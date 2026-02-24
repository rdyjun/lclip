// Main page application logic
const API = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async patch(url, data) {
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async delete(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
};

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}

function calcProjectDuration(project) {
  let max = 0;
  (project.layers || []).forEach(layer => {
    (layer.clips || []).forEach(clip => {
      if ((clip.endTime || 0) > max) max = clip.endTime;
    });
  });
  return max;
}

function startInlineEdit(nameEl, saveCallback) {
  const currentName = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'name-edit-input';
  input.value = currentName;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim() || currentName;
    nameEl.textContent = newName;
    input.replaceWith(nameEl);
    if (newName !== currentName) {
      try { await saveCallback(newName); }
      catch (err) { nameEl.textContent = currentName; alert('저장 실패: ' + err.message); }
    }
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; nameEl.textContent = currentName; input.replaceWith(nameEl); }
  });
}

// ── Navigation ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const page = link.dataset.page;
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    link.classList.add('active');
    document.getElementById(`page-${page}`).classList.add('active');
    if (page === 'projects') loadProjects();
  });
});

// ── Add Video Tabs ────────────────────────────────────────────────────────────
document.querySelectorAll('.add-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.add-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.querySelectorAll('[data-tab-content]').forEach(el => {
      el.style.display = el.dataset.tabContent === target ? '' : 'none';
    });
  });
});

// ── Upload ───────────────────────────────────────────────────────────────────
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const uploadProgress = document.getElementById('upload-progress');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

document.getElementById('btn-upload').addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const files = e.dataTransfer.files;
  if (files[0]) uploadFile(files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});

function uploadFile(file) {
  const formData = new FormData();
  formData.append('video', file);

  uploadZone.querySelector('.upload-zone-inner').style.display = 'none';
  uploadProgress.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '업로드 중...';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/videos/upload');

  xhr.upload.onprogress = e => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFill.style.width = pct + '%';
      progressText.textContent = `업로드 중... ${pct}%`;
    }
  };

  xhr.onload = () => {
    uploadZone.querySelector('.upload-zone-inner').style.display = 'block';
    uploadProgress.style.display = 'none';
    fileInput.value = '';
    if (xhr.status === 200) {
      loadVideos();
    } else {
      alert('업로드 실패: ' + xhr.responseText);
    }
  };

  xhr.onerror = () => {
    uploadZone.querySelector('.upload-zone-inner').style.display = 'block';
    uploadProgress.style.display = 'none';
    alert('업로드 중 오류가 발생했습니다.');
  };

  xhr.send(formData);
}

// ── Local Path Registration ───────────────────────────────────────────────────
document.getElementById('btn-register-local').addEventListener('click', registerLocalPath);
document.getElementById('local-path-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') registerLocalPath();
});

async function registerLocalPath() {
  const input = document.getElementById('local-path-input');
  const hint = document.getElementById('local-path-hint');
  const btn = document.getElementById('btn-register-local');
  const localPath = input.value.trim();

  if (!localPath) {
    hint.textContent = '경로를 입력하세요.';
    hint.className = 'local-path-hint error';
    return;
  }

  btn.disabled = true;
  hint.textContent = '확인 중...';
  hint.className = 'local-path-hint';

  try {
    const video = await API.post('/api/videos/register-local', { localPath });
    hint.textContent = `✅ 등록 완료: ${video.name}`;
    hint.className = 'local-path-hint success';
    input.value = '';
    loadVideos();
  } catch (err) {
    let msg = err.message;
    try { msg = JSON.parse(msg).error || msg; } catch (_) {}
    hint.textContent = '❌ ' + msg;
    hint.className = 'local-path-hint error';
  } finally {
    btn.disabled = false;
  }
}

// ── Load Videos ──────────────────────────────────────────────────────────────
async function loadVideos() {
  const grid = document.getElementById('video-grid');
  const emptyState = document.getElementById('empty-state');

  try {
    const videos = await API.get('/api/videos');
    grid.innerHTML = '';

    if (!videos.length) {
      grid.appendChild(emptyState);
      return;
    }

    videos.forEach(video => {
      const card = createVideoCard(video);
      grid.appendChild(card);
    });
  } catch (err) {
    console.error(err);
  }
}

function createVideoCard(video) {
  const tpl = document.getElementById('tpl-video-card');
  const card = tpl.content.cloneNode(true).querySelector('.video-card');

  // Both uploaded files and local files are served via the stream endpoint
  const videoEl = card.querySelector('.thumb-video');
  videoEl.src = `/api/videos/stream/${video.id}`;
  videoEl.addEventListener('loadedmetadata', () => {
    videoEl.currentTime = 1;
  });

  // Show local badge for locally-registered files
  if (video.isLocal) {
    const badge = document.createElement('span');
    badge.className = 'local-badge';
    badge.textContent = '로컬';
    card.querySelector('.thumb-overlay').appendChild(badge);
  }

  card.querySelector('.duration-badge').textContent = formatDuration(video.duration);
  const nameEl = card.querySelector('.video-name');
  nameEl.textContent = video.name;
  card.querySelector('.video-meta').textContent = `${formatSize(video.size)} · ${formatDuration(video.duration)} · ${formatDate(video.createdAt)}`;

  card.querySelector('.btn-rename').addEventListener('click', e => {
    e.stopPropagation();
    startInlineEdit(nameEl, async newName => {
      await API.patch(`/api/videos/${video.id}`, { name: newName });
      video.name = newName;
    });
  });

  card.querySelector('.btn-create-short').addEventListener('click', () => openCreateShortModal(video));
  card.querySelector('.btn-delete').addEventListener('click', async () => {
    if (!confirm(`"${video.name}"을(를) 삭제할까요?`)) return;
    try {
      await API.delete(`/api/videos/${video.id}`);
      loadVideos();
    } catch (err) {
      alert('삭제 실패: ' + err.message);
    }
  });

  return card;
}

// ── Load Projects ────────────────────────────────────────────────────────────
async function loadProjects() {
  const grid = document.getElementById('project-grid');
  const emptyState = document.getElementById('empty-projects');

  try {
    const projects = await API.get('/api/projects');
    grid.innerHTML = '';

    if (!projects.length) {
      grid.appendChild(emptyState);
      return;
    }

    projects.forEach(project => {
      const card = createProjectCard(project);
      grid.appendChild(card);
    });
  } catch (err) {
    console.error(err);
  }
}

function createProjectCard(project) {
  const tpl = document.getElementById('tpl-project-card');
  const card = tpl.content.cloneNode(true).querySelector('.project-card');

  const projNameEl = card.querySelector('.project-name');
  projNameEl.textContent = project.name;

  const dur = calcProjectDuration(project);
  const durStr = dur > 0 ? `${formatDuration(dur)} · ` : '';
  card.querySelector('.project-meta').textContent = `${durStr}${formatDate(project.createdAt)}`;

  card.querySelector('.btn-rename').addEventListener('click', e => {
    e.stopPropagation();
    startInlineEdit(projNameEl, async newName => {
      await API.patch(`/api/projects/${project.id}`, { name: newName });
      project.name = newName;
    });
  });

  card.querySelector('.btn-open-editor').addEventListener('click', () => {
    window.location.href = `/editor/${project.id}`;
  });

  card.querySelector('.btn-delete-project').addEventListener('click', async () => {
    if (!confirm(`"${project.name}"을(를) 삭제할까요?`)) return;
    try {
      await API.delete(`/api/projects/${project.id}`);
      loadProjects();
    } catch (err) {
      alert('삭제 실패: ' + err.message);
    }
  });

  return card;
}

// ── Create Short Modal ────────────────────────────────────────────────────────
let selectedVideoForShort = null;
let roflFile = null;
let roflData = null;

function openCreateShortModal(video) {
  selectedVideoForShort = video;
  document.getElementById('source-video-name').textContent = video.name;
  document.getElementById('project-name-input').value = `${video.name} - Short`;
  roflFile = null; roflData = null;
  document.getElementById('rofl-file-input').value = '';
  document.getElementById('rofl-file-name').textContent = '선택된 파일 없음';
  document.getElementById('btn-clear-rofl').style.display = 'none';
  document.getElementById('modal-create-short').style.display = 'flex';
}

document.getElementById('btn-pick-rofl').addEventListener('click', () => {
  document.getElementById('rofl-file-input').click();
});
document.getElementById('rofl-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  roflFile = file;
  document.getElementById('rofl-file-name').textContent = file.name;
  document.getElementById('btn-clear-rofl').style.display = '';
});
document.getElementById('btn-clear-rofl').addEventListener('click', () => {
  roflFile = null; roflData = null;
  document.getElementById('rofl-file-input').value = '';
  document.getElementById('rofl-file-name').textContent = '선택된 파일 없음';
  document.getElementById('btn-clear-rofl').style.display = 'none';
});

document.getElementById('modal-close-btn').addEventListener('click', closeModal);
document.getElementById('btn-cancel-short').addEventListener('click', closeModal);
document.getElementById('modal-create-short').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

function closeModal() {
  document.getElementById('modal-create-short').style.display = 'none';
  selectedVideoForShort = null;
}

document.getElementById('btn-confirm-short').addEventListener('click', async () => {
  if (!selectedVideoForShort) return;
  const name = document.getElementById('project-name-input').value.trim() || 'New Short';
  if (roflFile) {
    closeModal();
    await openRoflModal(name);
  } else {
    try {
      const project = await API.post('/api/projects', { sourceVideoId: selectedVideoForShort.id, name });
      closeModal();
      window.location.href = `/editor/${project.id}`;
    } catch (err) {
      alert('프로젝트 생성 실패: ' + err.message);
    }
  }
});

// ── ROFL Modal ────────────────────────────────────────────────────────────────
let roflProjectName = '';

async function openRoflModal(name) {
  roflProjectName = name;
  const body = document.getElementById('rofl-modal-body');
  body.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">⏳ ROFL 파일 분석 중...</p>';
  document.getElementById('btn-rofl-confirm').disabled = true;
  document.getElementById('modal-rofl').style.display = 'flex';

  try {
    const formData = new FormData();
    formData.append('rofl', roflFile);
    const res = await fetch('/api/rofl/parse', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(await res.text());
    roflData = await res.json();
    renderRoflModalBody(roflData);
  } catch (err) {
    let msg = err.message;
    try { msg = JSON.parse(msg).error || msg; } catch (_) {}
    body.innerHTML = `<p style="color:#e74c3c;font-size:13px">❌ 분석 실패: ${msg}</p>
      <p style="font-size:12px;color:var(--text-muted);margin-top:8px">아래에 이벤트를 직접 입력하거나 뒤로 돌아가세요.</p>
      <label class="form-label" style="margin-top:14px;display:block">이벤트 목록 (직접 입력)</label>
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">형식: 분:초 또는 초 + 유형(kill/death/assist)</p>
      <textarea class="form-input" id="rofl-events-text" rows="5" placeholder="5:30 kill&#10;8:15 death&#10;9:20 assist"></textarea>
      <div class="prop-row" style="margin-top:10px">
        <label class="prop-label" style="min-width:140px">영상 시작 오프셋 (초)</label>
        <input type="number" class="prop-input" id="rofl-video-offset" value="0" min="0" step="0.1">
      </div>
      <div class="prop-row"><label class="prop-label" style="min-width:140px">이벤트 전 여유 (초)</label><input type="number" class="prop-input" id="rofl-before" value="10" min="0" max="60"></div>
      <div class="prop-row"><label class="prop-label" style="min-width:140px">이벤트 후 여유 (초)</label><input type="number" class="prop-input" id="rofl-after" value="10" min="0" max="60"></div>
      <div class="prop-row"><label class="prop-label" style="min-width:140px">연속 이벤트 합치기 (초)</label><input type="number" class="prop-input" id="rofl-merge" value="20" min="0" max="120"></div>`;
    document.getElementById('btn-rofl-confirm').disabled = false;
  }
}

function renderRoflModalBody(data) {
  const body = document.getElementById('rofl-modal-body');
  const matchDur = data.matchLengthMs
    ? `${Math.floor(data.matchLengthMs / 60000)}분 ${Math.floor((data.matchLengthMs % 60000) / 1000)}초`
    : '알 수 없음';

  let html = `<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">게임 시간: ${matchDur}</p>
    <label class="form-label">내가 플레이한 챔피언</label>
    <select class="form-input" id="rofl-champion-select">
      <option value="">-- 선택하세요 --</option>`;
  (data.participants || []).forEach((p, i) => {
    html += `<option value="${i}">${p.championName} (${p.summonerName}) · K${p.kills}/D${p.deaths}/A${p.assists}</option>`;
  });
  html += `</select>
    <div class="prop-row" style="margin-top:12px">
      <label class="prop-label" style="min-width:140px">영상 시작 오프셋 (초)</label>
      <input type="number" class="prop-input" id="rofl-video-offset" value="0" min="0" step="0.1"
        title="녹화 영상에서 게임이 시작되는 시점. 예: 로딩화면 포함 시 ~90 입력">
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:12px">예: 로딩화면 포함 녹화 시 약 90초 입력</p>
    ${data.eventsFound
      ? `<p style="font-size:12px;color:#2ecc71;margin-bottom:8px">✅ ${data.events.length}개 이벤트 자동 감지됨</p>`
      : `<p style="font-size:12px;color:var(--text-muted);margin-bottom:4px">자동 이벤트 감지 불가 — 직접 입력하세요.</p>`}
    <label class="form-label">이벤트 목록 (편집 가능)</label>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">형식: 분:초 또는 초 + 유형(kill/death/assist), 줄 또는 쉼표 구분</p>
    <textarea class="form-input" id="rofl-events-text" rows="6"
      placeholder="5:30 kill&#10;8:15 death&#10;9:20 assist"></textarea>
    <div class="prop-row" style="margin-top:10px">
      <label class="prop-label" style="min-width:140px">이벤트 전 여유 (초)</label>
      <input type="number" class="prop-input" id="rofl-before" value="10" min="0" max="60">
    </div>
    <div class="prop-row">
      <label class="prop-label" style="min-width:140px">이벤트 후 여유 (초)</label>
      <input type="number" class="prop-input" id="rofl-after" value="10" min="0" max="60">
    </div>
    <div class="prop-row">
      <label class="prop-label" style="min-width:140px">연속 이벤트 합치기 (초)</label>
      <input type="number" class="prop-input" id="rofl-merge" value="20" min="0" max="120">
    </div>`;

  body.innerHTML = html;

  if (data.eventsFound && data.events.length > 0) {
    document.getElementById('rofl-events-text').value =
      data.events.map(e => `${fmtTime(e.timeS)} ${e.type}`).join('\n');
  }

  const sel = document.getElementById('rofl-champion-select');
  sel.addEventListener('change', () => {
    document.getElementById('btn-rofl-confirm').disabled = !sel.value;
  });
  document.getElementById('btn-rofl-confirm').disabled = true;
}

function fmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function parseManualEvents(text) {
  const events = [];
  text.split(/[\n,]+/).forEach(line => {
    const t = line.trim(); if (!t) return;
    const m1 = t.match(/^(\d+):(\d+)\s+(kill|death|assist)$/i);
    const m2 = t.match(/^(\d+(?:\.\d+)?)\s+(kill|death|assist)$/i);
    if (m1) events.push({ type: m1[3].toLowerCase(), timeS: parseInt(m1[1]) * 60 + parseInt(m1[2]) });
    else if (m2) events.push({ type: m2[2].toLowerCase(), timeS: parseFloat(m2[1]) });
  });
  return events;
}

function generateRoflClips(events, videoOffset, videoDuration, before, after, merge) {
  if (!events.length) return [];
  events = [...events].sort((a, b) => a.timeS - b.timeS);
  const segs = [];
  let cur = { events: [events[0]], start: events[0].timeS, end: events[0].timeS };
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    if (e.timeS - cur.end <= merge) { cur.events.push(e); cur.end = e.timeS; }
    else { segs.push(cur); cur = { events: [e], start: e.timeS, end: e.timeS }; }
  }
  segs.push(cur);
  return segs.map(seg => ({
    srcStart:   Math.max(0, seg.start - before + videoOffset),
    srcEnd:     Math.min(videoDuration || 99999, seg.end + after + videoOffset),
    eventTypes: [...new Set(seg.events.map(e => e.type))]
  })).filter(c => c.srcEnd > c.srcStart);
}

document.getElementById('rofl-modal-close').addEventListener('click', () => {
  document.getElementById('modal-rofl').style.display = 'none';
});
document.getElementById('modal-rofl').addEventListener('click', e => {
  if (e.target === e.currentTarget) document.getElementById('modal-rofl').style.display = 'none';
});
document.getElementById('btn-rofl-back').addEventListener('click', () => {
  document.getElementById('modal-rofl').style.display = 'none';
  document.getElementById('modal-create-short').style.display = 'flex';
});

document.getElementById('btn-rofl-confirm').addEventListener('click', async () => {
  const text    = document.getElementById('rofl-events-text')?.value || '';
  const offset  = parseFloat(document.getElementById('rofl-video-offset')?.value || 0);
  const before  = parseFloat(document.getElementById('rofl-before')?.value || 10);
  const after   = parseFloat(document.getElementById('rofl-after')?.value || 10);
  const merge   = parseFloat(document.getElementById('rofl-merge')?.value || 20);

  const events = parseManualEvents(text);
  if (!events.length) { alert('이벤트가 없습니다. 타임라인을 입력해 주세요.\n예) 5:30 kill'); return; }

  const roflClips = generateRoflClips(events, offset, selectedVideoForShort?.duration || 99999, before, after, merge);
  if (!roflClips.length) { alert('유효한 클립을 생성할 수 없습니다. 이벤트 시간과 오프셋을 확인해 주세요.'); return; }

  const btn = document.getElementById('btn-rofl-confirm');
  btn.disabled = true; btn.textContent = '생성 중...';
  try {
    const project = await API.post('/api/projects', {
      sourceVideoId: selectedVideoForShort.id,
      name: roflProjectName,
      roflClips
    });
    document.getElementById('modal-rofl').style.display = 'none';
    window.location.href = `/editor/${project.id}`;
  } catch (err) {
    alert('프로젝트 생성 실패: ' + err.message);
    btn.disabled = false; btn.textContent = '클립 생성 후 편집기 열기';
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadVideos();
