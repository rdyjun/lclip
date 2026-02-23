'use strict';
/**
 * Central configuration — all storage paths are overridable via environment variables.
 *
 * Docker usage  : set DATA_DIR / UPLOADS_DIR / EXPORTS_DIR to the paths INSIDE the container
 *                 and map them to NAS volumes via docker-compose volumes.
 * Bare-metal    : set the env vars to absolute paths on the host filesystem.
 * Default (dev) : everything goes under the project root (original behaviour).
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');   // project root (one level above src/)

module.exports = {
  PORT:        parseInt(process.env.PORT, 10) || 3000,
  DATA_DIR:    process.env.DATA_DIR    || path.join(ROOT, 'data'),
  UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(ROOT, 'uploads'),
  EXPORTS_DIR: process.env.EXPORTS_DIR || path.join(ROOT, 'exports'),
};
