import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createPrivateKey, randomUUID } from 'node:crypto';
import * as embeddedIssuerBase from './issuer-embedded-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 密钥生成器启用 build.asar=false：应用源码以普通磁盘目录分发（解压后通常为 resources/app/），不生成 app.asar。
 * dynamic import() 在 Windows 上仍须传入 file:// URL。
 */
function resolveLicenseCommonPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, 'license-common.mjs');
  const dev = join(here, '..', 'scripts', 'license-common.mjs');
  if (existsSync(bundled)) return bundled;
  if (existsSync(dev)) return dev;
  throw new Error(`license-common.mjs 未找到（__dirname=${here}）。请重新打包或执行 npm run sync:keygen-license 后再构建。`);
}

const licenseCommonPath = resolveLicenseCommonPath();
const licenseMod = await import(pathToFileURL(licenseCommonPath).href);
const {
  EMBEDDED_ISSUER_PUBLIC_KEY_HEX,
  COMMERCIAL_OFFER_LABEL,
  COMMERCIAL_OFFER_PERM_689,
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

const issuerLocalModulePath = join(__dirname, 'issuer-embedded-keys.local.mjs');
/** @type {Record<string, unknown>} */
let embeddedIssuerLocal = {};
if (existsSync(issuerLocalModulePath)) {
  embeddedIssuerLocal = await import(pathToFileURL(issuerLocalModulePath).href);
}

function mergedEmbeddedPrivatePkcs8Hex() {
  const fromLocal =
    embeddedIssuerLocal && typeof embeddedIssuerLocal.EMBEDDED_ISSUER_PRIVATE_PKCS8_HEX === 'string'
      ? embeddedIssuerLocal.EMBEDDED_ISSUER_PRIVATE_PKCS8_HEX.trim()
      : '';
  if (fromLocal) return fromLocal;
  return String(embeddedIssuerBase.EMBEDDED_ISSUER_PRIVATE_PKCS8_HEX || '').trim();
}

/** @returns {Buffer|null} 有效 PKCS#8 DER，否则 null */
function embeddedPrivateKeyDerBuffer() {
  const hex = mergedEmbeddedPrivatePkcs8Hex();
  if (!hex) return null;
  let buf;
  try {
    buf = Buffer.from(hex, 'hex');
  } catch {
    return null;
  }
  if (!buf.length) return null;
  try {
    createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' });
    return buf;
  } catch {
    return null;
  }
}

/** 签名用：优先内置私钥，否则磁盘文件 */
function resolvePrivateKeyBufferForSigning() {
  const emb = embeddedPrivateKeyDerBuffer();
  if (emb) return emb;
  const p = privateKeyPath();
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
}

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
    title: 'PlantUML 密钥生成器',
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
    const hasPrivateFile = existsSync(priv);
    const hasPublicFile = existsSync(pub);
    const hasEmbeddedPrivate = Boolean(embeddedPrivateKeyDerBuffer());
    const builtinPublicHex = String(EMBEDDED_ISSUER_PUBLIC_KEY_HEX || '').trim();

    let publicHex = '';
    if (hasPublicFile) {
      try {
        publicHex = readFileSync(pub).toString('hex');
      } catch {
        /* ignore */
      }
    }
    const publicHexSource =
      publicHex ? 'file' : builtinPublicHex ? 'built_in_license_common' : 'none';
    if (!publicHex && builtinPublicHex) {
      publicHex = builtinPublicHex;
    }

    const privateEffective = hasEmbeddedPrivate ? 'embedded' : hasPrivateFile ? 'file' : 'none';
    const embeddedPrivateHexPreview =
      hasEmbeddedPrivate && mergedEmbeddedPrivatePkcs8Hex()
        ? `${mergedEmbeddedPrivatePkcs8Hex().slice(0, 24)}…`
        : '';

    return {
      ok: true,
      /** @deprecated 使用 hasPrivateFile — 兼容旧前端 */
      hasPrivate: hasPrivateFile || hasEmbeddedPrivate,
      /** @deprecated 使用 hasPublicFile — 磁盘公钥是否存在 */
      hasPublic: hasPublicFile,
      hasPrivateFile,
      hasPublicFile,
      hasEmbeddedPrivate,
      hasBuiltinPublicHex: Boolean(builtinPublicHex),
      publicHexSource,
      privateEffective,
      privatePath: priv,
      publicPath: pub,
      publicHex,
      publicHexPreview: publicHex ? `${publicHex.slice(0, 32)}…` : '',
      embeddedPrivateHexPreview,
      issuerLocalOverlayPresent: existsSync(issuerLocalModulePath),
    };
  });

  ipcMain.handle('admin:init-keys', (_e, { overwrite }) => {
    if (embeddedPrivateKeyDerBuffer()) {
      return {
        ok: false,
        error:
          '已配置内置私钥（issuer-embedded-keys.mjs 或 issuer-embedded-keys.local.mjs），签发将优先使用内置私钥。若需改用「生成新密钥对」写入磁盘的密钥，请先清空上述文件中的 EMBEDDED_ISSUER_PRIVATE_PKCS8_HEX。',
      };
    }

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
        '请将上述公钥 Hex 写入仓库 scripts/license-common.mjs 中的 EMBEDDED_ISSUER_PUBLIC_KEY_HEX，与客户端内置公钥保持一致后再打包软件。',
    };
  });

  ipcMain.handle('admin:generate-license', (_e, params) => {
    try {
      const privateKey = resolvePrivateKeyBufferForSigning();
      if (!privateKey?.length) {
        return {
          ok: false,
          error:
            '未找到有效私钥。请在 issuer-embedded-keys.mjs（或本地的 issuer-embedded-keys.local.mjs）中填入 PKCS#8 私钥 DER 十六进制，或在「密钥」页生成密钥对 / 放置 .issuer-private.der。',
        };
      }

      const deviceCode = String(params?.deviceCode || '').trim();
      const hwId = String(params?.hwId || '').trim().toLowerCase();
      const licenseModeRaw = params?.licenseMode === 'permanent' ? 'permanent' : 'time_limited';
      const commercialSkuRaw = String(params?.commercialOffer || '').trim();
      const isLegacySku = !commercialSkuRaw || commercialSkuRaw === 'legacy';

      const fmt = validateDeviceCodeFormat(deviceCode);
      if (!fmt.valid) return { ok: false, error: fmt.error };

      if (!hwId || hwId.length < 16) {
        return { ok: false, error: 'HW_ID 至少 16 位十六进制字符' };
      }

      if (!verifyDeviceCode(deviceCode, hwId)) {
        return { ok: false, error: '激活设备码与 HW_ID 不匹配' };
      }

      const issuedAt = String(params?.issuedAt || '').trim() || new Date().toISOString().split('T')[0];

      /** @type {Record<string, unknown>} */
      const payload = {
        hwId,
        issuedAt,
        tier: 'full',
        batchId: String(params?.batchId || '').trim() || undefined,
        customerRef: String(params?.customerRef || '').trim() || undefined,
      };

      if (!isLegacySku) {
        if (!COMMERCIAL_OFFER_LABEL?.[commercialSkuRaw]) {
          return { ok: false, error: `未知明码档位: ${commercialSkuRaw}` };
        }
        payload.commercial_offer = commercialSkuRaw;
        if (commercialSkuRaw === COMMERCIAL_OFFER_PERM_689) {
          payload.licenseMode = 'permanent';
          payload.activateBefore =
            String(params?.activateBeforeBuyout || '').trim() ||
            new Date(Date.now() + 10 * 365 * 86400000).toISOString().split('T')[0];
        } else {
          payload.licenseMode = 'time_limited';
        }
      } else {
        payload.licenseMode = licenseModeRaw;
        let activateBefore = '';
        let validUntil = '';
        if (licenseModeRaw === 'permanent') {
          activateBefore =
            String(params?.activateBeforeLegacy || '').trim() ||
            new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
        } else {
          const days = Math.max(1, Math.min(36500, Number(params?.validUntilDays) || 30));
          validUntil = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
        }
        if (activateBefore) payload.activateBefore = activateBefore;
        if (validUntil) payload.validUntil = validUntil;
      }

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

  ipcMain.handle('admin:generate-monthly-key', () => {
    const key = `STM-${randomUUID().toString().replace(/-/g, '')}`;
    return { ok: true, key };
  });

  ipcMain.handle('admin:register-monthly-key', async (_e, payload) => {
    const serverBase = String(payload?.serverBase || '')
      .trim()
      .replace(/\/$/, '');
    const adminToken = String(payload?.adminToken || '').trim();
    const key = String(payload?.key || '').trim();
    if (!serverBase) return { ok: false, error: '请填写服务器根 URL' };
    if (!adminToken) return { ok: false, error: '请填写管理员 Token' };
    if (!key) return { ok: false, error: '请先生成密钥' };
    const url = `${serverBase}/api/admin/monthly-keys`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ key }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, error: `服务器返回非 JSON（HTTP ${res.status}）` };
      }
      if (!res.ok || !data?.ok) {
        return { ok: false, error: data?.error || `登记失败（HTTP ${res.status}）` };
      }
      return { ok: true, duplicate: Boolean(data.duplicate) };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
