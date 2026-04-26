// Load .env for local development (Docker injects vars via docker-compose env_file)
require('dotenv').config();

const express = require('express');
const session = require('express-session');
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

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  // req.path can be stripped inside mounted routers (e.g. "/parse" under "/api/rofl"),
  // so use originalUrl to reliably detect API requests.
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

// Disable timeout for large file uploads/exports
app.use((req, res, next) => {
  req.setTimeout(0);
  res.setTimeout(0);
  next();
});

// Login page (public) — before express.static so login.html is accessible unauthenticated
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Home page (protected) — before express.static so static middleware doesn't auto-serve index.html
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Editor page (protected) — before express.static
app.get('/editor/:projectId', requireAuth, (req, res) => {
  res.set('Cross-Origin-Opener-Policy',   'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'credentialless');
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// Static files (CSS/JS/images) — no auth required so login page can load assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(config.UPLOADS_DIR));
app.use('/exports', express.static(config.EXPORTS_DIR));

// Serve FFmpeg.wasm packages from same origin so the Worker chunk
// (814.ffmpeg.js) is also same-origin — required when COEP is enabled.
app.use('/vendor/ffmpeg',
  express.static(path.join(__dirname, 'node_modules/@ffmpeg/ffmpeg/dist/umd')));
app.use('/vendor/ffmpeg-core',
  express.static(path.join(__dirname, 'node_modules/@ffmpeg/core/dist/umd')));

// Serve shared defaults as a browser global
app.get('/api/defaults.js', (req, res) => {
  const defaults = require('./src/config/defaults');
  res.type('application/javascript');
  res.send(`window.APP_DEFAULTS=${JSON.stringify(defaults)};`);
});

// Auth routes (public)
const authRouter = require('./src/routes/auth');
app.use('/api/auth', authRouter);

// API Routes (protected)
const videosRouter   = require('./src/routes/videos');
const projectsRouter = require('./src/routes/projects');
const exportRouter   = require('./src/routes/export');
const roflRouter     = require('./src/routes/rofl');
const fontsRouter    = require('./src/routes/fonts');
const aiRouter       = require('./src/routes/ai');
const audioRouter    = require('./src/routes/audio');

app.use('/api/videos',   requireAuth, videosRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/export',   requireAuth, exportRouter);
app.use('/api/rofl',     requireAuth, roflRouter);
app.use('/api/fonts',    requireAuth, fontsRouter);
app.use('/api/ai',       requireAuth, aiRouter);
app.use('/api/audio',    requireAuth, audioRouter);

app.listen(PORT, () => {
  console.log(`Video Editor Server running at http://localhost:${PORT}`);
  console.log(`  DATA_DIR:    ${config.DATA_DIR}`);
  console.log(`  UPLOADS_DIR: ${config.UPLOADS_DIR}`);
  console.log(`  EXPORTS_DIR: ${config.EXPORTS_DIR}`);
});
