/**
 * license-common.mjs — 授权体系共享模块
 *
 * 提供设备指纹、激活设备码、签名验证等客户端与管理员工具共享的密码学原语。
 *
 * 设计依据：《UML大师-Agent-开发计划》第 12 节
 * - 方案 B（对称 HMAC）用于激活设备码生成与校验
 * - Ed25519 签名用于软件激活码
 *
 * 管理员私钥由 admin-tool GUI（issuer-embedded-keys.mjs）或 admin-cli 使用的 .der 文件持有；客户端仅内置公钥。
 * 本项目为学习交流，仓库内附有演示用密钥材料；请勿在生产环境直接使用。
 */

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/* ============================================================
 * 常量
 * ============================================================ */

/** 产品标识，用于派生 HW_ID 与激活设备码 */
export const PRODUCT_ID = 'UML-MASTER';
/** 产品版本布局（大版本号，用于派生） */
export const PRODUCT_LAYOUT = '2';

/** 明码激活码 SKU：`commercial_offer` 字段写入签名载荷（与 license_mode 搭配） */
export const COMMERCIAL_OFFER_DAY_PASS_99 = 'co_day_pass_9_9';
export const COMMERCIAL_OFFER_MONTH_399 = 'co_month_39_9';
export const COMMERCIAL_OFFER_YEAR_299 = 'co_year_299';
/** 689 买断：与时间型并列，仍为 license_mode=permanent */
export const COMMERCIAL_OFFER_PERM_689 = 'co_perm_689';

/** 自首次在本机激活日起算截止日期（日历日），签名中不含 absolute valid_until */
export const COMPUTED_TERM_COMMERCIAL_OFFERS = new Set([
  COMMERCIAL_OFFER_DAY_PASS_99,
  COMMERCIAL_OFFER_MONTH_399,
  COMMERCIAL_OFFER_YEAR_299,
]);

/** 给用户与运营看的文案映射 */
export const COMMERCIAL_OFFER_LABEL = {
  [COMMERCIAL_OFFER_DAY_PASS_99]: '¥9.9 当日不限次',
  [COMMERCIAL_OFFER_MONTH_399]: '¥39.9 按月',
  [COMMERCIAL_OFFER_YEAR_299]: '¥299 包年',
  [COMMERCIAL_OFFER_PERM_689]: '¥689 永久买断',
};

/** 本机日历日（与免费用量等一致，按用户时区日期） */
export function localYmdFromDate(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD + 天数 → YYYY-MM-DD（本地历法） */
export function ymdAddCalendarDays(startYmd, deltaDays) {
  const raw = String(startYmd || '').trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!parts) throw new Error(`invalid date ymd=${raw}`);
  const dt = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  dt.setDate(dt.getDate() + Number(deltaDays));
  return localYmdFromDate(dt);
}

/** ISO8601 UTC 字符串 → 用户本地日历日（用于读出首次激活日期） */
export function localYmdFromIsoStamp(iso) {
  try {
    return localYmdFromDate(new Date(iso));
  } catch {
    return '';
  }
}

/** 明码 SKU：根据首次激活日计算权益最后有效自然日（含当日） */
export function computeCommercialValidityEndYmd(firstActivateYmd, commercialOffer) {
  const start = String(firstActivateYmd || '').trim();
  if (!start || !COMMERCIAL_OFFER_LABEL[commercialOffer]) return '';
  if (!COMPUTED_TERM_COMMERCIAL_OFFERS.has(commercialOffer)) return '';

  if (commercialOffer === COMMERCIAL_OFFER_DAY_PASS_99) return start;
  if (commercialOffer === COMMERCIAL_OFFER_MONTH_399) return ymdAddCalendarDays(start, 30);
  if (commercialOffer === COMMERCIAL_OFFER_YEAR_299) return ymdAddCalendarDays(start, 364);

  return '';
}

/** 激活设备码 HMAC 密钥（对称，客户端混淆存放；管理员工具持有相同密钥） */
// 注意：对称密钥无法在向用户分发的客户端中真正隐藏，仅用于设备码一致性校验与防误输
const K_REQ_HEX = '756d6c2d6d61737465722d61637469766174696f6e2d6b65792d7631';
const K_REQ = Buffer.from(K_REQ_HEX, 'hex');

/** 激活设备码显示长度（Crockford Base32 编码后截断） */
const DEVICE_CODE_LENGTH = 28;

/** 许可证文件名称（存储在用户数据目录） */
const LICENSE_FILE_NAME = 'studio-license.json';

/**
 * 内置发行方 Ed25519 公钥（SPKI DER 十六进制）。
 * 与 admin-tool-gui/issuer-embedded-keys.mjs 内 PKCS#8 私钥及管理员工具密钥页生成逻辑成对；
 * admin-tool/.issuer-public.der 若存在则与该 hex 等价（二进制副本）。
 * 开发环境可通过环境变量 UML_MASTER_PUBKEY（hex）覆盖以使用独立密钥对。
 */
export const EMBEDDED_ISSUER_PUBLIC_KEY_HEX =
  '302a300506032b6570032100e19d8387fb633fea6daa82940df99a6a6fa31a2c413729869c384e8f97a232b9';

/**
 * 解析用于激活码验签的公钥 Buffer（SPKI DER）。
 * 优先使用环境变量 UML_MASTER_PUBKEY（便于开发/CI），否则使用内置公钥。
 * @returns {Buffer|null}
 */
export function resolveIssuerPublicKeyBuffer() {
  const envHex =
    typeof process !== 'undefined' && process.env && typeof process.env.UML_MASTER_PUBKEY === 'string'
      ? process.env.UML_MASTER_PUBKEY.trim()
      : '';
  const hex = envHex || EMBEDDED_ISSUER_PUBLIC_KEY_HEX || '';
  if (!hex) return null;
  try {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length < 16) return null;
    return buf;
  } catch {
    return null;
  }
}

/* ============================================================
 * 设备指纹（HW_ID）
 * ============================================================ */

/**
 * 收集本机稳定标识，生成设备指纹 HW_ID
 * @param {object} [options]
 * @param {string} [options.machineGuid] - Windows MachineGuid（由主进程传入）
 * @param {string} [options.cpuId] - CPU 标识
 * @param {string} [options.diskSerial] - 系统盘卷序列号
 * @param {string} [options.macAddress] - 稳定网卡 MAC
 * @returns {string} HW_ID 的十六进制字符串（SHA-256）
 */
export function generateHwId(options = {}) {
  const {
    machineGuid = '',
    cpuId = '',
    diskSerial = '',
    macAddress = '',
  } = options;

  // 按固定顺序拼接规范载荷
  const canonicalParts = [
    PRODUCT_ID,
    PRODUCT_LAYOUT,
    machineGuid.trim().toLowerCase(),
    cpuId.trim().toLowerCase(),
    diskSerial.trim().toUpperCase(),
    macAddress.trim().toLowerCase().replace(/[^0-9a-f]/g, ''),
  ];

  const canonicalPayload = canonicalParts.join('|');

  // HW_ID = SHA-256("UML-MASTER-LICENSE-v1" || canonical_payload)
  const hash = createHash('sha256')
    .update('UML-MASTER-LICENSE-v1')
    .update(canonicalPayload)
    .digest('hex');

  return hash;
}

/**
 * 生成简短的 HW_ID 展示串（前 16 位十六进制）
 * @param {string} hwId - 完整 HW_ID
 * @returns {string}
 */
export function shortHwId(hwId) {
  return hwId ? hwId.slice(0, 16).toUpperCase() : '';
}

/* ============================================================
 * 激活设备码（方案 B：HMAC-SHA256 + Crockford Base32）
 * ============================================================ */

/**
 * Crockford Base32 编码
 * @param {Buffer} buf
 * @returns {string}
 */
function crockfordBase32Encode(buf) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let bits = 0;
  let bitCount = 0;
  let result = '';

  for (let i = 0; i < buf.length; i++) {
    bits = (bits << 8) | buf[i];
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      result += alphabet[(bits >>> bitCount) & 0x1f];
    }
  }
  if (bitCount > 0) {
    result += alphabet[(bits << (5 - bitCount)) & 0x1f];
  }
  return result;
}

/**
 * 计算 Luhn mod N 校验位（用于 Crockford Base32）
 * @param {string} str
 * @returns {string}
 */
function luhnMod32Check(str) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const map = {};
  for (let i = 0; i < alphabet.length; i++) map[alphabet[i]] = i;

  let sum = 0;
  let double = false;
  for (let i = str.length - 1; i >= 0; i--) {
    let val = map[str[i]];
    if (val === undefined) val = 0;
    if (double) {
      val *= 2;
      if (val >= 32) val = val - 32 + 1;
    }
    sum += val;
    double = !double;
  }
  const check = (32 - (sum % 32)) % 32;
  return alphabet[check];
}

/**
 * 生成激活设备码
 * @param {string} hwId - 设备指纹
 * @returns {string} 激活设备码（固定长度，含校验位，每 4 位加连字符）
 */
export function generateDeviceCode(hwId) {
  // HMAC-SHA256(K_req, HW_ID || PRODUCT || LAYOUT)
  const hmac = createHmac('sha256', K_REQ)
    .update(hwId)
    .update(PRODUCT_ID)
    .update(PRODUCT_LAYOUT)
    .digest();

  // Crockford Base32 编码并截断
  let encoded = crockfordBase32Encode(hmac);
  encoded = encoded.slice(0, DEVICE_CODE_LENGTH - 1); // 留一位给校验位

  // 添加 Luhn 校验位
  const checkChar = luhnMod32Check(encoded);
  const deviceCode = encoded + checkChar;

  // 每 4 位加一个连字符便于阅读
  return deviceCode.replace(/(.{4})/g, '$1-').slice(0, -1);
}

/**
 * 校验激活设备码格式
 * @param {string} code - 激活设备码
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateDeviceCodeFormat(code) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: '激活设备码不能为空' };
  }

  const clean = code.replace(/-/g, '').toUpperCase();
  if (clean.length !== DEVICE_CODE_LENGTH) {
    return { valid: false, error: `激活设备码长度不正确（期望 ${DEVICE_CODE_LENGTH} 位，实际 ${clean.length} 位）` };
  }

  // 校验 Luhn 校验位
  const data = clean.slice(0, -1);
  const checkChar = clean.slice(-1);
  const expectedCheck = luhnMod32Check(data);
  if (checkChar !== expectedCheck) {
    return { valid: false, error: '激活设备码校验位不正确' };
  }

  return { valid: true };
}

/**
 * 验证激活设备码是否与 HW_ID 匹配（管理员工具使用）
 * @param {string} deviceCode - 用户提供的激活设备码
 * @param {string} hwId - 设备指纹
 * @returns {boolean}
 */
export function verifyDeviceCode(deviceCode, hwId) {
  const fmt = validateDeviceCodeFormat(deviceCode);
  if (!fmt.valid) return false;

  const expected = generateDeviceCode(hwId);
  return deviceCode.replace(/-/g, '').toUpperCase() === expected.replace(/-/g, '').toUpperCase();
}

/* ============================================================
 * 软件激活码（Ed25519 签名）
 * ============================================================ */

/**
 * 生成软件激活码载荷 JSON（不签名）
 * @param {object} params
 * @param {string} params.hwId - 设备指纹
 * @param {'permanent'|'time_limited'} params.licenseMode - 授权类型
 * @param {string} params.issuedAt - 签发日期 ISO 字符串
 * @param {string} [params.activateBefore] - 首激截止日期（永久型）
 * @param {string} [params.validUntil] - 有效期截止（限时型）
 * @param {string} [params.tier] - 授权等级
 * @param {string} [params.batchId] - 批次号
 * @param {string} [params.customerRef] - 客户标识
 * @param {string} [params.commercial_offer] - 明码档位 SKU（与 license_mode / validUntil 语义互斥时需遵守下方组合）
 */
export function buildLicensePayload(params) {
  const {
    hwId,
    licenseMode = 'time_limited',
    issuedAt = new Date().toISOString().split('T')[0],
    activateBefore,
    validUntil,
    tier = 'full',
    batchId = '',
    customerRef = '',
    commercial_offer = '',
  } = params;

  const sku = typeof commercial_offer === 'string' ? commercial_offer.trim() : '';

  const payload = {
    product_id: PRODUCT_ID,
    layout: PRODUCT_LAYOUT,
    hw_id: hwId,
    license_mode: licenseMode,
    tier,
    issued_at: issuedAt,
  };

  if (sku) {
    if (!COMMERCIAL_OFFER_LABEL[sku]) {
      throw new Error(`未知 commercial_offer: ${sku}`);
    }
    payload.commercial_offer = sku;
    if (sku === COMMERCIAL_OFFER_PERM_689 || licenseMode === 'permanent') {
      payload.license_mode = 'permanent';
    } else if (COMPUTED_TERM_COMMERCIAL_OFFERS.has(sku)) {
      payload.license_mode = 'time_limited';
    }
  }

  if (payload.license_mode === 'permanent' && activateBefore) {
    payload.activate_before = activateBefore;
  }

  if (payload.license_mode === 'time_limited' && validUntil && !COMPUTED_TERM_COMMERCIAL_OFFERS.has(sku)) {
    payload.valid_until = validUntil;
  }

  if (batchId) payload.batch_id = batchId;
  if (customerRef) payload.customer_ref = customerRef;

  return JSON.stringify(payload);
}

/**
 * 解析软件激活码
 * @param {string} licenseCode - 完整激活码字符串
 * @returns {{ ok: boolean, payload?: object, signature?: Buffer, payloadJson?: string, error?: string }}
 */
export function parseLicenseCode(licenseCode) {
  if (!licenseCode || typeof licenseCode !== 'string') {
    return { ok: false, error: '激活码不能为空' };
  }

  try {
    // 格式：Version.Base64Url(Payload.Signature)
    const parts = licenseCode.split('.');
    if (parts.length !== 3) {
      return { ok: false, error: '激活码格式不正确（应为 Version.Payload.Signature）' };
    }

    const [version, payloadB64, sigB64] = parts;

    if (version !== 'v1') {
      return { ok: false, error: `不支持的激活码版本: ${version}` };
    }

    // Base64 URL 解码
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const signature = Buffer.from(sigB64, 'base64url');

    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      return { ok: false, error: '激活码载荷解析失败' };
    }

    return {
      ok: true,
      payload,
      signature,
      payloadJson,
    };
  } catch (e) {
    return { ok: false, error: `激活码解析异常: ${e.message}` };
  }
}

/**
 * 验证软件激活码签名（客户端使用）
 * @param {object} parsed - parseLicenseCode 的返回结果
 * @param {Buffer} publicKey - Ed25519 公钥
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyLicenseSignature(parsed, publicKey) {
  if (!parsed?.ok) {
    return { valid: false, error: '无效的激活码解析结果' };
  }

  if (!publicKey || publicKey.length === 0) {
    return { valid: false, error: '缺少发行方公钥，无法验证激活码签名' };
  }

  try {
    const pubKeyObj = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    const isVerified = verify(null, Buffer.from(parsed.payloadJson), pubKeyObj, parsed.signature);
    if (!isVerified) {
      return { valid: false, error: '激活码签名验证失败' };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: `签名验证异常: ${e.message}` };
  }
}

/**
 * 客户端校验软件激活码的完整流程
 * @param {string} licenseCode - 用户输入的激活码
 * @param {string} hwId - 本机设备指纹
 * @param {Buffer} [publicKey] - Ed25519 公钥
 * @returns {{ ok: boolean, licenseMode?: string, error?: string, payload?: object }}
 */
export function validateLicenseCode(licenseCode, hwId, publicKey) {
  // 1. 解析
  const parsed = parseLicenseCode(licenseCode);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const { payload } = parsed;

  // 2. 验证产品 ID
  if (payload.product_id !== PRODUCT_ID) {
    return { ok: false, error: '激活码产品不匹配' };
  }

  // 3. 验证 HW_ID
  if (payload.hw_id !== hwId) {
    return { ok: false, error: '激活码与当前设备不匹配' };
  }

  // 4. 验证签名（必须配置公钥；无公钥则拒绝激活）
  if (!publicKey || publicKey.length === 0) {
    return { ok: false, error: '客户端缺少发行方公钥，无法接受激活码' };
  }
  const sigResult = verifyLicenseSignature(parsed, publicKey);
  if (!sigResult.valid) {
    return { ok: false, error: sigResult.error };
  }

  // 5. 验证有效期
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  if (payload.license_mode === 'permanent') {
    // 永久型：检查首激窗口
    if (payload.activate_before && today > payload.activate_before) {
      return { ok: false, error: `激活码已超过首激截止日期（${payload.activate_before}）` };
    }
  } else if (payload.license_mode === 'time_limited') {
    if (payload.commercial_offer && COMPUTED_TERM_COMMERCIAL_OFFERS.has(payload.commercial_offer)) {
      // 首次激活时再计算截止日期
    } else if (payload.valid_until && today > payload.valid_until) {
      return { ok: false, error: `激活码已过期（有效期至 ${payload.valid_until}）` };
    } else if (!payload.valid_until) {
      return { ok: false, error: '限时授权激活码缺少 valid_until（非明码档位时请检查签发参数）' };
    }
  }

  return {
    ok: true,
    licenseMode: payload.license_mode,
    payload,
  };
}

/* ============================================================
 * 许可证持久化存储
 * ============================================================ */

/**
 * 获取许可证文件路径
 * @param {string} userDataPath - Electron app.getPath('userData')
 * @returns {string}
 */
export function getLicensePath(userDataPath) {
  return join(userDataPath, LICENSE_FILE_NAME);
}

/**
 * 读取本地许可证
 * @param {string} userDataPath
 * @returns {object|null}
 */
export function readLicense(userDataPath) {
  try {
    const p = getLicensePath(userDataPath);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 写入本地许可证
 * @param {string} userDataPath
 * @param {object} licenseData
 */
export function writeLicense(userDataPath, licenseData) {
  const p = getLicensePath(userDataPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(licenseData, null, 2), 'utf8');
}

/**
 * 检查许可证状态
 * @param {string} userDataPath
 * @param {{ hwId?: string, publicKey?: Buffer } | null} [verificationContext] - 传入时将对磁盘上的 `license_code` 重新验签，防篡改
 * @returns {{ activated: boolean, licenseMode?: string, payload?: object, error?: string }}
 */
export function checkLicenseStatus(userDataPath, verificationContext = null) {
  const license = readLicense(userDataPath);
  if (!license) {
    return { activated: false, error: '未激活' };
  }

  if (license.deactivated === true) {
    return { activated: false, error: '授权已卸载', payload: license };
  }

  const hwId = verificationContext?.hwId;
  const publicKey = verificationContext?.publicKey;

  if (!hwId || !publicKey || !publicKey.length) {
    return { activated: false, error: '无法校验授权状态（缺少校验上下文）。', payload: license };
  }

  const storedCode = typeof license.license_code === 'string' ? license.license_code.trim() : '';
  if (!storedCode) {
    return {
      activated: false,
      error: '许可证缺少签名字段，请重新在「授权激活」中输入激活码。',
      payload: license,
    };
  }
  const v = validateLicenseCode(storedCode, hwId, publicKey);
  if (!v.ok) {
    return {
      activated: false,
      error: `许可证无效或已被篡改：${v.error}`,
      payload: license,
    };
  }

  const p = v.payload || {};

  const mode =
    typeof p.license_mode === 'string' ? p.license_mode : String(license.license_mode || '').trim();

  if (mode === 'time_limited') {
    let until = '';
    const co = p.commercial_offer;

    if (co && COMPUTED_TERM_COMMERCIAL_OFFERS.has(co)) {
      const act = typeof license.activated_at === 'string' ? license.activated_at.trim() : '';
      const redeemedYmd = act ? localYmdFromIsoStamp(act) : String(license.redeemed_ymd || '').trim();
      if (!redeemedYmd) {
        return {
          activated: false,
          licenseMode: 'time_limited',
          error:
            '授权记录不完整（缺少首次激活日期）。若刚升级到新版本后可尝试重新粘贴同一激活码完成同步，或联系管理员。',
          payload: license,
        };
      }
      until = computeCommercialValidityEndYmd(redeemedYmd, co);
    } else {
      until = String(p.valid_until || license.valid_until || '').trim();
    }

    if (!until) {
      return {
        activated: false,
        licenseMode: 'time_limited',
        error: '无法判定限时授权的截止日期（缺少 valid_until）。请卸载授权后重新激活。',
        payload: license,
      };
    }

    const now = new Date().toISOString().split('T')[0];
    if (now > until) {
      return {
        activated: false,
        licenseMode: 'time_limited',
        error: `许可证已过期（有效期至 ${until}）`,
        payload: license,
      };
    }
  }

  return {
    activated: true,
    licenseMode: mode,
    payload: license,
  };
}

/* ============================================================
 * 管理员工具密钥生成
 * ============================================================ */

/**
 * 生成 Ed25519 密钥对（管理员工具使用）
 * @returns {{ publicKey: Buffer, privateKey: Buffer }}
 */
export function generateKeyPair() {
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return { publicKey, privateKey };
  } catch {
    // 回退：生成 RSA 密钥对
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return { publicKey, privateKey };
  }
}

/**
 * 使用私钥签名载荷（管理员工具使用）
 * @param {string} payloadJson - 规范化的 JSON 载荷
 * @param {Buffer} privateKey - Ed25519 私钥
 * @returns {Buffer} 签名
 */
export function signPayload(payloadJson, privateKey) {
  try {
    const keyObj =
      Buffer.isBuffer(privateKey) || typeof privateKey === 'string'
        ? createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' })
        : privateKey;
    return sign(null, Buffer.from(payloadJson), keyObj);
  } catch (e) {
    throw new Error(`签名失败: ${e.message}`);
  }
}

/**
 * 生成完整的软件激活码字符串
 * @param {object} payload - 载荷对象
 * @param {Buffer} privateKey - 私钥
 * @returns {string} 完整激活码
 */
export function generateLicenseCode(payload, privateKey) {
  const payloadJson = buildLicensePayload(payload);
  const signature = signPayload(payloadJson, privateKey);
  const version = 'v1';

  const payloadB64 = Buffer.from(payloadJson).toString('base64url');
  const sigB64 = signature.toString('base64url');

  return `${version}.${payloadB64}.${sigB64}`;
}
