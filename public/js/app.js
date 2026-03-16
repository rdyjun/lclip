// Main page application logic
function handleUnauthorized(r) {
  if (r.status === 401) { location.href = '/login'; return true; }
  return false;
}

const API = {
  async get(url) {
    const r = await fetch(url);
    if (handleUnauthorized(r)) return;
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (handleUnauthorized(r)) return;
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async patch(url, data) {
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (handleUnauthorized(r)) return;
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async delete(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (handleUnauthorized(r)) return;
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
};

function showToast(msg, duration = 3000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

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
    if (page === 'ai-results') loadAiResults();
    else disconnectAiStream();
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

  card.querySelector('.btn-ai-analyze').addEventListener('click', () => openAiModal(video));
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
let _activeProjectFolderId = null; // persists across reloads

async function loadProjects() {
  const sidebar    = document.getElementById('projects-sidebar');
  const grid       = document.getElementById('project-grid');
  const emptyState = document.getElementById('empty-projects');

  try {
    const [projects, videos] = await Promise.all([
      API.get('/api/projects'),
      API.get('/api/videos'),
    ]);
    sidebar.innerHTML = '';
    grid.innerHTML    = '';

    if (!projects.length) {
      grid.appendChild(emptyState);
      return;
    }

    const videoMap = Object.fromEntries(videos.map(v => [v.id, v]));

    // Group projects by sourceVideoId
    const folderMap = new Map();
    const orphans   = [];
    projects.forEach(p => {
      const vid = p.sourceVideoId;
      if (vid && videoMap[vid]) {
        if (!folderMap.has(vid)) folderMap.set(vid, { videoId: vid, name: videoMap[vid].name, projects: [] });
        folderMap.get(vid).projects.push(p);
      } else {
        orphans.push(p);
      }
    });

    const folders = [...folderMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    if (orphans.length) folders.push({ videoId: null, name: '기타', projects: orphans });

    function selectFolder(folder, itemEl) {
      _activeProjectFolderId = folder.videoId;
      sidebar.querySelectorAll('.sidebar-folder-item').forEach(el => el.classList.remove('active'));
      itemEl.classList.add('active');
      grid.innerHTML = '';
      folder.projects.forEach(p => grid.appendChild(createProjectCard(p)));
    }

    // Determine which folder to activate (restore previous selection if possible)
    let defaultIdx = 0;
    if (_activeProjectFolderId !== null) {
      const idx = folders.findIndex(f => f.videoId === _activeProjectFolderId);
      if (idx !== -1) defaultIdx = idx;
    }

    folders.forEach((folder, i) => {
      const item = document.createElement('div');
      item.className = 'sidebar-folder-item' + (i === defaultIdx ? ' active' : '');
      item.innerHTML =
        `<span class="sidebar-folder-icon">📁</span>` +
        `<span class="sidebar-folder-name">${folder.name}</span>` +
        `<span class="sidebar-folder-badge">${folder.projects.length}</span>`;
      item.addEventListener('click', () => selectFolder(folder, item));
      sidebar.appendChild(item);
    });

    // Show default folder
    folders[defaultIdx].projects.forEach(p => grid.appendChild(createProjectCard(p)));
    _activeProjectFolderId = folders[defaultIdx].videoId;
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
      _activeProjectFolderId = project.sourceVideoId || null;
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
    document.getElementById('modal-create-short').style.display = 'none';
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

  let participantOptions = '<option value="">-- 선택하세요 --</option>';
  (data.participants || []).forEach((p, i) => {
    participantOptions += `<option value="${i}">${p.championName} (${p.summonerName}) · K${p.kills}/D${p.deaths}/A${p.assists}</option>`;
  });

  const eventsText = (data.eventsFound && data.events.length > 0)
    ? data.events.map(e => `${fmtTime(e.timeS)} ${e.type}`).join('\n')
    : '';

  body.innerHTML = `
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">게임 시간: ${matchDur}</p>
    <label class="form-label">내가 플레이한 챔피언</label>
    <select class="form-input" id="rofl-champion-select">
      ${participantOptions}
    </select>
    <div class="prop-row" style="margin-top:12px">
      <label class="prop-label" style="min-width:140px">영상 시작 오프셋 (초)</label>
      <input type="number" class="prop-input" id="rofl-video-offset" value="0" min="0" step="0.1"
        title="녹화 영상에서 게임이 시작되는 시점. 예: 로딩화면 포함 시 ~90 입력">
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">예: 로딩화면 포함 녹화 시 약 90초 입력</p>
    <div id="rofl-auto-section" style="display:none;margin-top:4px">
      <label class="form-label" style="margin-bottom:6px">자동 분석 결과 <span style="font-size:11px;color:var(--text-muted);font-weight:400">(점수 순 — 체크된 클립만 생성)</span></label>
      <div id="rofl-scored-clips"></div>
    </div>
    <details style="margin-top:14px">
      <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none">수동 입력 / 고급 설정</summary>
      <div style="margin-top:10px">
        ${data.eventsFound
          ? `<p style="font-size:12px;color:#2ecc71;margin-bottom:4px">✅ ${data.events.length}개 전투 구간 감지됨</p>`
          : `<p style="font-size:12px;color:var(--text-muted);margin-bottom:4px">자동 이벤트 감지 불가 — 직접 입력하세요.</p>`}
        <label class="form-label">이벤트 목록</label>
        <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">형식: 분:초 또는 초 + 유형(kill/death/assist/activity)</p>
        <textarea class="form-input" id="rofl-events-text" rows="5"
          placeholder="5:30 kill&#10;8:15 death&#10;9:20 activity">${eventsText}</textarea>
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
        </div>
      </div>
    </details>`;

  const sel = document.getElementById('rofl-champion-select');
  sel.addEventListener('change', () => {
    if (sel.value !== '') runAutoScore();
    else {
      _scoredClips = [];
      document.getElementById('rofl-auto-section').style.display = 'none';
      document.getElementById('btn-rofl-confirm').disabled = true;
    }
  });
  document.getElementById('rofl-video-offset').addEventListener('change', () => {
    if (sel.value !== '') runAutoScore();
  });

  document.getElementById('btn-rofl-confirm').disabled = true;
}

function fmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── ROFL Auto-Score ──────────────────────────────────────────────────────────
const SUBTITLE_POOLS = {
  penta:    ['야 ㅋㅋㅋ', '미친', '다 줘', '이게 되네'],
  quad:     ['ㅋㅋ 다 있네', '야', '전부 다야'],
  triple:   ['어 다 있네', '이 정도야', 'ㄷㄷ'],
  double:   ['쉽죠?', '어?', '당연하지'],
  outplay:  ['아슬아슬', '이게 피냐', 'ㅋㅋ 살았다'],
  activity: ['여기서', '자 가자', '집중'],
  single:   ['별거 아님', '이 정도야'],
};

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function getMultiKillLabel(n) {
  return n >= 5 ? 'penta' : n === 4 ? 'quad' : n === 3 ? 'triple' : n === 2 ? 'double' : 'single';
}

function getTemplateSubtitles(label, duration) {
  const pool = SUBTITLE_POOLS[label] || SUBTITLE_POOLS.single;
  const count = duration > 25 ? 3 : 2;
  const subs = [];
  for (let i = 0; i < count; i++) {
    subs.push({ offsetSec: Math.round(duration * (i + 1) / (count + 1)), text: pickRandom(pool), duration: 2 });
  }
  return subs;
}

function buildScoredClipsFromKills(killEvents, participantName, videoOffset, videoDuration, before, after) {
  const WINDOW = 12;
  let myKills = killEvents;
  if (participantName) {
    const base = participantName.toLowerCase().replace(/\s*#.*$/, '');
    const filtered = killEvents.filter(e => {
      const k = (e.killer || '').toLowerCase();
      return k && (k === base || k.includes(base) || base.includes(k));
    });
    if (filtered.length > 0) myKills = filtered;
  }
  const sorted = [...myKills].sort((a, b) => a.timeS - b.timeS);
  const clusters = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].timeS - cur[cur.length - 1].timeS <= WINDOW) cur.push(sorted[i]);
    else { clusters.push([...cur]); cur = [sorted[i]]; }
  }
  clusters.push(cur);
  const SCORES = { penta: 100, quad: 80, triple: 60, double: 40, single: 20 };
  return clusters.map(cluster => {
    const label = getMultiKillLabel(cluster.length);
    const srcStart = Math.max(0, cluster[0].timeS - before + videoOffset);
    const srcEnd   = Math.min(videoDuration, cluster[cluster.length - 1].timeS + after + videoOffset);
    return { srcStart, srcEnd, score: SCORES[label], label, killCount: cluster.length,
             eventTypes: [label], subtitles: getTemplateSubtitles(label, srcEnd - srcStart) };
  }).sort((a, b) => b.score - a.score);
}

function buildScoredClipsFromActivity(activityEvents, videoOffset, videoDuration, before, after) {
  return activityEvents
    .map(e => {
      const srcStart = Math.max(0, e.timeS - before + videoOffset);
      const srcEnd   = Math.min(videoDuration, e.timeS + after + videoOffset);
      return { srcStart, srcEnd, score: Math.round(e.intensity * 10), label: 'activity',
               killCount: 0, eventTypes: ['activity'],
               subtitles: getTemplateSubtitles('activity', srcEnd - srcStart) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

let _scoredClips = [];

function runAutoScore() {
  if (!roflData) return;
  const selEl = document.getElementById('rofl-champion-select');
  const participantIdx = selEl ? parseInt(selEl.value) : NaN;
  const participant = !isNaN(participantIdx) ? roflData.participants?.[participantIdx] : null;
  const offset = parseFloat(document.getElementById('rofl-video-offset')?.value || 0);
  const before = 10, after = 10;
  const videoDuration = selectedVideoForShort?.duration || 99999;

  const killEvents     = (roflData.events || []).filter(e => e.type === 'kill');
  const activityEvents = (roflData.events || []).filter(e => e.type === 'activity');

  let clips = [];
  if (killEvents.length > 0) {
    clips = buildScoredClipsFromKills(killEvents, participant?.summonerName, offset, videoDuration, before, after);
  } else if (activityEvents.length > 0) {
    clips = buildScoredClipsFromActivity(activityEvents, offset, videoDuration, before, after);
  }
  _scoredClips = clips.map(c => ({ ...c, checked: true }));
  renderScoredClipsList();
  const autoSection = document.getElementById('rofl-auto-section');
  if (autoSection) autoSection.style.display = _scoredClips.length ? '' : 'none';
  document.getElementById('btn-rofl-confirm').disabled = !_scoredClips.some(c => c.checked);
}

function renderScoredClipsList() {
  const container = document.getElementById('rofl-scored-clips');
  if (!container) return;
  if (!_scoredClips.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px">감지된 클립 없음</p>';
    return;
  }
  const LABEL_KO = { penta: '펜타킬', quad: '쿼드라킬', triple: '트리플킬', double: '더블킬', single: '단일킬', activity: '전투', outplay: '아웃플레이' };
  const scoreColor = s => s >= 80 ? '#e74c3c' : s >= 60 ? '#e67e22' : s >= 40 ? '#f1c40f' : '#95a5a6';
  container.innerHTML = _scoredClips.map((clip, i) => {
    const label  = LABEL_KO[clip.label] || clip.label;
    const time   = `${fmtTime(clip.srcStart)} ~ ${fmtTime(clip.srcEnd)}`;
    const dur    = Math.round(clip.srcEnd - clip.srcStart);
    const filled = Math.min(5, Math.ceil(clip.score / 20));
    const stars  = '★'.repeat(filled) + '☆'.repeat(5 - filled);
    return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px">
      <input type="checkbox" data-ci="${i}" ${clip.checked ? 'checked' : ''} style="flex-shrink:0">
      <span style="color:${scoreColor(clip.score)};min-width:60px">${stars}</span>
      <span style="font-weight:600;min-width:56px">${label}</span>
      <span style="color:var(--text-muted)">${time} (${dur}초)</span>
    </label>`;
  }).join('');
  container.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', e => {
      _scoredClips[parseInt(e.target.dataset.ci)].checked = e.target.checked;
      document.getElementById('btn-rofl-confirm').disabled = !_scoredClips.some(c => c.checked);
    });
  });
}

function parseManualEvents(text) {
  const events = [];
  text.split(/[\n,]+/).forEach(line => {
    const t = line.trim(); if (!t) return;
    const m1 = t.match(/^(\d+):(\d+)\s+(kill|death|assist|activity)$/i);
    const m2 = t.match(/^(\d+(?:\.\d+)?)\s+(kill|death|assist|activity)$/i);
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
  selectedVideoForShort = null;
});
document.getElementById('modal-rofl').addEventListener('click', e => {
  if (e.target === e.currentTarget) {
    document.getElementById('modal-rofl').style.display = 'none';
    selectedVideoForShort = null;
  }
});
document.getElementById('btn-rofl-back').addEventListener('click', () => {
  document.getElementById('modal-rofl').style.display = 'none';
  document.getElementById('modal-create-short').style.display = 'flex';
});

document.getElementById('btn-rofl-confirm').addEventListener('click', async () => {
  let roflClips;
  const autoClips = _scoredClips.filter(c => c.checked);
  if (autoClips.length > 0) {
    roflClips = autoClips;
  } else {
    const text   = document.getElementById('rofl-events-text')?.value || '';
    const offset = parseFloat(document.getElementById('rofl-video-offset')?.value || 0);
    const before = parseFloat(document.getElementById('rofl-before')?.value || 10);
    const after  = parseFloat(document.getElementById('rofl-after')?.value || 10);
    const merge  = parseFloat(document.getElementById('rofl-merge')?.value || 20);
    const events = parseManualEvents(text);
    if (!events.length) { alert('이벤트가 없습니다. 타임라인을 입력해 주세요.\n예) 5:30 kill'); return; }
    roflClips = generateRoflClips(events, offset, selectedVideoForShort?.duration || 99999, before, after, merge);
    if (!roflClips.length) { alert('유효한 클립을 생성할 수 없습니다. 이벤트 시간과 오프셋을 확인해 주세요.'); return; }
  }

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

// ── AI Highlight Analysis ─────────────────────────────────────────────────────
let _aiVideo = null;
let _aiClips = [];
let _aiMusic = [];

function openAiModal(video) {
  _aiVideo = video;
  _aiClips = [];
  document.getElementById('ai-modal-footer').style.display = 'none';
  document.getElementById('ai-modal-body').innerHTML =
    `<p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px">
       <strong>${video.name}</strong> 영상을 Gemini AI가 직접 시청하며 분석합니다.<br>
       킬, 멀티킬, 아웃플레이 등 유튜브 반응이 좋을 하이라이트를 자동으로 찾아 쇼츠 클립을 생성합니다.
     </p>
     <div class="progress-bar" id="ai-progress-bar" style="display:none">
       <div class="progress-fill" id="ai-progress-fill" style="width:0%"></div>
     </div>
     <p class="progress-text" id="ai-progress-text" style="display:none"></p>
     <button class="btn btn-primary" id="btn-ai-start" style="margin-top:8px">분석 시작</button>`;

  document.getElementById('btn-ai-start').addEventListener('click', startAiAnalysis);
  document.getElementById('modal-ai').style.display = 'flex';
}

async function startAiAnalysis() {
  document.getElementById('btn-ai-start').remove();
  document.getElementById('ai-progress-bar').style.display = 'block';
  document.getElementById('ai-progress-text').style.display = 'block';
  setAiProgress(10, '분석 요청 중...');
  try {
    const { jobId, existing } = await API.post('/api/ai/analyze', { videoId: _aiVideo.id });
    showToast(existing ? '이미 분석 중인 영상입니다.' : '✨ AI 분석 요청이 등록되었습니다.');
    setAiProgress(100, existing ? '이미 분석 중인 영상입니다.' : '분석이 시작되었습니다. 완료되면 상단 버튼에서 확인할 수 있습니다.');
    document.getElementById('ai-progress-bar').style.display = 'none';
    document.getElementById('ai-modal-footer').style.display = 'none';
    await refreshAiQueue();
    setTimeout(() => { document.getElementById('modal-ai').style.display = 'none'; }, 1800);
  } catch (err) {
    document.getElementById('ai-modal-body').innerHTML =
      `<p style="color:#e74c3c;font-size:13px">❌ ${err.message}</p>`;
  }
}

function setAiProgress(percent, message) {
  document.getElementById('ai-progress-fill').style.width = percent + '%';
  document.getElementById('ai-progress-text').textContent = message;
}

function renderAiResults(shorts, music) {
  if (!shorts.length) {
    document.getElementById('ai-modal-body').innerHTML =
      `<p style="color:var(--text-secondary);font-size:13px">하이라이트 장면을 찾지 못했습니다.</p>`;
    return;
  }

  // ── Shorts list ──
  let html = `<p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
    ✅ <strong>${shorts.length}개</strong> 쇼츠를 생성합니다.
  </p><div style="display:flex;flex-direction:column;gap:8px">`;

  shorts.forEach((s, i) => {
    const dur = s.totalDuration.toFixed(0);
    const overLimit = s.totalDuration > 60;
    const typeBadge = s.type === 'montage'
      ? `<span style="font-size:10px;background:#8e44ad;color:#fff;padding:1px 6px;border-radius:3px;margin-left:6px">모음</span>`
      : `<span style="font-size:10px;background:#2980b9;color:#fff;padding:1px 6px;border-radius:3px;margin-left:6px">단독</span>`;

    let timeInfo = s.type === 'standalone'
      ? `${fmtTime(s.segments[0].srcStart)} ~ ${fmtTime(s.segments[0].srcEnd)}`
      : `${s.segments.length}개 구간 이어붙이기`;

    const subPreview = s.subtitles?.length
      ? `<div style="font-size:10px;color:var(--accent);margin-top:3px">자막 ${s.subtitles.length}개: ${s.subtitles.map(t => `"${t.text}"`).join(', ')}</div>`
      : '';

    html += `
      <div style="background:var(--bg-hover);border-radius:6px;padding:10px 14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="color:var(--accent);font-weight:600;min-width:20px">#${i + 1}</span>
          <span style="font-size:13px;font-weight:600;flex:1">${s.title}</span>
          ${typeBadge}
          <span style="font-size:11px;color:${overLimit ? '#e74c3c' : 'var(--text-muted)'};font-weight:600">${dur}s${overLimit ? ' ⚠️' : ''}</span>
          ${s.virality ? `<span style="font-size:11px;color:#f1c40f;font-weight:600">⚡${s.virality}</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--text-muted)">${timeInfo}${s.description ? ' · ' + s.description : ''}</div>
        ${subPreview}
      </div>`;
  });
  html += '</div>';

  // ── Music recommendations ──
  if (music && music.length) {
    html += `
      <div style="margin-top:20px">
        <p style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text-primary)">🎵 추천 배경음악</p>
        <div style="display:flex;flex-direction:column;gap:8px">`;

    music.forEach(m => {
      const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(m.searchQuery || m.title)}`;
      html += `
        <div style="background:var(--bg-hover);border-radius:6px;padding:10px 14px;display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.title}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${[m.genre, m.mood, m.source].filter(Boolean).join(' · ')}</div>
          </div>
          <a href="${ytUrl}" target="_blank" rel="noopener"
             style="font-size:11px;padding:4px 10px;background:#c0392b;color:#fff;border-radius:4px;text-decoration:none;white-space:nowrap;flex-shrink:0">
            유튜브 검색
          </a>
        </div>`;
    });

    html += `</div></div>`;
  }

  document.getElementById('ai-modal-body').innerHTML = html;
  document.getElementById('ai-modal-footer').style.display = 'flex';
  const btn = document.getElementById('btn-ai-confirm');
  btn.disabled = false;
  btn.textContent = `쇼츠 ${shorts.length}개 생성`;
}

document.getElementById('ai-modal-close').addEventListener('click', () => {
  document.getElementById('modal-ai').style.display = 'none';
});
document.getElementById('btn-ai-cancel').addEventListener('click', () => {
  document.getElementById('modal-ai').style.display = 'none';
});
document.getElementById('modal-ai').addEventListener('click', e => {
  if (e.target === e.currentTarget) document.getElementById('modal-ai').style.display = 'none';
});

document.getElementById('btn-ai-confirm').addEventListener('click', async () => {
  if (!_aiVideo || !_aiClips.length) return;
  const btn = document.getElementById('btn-ai-confirm');
  btn.disabled = true;
  btn.textContent = '생성 중...';
  try {
    // Create one project per short in parallel
    const projects = await Promise.all(_aiClips.map(short =>
      API.post('/api/projects', {
        sourceVideoId: _aiVideo.id,
        name: short.title,
        musicRecommendations: _aiMusic,
        roflClips: short.segments.map((s, i) => ({
          srcStart:   s.srcStart,
          srcEnd:     s.srcEnd,
          eventTypes: ['highlight'],
          // Distribute subtitles to the first segment; montage offsets are cumulative
          subtitles: i === 0 ? short.subtitles || [] : [],
        })),
      })
    ));

    document.getElementById('modal-ai').style.display = 'none';

    if (projects.length === 1) {
      window.location.href = `/editor/${projects[0].id}`;
    } else {
      // Refresh project list so all new projects appear
      await loadProjects();
      // Scroll to project section
      document.querySelector('[data-page="projects"]')?.click();
    }
  } catch (err) {
    alert('프로젝트 생성 실패: ' + err.message);
    btn.disabled = false;
    btn.textContent = `쇼츠 ${_aiClips.length}개 생성`;
  }
});

// ── AI Queue ──────────────────────────────────────────────────────────────────
let _queueJobs = [];

async function refreshAiQueue() {
  try {
    _queueJobs = await API.get('/api/ai/jobs');
    updateAiQueueBadge();
    if (document.getElementById('ai-fab-popup').style.display !== 'none') {
      renderAiQueue();
    }
  } catch (_) {}
}

function updateAiQueueBadge() {
  const btn = document.getElementById('btn-ai-queue');
  const badge = document.getElementById('ai-queue-badge');
  const running = _queueJobs.filter(j => j.status === 'running' || j.status === 'queued').length;
  const total = _queueJobs.length;
  if (total === 0) {
    badge.style.display = 'none';
    btn.style.background = '';
    return;
  }
  badge.style.display = '';
  badge.textContent = total;
  const hasError = _queueJobs.some(j => j.status === 'error');
  btn.style.background = running ? '#2980b9' : hasError ? '#c0392b' : '#27ae60';
}

function renderAiQueue() {
  const body = document.getElementById('ai-queue-body');
  if (!_queueJobs.length) {
    body.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">진행 중인 분석이 없습니다.</p>';
    return;
  }
  let html = '<div style="display:flex;flex-direction:column;gap:12px">';
  _queueJobs.forEach(job => {
    const statusColor = { queued: '#888', running: '#3498db', done: '#27ae60', error: '#e74c3c' }[job.status] || '#888';
    const statusLabel = { queued: '대기 중', running: '분석 중', done: '완료 — 등록 대기', error: '오류' }[job.status] || job.status;
    const timeAgo = Math.round((Date.now() - job.createdAt) / 60000);
    const timeStr = timeAgo < 1 ? '방금 전' : `${timeAgo}분 전`;

    let actions = '';
    if (job.status === 'done') {
      const count = job.result?.shorts?.length || 0;
      actions = `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-primary btn-sm" onclick="approveAiJob('${job.id}')">✅ 쇼츠 ${count}개 등록</button>
          <button class="btn btn-secondary btn-sm" onclick="rejectAiJob('${job.id}')">✕ 반려</button>
        </div>`;
    } else if (job.status === 'error') {
      actions = `
        <div style="margin-top:8px;font-size:12px;color:#e74c3c">${job.error || '알 수 없는 오류'}</div>
        <div style="margin-top:8px"><button class="btn btn-secondary btn-sm" onclick="rejectAiJob('${job.id}')">✕ 닫기</button></div>`;
    } else {
      const pct = job.progress?.percent || 0;
      const msg = job.progress?.message || '';
      actions = `
        <div style="margin-top:10px">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <p style="font-size:12px;color:var(--text-muted);margin-top:4px">${msg}</p>
        </div>`;
    }

    html += `
      <div style="background:var(--bg-hover);border-radius:8px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;flex:1">${job.videoName}</span>
          <span style="font-size:11px;color:${statusColor};font-weight:600">${statusLabel}</span>
          <span style="font-size:11px;color:var(--text-muted)">${timeStr}</span>
        </div>
        ${actions}
      </div>`;
  });
  html += '</div>';
  body.innerHTML = html;
}

async function approveAiJob(jobId) {
  const job = _queueJobs.find(j => j.id === jobId);
  if (!job || !job.result) return;
  const { shorts, music } = job.result;

  const btn = document.querySelector(`[onclick="approveAiJob('${jobId}')"]`);
  if (btn) { btn.disabled = true; btn.textContent = '생성 중...'; }

  try {
    const projects = await Promise.all(shorts.map(short =>
      API.post('/api/projects', {
        sourceVideoId: job.videoId,
        name: short.title,
        musicRecommendations: music || [],
        roflClips: short.segments.map((s, i) => ({
          srcStart: s.srcStart,
          srcEnd: s.srcEnd,
          eventTypes: ['highlight'],
          subtitles: i === 0 ? short.subtitles || [] : [],
        })),
      })
    ));

    await API.delete(`/api/ai/jobs/${jobId}`);
    await refreshAiQueue();

    document.getElementById('ai-fab-popup').style.display = 'none';
    if (projects.length === 1) {
      window.location.href = `/editor/${projects[0].id}`;
    } else {
      await loadProjects();
      document.querySelector('[data-page="projects"]')?.click();
    }
  } catch (err) {
    alert('프로젝트 생성 실패: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = `✅ 쇼츠 ${shorts.length}개 등록`; }
  }
}

async function rejectAiJob(jobId) {
  try {
    await API.delete(`/api/ai/jobs/${jobId}`);
    await refreshAiQueue();
  } catch (err) {
    alert('삭제 실패: ' + err.message);
  }
}

document.getElementById('btn-ai-queue').addEventListener('click', (e) => {
  e.stopPropagation();
  const popup = document.getElementById('ai-fab-popup');
  if (popup.style.display !== 'none') {
    popup.style.display = 'none';
  } else {
    renderAiQueue();
    popup.style.display = '';
  }
});
document.addEventListener('click', (e) => {
  const container = document.getElementById('ai-fab-container');
  if (container && !container.contains(e.target)) {
    document.getElementById('ai-fab-popup').style.display = 'none';
  }
});

// Poll every 5s
setInterval(refreshAiQueue, 5000);
refreshAiQueue();

// ── AI Settings Modal ─────────────────────────────────────────────────────────
async function openAiSettings() {
  try {
    const cfg = await API.get('/api/ai/config');
    document.getElementById('ai-settings-refs').value = (cfg.referenceVideos || []).join('\n');
    document.getElementById('ai-settings-concept').value = cfg.concept || '';
  } catch (_) {}
  document.getElementById('modal-ai-settings').style.display = 'flex';
}

document.getElementById('btn-ai-settings').addEventListener('click', openAiSettings);
document.getElementById('ai-settings-close').addEventListener('click', () => {
  document.getElementById('modal-ai-settings').style.display = 'none';
});
document.getElementById('ai-settings-cancel').addEventListener('click', () => {
  document.getElementById('modal-ai-settings').style.display = 'none';
});
document.getElementById('modal-ai-settings').addEventListener('click', e => {
  if (e.target === e.currentTarget) document.getElementById('modal-ai-settings').style.display = 'none';
});
document.getElementById('ai-settings-save').addEventListener('click', async () => {
  const refsRaw = document.getElementById('ai-settings-refs').value;
  const referenceVideos = refsRaw.split('\n').map(s => s.trim()).filter(Boolean);
  const concept = document.getElementById('ai-settings-concept').value.trim();
  const btn = document.getElementById('ai-settings-save');
  btn.disabled = true;
  btn.textContent = '저장 중...';
  try {
    await API.post('/api/ai/config', { referenceVideos, concept });
    document.getElementById('modal-ai-settings').style.display = 'none';
  } catch (err) {
    alert('저장 실패: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '저장';
  }
});

// ── AI Results Page ───────────────────────────────────────────────────────────
let _aiEventSource = null;

function connectAiStream() {
  if (_aiEventSource) return;
  _aiEventSource = new EventSource('/api/ai/stream');
  _aiEventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'init') renderAiResultsList(data.jobs);
    else if (data.type === 'update') updateAiResultItem(data.job);
  };
  _aiEventSource.onerror = () => {
    // EventSource auto-reconnects on error
  };
}

function disconnectAiStream() {
  if (_aiEventSource) {
    _aiEventSource.close();
    _aiEventSource = null;
  }
}

function loadAiResults() {
  connectAiStream();
}

function renderAiResultsList(jobs) {
  const list = document.getElementById('ai-results-list');
  if (!list) return;
  if (!jobs.length) {
    list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px">분석 이력이 없습니다.</p>';
    return;
  }
  list.innerHTML = '';
  jobs.forEach(job => list.appendChild(renderAiResultItem(job)));
}

function updateAiResultItem(job) {
  const list = document.getElementById('ai-results-list');
  if (!list) return;
  const existing = list.querySelector(`[data-job-id="${job.id}"]`);
  const newEl = renderAiResultItem(job);
  if (existing) existing.replaceWith(newEl);
  else list.prepend(newEl);
}

function renderAiResultItem(job) {
  const statusLabel = { queued: '대기', running: '분석중', done: '완료', error: '오류' };
  const statusColor = { queued: 'var(--text-muted)', running: 'var(--accent)', done: '#4caf50', error: 'var(--error)' };
  const date = new Date(job.createdAt).toLocaleString('ko-KR');

  const el = document.createElement('div');
  el.className = 'ai-result-item';
  el.dataset.jobId = job.id;

  const badgeStyle = `background:${statusColor[job.status] || 'var(--text-muted)'};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;`;

  let detailHtml = '';
  if (job.status === 'done' && job.result?.shorts?.length) {
    const rows = job.result.shorts.map(s => {
      const dur = s.totalDuration != null ? `${Math.round(s.totalDuration)}s` : '';
      return `<div class="ai-short-row">
        <span style="font-weight:600">${s.title || '(제목 없음)'}</span>
        ${s.type ? `<span style="color:var(--text-muted)">[${s.type}]</span>` : ''}
        ${dur ? `<span style="color:var(--text-muted)">${dur}</span>` : ''}
        ${s.virality != null ? `<span style="color:var(--accent)">★${s.virality}</span>` : ''}
      </div>`;
    }).join('');
    detailHtml = `<div class="ai-result-shorts">${rows}</div>`;
  } else if (job.status === 'error') {
    detailHtml = `<div style="margin-top:8px;color:var(--error);font-size:13px">오류: ${job.error || '알 수 없는 오류'}</div>`;
  } else if (job.status === 'running' || job.status === 'queued') {
    const pct = job.progress?.percent ?? 0;
    const msg = job.progress?.message ?? '';
    detailHtml = `<div style="margin-top:10px">
      <div style="background:var(--bg-primary);border-radius:4px;height:6px;overflow:hidden">
        <div style="background:var(--accent);height:100%;width:${pct}%;transition:width 0.3s"></div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${msg} (${pct}%)</div>
    </div>`;
  }

  const logsHtml = (job.logs || []).map(l => {
    const t = new Date(l.time).toLocaleTimeString('ko-KR');
    return `<div class="ai-log-line"><span class="ai-log-time">${t}</span>${l.message}</div>`;
  }).join('');

  el.innerHTML = `
    <div class="ai-result-header">
      <span class="ai-result-title">${job.videoName || job.videoId}</span>
      <span style="${badgeStyle}">${statusLabel[job.status] || job.status}</span>
      <button class="btn btn-secondary btn-sm btn-toggle-logs">로그 보기</button>
    </div>
    <div class="ai-result-meta">${date}</div>
    ${detailHtml}
    <div class="ai-result-logs">${logsHtml || '<span style="color:var(--text-muted)">로그 없음</span>'}</div>
  `;

  el.querySelector('.btn-toggle-logs').addEventListener('click', () => {
    el.querySelector('.ai-result-logs').classList.toggle('open');
  });

  return el;
}

document.getElementById('btn-ai-results-refresh')
  ?.addEventListener('click', () => {
    disconnectAiStream();
    loadAiResults();
  });

// ── Init ──────────────────────────────────────────────────────────────────────
loadVideos();
