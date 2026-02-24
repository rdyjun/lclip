const express = require('express');
const router = express.Router();
const path = require('path');
const { Projects } = require('../models/db');
const { exportVideo } = require('../utils/ffmpeg');
const config = require('../config');

// POST /api/export/:projectId
router.post('/:projectId', async (req, res) => {
  const project = Projects.findById(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    // Send response immediately and process in background
    const outputFilename = `export_${project.id}_${Date.now()}.mp4`;
    const outputPath = path.join(config.EXPORTS_DIR, outputFilename);

    // Mark as processing
    Projects.update(project.id, { exportStatus: 'processing', exportFile: null });
    res.json({ status: 'processing', message: 'Export started' });

    // Progress callback — throttled to 1 DB write/second
    let lastProgressWrite = 0;
    const onProgress = (percent, message) => {
      const now = Date.now();
      if (now - lastProgressWrite > 1000) {
        lastProgressWrite = now;
        Projects.update(project.id, { exportProgress: percent, exportProgressMsg: message });
      }
    };

    // Process video
    exportVideo(project, outputPath, onProgress)
      .then(() => {
        Projects.update(project.id, {
          exportStatus: 'done',
          exportProgress: 100,
          exportProgressMsg: '완료',
          exportFile: `/exports/${outputFilename}`
        });
        console.log(`Export done: ${outputFilename}`);
      })
      .catch(err => {
        console.error('Export error:', err);
        Projects.update(project.id, { exportStatus: 'error', exportError: err.message });
      });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/:projectId/status
router.get('/:projectId/status', (req, res) => {
  const project = Projects.findById(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({
    status:   project.exportStatus    || 'idle',
    progress: project.exportProgress  || 0,
    message:  project.exportProgressMsg || '',
    file:     project.exportFile      || null,
    error:    project.exportError     || null,
  });
});

module.exports = router;
