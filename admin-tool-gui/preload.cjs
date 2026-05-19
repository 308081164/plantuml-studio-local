const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adminGui', {
  getKeyStatus: () => ipcRenderer.invoke('admin:get-key-status'),
  initKeys: (overwrite) => ipcRenderer.invoke('admin:init-keys', { overwrite }),
  generateLicense: (params) => ipcRenderer.invoke('admin:generate-license', params),
  verifyLicense: (code) => ipcRenderer.invoke('admin:verify-license', { code }),
  deviceCodeFromHwFields: (fields) => ipcRenderer.invoke('admin:device-code', fields),
  saveLicenseToFile: (code) => ipcRenderer.invoke('admin:save-license-file', { code }),
  generateMonthlyKey: () => ipcRenderer.invoke('admin:generate-monthly-key'),
  registerMonthlyKey: (payload) => ipcRenderer.invoke('admin:register-monthly-key', payload || {}),
});
