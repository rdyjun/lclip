/**
 * Properties Panel - shows and edits selected clip properties
 */
const Properties = (() => {

  function init() {
    EditorState.on('selectionChanged', onSelectionChanged);
    EditorState.on('projectLoaded', () => renderDefault());

    // Save snapshot once per clip selection before any property edit begins
    let _snapped = false;
    EditorState.on('selectionChanged', () => { _snapped = false; });

    const body = document.getElementById('properties-body');
    const onPropEdit = () => {
      if (!_snapped) { EditorState.saveSnapshot(); _snapped = true; }
    };
    body.addEventListener('mousedown', onPropEdit);
    body.addEventListener('focusin',   onPropEdit);
  }

  function onSelectionChanged({ layerId, clipId }) {
    if (!clipId || !layerId) {
      renderDefault();
      return;
    }
    const clip = EditorState.getClip(layerId, clipId);
    const layer = EditorState.getLayer(layerId);
    if (!clip) { renderDefault(); return; }

    document.getElementById('properties-title').textContent = layer.name;

    if (clip.type === 'video') renderVideoProps(layerId, clipId, clip);
    else if (clip.type === 'subtitle') renderSubtitleProps(layerId, clipId, clip);
    else if (clip.type === 'audio') renderAudioProps(layerId, clipId, clip);
    else renderDefault();
  }

  function renderDefault() {
    document.getElementById('properties-title').textContent = '속성';
    document.getElementById('properties-body').innerHTML =
      '<p class="prop-hint">클립을 선택하면 속성이 표시됩니다.</p>';
  }

  // ── Video Properties ──────────────────────────────────────────────────────────
  function renderVideoProps(layerId, clipId, clip) {
    const body = document.getElementById('properties-body');
    body.innerHTML = '';

    // ── Filtered clip info ──────────────────────────────────────────────────
    if (clip.isFiltered) {
      const filterSection = makeSection('ROFL 필터 클립');

      // Event type badges
      if (clip.eventTypes && clip.eventTypes.length) {
        const badges = clip.eventTypes.map(t => {
          const span = document.createElement('span');
          span.className = 'filter-event-badge';
          span.dataset.type = t;
          span.textContent = t === 'kill' ? '⚔ Kill' : t === 'death' ? '💀 Death' : '🤝 Assist';
          return span;
        });
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px';
        badges.forEach(b => row.appendChild(b));
        filterSection.appendChild(row);
      }

      const note = document.createElement('p');
      note.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px';
      note.textContent = 'ROFL로 생성된 필터 클립입니다.';
      filterSection.appendChild(note);

      filterSection.appendChild(makeRow('필터 시작(s)', makeNumberInput((clip.filterStart || clip.srcStart || 0).toFixed(2), v => {
        const val = Math.max(0, parseFloat(v));
        EditorState.updateClip(layerId, clipId, { filterStart: val, srcStart: val });
        Player.renderFrame();
      })));
      filterSection.appendChild(makeRow('필터 끝(s)', makeNumberInput((clip.filterEnd || clip.srcEnd || 0).toFixed(2), v => {
        const val = Math.max(0, parseFloat(v));
        EditorState.updateClip(layerId, clipId, { filterEnd: val, srcEnd: val });
        Player.renderFrame();
      })));
      body.appendChild(filterSection);
    }

    const section = makeSection('클립 설정');
    section.appendChild(makeRow('시작', makeNumberInput(clip.startTime.toFixed(2), v => {
      EditorState.updateClip(layerId, clipId, { startTime: parseFloat(v) });
      Timeline.render();
    })));
    section.appendChild(makeRow('끝', makeNumberInput(clip.endTime.toFixed(2), v => {
      EditorState.updateClip(layerId, clipId, { endTime: parseFloat(v) });
      Timeline.render();
    })));
    section.appendChild(makeRow('불투명도', makeRangeInput(clip.opacity * 100, 0, 100, v => {
      EditorState.updateClip(layerId, clipId, { opacity: parseFloat(v) / 100 });
      Player.renderFrame();
    })));
    section.appendChild(makeRow('볼륨', makeRangeInput((clip.volume !== undefined ? clip.volume : 1) * 100, 0, 100, v => {
      EditorState.updateClip(layerId, clipId, { volume: parseFloat(v) / 100 });
      const videoEl = document.getElementById('preview-video');
      if (videoEl) videoEl.volume = parseFloat(v) / 100;
    })));
    body.appendChild(section);

    // ── Speed ──────────────────────────────────────────────────────────────
    const speedSection = makeSection('재생 속도');
    const currentPct = Math.round((clip.speed || 1) * 100);

    const speedWrap = document.createElement('div');
    speedWrap.style.cssText = 'display:flex;align-items:center;gap:6px';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'prop-input';
    slider.min = 10; slider.max = 400; slider.step = 5;
    slider.value = currentPct;

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.className = 'prop-input';
    numInput.min = 10; numInput.max = 400; numInput.step = 5;
    numInput.value = currentPct;
    numInput.style.cssText = 'width:60px;flex-shrink:0';

    const pctLabel = document.createElement('span');
    pctLabel.style.cssText = 'font-size:11px;color:var(--text-secondary)';
    pctLabel.textContent = '%';

    function applySpeed(pct) {
      const s = Math.max(0.1, Math.min(4, pct / 100));
      const srcDur = (clip.srcEnd || 0) - (clip.srcStart || 0);
      const newEndTime = clip.startTime + srcDur / s;
      EditorState.updateClip(layerId, clipId, { speed: s, endTime: newEndTime });
      Timeline.render();
      Player.renderFrame();
    }

    slider.addEventListener('input', () => {
      numInput.value = slider.value;
      applySpeed(parseFloat(slider.value));
    });
    numInput.addEventListener('change', () => {
      slider.value = numInput.value;
      applySpeed(parseFloat(numInput.value));
    });

    speedWrap.appendChild(slider);
    speedWrap.appendChild(numInput);
    speedWrap.appendChild(pctLabel);
    speedSection.appendChild(speedWrap);
    body.appendChild(speedSection);

    const posSection = makeSection('위치/크기');
    posSection.appendChild(makeRow('X', makeNumberInput(clip.x || 0, v => {
      EditorState.updateClip(layerId, clipId, { x: parseFloat(v) }); Player.renderFrame();
    })));
    posSection.appendChild(makeRow('Y', makeNumberInput(clip.y || 0, v => {
      EditorState.updateClip(layerId, clipId, { y: parseFloat(v) }); Player.renderFrame();
    })));
    posSection.appendChild(makeRow('폭', makeNumberInput(clip.width || 1080, v => {
      EditorState.updateClip(layerId, clipId, { width: parseInt(v) }); Player.renderFrame();
    })));
    posSection.appendChild(makeRow('높이', makeNumberInput(clip.height || 1920, v => {
      EditorState.updateClip(layerId, clipId, { height: parseInt(v) }); Player.renderFrame();
    })));
    body.appendChild(posSection);
  }

  const SUBTITLE_FONTS = [
    { label: 'Noto Sans KR (기본)',  value: 'Noto Sans KR, sans-serif' },
    { label: 'Nanum Gothic',         value: 'Nanum Gothic, sans-serif' },
    { label: 'Nanum Myeongjo',       value: 'Nanum Myeongjo, serif' },
    { label: 'Gowun Dodum',          value: 'Gowun Dodum, sans-serif' },
    { label: 'Gowun Batang',         value: 'Gowun Batang, serif' },
    { label: 'Black Han Sans',       value: 'Black Han Sans, sans-serif' },
    { label: 'Do Hyeon',             value: 'Do Hyeon, sans-serif' },
    { label: 'IBM Plex Sans KR',     value: 'IBM Plex Sans KR, sans-serif' },
    { label: 'Jua',                  value: 'Jua, sans-serif' },
  ];

  // ── Subtitle Properties ───────────────────────────────────────────────────────
  function renderSubtitleProps(layerId, clipId, clip) {
    const body = document.getElementById('properties-body');
    body.innerHTML = '';

    // Text
    const textSection = makeSection('텍스트');
    const textarea = document.createElement('textarea');
    textarea.className = 'prop-textarea';
    textarea.value = clip.text || '';
    textarea.addEventListener('input', () => {
      EditorState.updateClip(layerId, clipId, { text: textarea.value });
      Player.renderFrame();
      Timeline.render();
    });
    textSection.appendChild(textarea);
    body.appendChild(textSection);

    // Timing
    const timeSection = makeSection('타이밍');
    timeSection.appendChild(makeRow('시작(s)', makeNumberInput(clip.startTime.toFixed(2), v => {
      EditorState.updateClip(layerId, clipId, { startTime: parseFloat(v) });
      Timeline.render();
    })));
    timeSection.appendChild(makeRow('끝(s)', makeNumberInput(clip.endTime.toFixed(2), v => {
      EditorState.updateClip(layerId, clipId, { endTime: parseFloat(v) });
      Timeline.render();
    })));
    body.appendChild(timeSection);

    // Position
    const posSection = makeSection('위치');
    posSection.appendChild(makeRow('X', makeNumberInput(clip.x || 540, v => {
      EditorState.updateClip(layerId, clipId, { x: parseInt(v) }); Player.renderFrame();
    })));
    posSection.appendChild(makeRow('Y', makeNumberInput(clip.y || 200, v => {
      EditorState.updateClip(layerId, clipId, { y: parseInt(v) }); Player.renderFrame();
    })));
    body.appendChild(posSection);

    // Font
    const fontSection = makeSection('폰트');

    const fontSelect = document.createElement('select');
    fontSelect.className = 'prop-input';
    const currentFont = clip.fontFamily || 'Noto Sans KR, sans-serif';
    SUBTITLE_FONTS.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.value;
      opt.textContent = f.label;
      opt.style.fontFamily = f.value;
      if (currentFont === f.value) opt.selected = true;
      fontSelect.appendChild(opt);
    });
    fontSelect.style.fontFamily = currentFont;
    fontSelect.addEventListener('change', () => {
      fontSelect.style.fontFamily = fontSelect.value;
      EditorState.updateClip(layerId, clipId, { fontFamily: fontSelect.value });
      Player.renderFrame();
    });
    fontSection.appendChild(makeRow('폰트', fontSelect));

    fontSection.appendChild(makeRow('크기', makeNumberInput(clip.fontSize || 48, v => {
      EditorState.updateClip(layerId, clipId, { fontSize: parseInt(v) }); Player.renderFrame();
    })));
    fontSection.appendChild(makeRow('색상', makeColorInput(clip.color || '#ffffff', v => {
      EditorState.updateClip(layerId, clipId, { color: v }); Player.renderFrame();
    })));

    const boldRow = makeRow('굵게', makeCheckbox(clip.bold, v => {
      EditorState.updateClip(layerId, clipId, { bold: v }); Player.renderFrame();
    }));
    fontSection.appendChild(boldRow);

    const alignSelect = document.createElement('select');
    alignSelect.className = 'prop-input';
    ['left', 'center', 'right'].forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a === 'left' ? '왼쪽' : a === 'center' ? '가운데' : '오른쪽';
      if (clip.align === a) opt.selected = true;
      alignSelect.appendChild(opt);
    });
    alignSelect.addEventListener('change', () => {
      EditorState.updateClip(layerId, clipId, { align: alignSelect.value });
      Player.renderFrame();
    });
    fontSection.appendChild(makeRow('정렬', alignSelect));
    body.appendChild(fontSection);

    // Background
    const bgSection = makeSection('배경');
    bgSection.appendChild(makeRow('배경색', makeColorInputAlpha(clip.backgroundColor || 'rgba(0,0,0,0.6)', v => {
      EditorState.updateClip(layerId, clipId, { backgroundColor: v }); Player.renderFrame();
    })));
    bgSection.appendChild(makeRow('패딩', makeNumberInput(clip.backgroundPadding || 16, v => {
      EditorState.updateClip(layerId, clipId, { backgroundPadding: parseInt(v) }); Player.renderFrame();
    })));
    bgSection.appendChild(makeRow('모서리', makeNumberInput(clip.borderRadius || 8, v => {
      EditorState.updateClip(layerId, clipId, { borderRadius: parseInt(v) }); Player.renderFrame();
    })));
    body.appendChild(bgSection);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.style.width = '100%';
    delBtn.style.marginTop = '10px';
    delBtn.textContent = '🗑 이 자막 삭제';
    delBtn.addEventListener('click', () => {
      EditorState.saveSnapshot();
      EditorState.removeClip(layerId, clipId);
      Timeline.render();
      Player.renderFrame();
    });
    body.appendChild(delBtn);
  }

  // ── Audio Properties ──────────────────────────────────────────────────────────
  function renderAudioProps(layerId, clipId, clip) {
    const body = document.getElementById('properties-body');
    body.innerHTML = '';

    const section = makeSection('오디오');
    section.appendChild(makeRow('이름', makeTextInput(clip.name || '', v => {
      EditorState.updateClip(layerId, clipId, { name: v });
    })));
    section.appendChild(makeRow('시작(s)', makeNumberInput(clip.startTime.toFixed(2), v => {
      EditorState.updateClip(layerId, clipId, { startTime: parseFloat(v) });
      Timeline.render();
    })));
    section.appendChild(makeRow('볼륨', makeRangeInput((clip.volume || 0.8) * 100, 0, 100, v => {
      EditorState.updateClip(layerId, clipId, { volume: parseFloat(v) / 100 });
    })));
    body.appendChild(section);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.style.width = '100%';
    delBtn.style.marginTop = '10px';
    delBtn.textContent = '🗑 오디오 삭제';
    delBtn.addEventListener('click', () => {
      EditorState.saveSnapshot();
      EditorState.removeClip(layerId, clipId);
      Timeline.render();
    });
    body.appendChild(delBtn);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────
  function makeSection(title) {
    const div = document.createElement('div');
    div.className = 'prop-section';
    const h = document.createElement('div');
    h.className = 'prop-section-title';
    h.textContent = title;
    div.appendChild(h);
    return div;
  }

  function makeRow(label, input) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.className = 'prop-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(input);
    return row;
  }

  function makeNumberInput(val, onChange) {
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'prop-input';
    el.value = val;
    el.step = 'any';
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  function makeTextInput(val, onChange) {
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'prop-input';
    el.value = val;
    el.addEventListener('input', () => onChange(el.value));
    return el;
  }

  function makeRangeInput(val, min, max, onChange) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.gap = '6px';
    const el = document.createElement('input');
    el.type = 'range';
    el.className = 'prop-input';
    el.min = min; el.max = max; el.value = val;
    const label = document.createElement('span');
    label.style.fontSize = '11px'; label.style.color = 'var(--text-secondary)';
    label.style.minWidth = '30px';
    label.textContent = Math.round(val) + '%';
    el.addEventListener('input', () => {
      label.textContent = Math.round(el.value) + '%';
      onChange(el.value);
    });
    wrap.appendChild(el); wrap.appendChild(label);
    return wrap;
  }

  function makeColorInput(val, onChange) {
    const el = document.createElement('input');
    el.type = 'color';
    el.className = 'prop-input';
    el.value = val.startsWith('rgba') ? '#ffffff' : val;
    el.addEventListener('input', () => onChange(el.value));
    return el;
  }

  function makeColorInputAlpha(val, onChange) {
    // Simple text input for rgba
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'prop-input';
    el.value = val;
    el.placeholder = 'rgba(0,0,0,0.6)';
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  function makeCheckbox(val, onChange) {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.className = 'prop-checkbox';
    el.checked = val;
    el.addEventListener('change', () => onChange(el.checked));
    return el;
  }

  return { init };
})();
