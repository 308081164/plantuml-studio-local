/**
 * 免费用量：每台设备安装目录下按自然日计数（与 HW_ID 脱钩，依赖本机 userData）。
 * 每日上限见 FREE_DAILY_LIMIT。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const FREE_DAILY_LIMIT = 12;
const QUOTA_FILE = 'studio-free-quota.json';

function quotaPath(userDataPath) {
  return join(userDataPath, QUOTA_FILE);
}

function localCalendarDay() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {string} userDataPath
 * @returns {{ day: string, count: number }}
 */
export function readFreeQuota(userDataPath) {
  try {
    const p = quotaPath(userDataPath);
    if (!existsSync(p)) return { day: localCalendarDay(), count: 0 };
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const day = typeof raw.day === 'string' ? raw.day : localCalendarDay();
    const count = Number.isFinite(raw.count) ? Math.max(0, Math.floor(raw.count)) : 0;
    return { day, count };
  } catch {
    return { day: localCalendarDay(), count: 0 };
  }
}

/**
 * 当前自然日剩余次数（不消耗）。
 * @param {string} userDataPath
 */
export function getFreeQuotaRemaining(userDataPath) {
  const today = localCalendarDay();
  let { day, count } = readFreeQuota(userDataPath);
  if (day !== today) {
    count = 0;
  }
  return Math.max(0, FREE_DAILY_LIMIT - count);
}

/**
 * 成功使用一次免费用量后调用。
 * @returns {{ ok: boolean, remaining: number, error?: string }}
 */
export function consumeOneFreeUse(userDataPath) {
  const today = localCalendarDay();
  let { day, count } = readFreeQuota(userDataPath);
  if (day !== today) {
    day = today;
    count = 0;
  }
  if (count >= FREE_DAILY_LIMIT) {
    return { ok: false, remaining: 0, error: `今日免费用量已用完（${FREE_DAILY_LIMIT}/${FREE_DAILY_LIMIT}），请明日再试或激活专业版 / 使用月度密钥。` };
  }
  count += 1;
  const p = quotaPath(userDataPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ day, count, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  return { ok: true, remaining: FREE_DAILY_LIMIT - count };
}
