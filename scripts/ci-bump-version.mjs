/**
 * CI 用：将 package.json 版本按「补丁 +1」规则递增，并同步 package-lock.json 顶层版本字段。
 * 规则：若为 x.y.z-pro.n 则 n+1；否则将 z 加一并保留可选后缀。
 *
 * 同时读取本地 git tag（v*-pro.*），取 max(tag.n, package.n)+1，
 * 避免 package.json 与 tag 漂移时重复创建已存在 tag（如 pro.48）。
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(root, '..', 'package.json');
const lockPath = join(root, '..', 'package-lock.json');

/** @param {string} v */
function parseProVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)-pro\.(\d+)$/);
  if (!m) return null;
  return {
    prefix: `${m[1]}.${m[2]}.${m[3]}-pro.`,
    pro: Number(m[4]),
  };
}

/** @param {string} v */
function bumpVersionString(v) {
  const pro = parseProVersion(v);
  if (pro) {
    return `${pro.prefix}${pro.pro + 1}`;
  }
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`无法解析版本号: ${v}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] || ''}`;
}

/** @returns {number[]} */
function listProTagNumbers() {
  try {
    const out = execSync('git tag -l "v*-pro.*"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const nums = [];
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const m = t.match(/^v(\d+\.\d+\.\d+)-pro\.(\d+)$/);
      if (m) nums.push(Number(m[2]));
    }
    return nums;
  } catch {
    return [];
  }
}

/**
 * @param {string} current
 * @returns {string}
 */
function resolveNextProVersion(current) {
  const parsed = parseProVersion(current);
  if (!parsed) return bumpVersionString(current);

  const tagMax = listProTagNumbers().reduce((max, n) => Math.max(max, n), 0);
  const nextPro = Math.max(parsed.pro, tagMax) + 1;
  return `${parsed.prefix}${nextPro}`;
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = String(pkg.version || '0.0.0');
const next = resolveNextProVersion(current);
pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = next;
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
} catch {
  /* 无 lock 时忽略 */
}

process.stdout.write(next);
