const SERVER = 'http://localhost:3000';

function formatSpeed(bytes) {
  if (!bytes) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

fetch(`${SERVER}/api/status`)
  .then(res => res.json())
  .then(data => {
    document.getElementById('popup-status').textContent = 'ONLINE';
    document.getElementById('popup-speed').textContent = formatSpeed(data.downloadSpeed);
    document.getElementById('popup-torrents').textContent = data.totalTorrents;
  })
  .catch(() => {
    const badge = document.getElementById('popup-status');
    badge.textContent = 'OFFLINE';
    badge.className = 'status-badge offline';
  });

document.getElementById('btn-popup-add').addEventListener('click', () => {
  const val = document.getElementById('popup-magnet-input').value.trim();
  if (!val) return;

  fetch(`${SERVER}/api/torrents/magnet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnetURI: val })
  })
  .then(res => res.json())
  .then(() => {
    alert('Torrent added to HyperTorrent engine!');
    document.getElementById('popup-magnet-input').value = '';
  })
  .catch(err => alert('Failed: ' + err.message));
});

document.getElementById('btn-popup-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: SERVER });
});
