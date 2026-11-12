const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenshareApp', {
  platform: process.platform,
  listAudio: () => ipcRenderer.invoke('audio:list'),
  startAudio: id => ipcRenderer.invoke('audio:start', id),
  stopAudio: () => ipcRenderer.invoke('audio:stop'),
  onPickSource: cb => ipcRenderer.on('pick-source', (_e, sources) => cb(sources)),
  pickSource: id => ipcRenderer.send('pick-source:result', id),
  getEncoder: () => ipcRenderer.invoke('encoder:get'),
  setEncoder: v => ipcRenderer.invoke('encoder:set', v),
  restart: () => ipcRenderer.invoke('app:restart'),
  openRemote: () => ipcRenderer.invoke('remote:open'),
});

// MessagePorts can't cross the context bridge, so hand the audio port to the page with postMessage.
ipcRenderer.on('audio:port', e => window.postMessage('screenshare-audio-port', '*', e.ports));
