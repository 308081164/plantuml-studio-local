/**
 * 支付回调与发布元数据服务（默认监听 8848）
 *
 * 环境变量见 server/.env.example 与 docs/github-actions-secrets.md
 * 切勿将服务器 root 密码写入仓库；部署请用 SSH 密钥或受控面板。
 */

import './load-env.mjs';
import express from 'express';
import { AlipaySdk } from 'alipay-sdk';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';
import dns from 'node:dns';
import { generatePlantumlFromNaturalLanguage, isOnlineDeepseekConfigured } from './online-deepseek.mjs';

const require = createRequire(import.meta.url);
const { encode: encodePlantUML } = require('plantuml-encoder');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STUDIO_SERVER_DATA_DIR || join(__dirname, 'data');
const ORDERS_FILE = join(DATA_DIR, 'orders.json');
const RELEASE_FILE = join(DATA_DIR, 'latest-github-release.json');

const PORT = Number(process.env.PORT || 8848);
/** 监听网卡；默认 0.0.0.0 便于公网 IP:PORT 直连。若仅允许本机 Nginx 反代可设为 127.0.0.1 */
const BIND_HOST = (process.env.STUDIO_BIND_HOST || '0.0.0.0').trim() || '0.0.0.0';
const MOCK_PAY = process.env.MOCK_PAY === '1' || process.env.MOCK_PAY === 'true';
const RELEASE_INJECT_TOKEN = process.env.STUDIO_RELEASE_INJECT_TOKEN || '';

/** 支付宝开放平台「应用私钥」（用于调起支付，PEM 或一行字符串） */
const ALIPAY_APP_PRIVATE_KEY = process.env.ALIPAY_APP_PRIVATE_KEY || '';
/** 支付宝「支付宝公钥」（验签异步通知，非应用公钥） */
const ALIPAY_PUBLIC_KEY = process.env.ALIPAY_PUBLIC_KEY || '';
const ALIPAY_APP_ID = process.env.ALIPAY_APP_ID || '';
/** 外网根地址（用于 notify_url / return_url），生产须 HTTPS，如 https://pay.example.com */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
const ALIPAY_KEY_TYPE = process.env.ALIPAY_KEY_TYPE === 'PKCS1' ? 'PKCS1' : 'PKCS8';

/** 随订单返回给客户端：支付宝网页常见权限类报错的排查说明（非密钥错误） */
const ALIPAY_PAY_PAGE_HINT_ZH =
  '若打开支付宝网页出现「调试错误」且错误代码为 insufficient-isv-permissions（ISV权限不足）：请在「支付宝开放平台」→ 控制台 → 产品中心 为当前 App 签约并开通「电脑网站支付」，审核生效后再试。沙箱调试须设置 ALIPAY_GATEWAY=https://openapi.alipaydev.com/gateway.do，并使用沙箱 AppID 与沙箱密钥，勿与正式环境混用。';

const orders = new Map();

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req.get('host') || '';
  const proto = req.protocol || 'http';
  return host ? `${proto}://${host}` : `http://127.0.0.1:${PORT}`;
}

function createAlipaySdk() {
  if (!ALIPAY_APP_ID || !ALIPAY_APP_PRIVATE_KEY || !ALIPAY_PUBLIC_KEY) return null;
  return new AlipaySdk({
    appId: ALIPAY_APP_ID,
    privateKey: ALIPAY_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
    alipayPublicKey: ALIPAY_PUBLIC_KEY.replace(/\\n/g, '\n'),
    signType: 'RSA2',
    gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
    timeout: 15000,
    keyType: ALIPAY_KEY_TYPE,
  });
}

function tryVerifyAlipayNotify(postData) {
  const sdk = createAlipaySdk();
  if (!sdk) {
    return { ok: false, error: '未配置支付宝密钥，跳过验签（请配置 ALIPAY_APP_ID / 私钥 / 支付宝公钥）' };
  }
  try {
    let ok = false;
    if (typeof sdk.checkNotifySignV2 === 'function') {
      ok = sdk.checkNotifySignV2(postData);
    } else {
      ok = sdk.checkNotifySign(postData);
    }
    return { ok: Boolean(ok), error: ok ? undefined : '通知验签未通过' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function persistOrders() {
  ensureDataDir();
  const arr = [...orders.values()];
  writeFileSync(ORDERS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

function loadOrders() {
  try {
    if (!existsSync(ORDERS_FILE)) return;
    const arr = JSON.parse(readFileSync(ORDERS_FILE, 'utf8'));
    if (!Array.isArray(arr)) return;
    for (const o of arr) {
      if (o && o.id) orders.set(o.id, o);
    }
  } catch {
    /* ignore */
  }
}

function buildUnlockToken(order) {
  const payload = `${order.id}|${order.contentDigest || ''}|${order.hwId || ''}|paid`;
  return createHash('sha256').update(payload + '|' + (process.env.UNLOCK_PEPPER || 'studio-unlock-v1')).digest('hex');
}

const app = express();
if (String(process.env.TRUST_PROXY || '') === '1') {
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'plantuml-studio-pay-server', mockPay: MOCK_PAY });
});

/** 创建解锁订单（客户端轮询 /api/orders/:id/status） */
app.post('/api/orders', async (req, res) => {
  try {
    const hwId = String(req.body?.hwId || '').trim();
    const contentDigest = String(req.body?.contentDigest || '').trim();
    const sku = String(req.body?.sku || 'agent_output_unlock');
    const amount = Number(req.body?.amount) || 0.8;
    if (!hwId || !contentDigest) {
      return res.status(400).json({ ok: false, error: '缺少 hwId 或 contentDigest' });
    }
    const id = randomUUID();
    const order = {
      id,
      hwId,
      contentDigest,
      sku,
      amount,
      status: 'pending',
      createdAt: Date.now(),
      unlockToken: null,
    };
    orders.set(id, order);
    persistOrders();

    let payUrl = '';
    if (MOCK_PAY) {
      payUrl = `${req.protocol}://${req.get('host')}/mock-pay/checkout?orderId=${encodeURIComponent(id)}`;
    } else {
      const sdk = createAlipaySdk();
      if (!sdk) {
        return res.status(503).json({
          ok: false,
          error: '未配置完整支付宝参数（ALIPAY_APP_ID / ALIPAY_APP_PRIVATE_KEY / ALIPAY_PUBLIC_KEY），无法下单',
        });
      }
      const publicBase = getPublicBaseUrl(req);
      payUrl = sdk.pageExecute('alipay.trade.page.pay', 'GET', {
        bizContent: {
          out_trade_no: id,
          product_code: 'FAST_INSTANT_TRADE_PAY',
          subject: 'PlantUML 智能生成解锁',
          body: `sku:${String(sku).slice(0, 100)}`,
          total_amount: Math.max(0.01, amount).toFixed(2),
        },
        notifyUrl: `${publicBase}/api/alipay/notify`,
        returnUrl: `${publicBase}/pay/return?orderId=${encodeURIComponent(id)}`,
      });
    }

    res.json({
      ok: true,
      orderId: id,
      payUrl,
      mock: MOCK_PAY,
      clientHintZh: MOCK_PAY ? '' : ALIPAY_PAY_PAGE_HINT_ZH,
    });
  } catch (e) {
    console.error('[api/orders]', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/orders/:id/status', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ ok: false, error: '订单不存在' });
  res.json({
    ok: true,
    status: o.status,
    unlockToken: o.status === 'paid' ? o.unlockToken : null,
    orderId: o.id,
  });
});

/** 支付宝异步通知（application/x-www-form-urlencoded） */
app.post('/api/alipay/notify', (req, res) => {
  const postData = req.body || {};
  const tradeStatus = postData.trade_status;
  const outTradeNo = postData.out_trade_no;

  if (MOCK_PAY) {
    return res.send('success');
  }

  const v = tryVerifyAlipayNotify(postData);
  if (!v.ok) {
    console.warn('[alipay notify] verify failed:', v.error);
    return res.status(400).send('fail');
  }

  if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
    return res.send('success');
  }

  const order = orders.get(String(outTradeNo || ''));
  if (!order) {
    console.warn('[alipay notify] unknown out_trade_no:', outTradeNo);
    return res.send('success');
  }
  order.status = 'paid';
  order.paidAt = Date.now();
  order.alipayTradeNo = postData.trade_no || '';
  order.unlockToken = buildUnlockToken(order);
  orders.set(order.id, order);
  persistOrders();
  res.send('success');
});

/** 客户端校验 unlockToken 与 digest */
app.post('/api/unlock/verify', (req, res) => {
  const token = String(req.body?.unlockToken || '').trim();
  const digest = String(req.body?.contentDigest || '').trim();
  const hwId = String(req.body?.hwId || '').trim();
  if (!token || !digest || !hwId) {
    return res.status(400).json({ ok: false, error: '缺少参数' });
  }
  for (const o of orders.values()) {
    if (o.status !== 'paid' || !o.unlockToken) continue;
    if (o.hwId !== hwId || o.contentDigest !== digest) continue;
    if (o.unlockToken === token) {
      return res.json({ ok: true, orderId: o.id });
    }
  }
  res.status(400).json({ ok: false, error: '令牌无效或 digest 不匹配' });
});

app.get('/pay/return', (req, res) => {
  const orderId = String(req.query.orderId || '');
  res.type('html').send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>支付返回</title></head>
<body style="font-family:sans-serif;padding:2rem;max-width:520px;">
<h2>支付已提交</h2>
<p>若您已在支付宝完成付款，请返回 <strong>PlantUML 本地工作室</strong>，点击 <strong>「我已完成支付」</strong> 拉取解锁状态。</p>
<p style="font-size:0.85rem;color:#666;">订单号：<code>${orderId || '—'}</code></p>
</body></html>`);
});

/** 模拟收银台（仅 MOCK_PAY） */
app.get('/mock-pay/checkout', (req, res) => {
  if (!MOCK_PAY) return res.status(404).send('Not found');
  const orderId = String(req.query.orderId || '');
  const o = orders.get(orderId);
  if (!o) return res.status(404).send('订单不存在');
  res.type('html').send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>模拟支付</title></head>
<body style="font-family:sans-serif;padding:2rem;">
<h1>模拟支付（开发用）</h1>
<p>订单：${orderId}</p>
<p>金额：¥${o.amount}</p>
<form method="POST" action="/mock-pay/complete">
<input type="hidden" name="orderId" value="${orderId}"/>
<button type="submit">确认已支付（模拟）</button>
</form></body></html>`);
});

app.post('/mock-pay/complete', express.urlencoded({ extended: true }), (req, res) => {
  if (!MOCK_PAY) return res.status(404).send('Not found');
  const orderId = String(req.body?.orderId || '');
  const o = orders.get(orderId);
  if (!o) return res.status(404).send('订单不存在');
  o.status = 'paid';
  o.paidAt = Date.now();
  o.unlockToken = buildUnlockToken(o);
  orders.set(o.id, o);
  persistOrders();
  res.redirect(`/mock-pay/done?orderId=${encodeURIComponent(orderId)}`);
});

app.get('/mock-pay/done', (req, res) => {
  if (!MOCK_PAY) return res.status(404).send('Not found');
  const orderId = String(req.query.orderId || '');
  const o = orders.get(orderId);
  res.type('html').send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/></head>
<body style="font-family:sans-serif;padding:2rem;">
<h2>支付完成（模拟）</h2>
<p>请返回桌面客户端，点击「我已完成支付」进行校验。</p>
<p>订单号：<code>${orderId}</code></p>
${o?.unlockToken ? `<p style="word-break:break-all;">调试令牌：<code>${o.unlockToken}</code></p>` : ''}
</body></html>`);
});

/** GitHub Actions：推送发布元数据（Bearer Token） */
app.post('/internal/github-release', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!RELEASE_INJECT_TOKEN || token !== RELEASE_INJECT_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const body = req.body || {};
  ensureDataDir();
  const record = {
    receivedAt: new Date().toISOString(),
    repository: body.repository,
    tag: body.tag,
    sha: body.sha,
    workflow: body.workflow,
    htmlUrl: body.html_url || body.htmlUrl,
    assets: body.assets || [],
  };
  writeFileSync(RELEASE_FILE, JSON.stringify(record, null, 2), 'utf8');
  res.json({ ok: true, written: RELEASE_FILE });
});

app.get('/api/public/latest-release', (_req, res) => {
  try {
    if (!existsSync(RELEASE_FILE)) return res.json({ ok: true, record: null });
    const record = JSON.parse(readFileSync(RELEASE_FILE, 'utf8'));
    res.json({ ok: true, record });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 在线 PlantUML 预览：编码后请求 PlantUML 官方公共服务（国内可达性通常优于 Kroki） */
const MAX_PLANTUML_SOURCE_CHARS = 180_000;
const PLANTUML_ONLINE_SVG_BASE = (
  process.env.PLANTUML_ONLINE_SVG_BASE || 'https://www.plantuml.com/plantuml/svg'
).replace(/\/$/, '');
/** GET 路径过长时易被网关截断，超过则提示使用桌面端 */
const MAX_ENCODED_PATH_CHARS = 7500;

/**
 * @param {string} source
 * @returns {Promise<{ ok: true, svg: string } | { ok: false, error: string, detail?: string }>}
 */
async function renderPlantumlSourceToSvg(source) {
  const trimmed = String(source ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return { ok: false, error: '请输入 PlantUML 源码' };
  }
  if (source.length > MAX_PLANTUML_SOURCE_CHARS) {
    return {
      ok: false,
      error: `源码长度超过上限（${MAX_PLANTUML_SOURCE_CHARS} 字符）`,
    };
  }
  let encoded;
  try {
    encoded = encodePlantUML(source);
  } catch (encErr) {
    return { ok: false, error: `编码失败：${encErr.message || encErr}` };
  }
  if (encoded.length > MAX_ENCODED_PATH_CHARS) {
    return {
      ok: false,
      error:
        '图表过大，编码后超出在线预览 URL 上限。请精简图源或使用桌面客户端进行本地渲染。',
    };
  }
  const url = `${PLANTUML_ONLINE_SVG_BASE}/${encoded}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  let r;
  try {
    r = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      headers: { Accept: 'image/svg+xml,text/plain,*/*' },
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await r.text();
  if (!r.ok) {
    return {
      ok: false,
      error: `PlantUML 在线服务返回 HTTP ${r.status}`,
      detail: text.slice(0, 4000),
    };
  }
  if (!text.includes('<svg')) {
    return {
      ok: false,
      error: '渲染结果非有效 SVG（可能为语法错误提示页）',
      detail: text.slice(0, 2000),
    };
  }
  return { ok: true, svg: text };
}

app.post('/api/convert/plantuml', async (req, res) => {
  try {
    const source = String(req.body?.source ?? '').replace(/^\uFEFF/, '');
    const out = await renderPlantumlSourceToSvg(source);
    if (!out.ok) {
      const status = out.error.includes('上限') ? 413 : out.error.includes('编码') ? 400 : 502;
      return res.status(status).json({ ok: false, error: out.error, detail: out.detail });
    }
    return res.json({ ok: true, svg: out.svg });
  } catch (e) {
    const msg = e?.name === 'AbortError' ? '渲染超时，请缩小图表或稍后重试' : String(e?.message || e);
    return res.status(502).json({ ok: false, error: msg });
  }
});

const MAX_NL_USER_CHARS = 12_000;

app.get('/api/public/online-ai', (_req, res) => {
  res.json({
    ok: true,
    deepseekConfigured: isOnlineDeepseekConfigured(),
  });
});

app.post('/api/convert/plantuml-nl', async (req, res) => {
  try {
    if (!isOnlineDeepseekConfigured()) {
      return res.status(503).json({
        ok: false,
        code: 'deepseek_not_configured',
        error:
          '服务端未配置 STUDIO_ONLINE_DEEPSEEK_API_KEY，自然语言生成不可用。请在 .env 中填写该字段后重启服务。',
      });
    }
    const userText = String(req.body?.userText ?? '').replace(/^\uFEFF/, '').trim();
    if (!userText) {
      return res.status(400).json({ ok: false, error: '请输入自然语言描述' });
    }
    if (userText.length > MAX_NL_USER_CHARS) {
      return res.status(413).json({
        ok: false,
        error: `描述过长（上限 ${MAX_NL_USER_CHARS} 字符）`,
      });
    }
    const renderSvg = req.body?.renderSvg !== false;
    let plantuml;
    try {
      plantuml = await generatePlantumlFromNaturalLanguage(userText);
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e.message || e) });
    }
    if (!plantuml || !/@start/i.test(plantuml)) {
      return res.status(502).json({
        ok: false,
        error: '模型未返回有效 PlantUML 源码（未检测到 @start…）',
        detail: plantuml?.slice(0, 800),
      });
    }
    if (!renderSvg) {
      return res.json({ ok: true, plantuml });
    }
    const svgOut = await renderPlantumlSourceToSvg(plantuml);
    if (!svgOut.ok) {
      return res.json({
        ok: true,
        plantuml,
        svg: null,
        renderWarning: svgOut.error,
        renderDetail: svgOut.detail,
      });
    }
    return res.json({ ok: true, plantuml, svg: svgOut.svg });
  } catch (e) {
    console.error('[api/convert/plantuml-nl]', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* ---------- 月度一次性密钥（登记 / 核销，JSON 持久化） ---------- */
const MONTHLY_KEYS_FILE = join(DATA_DIR, 'monthly-keys.json');

function loadMonthlyKeyStore() {
  try {
    if (!existsSync(MONTHLY_KEYS_FILE)) return { version: 1, keys: {} };
    const o = JSON.parse(readFileSync(MONTHLY_KEYS_FILE, 'utf8'));
    if (!o || typeof o !== 'object' || !o.keys || typeof o.keys !== 'object') return { version: 1, keys: {} };
    return o;
  } catch {
    return { version: 1, keys: {} };
  }
}

function saveMonthlyKeyStore(data) {
  mkdirSync(dirname(MONTHLY_KEYS_FILE), { recursive: true });
  writeFileSync(MONTHLY_KEYS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function addCalendarDaysYmd(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + (Number(days) || 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function adminMonthlyKeysAuth(req) {
  const tok = String(process.env.MONTHLY_KEYS_ADMIN_TOKEN || '').trim();
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return Boolean(tok && m && m[1] === tok);
}

app.post('/api/admin/monthly-keys', (req, res) => {
  if (!adminMonthlyKeysAuth(req)) {
    res.status(401).json({ ok: false, error: '未授权：请携带正确的 Authorization: Bearer' });
    return;
  }
  const key = String(req.body?.key || '').trim();
  if (!key || key.length < 16) {
    res.status(400).json({ ok: false, error: '密钥过短或为空' });
    return;
  }
  const st = loadMonthlyKeyStore();
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
  saveMonthlyKeyStore(st);
  res.json({ ok: true });
});

app.post('/api/license/redeem-monthly', (req, res) => {
  const key = String(req.body?.key || '').trim();
  const hw = String(req.body?.hw_id || '').trim().toLowerCase();
  if (!key || !hw || hw.length < 16) {
    res.status(400).json({ ok: false, error: '请提供密钥与有效 hw_id' });
    return;
  }
  const st = loadMonthlyKeyStore();
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
  saveMonthlyKeyStore(st);
  res.json({ ok: true, valid_until: validUntil });
});

const PUBLIC_WEB_DIR = join(__dirname, 'public');
const INDEX_HTML = join(PUBLIC_WEB_DIR, 'index.html');

/** 根路径：在挂载 static 之前兜底，避免镜像缺 public 时整站无响应 */
app.get('/', (_req, res, next) => {
  if (existsSync(INDEX_HTML)) return next();
  res.type('html').status(200).send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>PlantUML Studio 服务</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:36rem;line-height:1.5;">
<h1>服务已启动</h1>
<p>未找到 <code>public/index.html</code>，静态营销页未部署。请确认镜像/目录中包含 <code>public</code> 后重建容器。</p>
<p><a href="/api/health">健康检查</a>（JSON）</p>
</body></html>`);
});

if (existsSync(PUBLIC_WEB_DIR)) {
  app.use(express.static(PUBLIC_WEB_DIR, { maxAge: '2h', index: 'index.html' }));
}

loadOrders();
ensureDataDir();

process.on('unhandledRejection', (reason) => {
  console.error('[studio-pay-server] unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[studio-pay-server] uncaughtException', err);
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`[studio-pay-server] listening on ${BIND_HOST}:${PORT} mockPay=${MOCK_PAY}`);
});
