/**
 * Preview Player
 * - Aspect-ratio-correct rendering (cover / contain / fill)
 * - Video-driven playback — no seek() calls during play (eliminates black frames)
 * - Interactive canvas: click to select, drag to move, drag handles to resize
 * - Ctrl+scroll to zoom; canvas fills preview panel
 * - Dual video elements: standby pre-seeks the next clip for seamless boundary transitions
 */
const Player = (() => {
  let canvas, ctx;
  let videoElA, videoElB;   // two video elements; only one is "active" at a time
  let videoEl;              // pointer to the currently active element
  let animFrameId   = null;
  let lastTimestamp = null;
  let _zoom = 0.25;
  let _lastBoundaryClipId = null; // prevents re-firing on the same clip boundary

  // Standby pre-load state
  let _preloadClipId = null; // id of the clip currently pre-loaded on the standby element

  const OUTPUT_W = 1080, OUTPUT_H = 1920;
  const WS_MARGIN = 150; // workspace margin in output pixels around the output frame
  const HANDLE_PX = 7;  // handle half-size in canvas pixels

  // Pan offset — updated by centerView(); zoom always re-centers the frame
  let _panX = 0, _panY = 0;

  // Drag state for canvas-based clip editing
  let previewDrag    = null;
  let _visibleBounds = []; // clip bounds visible at the current frame

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    canvas  = document.getElementById('preview-canvas');
    ctx     = canvas.getContext('2d');
    videoElA = document.getElementById('preview-video');
    videoElB = document.getElementById('preview-video-b');
    videoEl  = videoElA; // A starts as active

    // Re-render on active element events (paused state only; during play, playLoop handles it)
    function onActiveEvent() {
      if (!EditorState.isPlaying() && this === videoEl) renderFrame();
    }
    videoElA.addEventListener('loadeddata', onActiveEvent);
    videoElA.addEventListener('seeked',     onActiveEvent);
    videoElB.addEventListener('loadeddata', onActiveEvent);
    videoElB.addEventListener('seeked',     onActiveEvent);

    // Size canvas to fill container; re-center on resize
    resizeCanvas();
    new ResizeObserver(resizeCanvas).observe(canvas.parentElement);

    setupMouseEvents();

    EditorState.on('projectLoaded',    () => {
      _preloadClipId = null;
      syncVideoToTime(EditorState.getCurrentTime());
      renderFrame();
    });
    EditorState.on('timeChanged',      onTimeChanged);
    EditorState.on('playStateChanged', onPlayStateChanged);
    EditorState.on('clipsChanged',     () => renderFrame());
    EditorState.on('selectionChanged', () => renderFrame());
    EditorState.on('layersChanged',    () => renderFrame());

    document.getElementById('zoom-in') .addEventListener('click', () => setZoom(Math.min(_zoom + 0.1, 4)));
    document.getElementById('zoom-out').addEventListener('click', () => setZoom(Math.max(_zoom - 0.1, 0.05)));
  }

  // ── Canvas sizing & centering ──────────────────────────────────────────────
  function resizeCanvas() {
    const container = canvas.parentElement;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width  = w;
    canvas.height = h;
    centerView();
    renderFrame();
  }

  function centerView() {
    const totalW = (OUTPUT_W + WS_MARGIN * 2) * _zoom;
    const totalH = (OUTPUT_H + WS_MARGIN * 2) * _zoom;
    _panX = Math.round((canvas.width  - totalW) / 2);
    _panY = Math.round((canvas.height - totalH) / 2);
  }

  function setZoom(z) {
    _zoom = z;
    document.getElementById('zoom-value').textContent = `${Math.round(z * 100)}%`;
    centerView();
    renderFrame();
  }

  // ── Time / Playback ────────────────────────────────────────────────────────
  function onTimeChanged(t) {
    updateTimecode(t);
    if (!EditorState.isPlaying()) {
      // Only sync and render during pause — playLoop manages everything during playback
      syncVideoToTime(t);
      renderFrame();
    }
  }

  function onPlayStateChanged(playing) {
    if (playing) {
      _lastBoundaryClipId = null;
      _preloadClipId      = null;
      syncVideoToTime(EditorState.getCurrentTime());
      videoEl.play().catch(() => {});
      lastTimestamp = null;
      animFrameId   = requestAnimationFrame(playLoop);
    } else {
      if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
      videoEl.pause();
      getStandby().pause();
      renderFrame();
    }
  }

  function syncVideoToTime(t) {
    const project = EditorState.getProject();
    if (!project) return;
    let clip = null;
    for (const layer of project.layers) {
      if (layer.visible === false) continue;
      const c = layer.clips.find(c => c.type === 'video' && c.startTime <= t && c.endTime > t);
      if (c) { clip = c; break; }
    }
    if (!clip) { videoEl.pause(); return; }

    const src = clip.src;
    if (videoEl.getAttribute('data-clip-src') !== src) {
      videoEl.src = src;
      videoEl.setAttribute('data-clip-src', src);
    }
    const vt = clip.srcStart + (t - clip.startTime);
    if (Math.abs(videoEl.currentTime - vt) > 0.08) videoEl.currentTime = vt;
  }

  // ── Dual-element helpers ───────────────────────────────────────────────────
  function getStandby() { return videoEl === videoElA ? videoElB : videoElA; }

  /** Pre-seek the standby element to the start of the next clip */
  function preloadNextClip(nextClip) {
    if (_preloadClipId === nextClip.id) return; // already in progress
    _preloadClipId = nextClip.id;
    const standby = getStandby();
    if (standby.getAttribute('data-clip-src') !== nextClip.src) {
      standby.src = nextClip.src;
      standby.setAttribute('data-clip-src', nextClip.src);
    }
    standby.currentTime = nextClip.srcStart;
    // Browser will seek async; readyState check at switch time confirms readiness
  }

  /** Switch active element to the standby (which has nextClip pre-loaded) */
  function switchToNextClip(nextClip) {
    const standby = getStandby();
    const old     = videoEl;

    if (_preloadClipId === nextClip.id && standby.readyState >= 2) {
      // Seamless swap — standby is already at the right frame
      videoEl = standby;
      videoEl.play().catch(() => {});
      old.pause();
    } else {
      // Fallback: direct seek on the active element (may stutter briefly)
      if (videoEl.getAttribute('data-clip-src') !== nextClip.src) {
        videoEl.src = nextClip.src;
        videoEl.setAttribute('data-clip-src', nextClip.src);
      }
      videoEl.currentTime = nextClip.srcStart;
      videoEl.play().catch(() => {});
    }
    _preloadClipId = null;
  }

  /** Find the nearest video clip that starts at or after clip.endTime */
  function findNextVideoClip(project, clip) {
    let next = null;
    for (const layer of project.layers) {
      if (layer.visible === false) continue;
      layer.clips.forEach(c => {
        if (c.type === 'video' && c.startTime >= clip.endTime) {
          if (!next || c.startTime < next.startTime) next = c;
        }
      });
    }
    return next;
  }

  // ── Animation loop ─────────────────────────────────────────────────────────
  function playLoop(ts) {
    if (!EditorState.isPlaying()) return;

    const project = EditorState.getProject();
    const t       = EditorState.getCurrentTime();

    // Find the video clip active at time t
    let clip = null;
    if (project) {
      for (const layer of project.layers) {
        if (layer.visible === false) continue;
        const c = layer.clips.find(c => c.type === 'video' && c.startTime <= t + 0.05 && c.endTime > t);
        if (c) { clip = c; break; }
      }
    }

    let newTime;

    if (clip && videoEl.readyState >= 2 && !videoEl.paused) {
      const derived = clip.startTime + (videoEl.currentTime - clip.srcStart);

      // Guard: if derived time diverges from editor time by >0.5 s, the video element
      // is still transitioning (src change / seek not yet settled) — use wall-clock timer.
      // This replaces the old "derived < clip.startTime - 0.5" check which failed when
      // clip.srcStart ≈ 0 (derived would equal clip.startTime, not triggering the guard,
      // causing a spurious reset to t=0).
      if (Math.abs(derived - t) > 0.5) {
        if (lastTimestamp !== null) newTime = t + (ts - lastTimestamp) / 1000;
      } else {
        newTime = derived;
      }

      if (newTime !== undefined && project) {
        const nextClip = findNextVideoClip(project, clip);

        // Pre-roll: start loading the standby element ~1.5 s before the boundary
        if (nextClip && newTime >= clip.endTime - 1.5) {
          preloadNextClip(nextClip);
        }

        // Boundary transition: swap to the pre-loaded standby element
        if (newTime >= clip.endTime - 0.02 && _lastBoundaryClipId !== clip.id) {
          _lastBoundaryClipId = clip.id;
          if (nextClip) switchToNextClip(nextClip);
        }
      }
    } else {
      // Timer-driven fallback: no active video clip (subtitle-only section) or video not ready
      if (lastTimestamp !== null) newTime = t + (ts - lastTimestamp) / 1000;
    }

    lastTimestamp = ts;

    if (newTime !== undefined) {
      const dur = EditorState.getTotalDuration();
      if (newTime >= dur) {
        EditorState.setCurrentTime(0);
        EditorState.setPlaying(false);
        return;
      }
      EditorState.setCurrentTime(newTime);
    }

    renderFrame();
    animFrameId = requestAnimationFrame(playLoop);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function renderFrame() {
    const t       = EditorState.getCurrentTime();
    const project = EditorState.getProject();

    // 1. Workspace background (full canvas, no transform)
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Content drawn in pan-translated space
    ctx.save();
    ctx.translate(_panX, _panY);

    const ofx = WS_MARGIN * _zoom, ofy = WS_MARGIN * _zoom;
    const ofw = OUTPUT_W * _zoom,   ofh = OUTPUT_H * _zoom;
    ctx.fillStyle = '#000';
    ctx.fillRect(ofx, ofy, ofw, ofh);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(ofx, ofy, ofw, ofh);

    if (!project) { ctx.restore(); return; }

    _visibleBounds = [];
    const z = _zoom;

    [...project.layers].sort((a, b) => a.order - b.order).forEach(layer => {
      if (layer.visible === false) return;
      layer.clips.forEach(clip => {
        if (clip.startTime > t || clip.endTime <= t) return;
        if (clip.type === 'video') {
          drawVideoClip(clip, z);
          _visibleBounds.push({ layerId: layer.id, clipId: clip.id, ...videoBounds(clip) });
        } else if (clip.type === 'subtitle') {
          const b = drawSubtitle(clip, z);
          if (b) _visibleBounds.push({ layerId: layer.id, clipId: clip.id, ...b });
        }
      });
    });

    ctx.restore();

    // 3. Dim overlay in screen space (output frame coords + pan offset)
    const sfx = ofx + _panX, sfy = ofy + _panY;
    const sfw = ofw, sfh = ofh;

    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    const topH = Math.max(0, Math.min(sfy, canvas.height));
    if (topH > 0) ctx.fillRect(0, 0, canvas.width, topH);
    const botY = Math.max(0, Math.min(sfy + sfh, canvas.height));
    if (canvas.height - botY > 0) ctx.fillRect(0, botY, canvas.width, canvas.height - botY);
    const oy1 = Math.max(0, Math.min(sfy, canvas.height));
    const oy2 = Math.max(0, Math.min(sfy + sfh, canvas.height));
    const oH  = oy2 - oy1;
    if (oH > 0) {
      const leftW = Math.max(0, Math.min(sfx, canvas.width));
      if (leftW > 0) ctx.fillRect(0, oy1, leftW, oH);
      const rightX = Math.max(0, Math.min(sfx + sfw, canvas.width));
      if (canvas.width - rightX > 0) ctx.fillRect(rightX, oy1, canvas.width - rightX, oH);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(sfx + 0.5, sfy + 0.5, sfw - 1, sfh - 1);

    // 4. Selection handles (screen space, above overlay)
    const selId = EditorState.getSelectedClip();
    if (selId) {
      const b = _visibleBounds.find(b => b.clipId === selId);
      if (b) drawHandles(b, z);
    }
  }

  // ── Clip drawing ───────────────────────────────────────────────────────────
  function videoBounds(clip) {
    return { x: clip.x || 0, y: clip.y || 0, w: clip.width || OUTPUT_W, h: clip.height || OUTPUT_H };
  }

  function subtitleBounds(clip) {
    const lines    = (clip.text || '').split('\n');
    const fontSize = clip.fontSize || 48;
    const pad      = clip.backgroundPadding || 16;
    const lineH    = fontSize * 1.3;
    const maxW     = Math.max(...lines.map(l => l.length * fontSize * 0.56), fontSize);
    const cx       = clip.x || OUTPUT_W / 2;
    const cy       = clip.y || 200;
    return { x: cx - maxW / 2 - pad, y: cy - pad, w: maxW + pad * 2, h: lines.length * lineH + pad * 2 };
  }

  function drawVideoClip(clip, z) {
    if (videoEl.readyState < 2) return;

    const dx   = (WS_MARGIN + (clip.x || 0)) * z, dy = (WS_MARGIN + (clip.y || 0)) * z;
    const dw   = (clip.width  || OUTPUT_W) * z, dh = (clip.height || OUTPUT_H) * z;
    const srcW = videoEl.videoWidth,             srcH = videoEl.videoHeight;
    const fit  = clip.fit || 'cover';

    ctx.save();
    ctx.globalAlpha = clip.opacity !== undefined ? clip.opacity : 1;

    if (!srcW || !srcH || fit === 'fill') {
      ctx.drawImage(videoEl, dx, dy, dw, dh);
    } else {
      const sa = srcW / srcH, da = dw / dh;
      if (fit === 'cover') {
        let sx, sy, sw, sh;
        if (sa > da) { sh = srcH; sw = srcH * da; sx = (srcW - sw) / 2; sy = 0; }
        else         { sw = srcW; sh = srcW / da; sx = 0; sy = (srcH - sh) / 2; }
        ctx.save(); ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
        ctx.drawImage(videoEl, sx, sy, sw, sh, dx, dy, dw, dh);
        ctx.restore();
      } else {
        ctx.fillStyle = '#000'; ctx.fillRect(dx, dy, dw, dh);
        if (sa > da) { const h = dw / sa; ctx.drawImage(videoEl, dx, dy + (dh - h) / 2, dw, h); }
        else         { const w = dh * sa; ctx.drawImage(videoEl, dx + (dw - w) / 2, dy, w, dh); }
      }
    }
    ctx.restore();
  }

  function drawSubtitle(clip, z) {
    const text = clip.text || '';
    if (!text) return null;

    const fontSize = (clip.fontSize || 48) * z;
    const cx       = (WS_MARGIN + (clip.x || OUTPUT_W / 2)) * z;
    const cy       = (WS_MARGIN + (clip.y || 200)) * z;
    const padding  = (clip.backgroundPadding || 16) * z;
    const lineH    = fontSize * 1.3;
    const lines    = text.split('\n');

    ctx.save();
    ctx.font         = `${clip.bold ? 'bold ' : ''}${fontSize}px ${clip.fontFamily || 'Noto Sans KR, sans-serif'}`;
    ctx.textAlign    = clip.align || 'center';
    ctx.textBaseline = 'top';

    const totalH = lines.length * lineH;
    const maxW   = Math.max(...lines.map(l => ctx.measureText(l).width), 1);

    if (clip.backgroundColor && clip.backgroundColor !== 'none') {
      ctx.fillStyle = clip.backgroundColor;
      roundRect(ctx, cx - maxW / 2 - padding, cy - padding,
        maxW + padding * 2, totalH + padding * 2, (clip.borderRadius || 8) * z);
      ctx.fill();
    }
    if (clip.shadow && clip.shadow !== 'none') {
      const p = clip.shadow.split(' ');
      if (p.length >= 4) {
        ctx.shadowOffsetX = parseFloat(p[0]) * z;
        ctx.shadowOffsetY = parseFloat(p[1]) * z;
        ctx.shadowBlur    = parseFloat(p[2]) * z;
        ctx.shadowColor   = p.slice(3).join(' ');
      }
    }
    ctx.fillStyle = clip.color || '#ffffff';
    lines.forEach((l, i) => ctx.fillText(l, cx, cy + i * lineH));
    ctx.restore();

    return subtitleBounds(clip);
  }

  // ── Selection handles ──────────────────────────────────────────────────────
  function handlePts(px, py, pw, ph) {
    return [
      { n: 'tl', cx: px,        cy: py        },
      { n: 'tc', cx: px + pw/2, cy: py        },
      { n: 'tr', cx: px + pw,   cy: py        },
      { n: 'ml', cx: px,        cy: py + ph/2 },
      { n: 'mr', cx: px + pw,   cy: py + ph/2 },
      { n: 'bl', cx: px,        cy: py + ph   },
      { n: 'bc', cx: px + pw/2, cy: py + ph   },
      { n: 'br', cx: px + pw,   cy: py + ph   },
    ];
  }

  function drawHandles(bounds, z) {
    const px = (bounds.x + WS_MARGIN) * z + _panX;
    const py = (bounds.y + WS_MARGIN) * z + _panY;
    const pw = bounds.w * z, ph = bounds.h * z;
    const hs = HANDLE_PX;

    ctx.save();
    ctx.strokeStyle = 'rgba(108,92,231,0.95)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(px, py, pw, ph);
    ctx.setLineDash([]);

    handlePts(px, py, pw, ph).forEach(h => {
      ctx.fillStyle   = '#fff';
      ctx.strokeStyle = '#6c5ce7';
      ctx.lineWidth   = 1.5;
      ctx.fillRect(h.cx - hs, h.cy - hs, hs * 2, hs * 2);
      ctx.strokeRect(h.cx - hs, h.cy - hs, hs * 2, hs * 2);
    });
    ctx.restore();
  }

  // ── Mouse interaction ──────────────────────────────────────────────────────
  const CURSORS = {
    tl: 'nw-resize', tc: 'n-resize', tr: 'ne-resize',
    ml: 'w-resize',                  mr: 'e-resize',
    bl: 'sw-resize', bc: 's-resize', br: 'se-resize',
  };

  function setupMouseEvents() {
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onCanvasHover);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);

    // Ctrl+scroll → zoom, keeping the output frame centered
    canvas.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.05 : -0.05;
      setZoom(Math.max(0.05, Math.min(4, _zoom + delta)));
    }, { passive: false });
  }

  function canvasXY(e) {
    const r = canvas.getBoundingClientRect();
    return { cx: e.clientX - r.left, cy: e.clientY - r.top };
  }

  function toOutput(cx, cy) {
    return { x: (cx - _panX) / _zoom - WS_MARGIN, y: (cy - _panY) / _zoom - WS_MARGIN };
  }

  function getHandle(cpx, cpy, bounds) {
    const px = (bounds.x + WS_MARGIN) * _zoom + _panX;
    const py = (bounds.y + WS_MARGIN) * _zoom + _panY;
    const pw = bounds.w * _zoom, ph = bounds.h * _zoom;
    const hs = HANDLE_PX + 3;
    for (const h of handlePts(px, py, pw, ph)) {
      if (Math.abs(cpx - h.cx) <= hs && Math.abs(cpy - h.cy) <= hs) return h.n;
    }
    return null;
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;

    const { cx, cy } = canvasXY(e);
    const { x: ox, y: oy } = toOutput(cx, cy);

    const selId  = EditorState.getSelectedClip();
    const selLId = EditorState.getSelectedLayer();

    if (selId) {
      const bounds = _visibleBounds.find(b => b.clipId === selId);
      if (bounds) {
        const handle = getHandle(cx, cy, bounds);
        if (handle) {
          EditorState.saveSnapshot();
          const clip = EditorState.getClip(selLId, selId);
          previewDrag = {
            type: handle, layerId: selLId, clipId: selId,
            startOX: ox, startOY: oy,
            origBounds: { ...bounds },
            origClip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, fontSize: clip.fontSize }
          };
          e.preventDefault(); return;
        }
      }
    }

    for (let i = _visibleBounds.length - 1; i >= 0; i--) {
      const b = _visibleBounds[i];
      if (ox >= b.x && ox <= b.x + b.w && oy >= b.y && oy <= b.y + b.h) {
        EditorState.selectClip(b.layerId, b.clipId);
        EditorState.saveSnapshot();
        const clip = EditorState.getClip(b.layerId, b.clipId);
        previewDrag = {
          type: 'move', layerId: b.layerId, clipId: b.clipId,
          startOX: ox, startOY: oy,
          origBounds: { ...b },
          origClip: { x: clip.x || 0, y: clip.y || 0, width: clip.width, height: clip.height, fontSize: clip.fontSize }
        };
        e.preventDefault(); return;
      }
    }
    EditorState.selectClip(null, null);
  }

  function onMouseMove(e) {
    if (!previewDrag) return;
    const { cx, cy } = canvasXY(e);
    const { x: ox, y: oy } = toOutput(cx, cy);
    const dx = ox - previewDrag.startOX, dy = oy - previewDrag.startOY;
    const ob = previewDrag.origBounds, oc = previewDrag.origClip;
    const clip = EditorState.getClip(previewDrag.layerId, previewDrag.clipId);
    if (!clip) return;

    const t = previewDrag.type;
    const MIN = 20;

    if (t === 'move') {
      let edx = dx, edy = dy;
      if (e.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) edy = 0;
        else edx = 0;
      }
      if (clip.type === 'subtitle') {
        EditorState.updateClip(previewDrag.layerId, previewDrag.clipId, {
          x: Math.round((oc.x || OUTPUT_W / 2) + edx),
          y: Math.round((oc.y || 200) + edy)
        });
      } else {
        EditorState.updateClip(previewDrag.layerId, previewDrag.clipId, {
          x: Math.round((oc.x || 0) + edx), y: Math.round((oc.y || 0) + edy)
        });
      }
    } else {
      let nx = ob.x, ny = ob.y, nw = ob.w, nh = ob.h;
      if (t.includes('l')) { nx = ob.x + dx; nw = ob.w - dx; }
      if (t.includes('r')) { nw = ob.w + dx; }
      if (t.includes('t')) { ny = ob.y + dy; nh = ob.h - dy; }
      if (t.includes('b')) { nh = ob.h + dy; }
      nw = Math.max(MIN, nw); nh = Math.max(MIN, nh);

      if (clip.type === 'video') {
        EditorState.updateClip(previewDrag.layerId, previewDrag.clipId, {
          x: Math.round(nx), y: Math.round(ny), width: Math.round(nw), height: Math.round(nh)
        });
      } else if (clip.type === 'subtitle') {
        const scale = Math.max(0.1, nw / ob.w);
        EditorState.updateClip(previewDrag.layerId, previewDrag.clipId, {
          x: Math.round(nx + nw / 2), y: Math.round(ny),
          fontSize: Math.max(8, Math.round((oc.fontSize || 48) * scale))
        });
      }
    }
    renderFrame();
  }

  function onMouseUp() { previewDrag = null; }

  function onCanvasHover(e) {
    if (previewDrag) { canvas.style.cursor = 'grabbing'; return; }

    const { cx, cy } = canvasXY(e);
    const { x: ox, y: oy } = toOutput(cx, cy);

    const selId = EditorState.getSelectedClip();
    if (selId) {
      const bounds = _visibleBounds.find(b => b.clipId === selId);
      if (bounds) {
        const h = getHandle(cx, cy, bounds);
        if (h) { canvas.style.cursor = CURSORS[h] || 'pointer'; return; }
      }
    }
    for (let i = _visibleBounds.length - 1; i >= 0; i--) {
      const b = _visibleBounds[i];
      if (ox >= b.x && ox <= b.x + b.w && oy >= b.y && oy <= b.y + b.h) {
        canvas.style.cursor = 'move'; return;
      }
    }
    canvas.style.cursor = 'default';
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2); if (r < 0) r = 0;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  function updateTimecode(t) {
    const m  = Math.floor(t / 60).toString().padStart(2, '0');
    const s  = Math.floor(t % 60).toString().padStart(2, '0');
    const ms = Math.floor((t % 1) * 1000).toString().padStart(3, '0');
    document.getElementById('timecode').textContent = `${m}:${s}.${ms}`;
  }

  return { init, renderFrame, setZoom };
})();
