// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge, ipcRenderer } from 'electron';

import type { NucleonSyncBridge } from '../bridge.ts';
import { IPC } from '../common/ipc.ts';

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
}

const bridge: NucleonSyncBridge = {
  status: () => ipcRenderer.invoke(IPC.request, 'GET', '/v1/status'),
  activity: (limit = 50) => ipcRenderer.invoke(IPC.request, 'GET', `/v1/activity?limit=${Number(limit)}`),
  sync: (req = {}) => ipcRenderer.invoke(IPC.request, 'POST', '/v1/sync', req),
  pause: (req = { scope: 'all' }) => ipcRenderer.invoke(IPC.request, 'POST', '/v1/pause', req),
  resume: (req = { scope: 'all' }) => ipcRenderer.invoke(IPC.request, 'POST', '/v1/resume', req),
  request: (method, path, body) => ipcRenderer.invoke(IPC.request, method, path, body),
  onEvent: (cb) => listen(IPC.event, cb),
  onConnection: (cb) => listen(IPC.connection, cb),
  connectionState: () => ipcRenderer.invoke(IPC.connectionState),
  uiState: () => ipcRenderer.invoke(IPC.getUiState),
  onUiState: (cb) => listen(IPC.uiState, cb),
  onNavigate: (cb) => listen(IPC.navigate, cb),
  pauseFor: (d) => ipcRenderer.invoke(IPC.pauseFor, d),
  showInFolder: (p) => ipcRenderer.invoke(IPC.showInFolder, p),
  openPath: (p) => ipcRenderer.invoke(IPC.openPath, p),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
  pickFolder: (p) => ipcRenderer.invoke(IPC.pickFolder, p),
  openMain: (screen) => ipcRenderer.send(IPC.openMain, screen),
  closeFlyout: () => ipcRenderer.send(IPC.closeFlyout),
  smokeReport: (data) => ipcRenderer.send(IPC.smoke, data),
  setup: (op, args) => ipcRenderer.invoke(IPC.setup, op, args),
  onSetupProgress: (cb) => listen(IPC.setupProgress, cb),
  setPrefs: (patch) => ipcRenderer.invoke(IPC.setPrefs, patch),
};

contextBridge.exposeInMainWorld('nucleonSync', bridge);
