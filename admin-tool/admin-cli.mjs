#!/usr/bin/env node

/**
 * admin-cli.mjs — UML 大师 管理员激活码生成工具（CLI）
 *
 * 功能：
 *   1. init-keys   — 首次运行：生成 Ed25519 密钥对，输出公钥（供客户端配置）
 *   2. generate    — 交互式生成软件激活码
 *   3. verify      — 验证软件激活码
 *   4. device-code — 根据 HW_ID 生成激活设备码（调试用）
 *
 * 设计依据：《UML大师-Agent-开发计划》第 12 节
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateHwId,
  generateDeviceCode,
  validateDeviceCodeFormat,
  verifyDeviceCode,
  buildLicensePayload,
  parseLicenseCode,
  generateKeyPair,
  signPayload,
  generateLicenseCode,
  PRODUCT_ID,
  PRODUCT_LAYOUT,
} from '../scripts/license-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ============================================================
 * 配置路径
 * ============================================================ */

/** 管理员工具数据目录（存放密钥） */
function adminDataDir() {
  const home = process.env.USERPROFILE || process.env.HOME || __dirname;
  return join(home, '.uml-master-admin');
}

function privateKeyPath() {
  return join(adminDataDir(), 'ed25519-private.der');
}

function publicKeyPath() {
  return join(adminDataDir(), 'ed25519-public.der');
}

function publicKeyHexPath() {
  return join(adminDataDir(), 'public-key-hex.txt');
}

/* ============================================================
 * 交互式输入
 * ============================================================ */

function ask(query) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/* ============================================================
 * 命令：init-keys
 * ============================================================ */

async function cmdInitKeys() {
  console.log('\n🔑 UML 大师 — 管理员密钥初始化\n');

  const dir = adminDataDir();
  mkdirSync(dir, { recursive: true });

  if (existsSync(privateKeyPath())) {
    const overwrite = await ask('⚠️  密钥已存在，是否覆盖？(y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('已取消。');
      return;
    }
  }

  console.log('正在生成 Ed25519 密钥对…');
  const { publicKey, privateKey } = generateKeyPair();

  writeFileSync(privateKeyPath(), privateKey);
  writeFileSync(publicKeyPath(), publicKey);

  // 同时输出公钥的十六进制字符串，方便配置到客户端
  const pubHex = publicKey.toString('hex');
  writeFileSync(publicKeyHexPath(), pubHex);

  console.log('\n✅ 密钥对已生成：');
  console.log(`   私钥: ${privateKeyPath()}`);
  console.log(`   公钥: ${publicKeyPath()}`);
  console.log(`   公钥(Hex): ${publicKeyHexPath()}`);
  console.log(`\n📋 请将以下公钥 Hex 配置到客户端环境变量 UML_MASTER_PUBKEY：`);
  console.log(`\n   ${pubHex}\n`);

  console.log('⚠️  请妥善保管私钥文件！私钥泄露后，任何人可签发激活码。');
  console.log('   建议将私钥存储在离线/受控环境，不要提交到版本控制。\n');
}

/* ============================================================
 * 命令：generate
 * ============================================================ */

async function cmdGenerate() {
  console.log('\n🔑 UML 大师 — 软件激活码生成\n');

  // 检查密钥
  if (!existsSync(privateKeyPath())) {
    console.error('❌ 未找到私钥。请先运行: node admin-cli.mjs init-keys\n');
    process.exit(1);
  }

  const privateKey = readFileSync(privateKeyPath());

  // 交互式输入
  const deviceCode = await ask('请输入用户的激活设备码: ');
  const fmtCheck = validateDeviceCodeFormat(deviceCode);
  if (!fmtCheck.valid) {
    console.error(`❌ ${fmtCheck.error}\n`);
    process.exit(1);
  }

  // 从激活设备码反推 HW_ID（方案 B：重算 HMAC 验证）
  // 注意：由于 HMAC 是单向的，管理员工具需要用户同时提供 HW_ID 或通过其他方式确认
  // 这里我们让用户输入 HW_ID 来验证
  const hwIdInput = await ask('请输入用户的 HW_ID（设备指纹）: ');
  if (!hwIdInput || hwIdInput.length < 16) {
    console.error('❌ HW_ID 格式不正确（至少 16 位十六进制字符）\n');
    process.exit(1);
  }

  // 验证激活设备码与 HW_ID 匹配
  const match = verifyDeviceCode(deviceCode, hwIdInput);
  if (!match) {
    console.error('❌ 激活设备码与 HW_ID 不匹配，请重新确认用户提供的信息\n');
    process.exit(1);
  }
  console.log('✅ 激活设备码验证通过\n');

  // 授权类型
  console.log('授权类型：');
  console.log('  1) permanent  — 永久授权（首激窗口 3 天）');
  console.log('  2) time_limited — 限时授权');
  const modeChoice = await ask('请选择 (1/2，默认 2): ');
  const licenseMode = modeChoice === '1' ? 'permanent' : 'time_limited';

  // 签发日期
  const issuedAt = await ask('签发日期 (YYYY-MM-DD，默认今天): ');
  const finalIssuedAt = issuedAt || new Date().toISOString().split('T')[0];

  // 有效期
  let activateBefore = '';
  let validUntil = '';

  if (licenseMode === 'permanent') {
    const defaultActivateBefore = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    const ab = await ask(`首激截止日期 (YYYY-MM-DD，默认 ${defaultActivateBefore}): `);
    activateBefore = ab || defaultActivateBefore;
  } else {
    const days = await ask('有效期天数 (默认 30): ');
    const daysNum = parseInt(days) || 30;
    validUntil = new Date(Date.now() + daysNum * 86400000).toISOString().split('T')[0];
    console.log(`   有效期至: ${validUntil}`);
  }

  // 可选字段
  const batchId = await ask('批次号 (可选): ');
  const customerRef = await ask('客户标识 (可选): ');

  // 生成激活码
  const payload = {
    hwId: hwIdInput,
    licenseMode,
    issuedAt: finalIssuedAt,
    tier: 'full',
    batchId: batchId || undefined,
    customerRef: customerRef || undefined,
  };

  if (activateBefore) payload.activateBefore = activateBefore;
  if (validUntil) payload.validUntil = validUntil;

  const licenseCode = generateLicenseCode(payload, privateKey);

  console.log('\n✅ 软件激活码已生成：');
  console.log(`\n${licenseCode}\n`);

  // 显示载荷详情
  const parsed = parseLicenseCode(licenseCode);
  if (parsed.ok) {
    console.log('📋 载荷详情：');
    console.log(JSON.stringify(parsed.payload, null, 2));
    console.log('');
  }

  // 保存到文件
  const save = await ask('是否保存到文件？(Y/n): ');
  if (save.toLowerCase() !== 'n') {
    const filename = `license-${hwIdInput.slice(0, 8)}-${Date.now()}.txt`;
    const filepath = join(adminDataDir(), filename);
    writeFileSync(filepath, licenseCode + '\n', 'utf8');
    console.log(`已保存到: ${filepath}\n`);
  }
}

/* ============================================================
 * 命令：verify
 * ============================================================ */

async function cmdVerify() {
  console.log('\n🔍 UML 大师 — 激活码验证\n');

  const licenseCode = await ask('请输入软件激活码: ');
  const parsed = parseLicenseCode(licenseCode);

  if (!parsed.ok) {
    console.error(`❌ 解析失败: ${parsed.error}\n`);
    return;
  }

  console.log('\n✅ 解析成功');
  console.log('📋 载荷：');
  console.log(JSON.stringify(parsed.payload, null, 2));

  // 验证签名
  if (existsSync(publicKeyPath())) {
    const publicKey = readFileSync(publicKeyPath());
    const { verify } = await import('node:crypto');
    try {
      const valid = verify(null, Buffer.from(parsed.payloadJson), publicKey, parsed.signature);
      console.log(`\n🔐 签名验证: ${valid ? '✅ 通过' : '❌ 失败'}`);
    } catch (e) {
      console.log(`\n🔐 签名验证: ⚠️  异常 - ${e.message}`);
    }
  } else {
    console.log('\n🔐 签名验证: ⏭️  跳过（未找到公钥文件）');
  }

  console.log('');
}

/* ============================================================
 * 命令：device-code
 * ============================================================ */

async function cmdDeviceCode() {
  console.log('\n🔑 UML 大师 — 激活设备码生成（调试用）\n');

  console.log('请输入设备信息（留空跳过）：');
  const machineGuid = await ask('  MachineGuid: ');
  const cpuId = await ask('  CPU ID: ');
  const diskSerial = await ask('  磁盘序列号: ');
  const macAddress = await ask('  MAC 地址: ');

  const hwId = generateHwId({
    machineGuid,
    cpuId,
    diskSerial,
    macAddress,
  });

  console.log(`\n📋 HW_ID: ${hwId}`);
  console.log(`📋 短 HW_ID: ${hwId.slice(0, 16).toUpperCase()}`);

  const deviceCode = generateDeviceCode(hwId);
  console.log(`📋 激活设备码: ${deviceCode}\n`);
}

/* ============================================================
 * 主入口
 * ============================================================ */

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || '';

  switch (cmd) {
    case 'init-keys':
      await cmdInitKeys();
      break;
    case 'generate':
      await cmdGenerate();
      break;
    case 'verify':
      await cmdVerify();
      break;
    case 'device-code':
      await cmdDeviceCode();
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`
UML 大师 — 管理员激活码生成工具

用法:
  node admin-cli.mjs <命令>

命令:
  init-keys    首次运行：生成 Ed25519 密钥对
  generate     交互式生成软件激活码
  verify       验证软件激活码
  device-code  根据设备信息生成激活设备码（调试用）
  help         显示此帮助信息

示例:
  node admin-cli.mjs init-keys
  node admin-cli.mjs generate
  node admin-cli.mjs verify
`);
      break;
  }
}

main().catch((e) => {
  console.error('错误:', e.message);
  process.exit(1);
});
