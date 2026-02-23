/**
 * Timeline - multi-layer timeline editor (DOM-based)
 * Clips are real <div> elements — no canvas clear/flash on zoom.
 */
const Timeline = (() => {
  let rulerCanvas, rulerCtx;
  let pxPerSec = 50;
  let scrollX = 0;
  const TRACK_H = 56;

  let drag = null;
  let _isDragging = false; // suppresses render() during drag
  let rightClickInfo = null;
  let _zoomPivot = null;   // { timeAtMouse, mouseX } for mouse-centered zoom
  const SNAP_PX  = 12;     // snap threshold in screen pixels

  function init() {
    rulerCanvas = document.getElementById('timeline-ruler');
    rulerCtx    = rulerCanvas.getContext('2d');

    setupZoom();
    setupEvents();

    EditorState.on('projectLoaded',  () => { renderLabels(); resize(); render(); });
    EditorState.on('clipsChanged',   () => { if (!_isDragging) render(); });
    EditorState.on('layersChanged',  () => { renderLabels(); resize(); render(); });
    EditorState.on('timeChanged',    renderPlayhead);
    EditorState.on('selectionChanged', () => { if (!_isDragging) render(); });

    window.addEventListener('resize', () => { resize(); renderRuler(); });
  }

  // ── Zoom ────────────────────────────────────────────────────────────────────
  let _zoomRaf     = null;
  let _pendingZoom = pxPerSec;

  function calcZoomNext(cur, dir) {
    let next;
    if (dir > 0) {
      next = cur < 1    ? +(cur + 0.1).toFixed(2)
           : cur < 5    ? cur + 1
           : cur < 50   ? cur + 5
           : cur < 200  ? cur + 20
           : cur < 1200 ? cur + 100 : cur + 500;
    } else {
      next = cur <= 1    ? +(cur - 0.1).toFixed(2)
           : cur <= 5    ? cur - 1
           : cur <= 50   ? cur - 5
           : cur <= 200  ? cur - 20
           : cur <= 1200 ? cur - 100 : cur - 500;
    }
    return Math.max(0.1, +next.toFixed(2));
  }

  function setupZoom() {
    const slider = document.getElementById('tl-zoom-slider');
    document.getElementById('tl-zoom-in').addEventListener('click', () => {
      const next = calcZoomNext(parseFloat(slider.value), +1);
      slider.value = next;
      onZoomChange(next);
    });
    document.getElementById('tl-zoom-out').addEventListener('click', () => {
      const next = calcZoomNext(parseFloat(slider.value), -1);
      slider.value = next;
      onZoomChange(next);
    });
    slider.addEventListener('input', () => onZoomChange(parseFloat(slider.value)));
  }

  function onZoomChange(val, pivot) {
    const fps     = getFps();
    const framePx = val / fps;
    const label   = framePx >= 1 ? `${val}px/s · ${framePx.toFixed(1)}px/f` : `${val}px/s`;
    document.getElementById('tl-zoom-label').textContent = label;

    _pendingZoom = val;
    if (pivot) _zoomPivot = pivot; // update pivot on every scroll event
    if (_zoomRaf) return;
    _zoomRaf = requestAnimationFrame(() => {
      _zoomRaf  = null;
      pxPerSec  = _pendingZoom;
      applyZoom();
    });
  }

  /** Zoom without rebuilding DOM — just update CSS widths/lefts */
  function applyZoom() {
    const wrapper  = document.getElementById('timeline-tracks-wrapper');
    const inner    = document.getElementById('timeline-tracks-inner');
    const duration = EditorState.getTotalDuration();
    const totalW   = Math.max(duration * pxPerSec + 200, wrapper.clientWidth);
    inner.style.width = totalW + 'px';

    document.querySelectorAll('.tl-clip').forEach(el => {
      const clip = EditorState.getClip(el.dataset.layerId, el.dataset.clipId);
      if (clip) positionClip(el, clip);
    });

    // Restore scroll so the time under mouse stays in place
    if (_zoomPivot) {
      const wrapper = document.getElementById('timeline-tracks-wrapper');
      wrapper.scrollLeft = Math.max(0, _zoomPivot.timeAtMouse * pxPerSec - _zoomPivot.mouseX);
      scrollX    = wrapper.scrollLeft;
      _zoomPivot = null;
    }

    renderRuler();
    renderPlayhead();
  }

  // ── Resize ──────────────────────────────────────────────────────────────────
  function resize() {
    const project        = EditorState.getProject();
    const wrapper        = document.getElementById('timeline-tracks-wrapper');
    const inner          = document.getElementById('timeline-tracks-inner');
    const labelContainer = document.getElementById('timeline-labels');

    const numLayers = project ? project.layers.length : 0;
    const totalH    = numLayers * TRACK_H;
    const duration  = EditorState.getTotalDuration();
    const totalW    = Math.max(duration * pxPerSec + 200, wrapper.clientWidth);

    inner.style.width  = totalW + 'px';
    inner.style.height = (totalH || TRACK_H) + 'px';
    labelContainer.style.height = totalH + 'px';

    rulerCanvas.width  = wrapper.clientWidth;
    rulerCanvas.height = 28;

    renderRuler();
    renderPlayhead();
  }

  // ── Render (DOM) ─────────────────────────────────────────────────────────────
  function render() {
    const project = EditorState.getProject();
    const inner   = document.getElementById('timeline-tracks-inner');
    if (!inner) return;
    inner.innerHTML = '';
    if (!project) return;

    const layers         = [...project.layers].sort((a, b) => b.order - a.order);
    const selectedClipId = EditorState.getSelectedClip();

    layers.forEach(layer => {
      const trackEl = document.createElement('div');
      trackEl.className        = 'tl-track';
      trackEl.dataset.layerId  = layer.id;

      if (layer.visible !== false) {
        layer.clips.forEach(clip => {
          trackEl.appendChild(createClipEl(layer, clip, clip.id === selectedClipId));
        });
      }
      inner.appendChild(trackEl);
    });

    // New-layer drop zone (shown during cross-layer drag below all tracks)
    const zoneEl = document.createElement('div');
    zoneEl.id          = 'tl-new-layer-zone';
    zoneEl.textContent = '+ 새 레이어에 놓기';
    inner.appendChild(zoneEl);

    resize();
  }

  function createClipEl(layer, clip, isSelected) {
    const typeClass = clip.type === 'video'    ? 'video-clip'
                    : clip.type === 'subtitle' ? 'subtitle-clip' : 'audio-clip';
    const filteredClass = clip.isFiltered ? ' filtered-clip' : '';

    const el = document.createElement('div');
    el.className        = `tl-clip ${typeClass}${filteredClass}${isSelected ? ' selected' : ''}`;
    el.dataset.clipId   = clip.id;
    el.dataset.layerId  = layer.id;
    positionClip(el, clip);

    const leftHandle = document.createElement('div');
    leftHandle.className = 'tl-handle left';

    const label = document.createElement('span');
    label.className = 'tl-clip-label';
    if (clip.isFiltered && clip.eventTypes && clip.eventTypes.length) {
      const badges = clip.eventTypes.map(t =>
        t === 'kill' ? '⚔' : t === 'death' ? '💀' : '🤝').join('');
      label.textContent = `${badges} ${clip.name || '비디오'}`;
    } else {
      label.textContent = clip.text || clip.name || (clip.type === 'video' ? '비디오' : clip.type);
    }

    const rightHandle = document.createElement('div');
    rightHandle.className = 'tl-handle right';

    el.appendChild(leftHandle);
    el.appendChild(label);
    el.appendChild(rightHandle);

    // Drag events
    leftHandle.addEventListener('mousedown', e => {
      e.stopPropagation();
      beginDrag(e, 'resize-start', layer.id, clip.id);
    });
    rightHandle.addEventListener('mousedown', e => {
      e.stopPropagation();
      beginDrag(e, 'resize-end', layer.id, clip.id);
    });
    el.addEventListener('mousedown', e => {
      beginDrag(e, 'move', layer.id, clip.id);
    });

    // Context menu
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      EditorState.selectClip(layer.id, clip.id);
      const rect   = el.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      rightClickInfo = { layerId: layer.id, clipId: clip.id, x: clip.startTime * pxPerSec + localX };
      window.rightClickInfo = rightClickInfo;
      const menu = document.getElementById('context-menu');
      menu.style.display = 'block';
      menu.style.left    = e.clientX + 'px';
      menu.style.top     = e.clientY + 'px';
    });

    return el;
  }

  function positionClip(el, clip) {
    el.style.left  = (clip.startTime * pxPerSec) + 'px';
    el.style.width = Math.max((clip.endTime - clip.startTime) * pxPerSec, 4) + 'px';
  }

  // ── Drag ─────────────────────────────────────────────────────────────────────
  function beginDrag(e, type, layerId, clipId) {
    if (e.button !== 0) return;
    e.preventDefault();

    const clip = EditorState.getClip(layerId, clipId);
    if (!clip) return;

    EditorState.selectClip(layerId, clipId);

    // Razor tool: split on click (filtered clips cannot be cut)
    if (type === 'move' && EditorState.getActiveTool() === 'razor') {
      if (clip.isFiltered) return; // filtered clips are cut-protected
      const rect        = e.currentTarget.getBoundingClientRect();
      const localOffset = e.clientX - rect.left;
      const t           = clip.startTime + localOffset / pxPerSec;
      EditorState.saveSnapshot();
      splitClip(layerId, clipId, t);
      return;
    }

    EditorState.saveSnapshot();
    _isDragging = true;
    document.body.style.cursor = type === 'move' ? 'grabbing' : 'ew-resize';

    drag = {
      type, layerId, clipId,
      currentLayerId: layerId, // tracks visual layer during cross-layer drag
      startClientX: e.clientX,
      startClientY: e.clientY,
      origStart:    clip.startTime,
      origEnd:      clip.endTime,
      origSrcStart: clip.srcStart ?? 0,
      origSrcEnd:   clip.srcEnd   ?? (clip.endTime - clip.startTime),
      el:           type === 'move' ? e.currentTarget : null,
      targetNewLayer: false
    };
  }

  function onMouseMove(e) {
    if (!drag) return;

    const dx      = e.clientX - drag.startClientX;
    const dt      = dx / pxPerSec;
    const clip    = EditorState.getClip(drag.layerId, drag.clipId);
    if (!clip) return;

    const project = EditorState.getProject();
    const minDur  = 1 / getFps();

    if (drag.type === 'move') {
      const dur      = drag.origEnd - drag.origStart;
      const rawStart = Math.max(0, drag.origStart + dt);
      const edges        = getSnapEdges(drag.clipId);
      const sStart       = snapToEdges(rawStart, edges);
      const sEnd         = snapToEdges(rawStart + dur, edges);
      const dStart       = Math.abs(sStart - rawStart);
      const dEnd         = Math.abs(sEnd - (rawStart + dur));
      const snappedStart = dStart > 0;
      const snappedEnd   = dEnd > 0;
      let newStart;
      if (snappedStart && snappedEnd) {
        // Both edges near a snap point — pick whichever is closer
        newStart = dStart <= dEnd ? Math.max(0, sStart) : Math.max(0, sEnd - dur);
      } else if (snappedStart) {
        newStart = Math.max(0, sStart);
      } else if (snappedEnd) {
        newStart = Math.max(0, sEnd - dur);
      } else {
        newStart = snapFrame(rawStart);
      }
      EditorState.updateClip(drag.layerId, drag.clipId, {
        startTime: newStart,
        endTime:   newStart + dur
      });
    } else if (drag.type === 'resize-start') {
      const rawStart   = Math.max(0, Math.min(drag.origEnd - minDur, drag.origStart + dt));
      const edges      = getSnapEdges(drag.clipId);
      const sStart     = snapToEdges(rawStart, edges);
      const newStart   = Math.abs(sStart - rawStart) > 0 ? Math.max(0, sStart) : snapFrame(rawStart);
      const startDelta = newStart - drag.origStart;
      EditorState.updateClip(drag.layerId, drag.clipId, {
        startTime: newStart,
        srcStart:  clip.type !== 'subtitle'
          ? Math.min(drag.origSrcStart + startDelta, drag.origSrcEnd - minDur)
          : clip.srcStart
      });
    } else if (drag.type === 'resize-end') {
      const maxSrcEnd = clip.type !== 'subtitle' ? (project.sourceVideoDuration || 9999) : 9999;
      const rawEnd    = Math.max(
        drag.origStart + minDur,
        Math.min(drag.origEnd + dt, drag.origStart + (maxSrcEnd - (clip.srcStart || 0)))
      );
      const edges     = getSnapEdges(drag.clipId);
      const sEnd      = snapToEdges(rawEnd, edges);
      const newEnd    = Math.abs(sEnd - rawEnd) > 0
        ? Math.max(drag.origStart + minDur, sEnd)
        : snapFrame(rawEnd);
      const endDelta  = newEnd - drag.origEnd;
      EditorState.updateClip(drag.layerId, drag.clipId, {
        endTime: newEnd,
        srcEnd:  clip.type !== 'subtitle'
          ? Math.min(drag.origSrcEnd + endDelta, maxSrcEnd)
          : clip.srcEnd
      });
    }

    // Update only this clip's position — no DOM rebuild
    const updated = EditorState.getClip(drag.layerId, drag.clipId);
    const clipEl  = document.querySelector(`.tl-clip[data-clip-id="${drag.clipId}"]`);
    if (clipEl && updated) positionClip(clipEl, updated);

    // ── Cross-layer detection (move only) ────────────────────────────────────
    if (drag.type === 'move' && drag.el) {
      const wrapper     = document.getElementById('timeline-tracks-wrapper');
      const wrapperRect = wrapper.getBoundingClientRect();
      const localY      = e.clientY - wrapperRect.top + wrapper.scrollTop;
      const project     = EditorState.getProject();
      const sortedLayers = [...project.layers].sort((a, b) => b.order - a.order);
      const trackIdx    = Math.floor(localY / TRACK_H);
      const zoneEl      = document.getElementById('tl-new-layer-zone');

      if (trackIdx >= sortedLayers.length) {
        // Below all tracks → new layer zone
        if (zoneEl) zoneEl.classList.add('active');
        drag.targetNewLayer = true;
      } else {
        if (zoneEl) zoneEl.classList.remove('active');
        drag.targetNewLayer = false;
        if (trackIdx >= 0) {
          const targetLayer = sortedLayers[trackIdx];
          if (targetLayer && targetLayer.id !== drag.currentLayerId) {
            const targetTrack = document.querySelector(`.tl-track[data-layer-id="${targetLayer.id}"]`);
            if (targetTrack) {
              targetTrack.appendChild(drag.el);
              drag.currentLayerId = targetLayer.id;
              drag.el.dataset.layerId = targetLayer.id;
            }
          }
        }
      }
    }

    renderPlayhead();
    Player.renderFrame();
  }

  function onMouseUp() {
    if (!drag) return;

    const { type, layerId, currentLayerId, clipId, targetNewLayer } = drag;

    // ── Commit cross-layer move ───────────────────────────────────────────────
    if (type === 'move' && (targetNewLayer || currentLayerId !== layerId)) {
      const clipData = EditorState.getClip(layerId, clipId);
      const project  = EditorState.getProject();

      if (clipData && project) {
        const origLayer = EditorState.getLayer(layerId);

        if (targetNewLayer) {
          // Drop into new layer at the bottom of the stack
          if (origLayer) origLayer.clips = origLayer.clips.filter(c => c.id !== clipId);
          const minOrder = project.layers.length
            ? Math.min(...project.layers.map(l => l.order)) - 1
            : 0;
          const newLayer = {
            id:      EditorState.genId(),
            name:    `레이어 ${project.layers.length + 1}`,
            type:    clipData.type,
            order:   minOrder,
            visible: true,
            clips:   [{ ...clipData }]
          };
          project.layers.push(newLayer);
          EditorState.selectClip(newLayer.id, clipId);
          EditorState.emit('layersChanged');
        } else {
          // Drop into a different existing layer
          if (origLayer) origLayer.clips = origLayer.clips.filter(c => c.id !== clipId);
          const destLayer = EditorState.getLayer(currentLayerId);
          if (destLayer) destLayer.clips.push({ ...clipData });
          EditorState.selectClip(currentLayerId, clipId);
          EditorState.emit('layersChanged');
        }
      }
    }

    // Clean up drop zone highlight
    const zoneEl = document.getElementById('tl-new-layer-zone');
    if (zoneEl) zoneEl.classList.remove('active');

    _isDragging            = false;
    drag                   = null;
    document.body.style.cursor = '';
    render(); // final sync after drag ends
  }

  // ── Events ───────────────────────────────────────────────────────────────────
  function setupEvents() {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);

    rulerCanvas.addEventListener('mousedown', onRulerClick);

    const wrapper = document.getElementById('timeline-tracks-wrapper');
    wrapper.addEventListener('scroll', () => {
      scrollX = wrapper.scrollLeft;
      renderRuler();
    });

    wrapper.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect        = wrapper.getBoundingClientRect();
      const mouseX      = e.clientX - rect.left;
      const timeAtMouse = (mouseX + wrapper.scrollLeft) / pxPerSec;
      const slider      = document.getElementById('tl-zoom-slider');
      const next        = calcZoomNext(parseFloat(slider.value), e.deltaY < 0 ? +1 : -1);
      slider.value      = next;
      onZoomChange(next, { timeAtMouse, mouseX });
    }, { passive: false });
  }

  function onRulerClick(e) {
    const rect = rulerCanvas.getBoundingClientRect();
    const x    = e.clientX - rect.left + scrollX;
    EditorState.setCurrentTime(Math.max(0, xToTime(x)));
  }

  // ── Ruler (canvas) ───────────────────────────────────────────────────────────
  function renderRuler() {
    rulerCtx.clearRect(0, 0, rulerCanvas.width, rulerCanvas.height);
    rulerCtx.fillStyle = '#1a1a23';
    rulerCtx.fillRect(0, 0, rulerCanvas.width, rulerCanvas.height);

    rulerCtx.strokeStyle = '#2a2a3a';
    rulerCtx.lineWidth   = 1;
    rulerCtx.beginPath();
    rulerCtx.moveTo(0, 27);
    rulerCtx.lineTo(rulerCanvas.width, 27);
    rulerCtx.stroke();

    const project  = EditorState.getProject();
    const fps      = project ? (project.fps || 30) : 30;
    const duration = EditorState.getTotalDuration() + 10;
    const framePx  = pxPerSec / fps;

    // Frame-level markers when zoomed in enough
    if (framePx >= 6) {
      const totalFrames = Math.ceil(duration * fps);
      for (let f = 0; f <= totalFrames; f++) {
        const x = timeToX(f / fps) - scrollX;
        if (x < -2 || x > rulerCanvas.width + 2) continue;
        const isSec = f % fps === 0;
        rulerCtx.strokeStyle = isSec ? '#4a4a60' : '#2e2e42';
        rulerCtx.lineWidth   = 1;
        rulerCtx.beginPath();
        rulerCtx.moveTo(x, isSec ? 14 : 20);
        rulerCtx.lineTo(x, 28);
        rulerCtx.stroke();
        if (framePx >= 20 && !isSec) {
          const showEvery = framePx >= 40 ? 1 : framePx >= 20 ? 2 : 5;
          if (f % showEvery === 0) {
            rulerCtx.fillStyle    = '#44445a';
            rulerCtx.font         = '8px monospace';
            rulerCtx.textBaseline = 'top';
            rulerCtx.fillText(`${f % fps}`, x + 1, 17);
          }
        }
      }
    }

    // Second / minute markers
    const step = getGridStep();
    rulerCtx.fillStyle    = '#666680';
    rulerCtx.font         = '10px monospace';
    rulerCtx.textBaseline = 'middle';

    for (let t = 0; t <= duration; t += step) {
      const x = timeToX(t) - scrollX;
      if (x < 0 || x > rulerCanvas.width) continue;
      rulerCtx.strokeStyle = '#4a4a60';
      rulerCtx.lineWidth   = 1;
      rulerCtx.beginPath();
      rulerCtx.moveTo(x, 12);
      rulerCtx.lineTo(x, 28);
      rulerCtx.stroke();
      rulerCtx.fillText(formatTime(t), x + 2, 7);
    }
  }

  // ── Playhead ─────────────────────────────────────────────────────────────────
  function renderPlayhead() {
    document.getElementById('playhead-line').style.left = timeToX(EditorState.getCurrentTime()) + 'px';
  }

  // ── Labels ───────────────────────────────────────────────────────────────────
  function renderLabels() {
    const project   = EditorState.getProject();
    const container = document.getElementById('timeline-labels');
    container.innerHTML = '';
    if (!project) return;

    const layers = [...project.layers].sort((a, b) => b.order - a.order);

    layers.forEach((layer, displayIdx) => {
      const el = document.createElement('div');
      el.className       = 'layer-label';
      el.dataset.layerId = layer.id;
      el.draggable       = true;
      if (EditorState.getSelectedLayer() === layer.id) el.classList.add('selected');

      const dragHandle = document.createElement('div');
      dragHandle.className   = 'layer-drag-handle';
      dragHandle.textContent = '⠿';

      const badge = document.createElement('div');
      badge.className   = `layer-type-badge badge-${layer.type}`;
      badge.textContent = layer.type === 'video' ? '🎬' : layer.type === 'subtitle' ? '💬' : '🎵';

      const text = document.createElement('span');
      text.className   = 'layer-label-text';
      text.textContent = layer.name;

      const visBtn = document.createElement('button');
      visBtn.className   = 'layer-vis-btn';
      visBtn.textContent = layer.visible !== false ? '👁' : '🚫';
      visBtn.title       = '표시/숨기기';
      visBtn.addEventListener('click', e => {
        e.stopPropagation();
        EditorState.updateLayer(layer.id, { visible: layer.visible === false });
        renderLabels();
        Player.renderFrame();
      });

      el.appendChild(dragHandle);
      el.appendChild(badge);
      el.appendChild(text);
      el.appendChild(visBtn);

      // Drag-to-reorder
      el.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', layer.id);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => el.classList.add('dragging'), 0);
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', e => {
        if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
      });
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const srcId = e.dataTransfer.getData('text/plain');
        if (!srcId || srcId === layer.id) return;
        const current  = [...project.layers].sort((a, b) => b.order - a.order);
        const srcIdx   = current.findIndex(l => l.id === srcId);
        if (srcIdx === -1) return;
        const reordered = [...current];
        const [moved]   = reordered.splice(srcIdx, 1);
        reordered.splice(displayIdx, 0, moved);
        EditorState.saveSnapshot();
        EditorState.reorderLayers(reordered.map(l => l.id));
      });

      el.addEventListener('click', () => {
        EditorState.selectClip(layer.id, null);
        renderLabels();
      });

      container.appendChild(el);
    });
  }

  // ── Split Clip ───────────────────────────────────────────────────────────────
  function splitClip(layerId, clipId, t) {
    const clip = EditorState.getClip(layerId, clipId);
    if (!clip || t <= clip.startTime || t >= clip.endTime) return;

    const ratio    = (t - clip.startTime) / (clip.endTime - clip.startTime);
    const splitSrc = (clip.srcStart || 0) + ((clip.srcEnd || 0) - (clip.srcStart || 0)) * ratio;

    const newClip = {
      ...clip,
      id:        EditorState.genId(),
      startTime: t,
      endTime:   clip.endTime,
      srcStart:  splitSrc,
      srcEnd:    clip.srcEnd
    };

    const prev = _isDragging;
    _isDragging = true; // suppress intermediate renders
    EditorState.updateClip(layerId, clipId, { endTime: t, srcEnd: splitSrc });
    EditorState.addClip(layerId, newClip);
    _isDragging = prev;
    render();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function timeToX(t)    { return t * pxPerSec; }
  function xToTime(x)    { return x / pxPerSec; }
  function getFps()      { const p = EditorState.getProject(); return p ? (p.fps || 30) : 30; }
  function snapFrame(t)  { const fps = getFps(); return Math.round(t * fps) / fps; }

  /** Returns all clip edge times except for the excluded clip */
  function getSnapEdges(excludeClipId) {
    const project = EditorState.getProject();
    if (!project) return [];
    const edges = [];
    for (const layer of project.layers) {
      for (const clip of layer.clips) {
        if (clip.id === excludeClipId) continue;
        edges.push(clip.startTime, clip.endTime);
      }
    }
    return edges;
  }

  /** Snaps t to nearest edge within SNAP_PX threshold; returns t unchanged if nothing close */
  function snapToEdges(t, edges) {
    const threshold = SNAP_PX / pxPerSec;
    let best = t, bestDist = threshold;
    for (const edge of edges) {
      const dist = Math.abs(t - edge);
      if (dist < bestDist) { bestDist = dist; best = edge; }
    }
    return best;
  }

  function getGridStep() {
    if (pxPerSec >= 200) return 1;
    if (pxPerSec >= 80)  return 1;
    if (pxPerSec >= 40)  return 2;
    if (pxPerSec >= 20)  return 5;
    if (pxPerSec >= 10)  return 10;
    if (pxPerSec >= 1)   return 30;
    if (pxPerSec >= 0.3) return 60;   // 1분 간격
    return 300;                        // 5분 간격
  }

  function formatTime(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
  }

  return { init, render, renderLabels, renderRuler, resize };
})();
