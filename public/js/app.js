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
  wsConnected: false
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
// WebSocket Telemetry Connection
// --------------------------------------------------------------------------

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

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

  state.ws.onclose = () => {
    state.wsConnected = false;
    updateStatusIndicator(false);
    setTimeout(initWebSocket, 2000); // Auto reconnect
  };

  state.ws.onerror = () => {
    state.ws.close();
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
  const completedCount = state.torrents.filter(t => t.status === 'completed').length;
  const pausedCount = state.torrents.filter(t => t.status === 'paused').length;

  document.getElementById('count-all').textContent = state.torrents.length;
  document.getElementById('count-downloading').textContent = downloadingCount;
  document.getElementById('count-completed').textContent = completedCount;
  document.getElementById('count-paused').textContent = pausedCount;

  // Update live trackers count
  const trackersCountEl = document.getElementById('global-trackers-count');
  if (trackersCountEl) {
    trackersCountEl.textContent = `${state.globalStats.cachedTrackersCount || 0} LIVE`;
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

  // Render cards
  container.innerHTML = filtered.map(t => {
    const percent = Math.floor(t.progress * 100);
    const isSelected = state.selectedHash === t.infoHash;
    const isPaused = t.status === 'paused';
    const isCompleted = t.status === 'completed';

    return `
      <div class="torrent-card ${isSelected ? 'selected' : ''}" data-hash="${t.infoHash}">
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
            </button>
            <button class="btn-icon inspect-btn" data-hash="${t.infoHash}" title="Inspect Swarm & Pieces">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            </button>
            <button class="btn-icon danger delete-btn" data-hash="${t.infoHash}" title="Delete Torrent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </div>

        <div class="progress-container">
          <div class="progress-track">
            <div class="progress-fill ${isCompleted ? 'completed' : (isPaused ? 'paused' : '')}" style="width: ${percent}%;"></div>
          </div>
          <div class="progress-info-row">
            <span class="progress-percentage font-mono">${percent}%</span>
            <span class="font-mono">${formatBytes(t.downloaded)} of ${formatBytes(t.length)}</span>
          </div>
        </div>

        <div class="card-metrics-row font-mono">
          <div class="metric-item rate-down">
            <span>↓</span> <strong>${formatSpeed(t.downloadSpeed)}</strong>
          </div>
          <div class="metric-item rate-up">
            <span>↑</span> <strong>${formatSpeed(t.uploadSpeed)}</strong>
          </div>
          <div class="metric-item">
            <span>Peers:</span> <strong>${t.numPeers}</strong>
          </div>
          <div class="metric-item">
            <span>ETA:</span> <strong>${formatETA(t.timeRemaining)}</strong>
          </div>
          <div class="metric-item">
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
  document.querySelectorAll('.torrent-card, .inspect-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pause-btn') || e.target.closest('.resume-btn') || 
          e.target.closest('.delete-btn') || e.target.closest('.seq-btn') || 
          e.target.closest('.boost-btn')) {
        return; // Don't trigger inspect when clicking other controls
      }
      const hash = el.dataset.hash || el.closest('.torrent-card').dataset.hash;
      openDetailDrawer(hash);
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
  state.selectedHash = null;
  const drawer = document.getElementById('detail-drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  unsubscribeTorrentDetails();
  renderTorrentsList();
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
  const peersBody = document.getElementById('peers-table-body');
  if (details.peers && details.peers.length > 0) {
    peersBody.innerHTML = details.peers.map(p => `
      <tr>
        <td class="font-mono">${escapeHtml(p.ip)}:${p.port}</td>
        <td>${escapeHtml(p.client || 'BitTorrent')}</td>
        <td class="font-mono" style="color: var(--cyan-400);">${formatSpeed(p.downloadSpeed)}</td>
        <td class="font-mono" style="color: var(--violet-500);">${formatSpeed(p.uploadSpeed)}</td>
        <td class="font-mono">${formatBytes(p.downloaded)}</td>
        <td><span class="badge" style="background: ${p.choked ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)'}; color: ${p.choked ? '#ef4444' : '#10b981'};">${p.choked ? 'Choked' : 'Unchoked'}</span></td>
      </tr>
    `).join('');
  } else {
    peersBody.innerHTML = `<tr><td colspan="6" class="text-center">Searching swarm for peers...</td></tr>`;
  }

  // Files Tab
  document.getElementById('drawer-file-count').textContent = details.files ? details.files.length : 0;
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
          ${isMedia ? `
            <button class="btn btn-secondary stream-file-btn" data-hash="${details.infoHash}" data-index="${f.index}" data-name="${escapeHtml(f.name)}" data-size="${formatBytes(f.length)}" style="padding: 0.35rem 0.75rem; font-size: 0.75rem;">
              ▶ Stream
            </button>
          ` : ''}
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

  // Hover detection
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);

    const col = Math.floor(mouseX / cellW);
    const row = Math.floor(mouseY / cellH);
    const index = row * cols + col;

    const tip = document.getElementById('piece-hover-tip');
    if (index >= 0 && index < count) {
      const isDownloaded = pieces[index] === 1;
      tip.textContent = `Piece #${index}: ${isDownloaded ? 'Complete (Verified)' : 'Pending / Missing'}`;
    }
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

  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeStreamModal() {
  const modal = document.getElementById('modal-stream');
  const player = document.getElementById('stream-video-player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

// --------------------------------------------------------------------------
// Add Magnet & Upload Modals
// --------------------------------------------------------------------------

function setupModals() {
  // Magnet Modal
  const magnetModal = document.getElementById('modal-magnet');
  const magnetInput = document.getElementById('magnet-input');

  document.getElementById('btn-open-magnet-modal').onclick = () => {
    magnetModal.classList.add('open');
    magnetInput.focus();
  };
  document.getElementById('btn-empty-add-magnet').onclick = () => {
    magnetModal.classList.add('open');
    magnetInput.focus();
  };
  document.getElementById('btn-close-magnet-modal').onclick = () => magnetModal.classList.remove('open');
  document.getElementById('btn-cancel-magnet').onclick = () => magnetModal.classList.remove('open');

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
    magnetModal.classList.add('open');
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
      magnetModal.classList.remove('open');
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

  document.getElementById('btn-open-upload-modal').onclick = () => uploadModal.classList.add('open');
  document.getElementById('btn-close-upload-modal').onclick = () => uploadModal.classList.remove('open');
  document.getElementById('btn-cancel-upload').onclick = () => uploadModal.classList.remove('open');

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
      uploadModal.classList.remove('open');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Video Stream Modal Close
  document.getElementById('btn-close-stream-modal').onclick = closeStreamModal;
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
// Browser Magnet Link Auto-Capture & Protocol Handler
// --------------------------------------------------------------------------

function setupProtocolHandler() {
  const btn = document.getElementById('btn-register-handler');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if ('registerProtocolHandler' in navigator) {
      try {
        const handlerUrl = `${window.location.origin}/?magnet=%s`;
        navigator.registerProtocolHandler('magnet', handlerUrl);
        showToast('Registered HyperTorrent as default browser magnet handler!', 'success');
      } catch (err) {
        showToast('Browser requires permission or HTTPS to register handler: ' + err.message, 'error');
      }
    } else {
      showToast('Your browser does not support registerProtocolHandler', 'error');
    }
  });
}

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
// Desktop / Electron Integration
// --------------------------------------------------------------------------

function setupDesktopIntegration() {
  const btnOpenFolder = document.getElementById('btn-open-downloads-folder');
  if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', async () => {
      if (window.electronAPI?.openDownloadsFolder) {
        await window.electronAPI.openDownloadsFolder();
        showToast('Opening Downloads folder in File Explorer...', 'info');
      } else {
        showToast('Downloads folder: ./downloads', 'info');
      }
    });
  }

  // Also make save-dir in drawer clickable
  const saveDirEl = document.getElementById('ov-savedir');
  if (saveDirEl) {
    saveDirEl.style.cursor = 'pointer';
    saveDirEl.title = 'Click to open in File Explorer';
    saveDirEl.addEventListener('click', () => {
      if (window.electronAPI?.openDownloadsFolder) {
        window.electronAPI.openDownloadsFolder();
      }
    });
  }

  // Listen for incoming magnet links pushed from Electron
  if (window.electronAPI?.onMagnetReceived) {
    window.electronAPI.onMagnetReceived((magnetUri) => {
      showToast('⚡ Magnet link auto-received from desktop!', 'success');
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
    searchModal.classList.add('open');
    searchModal.setAttribute('aria-hidden', 'false');
    const input = document.getElementById('indexer-search-input');
    if (input) input.focus();
  });

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      searchModal.classList.remove('open');
      searchModal.setAttribute('aria-hidden', 'true');
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
      document.getElementById('modal-search').classList.remove('open');
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
          document.getElementById('modal-search').classList.remove('open');
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
        <button class="btn btn-primary btn-dl-sniff" data-magnet="${escapeHtml(item.magnetURI)}" style="padding: 0.45rem 1rem; font-size: 0.8rem;">
          Download
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
          document.getElementById('modal-search').classList.remove('open');
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
}

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  setupModals();
  setupToolbarAndTabs();
  setupSearchModal();
  setupProtocolHandler();
  setupTurboBoostControls();
  initWebSocket();
  checkUrlParamsForMagnets();
  setupDesktopIntegration();
});


