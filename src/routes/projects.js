const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { Projects, Videos, uuidv4 } = require('../models/db');
const config = require('../config');
const defaults = require('../config/defaults');

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(config.UPLOADS_DIR, 'audio')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  }
});
const uploadAudio = multer({ storage: audioStorage });

// GET /api/projects
router.get('/', (req, res) => {
  const projects = Projects.findAll();

  // Auto-fix: infer sourceVideoId from video layer clip src if missing
  projects.forEach(p => {
    if (p.sourceVideoId) return;
    const videoLayer = (p.layers || []).find(l => l.type === 'video');
    const src = videoLayer?.clips?.[0]?.src || '';
    const m = src.match(/\/api\/videos\/stream\/([a-zA-Z0-9-]+)/);
    if (m && Videos.findById(m[1])) {
      p.sourceVideoId = m[1];
      Projects.update(p.id, { sourceVideoId: m[1] });
    }
  });

  res.json(projects);
});

// GET /api/projects/:id
router.get('/:id', (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

// POST /api/projects - Create a new project from a video
router.post('/', (req, res) => {
  const { sourceVideoId, name, roflClips, musicRecommendations } = req.body;
  const video = Videos.findById(sourceVideoId);
  if (!video) return res.status(404).json({ error: 'Source video not found' });

  const projectName = name || `${video.name} - Short`;
  const hasRofl = Array.isArray(roflClips) && roflClips.length > 0;
  const layers  = hasRofl ? buildRoflLayers(video, roflClips, projectName) : buildDefaultLayers(video);

  const project = Projects.create({
    name: projectName,
    sourceVideoId,
    sourceVideoPath: video.path,
    sourceVideoDuration: video.duration,
    sourceVideoWidth: video.width,
    sourceVideoHeight: video.height,
    musicRecommendations: Array.isArray(musicRecommendations) ? musicRecommendations : [],
    layers
  });

  res.json(project);
});

// PUT /api/projects/:id - Save project state
router.put('/:id', (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const updated = Projects.update(req.params.id, req.body);
  res.json(updated);
});

// PATCH /api/projects/:id - Rename project
router.patch('/:id', (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const updated = Projects.update(req.params.id, { name: name.trim() });
  res.json(updated);
});

// DELETE /api/projects/:id
router.delete('/:id', (req, res) => {
  Projects.delete(req.params.id);
  res.json({ success: true });
});

// POST /api/projects/:id/audio - Upload audio for project
router.post('/:id/audio', uploadAudio.single('audio'), (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  res.json({
    path: `/uploads/audio/${req.file.filename}`,
    filename: req.file.filename,
    originalname: Buffer.from(req.file.originalname, 'latin1').toString('utf8')
  });
});

function buildDefaultLayers(video) {
  const duration = video.duration || 60;
  const dv = defaults.video;

  return [
    {
      id: uuidv4(),
      type: 'video',
      name: 'Video',
      order: 0,
      locked: false,
      visible: true,
      clips: [
        {
          id: uuidv4(),
          type: 'video',
          src: `/api/videos/stream/${video.id}`,
          name: video.name,
          startTime: 0,
          endTime: duration,
          srcStart: 0,
          srcEnd: duration,
          x: dv.x, y: dv.y, width: dv.width, height: dv.height,
          scale: dv.scale, opacity: dv.opacity,
        },
      ],
    },
    {
      id: uuidv4(),
      type: 'audio',
      name: 'Background Music',
      order: 1,
      locked: false,
      visible: true,
      clips: [],
    },
  ];
}

/**
 * Build layers for a ROFL-generated project.
 * roflClips: [{ srcStart, srcEnd, eventTypes }]
 * Clips are placed sequentially in the timeline with a 0.5s gap.
 */
function buildRoflLayers(video, roflClips, projectName) {
  const src = video.isLocal
    ? `/api/videos/stream/${video.id}`
    : (video.path || `/api/videos/stream/${video.id}`);

  const dv = defaults.video;

  let timelinePos = 0;
  const videoClips = roflClips.map(seg => {
    const duration = Math.max(0.1, seg.srcEnd - seg.srcStart);
    const clip = {
      id: uuidv4(),
      type: 'video',
      src,
      name: video.name,
      startTime: timelinePos,
      endTime: timelinePos + duration,
      srcStart: seg.srcStart,
      srcEnd: seg.srcEnd,
      x: dv.x, y: dv.y, width: dv.width, height: dv.height,
      scale: dv.scale, opacity: dv.opacity,
      isFiltered: true,
      filterStart: seg.srcStart,
      filterEnd: seg.srcEnd,
      eventTypes: seg.eventTypes || [],
    };
    timelinePos += duration + 0.5; // 0.5s gap between segments
    return clip;
  });

  return [
    {
      id: uuidv4(),
      type: 'video',
      name: 'Video (ROFL)',
      order: 0,
      locked: false,
      visible: true,
      clips: videoClips,
    },
    {
      id: uuidv4(),
      type: 'audio',
      name: 'Background Music',
      order: 1,
      locked: false,
      visible: true,
      clips: [],
    },
  ];
}
module.exports = router;

