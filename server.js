const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const config = require('./src/config');

const app = express();
const PORT = config.PORT;

// Ensure required directories exist (uses configurable paths)
const storageDirs = [
  config.DATA_DIR,
  path.join(config.UPLOADS_DIR, 'videos'),
  path.join(config.UPLOADS_DIR, 'audio'),
  path.join(config.UPLOADS_DIR, 'thumbnails'),
  path.join(config.UPLOADS_DIR, 'tmp'),
  config.EXPORTS_DIR,
];
storageDirs.forEach(dir => fs.ensureDirSync(dir));

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Disable timeout for large file uploads/exports
app.use((req, res, next) => {
  req.setTimeout(0);
  res.setTimeout(0);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(config.UPLOADS_DIR));
app.use('/exports', express.static(config.EXPORTS_DIR));

// Routes
const videosRouter   = require('./src/routes/videos');
const projectsRouter = require('./src/routes/projects');
const exportRouter   = require('./src/routes/export');
const roflRouter     = require('./src/routes/rofl');
const fontsRouter    = require('./src/routes/fonts');

app.use('/api/videos',   videosRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/export',   exportRouter);
app.use('/api/rofl',     roflRouter);
app.use('/api/fonts',    fontsRouter);

// Serve editor page with COOP/COEP headers required by FFmpeg.wasm
// (SharedArrayBuffer is only available in cross-origin isolated contexts).
// credentialless COEP allows same-origin resources + cross-origin resources
// that don't send credentials (e.g. Google Fonts CDN).
app.get('/editor/:projectId', (req, res) => {
  res.set('Cross-Origin-Opener-Policy',   'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'credentialless');
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

app.listen(PORT, () => {
  console.log(`Video Editor Server running at http://localhost:${PORT}`);
  console.log(`  DATA_DIR:    ${config.DATA_DIR}`);
  console.log(`  UPLOADS_DIR: ${config.UPLOADS_DIR}`);
  console.log(`  EXPORTS_DIR: ${config.EXPORTS_DIR}`);
});
