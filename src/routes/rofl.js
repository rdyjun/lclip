'use strict';
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs-extra');
const { parseROFL } = require('../utils/roflParser');
const config   = require('../config');

const upload = multer({
  dest: path.join(config.UPLOADS_DIR, 'tmp'),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.rofl') cb(null, true);
    else cb(new Error('ROFL 파일(.rofl)만 업로드 가능합니다'));
  },
  limits: { fileSize: 300 * 1024 * 1024 } // 300 MB
});

// POST /api/rofl/parse
router.post('/parse', upload.single('rofl'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ROFL 파일이 없습니다' });

  const filePath = req.file.path;
  try {
    const result = parseROFL(filePath);
    res.json(result);
  } catch (err) {
    console.error('[ROFL parse error]', err.message);
    res.status(400).json({ error: err.message });
  } finally {
    fs.remove(filePath).catch(() => {});
  }
});

module.exports = router;
