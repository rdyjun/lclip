const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const DATA_DIR = config.DATA_DIR;

function readDb(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  return fs.readJsonSync(file);
}

function writeDb(name, data) {
  const file = path.join(DATA_DIR, `${name}.json`);
  fs.writeJsonSync(file, data, { spaces: 2 });
}

// ─── Videos ────────────────────────────────────────────────────────────────
const Videos = {
  findAll() { return readDb('videos'); },
  findById(id) { return readDb('videos').find(v => v.id === id); },
  create(data) {
    const videos = readDb('videos');
    const video = { id: uuidv4(), createdAt: new Date().toISOString(), ...data };
    videos.push(video);
    writeDb('videos', videos);
    return video;
  },
  update(id, data) {
    const videos = readDb('videos');
    const idx = videos.findIndex(v => v.id === id);
    if (idx === -1) return null;
    videos[idx] = { ...videos[idx], ...data };
    writeDb('videos', videos);
    return videos[idx];
  },
  delete(id) {
    const videos = readDb('videos');
    const filtered = videos.filter(v => v.id !== id);
    writeDb('videos', filtered);
  }
};

// ─── Projects ───────────────────────────────────────────────────────────────
const Projects = {
  findAll() { return readDb('projects'); },
  findById(id) { return readDb('projects').find(p => p.id === id); },
  findByVideoId(videoId) { return readDb('projects').filter(p => p.sourceVideoId === videoId); },
  create(data) {
    const projects = readDb('projects');
    const project = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: 'New Short',
      outputWidth: 1080,
      outputHeight: 1920,
      fps: 30,
      layers: [],
      ...data
    };
    projects.push(project);
    writeDb('projects', projects);
    return project;
  },
  update(id, data) {
    const projects = readDb('projects');
    const idx = projects.findIndex(p => p.id === id);
    if (idx === -1) return null;
    projects[idx] = { ...projects[idx], ...data, updatedAt: new Date().toISOString() };
    writeDb('projects', projects);
    return projects[idx];
  },
  delete(id) {
    const projects = readDb('projects');
    const filtered = projects.filter(p => p.id !== id);
    writeDb('projects', filtered);
  }
};

module.exports = { Videos, Projects, uuidv4 };
