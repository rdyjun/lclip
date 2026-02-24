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
  const { sourceVideoId, name, roflClips } = req.body;
  const video = Videos.findById(sourceVideoId);
  if (!video) return res.status(404).json({ error: 'Source video not found' });

  const hasRofl = Array.isArray(roflClips) && roflClips.length > 0;
  const layers  = hasRofl ? buildRoflLayers(video, roflClips) : buildDefaultLayers(video);

  const project = Projects.create({
    name: name || `${video.name} - Short`,
    sourceVideoId,
    sourceVideoPath: video.path,
    sourceVideoDuration: video.duration,
    sourceVideoWidth: video.width,
    sourceVideoHeight: video.height,
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
    originalname: req.file.originalname
  });
});

function buildDefaultLayers(video) {
  const duration = video.duration || 60;
  const dv = defaults.video;
  const ds = defaults.subtitle;
  const dc = defaults.channelSubtitle;
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
          scale: dv.scale, opacity: dv.opacity
        }
      ]
    },
    {
      id: uuidv4(),
      type: 'subtitle',
      name: '자막 레이어 1',
      order: 1,
      locked: false,
      visible: true,
      clips: [
        {
          id: uuidv4(),
          type: 'subtitle',
          text: '여기에 자막을 입력하세요',
          startTime: 0,
          endTime: 5,
          x: 540, y: 200,
          ...ds
        }
      ]
    },
    {
      id: uuidv4(),
      type: 'subtitle',
      name: '채널명 레이어',
      order: 2,
      locked: false,
      visible: true,
      clips: [
        {
          id: uuidv4(),
          type: 'subtitle',
          text: '@채널명',
          startTime: 0,
          endTime: duration,
          ...dc
        }
      ]
    },
    {
      id: uuidv4(),
      type: 'audio',
      name: '배경음악',
      order: 3,
      locked: false,
      visible: true,
      clips: []
    }
  ];
}

/**
 * Build layers for a ROFL-generated project.
 * roflClips: [{ srcStart, srcEnd, eventTypes }]
 * Clips are placed sequentially in the timeline with a 0.5s gap.
 */
function buildRoflLayers(video, roflClips) {
  const src = video.isLocal
    ? `/api/videos/stream/${video.id}`
    : (video.path || `/api/videos/stream/${video.id}`);

  const dv = defaults.video;
  const dc = defaults.channelSubtitle;

  let timelinePos = 0;
  const videoClips = roflClips.map(seg => {
    const duration = Math.max(0.1, seg.srcEnd - seg.srcStart);
    const clip = {
      id:          uuidv4(),
      type:        'video',
      src,
      name:        video.name,
      startTime:   timelinePos,
      endTime:     timelinePos + duration,
      srcStart:    seg.srcStart,
      srcEnd:      seg.srcEnd,
      x: dv.x, y: dv.y, width: dv.width, height: dv.height,
      scale: dv.scale, opacity: dv.opacity,
      isFiltered:  true,
      filterStart: seg.srcStart,
      filterEnd:   seg.srcEnd,
      eventTypes:  seg.eventTypes || []
    };
    timelinePos += duration + 0.5; // 0.5s gap between segments
    return clip;
  });

  const totalDuration = timelinePos || 60;

  return [
    {
      id: uuidv4(), type: 'video', name: 'Video (ROFL)',
      order: 0, locked: false, visible: true,
      clips: videoClips
    },
    {
      id: uuidv4(), type: 'subtitle', name: '자막 레이어 1',
      order: 1, locked: false, visible: true, clips: []
    },
    {
      id: uuidv4(), type: 'subtitle', name: '채널명 레이어',
      order: 2, locked: false, visible: true,
      clips: [{
        id: uuidv4(), type: 'subtitle', text: '@채널명',
        startTime: 0, endTime: totalDuration,
        ...dc
      }]
    },
    {
      id: uuidv4(), type: 'audio', name: '배경음악',
      order: 3, locked: false, visible: true, clips: []
    }
  ];
}

module.exports = router;
