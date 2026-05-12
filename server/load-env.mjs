/**
 * 轻量 .env 加载（不依赖 dotenv 包，避免容器内 ESM 解析 node_modules/dotenv 失败导致进程无法启动）。
 * Docker Compose 的 env_file 已会把变量注入进程环境；若存在 /app/.env 文件则再合并（不覆盖已有非空值）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} envPath
 */
export function loadEnvFromPath(envPath) {
  if (!envPath || !existsSync(envPath)) return;
  let raw = readFileSync(envPath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      const q = val[0];
      val = val.slice(1, -1);
      if (q === '"') val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      else val = val.replace(/\\n/g, '\n').replace(/\\'/g, "'");
    }
    const cur = process.env[key];
    if (cur === undefined || cur === '') {
      process.env[key] = val;
    }
  }
}

loadEnvFromPath(join(dirname(fileURLToPath(import.meta.url)), '.env'));
