/**
 * Editor State - single source of truth
 */
const EditorState = (() => {
  let _project = null;
  let _currentTime = 0;
  let _playing = false;
  let _selectedClipId = null;
  let _selectedLayerId = null;
  let _activeTool = 'select'; // 'select' | 'razor'
  let _listeners = {};

  // ── History (undo / redo) ───────────────────────────────────────────────────
  const MAX_HISTORY = 50;
  let _undoStack = []; // snapshots saved BEFORE each user action
  let _redoStack = []; // snapshots available for redo

  function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }

  function off(event, fn) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(f => f !== fn);
  }

  function emit(event, data) {
    (_listeners[event] || []).forEach(fn => fn(data));
  }

  function getProject() { return _project; }
  function setProject(p) {
    _project = p;
    _undoStack = [];
    _redoStack = [];
    emit('projectLoaded', p);
  }

  function getCurrentTime() { return _currentTime; }
  function setCurrentTime(t) {
    _currentTime = Math.max(0, t);
    emit('timeChanged', _currentTime);
  }

  function isPlaying() { return _playing; }
  function setPlaying(v) {
    _playing = v;
    emit('playStateChanged', v);
  }

  function getSelectedClip() { return _selectedClipId; }
  function getSelectedLayer() { return _selectedLayerId; }
  function selectClip(layerId, clipId) {
    _selectedLayerId = layerId;
    _selectedClipId = clipId;
    emit('selectionChanged', { layerId, clipId });
  }

  function getActiveTool() { return _activeTool; }
  function setActiveTool(t) {
    _activeTool = t;
    emit('toolChanged', t);
  }

  function getLayer(layerId) {
    if (!_project) return null;
    return _project.layers.find(l => l.id === layerId);
  }

  function getClip(layerId, clipId) {
    const layer = getLayer(layerId);
    if (!layer) return null;
    return layer.clips.find(c => c.id === clipId);
  }

  function getTotalDuration() {
    if (!_project) return 0;
    let max = 0;
    _project.layers.forEach(layer => {
      layer.clips.forEach(clip => { if (clip.endTime > max) max = clip.endTime; });
    });
    return max || (_project.sourceVideoDuration || 60);
  }

  function updateClip(layerId, clipId, updates) {
    const layer = getLayer(layerId);
    if (!layer) return;
    const idx = layer.clips.findIndex(c => c.id === clipId);
    if (idx === -1) return;
    layer.clips[idx] = { ...layer.clips[idx], ...updates };
    emit('clipsChanged', { layerId });
  }

  function addClip(layerId, clip) {
    const layer = getLayer(layerId);
    if (!layer) return;
    layer.clips.push(clip);
    emit('clipsChanged', { layerId });
  }

  function removeClip(layerId, clipId) {
    const layer = getLayer(layerId);
    if (!layer) return;
    layer.clips = layer.clips.filter(c => c.id !== clipId);
    if (_selectedClipId === clipId) { _selectedClipId = null; _selectedLayerId = null; }
    emit('clipsChanged', { layerId });
    emit('selectionChanged', { layerId: null, clipId: null });
  }

  function addLayer(layer) {
    if (!_project) return;
    _project.layers.push(layer);
    emit('layersChanged');
  }

  function removeLayer(layerId) {
    if (!_project) return;
    _project.layers = _project.layers.filter(l => l.id !== layerId);
    emit('layersChanged');
  }

  function updateLayer(layerId, updates) {
    const layer = getLayer(layerId);
    if (!layer) return;
    Object.assign(layer, updates);
    emit('layersChanged');
  }

  // ── Snapshot / Undo / Redo ──────────────────────────────────────────────────
  /** Call BEFORE a user action to make it undoable. */
  function saveSnapshot() {
    if (!_project) return;
    _undoStack.push(JSON.parse(JSON.stringify(_project.layers)));
    _redoStack = []; // new action clears redo branch
    if (_undoStack.length > MAX_HISTORY) _undoStack.shift();
  }

  function undo() {
    if (!_project || _undoStack.length === 0) return;
    _redoStack.push(JSON.parse(JSON.stringify(_project.layers)));
    _project.layers = _undoStack.pop();
    _selectedClipId = null;
    _selectedLayerId = null;
    emit('clipsChanged', {});
    emit('layersChanged');
    emit('selectionChanged', { layerId: null, clipId: null });
  }

  function redo() {
    if (!_project || _redoStack.length === 0) return;
    _undoStack.push(JSON.parse(JSON.stringify(_project.layers)));
    _project.layers = _redoStack.pop();
    _selectedClipId = null;
    _selectedLayerId = null;
    emit('clipsChanged', {});
    emit('layersChanged');
    emit('selectionChanged', { layerId: null, clipId: null });
  }

  function canUndo() { return _undoStack.length > 0; }
  function canRedo() { return _redoStack.length > 0; }

  // orderedIds: layer ids from top of UI to bottom (highest z-order first)
  function reorderLayers(orderedIds) {
    const N = orderedIds.length;
    orderedIds.forEach((id, i) => {
      const layer = getLayer(id);
      if (layer) layer.order = N - 1 - i; // top of list = highest order = drawn last
    });
    emit('layersChanged');
  }

  // Generate unique ID
  function genId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  return {
    on, off, emit,
    getProject, setProject,
    getCurrentTime, setCurrentTime,
    isPlaying, setPlaying,
    getSelectedClip, getSelectedLayer, selectClip,
    getActiveTool, setActiveTool,
    getLayer, getClip, getTotalDuration,
    updateClip, addClip, removeClip,
    addLayer, removeLayer, updateLayer, reorderLayers,
    saveSnapshot, undo, redo, canUndo, canRedo,
    genId
  };
})();
