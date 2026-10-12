/* ==========================================================================
   HYPERTORRENT - CLIENT CONTROLLER & WEBSOCKET ENGINE
   ========================================================================== */

// State Management
const state = {
  torrents: [],
  globalStats: {
    downloadSpeed: 0,
    uploadSpeed: 0,
    ratio: 0,
    totalTorrents: 0
  },
  activeFilter: 'all',
  searchQuery: '',
  selectedHash: null,
  activeDrawerTab: 'overview',
  bandwidthHistory: {
    download: new Array(60).fill(0),
    upload: new Array(60).fill(0)
  },
  detailedTorrent: null,
  ws: null,
  wsConnected: false,
  token: localStorage.getItem('ht_token') || null,
  apiKey: localStorage.getItem('ht_api_key') || null,
  currentUser: null,
  authConfig: {
    isConfigured: false,
    authEnabled: true,
    requireLocalAuth: true
  }
};

// Global Authenticated Fetch Interceptor
const _originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
  const opts = { ...options };
  opts.credentials = 'include';
  opts.headers = opts.headers ? { ...opts.headers } : {};

  const token = state.token || localStorage.getItem('ht_token');
  if (token && !opts.headers['Authorization'] && !opts.headers['authorization']) {
    opts.headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await _originalFetch(url, opts);

  // If unauthorized on a protected /api/ route (excluding auth status/login)
  if (response.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    if (typeof showAuthModal === 'function') {
      showAuthModal(false, 'Authorization required. Please enter master password.');
    }
  }

  return response;
};

// Formatting Utilities
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + '/s';
}

function formatETA(ms) {
  if (!ms || ms === Infinity || isNaN(ms)) return '--';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatPercent(progress, status) {
  if (status === 'completed' || progress >= 1) return '100%';
  if (!progress || progress <= 0) return '0%';
  const p = progress * 100;
  if (p < 0.1) return `${p.toFixed(2)}%`;
  if (p < 100) return `${p.toFixed(1)}%`;
  return '100%';
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --------------------------------------------------------------------------
// Mobile Safe-Area & Body Scroll Locking Helpers
// --------------------------------------------------------------------------

let _openModalCount = 0;
let _savedScrollY = 0;

function lockBodyScroll() {
  _openModalCount++;
  if (_openModalCount === 1) {
    _savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add('modal-open');
    document.body.style.top = `-${_savedScrollY}px`;
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
  }
}

function unlockBodyScroll() {
  _openModalCount = Math.max(0, _openModalCount - 1);
  if (_openModalCount === 0) {
    document.body.classList.remove('modal-open');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, _savedScrollY);
  }
}

function resetMobileNavToDefault() {
  const navTorrents = document.getElementById('mob-nav-torrents');
  if (navTorrents) {
    document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));
    navTorrents.classList.add('active');
  }
}

const ALL_MODAL_IDS = [
  'modal-magnet',
  'modal-upload',
  'modal-search',
  'modal-stream',
  'modal-proxy',
  'modal-disk',
  'modal-turbo-downloader',
  'modal-auth',
  'modal-security',
  'modal-profile'
];

function openModal(modalOrId) {
  const m = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
  if (!m) return;
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  lockBodyScroll();
}

function closeModal(modalOrId) {
  const m = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
  if (!m || !m.classList.contains('open')) return;
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
  unlockBodyScroll();
  resetMobileNavToDefault();
  if (m.id === 'modal-stream' && typeof closeStreamModal === 'function') {
    const player = document.getElementById('stream-video-player');
    if (player) {
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
  }
}

function closeAllModals() {
  ALL_MODAL_IDS.forEach(id => {
    const m = document.getElementById(id);
    if (m && m.classList.contains('open')) {
      closeModal(m);
    }
  });
}

// --------------------------------------------------------------------------
// WebSocket Telemetry Connection
// --------------------------------------------------------------------------

let wsReconnectTimer = null;

function initWebSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  if (state.ws) {
    state.ws.onopen = null;
    state.ws.onmessage = null;
    state.ws.onclose = null;
    state.ws.onerror = null;
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = state.token || localStorage.getItem('ht_token') || '';
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  const wsUrl = `${protocol}//${window.location.host}/ws${tokenQuery}`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    state.wsConnected = true;
    updateStatusIndicator(true);
    if (state.selectedHash) {
      subscribeTorrentDetails(state.selectedHash);
    }
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'tick') {
        state.globalStats = data.stats;
        state.torrents = data.torrents;
        updateGlobalTelemetry();
        renderTorrentsList();
        recordBandwidthHistory(data.stats.downloadSpeed, data.stats.uploadSpeed);
      } else if (data.type === 'torrent_details') {
        state.detailedTorrent = data.details;
        if (state.selectedHash === data.details.infoHash) {
          renderDrawerDetails(data.details);
        }
      }
    } catch (e) {
      console.error('WS Parse Error:', e);
    }
  };

  state.ws.onclose = (event) => {
    state.wsConnected = false;
    updateStatusIndicator(false);
    if (event && (event.code === 1008 || event.code === 4001)) {
      if (typeof showAuthModal === 'function') {
        showAuthModal(false, 'Unauthorized. Please authenticate.');
      }
      return;
    }
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(initWebSocket, 2000); // Auto reconnect
  };

  state.ws.onerror = () => {
    try { state.ws.close(); } catch (e) {}
  };
}

function subscribeTorrentDetails(infoHash) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'subscribe_details',
      infoHash: infoHash
    }));
  }
}

function unsubscribeTorrentDetails() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'unsubscribe_details' }));
  }
}

function updateStatusIndicator(online) {
  const indicator = document.getElementById('status-indicator');
  const text = document.getElementById('daemon-status-text');
  if (online) {
    indicator.className = 'pulse-indicator online';
    text.textContent = 'ENGINE ONLINE';
  } else {
    indicator.className = 'pulse-indicator offline';
    indicator.style.backgroundColor = '#ef4444';
    indicator.style.boxShadow = '0 0 10px #ef4444';
    text.textContent = 'RECONNECTING...';
  }
}

// --------------------------------------------------------------------------
// Telemetry & Bandwidth Sparkline Graph
// --------------------------------------------------------------------------

function updateGlobalTelemetry() {
  document.getElementById('global-down-speed').textContent = formatSpeed(state.globalStats.downloadSpeed);
  document.getElementById('global-up-speed').textContent = formatSpeed(state.globalStats.uploadSpeed);
  document.getElementById('global-ratio').textContent = (state.globalStats.ratio || 0).toFixed(2);
  document.getElementById('global-active-count').textContent = state.torrents.length;

  // Update counts on filter tabs
  const downloadingCount = state.torrents.filter(t => t.status === 'downloading').length;
  const queuedCount = state.torrents.filter(t => t.status === 'queued').length;
  const completedCount = state.torrents.filter(t => t.status === 'completed').length;
  const pausedCount = state.torrents.filter(t => t.status === 'paused').length;

  document.getElementById('count-all').textContent = state.torrents.length;
  document.getElementById('count-downloading').textContent = downloadingCount;
  const countQueuedEl = document.getElementById('count-queued');
  if (countQueuedEl) countQueuedEl.textContent = queuedCount;
  document.getElementById('count-completed').textContent = completedCount;
  document.getElementById('count-paused').textContent = pausedCount;

  // Update live trackers count
  const trackersCountEl = document.getElementById('global-trackers-count');
  if (trackersCountEl) {
    trackersCountEl.textContent = `${state.globalStats.cachedTrackersCount || 0} LIVE`;
  }

  // Update header proxy button active indicator
  const proxyBtn = document.getElementById('btn-open-proxy-modal');
  if (proxyBtn && state.globalStats && state.globalStats.proxy) {
    proxyBtn.classList.toggle('proxy-active', !!state.globalStats.proxy.enabled);
  }

  // Update live SSD storage gauge widget (Admin Only)
  if (state.globalStats && state.globalStats.disk) {
    const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
    if (isAdmin) {
      updateHeaderDiskGauge(state.globalStats.disk);
    }
  }
}

function updateHeaderDiskGauge(disk) {
  const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
  const headerCard = document.getElementById('btn-open-disk-modal');
  if (!isAdmin) {
    if (headerCard) {
      headerCard.classList.add('admin-only-hidden');
      headerCard.style.setProperty('display', 'none', 'important');
    }
    return;
  }
  if (!disk || !disk.total) return;
  if (headerCard) {
    headerCard.classList.remove('admin-only-hidden');
    headerCard.style.removeProperty('display');
    headerCard.style.display = 'flex';
  }
  const percent = disk.percent !== undefined ? disk.percent : 0;
  const badge = document.getElementById('header-disk-badge');
  const bar = document.getElementById('header-disk-bar');
  const text = document.getElementById('header-disk-text');
  const percentEl = document.getElementById('header-disk-percent');

  if (bar) bar.style.width = `${percent}%`;
  if (text) text.textContent = `${formatBytes(disk.free)} Free`;
  if (percentEl) percentEl.textContent = `${percent}%`;

  if (headerCard && badge) {
    headerCard.classList.remove('warning', 'critical');
    badge.className = 'disk-badge-pill';

    if (percent >= 90) {
      headerCard.classList.add('critical');
      badge.classList.add('crit');
      badge.textContent = 'CRITICAL';
    } else if (percent >= 80) {
      headerCard.classList.add('warning');
      badge.classList.add('warn');
      badge.textContent = 'WARN';
    } else {
      badge.classList.add('ok');
      badge.textContent = 'NORMAL';
    }
  }
}

function recordBandwidthHistory(down, up) {
  state.bandwidthHistory.download.shift();
  state.bandwidthHistory.download.push(down || 0);

  state.bandwidthHistory.upload.shift();
  state.bandwidthHistory.upload.push(up || 0);

  drawBandwidthGraph();
}

function drawBandwidthGraph() {
  const canvas = document.getElementById('bandwidth-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);

  // Determine max scale (minimum 50 KB/s so small traffic has scale)
  const maxDown = Math.max(...state.bandwidthHistory.download, 1024 * 50);
  const maxUp = Math.max(...state.bandwidthHistory.upload, 1024 * 50);
  const maxVal = Math.max(maxDown, maxUp) * 1.15;

  // Draw Grid Lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let y = 0; y <= height; y += height / 3) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Draw Series Function
  function drawLine(history, strokeColor, fillColor) {
    const step = width / (history.length - 1);
    ctx.beginPath();
    ctx.moveTo(0, height);

    for (let i = 0; i < history.length; i++) {
      const x = i * step;
      const y = height - (history[i] / maxVal) * (height - 10);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill under curve
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  // Draw Download Series (Cyan)
  const cyanGrad = ctx.createLinearGradient(0, 0, 0, height);
  cyanGrad.addColorStop(0, 'rgba(0, 242, 254, 0.25)');
  cyanGrad.addColorStop(1, 'rgba(0, 242, 254, 0.0)');
  drawLine(state.bandwidthHistory.download, '#00f2fe', cyanGrad);

  // Draw Upload Series (Violet)
  const violetGrad = ctx.createLinearGradient(0, 0, 0, height);
  violetGrad.addColorStop(0, 'rgba(138, 43, 226, 0.2)');
  violetGrad.addColorStop(1, 'rgba(138, 43, 226, 0.0)');
  drawLine(state.bandwidthHistory.upload, '#8a2be2', violetGrad);
}

// --------------------------------------------------------------------------
// Torrents List Rendering
// --------------------------------------------------------------------------

function renderTorrentsList() {
  const container = document.getElementById('torrents-grid');
  const emptyState = document.getElementById('empty-state');

  // Filter torrents
  let filtered = state.torrents;
  if (state.activeFilter !== 'all') {
    filtered = filtered.filter(t => t.status === state.activeFilter);
  }

  // Search filter
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(t => 
      (t.name && t.name.toLowerCase().includes(q)) || 
      (t.infoHash && t.infoHash.toLowerCase().includes(q))
    );
  }

  if (filtered.length === 0) {
    emptyState.style.display = 'flex';
    container.innerHTML = '';
    return;
  }

  emptyState.style.display = 'none';

  // In-place reconciliation: update cards smoothly without destroying DOM or dropping touch taps
  const existingCards = container.querySelectorAll('.torrent-card');
  if (existingCards.length === filtered.length) {
    let canUpdateInPlace = true;
    for (let i = 0; i < filtered.length; i++) {
      const card = existingCards[i];
      const t = filtered[i];
      if (card.dataset.hash !== t.infoHash ||
          card.dataset.status !== t.status ||
          card.dataset.boosted !== String(!!t.boosted) ||
          card.dataset.seq !== String(!!t.sequential)) {
        canUpdateInPlace = false;
        break;
      }
    }

    if (canUpdateInPlace) {
      for (let i = 0; i < filtered.length; i++) {
        const card = existingCards[i];
        const t = filtered[i];
        const isSelected = state.selectedHash === t.infoHash;
        const isCompleted = t.status === 'completed';
        const isPaused = t.status === 'paused';
        const isQueued = t.status === 'queued';

        const rawPercent = Math.min(100, Math.max(0, (t.progress || 0) * 100));
        const percentText = formatPercent(t.progress, t.status);
        const fillWidth = isCompleted ? 100 : (t.downloaded > 0 && rawPercent < 0.5 ? 0.5 : rawPercent);

        card.classList.toggle('selected', isSelected);

        const progressFill = card.querySelector('.progress-fill');
        if (progressFill) {
          progressFill.className = `progress-fill ${isCompleted ? 'completed' : (isPaused ? 'paused' : (isQueued ? 'queued' : ''))}`;
          progressFill.style.width = `${fillWidth.toFixed(2)}%`;
        }

        const percentEl = card.querySelector('.progress-percentage');
        if (percentEl) percentEl.textContent = percentText;

        const bytesEl = card.querySelector('.progress-bytes');
        if (bytesEl) bytesEl.textContent = `${formatBytes(t.downloaded)} of ${formatBytes(t.length)}`;

        const rateDownEl = card.querySelector('.rate-down strong');
        if (rateDownEl) rateDownEl.textContent = formatSpeed(t.downloadSpeed);

        const rateUpEl = card.querySelector('.rate-up strong');
        if (rateUpEl) rateUpEl.textContent = formatSpeed(t.uploadSpeed);

        const peersEl = card.querySelector('.metric-peers strong');
        if (peersEl) peersEl.textContent = t.numPeers;

        const etaEl = card.querySelector('.metric-eta strong');
        if (etaEl) etaEl.textContent = formatETA(t.timeRemaining);

        const ratioEl = card.querySelector('.metric-ratio strong');
        if (ratioEl) ratioEl.textContent = (t.ratio || 0).toFixed(2);
      }
      return;
    }
  }

  // Render cards
  container.innerHTML = filtered.map(t => {
    const isSelected = state.selectedHash === t.infoHash;
    const isPaused = t.status === 'paused';
    const isQueued = t.status === 'queued';
    const isCompleted = t.status === 'completed';

    const rawPercent = Math.min(100, Math.max(0, (t.progress || 0) * 100));
    const percentText = formatPercent(t.progress, t.status);
    const fillWidth = isCompleted ? 100 : (t.downloaded > 0 && rawPercent < 0.5 ? 0.5 : rawPercent);

    return `
      <div class="torrent-card ${isSelected ? 'selected' : ''}" data-hash="${t.infoHash}" data-status="${t.status}" data-boosted="${!!t.boosted}" data-seq="${!!t.sequential}">
        <div class="card-top-row">
          <div class="card-name-group">
            <span class="torrent-status-pill ${t.status}">${t.status}</span>
            ${t.boosted ? `<span class="torrent-status-pill turbo" title="⚡ Turbo Boost active: 90+ live community trackers injected">⚡ TURBO</span>` : ''}
            <h3 class="card-title">${escapeHtml(t.name)}</h3>
          </div>
          <div class="card-controls">
            <button class="btn-icon boost-btn ${t.boosted ? 'boosted' : ''}" data-hash="${t.infoHash}" title="${t.boosted ? '⚡ Turbo Active (Click to Re-Boost)' : '⚡ Turbo Boost (Inject live trackers & discover more peers)'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
            </button>
            ${isPaused 
              ? `<button class="btn-icon resume-btn" data-hash="${t.infoHash}" title="Resume"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></button>`
              : `<button class="btn-icon pause-btn" data-hash="${t.infoHash}" title="Pause"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg></button>`
            }
            <button class="btn-icon seq-btn ${t.sequential ? 'active' : ''}" data-hash="${t.infoHash}" title="${t.sequential ? 'Sequential Mode ON' : 'Toggle Sequential Streaming Mode'}" style="${t.sequential ? 'color: var(--cyan-400); border-color: var(--cyan-400);' : ''}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>
            </button>
            ${t.mainFile ? `
              <button class="btn-icon btn-turbo-download" data-hash="${t.infoHash}" data-index="${t.mainFile.index}" data-name="${escapeHtml(t.mainFile.name)}" data-length="${t.mainFile.length}" title="⚡ Turbo Download (${escapeHtml(t.mainFile.name)}) - Multi-Stream IDM High-Speed Engine">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
              </button>
              <a href="/api/download/${encodeURIComponent(t.infoHash)}/${t.mainFile.index}" class="btn-icon direct-download-btn" title="⚡ Direct ${t.mainFile.isVideo ? 'Movie' : 'File'} Download (${escapeHtml(t.mainFile.name)}) - Resumable & Recommended for iPhone/Mobile" download>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              </a>
            ` : ''}
            <a href="/api/download/${encodeURIComponent(t.infoHash)}/zip" class="btn-icon zip-download-btn" title="Stream Download All as ZIP (.zip on-the-fly directly to your PC) - Keep screen unlocked on iOS" download>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            </a>
            <button class="btn-icon danger delete-btn" data-hash="${t.infoHash}" title="Delete Torrent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </div>

        <div class="progress-container">
          <div class="progress-track">
            <div class="progress-fill ${isCompleted ? 'completed' : (isPaused ? 'paused' : (isQueued ? 'queued' : ''))}" style="width: ${fillWidth.toFixed(2)}%;"></div>
          </div>
          <div class="progress-info-row">
            <span class="progress-percentage font-mono">${percentText}</span>
            <span class="font-mono progress-bytes">${formatBytes(t.downloaded)} of ${formatBytes(t.length)}</span>
          </div>
        </div>

        <div class="card-metrics-row font-mono">
          <div class="metric-item rate-down">
            <span>↓</span> <strong>${formatSpeed(t.downloadSpeed)}</strong>
          </div>
          <div class="metric-item rate-up">
            <span>↑</span> <strong>${formatSpeed(t.uploadSpeed)}</strong>
          </div>
          <div class="metric-item metric-peers">
            <span>Peers:</span> <strong>${t.numPeers}</strong>
          </div>
          <div class="metric-item metric-eta">
            <span>ETA:</span> <strong>${formatETA(t.timeRemaining)}</strong>
          </div>
          <div class="metric-item metric-ratio">
            <span>Ratio:</span> <strong>${(t.ratio || 0).toFixed(2)}</strong>
          </div>
        </div>
      </div>
    `;
  }).join('');

  bindTorrentCardEvents();
}

function bindTorrentCardEvents() {
  // Inspect / Select Card
  document.querySelectorAll('.torrent-card').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pause-btn') || e.target.closest('.resume-btn') || 
          e.target.closest('.delete-btn') || e.target.closest('.seq-btn') || 
          e.target.closest('.boost-btn') || e.target.closest('.zip-download-btn') ||
          e.target.closest('.direct-download-btn') || e.target.closest('.btn-turbo-download')) {
        return; // Don't trigger inspect when clicking other controls
      }
      const hash = el.dataset.hash || el.closest('.torrent-card').dataset.hash;
      openDetailDrawer(hash);
    });
  });

  // ⚡ Turbo Download (Multi-Stream IDM Engine) Button
  document.querySelectorAll('.btn-turbo-download').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      const index = parseInt(btn.dataset.index, 10);
      const name = btn.dataset.name;
      const length = parseInt(btn.dataset.length, 10);
      openTurboModal(hash, index, name, length);
    });
  });

  // Download Action Mobile Tips & Feedback
  document.querySelectorAll('.zip-download-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showToast('📦 Starting ZIP download. (Tip: Keep screen unlocked on iOS Safari during ZIP downloads)', 'info');
    });
  });

  document.querySelectorAll('.direct-download-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showToast('⚡ Starting Direct Resumable Download. Works seamlessly on iPhone & Mobile!', 'success');
    });
  });

  // Turbo Boost Button
  document.querySelectorAll('.boost-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      btn.classList.add('spinning');
      try {
        const res = await fetch(`/api/torrents/${encodeURIComponent(hash)}/boost`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(`⚡ Turbo Boost active! Injected ${data.newTrackersAdded} live trackers (${data.totalTrackers} active). DHT re-announced.`, 'success');
        } else {
          showToast('Turbo Boost error: ' + (data.error || 'Failed'), 'error');
        }
      } catch (err) {
        showToast('Boost error: ' + err.message, 'error');
      } finally {
        btn.classList.remove('spinning');
      }
    });
  });

  // Pause Button
  document.querySelectorAll('.pause-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      try {
        // Immediate optimistic UI response
        const t = state.torrents.find(x => x.infoHash === hash);
        if (t) {
          t.status = 'paused';
          t.paused = true;
          t.downloadSpeed = 0;
          t.uploadSpeed = 0;
          renderTorrentsList();
        }
        await fetch(`/api/torrents/${encodeURIComponent(hash)}/pause`, { method: 'POST' });
        showToast('Torrent paused', 'info');
      } catch (err) {
        showToast('Failed to pause: ' + err.message, 'error');
      }
    });
  });

  // Resume Button
  document.querySelectorAll('.resume-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      try {
        // Immediate optimistic UI response
        const t = state.torrents.find(x => x.infoHash === hash);
        if (t) {
          t.status = 'downloading';
          t.paused = false;
          renderTorrentsList();
        }
        await fetch(`/api/torrents/${encodeURIComponent(hash)}/resume`, { method: 'POST' });
        showToast('Torrent resumed', 'success');
      } catch (err) {
        showToast('Failed to resume: ' + err.message, 'error');
      }
    });
  });

  // Sequential Mode Toggle
  document.querySelectorAll('.seq-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      try {
        const res = await fetch(`/api/torrents/${hash}/sequential`, { method: 'POST' });
        const data = await res.json();
        showToast(`Sequential mode ${data.sequential ? 'Enabled' : 'Disabled'}`, 'info');
      } catch (err) {
        showToast('Failed to toggle mode: ' + err.message, 'error');
      }
    });
  });

  // Delete Button
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      if (confirm('Are you sure you want to remove this torrent? Click OK to remove.')) {
        const deleteData = confirm('Do you also want to delete the downloaded files from disk?');
        try {
          await fetch(`/api/torrents/${hash}?deleteFiles=${deleteData}`, { method: 'DELETE' });
          showToast('Torrent removed', 'info');
          if (state.selectedHash === hash) {
            closeDetailDrawer();
          }
        } catch (err) {
          showToast('Failed to delete: ' + err.message, 'error');
        }
      }
    });
  });
}

// --------------------------------------------------------------------------
// Slide-Over Detail Inspector Drawer
// --------------------------------------------------------------------------

function openDetailDrawer(infoHash) {
  state.selectedHash = infoHash;
  const drawer = document.getElementById('detail-drawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');

  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) {
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');
  }

  lockBodyScroll();

  // 1. Immediately populate whatever summary data we already have
  const cached = state.torrents.find(t => t.infoHash === infoHash);
  if (cached) {
    renderDrawerDetails(cached);
  }

  // 2. Fetch full deep details (files, peers, piece bitfield, trackers) via REST immediately
  fetch(`/api/torrents/${encodeURIComponent(infoHash)}`)
    .then(res => res.json())
    .then(details => {
      if (details && state.selectedHash === infoHash) {
        state.detailedTorrent = details;
        renderDrawerDetails(details);
      }
    })
    .catch(err => console.warn('Failed to fetch details:', err));

  // 3. Keep live WebSocket subscription for continuous updates
  subscribeTorrentDetails(infoHash);
  renderTorrentsList(); // Update selected card highlight
}

function closeDetailDrawer() {
  const drawer = document.getElementById('detail-drawer');
  if (drawer && drawer.classList.contains('open')) {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
    resetMobileNavToDefault();
  }

  state.selectedHash = null;

  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) {
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
  }

  unsubscribeTorrentDetails();
  renderTorrentsList();
}

function setupDrawerTouchDismiss() {
  const drawer = document.getElementById('detail-drawer');
  if (!drawer) return;

  let touchStartX = 0;
  let touchStartY = 0;
  let isSwiping = false;

  drawer.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    isSwiping = false;
  }, { passive: true });

  drawer.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - touchStartX;
    const diffY = Math.abs(currentY - touchStartY);

    // If swipe is primarily horizontal and towards right (> 30px)
    if (diffX > 30 && diffX > diffY) {
      isSwiping = true;
    }
  }, { passive: true });

  drawer.addEventListener('touchend', (e) => {
    if (!isSwiping) return;
    const touchEndX = e.changedTouches[0].clientX;
    const diffX = touchEndX - touchStartX;
    // If swiped right by more than 75px, close the drawer
    if (diffX > 75) {
      closeDetailDrawer();
    }
    isSwiping = false;
  }, { passive: true });
}

function renderDrawerDetails(details) {
  if (!details) return;

  // Header
  document.getElementById('drawer-torrent-title').textContent = details.name;
  document.getElementById('drawer-torrent-hash').textContent = `HASH: ${details.infoHash}`;
  const badge = document.getElementById('drawer-status-badge');
  badge.textContent = details.status.toUpperCase();
  badge.className = `drawer-badge ${details.status}`;

  // Update Drawer Pause / Resume Toggle Button
  const drawerPauseBtn = document.getElementById('btn-drawer-pause-toggle');
  const drawerPauseText = document.getElementById('btn-drawer-pause-text');
  const drawerPauseIcon = document.getElementById('drawer-pause-icon');
  const isPaused = details.paused || details.status === 'paused';
  if (drawerPauseBtn && drawerPauseText && drawerPauseIcon) {
    if (isPaused) {
      drawerPauseText.textContent = 'Resume';
      drawerPauseBtn.title = 'Resume downloading';
      drawerPauseIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
      drawerPauseBtn.className = 'btn btn-primary btn-sm';
    } else {
      drawerPauseText.textContent = 'Pause';
      drawerPauseBtn.title = 'Pause downloading';
      drawerPauseIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
      drawerPauseBtn.className = 'btn btn-secondary btn-sm';
    }
  }

  // Update Drawer Turbo Boost Button State
  const drawerBoostBtn = document.getElementById('btn-drawer-boost');
  const drawerBoostText = document.getElementById('btn-drawer-boost-text');
  if (drawerBoostBtn) {
    if (details.boosted) {
      drawerBoostBtn.classList.add('btn-turbo-active');
      if (drawerBoostText) drawerBoostText.textContent = '⚡ Turbo Active';
      drawerBoostBtn.title = '⚡ Torrent is Turbo-Charged! Click to force fresh tracker re-announce.';
    } else {
      drawerBoostBtn.classList.remove('btn-turbo-active');
      if (drawerBoostText) drawerBoostText.textContent = 'Turbo Boost';
      drawerBoostBtn.title = '⚡ Turbo Boost this torrent (Inject live community trackers & force swarm re-announce)';
    }
  }

  // Overview Tab
  document.getElementById('ov-downloaded').textContent = `${formatBytes(details.downloaded)} / ${formatBytes(details.length)}`;
  document.getElementById('ov-rates').textContent = `↓ ${formatSpeed(details.downloadSpeed)} | ↑ ${formatSpeed(details.uploadSpeed)}`;
  document.getElementById('ov-eta').textContent = formatETA(details.timeRemaining);
  document.getElementById('ov-pieces').textContent = `${details.numPieces} pieces × ${formatBytes(details.pieceLength)}`;

  const trackersList = document.getElementById('ov-trackers-list');
  const trackersCount = document.getElementById('ov-trackers-count');
  if (details.trackers && details.trackers.length > 0) {
    if (trackersCount) trackersCount.textContent = details.trackers.length;
    trackersList.innerHTML = details.trackers.map(tr => `<li>${escapeHtml(tr)}</li>`).join('');
  } else {
    if (trackersCount) trackersCount.textContent = '1';
    trackersList.innerHTML = `<li>DHT (Distributed Hash Table) & Peer Exchange</li>`;
  }

  // Piece Matrix Canvas
  renderPieceMatrix(details.pieces);

  // Peers Tab
  document.getElementById('drawer-peer-count').textContent = details.peers ? details.peers.length : 0;

  // Swarm Optimizer Banner Status Text
  const optimizerStatusEl = document.getElementById('optimizer-status-text');
  if (optimizerStatusEl) {
    const stats = details.optimizerStats || (state.globalStats && state.globalStats.optimizer);
    if (stats && stats.totalEvicted > 0) {
      optimizerStatusEl.textContent = `Autonomous scoring active • ${stats.totalEvicted} stalled/choked peers evicted • Swarm tuned for peak bandwidth`;
    } else {
      optimizerStatusEl.textContent = `Continuous peer scoring & choke eviction active • Swarm evaluated every 15s`;
    }
  }

  const peersBody = document.getElementById('peers-table-body');
  if (details.peers && details.peers.length > 0) {
    // Sort peers: fastest download speed & highest quality score first
    const sortedPeers = [...details.peers].sort((a, b) => {
      if ((b.downloadSpeed || 0) !== (a.downloadSpeed || 0)) {
        return (b.downloadSpeed || 0) - (a.downloadSpeed || 0);
      }
      return (b.qualityScore || 0) - (a.qualityScore || 0);
    });

    peersBody.innerHTML = sortedPeers.map(p => {
      const score = p.qualityScore !== undefined ? p.qualityScore : 50;
      let scoreBadgeClass = 'peer-score-fair';
      if (score >= 80) scoreBadgeClass = 'peer-score-elite';
      else if (score >= 50) scoreBadgeClass = 'peer-score-good';
      else if (score < 25) scoreBadgeClass = 'peer-score-stalled';

      return `
      <tr>
        <td class="font-mono">${escapeHtml(p.ip)}:${p.port}</td>
        <td>${escapeHtml(p.client || 'BitTorrent')}</td>
        <td>
          <div class="peer-score-cell">
            <span class="peer-score-pill ${scoreBadgeClass}">${score}%</span>
            <span class="peer-score-label">${escapeHtml(p.healthLabel || 'Active Partner')}</span>
          </div>
        </td>
        <td class="font-mono" style="color: var(--cyan-400);">${formatSpeed(p.downloadSpeed)}</td>
        <td class="font-mono" style="color: var(--violet-500);">${formatSpeed(p.uploadSpeed)}</td>
        <td class="font-mono">${formatBytes(p.downloaded)}</td>
        <td><span class="badge" style="background: ${p.choked ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)'}; color: ${p.choked ? '#ef4444' : '#10b981'};">${p.choked ? 'Choked' : 'Unchoked'}</span></td>
      </tr>
    `}).join('');
  } else {
    peersBody.innerHTML = `<tr><td colspan="7" class="text-center">Searching swarm for peers...</td></tr>`;
  }

  // Files Tab
  const totalFilesCount = details.files ? details.files.length : (details.filesCount || 0);
  document.getElementById('drawer-file-count').textContent = totalFilesCount;
  
  // Update "Download All as ZIP" action in Files tab
  const btnZip = document.getElementById('btn-download-all-zip');
  const filesSummary = document.getElementById('files-summary-text');
  if (btnZip) {
    btnZip.href = `/api/download/${encodeURIComponent(details.infoHash)}/zip`;
    btnZip.title = `Stream all ${totalFilesCount} files as an on-the-fly .zip directly to your PC`;
  }
  if (filesSummary) {
    filesSummary.textContent = `${totalFilesCount} files (${formatBytes(details.length)})`;
  }

  const filesContainer = document.getElementById('files-list-container');
  if (details.files && details.files.length > 0) {
    filesContainer.innerHTML = details.files.map(f => {
      const isMedia = /\.(mp4|mkv|avi|mov|webm|mp3|flac|wav|m4a)$/i.test(f.name);
      return `
        <div class="file-row">
          <div class="file-main-info">
            <input type="checkbox" class="file-select-checkbox" data-hash="${details.infoHash}" data-index="${f.index}" ${f.selected ? 'checked' : ''}>
            <div class="file-text-col">
              <div class="file-name">${escapeHtml(f.name)}</div>
              <div class="file-size font-mono">${formatBytes(f.length)}</div>
            </div>
          </div>
          <div class="file-actions-row" style="display: flex; align-items: center; gap: 0.5rem;">
            ${isMedia ? `
              <button class="btn btn-secondary stream-file-btn" data-hash="${details.infoHash}" data-index="${f.index}" data-name="${escapeHtml(f.name)}" data-size="${formatBytes(f.length)}" style="padding: 0.35rem 0.65rem; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 0.35rem;">
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" style="width: 12px; height: 12px;">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span>Stream</span>
              </button>
            ` : ''}
            <button class="btn btn-secondary turbo-file-btn" data-hash="${details.infoHash}" data-index="${f.index}" data-name="${escapeHtml(f.name)}" data-length="${f.length}" style="padding: 0.35rem 0.65rem; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 0.35rem;" title="⚡ Turbo Download (Multi-Stream IDM Engine)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
              <span>Turbo</span>
            </button>
            <a href="/api/download/${encodeURIComponent(details.infoHash)}/${f.index}" class="btn btn-primary file-download-btn" style="padding: 0.35rem 0.65rem; font-size: 0.75rem; text-decoration: none; display: inline-flex; align-items: center; gap: 0.35rem;" title="Direct Resumable HTTPS Download (Best for iPhone/Mobile & PC Seedbox mode)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Download</span>
            </a>
          </div>
        </div>
      `;
    }).join('');

    bindFilesTabEvents();
  }
}

function bindFilesTabEvents() {
  // Checkbox toggle
  document.querySelectorAll('.file-select-checkbox').forEach(chk => {
    chk.addEventListener('change', async (e) => {
      const hash = chk.dataset.hash;
      const index = chk.dataset.index;
      const selected = chk.checked;
      try {
        await fetch(`/api/torrents/${hash}/files/${index}/priority`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selected })
        });
      } catch (err) {
        showToast('Failed to update file selection', 'error');
      }
    });
  });

  // Stream Button
  document.querySelectorAll('.stream-file-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      const index = btn.dataset.index;
      const name = btn.dataset.name;
      const size = btn.dataset.size;
      openStreamModal(hash, index, name, size);
    });
  });

  // ⚡ Turbo File Download Button
  document.querySelectorAll('.turbo-file-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      const index = parseInt(btn.dataset.index, 10);
      const name = btn.dataset.name;
      const length = parseInt(btn.dataset.length, 10);
      openTurboModal(hash, index, name, length);
    });
  });
}

// --------------------------------------------------------------------------
// Real-Time Piece Matrix Canvas
// --------------------------------------------------------------------------

function renderPieceMatrix(pieces) {
  const canvas = document.getElementById('pieces-canvas');
  if (!canvas || !pieces || pieces.length === 0) return;

  const ctx = canvas.getContext('2d');
  const count = pieces.length;
  const verifiedCount = pieces.filter(p => p === 1).length;

  document.getElementById('piece-stat-counts').textContent = `${verifiedCount} / ${count} (${Math.floor((verifiedCount / count) * 100)}%)`;

  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);

  // Calculate grid layout
  const cols = Math.ceil(Math.sqrt(count * (width / height)));
  const rows = Math.ceil(count / cols);
  const cellW = width / cols;
  const cellH = height / rows;

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = row * cellH;

    if (pieces[i] === 1) {
      ctx.fillStyle = '#10b981'; // Verified piece
    } else {
      ctx.fillStyle = '#172235'; // Pending piece
    }

    ctx.fillRect(x + 0.5, y + 0.5, Math.max(1, cellW - 1), Math.max(1, cellH - 1));
  }

  // Hover & Touch inspection detection for mobile and desktop
  const inspectPieceAt = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = (clientX - rect.left) * (canvas.width / rect.width);
    const mouseY = (clientY - rect.top) * (canvas.height / rect.height);

    const col = Math.floor(mouseX / cellW);
    const row = Math.floor(mouseY / cellH);
    const index = row * cols + col;

    const tip = document.getElementById('piece-hover-tip');
    if (tip && index >= 0 && index < count) {
      const isDownloaded = pieces[index] === 1;
      tip.textContent = `Piece #${index}: ${isDownloaded ? 'Complete (Verified)' : 'Pending / Missing'}`;
    }
  };

  canvas.onmousemove = (e) => inspectPieceAt(e.clientX, e.clientY);
  canvas.ontouchstart = (e) => {
    if (e.touches && e.touches[0]) inspectPieceAt(e.touches[0].clientX, e.touches[0].clientY);
  };
  canvas.ontouchmove = (e) => {
    if (e.touches && e.touches[0]) inspectPieceAt(e.touches[0].clientX, e.touches[0].clientY);
  };
}

// --------------------------------------------------------------------------
// Media Streamer Modal
// --------------------------------------------------------------------------

function openStreamModal(hash, fileIndex, fileName, fileSize) {
  const modal = document.getElementById('modal-stream');
  const player = document.getElementById('stream-video-player');
  document.getElementById('stream-file-title').textContent = fileName;
  document.getElementById('stream-file-size').textContent = fileSize;

  const streamUrl = `/api/stream/${hash}/${fileIndex}`;
  player.src = streamUrl;
  player.load();
  player.play().catch(() => {
    // Autoplay prevented, user can click play
  });

  openModal(modal);
}

function closeStreamModal() {
  const modal = document.getElementById('modal-stream');
  const player = document.getElementById('stream-video-player');
  if (player) {
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  closeModal(modal);
}

// --------------------------------------------------------------------------
// Add Magnet & Upload Modals
// --------------------------------------------------------------------------

function setupModals() {
  // Magnet Modal
  const magnetModal = document.getElementById('modal-magnet');
  const magnetInput = document.getElementById('magnet-input');

  document.getElementById('btn-open-magnet-modal').onclick = () => {
    openModal(magnetModal);
    setTimeout(() => magnetInput.focus(), 100);
  };
  document.getElementById('btn-empty-add-magnet').onclick = () => {
    openModal(magnetModal);
    setTimeout(() => magnetInput.focus(), 100);
  };
  document.getElementById('btn-close-magnet-modal').onclick = () => closeModal(magnetModal);
  document.getElementById('btn-cancel-magnet').onclick = () => closeModal(magnetModal);

  // Sample Chips
  document.getElementById('chip-ubuntu').onclick = () => {
    magnetInput.value = 'magnet:?xt=urn:btih:3e7bfb7b3096d117eecbcfa689e4726d40026a0b&dn=ubuntu-24.04-desktop-amd64.iso';
  };
  document.getElementById('chip-bigbuck').onclick = () => {
    magnetInput.value = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny';
  };
  document.getElementById('chip-sintel').onclick = () => {
    magnetInput.value = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel';
  };
  document.getElementById('btn-empty-demo-torrent').onclick = () => {
    openModal(magnetModal);
    magnetInput.value = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel';
  };

  // Submit Magnet
  document.getElementById('btn-submit-magnet').onclick = async () => {
    const val = magnetInput.value.trim();
    if (!val) {
      showToast('Please paste a valid magnet link', 'error');
      return;
    }

    try {
      const res = await fetch('/api/torrents/magnet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnetURI: val })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add magnet');
      
      showToast('Torrent added to swarm!', 'success');
      magnetInput.value = '';
      closeModal(magnetModal);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Upload .torrent Modal
  const uploadModal = document.getElementById('modal-upload');
  const fileInput = document.getElementById('torrent-file-input');
  const dropZone = document.getElementById('torrent-drop-zone');
  const submitUploadBtn = document.getElementById('btn-submit-upload');
  const selectedFileInfo = document.getElementById('selected-file-info');
  const selectedFileName = document.getElementById('selected-file-name');
  let currentFile = null;

  document.getElementById('btn-open-upload-modal').onclick = () => openModal(uploadModal);
  document.getElementById('btn-close-upload-modal').onclick = () => closeModal(uploadModal);
  document.getElementById('btn-cancel-upload').onclick = () => closeModal(uploadModal);

  dropZone.onclick = (e) => {
    if (e.target.id !== 'btn-clear-file') {
      fileInput.click();
    }
  };

  fileInput.onchange = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  };

  dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  };

  dropZone.ondragleave = () => {
    dropZone.classList.remove('dragover');
  };

  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  function handleFile(file) {
    if (!file.name.endsWith('.torrent')) {
      showToast('Please select a valid .torrent file', 'error');
      return;
    }
    currentFile = file;
    selectedFileName.textContent = file.name;
    selectedFileInfo.style.display = 'flex';
    submitUploadBtn.disabled = false;
  }

  document.getElementById('btn-clear-file').onclick = (e) => {
    e.stopPropagation();
    currentFile = null;
    fileInput.value = '';
    selectedFileInfo.style.display = 'none';
    submitUploadBtn.disabled = true;
  };

  submitUploadBtn.onclick = async () => {
    if (!currentFile) return;
    const formData = new FormData();
    formData.append('torrentFile', currentFile);

    try {
      const res = await fetch('/api/torrents/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to upload torrent file');

      showToast('Torrent uploaded and initialized!', 'success');
      currentFile = null;
      fileInput.value = '';
      selectedFileInfo.style.display = 'none';
      submitUploadBtn.disabled = true;
      closeModal(uploadModal);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Video Stream Modal Close
  document.getElementById('btn-close-stream-modal').onclick = closeStreamModal;

  // Universal Backdrop click dismissal for all modals (Mobile & Desktop)
  ALL_MODAL_IDS.forEach(id => {
    const modalEl = document.getElementById(id);
    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
          if (id === 'modal-auth') {
            if (state.currentUser) closeModal(modalEl);
          } else {
            closeModal(modalEl);
          }
        }
      });
    }
  });

  // Drawer Backdrop dismissal
  const drawerBackdrop = document.getElementById('drawer-backdrop');
  if (drawerBackdrop) {
    drawerBackdrop.onclick = closeDetailDrawer;
  }

  // Keyboard ESC dismissal for modals and drawer
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDetailDrawer();
      ALL_MODAL_IDS.forEach(id => {
        const m = document.getElementById(id);
        if (m && m.classList.contains('open')) {
          if (id === 'modal-auth') {
            if (state.currentUser) closeModal(m);
          } else {
            closeModal(m);
          }
        }
      });
    }
  });
}

// --------------------------------------------------------------------------
// Navigation, Tabs & Search
// --------------------------------------------------------------------------

async function addPastedTorrent(rawSource) {
  showToast('Connecting to swarm & initiating download...', 'info');
  try {
    const res = await fetch('/api/torrents/magnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnetURI: rawSource })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add torrent');
    showToast(`⚡ Added to engine: ${data.torrent.name || 'Resolving metadata...'}`, 'success');
  } catch (err) {
    showToast('Failed to add torrent: ' + err.message, 'error');
  }
}

function setupToolbarAndTabs() {
  // Filter Tabs
  document.querySelectorAll('.filter-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeFilter = btn.dataset.filter;
      renderTorrentsList();
    });
  });

  // Search Input with Smart Magnet/Hash Detection
  const searchInput = document.getElementById('torrent-search-input');
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val.startsWith('magnet:?') || /^[a-f0-9]{40}$/i.test(val) || /^https?:\/\/.*\.torrent/i.test(val)) {
      searchInput.value = '';
      addPastedTorrent(val);
      return;
    }
    state.searchQuery = val;
    renderTorrentsList();
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = searchInput.value.trim();
      if (val.startsWith('magnet:?') || /^[a-f0-9]{40}$/i.test(val) || /^https?:\/\/.*\.torrent/i.test(val)) {
        searchInput.value = '';
        addPastedTorrent(val);
      } else if (val) {
        // Check if query matches any active torrents
        const matches = state.torrents.filter(t => 
          (t.name && t.name.toLowerCase().includes(val.toLowerCase())) ||
          (t.infoHash && t.infoHash.toLowerCase().includes(val.toLowerCase()))
        );
        if (matches.length === 0) {
          // Open Swarm Search directly with this keyword
          const searchModal = document.getElementById('modal-search');
          if (searchModal) {
            searchModal.classList.add('open');
            const idxInput = document.getElementById('indexer-search-input');
            if (idxInput) {
              idxInput.value = val;
              executeIndexerSearch(val);
            }
          }
        }
      }
    }
  });

  // Global window paste listener for instant magnet capture anywhere on page
  window.addEventListener('paste', (e) => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
      return; // Allow normal pasting inside text fields
    }
    const text = (e.clipboardData || window.clipboardData)?.getData('text')?.trim();
    if (text && (text.startsWith('magnet:?') || /^[a-f0-9]{40}$/i.test(text) || /^https?:\/\/.*\.torrent/i.test(text))) {
      addPastedTorrent(text);
    }
  });

  // Drawer Tabs
  document.querySelectorAll('.drawer-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.drawer-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.drawer-tab-pane').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.dataset.drawerTab;
      document.getElementById(`tab-pane-${tabId}`).classList.add('active');

      if (tabId === 'pieces' && state.detailedTorrent) {
        renderPieceMatrix(state.detailedTorrent.pieces);
      }
    });
  });

  // Close Drawer
  document.getElementById('btn-close-drawer').onclick = closeDetailDrawer;
}

// Helper: Escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --------------------------------------------------------------------------
// Browser URL Magnet Parameter Auto-Detection
// --------------------------------------------------------------------------

function checkUrlParamsForMagnets() {
  const urlParams = new URLSearchParams(window.location.search);
  const magnet = urlParams.get('magnet') || urlParams.get('add');
  if (magnet) {
    showToast('Detected magnet link from browser! Starting download...', 'info');
    fetch('/api/torrents/magnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnetURI: magnet })
    })
    .then(res => res.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      showToast('Magnet link successfully captured and added to swarm!', 'success');
      // Clean URL query string
      window.history.replaceState({}, document.title, window.location.pathname);
    })
    .catch(err => {
      showToast('Failed to auto-add magnet: ' + err.message, 'error');
    });
  }
}

// --------------------------------------------------------------------------
// Search Swarms & Webpage Sniffer Modal
// --------------------------------------------------------------------------

function setupSearchModal() {
  const searchModal = document.getElementById('modal-search');
  const btnOpen = document.getElementById('btn-open-search-modal');
  const btnClose = document.getElementById('btn-close-search-modal');
  
  if (!searchModal || !btnOpen) return;

  btnOpen.addEventListener('click', () => {
    openModal(searchModal);
    const input = document.getElementById('indexer-search-input');
    if (input) setTimeout(() => input.focus(), 100);
  });

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      closeModal(searchModal);
    });
  }

  // Modal navigation tabs
  const tabIndexer = document.getElementById('search-tab-indexer');
  const tabSniffer = document.getElementById('search-tab-sniffer');
  const viewIndexer = document.getElementById('view-indexer');
  const viewSniffer = document.getElementById('view-sniffer');

  tabIndexer.addEventListener('click', () => {
    tabIndexer.classList.add('active');
    tabSniffer.classList.remove('active');
    viewIndexer.style.display = 'block';
    viewSniffer.style.display = 'none';
  });

  tabSniffer.addEventListener('click', () => {
    tabSniffer.classList.add('active');
    tabIndexer.classList.remove('active');
    viewIndexer.style.display = 'none';
    viewSniffer.style.display = 'block';
  });

  // Suggestion chips
  document.querySelectorAll('.search-suggest-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.query;
      const input = document.getElementById('indexer-search-input');
      input.value = q;
      executeIndexerSearch(q);
    });
  });

  // Search button & Enter key
  const searchInput = document.getElementById('indexer-search-input');
  const searchBtn = document.getElementById('btn-execute-search');

  searchBtn.addEventListener('click', () => {
    const q = searchInput.value.trim();
    if (q) executeIndexerSearch(q);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = searchInput.value.trim();
      if (q) executeIndexerSearch(q);
    }
  });

  // Sniffer button & Enter key
  const snifferInput = document.getElementById('sniffer-url-input');
  const snifferBtn = document.getElementById('btn-execute-sniff');

  snifferBtn.addEventListener('click', () => {
    const url = snifferInput.value.trim();
    if (url) executePageSniff(url);
  });

  snifferInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = snifferInput.value.trim();
      if (url) executePageSniff(url);
    }
  });
}

async function executeIndexerSearch(query) {
  const container = document.getElementById('search-results-container');
  const autoAdd = document.getElementById('toggle-auto-add').checked;

  container.innerHTML = `
    <div class="search-placeholder">
      <p style="color: var(--cyan-400);">Searching swarm indexers and filtering for highest-speed seeders...</p>
    </div>
  `;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&autoAdd=${autoAdd}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Search failed');

    if (autoAdd && data.autoAdded && data.autoAddedTorrent) {
      showToast(`⚡ Auto-filtered & added top swarm: ${data.autoAddedTorrent.name}`, 'success');
      closeModal(document.getElementById('modal-search'));
      return;
    }

    if (!data.results || data.results.length === 0) {
      container.innerHTML = `
        <div class="search-placeholder">
          <p>No active torrent swarms found for "${escapeHtml(query)}". Try another search keyword.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = data.results.map((item, idx) => `
      <div class="search-result-card">
        <div class="search-result-info">
          <div class="search-result-title">${escapeHtml(item.name)}</div>
          <div class="search-meta-row font-mono">
            <span class="search-meta-badge">${escapeHtml(item.category)}</span>
            <span class="search-meta-badge">${formatBytes(item.sizeBytes)}</span>
            <span class="health-pill ${item.seeders > 10 ? 'high' : ''}">
              ⚡ ${item.seeders} seeds | ${item.leechers} leech
            </span>
            ${idx === 0 ? '<span class="badge" style="background: rgba(0, 242, 254, 0.2); color: var(--cyan-400); font-weight: 700;">★ Best Swarm</span>' : ''}
          </div>
        </div>
        <button class="btn btn-primary btn-dl-search" data-magnet="${escapeHtml(item.magnetURI)}" data-name="${escapeHtml(item.name)}" style="padding: 0.45rem 1rem; font-size: 0.8rem; white-space: nowrap;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
          <span>Download</span>
        </button>
      </div>
    `).join('');

    // Bind download buttons
    container.querySelectorAll('.btn-dl-search').forEach(btn => {
      btn.addEventListener('click', async () => {
        const magnet = btn.dataset.magnet;
        const name = btn.dataset.name;
        try {
          btn.disabled = true;
          btn.innerHTML = '<span>Adding...</span>';
          await fetch('/api/torrents/magnet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ magnetURI: magnet })
          });
          showToast(`Started downloading: ${name}`, 'success');
          closeModal(document.getElementById('modal-search'));
        } catch (err) {
          showToast('Failed to add: ' + err.message, 'error');
          btn.disabled = false;
        }
      });
    });

  } catch (err) {
    container.innerHTML = `
      <div class="search-placeholder">
        <p style="color: var(--rose-500);">Search error: ${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

async function executePageSniff(pageUrl) {
  const container = document.getElementById('sniffer-results-container');
  container.innerHTML = `
    <div class="search-placeholder">
      <p style="color: var(--cyan-400);">Sniffing page and auto-filtering magnet links...</p>
    </div>
  `;

  try {
    const res = await fetch('/api/sniff-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageUrl })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to sniff webpage');

    if (!data.magnets || data.magnets.length === 0) {
      container.innerHTML = `
        <div class="search-placeholder">
          <p>No magnet links were detected on this webpage.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = data.magnets.map(item => `
      <div class="search-result-card">
        <div class="search-result-info">
          <div class="search-result-title">${escapeHtml(item.name)}</div>
          <div class="search-meta-row font-mono">
            <span class="search-meta-badge">HASH: ${item.infoHash}</span>
          </div>
        </div>
        <button class="btn btn-primary btn-dl-sniff" data-magnet="${escapeHtml(item.magnetURI)}" style="padding: 0.45rem 1rem; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 0.4rem;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <span>Download</span>
        </button>
      </div>
    `).join('');

    container.querySelectorAll('.btn-dl-sniff').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          btn.disabled = true;
          await fetch('/api/torrents/magnet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ magnetURI: btn.dataset.magnet })
          });
          showToast('Added detected magnet link to engine!', 'success');
          closeModal(document.getElementById('modal-search'));
        } catch (err) {
          showToast('Failed to add: ' + err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    container.innerHTML = `
      <div class="search-placeholder">
        <p style="color: var(--rose-500);">Sniffer error: ${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

// --------------------------------------------------------------------------
// Turbo Boost & Swarm Acceleration Controls
// --------------------------------------------------------------------------

function setupTurboBoostControls() {
  // Global "Turbo Boost All" Header Button
  const btnTurboAll = document.getElementById('btn-turbo-all');
  if (btnTurboAll) {
    btnTurboAll.addEventListener('click', async () => {
      btnTurboAll.classList.add('spinning');
      try {
        const res = await fetch('/api/torrents/boost-all', { method: 'POST' });
        const data = await res.json();
        if (data.boostedCount > 0) {
          showToast(`⚡ Turbo Boosted ${data.boostedCount} active torrent(s)! Live trackers injected & swarms re-announced.`, 'success');
        } else {
          showToast('No active downloads to boost right now.', 'info');
        }
      } catch (err) {
        showToast('Turbo Boost failed: ' + err.message, 'error');
      } finally {
        setTimeout(() => btnTurboAll.classList.remove('spinning'), 600);
      }
    });
  }

  // Drawer "Turbo Boost" Button
  const btnDrawerBoost = document.getElementById('btn-drawer-boost');
  if (btnDrawerBoost) {
    btnDrawerBoost.addEventListener('click', async () => {
      if (!state.selectedHash) return;
      btnDrawerBoost.classList.add('spinning');
      try {
        const res = await fetch(`/api/torrents/${encodeURIComponent(state.selectedHash)}/boost`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(`⚡ Turbo Boost active! Injected ${data.newTrackersAdded} live trackers (${data.totalTrackers} active). DHT re-announced.`, 'success');
          // Re-fetch details to immediately update trackers list and state
          const detRes = await fetch(`/api/torrents/${encodeURIComponent(state.selectedHash)}`);
          const det = await detRes.json();
          renderDrawerDetails(det);
        } else {
          showToast('Turbo Boost error: ' + (data.error || 'Failed'), 'error');
        }
      } catch (err) {
        showToast('Boost error: ' + err.message, 'error');
      } finally {
        setTimeout(() => btnDrawerBoost.classList.remove('spinning'), 600);
      }
    });
  }

  // Drawer Overview "Re-Announce" Live Trackers Button
  const btnRefreshTrackers = document.getElementById('btn-refresh-trackers');
  if (btnRefreshTrackers) {
    btnRefreshTrackers.addEventListener('click', async () => {
      if (!state.selectedHash) return;
      btnRefreshTrackers.classList.add('spinning');
      try {
        await fetch('/api/trackers/live?force=true');
        const res = await fetch(`/api/torrents/${encodeURIComponent(state.selectedHash)}/boost`, { method: 'POST' });
        const data = await res.json();
        showToast(`Harvested latest community trackers! Total: ${data.totalTrackers} active.`, 'success');
        const detRes = await fetch(`/api/torrents/${encodeURIComponent(state.selectedHash)}`);
        const det = await detRes.json();
        renderDrawerDetails(det);
      } catch (err) {
        showToast('Failed to refresh trackers: ' + err.message, 'error');
      } finally {
        setTimeout(() => btnRefreshTrackers.classList.remove('spinning'), 600);
      }
    });
  }

  // Drawer Pause/Resume Toggle Button
  const btnDrawerPause = document.getElementById('btn-drawer-pause-toggle');
  if (btnDrawerPause) {
    btnDrawerPause.addEventListener('click', async () => {
      if (!state.selectedHash) return;
      const t = state.torrents.find(x => x.infoHash === state.selectedHash) || state.detailedTorrent;
      const isCurrentlyPaused = t && (t.paused || t.status === 'paused');
      const action = isCurrentlyPaused ? 'resume' : 'pause';
      try {
        // Optimistic UI update
        if (t) {
          t.status = isCurrentlyPaused ? 'downloading' : 'paused';
          t.paused = !isCurrentlyPaused;
          if (!isCurrentlyPaused) {
            t.downloadSpeed = 0;
            t.uploadSpeed = 0;
          }
          renderTorrentsList();
        }
        await fetch(`/api/torrents/${encodeURIComponent(state.selectedHash)}/${action}`, { method: 'POST' });
        showToast(isCurrentlyPaused ? 'Torrent resumed' : 'Torrent paused', 'info');
        const detRes = await fetch(`/api/torrents/${encodeURIComponent(state.selectedHash)}`);
        const det = await detRes.json();
        renderDrawerDetails(det);
      } catch (err) {
        showToast(`Failed to ${action}: ` + err.message, 'error');
      }
    });
  }

  // Swarm Optimizer Manual Evaluation Button
  const btnOptimizeSwarm = document.getElementById('btn-optimize-swarm');
  if (btnOptimizeSwarm) {
    btnOptimizeSwarm.addEventListener('click', async () => {
      if (!state.selectedHash) return;
      btnOptimizeSwarm.classList.add('spinning');
      try {
        const res = await fetch(`/api/torrents/${encodeURIComponent(state.selectedHash)}/optimize`, { method: 'POST' });
        const data = await res.json();
        if (data.optimized) {
          showToast(`⚡ Swarm optimized! Evaluated ${data.totalEvaluated} peers, evicted ${data.evictedCount} stalled/choked connections.`, 'success');
        } else {
          showToast(`Swarm health check: ${data.reason || 'Swarm is healthy'}`, 'info');
        }
        const detRes = await fetch(`/api/torrents/${encodeURIComponent(state.selectedHash)}`);
        const det = await detRes.json();
        renderDrawerDetails(det);
      } catch (err) {
        showToast('Swarm optimization failed: ' + err.message, 'error');
      } finally {
        setTimeout(() => btnOptimizeSwarm.classList.remove('spinning'), 600);
      }
    });
  }
}

// --------------------------------------------------------------------------
// Proxy Settings Modal (ISP Throttle Bypass)
// --------------------------------------------------------------------------

function setupProxyModal() {
  const modal = document.getElementById('modal-proxy');
  const btnOpen = document.getElementById('btn-open-proxy-modal');
  const btnClose = document.getElementById('btn-close-proxy-modal');
  const toggleEnabled = document.getElementById('proxy-enabled-toggle');
  const typeChips = document.querySelectorAll('.proxy-type-chip');
  const hostInput = document.getElementById('proxy-host');
  const portInput = document.getElementById('proxy-port');
  const usernameInput = document.getElementById('proxy-username');
  const passwordInput = document.getElementById('proxy-password');
  const statusCard = document.getElementById('proxy-status-card');
  const statusText = document.getElementById('proxy-status-text');
  const statusLatency = document.getElementById('proxy-latency');
  const btnTest = document.getElementById('btn-proxy-test');
  const btnSave = document.getElementById('btn-proxy-save');

  if (!modal || !btnOpen) return;

  let selectedType = 'socks5';

  function updateStatusUI(status) {
    if (status.enabled && status.host) {
      statusCard.className = 'proxy-status-card status-active';
      statusText.textContent = `Active: ${status.type.toUpperCase()}://${status.host}:${status.port}`;
      if (btnOpen) btnOpen.classList.add('proxy-active');
    } else {
      statusCard.className = 'proxy-status-card';
      statusText.textContent = 'Proxy Disabled — Direct peer connections';
      statusLatency.textContent = '';
      if (btnOpen) btnOpen.classList.remove('proxy-active');
    }
  }

  // Load existing configuration from server
  async function loadProxyConfig() {
    try {
      const res = await fetch('/api/proxy');
      if (!res.ok) return;
      const data = await res.json();

      toggleEnabled.checked = !!data.enabled;
      selectedType = data.type || 'socks5';
      hostInput.value = data.host || '';
      portInput.value = data.port || 1080;

      typeChips.forEach(chip => {
        chip.classList.toggle('active', chip.dataset.proxyType === selectedType);
      });

      updateStatusUI(data);
    } catch (err) {
      console.warn('Could not load proxy config:', err.message);
    }
  }

  // Type selection chips
  typeChips.forEach(chip => {
    chip.addEventListener('click', () => {
      typeChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedType = chip.dataset.proxyType;

      // Auto-populate default port if field is empty or using standard default
      if (!portInput.value || portInput.value === '1080' || portInput.value === '8080') {
        portInput.value = selectedType === 'socks5' ? '1080' : '8080';
      }
    });
  });

  // Open & Close Modal
  btnOpen.addEventListener('click', () => {
    openModal(modal);
    loadProxyConfig();
  });

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      closeModal(modal);
    });
  }

  // Test Connection
  if (btnTest) {
    btnTest.addEventListener('click', async () => {
      const host = hostInput.value.trim();
      const port = parseInt(portInput.value, 10);

      if (!host) {
        showToast('Please enter a proxy host / IP before testing', 'error');
        hostInput.focus();
        return;
      }

      btnTest.disabled = true;
      btnTest.classList.add('spinning');
      statusCard.className = 'proxy-status-card status-testing';
      statusText.textContent = 'Testing connection through proxy...';
      statusLatency.textContent = '';

      try {
        const payload = {
          host,
          port: port || (selectedType === 'socks5' ? 1080 : 8080),
          type: selectedType,
          username: usernameInput.value.trim(),
          password: passwordInput.value
        };

        const res = await fetch('/api/proxy/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const result = await res.json();

        if (result.success) {
          statusCard.className = 'proxy-status-card status-active';
          statusText.textContent = result.message || 'Connection verified successfully!';
          if (result.latencyMs !== undefined) {
            statusLatency.textContent = `${result.latencyMs}ms`;
          }
          showToast(`✅ Proxy connection verified (${result.latencyMs}ms)`, 'success');
        } else {
          statusCard.className = 'proxy-status-card status-error';
          statusText.textContent = result.error || 'Connection failed';
          statusLatency.textContent = 'Failed';
          showToast(`❌ Proxy test failed: ${result.error || 'Cannot reach proxy'}`, 'error');
        }
      } catch (err) {
        statusCard.className = 'proxy-status-card status-error';
        statusText.textContent = `Test failed: ${err.message}`;
        showToast('Proxy test request error: ' + err.message, 'error');
      } finally {
        btnTest.disabled = false;
        btnTest.classList.remove('spinning');
      }
    });
  }

  // Save and Apply
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      const isEnabled = toggleEnabled.checked;
      const host = hostInput.value.trim();
      const port = parseInt(portInput.value, 10);

      if (isEnabled && !host) {
        showToast('Please enter a proxy host / IP or disable the proxy toggle', 'error');
        hostInput.focus();
        return;
      }

      btnSave.disabled = true;

      try {
        const payload = {
          enabled: isEnabled,
          type: selectedType,
          host: host,
          port: port || (selectedType === 'socks5' ? 1080 : 8080),
          username: usernameInput.value.trim(),
          password: passwordInput.value
        };

        const res = await fetch('/api/proxy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save proxy settings');

        updateStatusUI(data);

        showToast(
          isEnabled
            ? `🔒 Proxy routing active via ${selectedType.toUpperCase()}://${host}:${payload.port}`
            : 'Proxy disabled — direct peer routing active',
          'success'
        );

        setTimeout(() => {
          modal.classList.remove('open');
          modal.setAttribute('aria-hidden', 'true');
        }, 500);
      } catch (err) {
        showToast('Failed to save proxy: ' + err.message, 'error');
      } finally {
        btnSave.disabled = false;
      }
    });
  }

  // Load initial configuration immediately
  loadProxyConfig();
}

// --------------------------------------------------------------------------
// Mobile Navigation Bar Controller (Thumb Friendly for iOS & Android)
// --------------------------------------------------------------------------

function setupMobileNavigation() {
  const navTorrents = document.getElementById('mob-nav-torrents');
  const navSearch = document.getElementById('mob-nav-search');
  const navAdd = document.getElementById('mob-nav-add');
  const navTurbo = document.getElementById('mob-nav-turbo');

  const updateActiveMobNav = (btn) => {
    document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));
    if (btn) btn.classList.add('active');
  };

  if (navTorrents) {
    navTorrents.addEventListener('click', () => {
      updateActiveMobNav(navTorrents);
      closeDetailDrawer();
      closeAllModals();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  if (navSearch) {
    navSearch.addEventListener('click', () => {
      updateActiveMobNav(navSearch);
      closeDetailDrawer();
      const searchModal = document.getElementById('modal-search');
      if (searchModal) {
        openModal(searchModal);
        const input = document.getElementById('indexer-search-input');
        if (input) setTimeout(() => input.focus(), 150);
      }
    });
  }

  if (navAdd) {
    navAdd.addEventListener('click', () => {
      updateActiveMobNav(navAdd);
      closeDetailDrawer();
      const magnetModal = document.getElementById('modal-magnet');
      if (magnetModal) {
        openModal(magnetModal);
        const input = document.getElementById('magnet-input');
        if (input) setTimeout(() => input.focus(), 150);
      }
    });
  }

  if (navTurbo) {
    navTurbo.addEventListener('click', () => {
      updateActiveMobNav(navTurbo);
      const btnTurbo = document.getElementById('btn-turbo-all');
      if (btnTurbo) btnTurbo.click();
    });
  }

  const navProfile = document.getElementById('mob-nav-profile');
  if (navProfile) {
    navProfile.addEventListener('click', () => {
      updateActiveMobNav(navProfile);
      closeDetailDrawer();
      if (!state.currentUser && state.authConfig && state.authConfig.authEnabled) {
        const authModal = document.getElementById('modal-auth');
        if (authModal) openModal(authModal);
      } else {
        const profileModal = document.getElementById('modal-profile');
        if (profileModal) {
          updateUserHeaderBadge(state.currentUser);
          openModal(profileModal);
        }
      }
    });
  }
}

// --------------------------------------------------------------------------
// User Profile & Quick Settings Modal Controller
// --------------------------------------------------------------------------

function setupProfileModal() {
  const modal = document.getElementById('modal-profile');
  const btnClose = document.getElementById('btn-close-profile-modal');
  const btnCloseFooter = document.getElementById('btn-close-profile-modal-footer');

  const btnOpenSec = document.getElementById('btn-profile-open-security');
  const btnOpenDisk = document.getElementById('btn-profile-open-disk');
  const btnOpenProxy = document.getElementById('btn-profile-open-proxy');
  const btnProfLogout = document.getElementById('btn-profile-logout');
  const headerBadge = document.getElementById('header-user-badge');

  if (btnClose) btnClose.onclick = () => closeModal(modal);
  if (btnCloseFooter) btnCloseFooter.onclick = () => closeModal(modal);

  // Allow clicking desktop header badge to open profile modal as well
  if (headerBadge) {
    headerBadge.addEventListener('click', () => {
      if (modal) {
        updateUserHeaderBadge(state.currentUser);
        openModal(modal);
      }
    });
  }

  if (btnOpenSec) {
    btnOpenSec.addEventListener('click', () => {
      if (modal) closeModal(modal);
      const secModal = document.getElementById('modal-security');
      const btnHeaderSec = document.getElementById('btn-open-security-modal');
      if (btnHeaderSec) {
        btnHeaderSec.click();
      } else if (secModal) {
        openModal(secModal);
      }
    });
  }

  if (btnOpenDisk) {
    btnOpenDisk.addEventListener('click', () => {
      if (modal) closeModal(modal);
      const diskModal = document.getElementById('modal-disk');
      if (diskModal) openModal(diskModal);
    });
  }

  if (btnOpenProxy) {
    btnOpenProxy.addEventListener('click', () => {
      if (modal) closeModal(modal);
      const proxyModal = document.getElementById('modal-proxy');
      if (proxyModal) openModal(proxyModal);
    });
  }

  if (btnProfLogout) {
    btnProfLogout.addEventListener('click', () => {
      if (modal) closeModal(modal);
      const btnLogoutHeader = document.getElementById('btn-logout-header');
      if (btnLogoutHeader) {
        btnLogoutHeader.click();
      }
    });
  }
}

// --------------------------------------------------------------------------
// Storage & Auto-Cleanup Modal Controller
// --------------------------------------------------------------------------

function setupDiskStorageModal() {
  const modal = document.getElementById('modal-disk');
  const btnOpenHeader = document.getElementById('btn-open-disk-modal');
  const btnOpenUtil = document.getElementById('btn-open-disk-modal-util');
  const btnClose = document.getElementById('btn-close-disk-modal');
  const btnCloseFooter = document.getElementById('btn-close-disk-modal-footer');
  const btnSaveAuto = document.getElementById('btn-save-auto-cleanup');
  const btnRunManual = document.getElementById('btn-run-manual-cleanup');
  const toggleAuto = document.getElementById('toggle-auto-cleanup');
  const selectThreshold = document.getElementById('select-cleanup-threshold');
  const chkDeleteFiles = document.getElementById('chk-cleanup-delete-files');
  const selectAge = document.getElementById('select-manual-age');

  const openDisk = async () => {
    if (!state.currentUser || state.currentUser.role !== 'admin') {
      showToast('Storage telemetry & auto-cleanup are restricted to Administrators.', 'warning');
      return;
    }
    if (!modal) return;
    openModal(modal);
    await refreshDiskModalData();
  };

  const closeDisk = () => {
    if (!modal) return;
    closeModal(modal);
  };

  if (btnOpenHeader) btnOpenHeader.addEventListener('click', openDisk);
  if (btnOpenUtil) btnOpenUtil.addEventListener('click', openDisk);
  if (btnClose) btnClose.addEventListener('click', closeDisk);
  if (btnCloseFooter) btnCloseFooter.addEventListener('click', closeDisk);

  // Save Auto-Cleanup Configuration
  if (btnSaveAuto) {
    btnSaveAuto.addEventListener('click', async () => {
      try {
        btnSaveAuto.disabled = true;
        const enabled = toggleAuto ? toggleAuto.checked : false;
        const thresholdPercent = selectThreshold ? parseInt(selectThreshold.value, 10) : 90;
        const deleteFiles = chkDeleteFiles ? chkDeleteFiles.checked : true;

        const res = await fetch('/api/disk/auto-cleanup', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, thresholdPercent, deleteFiles })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`⚙️ Auto-cleanup rules saved! Protection: ${enabled ? 'ACTIVE' : 'OFF'}`, 'success');
        } else {
          showToast('Failed to save rules: ' + (data.error || 'Error'), 'error');
        }
      } catch (err) {
        showToast('Error saving auto-cleanup: ' + err.message, 'error');
      } finally {
        btnSaveAuto.disabled = false;
      }
    });
  }

  // Trigger Manual Cleanup
  if (btnRunManual) {
    btnRunManual.addEventListener('click', async () => {
      const maxAgeHours = selectAge ? parseInt(selectAge.value, 10) : 0;
      const deleteFiles = chkDeleteFiles ? chkDeleteFiles.checked : true;

      const confirmMsg = maxAgeHours === 0 
        ? 'Purge ALL completed torrents and delete payload files from the server SSD?' 
        : `Purge completed torrents older than ${maxAgeHours} hours and free SSD space?`;

      if (!confirm(confirmMsg)) return;

      try {
        btnRunManual.disabled = true;
        btnRunManual.innerHTML = '<span>Purging...</span>';

        const res = await fetch('/api/disk/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxAgeHours, deleteFiles })
        });
        const data = await res.json();

        if (data.success) {
          const freedStr = formatBytes(data.freedBytes);
          showToast(`🧹 Reclamation Complete! Cleaned ${data.cleanedCount} torrent(s), freed ${freedStr} SSD space.`, 'success');
          await refreshDiskModalData();
        } else {
          showToast('Cleanup failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showToast('Cleanup error: ' + err.message, 'error');
      } finally {
        btnRunManual.disabled = false;
        btnRunManual.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span>Reclaim Disk Space Now</span>`;
      }
    });
  }
}

async function refreshDiskModalData() {
  try {
    const res = await fetch('/api/disk');
    if (!res.ok) return;
    const disk = await res.json();

    const percent = disk.percent !== undefined ? disk.percent : 0;
    const circle = document.getElementById('modal-disk-circle');
    const percentEl = document.getElementById('modal-disk-percent');
    const freeEl = document.getElementById('modal-disk-free');
    const usedEl = document.getElementById('modal-disk-used');
    const totalEl = document.getElementById('modal-disk-total');
    const meterFill = document.getElementById('modal-disk-meter-fill');
    const statusCap = document.getElementById('modal-disk-status-caption');
    const maxCap = document.getElementById('modal-disk-max-caption');

    if (percentEl) percentEl.textContent = `${percent}%`;
    if (freeEl) freeEl.textContent = formatBytes(disk.free);
    if (usedEl) usedEl.textContent = formatBytes(disk.used);
    if (totalEl) totalEl.textContent = formatBytes(disk.total);
    if (meterFill) {
      meterFill.style.width = `${percent}%`;
      meterFill.className = 'disk-main-meter-fill';
      if (percent >= 90) meterFill.classList.add('critical');
      else if (percent >= 80) meterFill.classList.add('warning');
    }
    if (maxCap) maxCap.textContent = formatBytes(disk.total);

    if (circle) {
      circle.className = 'disk-gauge-circle';
      if (percent >= 90) circle.classList.add('critical');
      else if (percent >= 80) circle.classList.add('warning');
    }

    if (statusCap) {
      if (percent >= 90) {
        statusCap.textContent = 'Storage Health: CRITICAL (Danger of disk exhaustion)';
        statusCap.style.color = 'var(--rose-500)';
      } else if (percent >= 80) {
        statusCap.textContent = 'Storage Health: WARNING (Approaching capacity limit)';
        statusCap.style.color = 'var(--amber-500)';
      } else {
        statusCap.textContent = 'Storage Health: Optimal';
        statusCap.style.color = 'var(--emerald-500)';
      }
    }

    // Auto-cleanup toggle & threshold state
    if (disk.autoCleanup) {
      const toggle = document.getElementById('toggle-auto-cleanup');
      const thresholdSelect = document.getElementById('select-cleanup-threshold');
      const deleteChk = document.getElementById('chk-cleanup-delete-files');
      if (toggle) toggle.checked = !!disk.autoCleanup.enabled;
      if (thresholdSelect && disk.autoCleanup.thresholdPercent) {
        thresholdSelect.value = String(disk.autoCleanup.thresholdPercent);
      }
      if (deleteChk && disk.autoCleanup.deleteFiles !== undefined) {
        deleteChk.checked = !!disk.autoCleanup.deleteFiles;
      }
    }

    // Completed Torrents List
    const summaryBadge = document.getElementById('modal-completed-summary');
    const listContainer = document.getElementById('completed-torrents-container');
    const completedList = disk.completedTorrents || [];

    if (summaryBadge) {
      summaryBadge.textContent = `${completedList.length} Completed (${formatBytes(disk.completedTorrentsSize || 0)})`;
    }

    if (listContainer) {
      if (completedList.length === 0) {
        listContainer.innerHTML = `<div class="cleanup-empty-hint">No completed torrents currently occupying SSD storage.</div>`;
      } else {
        listContainer.innerHTML = completedList.map(item => `
          <div class="completed-torrent-item">
            <div class="completed-torrent-name font-mono" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <span class="font-mono" style="color: var(--cyan-400);">${formatBytes(item.length)}</span>
              <button class="btn-icon danger single-purge-btn" data-hash="${item.infoHash}" title="Purge this torrent from SSD">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          </div>
        `).join('');

        // Bind single purge buttons
        listContainer.querySelectorAll('.single-purge-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const hash = btn.dataset.hash;
            if (!confirm('Permanently purge this torrent and delete its files from the VPS disk?')) return;
            try {
              await fetch(`/api/torrents/${encodeURIComponent(hash)}?deleteFiles=true`, { method: 'DELETE' });
              showToast('Torrent purged from disk', 'info');
              await refreshDiskModalData();
            } catch (err) {
              showToast('Failed to purge torrent: ' + err.message, 'error');
            }
          });
        });
      }
    }
  } catch (err) {
    console.warn('[Refresh Disk Data Error]:', err.message);
  }
}

// --------------------------------------------------------------------------
// ⚡ Hyper-Speed Turbo Downloader Modal Controller (IDM-Style Engine)
// --------------------------------------------------------------------------

let currentTurboInstance = null;
let currentTurboStreams = 8;
let currentTurboTarget = null;

function setupTurboDownloaderModal() {
  const modal = document.getElementById('modal-turbo-downloader');
  const btnClose = document.getElementById('btn-close-turbo-modal');
  const btnStart = document.getElementById('btn-start-turbo-download');
  const btnPause = document.getElementById('btn-turbo-pause');
  const btnCancel = document.getElementById('btn-turbo-cancel');
  const streamChips = document.querySelectorAll('#turbo-concurrency-chips .turbo-chip');

  const closeTurbo = async () => {
    if (!modal) return;
    if (currentTurboInstance && currentTurboInstance.status === 'downloading') {
      if (!confirm('A Turbo Download is currently active. Do you want to pause or stop it before closing?')) {
        return;
      }
      currentTurboInstance.pause();
    }
    closeModal(modal);
  };

  if (btnClose) btnClose.addEventListener('click', closeTurbo);

  // Stream chips selector (4, 8, 16 connections)
  streamChips.forEach(chip => {
    chip.addEventListener('click', () => {
      if (currentTurboInstance && (currentTurboInstance.status === 'downloading' || currentTurboInstance.status === 'preparing')) {
        showToast('Cannot change stream concurrency while downloading is active.', 'info');
        return;
      }
      streamChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentTurboStreams = parseInt(chip.dataset.streams, 10) || 8;

      if (currentTurboTarget) {
        renderTurboThreadsPlaceholder(currentTurboStreams, currentTurboTarget.fileLength);
        const streamsCount = document.getElementById('turbo-active-streams-count');
        if (streamsCount) streamsCount.textContent = `0 / ${currentTurboStreams} Streams`;
        if (btnStart) {
          btnStart.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:16px;height:16px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg><span>Start Turbo Download (${currentTurboStreams} Streams)</span>`;
        }
      }
    });
  });

  // Start button
  if (btnStart) {
    btnStart.addEventListener('click', async () => {
      if (!currentTurboInstance) return;
      try {
        btnStart.disabled = true;
        btnStart.innerHTML = '<span>Connecting Streams...</span>';
        await currentTurboInstance.start();
      } catch (err) {
        console.warn('[TurboDownloader] Start error:', err);
        if (err.message && err.message.includes('cancelled')) {
          showToast('Save destination cancelled.', 'info');
        } else {
          showToast('Download error: ' + err.message, 'error');
        }
        btnStart.disabled = false;
        btnStart.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:16px;height:16px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg><span>Start Turbo Download (${currentTurboStreams} Streams)</span>`;
      }
    });
  }

  // Pause / Resume button
  if (btnPause) {
    btnPause.addEventListener('click', async () => {
      if (!currentTurboInstance) return;
      if (currentTurboInstance.status === 'downloading') {
        currentTurboInstance.pause();
        showToast('⏸ Turbo Download paused.', 'info');
      } else if (currentTurboInstance.status === 'paused') {
        showToast('▶ Resuming Turbo Download...', 'info');
        await currentTurboInstance.resume();
      }
    });
  }

  // Cancel button
  if (btnCancel) {
    btnCancel.addEventListener('click', async () => {
      if (!currentTurboInstance) return;
      if (confirm('Cancel this Turbo Download?')) {
        await currentTurboInstance.cancel();
        showToast('Turbo Download cancelled.', 'info');
        closeModal();
      }
    });
  }
}

async function openTurboModal(infoHash, fileIndex, filename, fileLength) {
  const modal = document.getElementById('modal-turbo-downloader');
  if (!modal) return;

  if (currentTurboInstance && currentTurboInstance.status === 'downloading') {
    if (!confirm('A Turbo Download is currently active. Do you want to cancel it and start this new download?')) {
      return;
    }
    await currentTurboInstance.cancel();
  }

  currentTurboTarget = { infoHash, fileIndex, filename, fileLength };

  const nameEl = document.getElementById('turbo-modal-filename');
  const displayTitle = document.getElementById('turbo-file-display-name');
  const displaySize = document.getElementById('turbo-file-display-size');
  const storageBadge = document.getElementById('turbo-storage-badge');
  const speedVal = document.getElementById('turbo-speed-val');
  const peakSpeedVal = document.getElementById('turbo-peak-speed-val');
  const etaVal = document.getElementById('turbo-eta-val');
  const masterFill = document.getElementById('turbo-master-fill');
  const progressPercent = document.getElementById('turbo-progress-percent');
  const progressTransferred = document.getElementById('turbo-progress-transferred');
  const streamsCount = document.getElementById('turbo-active-streams-count');
  const statusBadge = document.getElementById('turbo-engine-status-badge');
  const btnStart = document.getElementById('btn-start-turbo-download');
  const btnPause = document.getElementById('btn-turbo-pause');
  const btnCancel = document.getElementById('btn-turbo-cancel');

  const isMobile = window.TurboDownloader ? window.TurboDownloader.isMobile() : false;
  const isDirectDisk = window.TurboDownloader ? window.TurboDownloader.isFileSystemAccessSupported() && !isMobile : false;

  if (nameEl) nameEl.textContent = `Turbo Download: ${filename}`;
  if (displayTitle) displayTitle.textContent = filename;
  if (displaySize) displaySize.textContent = formatBytes(fileLength);
  if (storageBadge) {
    if (isDirectDisk) {
      storageBadge.textContent = 'Direct NVMe/SSD Stream (Zero RAM)';
      storageBadge.className = 'badge badge-cyan';
    } else if (isMobile) {
      storageBadge.textContent = 'Mobile Stream (Screen Wake Lock)';
      storageBadge.className = 'badge badge-amber';
    } else {
      storageBadge.textContent = 'High-Speed Memory Stream';
      storageBadge.className = 'badge';
    }
  }

  if (speedVal) speedVal.textContent = '0.00 MB/s';
  if (peakSpeedVal) peakSpeedVal.textContent = 'Peak: 0.00 MB/s';
  if (etaVal) etaVal.textContent = '--:--';
  if (masterFill) masterFill.style.width = '0%';
  if (progressPercent) progressPercent.textContent = '0%';
  if (progressTransferred) progressTransferred.textContent = `0 B of ${formatBytes(fileLength)}`;
  if (streamsCount) streamsCount.textContent = `0 / ${currentTurboStreams} Streams`;
  if (statusBadge) {
    statusBadge.textContent = 'READY';
    statusBadge.className = 'badge';
  }

  if (btnStart) {
    btnStart.style.display = 'inline-flex';
    btnStart.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:16px;height:16px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg><span>Start Turbo Download (${currentTurboStreams} Streams)</span>`;
    btnStart.disabled = false;
  }
  if (btnPause) btnPause.style.display = 'none';
  if (btnCancel) btnCancel.style.display = 'none';

  renderTurboThreadsPlaceholder(currentTurboStreams, fileLength);

  // Setup 1-Click Stream copy
  const directDownloadUrl = `${window.location.origin}/api/download/${encodeURIComponent(infoHash)}/${fileIndex}`;
  const btnCopy = document.getElementById('btn-copy-stream-link');
  if (btnCopy) {
    btnCopy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(directDownloadUrl);
        showToast('📋 Copied Multi-Stream URL! Paste into 1DM / ADM on Android or Documents on iOS.', 'success');
      } catch (e) {
        prompt('Copy Multi-Stream Download URL:', directDownloadUrl);
      }
    };
  }

  // Create new TurboDownloader instance
  if (!window.TurboDownloader) {
    showToast('TurboDownloader engine module not loaded', 'error');
    return;
  }

  currentTurboInstance = new window.TurboDownloader({
    infoHash,
    fileIndex,
    filename,
    fileLength,
    concurrency: currentTurboStreams,
    downloadUrl: `/api/download/${encodeURIComponent(infoHash)}/${fileIndex}`,
    onProgress: (stats) => {
      if (speedVal) speedVal.textContent = formatSpeed(stats.speed);
      if (peakSpeedVal) peakSpeedVal.textContent = `Peak: ${formatSpeed(stats.peakSpeed)}`;
      if (etaVal) etaVal.textContent = stats.eta > 0 ? formatETA(stats.eta * 1000) : '--';
      if (masterFill) masterFill.style.width = `${stats.percent.toFixed(1)}%`;
      if (progressPercent) progressPercent.textContent = `${stats.percent.toFixed(1)}%`;
      if (progressTransferred) progressTransferred.textContent = `${formatBytes(stats.downloaded)} of ${formatBytes(stats.total)}`;
    },
    onThreadUpdate: (threads) => {
      renderTurboThreads(threads);
    },
    onStateChange: (status) => {
      if (statusBadge) {
        statusBadge.textContent = status.toUpperCase();
        if (status === 'downloading') statusBadge.className = 'badge turbo';
        else if (status === 'completed') statusBadge.className = 'badge ok';
        else if (status === 'paused') statusBadge.className = 'badge warning';
        else if (status === 'error') statusBadge.className = 'badge danger';
      }

      if (status === 'downloading') {
        if (btnStart) btnStart.style.display = 'none';
        if (btnPause) {
          btnPause.style.display = 'inline-flex';
          const pauseText = document.getElementById('turbo-pause-btn-text');
          if (pauseText) pauseText.textContent = 'Pause';
        }
        if (btnCancel) btnCancel.style.display = 'inline-flex';
      } else if (status === 'paused') {
        if (btnPause) {
          const pauseText = document.getElementById('turbo-pause-btn-text');
          if (pauseText) pauseText.textContent = 'Resume';
        }
      } else if (status === 'completed') {
        if (btnStart) {
          btnStart.style.display = 'inline-flex';
          btnStart.innerHTML = '<span>🎉 Download Complete!</span>';
          btnStart.disabled = true;
        }
        if (btnPause) btnPause.style.display = 'none';
        if (btnCancel) btnCancel.style.display = 'none';
      }
    },
    onComplete: (res) => {
      showToast(`🎉 Turbo Download Complete: ${res.filename} (Peak Speed: ${formatSpeed(res.peakSpeed)})`, 'success');
    },
    onError: (err) => {
      showToast(`Download error: ${err.message}`, 'error');
    }
  });

  openModal(modal);
}

function renderTurboThreadsPlaceholder(count, totalBytes) {
  const container = document.getElementById('turbo-threads-grid');
  if (!container) return;

  const segSize = totalBytes > 0 ? Math.floor(totalBytes / count) : 0;
  let html = '';
  for (let i = 0; i < count; i++) {
    const start = i * segSize;
    const end = (i === count - 1) ? Math.max(0, totalBytes - 1) : Math.max(0, (i + 1) * segSize - 1);
    html += `
      <div class="turbo-thread-card" id="turbo-thread-${i}">
        <div class="turbo-thread-top">
          <span class="turbo-thread-id font-mono">⚡ Stream #${i + 1}</span>
          <span class="turbo-thread-speed font-mono">0.00 B/s</span>
        </div>
        <div class="turbo-thread-track">
          <div class="turbo-thread-fill" style="width: 0%;"></div>
        </div>
        <div class="turbo-thread-range font-mono">
          <span>${formatBytes(start)}</span>
          <span class="thread-status-text">Pending</span>
          <span>${formatBytes(end)}</span>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

function renderTurboThreads(threads) {
  const container = document.getElementById('turbo-threads-grid');
  if (!container || !threads || threads.length === 0) return;

  const activeCount = threads.filter(t => t.status === 'active').length;
  const streamsCount = document.getElementById('turbo-active-streams-count');
  if (streamsCount) streamsCount.textContent = `${activeCount} / ${threads.length} Streams`;

  threads.forEach((t, i) => {
    let card = document.getElementById(`turbo-thread-${i}`);
    const segTotal = Math.max(1, t.end - t.start);
    const segDone = Math.max(0, t.current - t.start);
    const pct = Math.min(100, Math.floor((segDone / segTotal) * 100));

    if (!card) {
      card = document.createElement('div');
      card.id = `turbo-thread-${i}`;
      card.className = 'turbo-thread-card';
      container.appendChild(card);
    }

    card.className = `turbo-thread-card ${t.status === 'completed' ? 'completed' : (t.status === 'active' ? 'active' : '')}`;
    card.innerHTML = `
      <div class="turbo-thread-top">
        <span class="turbo-thread-id font-mono">⚡ Stream #${i + 1}</span>
        <span class="turbo-thread-speed font-mono">${t.status === 'completed' ? 'Done 100%' : (t.speed > 0 ? formatSpeed(t.speed) : t.status.toUpperCase())}</span>
      </div>
      <div class="turbo-thread-track">
        <div class="turbo-thread-fill" style="width: ${pct}%;"></div>
      </div>
      <div class="turbo-thread-range font-mono">
        <span>${formatBytes(t.start)}</span>
        <span class="thread-status-text">${pct}%</span>
        <span>${formatBytes(t.end)}</span>
      </div>
    `;
  });
}

// --------------------------------------------------------------------------
// Master Authentication & Security Management
// --------------------------------------------------------------------------

function showAuthModal(isSetup = false, errorMsg = '') {
  const modal = document.getElementById('modal-auth');
  if (!modal) return;

  const titleEl = document.getElementById('auth-modal-title');
  const subEl = document.getElementById('auth-modal-subtitle');
  const setupFields = document.getElementById('auth-setup-fields');
  const loginFields = document.getElementById('auth-login-fields');
  const btnText = document.getElementById('auth-btn-text');
  const errBanner = document.getElementById('auth-error-banner');

  if (isSetup) {
    if (titleEl) titleEl.textContent = 'Master Security Setup';
    if (subEl) subEl.textContent = 'Establish a master password to protect HyperTorrent';
    if (setupFields) setupFields.style.display = 'block';
    if (loginFields) loginFields.style.display = 'none';
    if (btnText) btnText.textContent = 'Create Password & Unlock';
  } else {
    if (titleEl) titleEl.textContent = 'Master Access Lock';
    if (subEl) subEl.textContent = 'Authenticate to access HyperTorrent dashboard';
    if (setupFields) setupFields.style.display = 'none';
    if (loginFields) loginFields.style.display = 'block';
    if (btnText) btnText.textContent = 'Unlock Dashboard';
  }

  if (errorMsg) {
    if (errBanner) {
      errBanner.textContent = errorMsg;
      errBanner.style.display = 'flex';
    }
  } else if (errBanner) {
    errBanner.style.display = 'none';
  }

  openModal(modal);
}

function hideAuthModal() {
  const modal = document.getElementById('modal-auth');
  if (modal) {
    closeModal(modal);
  }
}

function updateUserHeaderBadge(user) {
  // Desktop header badge elements
  const badge = document.getElementById('header-user-badge');
  const avatar = document.getElementById('header-user-avatar');
  const initials = document.getElementById('header-user-initials');
  const emailEl = document.getElementById('header-user-email');
  const roleEl = document.getElementById('header-user-role');

  // Mobile bottom nav profile elements
  const mobAvatar = document.getElementById('mob-nav-user-avatar');
  const mobInitials = document.getElementById('mob-nav-user-initials');
  const mobIcon = document.getElementById('mob-nav-user-icon');
  const mobLabel = document.getElementById('mob-nav-profile-label');

  // Profile modal elements
  const profHeroAvatar = document.getElementById('profile-hero-avatar');
  const profHeroInitials = document.getElementById('profile-hero-initials');
  const profHeroName = document.getElementById('profile-hero-name');
  const profHeroEmail = document.getElementById('profile-hero-email');
  const profHeroRole = document.getElementById('profile-hero-role');
  const profHeroStatus = document.getElementById('profile-hero-status');
  const profStatRole = document.getElementById('profile-stat-role');
  const profStatActive = document.getElementById('profile-stat-active');
  const profStatStorage = document.getElementById('profile-stat-storage');

  if (!user) {
    if (badge) badge.style.display = 'none';

    // Mobile nav fallback to default icon
    if (mobAvatar) mobAvatar.style.display = 'none';
    if (mobInitials) mobInitials.style.display = 'none';
    if (mobIcon) mobIcon.style.display = 'block';
    if (mobLabel) mobLabel.textContent = 'Profile';

    // Profile modal fallback
    if (profHeroAvatar) profHeroAvatar.style.display = 'none';
    if (profHeroInitials) {
      profHeroInitials.style.display = 'flex';
      profHeroInitials.textContent = '?';
    }
    if (profHeroName) profHeroName.textContent = 'Not Logged In';
    if (profHeroEmail) profHeroEmail.textContent = 'Guest Session';
    if (profHeroRole) {
      profHeroRole.textContent = 'LOCKED';
      profHeroRole.className = 'user-role-tag';
    }
    if (profHeroStatus) profHeroStatus.className = 'profile-hero-status-dot offline';
    if (profStatRole) profStatRole.textContent = 'None';
    if (profStatActive) profStatActive.textContent = '0 Active';
    if (profStatStorage) profStatStorage.textContent = '--';
    return;
  }

  if (badge) badge.style.display = 'flex';
  const displayName = user.name || user.email || 'User';
  const firstLetter = (displayName[0] || 'U').toUpperCase();
  const role = (user.role || 'user').toLowerCase();

  // 1. Desktop header badge
  if (emailEl) emailEl.textContent = user.email || displayName;
  if (roleEl) {
    roleEl.textContent = role.toUpperCase();
    roleEl.className = `user-role-tag ${role}`;
  }
  if (user.picture && avatar) {
    avatar.src = user.picture;
    avatar.style.display = 'block';
    if (initials) initials.style.display = 'none';
  } else if (initials) {
    if (avatar) avatar.style.display = 'none';
    initials.style.display = 'flex';
    initials.textContent = firstLetter;
  }

  // 2. Mobile bottom nav profile icon
  if (mobLabel) mobLabel.textContent = 'Profile';
  if (user.picture && mobAvatar) {
    mobAvatar.src = user.picture;
    mobAvatar.style.display = 'block';
    if (mobInitials) mobInitials.style.display = 'none';
    if (mobIcon) mobIcon.style.display = 'none';
  } else if (mobInitials) {
    if (mobAvatar) mobAvatar.style.display = 'none';
    mobInitials.style.display = 'flex';
    mobInitials.textContent = firstLetter;
    if (mobIcon) mobIcon.style.display = 'none';
  } else if (mobIcon) {
    mobIcon.style.display = 'block';
  }

  // 3. Profile modal hero & stats
  if (profHeroName) profHeroName.textContent = displayName;
  if (profHeroEmail) profHeroEmail.textContent = user.email || displayName;
  if (profHeroRole) {
    profHeroRole.textContent = role.toUpperCase();
    profHeroRole.className = `user-role-tag ${role}`;
  }
  if (profHeroStatus) profHeroStatus.className = 'profile-hero-status-dot online';
  if (profStatRole) profStatRole.textContent = role.toUpperCase();

  if (user.picture && profHeroAvatar) {
    profHeroAvatar.src = user.picture;
    profHeroAvatar.style.display = 'block';
    if (profHeroInitials) profHeroInitials.style.display = 'none';
  } else if (profHeroInitials) {
    if (profHeroAvatar) profHeroAvatar.style.display = 'none';
    profHeroInitials.style.display = 'flex';
    profHeroInitials.textContent = firstLetter;
  }

  // Active downloads count
  if (profStatActive) {
    const activeCount = Array.isArray(state.torrents)
      ? state.torrents.filter(t => t.status === 'downloading' || t.status === 'seeding').length
      : 0;
    profStatActive.textContent = `${activeCount} Active`;
  }

  // Storage stats
  if (profStatStorage) {
    if (user.storageUsed && typeof formatBytes === 'function') {
      profStatStorage.textContent = formatBytes(user.storageUsed);
    } else if (state.globalStats && state.globalStats.disk && typeof formatBytes === 'function') {
      profStatStorage.textContent = formatBytes(state.globalStats.disk.used);
    } else {
      profStatStorage.textContent = 'Online';
    }
  }
}

function applyRolePermissions(user) {
  const isAdmin = !!(user && user.role === 'admin');
  const isLoggedIn = !!user;

  // Helper to cleanly toggle visibility using both class and inline style !important
  const setVisibility = (el, show, displayStyle = 'inline-flex') => {
    if (!el) return;
    if (show) {
      el.classList.remove('admin-only-hidden');
      el.style.removeProperty('display');
      el.style.display = displayStyle;
    } else {
      el.classList.add('admin-only-hidden');
      el.style.setProperty('display', 'none', 'important');
    }
  };

  // Real-time SSD Storage Gauge Card (Header)
  const btnDiskGauge = document.getElementById('btn-open-disk-modal');
  setVisibility(btnDiskGauge, isAdmin, 'flex');
  if (btnDiskGauge) btnDiskGauge.style.cursor = isAdmin ? 'pointer' : 'default';

  // Admin-only header buttons & triggers
  const btnProxy = document.getElementById('btn-open-proxy-modal');
  const btnDiskUtil = document.getElementById('btn-open-disk-modal-util');
  const btnSec = document.getElementById('btn-open-security-modal');
  const btnLogout = document.getElementById('btn-logout-header');

  setVisibility(btnProxy, isAdmin, 'inline-flex');
  setVisibility(btnDiskUtil, isAdmin, 'inline-flex');
  setVisibility(btnSec, isAdmin, 'inline-flex');
  setVisibility(btnLogout, isLoggedIn, 'inline-flex');

  // Profile modal action items
  const btnProfSec = document.getElementById('btn-profile-open-security');
  const btnProfDisk = document.getElementById('btn-profile-open-disk');
  const btnProfProxy = document.getElementById('btn-profile-open-proxy');
  const btnProfLogout = document.getElementById('btn-profile-logout');

  setVisibility(btnProfSec, isAdmin, 'flex');
  setVisibility(btnProfDisk, isAdmin, 'flex');
  setVisibility(btnProfProxy, isAdmin, 'flex');
  setVisibility(btnProfLogout, isLoggedIn, 'flex');

  // Also sync user profile badge in header & bottom navigation
  updateUserHeaderBadge(user);

  // Security modal tabs for non-admins
  const tabGoogle = document.getElementById('tab-sec-google');
  const tabUsers = document.getElementById('tab-sec-users');
  if (tabGoogle) tabGoogle.style.display = isAdmin ? 'flex' : 'none';
  if (tabUsers) tabUsers.style.display = isAdmin ? 'flex' : 'none';
}

async function checkAuthStatus() {
  try {
    // 1. Check URL parameters for OAuth redirect feedback
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('login') === 'success') {
      window.history.replaceState({}, document.title, window.location.pathname);
      showToast('Signed in successfully with Google! Welcome back.', 'success');
    }
    const authErr = urlParams.get('auth_error');
    if (authErr) {
      window.history.replaceState({}, document.title, window.location.pathname);
      const decodedErr = decodeURIComponent(authErr);
      showToast(decodedErr, 'error');
      showAuthModal(false, decodedErr);
      return false;
    }

    const res = await _originalFetch('/api/auth/status');
    const data = await res.json();
    state.authConfig = data;

    // Toggle Google sign in button visibility
    const googleContainer = document.getElementById('google-auth-container');
    if (googleContainer) {
      googleContainer.style.display = data.googleAuthEnabled ? 'block' : 'none';
    }

    if (!data.isConfigured) {
      showAuthModal(true);
      return false;
    }

    // Always fetch /api/auth/me to bind user session context
    const token = state.token || localStorage.getItem('ht_token');
    const testHeaders = token ? { 'Authorization': `Bearer ${token}` } : {};
    const meRes = await _originalFetch('/api/auth/me', { headers: testHeaders, credentials: 'include' });

    if (meRes.ok) {
      const meData = await meRes.json();
      state.currentUser = meData.user;
      applyRolePermissions(meData.user);
      hideAuthModal();
      initWebSocket();
      return true;
    } else {
      applyRolePermissions(null);
      if (data.authEnabled && (!data.isLocal || data.requireLocalAuth)) {
        showAuthModal(false);
        return false;
      }
    }

    hideAuthModal();
    initWebSocket();
    return true;
  } catch (err) {
    applyRolePermissions(null);
    console.warn('[Auth Check Warning]:', err);
    return false;
  }
}

function setupAuthSystem() {
  const authForm = document.getElementById('auth-form');
  const errBanner = document.getElementById('auth-error-banner');
  const spinner = document.getElementById('auth-spinner');
  const btnText = document.getElementById('auth-btn-text');

  // Toggle password visibility helpers
  const btnToggleSetup = document.getElementById('btn-toggle-setup-pwd');
  const setupPwdInput = document.getElementById('setup-password-input');
  if (btnToggleSetup && setupPwdInput) {
    btnToggleSetup.addEventListener('click', () => {
      setupPwdInput.type = setupPwdInput.type === 'password' ? 'text' : 'password';
      btnToggleSetup.textContent = setupPwdInput.type === 'password' ? '👁' : '🙈';
    });
  }

  const btnToggleLogin = document.getElementById('btn-toggle-login-pwd');
  const loginPwdInput = document.getElementById('login-password-input');
  if (btnToggleLogin && loginPwdInput) {
    btnToggleLogin.addEventListener('click', () => {
      loginPwdInput.type = loginPwdInput.type === 'password' ? 'text' : 'password';
      btnToggleLogin.textContent = loginPwdInput.type === 'password' ? '👁' : '🙈';
    });
  }

  // Handle Auth Form Submission (Login or Setup)
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (errBanner) errBanner.style.display = 'none';
      if (spinner) spinner.style.display = 'inline-block';
      if (btnText) btnText.style.opacity = '0.5';

      try {
        if (!state.authConfig.isConfigured) {
          // Setup mode
          const p1 = document.getElementById('setup-password-input').value;
          const p2 = document.getElementById('setup-confirm-input').value;

          if (!p1 || p1.length < 6) {
            throw new Error('Password must be at least 6 characters long');
          }
          if (p1 !== p2) {
            throw new Error('Passwords do not match');
          }

          const res = await _originalFetch('/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: p1 }),
            credentials: 'include'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Setup failed');

          state.token = data.token;
          state.apiKey = data.apiKey;
          if (data.token) localStorage.setItem('ht_token', data.token);
          if (data.apiKey) localStorage.setItem('ht_api_key', data.apiKey);
          state.authConfig.isConfigured = true;

          const currentUser = data.user || {
            id: 'admin',
            role: 'admin',
            email: 'admin@local',
            name: 'Master Admin'
          };
          state.currentUser = currentUser;
          applyRolePermissions(currentUser);

          hideAuthModal();
          showToast('Master password successfully configured! API Key generated.', 'success');
          await checkAuthStatus();
        } else {
          // Login mode
          const password = document.getElementById('login-password-input').value;
          if (!password) {
            throw new Error('Please enter master password');
          }

          const res = await _originalFetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
            credentials: 'include'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Login failed');

          state.token = data.token;
          state.apiKey = data.apiKey;
          if (data.token) localStorage.setItem('ht_token', data.token);
          if (data.apiKey) localStorage.setItem('ht_api_key', data.apiKey);

          const currentUser = data.user || {
            id: 'admin',
            role: 'admin',
            email: 'admin@local',
            name: 'Master Admin'
          };
          state.currentUser = currentUser;
          applyRolePermissions(currentUser);

          hideAuthModal();
          showToast('Master access granted! Welcome back.', 'success');
          await checkAuthStatus();
        }
      } catch (err) {
        if (errBanner) {
          errBanner.textContent = err.message;
          errBanner.style.display = 'flex';
        }
      } finally {
        if (spinner) spinner.style.display = 'none';
        if (btnText) btnText.style.opacity = '1';
      }
    });
  }

  // Security Settings Modal & Header Triggers
  const secModal = document.getElementById('modal-security');
  const btnOpenSec = document.getElementById('btn-open-security-modal');
  const btnCloseSec = document.getElementById('btn-close-security-modal');
  const btnCloseSecFooter = document.getElementById('btn-close-security-footer');
  const apiKeyDisplay = document.getElementById('display-api-key');
  const btnCopyApiKey = document.getElementById('btn-copy-api-key');
  const btnToggleKeyVis = document.getElementById('btn-toggle-key-vis');
  const btnRegenApiKey = document.getElementById('btn-regen-api-key');
  const btnSaveSecSettings = document.getElementById('btn-save-sec-settings');
  const btnSaveNewPwd = document.getElementById('btn-save-new-pwd');
  const btnLogoutHeader = document.getElementById('btn-logout-header');

  const toggleAuthEnabled = document.getElementById('toggle-auth-enabled');
  const toggleLocalBypass = document.getElementById('toggle-local-bypass');

  // Subtabs switching inside Security Modal
  const secTabs = document.querySelectorAll('.sec-tab-btn');
  secTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-sectab');
      secTabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const pMaster = document.getElementById('sec-pane-master');
      const pGoogle = document.getElementById('sec-pane-google');
      const pUsers = document.getElementById('sec-pane-users');

      if (pMaster) pMaster.style.display = targetTab === 'master' ? 'block' : 'none';
      if (pGoogle) pGoogle.style.display = targetTab === 'google' ? 'block' : 'none';
      if (pUsers) pUsers.style.display = targetTab === 'users' ? 'block' : 'none';

      if (targetTab === 'google') loadGoogleOAuthConfig();
      if (targetTab === 'users') loadUsersManagementTable();
    });
  });

  // Google OAuth Config Handlers
  let _googleConfigLoaded = false;

  async function loadGoogleOAuthConfig() {
    _googleConfigLoaded = false;
    const saveBtn = document.getElementById('btn-save-google-config');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.5'; }

    try {
      const res = await fetch('/api/auth/google-config');
      if (res.status === 401 || res.status === 403) {
        showToast('Admin authentication required to view Google OAuth settings. Please log in with master password first.', 'error');
        return;
      }
      if (!res.ok) throw new Error('Failed to load Google configuration');
      const data = await res.json();

      const toggleGoogle = document.getElementById('toggle-google-auth');
      const inputClientId = document.getElementById('input-google-client-id');
      const inputClientSec = document.getElementById('input-google-client-secret');
      const displayCbUrl = document.getElementById('display-google-callback-url');
      const inputAdminEmails = document.getElementById('input-admin-emails');
      const inputAllowedEmails = document.getElementById('input-allowed-emails');
      const inputAllowedDomains = document.getElementById('input-allowed-domains');
      const inputMaxActive = document.getElementById('input-quota-max-active');
      const inputMaxStorage = document.getElementById('input-quota-max-storage');

      if (toggleGoogle) toggleGoogle.checked = Boolean(data.enabled);
      if (inputClientId) inputClientId.value = data.clientId || '';
      if (inputClientSec) {
        inputClientSec.value = ''; // always clear - never pre-fill secrets
        inputClientSec.placeholder = data.hasSecret ? '•••••••••••••••• (configured)' : 'Paste client secret';
      }
      if (displayCbUrl) displayCbUrl.value = data.callbackUrl || '';
      if (inputAdminEmails) inputAdminEmails.value = (data.adminEmails || []).join(', ');
      if (inputAllowedEmails) inputAllowedEmails.value = (data.allowedEmails || []).join(', ');
      if (inputAllowedDomains) inputAllowedDomains.value = (data.allowedDomains || []).join(', ');

      const q = data.defaultUserQuota || {};
      if (inputMaxActive) inputMaxActive.value = q.maxActiveTorrents || 3;
      if (inputMaxStorage) inputMaxStorage.value = Math.round((q.maxStorageBytes || 21474836480) / (1024 * 1024 * 1024));

      _googleConfigLoaded = true;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = '1'; }
    } catch (err) {
      showToast('Error loading Google OAuth settings: ' + err.message, 'error');
    }
  }

  // Toggle client secret visibility
  const btnToggleSecretVis = document.getElementById('btn-toggle-secret-vis');
  const inputSecret = document.getElementById('input-google-client-secret');
  if (btnToggleSecretVis && inputSecret) {
    btnToggleSecretVis.addEventListener('click', () => {
      inputSecret.type = inputSecret.type === 'password' ? 'text' : 'password';
      btnToggleSecretVis.textContent = inputSecret.type === 'password' ? '👁' : '🙈';
    });
  }

  // Copy Google Callback URL
  const btnCopyCb = document.getElementById('btn-copy-callback-url');
  const displayCb = document.getElementById('display-google-callback-url');
  if (btnCopyCb && displayCb) {
    btnCopyCb.addEventListener('click', () => {
      if (displayCb.value) {
        navigator.clipboard.writeText(displayCb.value);
        showToast('Authorized Redirect URI copied to clipboard!', 'success');
      }
    });
  }

  // Save Google OAuth Configuration
  const btnSaveGoogle = document.getElementById('btn-save-google-config');
  if (btnSaveGoogle) {
    btnSaveGoogle.addEventListener('click', async () => {
      try {
        // SAFETY: Prevent saving when config wasn't loaded (avoids overwriting real values with empty)
        if (!_googleConfigLoaded) {
          showToast('Cannot save: Google OAuth settings were not loaded. Please reload the page and try again.', 'error');
          return;
        }

        const enabled = document.getElementById('toggle-google-auth').checked;
        const clientId = (document.getElementById('input-google-client-id').value || '').trim();
        const secretVal = (document.getElementById('input-google-client-secret').value || '').trim();
        const adminEmails = document.getElementById('input-admin-emails').value;
        const allowedEmails = document.getElementById('input-allowed-emails').value;
        const allowedDomains = document.getElementById('input-allowed-domains').value;
        const maxActive = parseInt(document.getElementById('input-quota-max-active').value, 10) || 3;
        const maxStorageGB = parseInt(document.getElementById('input-quota-max-storage').value, 10) || 20;

        // Validate Client ID format
        if (enabled && clientId && !clientId.endsWith('.apps.googleusercontent.com')) {
          showToast('Warning: Client ID should end with ".apps.googleusercontent.com". Please verify your Google Cloud Console credentials.', 'error');
          return;
        }

        const payload = {
          enabled,
          clientId,
          adminEmails,
          allowedEmails,
          allowedDomains,
          defaultUserQuota: {
            maxActiveTorrents: maxActive,
            maxStorageBytes: maxStorageGB * 1024 * 1024 * 1024
          }
        };
        if (secretVal) {
          payload.clientSecret = secretVal;
        }

        const res = await fetch('/api/auth/google-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save Google OAuth settings');

        showToast('Google OAuth 2.0 configuration saved!', 'success');
        // Reload config to refresh callback URL and other derived values
        await loadGoogleOAuthConfig();
        checkAuthStatus();
      } catch (err) {
        showToast('Error saving Google settings: ' + err.message, 'error');
      }
    });
  }

  // Users & Quotas Management Table Loader
  async function loadUsersManagementTable() {
    const tbody = document.getElementById('users-table-body');
    const badge = document.getElementById('sec-users-count-badge');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:1.5rem;">Loading users and live quotas...</td></tr>`;

    try {
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error('Failed to fetch user accounts');
      const data = await res.json();
      const users = data.users || [];

      if (badge) badge.textContent = users.length;

      if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:1.5rem;">No registered users yet. Sign in with Google to create accounts.</td></tr>`;
        return;
      }

      tbody.innerHTML = '';
      users.forEach(u => {
        const tr = document.createElement('tr');
        const usage = u.usage || { totalStorageBytes: 0, activeTorrents: 0 };
        const quota = u.quota || { maxStorageBytes: 21474836480, maxActiveTorrents: 3 };

        const percent = Math.min(100, Math.round((usage.totalStorageBytes / quota.maxStorageBytes) * 100));
        const barClass = percent > 90 ? 'danger' : (percent > 70 ? 'warning' : '');

        const avatarHtml = u.picture
          ? `<img src="${u.picture}" class="user-cell-avatar" alt="Avatar" />`
          : `<div class="user-cell-initials">${(u.name || u.email || 'U')[0].toUpperCase()}</div>`;

        tr.innerHTML = `
          <td>
            <div class="user-cell-profile">
              ${avatarHtml}
              <div class="user-cell-meta">
                <span class="user-cell-name">${u.name || 'User'}</span>
                <span class="user-cell-email">${u.email}</span>
              </div>
            </div>
          </td>
          <td>
            <select class="role-badge-select" data-userid="${u.id}">
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>USER</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>ADMIN</option>
            </select>
          </td>
          <td>
            <span style="font-family:monospace; font-weight:600;">${usage.activeTorrents}</span> / <span style="font-family:monospace; color:var(--text-muted);">${quota.maxActiveTorrents}</span>
          </td>
          <td>
            <div class="quota-progress-cell">
              <div class="quota-progress-bar">
                <div class="quota-progress-fill ${barClass}" style="width: ${percent}%;"></div>
              </div>
              <span class="quota-text-sub">${formatBytes(usage.totalStorageBytes)} / ${formatBytes(quota.maxStorageBytes)} (${percent}%)</span>
            </div>
          </td>
          <td>
            <span class="status-indicator-pill ${u.status || 'active'}">${(u.status || 'active').toUpperCase()}</span>
          </td>
          <td>
            <div class="user-action-btn-group">
              <button class="btn-user-action btn-edit-quota" data-userid="${u.id}" data-currtorrents="${quota.maxActiveTorrents}" data-currstorage="${Math.round(quota.maxStorageBytes / (1024*1024*1024))}" title="Edit Quota">Quota</button>
              <button class="btn-user-action btn-toggle-ban" data-userid="${u.id}" data-currstatus="${u.status || 'active'}" title="${u.status === 'banned' ? 'Unban User' : 'Ban User'}">${u.status === 'banned' ? 'Unban' : 'Ban'}</button>
              <button class="btn-user-action danger btn-delete-user" data-userid="${u.id}" data-useremail="${u.email}" title="Delete User">Del</button>
            </div>
          </td>
        `;

        tbody.appendChild(tr);
      });

      // Role Select Change Handler
      tbody.querySelectorAll('.role-badge-select').forEach(sel => {
        sel.addEventListener('change', async (e) => {
          const userId = e.target.getAttribute('data-userid');
          const newRole = e.target.value;
          try {
            const r = await fetch(`/api/users/${encodeURIComponent(userId)}/role`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role: newRole })
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Failed to update user role');
            showToast(`Role updated to ${newRole.toUpperCase()}!`, 'success');
          } catch (err) {
            showToast(err.message, 'error');
            loadUsersManagementTable();
          }
        });
      });

      // Quota Edit Button Handler
      tbody.querySelectorAll('.btn-edit-quota').forEach(btn => {
        btn.addEventListener('click', async () => {
          const userId = btn.getAttribute('data-userid');
          const currT = btn.getAttribute('data-currtorrents');
          const currS = btn.getAttribute('data-currstorage');

          const newT = prompt(`Enter max active torrents limit for this user:`, currT);
          if (newT === null) return;
          const newS = prompt(`Enter max storage quota in GB for this user:`, currS);
          if (newS === null) return;

          try {
            const r = await fetch(`/api/users/${encodeURIComponent(userId)}/quota`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                maxActiveTorrents: parseInt(newT, 10) || 3,
                maxStorageBytes: (parseInt(newS, 10) || 20) * 1024 * 1024 * 1024
              })
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Failed to update quota');
            showToast('User quota updated successfully!', 'success');
            loadUsersManagementTable();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });

      // Toggle Ban Handler
      tbody.querySelectorAll('.btn-toggle-ban').forEach(btn => {
        btn.addEventListener('click', async () => {
          const userId = btn.getAttribute('data-userid');
          const currStatus = btn.getAttribute('data-currstatus');
          const newStatus = currStatus === 'banned' ? 'active' : 'banned';

          try {
            const r = await fetch(`/api/users/${encodeURIComponent(userId)}/status`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: newStatus })
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Failed to update user status');
            showToast(`User status set to ${newStatus.toUpperCase()}`, 'info');
            loadUsersManagementTable();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });

      // Delete User Handler
      tbody.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          const userId = btn.getAttribute('data-userid');
          const userEmail = btn.getAttribute('data-useremail');
          if (!confirm(`Delete user account for "${userEmail}"? Their quota and permissions will be reset.`)) return;

          try {
            const r = await fetch(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Failed to delete user');
            showToast('User account removed.', 'info');
            loadUsersManagementTable();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });

    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#f87171; padding:1.5rem;">Failed to load users: ${err.message}</td></tr>`;
    }
  }

  const btnRefreshUsers = document.getElementById('btn-refresh-users');
  if (btnRefreshUsers) {
    btnRefreshUsers.addEventListener('click', loadUsersManagementTable);
  }

  // Open Security Modal (Admin Only)
  if (btnOpenSec && secModal) {
    btnOpenSec.addEventListener('click', async () => {
      if (!state.currentUser || state.currentUser.role !== 'admin') {
        showToast('Security settings & user management are restricted to Administrators.', 'warning');
        return;
      }
      openModal(secModal);

      try {
        const [statRes, keyRes] = await Promise.all([
          fetch('/api/auth/status'),
          fetch('/api/auth/api-key')
        ]);
        const statData = await statRes.json();
        const keyData = await keyRes.json();

        state.authConfig = statData;
        if (toggleAuthEnabled) toggleAuthEnabled.checked = statData.authEnabled;
        if (toggleLocalBypass) toggleLocalBypass.checked = !statData.requireLocalAuth;
        if (apiKeyDisplay && keyData.apiKey) {
          apiKeyDisplay.value = keyData.apiKey;
          state.apiKey = keyData.apiKey;
          localStorage.setItem('ht_api_key', keyData.apiKey);
        }
      } catch (err) {
        showToast('Failed to load security settings: ' + err.message, 'error');
      }
    });
  }

  // Close Security Modal
  [btnCloseSec, btnCloseSecFooter].forEach(btn => {
    if (btn && secModal) {
      btn.addEventListener('click', () => {
        closeModal(secModal);
      });
    }
  });

  // Copy API Key
  if (btnCopyApiKey && apiKeyDisplay) {
    btnCopyApiKey.addEventListener('click', () => {
      if (apiKeyDisplay.value && apiKeyDisplay.value !== 'Loading...') {
        navigator.clipboard.writeText(apiKeyDisplay.value);
        showToast('API Key copied to clipboard! Paste it into Chrome Extension or IDM.', 'success');
      }
    });
  }

  // Toggle API Key visibility
  if (btnToggleKeyVis && apiKeyDisplay) {
    btnToggleKeyVis.addEventListener('click', () => {
      apiKeyDisplay.type = apiKeyDisplay.type === 'password' ? 'text' : 'password';
      btnToggleKeyVis.textContent = apiKeyDisplay.type === 'password' ? '👁' : '🙈';
    });
  }

  // Regenerate API Key
  if (btnRegenApiKey) {
    btnRegenApiKey.addEventListener('click', async () => {
      if (confirm('Regenerate API Key? Any browser extensions or scripts using the current key will need to be updated.')) {
        try {
          const res = await fetch('/api/auth/regenerate-key', { method: 'POST' });
          const data = await res.json();
          if (data.apiKey) {
            apiKeyDisplay.value = data.apiKey;
            state.apiKey = data.apiKey;
            localStorage.setItem('ht_api_key', data.apiKey);
            showToast('New API key generated successfully!', 'success');
          }
        } catch (err) {
          showToast('Failed to regenerate API key: ' + err.message, 'error');
        }
      }
    });
  }

  // Save Access Settings (Toggles)
  if (btnSaveSecSettings) {
    btnSaveSecSettings.addEventListener('click', async () => {
      try {
        const authEnabled = toggleAuthEnabled ? toggleAuthEnabled.checked : true;
        const requireLocalAuth = toggleLocalBypass ? !toggleLocalBypass.checked : true;

        const res = await fetch('/api/auth/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authEnabled, requireLocalAuth })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update settings');

        state.authConfig = data.config;
        showToast('Master access settings saved successfully!', 'success');
        secModal.classList.remove('open');
      } catch (err) {
        showToast('Failed to save settings: ' + err.message, 'error');
      }
    });
  }

  // Change Password
  if (btnSaveNewPwd) {
    btnSaveNewPwd.addEventListener('click', async () => {
      const currPwd = document.getElementById('change-curr-pwd').value;
      const newPwd = document.getElementById('change-new-pwd').value;

      if (!currPwd || !newPwd) {
        showToast('Please enter both current and new password', 'error');
        return;
      }
      if (newPwd.length < 6) {
        showToast('New password must be at least 6 characters', 'error');
        return;
      }

      try {
        const res = await fetch('/api/auth/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: currPwd, newPassword: newPwd })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Password update failed');

        document.getElementById('change-curr-pwd').value = '';
        document.getElementById('change-new-pwd').value = '';
        showToast('Master password successfully updated!', 'success');
      } catch (err) {
        showToast('Failed to update password: ' + err.message, 'error');
      }
    });
  }

  // Logout Button in Header
  if (btnLogoutHeader) {
    btnLogoutHeader.addEventListener('click', async () => {
      try {
        await _originalFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      } catch (e) {}

      state.token = null;
      state.currentUser = null;
      localStorage.removeItem('ht_token');
      applyRolePermissions(null);

      const userBadge = document.getElementById('header-user-badge');
      if (userBadge) userBadge.style.display = 'none';

      if (state.ws) {
        try { state.ws.close(); } catch (e) {}
      }

      showToast('Session logged out.', 'info');
      checkAuthStatus();
    });
  }
}

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  setupModals();
  setupToolbarAndTabs();
  setupSearchModal();
  setupTurboBoostControls();
  setupProxyModal();
  setupDiskStorageModal();
  setupTurboDownloaderModal();
  setupMobileNavigation();
  setupProfileModal();
  setupDrawerTouchDismiss();
  setupAuthSystem();
  checkAuthStatus();
  checkUrlParamsForMagnets();
});



