/**
 * 月度密钥服务：登记（管理员）与核销（客户端，一次性）。
 *
 * 环境变量：
 * - PORT（默认 8850）
 * - MONTHLY_KEYS_ADMIN_TOKEN — 登记接口必填 Bearer Token
 */
import express from 'express';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MONTHLY_KEYS_DATA_DIR || join(__dirname, 'data');
const STORE_PATH = join(DATA_DIR, 'monthly-keys.json');

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) return { version: 1, keys: {} };
    const o = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    if (!o || typeof o !== 'object' || !o.keys || typeof o.keys !== 'object') return { version: 1, keys: {} };
    return o;
  } catch {
    return { version: 1, keys: {} };
  }
}

function saveStore(data) {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function addCalendarDaysYmd(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + Number(days) || 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function adminAuth(req) {
  const tok = String(process.env.MONTHLY_KEYS_ADMIN_TOKEN || '').trim();
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return Boolean(tok && m && m[1] === tok);
}

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'monthly-keys' });
});

/** 管理员：登记密钥（生成器生成后调用；同一密钥重复登记返回 duplicate） */
app.post('/api/admin/monthly-keys', (req, res) => {
  if (!adminAuth(req)) {
    res.status(401).json({ ok: false, error: '未授权：请携带正确的 Authorization: Bearer' });
    return;
  }
  const key = String(req.body?.key || '').trim();
  if (!key || key.length < 16) {
    res.status(400).json({ ok: false, error: '密钥过短或为空' });
    return;
  }
  const st = loadStore();
  if (st.keys[key]) {
    res.json({ ok: true, duplicate: true, message: '该密钥已登记' });
    return;
  }
  st.keys[key] = {
    status: 'registered',
    created_at: new Date().toISOString(),
    used_at: null,
    used_hw_id: null,
    valid_until: null,
  };
  saveStore(st);
  res.json({ ok: true });
});

/** 客户端：核销月度密钥，一次性；返回 valid_until（自然日 YYYY-MM-DD） */
app.post('/api/license/redeem-monthly', (req, res) => {
  const key = String(req.body?.key || '').trim();
  const hw = String(req.body?.hw_id || '').trim().toLowerCase();
  if (!key || !hw || hw.length < 16) {
    res.status(400).json({ ok: false, error: '请提供密钥与有效 hw_id' });
    return;
  }
  const st = loadStore();
  const row = st.keys[key];
  if (!row) {
    res.json({ ok: false, error: '密钥无效或未在服务器登记' });
    return;
  }
  if (row.status === 'used') {
    res.json({ ok: false, error: '密钥已使用并已作废' });
    return;
  }
  const validUntil = addCalendarDaysYmd(31);
  row.status = 'used';
  row.used_at = new Date().toISOString();
  row.used_hw_id = hw;
  row.valid_until = validUntil;
  saveStore(st);
  res.json({ ok: true, valid_until: validUntil });
});

const PORT = Number(process.env.PORT || 8850);
app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[monthly-keys] listening on ${PORT}, store=${STORE_PATH}`);
});
