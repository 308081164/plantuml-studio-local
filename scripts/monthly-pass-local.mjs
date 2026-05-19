/**
 * 月度解锁：由线上服务核销一次性密钥后，客户端写入本地 `valid_until`（YYYY-MM-DD）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const FILE = 'studio-monthly-pass.json';

function pathOf(userDataPath) {
  return join(userDataPath, FILE);
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function readMonthlyPass(userDataPath) {
  try {
    const p = pathOf(userDataPath);
    if (!existsSync(p)) return null;
    const o = JSON.parse(readFileSync(p, 'utf8'));
    if (!o || typeof o.valid_until !== 'string') return null;
    return o;
  } catch {
    return null;
  }
}

export function isMonthlyPassActive(userDataPath) {
  const o = readMonthlyPass(userDataPath);
  if (!o?.valid_until) return false;
  const t = todayYmd();
  return t <= String(o.valid_until).trim();
}

export function writeMonthlyPass(userDataPath, { valid_until }) {
  const p = pathOf(userDataPath);
  mkdirSync(dirname(p), { recursive: true });
  const body = {
    valid_until: String(valid_until || '').trim(),
    updated_at: new Date().toISOString(),
  };
  writeFileSync(p, JSON.stringify(body, null, 2), 'utf8');
}

export function clearMonthlyPass(userDataPath) {
  try {
    const p = pathOf(userDataPath);
    if (existsSync(p)) writeFileSync(p, JSON.stringify({ cleared: true, cleared_at: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}
