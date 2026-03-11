/**
 * Editor Main Controller
 */
(async () => {
  // Get project ID from URL
  const projectId = window.location.pathname.split('/').pop();

  // Initialize modules
  Player.init();
  Timeline.init();
  Layers.init();
  Properties.init();

  // Load project
  try {
    const project = await fetch(`/api/projects/${projectId}`).then(r => r.json());
    document.getElementById('project-title').textContent = project.name;
    document.title = `${project.name} - ShortCut Studio`;
    EditorState.setProject(project);
    Timeline.resize();
    Timeline.render();
    Timeline.renderLabels();
    Timeline.renderRuler();
  } catch (err) {
    alert('프로젝트를 불러오는데 실패했습니다: ' + err.message);
  }

  // ── Playback Controls ──────────────────────────────────────────────────────────
  document.getElementById('btn-play-pause').addEventListener('click', () => {
    const playing = !EditorState.isPlaying();
    EditorState.setPlaying(playing);
    document.getElementById('btn-play-pause').textContent = playing ? '⏸' : '▶';
  });

  document.getElementById('btn-to-start').addEventListener('click', () => {
    EditorState.setPlaying(false);
    document.getElementById('btn-play-pause').textContent = '▶';
    EditorState.setCurrentTime(0);
  });

  document.getElementById('btn-to-end').addEventListener('click', () => {
    EditorState.setPlaying(false);
    document.getElementById('btn-play-pause').textContent = '▶';
    EditorState.setCurrentTime(EditorState.getTotalDuration());
  });

  document.getElementById('btn-step-back').addEventListener('click', () => {
    EditorState.setCurrentTime(Math.max(0, EditorState.getCurrentTime() - 1/30));
  });

  document.getElementById('btn-step-fwd').addEventListener('click', () => {
    EditorState.setCurrentTime(EditorState.getCurrentTime() + 1/30);
  });

  EditorState.on('playStateChanged', playing => {
    document.getElementById('btn-play-pause').textContent = playing ? '⏸' : '▶';
  });

  // ── Cut at playhead ────────────────────────────────────────────────────────────
  function cutAtPlayhead() {
    const t = EditorState.getCurrentTime();
    const project = EditorState.getProject();
    if (!project) return;

    const selClipId  = EditorState.getSelectedClip();
    const selLayerId = EditorState.getSelectedLayer();

    // Collect clips to split (selected clip only, or all visible clips at this time)
    const toSplit = [];
    if (selClipId && selLayerId) {
      const clip = EditorState.getClip(selLayerId, selClipId);
      if (clip && t > clip.startTime && t < clip.endTime) {
        toSplit.push({ layerId: selLayerId, clipId: selClipId });
      }
    } else {
      project.layers.forEach(layer => {
        if (layer.visible === false) return;
        layer.clips.forEach(clip => {
          if (t > clip.startTime && t < clip.endTime) {
            toSplit.push({ layerId: layer.id, clipId: clip.id });
          }
        });
      });
    }

    if (toSplit.length === 0) return;
    EditorState.saveSnapshot();
    toSplit.forEach(({ layerId, clipId }) => {
      EditorState.emit('splitClip', { layerId, clipId, t });
    });
    showToast('클립 분할됨');
  }

  document.getElementById('btn-cut').addEventListener('click', cutAtPlayhead);

  // ── Tool Selection ─────────────────────────────────────────────────────────────
  document.getElementById('active-tool').addEventListener('change', e => {
    EditorState.setActiveTool(e.target.value);
  });

  // ── Undo / Redo buttons ────────────────────────────────────────────────────
  function updateUndoRedoBtns() {
    document.getElementById('btn-undo').disabled = !EditorState.canUndo();
    document.getElementById('btn-redo').disabled = !EditorState.canRedo();
  }
  document.getElementById('btn-undo').addEventListener('click', () => {
    EditorState.undo(); showToast('실행 취소'); updateUndoRedoBtns();
  });
  document.getElementById('btn-redo').addEventListener('click', () => {
    EditorState.redo(); showToast('다시 실행'); updateUndoRedoBtns();
  });
  EditorState.on('clipsChanged',  updateUndoRedoBtns);
  EditorState.on('layersChanged', updateUndoRedoBtns);

  // ── Keyboard Shortcuts ────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    // Undo / Redo work even when an input is focused
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) { EditorState.redo(); showToast('다시 실행'); }
      else             { EditorState.undo(); showToast('실행 취소'); }
      updateUndoRedoBtns();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      EditorState.redo(); showToast('다시 실행');
      updateUndoRedoBtns();
      return;
    }

    // Don't trigger other shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        const playing = !EditorState.isPlaying();
        EditorState.setPlaying(playing);
        break;
      case 'ArrowLeft':
        EditorState.setCurrentTime(Math.max(0, EditorState.getCurrentTime() - (e.shiftKey ? 1 : 1/30)));
        break;
      case 'ArrowRight':
        EditorState.setCurrentTime(EditorState.getCurrentTime() + (e.shiftKey ? 1 : 1/30));
        break;
      case 'Delete':
      case 'Backspace': {
        const clipId = EditorState.getSelectedClip();
        const layerId = EditorState.getSelectedLayer();
        if (clipId && layerId) {
          if (confirm('선택된 클립을 삭제할까요?')) {
            EditorState.saveSnapshot();
            EditorState.removeClip(layerId, clipId);
            Timeline.render();
            Player.renderFrame();
          }
        }
        break;
      }
      case 'c':
        cutAtPlayhead();
        break;
      case 'v':
        EditorState.setActiveTool('select');
        document.getElementById('active-tool').value = 'select';
        break;
    }
  });

  // ── Panel Resize ──────────────────────────────────────────────────────────────
  (() => {
    const divider   = document.getElementById('panel-divider');
    const leftPanel = document.getElementById('editor-left');
    let panelDrag   = null;

    divider.addEventListener('mousedown', e => {
      e.preventDefault();
      panelDrag = { startX: e.clientX, startW: leftPanel.offsetWidth };
      divider.classList.add('dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', e => {
      if (!panelDrag) return;
      const w = Math.max(220, Math.min(900, panelDrag.startW + (e.clientX - panelDrag.startX)));
      leftPanel.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!panelDrag) return;
      panelDrag = null;
      divider.classList.remove('dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      Timeline.resize();
      Timeline.renderRuler();
    });
  })();

  // ── Save ──────────────────────────────────────────────────────────────────────
  let saveTimeout = null;
  function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveProject, 2000);
  }

  async function saveProject() {
    const project = EditorState.getProject();
    if (!project) return;
    try {
      await fetch(`/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layers: project.layers, name: project.name })
      });
      showToast('저장됨');
    } catch (err) {
      console.error('Save error:', err);
    }
  }

  document.getElementById('btn-save').addEventListener('click', saveProject);

  // Auto-save on changes
  EditorState.on('clipsChanged', scheduleSave);
  EditorState.on('layersChanged', scheduleSave);

  // ── Export ────────────────────────────────────────────────────────────────────

  // Mode hint text shown below the radio buttons
  const modeHints = {
    server: '서버에서 FFmpeg로 렌더링합니다. NAS 서버 사양에 따라 시간이 걸릴 수 있습니다.',
    client: '브라우저에서 FFmpeg.wasm으로 렌더링합니다. 첫 실행 시 WASM 다운로드가 필요합니다.',
  };
  document.querySelectorAll('input[name="export-mode"]').forEach(radio => {
    radio.addEventListener('change', e => {
      document.getElementById('export-mode-hint').textContent = modeHints[e.target.value] || '';
    });
  });

  function getExportMode() {
    const radio = document.querySelector('input[name="export-mode"]:checked');
    return radio ? radio.value : 'server';
  }

  document.getElementById('btn-export').addEventListener('click', () => {
    document.getElementById('modal-export').style.display = 'flex';
    document.getElementById('export-status-text').textContent = '';
    document.getElementById('export-download-area').style.display = 'none';
    document.getElementById('export-status-area').style.display = 'block';
    document.getElementById('export-progress-bar').style.display = 'none';
    document.getElementById('export-progress-fill').style.width = '0%';
    document.getElementById('export-progress-fill').style.background = '';
    document.getElementById('btn-start-export').disabled = false;
  });

  ['export-modal-close', 'export-modal-close2'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => {
      document.getElementById('modal-export').style.display = 'none';
    });
  });

  document.getElementById('btn-start-export').addEventListener('click', async () => {
    const project = EditorState.getProject();
    if (!project) return;

    await saveProject();

    document.getElementById('btn-start-export').disabled = true;
    document.getElementById('export-progress-bar').style.display = 'block';
    document.getElementById('export-progress-fill').style.width = '0%';
    document.getElementById('export-status-text').textContent = '렌더링 시작 중...';

    if (getExportMode() === 'client') {
      startClientExport(project);
    } else {
      try {
        document.getElementById('export-status-text').textContent = '자막 렌더링 중...';
        const subtitlePngs = renderSubtitlePngsForExport(project);
        await fetch(`/api/export/${project.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subtitlePngs }),
        });
        pollExportStatus(project.id);
      } catch (err) {
        document.getElementById('export-status-text').textContent = '오류: ' + err.message;
        document.getElementById('btn-start-export').disabled = false;
      }
    }
  });

  // Render all subtitle clips to PNG using the browser's canvas (same rendering as the editor preview).
  // Returns [{clipId, png: base64String}] for each visible subtitle clip with text.
  function renderSubtitlePngsForExport(project) {
    const OUTPUT_W = 1080, OUTPUT_H = 1920;
    const allSubtitleClips = (project.layers || [])
      .filter(l => l.visible !== false)
      .flatMap(l => l.clips.filter(c => c.type === 'subtitle' && c.text));

    if (!allSubtitleClips.length) return [];

    const offscreen = document.createElement('canvas');
    offscreen.width  = OUTPUT_W;
    offscreen.height = OUTPUT_H;
    const ctx = offscreen.getContext('2d');

    return allSubtitleClips.map(clip => {
      ctx.clearRect(0, 0, OUTPUT_W, OUTPUT_H);

      const fontSize = clip.fontSize || 48;
      const cx       = clip.x != null ? clip.x : OUTPUT_W / 2;
      const cy       = clip.y != null ? clip.y : 200;
      const padding  = clip.backgroundPadding || 16;
      const lineH    = fontSize * 1.3;
      const lines    = (clip.text || '').split('\n');

      ctx.font         = `${clip.bold ? 'bold ' : ''}${fontSize}px ${clip.fontFamily || 'Noto Sans KR, sans-serif'}`;
      ctx.textAlign    = clip.align || 'center';
      ctx.textBaseline = 'top';

      const totalH = lines.length * lineH;
      const maxW   = Math.max(...lines.map(l => ctx.measureText(l).width), 1);

      if (clip.backgroundColor && clip.backgroundColor !== 'none') {
        ctx.fillStyle = clip.backgroundColor;
        const r = clip.borderRadius || 8;
        const bx = cx - maxW / 2 - padding, by = cy - padding;
        const bw = maxW + padding * 2,       bh = totalH + padding * 2;
        ctx.beginPath();
        ctx.moveTo(bx + r, by); ctx.lineTo(bx + bw - r, by);
        ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
        ctx.lineTo(bx + bw, by + bh - r);
        ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
        ctx.lineTo(bx + r, by + bh);
        ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
        ctx.lineTo(bx, by + r); ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath(); ctx.fill();
      }

      // Always reset shadow state to avoid bleed-through from previous clips
      ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.shadowBlur    = 0; ctx.shadowColor   = 'transparent';
      if (clip.shadow && clip.shadow !== 'none') {
        const p = clip.shadow.split(' ');
        if (p.length >= 4) {
          ctx.shadowOffsetX = parseFloat(p[0]); ctx.shadowOffsetY = parseFloat(p[1]);
          ctx.shadowBlur    = parseFloat(p[2]); ctx.shadowColor   = p.slice(3).join(' ');
        }
      }

      ctx.fillStyle = clip.color || '#ffffff';
      lines.forEach((l, i) => ctx.fillText(l, cx, cy + i * lineH));

      // Strip the data URL prefix to get raw base64
      const png = offscreen.toDataURL('image/png').split(',')[1];
      return { clipId: clip.id, png };
    });
  }

  async function startClientExport(project) {
    const fill     = document.getElementById('export-progress-fill');
    const statusTx = document.getElementById('export-status-text');

    try {
      const blobUrl = await ClientExport.exportVideo(project, {
        onProgress: (pct, msg) => {
          fill.style.width = pct + '%';
          statusTx.textContent = msg ? `${msg} (${pct}%)` : `렌더링 중... ${pct}%`;
        },
        onLog: msg => console.log('[FFmpeg.wasm]', msg),
      });

      fill.style.width = '100%';
      setTimeout(() => {
        document.getElementById('export-progress-bar').style.display = 'none';
        document.getElementById('export-status-area').style.display = 'none';
        document.getElementById('export-download-area').style.display = 'block';
        const link = document.getElementById('export-download-link');
        link.href = blobUrl;
        link.download = `${project.name || 'export'}.mp4`;
        link.textContent = '영상 다운로드';
      }, 400);
    } catch (err) {
      console.error('Client export error:', err);
      statusTx.textContent = '오류: ' + err.message;
      fill.style.background = 'var(--danger, #e05)';
      document.getElementById('btn-start-export').disabled = false;
    }
  }

  function pollExportStatus(projectId) {
    const fill     = document.getElementById('export-progress-fill');
    const statusTx = document.getElementById('export-status-text');

    const interval = setInterval(async () => {
      try {
        const status = await fetch(`/api/export/${projectId}/status`).then(r => r.json());
        if (status.status === 'done') {
          clearInterval(interval);
          fill.style.width = '100%';
          setTimeout(() => {
            document.getElementById('export-progress-bar').style.display = 'none';
            document.getElementById('export-status-area').style.display = 'none';
            document.getElementById('export-download-area').style.display = 'block';
            const link = document.getElementById('export-download-link');
            link.href = status.file;
            link.textContent = '영상 다운로드';
          }, 400);
        } else if (status.status === 'error') {
          clearInterval(interval);
          statusTx.textContent = '오류: ' + status.error;
          fill.style.background = 'var(--danger, #e05)';
          document.getElementById('btn-start-export').disabled = false;
        } else {
          const pct = status.progress || 0;
          fill.style.width = pct + '%';
          statusTx.textContent = status.message
            ? `${status.message} (${pct}%)`
            : `렌더링 중... ${pct}%`;
        }
      } catch (err) {
        clearInterval(interval);
      }
    }, 1500);
  }

  // ── Audio Modal ───────────────────────────────────────────────────────────────
  document.getElementById('audio-modal-close').addEventListener('click', () => {
    document.getElementById('modal-audio').style.display = 'none';
  });
  document.getElementById('audio-cancel').addEventListener('click', () => {
    document.getElementById('modal-audio').style.display = 'none';
  });

  document.getElementById('audio-volume').addEventListener('input', e => {
    document.getElementById('audio-volume-label').textContent = e.target.value + '%';
  });

  document.getElementById('audio-confirm').addEventListener('click', async () => {
    const file = document.getElementById('audio-file-input').files[0];
    if (!file) { alert('오디오 파일을 선택하세요.'); return; }

    const startTime = parseFloat(document.getElementById('audio-start-time').value) || 0;
    const volume = parseInt(document.getElementById('audio-volume').value) || 80;
    const project = EditorState.getProject();

    const formData = new FormData();
    formData.append('audio', file);

    try {
      const result = await fetch(`/api/projects/${project.id}/audio`, {
        method: 'POST',
        body: formData
      }).then(r => r.json());

      // Get actual audio duration from the browser so endTime is accurate
      const audioDuration = await new Promise(resolve => {
        const tmp = new Audio();
        tmp.addEventListener('loadedmetadata', () => resolve(isFinite(tmp.duration) ? tmp.duration : 60));
        tmp.addEventListener('error', () => resolve(60));
        tmp.src = result.path;
      });

      Layers.addAudioLayer(result.path, result.originalname, startTime, volume, audioDuration);
      document.getElementById('modal-audio').style.display = 'none';
      Timeline.render();
    } catch (err) {
      alert('오디오 업로드 실패: ' + err.message);
    }
  });

  // ── Context Menu ──────────────────────────────────────────────────────────────
  document.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      const menu = document.getElementById('context-menu');
      menu.style.display = 'none';

      if (!rightClickInfo) return;
      const { layerId, clipId, x } = rightClickInfo;
      const clip = EditorState.getClip(layerId, clipId);
      if (!clip) return;

      if (action === 'delete') {
        EditorState.saveSnapshot();
        EditorState.removeClip(layerId, clipId);
        Timeline.render();
        Player.renderFrame();
      } else if (action === 'split' || action === 'cut') {
        EditorState.saveSnapshot();
        Timeline.splitClipAt(layerId, clipId, EditorState.getCurrentTime());
      } else if (action === 'duplicate') {
        EditorState.saveSnapshot();
        const newClip = {
          ...clip,
          id: EditorState.genId(),
          startTime: clip.endTime,
          endTime: clip.endTime + (clip.endTime - clip.startTime)
        };
        EditorState.addClip(layerId, newClip);
        Timeline.render();
      }

      rightClickInfo = null;
    });
  });

  document.addEventListener('click', () => {
    document.getElementById('context-menu').style.display = 'none';
  });

  // ── Toast ──────────────────────────────────────────────────────────────────────
  function showToast(msg) {
    let toast = document.getElementById('editor-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'editor-toast';
      toast.style.cssText = `
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:var(--bg-card); border:1px solid var(--border); border-radius:8px;
        padding:8px 20px; font-size:13px; z-index:9999;
        transition: opacity 0.3s; pointer-events:none;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 1500);
  }

  // Global reference for context menu in timeline
  window.rightClickInfo = null;

  // Expose splitClipAt to context menu
  Timeline.splitClipAt = (layerId, clipId, t) => {
    // This calls the internal split function
    EditorState.emit('splitClip', { layerId, clipId, t });
  };
  EditorState.on('splitClip', ({ layerId, clipId, t }) => {
    const clip = EditorState.getClip(layerId, clipId);
    if (!clip || t <= clip.startTime || t >= clip.endTime) return;
    const ratio = (t - clip.startTime) / (clip.endTime - clip.startTime);
    const splitSrc = (clip.srcStart || 0) + ((clip.srcEnd || 0) - (clip.srcStart || 0)) * ratio;
    const newClip = { ...clip, id: EditorState.genId(), startTime: t, endTime: clip.endTime, srcStart: splitSrc, srcEnd: clip.srcEnd };
    EditorState.updateClip(layerId, clipId, { endTime: t, srcEnd: splitSrc });
    EditorState.addClip(layerId, newClip);
    Timeline.render();
  });

})();
