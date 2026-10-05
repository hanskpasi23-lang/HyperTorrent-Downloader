const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  openDownloadsFolder: () => ipcRenderer.invoke('open-downloads-folder'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onMagnetReceived: (callback) => {
    ipcRenderer.on('incoming-magnet', (_event, magnetUri) => callback(magnetUri));
  }
});
