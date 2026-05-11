/**
 * 支付回调与发布元数据服务（默认监听 8848）
 *
 * 环境变量见 server/.env.example 与 docs/github-actions-secrets.md
 * 切勿将服务器 root 密码写入仓库；部署请用 SSH 密钥或受控面板。
 */

import dotenv from 'dotenv';
import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const DATA_DIR = process.env.STUDIO_SERVER_DATA_DIR || join(__dirname, 'data');
const ORDERS_FILE = join(DATA_DIR, 'orders.json');
const RELEASE_FILE = join(DATA_DIR, 'latest-github-release.json');

const PORT = Number(process.env.PORT || 8848);
const MOCK_PAY = process.env.MOCK_PAY === '1' || process.env.MOCK_PAY === 'true';
const RELEASE_INJECT_TOKEN = process.env.STUDIO_RELEASE_INJECT_TOKEN || '';

/** 支付宝开放平台「应用私钥」（用于调起支付，PEM 或一行字符串） */
const ALIPAY_APP_PRIVATE_KEY = process.env.ALIPAY_APP_PRIVATE_KEY || '';
/** 支付宝「支付宝公钥」（验签异步通知，非应用公钥） */
const ALIPAY_PUBLIC_KEY = process.env.ALIPAY_PUBLIC_KEY || '';
const ALIPAY_APP_ID = process.env.ALIPAY_APP_ID || '';

const orders = new Map();

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

async function tryVerifyAlipayNotify(postData) {
  if (!ALIPAY_APP_ID || !ALIPAY_APP_PRIVATE_KEY || !ALIPAY_PUBLIC_KEY) {
    return { ok: false, error: '未配置支付宝密钥，跳过验签（请配置 ALIPAY_APP_ID / 私钥 / 支付宝公钥）' };
  }
  try {
    const mod = await import('alipay-sdk');
    const AlipaySdk = mod.default || mod;
    const alipaySdk = new AlipaySdk({
      appId: ALIPAY_APP_ID,
      privateKey: ALIPAY_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
      alipayPublicKey: ALIPAY_PUBLIC_KEY.replace(/\\n/g, '\n'),
      signType: 'RSA2',
      gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
      timeout: 15000,
    });
    const ok = typeof alipaySdk.checkNotifySign === 'function' && alipaySdk.checkNotifySign(postData);
    return { ok: Boolean(ok), error: ok ? undefined : 'checkNotifySign 未通过' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'plantuml-studio-pay-server', mockPay: MOCK_PAY });
});

/** 创建解锁订单（客户端轮询 /api/orders/:id/status） */
app.post('/api/orders', (req, res) => {
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
  } else if (ALIPAY_APP_ID) {
    // 真实场景需按产品调用「手机网站支付」或「当面付」等接口生成表单/链接；此处返回占位，由商户自行补全 SDK 调用
    payUrl = `${req.protocol}://${req.get('host')}/pay/alipay-placeholder?orderId=${encodeURIComponent(id)}`;
  } else {
    payUrl = '';
  }

  res.json({ ok: true, orderId: id, payUrl, mock: MOCK_PAY });
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
app.post('/api/alipay/notify', async (req, res) => {
  const postData = req.body || {};
  const tradeStatus = postData.trade_status;
  const outTradeNo = postData.out_trade_no;

  if (MOCK_PAY) {
    return res.send('success');
  }

  const v = await tryVerifyAlipayNotify(postData);
  if (!v.ok) {
    console.warn('[alipay notify] verify failed:', v.error);
    return res.status(400).send('fail');
  }

  if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
    return res.send('success');
  }

  const order = orders.get(outTradeNo);
  if (order) {
    order.status = 'paid';
    order.paidAt = Date.now();
    order.alipayTradeNo = postData.trade_no || '';
    order.unlockToken = buildUnlockToken(order);
    orders.set(order.id, order);
    persistOrders();
  }

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

app.get('/pay/alipay-placeholder', (_req, res) => {
  res.type('html').send(
    '<!DOCTYPE html><html><body style="padding:2rem;font-family:sans-serif"><h2>支付宝收银台占位</h2><p>请在服务器上补全「手机网站支付」或「电脑网站支付」下单逻辑，将用户重定向到支付宝官方页面。</p><p>参考：<code>alipay-sdk</code> 文档与开放平台密钥配置。</p></body></html>'
  );
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

loadOrders();
ensureDataDir();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[studio-pay-server] listening on 0.0.0.0:${PORT} mockPay=${MOCK_PAY}`);
});
