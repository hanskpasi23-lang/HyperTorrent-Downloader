// HyperTorrent Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "hypertorrent-download-link",
    title: "⚡ Download with HyperTorrent",
    contexts: ["link", "selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let magnetURI = null;

  if (info.linkUrl && info.linkUrl.startsWith('magnet:?')) {
    magnetURI = info.linkUrl;
  } else if (info.selectionText && info.selectionText.includes('magnet:?')) {
    const match = info.selectionText.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s]*/);
    if (match) magnetURI = match[0];
  }

  if (magnetURI) {
    fetch('http://localhost:3000/api/torrents/magnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnetURI })
    })
    .catch(err => console.error('HyperTorrent background add failed:', err));
  }
});
