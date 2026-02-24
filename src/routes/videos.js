const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { Videos } = require('../models/db');
const ffmpegLib = require('fluent-ffmpeg');
const { getVideoInfo, createClipStream } = require('../utils/ffmpeg');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(config.UPLOADS_DIR, 'videos')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Invalid file type'));
  }
  // no fileSize limit — disk storage streams to file, no memory issue
});

// GET /api/videos
router.get('/', (req, res) => {
  const videos = Videos.findAll();
  res.json(videos);
});

// GET /api/videos/:id
router.get('/:id', (req, res) => {
  const video = Videos.findById(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  res.json(video);
});

// POST /api/videos/upload
router.post('/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const info = await getVideoInfo(filePath);

    const video = Videos.create({
      name: req.file.originalname,
      filename: req.file.filename,
      path: `/uploads/videos/${req.file.filename}`,
      size: req.file.size,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      thumbnail: info.thumbnail || null
    });

    res.json(video);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/videos/register-local
// Register a video that already exists on disk (no copy, no upload)
router.post('/register-local', async (req, res) => {
  try {
    const { localPath } = req.body;
    if (!localPath) return res.status(400).json({ error: 'localPath is required' });

    const absPath = path.resolve(localPath);
    if (!fs.existsSync(absPath)) return res.status(400).json({ error: '파일을 찾을 수 없습니다: ' + absPath });

    const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    if (!allowed.includes(path.extname(absPath).toLowerCase())) {
      return res.status(400).json({ error: '지원하지 않는 형식입니다' });
    }

    const info = await getVideoInfo(absPath);
    const stat = fs.statSync(absPath);

    const video = Videos.create({
      name: path.basename(absPath),
      filename: path.basename(absPath),
      localPath: absPath,          // absolute path on disk
      path: null,                  // no web-serve path (use /api/videos/stream/:id)
      isLocal: true,
      size: stat.size,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps
    });

    res.json(video);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos/stream/:id
// Stream video file — works for both uploaded files and locally registered files
router.get('/stream/:id', (req, res) => {
  const video = Videos.findById(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const filePath = video.isLocal
    ? video.localPath
    : path.join(config.UPLOADS_DIR, '..', (video.path || '').replace(/^\//, ''));

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '파일이 존재하지 않습니다' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4'
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// GET /api/videos/clip/:id?start=X&end=Y
// Extracts a time-bounded clip and streams it as H.264 MP4.
// Used by client-side FFmpeg.wasm export so it receives a decodable H.264
// segment instead of the potentially HEVC source.
// Response header X-Has-Audio: 1/0 tells client whether audio is present.
const _audioProbeCache = new Map();
router.get('/clip/:id', async (req, res) => {
  const video = Videos.findById(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const filePath = video.isLocal
    ? video.localPath
    : path.join(config.UPLOADS_DIR, '..', (video.path || '').replace(/^\//, ''));

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const start = parseFloat(req.query.start) || 0;
  const end   = parseFloat(req.query.end);
  if (!end || end <= start) {
    return res.status(400).json({ error: 'Invalid start/end query params' });
  }

  // Probe once per file path, cache result for the process lifetime.
  let hasAudio = _audioProbeCache.get(filePath);
  if (hasAudio === undefined) {
    hasAudio = await new Promise(resolve => {
      ffmpegLib.ffprobe(filePath, (err, meta) => {
        resolve(!err && meta.streams.some(s => s.codec_type === 'audio'));
      });
    });
    _audioProbeCache.set(filePath, hasAudio);
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('X-Has-Audio', hasAudio ? '1' : '0');
  // Allow the client JS to read this custom header (CORS expose)
  res.setHeader('Access-Control-Expose-Headers', 'X-Has-Audio');

  createClipStream(filePath, start, end, hasAudio)
    .on('error', err => {
      console.error(`Clip stream error [${video.id}]:`, err.message);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    })
    .pipe(res, { end: true });
});

// DELETE /api/videos/:id
router.delete('/:id', (req, res) => {
  const video = Videos.findById(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  // Only delete file from disk if it was uploaded (not a local registration)
  if (!video.isLocal && video.path) {
    const filePath = path.join(config.UPLOADS_DIR, '..', video.path.replace(/^\//, ''));
    if (fs.existsSync(filePath)) fs.removeSync(filePath);
  }

  Videos.delete(req.params.id);
  res.json({ success: true });
});

module.exports = router;
