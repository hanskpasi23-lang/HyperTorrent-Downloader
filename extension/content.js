// HyperTorrent Browser Extension - In-Page Magnet Interceptor & Auto-Filter

(function () {
  // Listen for click events anywhere on the page
  document.addEventListener('click', function (e) {
    const link = e.target.closest('a');
    if (!link) return;

    const href = link.getAttribute('href');
    if (href && href.startsWith('magnet:?')) {
      e.preventDefault();
      e.stopPropagation();
      sendMagnetToEngine(href);
    }
  }, true);

  async function sendMagnetToEngine(magnetURI) {
    showInPageNotification('⚡ Sending magnet to HyperTorrent engine...', '#00f2fe');

    try {
      const data = await chrome.storage.local.get(['serverUrl', 'apiKey']);
      const serverUrl = (data.serverUrl || 'http://localhost:3000').replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (data.apiKey) {
        headers['X-API-Key'] = data.apiKey;
      }

      const res = await fetch(`${serverUrl}/api/torrents/magnet`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ magnetURI })
      });

      const resData = await res.json();
      if (resData.error) throw new Error(resData.error);
      const name = resData.torrent ? resData.torrent.name : 'Torrent';
      showInPageNotification(`⚡ HyperTorrent: "${name}" started downloading!`, '#10b981');
    } catch (err) {
      showInPageNotification(`HyperTorrent error: ${err.message}. Check VPS server URL / API key in extension settings.`, '#ef4444');
    }
  }

  function showInPageNotification(message, color = '#00f2fe') {
    let toast = document.getElementById('hypertorrent-extension-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'hypertorrent-extension-toast';
      toast.style.position = 'fixed';
      toast.style.bottom = '24px';
      toast.style.right = '24px';
      toast.style.padding = '12px 20px';
      toast.style.borderRadius = '12px';
      toast.style.backgroundColor = '#0b1120';
      toast.style.color = '#ffffff';
      toast.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      toast.style.fontSize = '14px';
      toast.style.fontWeight = '600';
      toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.8), 0 0 15px rgba(0,242,254,0.3)';
      toast.style.zIndex = '2147483647';
      toast.style.transition = 'all 0.3s ease';
      document.body.appendChild(toast);
    }

    toast.style.borderLeft = `4px solid ${color}`;
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(15px)';
    }, 4500);
  }
})();
