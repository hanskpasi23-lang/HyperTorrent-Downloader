// HyperTorrent Background Service Worker with API Key Authentication

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "hypertorrent-download-link",
    title: "⚡ Download with HyperTorrent",
    contexts: ["link", "selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let magnetURI = null;

  if (info.linkUrl && info.linkUrl.startsWith('magnet:?')) {
    magnetURI = info.linkUrl;
  } else if (info.selectionText && info.selectionText.includes('magnet:?')) {
    const match = info.selectionText.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s]*/);
    if (match) magnetURI = match[0];
  }

  if (magnetURI) {
    const data = await chrome.storage.local.get(['apiKey', 'serverUrl']);
    const baseUrl = data.serverUrl || 'http://localhost:3000';
    const headers = { 'Content-Type': 'application/json' };

    if (data.apiKey) {
      headers['X-API-Key'] = data.apiKey;
    }

    fetch(`${baseUrl}/api/torrents/magnet`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ magnetURI })
    })
    .catch(err => console.error('HyperTorrent background add failed:', err));
  }
});
