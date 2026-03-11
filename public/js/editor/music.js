(function () {
  'use strict';

  let _searchTimeout = null;
  let _activeTab     = 'recommend'; // 'recommend' | 'youtube' | 'library'
  let _drawerOpen    = false;

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    const toggleBtn = document.getElementById('btn-toggle-music');
    const drawer    = document.getElementById('music-drawer');
    if (!toggleBtn || !drawer) return;

    toggleBtn.addEventListener('click', () => {
      _drawerOpen = !_drawerOpen;
      drawer.classList.toggle('open', _drawerOpen);
      toggleBtn.classList.toggle('active', _drawerOpen);
      if (_drawerOpen) renderDrawer();
    });
  }

  // ── Render drawer shell ────────────────────────────────────────────────────
  function renderDrawer() {
    const inner   = document.getElementById('music-drawer-inner');
    if (!inner) return;
    const project = (typeof EditorState !== 'undefined') ? EditorState.getProject() : null;
    const recs    = project?.musicRecommendations || [];
    _activeTab    = 'recommend';

    inner.innerHTML = `
      <div class="md-header">
        <span class="md-title">🎵 음악</span>
        <button class="md-close" id="md-close">✕</button>
      </div>
      <div class="md-tabs">
        <button class="md-tab active" data-tab="recommend">AI 추천${recs.length ? ` (${recs.length})` : ''}</button>
        <button class="md-tab" data-tab="youtube">유튜브</button>
        <button class="md-tab" data-tab="library">내 라이브러리</button>
      </div>
      <div class="md-search-row" id="md-search-row" style="display:none">
        <input id="md-search-input" class="md-search-input" type="text"
               placeholder="유튜브 음악 검색..." autocomplete="off">
        <button id="md-search-btn" class="btn btn-sm btn-primary">검색</button>
      </div>
      <div class="md-list" id="md-list">${buildRecHTML(recs)}</div>
    `;

    // Tab click
    inner.querySelectorAll('.md-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        inner.querySelectorAll('.md-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _activeTab = btn.dataset.tab;
        const searchRow = document.getElementById('md-search-row');
        searchRow.style.display = _activeTab === 'youtube' ? 'flex' : 'none';
        if (_activeTab === 'recommend') {
          document.getElementById('md-list').innerHTML = buildRecHTML(recs);
        } else if (_activeTab === 'youtube') {
          document.getElementById('md-list').innerHTML = '<p class="md-empty">검색어를 입력하세요.</p>';
        } else if (_activeTab === 'library') {
          loadLibrary();
        }
      });
    });

    // Search
    document.getElementById('md-search-btn').addEventListener('click', () => {
      doYTSearch(document.getElementById('md-search-input').value.trim());
    });
    document.getElementById('md-search-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') doYTSearch(e.target.value.trim());
    });
    document.getElementById('md-search-input').addEventListener('input', e => {
      clearTimeout(_searchTimeout);
      const q = e.target.value.trim();
      if (q.length > 1) _searchTimeout = setTimeout(() => doYTSearch(q), 700);
    });

    // Close button
    document.getElementById('md-close').addEventListener('click', () => {
      _drawerOpen = false;
      document.getElementById('music-drawer').classList.remove('open');
      document.getElementById('btn-toggle-music').classList.remove('active');
    });
  }

  // ── Mini YouTube Player ────────────────────────────────────────────────────
  let _miniPlayerVideoId = null;

  function extractVideoId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function openMiniPlayer(videoId, title) {
    if (_miniPlayerVideoId === videoId) return;
    _miniPlayerVideoId = videoId;

    let player = document.getElementById('yt-mini-player');
    if (!player) {
      player = document.createElement('div');
      player.id = 'yt-mini-player';
      document.body.appendChild(player);
    }

    player.innerHTML = `
      <div class="yt-mini-header">
        <span class="yt-mini-title">${esc(title)}</span>
        <button class="yt-mini-close" id="yt-mini-close">✕</button>
      </div>
      <div class="yt-mini-notice">* 변환 시 이 음악은 포함되지 않습니다</div>
      <iframe
        src="https://www.youtube.com/embed/${videoId}?autoplay=1&start=0"
        allow="autoplay; encrypted-media"
        allowfullscreen
        class="yt-mini-iframe"
        frameborder="0"
      ></iframe>
    `;
    player.classList.add('open');

    document.getElementById('yt-mini-close').addEventListener('click', () => {
      player.classList.remove('open');
      player.innerHTML = '';
      _miniPlayerVideoId = null;
    });
  }

  // ── AI Recommendations ─────────────────────────────────────────────────────
  function buildRecHTML(recs) {
    if (!recs.length) {
      return '<p class="md-empty">AI 추천 음악이 없습니다.<br>AI 쇼츠 분석 후 생성된 프로젝트에서 확인하세요.</p>';
    }
    return recs.map(m => {
      const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(m.searchQuery || m.title)}`;
      return `
        <div class="md-item">
          <div class="md-item-body">
            <div class="md-item-title">${esc(m.title)}</div>
            <div class="md-item-meta">${esc([m.genre, m.mood].filter(Boolean).join(' · '))}</div>
            ${m.source ? `<div class="md-item-source">${esc(m.source)}</div>` : ''}
          </div>
          <a href="${esc(ytUrl)}" target="_blank" rel="noopener" class="md-btn-yt">유튜브</a>
        </div>`;
    }).join('');
  }

  // ── YouTube Search ─────────────────────────────────────────────────────────
  async function doYTSearch(q) {
    if (!q) return;
    const list = document.getElementById('md-list');
    if (!list) return;
    list.innerHTML = '<p class="md-empty">검색 중...</p>';
    try {
      const res   = await fetch(`/api/ai/music-search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(await res.text());
      const items = await res.json();
      if (!items.length) { list.innerHTML = '<p class="md-empty">결과가 없습니다.</p>'; return; }
      const notice = '<p class="md-yt-notice">* 백그라운드 재생 전용 — 변환 시 음악은 포함되지 않습니다</p>';
      list.innerHTML = notice + items.map(item => {
        const vid = extractVideoId(item.url || '');
        return `
        <div class="md-item">
          ${item.thumbnail
            ? `<img src="${esc(item.thumbnail)}" class="md-thumb" alt="" loading="lazy">`
            : `<div class="md-thumb-ph">♪</div>`}
          <div class="md-item-body">
            <div class="md-item-title">${esc(item.title)}</div>
            <div class="md-item-meta">${esc(item.channel)}${item.duration ? ' · ' + esc(item.duration) : ''}</div>
          </div>
          ${vid ? `<button class="md-btn-play" data-vid="${esc(vid)}" data-title="${esc(item.title)}">▶</button>` : ''}
          <a href="${esc(item.url)}" target="_blank" rel="noopener" class="md-btn-yt">유튜브</a>
        </div>`;
      }).join('');

      list.querySelectorAll('.md-btn-play').forEach(btn => {
        btn.addEventListener('click', () => openMiniPlayer(btn.dataset.vid, btn.dataset.title));
      });
    } catch (err) {
      list.innerHTML = `<p class="md-empty" style="color:#e74c3c">검색 실패: ${esc(err.message)}</p>`;
    }
  }

  // ── Local Library ──────────────────────────────────────────────────────────
  async function loadLibrary() {
    const list = document.getElementById('md-list');
    if (!list) return;
    list.innerHTML = '<p class="md-empty">불러오는 중...</p>';
    try {
      const items = await fetch('/api/audio').then(r => r.json());
      renderLibrary(items);
    } catch (err) {
      list.innerHTML = `<p class="md-empty" style="color:#e74c3c">불러오기 실패</p>`;
    }
  }

  function renderLibrary(items) {
    const list = document.getElementById('md-list');
    if (!list) return;

    const uploadRow = `
      <div class="md-upload-row">
        <label class="btn btn-sm btn-secondary md-upload-label">
          + 파일 추가
          <input type="file" id="md-file-input" accept="audio/*,video/*" style="display:none" multiple>
        </label>
      </div>`;

    if (!items.length) {
      list.innerHTML = uploadRow + '<p class="md-empty">업로드된 파일이 없습니다.</p>';
    } else {
      list.innerHTML = uploadRow + items.map(item => `
        <div class="md-item" data-audio-id="${esc(item.id)}">
          <div class="md-lib-icon">♪</div>
          <div class="md-item-body">
            <div class="md-item-title">${esc(item.name)}</div>
            <div class="md-item-meta">${formatBytes(item.size)}</div>
          </div>
          <button class="md-btn-add" data-audio-id="${esc(item.id)}" title="타임라인에 추가">+</button>
          <button class="md-btn-del" data-audio-id="${esc(item.id)}" title="삭제">🗑</button>
        </div>`).join('');
    }

    // Upload handler
    document.getElementById('md-file-input')?.addEventListener('change', async e => {
      const files = Array.from(e.target.files);
      for (const file of files) {
        const fd = new FormData();
        fd.append('audio', file);
        await fetch('/api/audio/upload', { method: 'POST', body: fd });
      }
      e.target.value = '';
      await loadLibrary();
    });

    // Add to timeline
    list.querySelectorAll('.md-btn-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const audioId   = btn.dataset.audioId;
        const project   = EditorState.getProject();
        const startTime = EditorState.getCurrentTime?.() ?? 0;
        try {
          const clip = await fetch('/api/audio/add-to-project', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ projectId: project.id, audioId, startTime }),
          }).then(r => r.json());
          if (clip.error) throw new Error(clip.error);
          // Reload project state
          const updated = await fetch(`/api/projects/${project.id}`).then(r => r.json());
          EditorState.setProject(updated);
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = '+'; }, 1500);
        } catch (err) {
          alert('추가 실패: ' + err.message);
        }
      });
    });

    // Delete
    list.querySelectorAll('.md-btn-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('라이브러리에서 삭제할까요?')) return;
        await fetch(`/api/audio/${btn.dataset.audioId}`, { method: 'DELETE' });
        await loadLibrary();
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
