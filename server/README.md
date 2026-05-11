# 支付与发布元数据服务

监听端口默认 **8848**（可用环境变量 `PORT` 覆盖）。

## CI/CD 当前会部署后端吗？

**会（在推送 `main` 且 Release 流水线成功时）。**  
工作流 `deploy-pay-server` 在构建与可选的「发布元数据」步骤之后执行：通过 **SSH + tar 流** 将仓库内 **`server/`** 同步到服务器 **`~/plantuml-pay-server/`**，并执行 **`docker compose up -d --build`**（不要求服务器安装 `rsync`）。  
需在 GitHub Actions Secrets 中配置 **`SSH_HOST`**、**`SSH_SECRET`**（OpenSSH 私钥全文），可选 **`SSH_USER`**（默认 `root`）。未配置 `SSH_HOST` 时该步骤会跳过。

详见仓库根目录 **`docs/github-actions-secrets.md`**。

---

## 手动填写私钥的 `.env` 在哪里？

在**本仓库**里：

| 场景 | 路径 |
|------|------|
| 本地直接跑 Node | **`server/.env`**（与 `server/index.mjs`、`server/.env.example` 同目录） |
| 首次创建 | `cp server/.env.example server/.env`，再编辑 **`server/.env`** |

该文件已被根目录 `.gitignore` 忽略，**不会进入 git**。  
`index.mjs` 启动时会通过 `dotenv` **自动加载** `server/.env`。

使用 **Docker Compose** 时：在 **`server/` 目录下**（与 `docker-compose.yml` 同级）同样放置 **`server/.env`**，Compose 的 `env_file: .env` 会从宿主机读取该文件并注入容器。

---

## Docker 部署（推荐）

在服务器上进入包含 `Dockerfile` 的目录（即 **`server/`**）：

```bash
cd server
cp .env.example .env
# 编辑 .env：填入 ALIPAY_APP_ID、ALIPAY_APP_PRIVATE_KEY、ALIPAY_PUBLIC_KEY、STUDIO_RELEASE_INJECT_TOKEN 等

docker compose up -d --build
```

- 容器内监听 **8848**，映射到宿主机 **8848**。  
- 订单等数据在卷 **`studio_pay_data`**（容器内 `/app/data`）。

更新代码后：

```bash
git pull
docker compose up -d --build
```

---

## 快速启动（非 Docker）

```bash
cd server
npm install
cp .env.example .env
npm start
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
| GET | `/api/public/latest-release` | 公开读取最近一次 CI 写入的发布信息 |

## 支付宝正式接入

1. 在 [支付宝开放平台](https://open.alipay.com/) 创建应用并签约所需产品。  
2. 将 `ALIPAY_APP_ID`、`ALIPAY_APP_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` 写入 **`server/.env`**（或 Docker 使用的同一份 `env_file`）。  
3. 扩展 `index.mjs` 实现真实下单与 `payUrl`。  
4. 异步通知 URL 外网可达，指向 `/api/alipay/notify`。

## 数据目录

非 Docker：默认 `server/data/`。Docker：卷内 `/app/data`。
