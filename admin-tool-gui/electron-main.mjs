import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const licenseCommonDev = join(__dirname, '..', 'scripts', 'license-common.mjs');
const licenseCommonBundled = join(__dirname, 'license-common.mjs');
const licenseCommonPath = existsSync(licenseCommonBundled) ? licenseCommonBundled : licenseCommonDev;
const licenseMod = await import(licenseCommonPath);
const {
  generateKeyPair,
  generateHwId,
  generateDeviceCode,
  validateDeviceCodeFormat,
  verifyDeviceCode,
  generateLicenseCode,
  parseLicenseCode,
  verifyLicenseSignature,
  resolveIssuerPublicKeyBuffer,
} = licenseMod;

function adminDataDir() {
  const home = process.env.USERPROFILE || process.env.HOME || __dirname;
  return join(home, '.uml-master-admin');
}

function repoAdminToolDir() {
  return join(__dirname, '..', 'admin-tool');
}

function privateKeyPath() {
  const local = join(repoAdminToolDir(), '.issuer-private.der');
  if (existsSync(local)) return local;
  return join(adminDataDir(), 'ed25519-private.der');
}

function publicKeyPath() {
  const local = join(repoAdminToolDir(), '.issuer-public.der');
  if (existsSync(local)) return local;
  return join(adminDataDir(), 'ed25519-public.der');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 920,
    height: 820,
    minWidth: 720,
    minHeight: 640,
    title: 'UML大师激活码管理',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('admin:get-key-status', () => {
    const priv = privateKeyPath();
    const pub = publicKeyPath();
    const hasPrivate = existsSync(priv);
    const hasPublic = existsSync(pub);
    let publicHex = '';
    if (hasPublic) {
      try {
        publicHex = readFileSync(pub).toString('hex');
      } catch {
        /* ignore */
      }
    }
    return {
      ok: true,
      hasPrivate,
      hasPublic,
      privatePath: priv,
      publicPath: pub,
      publicHex,
      publicHexPreview: publicHex ? `${publicHex.slice(0, 32)}…` : '',
    };
  });

  ipcMain.handle('admin:init-keys', (_e, { overwrite }) => {
    const dir = adminDataDir();
    mkdirSync(dir, { recursive: true });
    const repoDir = repoAdminToolDir();
    mkdirSync(repoDir, { recursive: true });

    const existingPriv = privateKeyPath();
    if (existsSync(existingPriv) && !overwrite) {
      return { ok: false, error: '密钥已存在。若需覆盖，请勾选「覆盖已有密钥」后重试。' };
    }

    const { publicKey, privateKey } = generateKeyPair();
    const pubHex = publicKey.toString('hex');

    writeFileSync(join(repoDir, '.issuer-private.der'), privateKey);
    writeFileSync(join(repoDir, '.issuer-public.der'), publicKey);
    writeFileSync(join(repoDir, 'embedded-public-hex.txt'), `${pubHex}\n`, 'utf8');

    writeFileSync(join(dir, 'ed25519-private.der'), privateKey);
    writeFileSync(join(dir, 'ed25519-public.der'), publicKey);
    writeFileSync(join(dir, 'public-key-hex.txt'), `${pubHex}\n`, 'utf8');

    return {
      ok: true,
      publicHex: pubHex,
      paths: {
        repoPrivate: join(repoDir, '.issuer-private.der'),
        repoPublic: join(repoDir, '.issuer-public.der'),
        homeDir: dir,
      },
      hint:
        '请将上述公钥 Hex 写入 plantuml-desktop/scripts/license-common.mjs 中的 EMBEDDED_ISSUER_PUBLIC_KEY_HEX，与客户端内置公钥保持一致后再打包软件。',
    };
  });

  ipcMain.handle('admin:generate-license', (_e, params) => {
    try {
      const p = privateKeyPath();
      if (!existsSync(p)) {
        return { ok: false, error: '未找到私钥。请先在「密钥」页生成密钥对，或将 .issuer-private.der 放到 admin-tool 目录。' };
      }
      const privateKey = readFileSync(p);

      const deviceCode = String(params?.deviceCode || '').trim();
      const hwId = String(params?.hwId || '').trim().toLowerCase();
      const licenseMode = params?.licenseMode === 'permanent' ? 'permanent' : 'time_limited';

      const fmt = validateDeviceCodeFormat(deviceCode);
      if (!fmt.valid) return { ok: false, error: fmt.error };

      if (!hwId || hwId.length < 16) {
        return { ok: false, error: 'HW_ID 至少 16 位十六进制字符' };
      }

      if (!verifyDeviceCode(deviceCode, hwId)) {
        return { ok: false, error: '激活设备码与 HW_ID 不匹配' };
      }

      const issuedAt = String(params?.issuedAt || '').trim() || new Date().toISOString().split('T')[0];
      let activateBefore = '';
      let validUntil = '';

      if (licenseMode === 'permanent') {
        activateBefore =
          String(params?.activateBefore || '').trim() ||
          new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
      } else {
        const days = Math.max(1, Math.min(36500, Number(params?.validUntilDays) || 30));
        validUntil = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
      }

      const payload = {
        hwId,
        licenseMode,
        issuedAt,
        tier: 'full',
        batchId: String(params?.batchId || '').trim() || undefined,
        customerRef: String(params?.customerRef || '').trim() || undefined,
      };
      if (activateBefore) payload.activateBefore = activateBefore;
      if (validUntil) payload.validUntil = validUntil;

      const licenseCode = generateLicenseCode(payload, privateKey);
      return { ok: true, licenseCode, payloadSummary: payload };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('admin:verify-license', (_e, { code }) => {
    try {
      const licenseCode = String(code || '').trim();
      const parsed = parseLicenseCode(licenseCode);
      if (!parsed.ok) return { ok: false, error: parsed.error };

      let sigValid = false;
      let sigError = '';
      const pubPath = publicKeyPath();
      if (existsSync(pubPath)) {
        const publicKey = readFileSync(pubPath);
        const r = verifyLicenseSignature(parsed, publicKey);
        sigValid = r.valid;
        sigError = r.error || '';
      } else {
        const buf = resolveIssuerPublicKeyBuffer();
        if (buf && buf.length) {
          const r = verifyLicenseSignature(parsed, buf);
          sigValid = r.valid;
          sigError = r.error || '';
        } else {
          sigError = '未找到公钥文件且无法使用内置公钥';
        }
      }

      return {
        ok: true,
        parsed: true,
        payload: parsed.payload,
        payloadJson: parsed.payloadJson,
        sigValid,
        sigError,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('admin:device-code', (_e, fields) => {
    try {
      const machineGuid = String(fields?.machineGuid || '').trim();
      const cpuId = String(fields?.cpuId || '').trim();
      const diskSerial = String(fields?.diskSerial || '').trim();
      const macAddress = String(fields?.macAddress || '').trim();

      const hwId = generateHwId({ machineGuid, cpuId, diskSerial, macAddress });
      const deviceCode = generateDeviceCode(hwId);
      return {
        ok: true,
        hwId,
        shortHwId: hwId.slice(0, 16).toUpperCase(),
        deviceCode,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('admin:save-license-file', async (_e, { code }) => {
    const text = String(code || '').trim();
    if (!text) return { ok: false, error: '激活码为空' };
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win || undefined, {
      title: '保存激活码',
      defaultPath: join(adminDataDir(), `license-${Date.now()}.txt`),
      filters: [{ name: '文本', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { ok: true, canceled: true };
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${text}\n`, 'utf8');
    return { ok: true, path: filePath };
  });

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
