/**
 * CI 用：将 package.json 版本按「补丁 +1」规则递增，并同步 package-lock.json 顶层版本字段。
 * 规则：若为 x.y.z-pro.n 则 n+1；否则将 z 加一并保留可选后缀。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(root, '..', 'package.json');
const lockPath = join(root, '..', 'package-lock.json');

function bumpVersionString(v) {
  const pro = v.match(/^(\d+)\.(\d+)\.(\d+)-pro\.(\d+)$/);
  if (pro) {
    return `${pro[1]}.${pro[2]}.${pro[3]}-pro.${Number(pro[4]) + 1}`;
  }
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`无法解析版本号: ${v}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] || ''}`;
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const next = bumpVersionString(String(pkg.version || '0.0.0'));
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
