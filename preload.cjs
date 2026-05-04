/* Preload 须为 CommonJS：Electron 沙箱预加载脚本不按 ES module 执行 */
const { contextBridge, ipcRenderer } = require('electron');

let menuCopyPreviewHandler = null;
ipcRenderer.on('studio:menu-copy-preview', () => {
  if (menuCopyPreviewHandler) menuCopyPreviewHandler();
});

let menuSessionLogHandler = null;
ipcRenderer.on('studio:menu-session-log', () => {
  if (menuSessionLogHandler) menuSessionLogHandler();
});

let menuErrorLogHandler = null;
ipcRenderer.on('studio:menu-error-log', () => {
  if (menuErrorLogHandler) menuErrorLogHandler();
});

let menuLicenseHandler = null;
ipcRenderer.on('studio:menu-license', () => {
  if (menuLicenseHandler) menuLicenseHandler();
});

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = binary.charCodeAt(i);
  return u8.buffer;
}

contextBridge.exposeInMainWorld('studio', {
  getApiBase: () => ipcRenderer.invoke('studio:get-api-base'),
  onServerLog: (cb) => {
    const fn = (_e, line) => cb(line);
    ipcRenderer.on('studio:server-log', fn);
    return () => ipcRenderer.removeListener('studio:server-log', fn);
  },
  /** 将 PNG 二进制写入系统剪贴板（主进程 nativeImage） */
  copyPngToClipboard: (arrayBuffer) => ipcRenderer.invoke('studio:clipboard-write-png', arrayBuffer),
  /** 将源码渲染为 PNG，返回 ArrayBuffer 供剪贴板或自行处理 */
  renderPngToBuffer: async (source) => {
    const r = await ipcRenderer.invoke('studio:render-png-buffer', { source });
    if (!r?.ok) return r;
    return { ok: true, arrayBuffer: base64ToArrayBuffer(r.base64) };
  },
  getAgentConfig: () => ipcRenderer.invoke('studio:agent-config-get'),
  setAgentConfig: (partial) => ipcRenderer.invoke('studio:agent-config-set', partial),
  runAgent: (userText) => ipcRenderer.invoke('studio:agent-run', { userText }),
  pickProjectDirectory: () => ipcRenderer.invoke('studio:pick-project-directory'),
  projectSummary: (rootPath) => ipcRenderer.invoke('studio:project-summary', { rootPath }),
  runAgentProject: (payload) => ipcRenderer.invoke('studio:agent-run-project', payload),
  projectContextEstimate: (payload) => ipcRenderer.invoke('studio:project-context-estimate', payload),
  onMenuCopyPreview: (cb) => {
    menuCopyPreviewHandler = typeof cb === 'function' ? cb : null;
    return () => {
      menuCopyPreviewHandler = null;
    };
  },
  onMenuSessionLog: (cb) => {
    menuSessionLogHandler = typeof cb === 'function' ? cb : null;
    return () => {
      menuSessionLogHandler = null;
    };
  },
  onMenuErrorLog: (cb) => {
    menuErrorLogHandler = typeof cb === 'function' ? cb : null;
    return () => {
      menuErrorLogHandler = null;
    };
  },
  onMenuLicense: (cb) => {
    menuLicenseHandler = typeof cb === 'function' ? cb : null;
    return () => {
      menuLicenseHandler = null;
    };
  },
  errorArchiveAppend: (payload) => ipcRenderer.invoke('studio:error-archive-append', payload),
  errorArchiveRead: () => ipcRenderer.invoke('studio:error-archive-read'),
  stashList: () => ipcRenderer.invoke('studio:stash-list'),
  stashAdd: (payload) => ipcRenderer.invoke('studio:stash-add', payload),
  stashRemove: (ids) => ipcRenderer.invoke('studio:stash-remove', { ids }),
  stashGetFull: (id) => ipcRenderer.invoke('studio:stash-get-full', { id }),
  stashCopy: (id) => ipcRenderer.invoke('studio:stash-copy', { id }),
  /* ---------- 授权与激活 ---------- */
  licenseGetDeviceInfo: () => ipcRenderer.invoke('studio:license-get-device-info'),
  licenseGetStatus: () => ipcRenderer.invoke('studio:license-get-status'),
  licenseActivate: (licenseCode) => ipcRenderer.invoke('studio:license-activate', { licenseCode }),
  licenseDeactivate: () => ipcRenderer.invoke('studio:license-deactivate'),
});
