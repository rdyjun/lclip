const express = require('express');
const router  = express.Router();
const { getFontPath } = require('../utils/ffmpeg');
const fs = require('fs-extra');

// GET /api/fonts/resolve?family=Noto+Sans+KR,+sans-serif&bold=1
// Resolves the best-matching font file on the server and streams it.
// Used by the client-side FFmpeg.wasm export to write fonts into the VFS.
router.get('/resolve', (req, res) => {
  const { family = '', bold } = req.query;
  const isBold = bold === '1' || bold === 'true';

  const fontPath = getFontPath(isBold, family || undefined);
  if (!fontPath) return res.status(404).json({ error: 'No font available' });

  // getFontPath may return a Windows-style path like C\:/Windows/Fonts/...
  // Normalise it to a real path before checking existence.
  const realPath = fontPath.startsWith('C\\:/')
    ? fontPath.replace('C\\:/', 'C:/')
    : fontPath;

  if (!fs.existsSync(realPath)) {
    return res.status(404).json({ error: `Font file not found: ${realPath}` });
  }

  res.setHeader('Content-Type', 'font/ttf');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(realPath);
});

module.exports = router;
