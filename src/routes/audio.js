const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs-extra');
const multer  = require('multer');
const config  = require('../config');
const { Projects, uuidv4 } = require('../models/db');

const LIBRARY_FILE = path.join(config.DATA_DIR, 'audio-library.json');

function loadLibrary() {
  try { return fs.readJsonSync(LIBRARY_FILE); } catch (_) { return []; }
}
function saveLibrary(lib) {
  fs.writeJsonSync(LIBRARY_FILE, lib, { spaces: 2 });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(config.UPLOADS_DIR, 'audio')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// GET /api/audio  — return library list
router.get('/', (req, res) => {
  res.json(loadLibrary());
});

// POST /api/audio/upload  — upload new file, save to library
router.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // multer passes originalname as latin1; decode to utf-8 to restore Korean
  const decodedName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const entry = {
    id:         uuidv4(),
    name:       path.basename(decodedName, path.extname(decodedName)),
    filename:   req.file.filename,
    src:        `/uploads/audio/${req.file.filename}`,
    size:       req.file.size,
    uploadedAt: new Date().toISOString(),
  };

  const lib = loadLibrary();
  lib.unshift(entry); // newest first
  saveLibrary(lib);
  res.json(entry);
});

// DELETE /api/audio/:id  — remove from library (+ optionally delete file)
router.delete('/:id', (req, res) => {
  const lib = loadLibrary();
  const idx = lib.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [entry] = lib.splice(idx, 1);
  saveLibrary(lib);
  try { fs.removeSync(path.join(config.UPLOADS_DIR, 'audio', entry.filename)); } catch (_) {}
  res.json({ ok: true });
});

// POST /api/audio/add-to-project  — add library file as audio clip on timeline
router.post('/add-to-project', (req, res) => {
  const { projectId, audioId, startTime = 0, volume = 80 } = req.body;

  const project = Projects.findById(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const lib = loadLibrary();
  const entry = lib.find(e => e.id === audioId);
  if (!entry) return res.status(404).json({ error: 'Audio not found in library' });

  const audioLayer = project.layers?.find(l => l.type === 'audio');
  if (!audioLayer) return res.status(400).json({ error: 'No audio layer in project' });

  const clip = {
    id:        uuidv4(),
    type:      'audio',
    src:       entry.src,
    name:      entry.name,
    startTime: Number(startTime),
    endTime:   Number(startTime) + 30, // default 30s; user can resize in timeline
    volume:    Number(volume) / 100,
  };

  audioLayer.clips = [...(audioLayer.clips || []), clip];
  Projects.update(projectId, { layers: project.layers });
  res.json(clip);
});

module.exports = router;
