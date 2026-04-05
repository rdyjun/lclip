'use strict';
/**
 * ROFL file parser for League of Legends replay files.
 *
 * === Legacy format (RIOT:ROFL:1.1) ===
 *   Offset  0: Magic "RIOT:ROFL:1.1\0"  (14 bytes)
 *   Offset 14: RSA Signature             (256 bytes)
 *   Offset 270: Header struct
 *     +0  uint16 headerLen
 *     +2  uint32 fileLen
 *     +6  uint32 metadataOffset
 *     +10 uint32 metadataLength
 *     +14 uint32 payloadHeaderOffset
 *     +18 uint32 payloadHeaderLength
 *     +22 uint32 payloadOffset
 *     +26 uint32 payloadLength
 *
 * === New format (RIOT v2, patch ~15.x+) ===
 *   Offset  0: Magic "RIOT"             (4 bytes)
 *   Offset  4: uint16 = 2              (format version)
 *   Offset  6: 8 bytes                 (hash/identifier)
 *   Offset 14: uint8 versionStrLen
 *   Offset 15: game version string     (versionStrLen bytes)
 *   Offset 15+vLen: various header fields
 *   Then: zstd-compressed payload chunks (9-byte header each)
 *   Trailer: 256-byte signature + JSON metadata
 *     {"gameLength":N,"lastGameChunkId":N,"lastKeyFrameId":N,"statsJson":"[{...}]"}
 */

const fs     = require('fs');
const zlib   = require('zlib');
const crypto = require('crypto');
const path   = require('path');

// fzstd for ROFL2 format (pure-JS zstd decompressor)
let fzstd = null;
try { fzstd = require('fzstd'); } catch (_) {}

const LEGACY_MAGIC = 'RIOT:ROFL:1.1\x00';
const NEW_MAGIC    = 'RIOT';

/**
 * Parse a .rofl file.
 * Returns: { matchId, matchLengthMs, participants, events, eventsFound }
 */
function parseROFL(filePath) {
  const buf = fs.readFileSync(filePath);

  if (buf.length < 4) throw new Error('유효하지 않은 ROFL 파일: 파일이 너무 짧습니다');

  const magic4 = buf.slice(0, 4).toString('ascii');

  if (magic4 === NEW_MAGIC && buf.length >= 6 && buf[4] === 0x02) {
    return parseROFL2(buf, filePath);
  }

  // Legacy format check
  if (buf.length >= 14 && buf.slice(0, 14).toString('ascii') === LEGACY_MAGIC) {
    return parseROFL1(buf, filePath);
  }

  throw new Error('유효하지 않은 ROFL 파일: 지원하지 않는 포맷입니다 (magic: ' + buf.slice(0, 8).toString('hex') + ')');
}

// ── ROFL2 (new format, patch 15.x+) ─────────────────────────────────────────
function parseROFL2(buf, filePath) {
  // Parse game version string from header
  let gameVersion = '';
  try {
    const vLen = buf[14];
    if (vLen > 0 && vLen < 64 && 15 + vLen <= buf.length) {
      gameVersion = buf.slice(15, 15 + vLen).toString('ascii');
    }
  } catch (_) {}

  // matchId from filename (e.g. KR-8113900197.rofl → "8113900197")
  const basename = path.basename(filePath, '.rofl');
  const matchId  = basename.replace(/^[A-Z]+-/, '');

  // Find metadata JSON: scan for {"gameLength" in the file
  // Metadata is at: [last_zstd_frame_end + 256 bytes of signature + JSON]
  const GAME_LEN_KEY = Buffer.from('{"gameLength"');
  const metaOffset   = buf.indexOf(GAME_LEN_KEY);
  if (metaOffset < 0) {
    return { matchId, matchLengthMs: 0, participants: [], events: [], eventsFound: false, gameVersion };
  }

  const metaStr = buf.slice(metaOffset, metaOffset + 500000).toString('utf8');

  // Find JSON end
  let depth = 0, jsonEnd = -1;
  for (let i = 0; i < metaStr.length; i++) {
    if (metaStr[i] === '{') depth++;
    else if (metaStr[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
  }

  let matchLengthMs = 0;
  let participants  = [];

  try {
    const meta = JSON.parse(jsonEnd > 0 ? metaStr.substring(0, jsonEnd) : metaStr);
    matchLengthMs = parseInt(meta.gameLength) || 0;

    if (meta.statsJson) {
      const stats = typeof meta.statsJson === 'string'
        ? JSON.parse(meta.statsJson)
        : meta.statsJson;
      participants = parseROFL2Participants(stats);
    }
  } catch (e) {
    console.warn('[ROFL2] 메타데이터 파싱 실패:', e.message);
  }

  // Event extraction from zstd chunks (best-effort, skips on error)
  let events = [];
  if (fzstd) {
    try {
      events = extractROFL2Events(buf);
    } catch (e) {
      console.warn('[ROFL2] 이벤트 추출 실패:', e.message);
    }
  }

  return { matchId, matchLengthMs, participants, events, eventsFound: events.length > 0, gameVersion };
}

function parseROFL2Participants(stats) {
  if (!Array.isArray(stats)) return [];
  return stats.map((p, i) => {
    // New format uses RIOT_ID_GAME_NAME + RIOT_ID_TAG_LINE for player name
    const gameName = p.RIOT_ID_GAME_NAME || '';
    const tagLine  = p.RIOT_ID_TAG_LINE  || '';
    const summonerName = gameName
      ? (tagLine ? `${gameName} #${tagLine}` : gameName)
      : (p.SUMMONER_NAME || p.NAME || `플레이어${i + 1}`);

    return {
      id:           i + 1,
      championName: p.SKIN || p.championName || `챔피언${i + 1}`,
      summonerName,
      team:         parseInt(p.TEAM || p.teamId || 0),
      kills:        parseInt(p.CHAMPIONS_KILLED || p.kills  || 0),
      deaths:       parseInt(p.NUM_DEATHS || p.deaths || 0),
      assists:      parseInt(p.ASSISTS || p.assists || 0),
    };
  });
}

/**
 * Extract activity events from ROFL2 using chunk-size heuristics.
 *
 * ROFL2 packets are encrypted with a per-patch lookup table cipher,
 * making direct text extraction impossible. Instead, we use the
 * decompressed chunk size as a proxy for game activity:
 *   larger chunk = more packets = more in-game events = likely fight.
 *
 * Each type=1 chunk covers ~30 seconds of game time.
 * The float32 at bytes 1-4 of the decompressed data is the chunk start time.
 * Chunks with z-score >= 0.8 above average are returned as 'activity' events.
 */
function extractROFL2Events(buf) {
  const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const chunks = [];
  let pos = 0;

  // Scan all zstd frames; advance by compSize to skip the frame body reliably
  while (pos < buf.length) {
    const idx = buf.indexOf(ZSTD_MAGIC, pos);
    if (idx < 0) break;

    // 9-byte chunk header immediately before zstd magic:
    //   [type(1)][decompressedSize(4)][compressedSize(4)][zstd frame...]
    if (idx < 9) { pos = idx + 4; continue; }

    const chunkType = buf[idx - 9];
    const compSize  = buf.readUInt32LE(idx - 4);

    if (compSize < 4 || compSize > 50 * 1024 * 1024 || idx + compSize > buf.length) {
      pos = idx + 4;
      continue;
    }

    let startTimeS = -1;
    let decompLen  = 0;
    try {
      const chunkData    = buf.slice(idx, idx + compSize);
      const decompressed = Buffer.from(fzstd.decompress(chunkData));
      decompLen = decompressed.length;
      // First 5 bytes of decompressed data: [type(1)][float32 startTime LE(4)]
      if (decompressed.length >= 5) {
        startTimeS = decompressed.readFloatLE(1);
        if (!isFinite(startTimeS) || startTimeS < 0 || startTimeS > 7200) startTimeS = -1;
      }
    } catch (_) {}

    if (startTimeS >= 0 && decompLen > 0) {
      chunks.push({ chunkType, startTimeS, decompLen });
    }

    pos = idx + compSize; // advance past this compressed frame
  }

  if (chunks.length < 4) return [];

  // Only regular game chunks (type=1); skip first 300 s (laning phase)
  const regular = chunks.filter(c => c.chunkType === 1 && c.startTimeS >= 300);
  if (regular.length < 4) return [];

  // Z-score of decompressed size detects high-activity (fight) windows
  const sizes  = regular.map(c => c.decompLen);
  const mean   = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const stddev = Math.sqrt(sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / sizes.length);
  if (stddev === 0) return [];

  const events = [];
  for (const c of regular) {
    const z = (c.decompLen - mean) / stddev;
    if (z >= 1.5) {
      events.push({
        type:      'activity',
        timeS:     Math.round(c.startTimeS),
        intensity: Math.round(z * 10) / 10,
      });
    }
  }
  return events;
}

// ── ROFL1 (legacy format) ────────────────────────────────────────────────────
function parseROFL1(buf, filePath) {
  const ho = 270;
  if (buf.length < ho + 30) throw new Error('ROFL 파일이 너무 짧습니다');

  const metaOffset       = buf.readUInt32LE(ho + 6);
  const metaLen          = buf.readUInt32LE(ho + 10);
  const payloadHdrOffset = buf.readUInt32LE(ho + 14);
  const payloadHdrLen    = buf.readUInt32LE(ho + 18);
  const payloadOffset    = buf.readUInt32LE(ho + 22);
  const payloadLen       = buf.readUInt32LE(ho + 26);

  if (metaOffset + metaLen > buf.length) throw new Error('메타데이터 오프셋이 파일 크기를 초과합니다');
  const metaStr = buf.slice(metaOffset, metaOffset + metaLen).toString('utf8');
  const meta    = JSON.parse(metaStr);

  let participants = [];
  try {
    if (meta.statsJson) {
      const stats = JSON.parse(meta.statsJson);
      participants = parseLegacyParticipants(stats);
    }
  } catch (e) {
    console.warn('[ROFL1] statsJson 파싱 실패:', e.message);
  }

  let matchId = '0', matchLengthMs = 0, encryptionKey = null;
  if (payloadHdrOffset + payloadHdrLen <= buf.length && payloadHdrLen >= 34) {
    try {
      const ph  = buf.slice(payloadHdrOffset, payloadHdrOffset + payloadHdrLen);
      matchId       = ph.readBigUInt64LE(0).toString();
      matchLengthMs = ph.readUInt32LE(8);
      const ekLen   = ph.readUInt16LE(32);
      if (ekLen > 0 && ekLen < 512 && 34 + ekLen <= ph.length) {
        encryptionKey = ph.slice(34, 34 + ekLen).toString('ascii');
      }
    } catch (e) {
      console.warn('[ROFL1] 페이로드 헤더 파싱 실패:', e.message);
    }
  }

  let events = [];
  if (encryptionKey && payloadLen > 0 && payloadOffset + payloadLen <= buf.length) {
    try {
      events = extractLegacyEvents(buf, payloadOffset, payloadLen, encryptionKey);
    } catch (e) {
      console.warn('[ROFL1] 이벤트 추출 실패:', e.message);
    }
  }

  return { matchId, matchLengthMs, participants, events, eventsFound: events.length > 0 };
}

function parseLegacyParticipants(stats) {
  const arr = Array.isArray(stats)
    ? stats
    : (stats.playerStatSummaries || stats.participants || stats.playerStats || []);

  return arr.map((p, i) => ({
    id:           i + 1,
    championName: p.SKIN || p.championName || p.skin || p.champion || `챔피언${i + 1}`,
    summonerName: p.SUMMONER_NAME || p.summonerName || p.name || `플레이어${i + 1}`,
    team:         parseInt(p.TEAM   || p.teamId   || 0),
    kills:        parseInt(p.KILLS  || p.CHAMPIONS_KILLED || p.kills  || 0),
    deaths:       parseInt(p.DEATHS || p.NUM_DEATHS       || p.deaths || 0),
    assists:      parseInt(p.ASSISTS || p.assists  || 0),
  }));
}

function extractLegacyEvents(buf, payloadOffset, payloadLen, encryptionKey) {
  const events = [];
  let   offset = payloadOffset;
  const end    = payloadOffset + payloadLen;
  const MAX    = 300;
  let   n      = 0;

  while (offset < end - 17 && n < MAX) {
    try {
      const dataLen = buf.readUInt32LE(offset + 9);
      offset += 17;
      if (dataLen === 0 || dataLen > 10 * 1024 * 1024) break;
      if (offset + dataLen > end) break;
      const chunkData    = buf.slice(offset, offset + dataLen);
      offset += dataLen;
      n++;
      const decompressed = tryDecryptDecompress(chunkData, encryptionKey);
      if (decompressed) events.push(...scanForKillEvents(decompressed));
    } catch (_) {
      break;
    }
  }

  return events;
}

function tryDecryptDecompress(data, encryptionKey) {
  let buf = data;
  try {
    const keyBuf   = Buffer.from(encryptionKey, 'base64');
    const decipher = crypto.createDecipheriv('bf-ecb', keyBuf, Buffer.alloc(0));
    decipher.setAutoPadding(false);
    buf = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (_) {
    buf = data;
  }

  for (const fn of [
    () => zlib.inflateSync(buf),
    () => zlib.inflateRawSync(buf),
    () => zlib.inflateSync(buf.slice(4)),
    () => zlib.inflateRawSync(buf.slice(4)),
    () => zlib.gunzipSync(buf),
  ]) {
    try { return fn(); } catch (_) {}
  }
  return null;
}

// ── Event scanning (shared) ──────────────────────────────────────────────────
function scanForKillEvents(data) {
  const text = data.toString('utf8', 0, Math.min(data.length, 512 * 1024));
  if (text.includes('ChampionKill') || text.includes('championKill')) {
    return extractJsonKillEvents(text);
  }
  return [];
}

function extractJsonKillEvents(text) {
  const events = [];
  let pos = 0;

  while (pos < text.length) {
    const idx = text.indexOf('ChampionKill', pos);
    if (idx < 0) break;

    const objStart = text.lastIndexOf('{', idx);
    if (objStart < 0) { pos = idx + 12; continue; }

    let depth = 0, objEnd = -1;
    for (let i = objStart; i < Math.min(text.length, objStart + 1000); i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { objEnd = i + 1; break; } }
    }

    if (objEnd > 0) {
      try {
        const obj   = JSON.parse(text.substring(objStart, objEnd));
        const timeS = parseFloat(obj.EventTime ?? obj.eventTime ?? obj.gameTime ?? -1);
        if (timeS >= 0) {
          events.push({
            type:   'kill',
            timeS,
            killer: obj.KillerName  || obj.killerName  || '',
            victim: obj.VictimName  || obj.victimName  || '',
          });
        }
      } catch (_) {}
    }

    pos = idx + 12;
  }

  return events;
}

module.exports = { parseROFL };
