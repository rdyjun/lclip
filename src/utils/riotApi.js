'use strict';
/**
 * Riot Games API helper — Match Timeline v5
 *
 * Fetches per-kill timestamps for a given matchId.
 * matchId format from ROFL filename: "KR-8113900197" → API uses "KR_8113900197"
 *
 * Regional routing (platformId → regional endpoint):
 *   KR, JP → asia.api.riotgames.com
 *   EUW, EUNE, TR, RU → europe.api.riotgames.com
 *   NA, BR, LAN, LAS → americas.api.riotgames.com
 */

const https = require('https');
const config = require('../config');

const PLATFORM_TO_REGION = {
  KR: 'asia', JP1: 'asia',
  EUW1: 'europe', EUN1: 'europe', TR1: 'europe', RU: 'europe',
  NA1: 'americas', BR1: 'americas', LA1: 'americas', LA2: 'americas',
  OC1: 'sea', PH2: 'sea', SG2: 'sea', TH2: 'sea', TW2: 'sea', VN2: 'sea',
};

function getRegion(platformId) {
  return PLATFORM_TO_REGION[platformId?.toUpperCase()] || 'asia';
}

/**
 * Simple HTTPS GET — returns parsed JSON or throws.
 */
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`Riot API ${res.statusCode}: ${body}`));
        } else {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Riot API 응답 파싱 실패: ' + e.message)); }
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Riot API 요청 타임아웃')); });
  });
}

/**
 * Fetch kill events from Riot Match Timeline API.
 *
 * @param {string} roflBasename  e.g. "KR-8113900197" (from ROFL filename without .rofl)
 * @returns {Promise<{ events: Array, matchId: string }>}
 *   events: [{ type:'kill', timeS, killer, victim, assistCount }]
 */
async function fetchMatchKillEvents(roflBasename) {
  const apiKey = config.RIOT_API_KEY;
  if (!apiKey) throw new Error('RIOT_API_KEY가 설정되지 않았습니다');

  // "KR-8113900197" → platform="KR", numeric="8113900197"
  const match = roflBasename.match(/^([A-Z0-9]+)-(\d+)$/i);
  if (!match) throw new Error(`ROFL 파일명에서 matchId를 추출할 수 없습니다: ${roflBasename}`);

  const platformId = match[1].toUpperCase();
  const numericId  = match[2];
  const matchId    = `${platformId}_${numericId}`;
  const region     = getRegion(platformId);

  const url = `https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`;
  const data = await httpsGet(url, { 'X-Riot-Token': apiKey });

  const events = [];
  const frames = data?.info?.frames || [];
  for (const frame of frames) {
    for (const ev of (frame.events || [])) {
      if (ev.type === 'CHAMPION_KILL') {
        events.push({
          type:         'kill',
          timeS:        Math.round(ev.timestamp / 1000),
          killerId:     ev.killerId,
          victimId:     ev.victimId,
          assistCount:  (ev.assistingParticipantIds || []).length,
        });
      }
    }
  }

  // Attach participant index map (participantId 1-10 → array index 0-9)
  const participants = data?.info?.participants || [];
  const participantMap = {};
  participants.forEach((p, i) => { participantMap[p.participantId] = i; });

  // Annotate events with participant indices for kill scoring
  for (const ev of events) {
    ev.killerIdx = participantMap[ev.killerId] ?? -1;
    ev.victimIdx = participantMap[ev.victimId] ?? -1;
  }

  return { events, matchId };
}

module.exports = { fetchMatchKillEvents };
