'use strict';
/**
 * ROFL file parser for League of Legends replay files.
 *
 * Format (RIOT:ROFL:1.1):
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
 *   Payload header:
 *     +0  uint64 matchId
 *     +8  uint32 matchLength (ms)
 *     +12 uint32 keyframeCount
 *     +16 uint32 chunkCount
 *     +20 uint32 endStartupChunkId
 *     +24 uint32 startGameChunkId
 *     +28 uint32 keyframeInterval
 *     +32 uint16 encryptionKeyLength
 *     +34 string encryptionKey (base64)
 *
 *   Payload chunks (Blowfish ECB encrypted, then zlib compressed):
 *     +0 uint32 chunkId
 *     +4 uint8  type  (1=chunk 2=keyframe)
 *     +5 uint32 nextChunkId
 *     +9 uint32 dataLength
 *     +13 uint32 keyframeId
 *     +17 N bytes data
 */

const fs   = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

/**
 * Parse a .rofl file.
 * Returns: { matchId, matchLengthMs, participants, events, eventsFound }
 */
function parseROFL(filePath) {
  const buf = fs.readFileSync(filePath);

  // Verify magic
  if (buf.length < 14 || buf.slice(0, 14).toString('ascii') !== 'RIOT:ROFL:1.1\x00') {
    throw new Error('유효하지 않은 ROFL 파일: 매직 바이트가 일치하지 않습니다');
  }

  const ho = 270; // header offset (14 magic + 256 signature)
  if (buf.length < ho + 30) throw new Error('ROFL 파일이 너무 짧습니다');

  const metaOffset       = buf.readUInt32LE(ho + 6);
  const metaLen          = buf.readUInt32LE(ho + 10);
  const payloadHdrOffset = buf.readUInt32LE(ho + 14);
  const payloadHdrLen    = buf.readUInt32LE(ho + 18);
  const payloadOffset    = buf.readUInt32LE(ho + 22);
  const payloadLen       = buf.readUInt32LE(ho + 26);

  // Parse metadata JSON
  if (metaOffset + metaLen > buf.length) throw new Error('메타데이터 오프셋이 파일 크기를 초과합니다');
  const metaStr = buf.slice(metaOffset, metaOffset + metaLen).toString('utf8');
  const meta    = JSON.parse(metaStr);

  // Parse participant list from statsJson
  let participants = [];
  try {
    if (meta.statsJson) {
      const stats = JSON.parse(meta.statsJson);
      participants = parseParticipants(stats);
    }
  } catch (e) {
    console.warn('[ROFL] statsJson 파싱 실패:', e.message);
  }

  // Parse payload header
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
      console.warn('[ROFL] 페이로드 헤더 파싱 실패:', e.message);
    }
  }

  // Try to extract kill/death/assist events from payload chunks
  let events = [];
  if (encryptionKey && payloadLen > 0 && payloadOffset + payloadLen <= buf.length) {
    try {
      events = extractEvents(buf, payloadOffset, payloadLen, encryptionKey);
    } catch (e) {
      console.warn('[ROFL] 이벤트 추출 실패:', e.message);
    }
  }

  return { matchId, matchLengthMs, participants, events, eventsFound: events.length > 0 };
}

// ── Participants ────────────────────────────────────────────────────────────
function parseParticipants(stats) {
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
    assists:      parseInt(p.ASSISTS || p.assists  || 0)
  }));
}

// ── Payload chunk iteration ─────────────────────────────────────────────────
function extractEvents(buf, payloadOffset, payloadLen, encryptionKey) {
  const events   = [];
  let   offset   = payloadOffset;
  const end      = payloadOffset + payloadLen;
  const MAX      = 300; // max chunks to scan
  let   n        = 0;

  while (offset < end - 17 && n < MAX) {
    try {
      const dataLen = buf.readUInt32LE(offset + 9);
      offset += 17; // chunk header size

      if (dataLen === 0 || dataLen > 10 * 1024 * 1024) break;
      if (offset + dataLen > end) break;

      const chunkData = buf.slice(offset, offset + dataLen);
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

  // Attempt Blowfish ECB decryption (may fail on Node 18+ with OpenSSL 3)
  try {
    const keyBuf  = Buffer.from(encryptionKey, 'base64');
    const decipher = crypto.createDecipheriv('bf-ecb', keyBuf, Buffer.alloc(0));
    decipher.setAutoPadding(false);
    buf = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (_) {
    buf = data; // fall through to raw inflate
  }

  // Try various zlib modes
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

// ── Event scanning ──────────────────────────────────────────────────────────
function scanForKillEvents(data) {
  // Convert to string (limit for performance)
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

    // Find matching closing brace
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
