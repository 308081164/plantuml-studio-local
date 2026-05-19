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
`index.mjs` 启动时会通过 **`load-env.mjs`** 自动加载同目录下的 `.env`（不覆盖已由 Docker / 系统注入的非空变量）。

使用 **Docker Compose** 时：在 **`server/` 目录下**（与 `docker-compose.yml` 同级）放置 **`server/.env`**，Compose 的 `env_file: .env` 会从宿主机读取该文件并注入容器。**首次 CI 部署**若目录里没有 `.env`，流水线会从 `.env.example` 自动复制一份占位文件（你仍需 SSH 上机填写真实密钥）。

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
| POST | `/api/admin/monthly-keys` | 登记月度密钥（Header: `Authorization: Bearer <MONTHLY_KEYS_ADMIN_TOKEN>`，body: `{ key }`） |
| POST | `/api/license/redeem-monthly` | 客户端核销月度密钥（body: `{ key, hw_id }`，一次性） |

密钥数据默认写入 `data/monthly-keys.json`（与订单数据同卷）。详见 `.env.example` 中的 `MONTHLY_KEYS_ADMIN_TOKEN`。

## 支付宝正式接入

1. 在 [支付宝开放平台](https://open.alipay.com/) 创建应用并签约所需产品。  
2. 将 `ALIPAY_APP_ID`、`ALIPAY_APP_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` 写入 **`server/.env`**（或 Docker 使用的同一份 `env_file`）。  
3. 扩展 `index.mjs` 实现真实下单与 `payUrl`。  
4. 异步通知 URL 外网可达，指向 `/api/alipay/notify`。

## 数据目录

非 Docker：默认 `server/data/`。Docker：卷内 `/app/data`。

---

## 排查：浏览器访问 `http://公网IP:8848` 出现 HTTP 502

**本服务（Express）对首页 `GET /` 正常应返回 200（静态页）或 JSON 接口返回 4xx/5xx，一般不会主动返回「网关 502」那种空白页。** 若 Edge/Chrome 显示 **HTTP ERROR 502**，多数是 **Nginx（或其它反代）在 8848 端口上代替 Node 监听**，反代到上游失败；或 **宿主机 8848 被其它程序占用**，Docker 实际未绑定到公网。

### 建议按顺序检查

1. **在 ECS 上直连容器端口（绕过公网）**  
   ```bash
   curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:8848/api/health
   ```  
   若此处为 **200**，说明 Node 容器正常，问题在 **公网到宿主机 8848** 或 **前面还有一层 502**。

2. **谁占用了宿主机 8848**  
   ```bash
   ss -tlnp | grep 8848
   ```  
   - 若显示 **`docker-proxy`**：一般为 Compose 映射正常。  
   - 若显示 **`nginx`**：说明宝塔/Nginx 抢占了 8848，Docker 可能映射失败或映射到别的端口，浏览器访问 IP:8848 会走 Nginx → 上游异常即 **502**。处理：**不要让 Nginx 监听 8848**，或把 Compose 改为 **`18848:8848`**，再用 Nginx **反代到 127.0.0.1:18848**。

3. **阿里云安全组**  
   入方向放行 **TCP 8848**（若改用 18848 则放行对应端口）。

4. **`.env` 中的 `STUDIO_BIND_HOST`**  
   若误设为 **`127.0.0.1`**，则容器内只监听回环，**公网 IP:8848 无法连到 Node**（表现多为超时或经反代后 502）。留空或 **`0.0.0.0`** 即可（见 `.env.example`）。

5. **改端口后**  
   执行 `docker compose up -d --build`，再用 `curl` 复测。

6. **`curl … 000` 且 `Connection refused`、且 `ss` 无 8848**  
   表示**当前宿主机没有任何服务监听 8848**（容器未运行、映射失败或未部署）。请在本机目录 `~/plantuml-pay-server` 执行：  
   `docker compose ps -a` · `docker compose logs --tail=80 studio-pay-server`  
   若提示 `docker: command not found`，需先安装并启动 Docker；若容器为 `Exited`，根据日志修正 `.env` 或镜像后再 `docker compose up -d --build`。  
   若状态为 **`Restarting`** 且日志含 **`ERR_MODULE_NOT_FOUND`** / **`Cannot find package ... express`**：镜像内依赖未就绪或缓存异常，请 **`docker compose build --no-cache && docker compose up -d`**（或先同步含最新 `Dockerfile` 的 `server/` 再执行）。

7. **服务器未安装 `git`**  
   不影响使用 **GitHub Actions 的 tar|ssh 部署**（流水线会把 `server/` 打包解压到该目录）。若你仍想在服务器上 `git pull`，可安装：`dnf install -y git`（AlmaLinux/RHEL 系）或按发行版使用 `yum`/`apt`。

### 与「仅域名 HTTPS 访问」的关系

生产环境更推荐：**仅 80/443 由 Nginx 终止 TLS**，上游指向 **`http://127.0.0.1:8848`**（或映射后的本机端口），不必把 8848 暴露到公网。此时公网访问 **IP:8848** 可能故意不通，属安全策略，不是故障。
