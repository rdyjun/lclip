'use strict';
/**
 * Riot Games API helper (Match Timeline v5).
 *
 * Fetches per-kill timestamps for a given matchId.
 * ROFL filename format: "KR-8113900197" -> API matchId "KR_8113900197".
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

function getDisplayName(participant) {
  if (!participant) return '';
  if (participant.riotIdGameName) {
    return participant.riotIdTagline
      ? `${participant.riotIdGameName}#${participant.riotIdTagline}`
      : participant.riotIdGameName;
  }
  return participant.summonerName || participant.gameName || participant.puuid || '';
}

/**
 * Simple HTTPS GET that returns parsed JSON.
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
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Riot API response parse failed: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Riot API request timeout'));
    });
  });
}

/**
 * Fetch kill events from Riot Match Timeline API.
 *
 * @param {string} roflBasename e.g. "KR-8113900197"
 * @returns {Promise<{ events: Array, matchId: string, participants: Array }>}
 */
async function fetchMatchKillEvents(roflBasename) {
  const apiKey = config.RIOT_API_KEY;
  if (!apiKey) throw new Error('RIOT_API_KEY is not configured');

  const match = roflBasename.match(/^([A-Z0-9]+)-(\d+)$/i);
  if (!match) throw new Error(`Cannot parse matchId from ROFL filename: ${roflBasename}`);

  const platformId = match[1].toUpperCase();
  const numericId = match[2];
  const matchId = `${platformId}_${numericId}`;
  const region = getRegion(platformId);
  const headers = { 'X-Riot-Token': apiKey };

  const baseUrl = `https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
  const timelineUrl = `${baseUrl}/timeline`;

  const [timelineData, matchData] = await Promise.all([
    httpsGet(timelineUrl, headers),
    // Match payload has richer participant metadata. Keep timeline usable even if this fails.
    httpsGet(baseUrl, headers).catch(() => null),
  ]);

  const rawParticipants = matchData?.info?.participants || timelineData?.info?.participants || [];
  const participants = rawParticipants.map((p, i) => {
    const participantId = Number.isInteger(p.participantId) ? p.participantId : (i + 1);
    const index = Number.isInteger(p.participantId) ? (p.participantId - 1) : i;
    return {
      index,
      participantId,
      championName: p.championName || '',
      summonerName: getDisplayName(p),
      kills: parseInt(p.kills, 10) || 0,
      deaths: parseInt(p.deaths, 10) || 0,
      assists: parseInt(p.assists, 10) || 0,
    };
  }).sort((a, b) => a.index - b.index);

  const participantById = {};
  participants.forEach(p => {
    participantById[p.participantId] = p;
  });

  const events = [];
  const frames = timelineData?.info?.frames || [];
  for (const frame of frames) {
    for (const ev of (frame.events || [])) {
      if (ev.type !== 'CHAMPION_KILL') continue;
      const killer = participantById[ev.killerId];
      const victim = participantById[ev.victimId];
      events.push({
        type: 'kill',
        timeS: Math.round(ev.timestamp / 1000),
        killerId: ev.killerId,
        victimId: ev.victimId,
        assistCount: (ev.assistingParticipantIds || []).length,
        killerIdx: killer?.index ?? -1,
        victimIdx: victim?.index ?? -1,
        killer: killer?.summonerName || '',
        victim: victim?.summonerName || '',
        killerChampion: killer?.championName || '',
        victimChampion: victim?.championName || '',
      });
    }
  }

  return { events, matchId, participants };
}

module.exports = { fetchMatchKillEvents };
