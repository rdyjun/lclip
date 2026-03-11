const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const ffmpegLib = require('fluent-ffmpeg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');
const { Videos } = require('../models/db');
const config = require('../config');
const { buildContent } = require('../prompts/highlights');

const AI_CONFIG_FILE = path.join(config.DATA_DIR, 'ai-config.json');
function loadAiConfig() {
  try { return fs.readJsonSync(AI_CONFIG_FILE); }
  catch (_) { return { referenceVideos: [], concept: '' }; }
}
function saveAiConfig(cfg) {
  fs.writeJsonSync(AI_CONFIG_FILE, cfg, { spaces: 2 });
}

if (!process.env.FFMPEG_PATH) {
  try { ffmpegLib.setFfmpegPath(require('ffmpeg-static')); } catch (_) {}
}
if (!process.env.FFPROBE_PATH) {
  try { ffmpegLib.setFfprobePath(require('@ffprobe-installer/ffprobe').path); } catch (_) {}
}

function getFilePath(video) {
  return video.isLocal
    ? video.localPath
    : path.join(config.UPLOADS_DIR, '..', (video.path || '').replace(/^\//, ''));
}

const MAX_UPLOAD_BYTES = 1.8 * 1024 * 1024 * 1024; // 1.8 GB (Gemini Files API limit: 2 GB)

// Compress to 720p if file is too large for upload
function compressVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpegLib(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-vf', 'scale=-2:720',
        '-crf', '28',
        '-preset', 'fast',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Upload video to Gemini Files API, poll until ACTIVE
async function uploadToGemini(filePath, displayName, apiKey, onProgress) {
  const fileManager = new GoogleAIFileManager(apiKey);

  onProgress('Gemini에 영상 업로드 중... (파일 크기에 따라 1~5분 소요)');

  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: 'video/mp4',
    displayName,
  });

  let file = uploadResult.file;

  // Poll until Gemini finishes processing
  let dots = 0;
  while (file.state === FileState.PROCESSING) {
    await new Promise(r => setTimeout(r, 5000));
    file = await fileManager.getFile(file.name);
    dots++;
    onProgress(`Gemini가 영상을 처리 중입니다${'.'.repeat((dots % 3) + 1)}`);
  }

  if (file.state === FileState.FAILED) {
    throw new Error('Gemini 영상 처리에 실패했습니다.');
  }

  return { file, fileManager };
}

// GET /api/ai/config
router.get('/config', (req, res) => res.json(loadAiConfig()));

// POST /api/ai/config
router.post('/config', (req, res) => {
  const cfg = {
    referenceVideos: Array.isArray(req.body.referenceVideos) ? req.body.referenceVideos : [],
    concept: String(req.body.concept || ''),
  };
  saveAiConfig(cfg);
  res.json(cfg);
});

// GET /api/ai/analyze?videoId=xxx  — SSE endpoint
router.get('/analyze', async (req, res) => {
  const { videoId } = req.query;
  const video = Videos.findById(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    send('error', { message: 'GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.' });
    return res.end();
  }

  const originalPath = getFilePath(video);
  if (!fs.existsSync(originalPath)) {
    send('error', { message: '영상 파일을 찾을 수 없습니다.' });
    return res.end();
  }

  let uploadPath = originalPath;
  let tmpDir = null;
  let geminiFile = null;
  let fileManager = null;

  try {
    // Compress if file exceeds Gemini's 2 GB limit
    const stat = fs.statSync(originalPath);
    if (stat.size > MAX_UPLOAD_BYTES) {
      send('progress', {
        message: `파일 크기(${(stat.size / 1e9).toFixed(1)}GB)가 커서 720p로 압축 중...`,
        percent: 10,
      });
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-compress-'));
      uploadPath = path.join(tmpDir, 'compressed.mp4');
      await compressVideo(originalPath, uploadPath);
    }

    send('progress', { message: 'Gemini에 영상 업로드 중...', percent: 20 });

    const result = await uploadToGemini(
      uploadPath,
      video.name,
      apiKey,
      msg => send('progress', { message: msg, percent: 40 }),
    );
    geminiFile = result.file;
    fileManager = result.fileManager;

    send('progress', { message: 'Gemini가 영상을 분석 중입니다... (30초~3분 소요)', percent: 60 });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const aiConfig = loadAiConfig();
    const response = await model.generateContent(buildContent(geminiFile, video.duration, aiConfig));

    send('progress', { message: '결과 처리 중...', percent: 90 });

    const text = response.response.text();
    const clean = text.replace(/```[a-z]*\n?/gi, '').trim();
    // Accept both object {"shorts":[...],"music":[...]} and bare array fallback
    const objMatch   = clean.match(/\{[\s\S]*\}/);
    const arrayMatch = clean.match(/\[[\s\S]*\]/);
    if (!objMatch && !arrayMatch) {
      throw new Error('Gemini가 유효한 JSON을 반환하지 않았습니다:\n' + text.slice(0, 300));
    }
    const parsed  = JSON.parse(objMatch ? objMatch[0] : arrayMatch[0]);
    const rawList = Array.isArray(parsed) ? parsed : (parsed.shorts || []);
    const music   = Array.isArray(parsed.music) ? parsed.music : [];

    const cap = t => Math.min(video.duration, Math.max(0, Math.round(Number(t) || 0)));

    const normalizeSubtitles = subs =>
      Array.isArray(subs)
        ? subs.map(s => ({
            offsetSec: Math.max(0, Number(s.offsetSec) || 0),
            text:      String(s.text || ''),
            duration:  Math.max(1, Number(s.duration) || 3),
          }))
        : [];

    const shorts = rawList
      .map(h => {
        if (h.type === 'montage' && Array.isArray(h.segments) && h.segments.length > 0) {
          const segments = h.segments
            .map(s => ({ srcStart: cap(s.startTime), srcEnd: cap(s.endTime) }))
            .filter(s => s.srcEnd > s.srcStart + 2);
          const totalDuration = segments.reduce((sum, s) => sum + (s.srcEnd - s.srcStart), 0);
          if (!segments.length) return null;
          return {
            type: 'montage',
            title:       h.title || '하이라이트 모음',
            description: h.description || '',
            virality:    Number(h.virality) || 0,
            segments,
            subtitles:   normalizeSubtitles(h.subtitles),
            totalDuration,
          };
        } else {
          const srcStart = cap(h.startTime);
          const srcEnd   = cap(h.endTime);
          if (srcEnd <= srcStart + 5) return null;
          return {
            type: 'standalone',
            title:       h.title || '하이라이트',
            description: h.description || '',
            virality:    Number(h.virality) || 0,
            segments:    [{ srcStart, srcEnd }],
            subtitles:   normalizeSubtitles(h.subtitles),
            totalDuration: srcEnd - srcStart,
          };
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.virality - a.virality);

    send('result', { shorts, music });
  } catch (err) {
    console.error('[AI analyze]', err.message);
    send('error', { message: err.message });
  } finally {
    // Clean up: delete uploaded file from Gemini servers
    if (geminiFile && fileManager) {
      fileManager.deleteFile(geminiFile.name).catch(() => {});
    }
    if (tmpDir) fs.removeSync(tmpDir);
    res.end();
  }
});

// GET /api/ai/music-search?q=xxx  — YouTube search proxy (no API key needed)
router.get('/music-search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'query required' });

  try {
    const ytsr = require('ytsr');
    const result = await ytsr(q, { limit: 15 });
    const items = result.items
      .filter(i => i.type === 'video')
      .slice(0, 12)
      .map(i => ({
        id:        i.id,
        title:     i.title,
        thumbnail: i.bestThumbnail?.url || '',
        channel:   i.author?.name || '',
        duration:  i.duration || '',
        url:       i.url,
      }));
    res.json(items);
  } catch (err) {
    console.error('[music-search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
