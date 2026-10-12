function formatSpeed(bytes) {
  if (!bytes) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

const serverUrlInput = document.getElementById('popup-server-url');
const apiKeyInput = document.getElementById('popup-api-key');

async function getServerConfig() {
  const data = await chrome.storage.local.get(['serverUrl', 'apiKey']);
  const serverUrl = (data.serverUrl || 'http://localhost:3000').replace(/\/+$/, '');
  const apiKey = data.apiKey || '';
  return { serverUrl, apiKey };
}

// Load saved Server URL and API Key
chrome.storage.local.get(['serverUrl', 'apiKey'], (res) => {
  if (serverUrlInput) {
    serverUrlInput.value = res.serverUrl || 'http://localhost:3000';
  }
  if (apiKeyInput && res.apiKey) {
    apiKeyInput.value = res.apiKey;
  }
  refreshStatus();
});

if (serverUrlInput) {
  serverUrlInput.addEventListener('change', () => {
    let val = serverUrlInput.value.trim().replace(/\/+$/, '');
    if (!val) val = 'http://localhost:3000';
    chrome.storage.local.set({ serverUrl: val }, () => {
      refreshStatus();
    });
  });
}

if (apiKeyInput) {
  apiKeyInput.addEventListener('change', () => {
    chrome.storage.local.set({ apiKey: apiKeyInput.value.trim() }, () => {
      refreshStatus();
    });
  });
}

function getHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  return headers;
}

async function refreshStatus() {
  const { serverUrl, apiKey } = await getServerConfig();
  const badge = document.getElementById('popup-status');

  fetch(`${serverUrl}/api/status`, { headers: getHeaders(apiKey) })
    .then(res => res.json())
    .then(data => {
      badge.textContent = 'ONLINE';
      badge.className = 'status-badge';
      document.getElementById('popup-speed').textContent = formatSpeed(data.downloadSpeed);
      document.getElementById('popup-torrents').textContent = data.totalTorrents;
    })
    .catch(() => {
      badge.textContent = 'OFFLINE';
      badge.className = 'status-badge offline';
    });
}

document.getElementById('btn-popup-add').addEventListener('click', async () => {
  const val = document.getElementById('popup-magnet-input').value.trim();
  if (!val) return;

  const { serverUrl, apiKey } = await getServerConfig();

  fetch(`${serverUrl}/api/torrents/magnet`, {
    method: 'POST',
    headers: getHeaders(apiKey),
    body: JSON.stringify({ magnetURI: val })
  })
  .then(res => res.json())
  .then((data) => {
    if (data.error) throw new Error(data.error);
    alert('Torrent added to HyperTorrent engine!');
    document.getElementById('popup-magnet-input').value = '';
    refreshStatus();
  })
  .catch(err => alert('Failed: ' + err.message));
});

document.getElementById('btn-popup-dashboard').addEventListener('click', async () => {
  const { serverUrl } = await getServerConfig();
  chrome.tabs.create({ url: serverUrl });
});
