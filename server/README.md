# 支付与发布元数据服务

监听端口默认 **8848**（可用环境变量 `PORT` 覆盖）。

## 快速启动

```bash
cd server
npm install
export STUDIO_RELEASE_INJECT_TOKEN='与 GitHub Actions Secret 一致的长随机串'
export MOCK_PAY=1
node index.mjs
```

## 环境变量

见同目录 `.env.example`。

## 接口摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/orders` | 创建解锁订单，body: `{ hwId, contentDigest, sku?, amount? }` |
| GET | `/api/orders/:id/status` | 轮询订单，`paid` 时返回 `unlockToken` |
| POST | `/api/unlock/verify` | 校验令牌，body: `{ hwId, contentDigest, unlockToken }` |
| POST | `/api/alipay/notify` | 支付宝异步通知（`application/x-www-form-urlencoded`） |
| POST | `/internal/github-release` | CI 写入发布元数据，Header: `Authorization: Bearer <STUDIO_RELEASE_INJECT_TOKEN>` |
| GET | `/api/public/latest-release` | 公开读取最近一次 CI 写入的发布信息（可选给客户端检查更新） |

## 支付宝正式接入

1. 在 [支付宝开放平台](https://open.alipay.com/) 创建应用，开通「手机网站支付」或所需产品。  
2. 生成 RSA2 密钥对，配置「应用公钥」，获取「支付宝公钥」。  
3. 将 `ALIPAY_APP_ID`、`ALIPAY_APP_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` 写入服务器环境（**不要**提交到 git）。  
4. 在 `POST /api/orders` 返回真实 `payUrl` 或表单（需自行扩展 `index.mjs` 调用 `alipay-sdk` 下单接口）。  
5. 异步通知 URL 指向 `https://你的域名/api/alipay/notify`（外网可达）。

## 数据目录

订单持久化默认写入 `server/data/orders.json`，可通过 `STUDIO_SERVER_DATA_DIR` 重定向。
