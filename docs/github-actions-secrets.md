# GitHub Actions 与自建服务器：Secrets 配置说明

本文说明本仓库 **Release on push** 工作流及桌面客户端联调服务器时，需要在 **GitHub → Settings → Secrets and variables → Actions** 中配置的密钥名称与取值来源。

**请勿**将云服务器 SSH 密码、支付宝私钥等敏感信息写入仓库或提交到 git。

**Windows 安装包与 PlantUML JAR**：`plantuml-*.jar` 在 `.gitignore` 中，仓库不含该二进制。工作流在 `electron-builder` 前会执行 **`npm run prepare:plantuml`**（从 PlantUML 官方 GitHub latest 下载 `plantuml-{version}.jar` 至 `vendor/plantuml/`），否则安装包内无 JAR，启动会提示「未找到 PlantUML JAR」。`GITHUB_TOKEN` 由工作流注入，用于提高 `api.github.com` 请求额度。

---

## 1. 发布元数据注入（工作流 `update-infra-release-meta` 任务）

在 Windows 构建并上传 GitHub Release 成功后，可选地向自建服务 `POST` 一条 JSON，用于更新「最新版本」等展示信息（对应 `server/index.mjs` 的 `/internal/github-release`）。

| Secret 名称 | 必填 | 说明 |
|-------------|------|------|
| `STUDIO_RELEASE_INJECT_URL` | 可选 | 完整 URL，例如 `http://39.105.11.3:8848/internal/github-release`（生产环境建议 HTTPS + 域名） |
| `STUDIO_RELEASE_INJECT_TOKEN` | 与上一项同时配置 | 与服务器环境变量 `STUDIO_RELEASE_INJECT_TOKEN` **完全一致**的长随机字符串（Bearer Token） |

若未配置上述两项，工作流会跳过该步骤，不影响构建与 Release。

---

## 2. 服务器（8848）环境变量（不在 GitHub，在机器上配置）

在 `39.105.11.3` 上部署 `server/` 时，将 `server/.env.example` 复制为 `.env` 或写入 systemd，至少包含：

| 变量名 | 说明 |
|--------|------|
| `PORT` | 默认 `8848` |
| `STUDIO_RELEASE_INJECT_TOKEN` | 与 GitHub Secret `STUDIO_RELEASE_INJECT_TOKEN` 相同 |
| `MOCK_PAY` | 开发联调设为 `1`；正式对接支付宝后改为 `0` 并配置下方支付宝变量 |
| `UNLOCK_PEPPER` | 可选，用于派生 `unlockToken` 的盐 |
| `PUBLIC_BASE_URL` | 外网根地址（须含协议与端口或反代路径），用于支付宝 `notify_url` / `return_url`，生产建议 **HTTPS** |
| `ALIPAY_KEY_TYPE` | 可选，`PKCS1` 或 `PKCS8`（默认 PKCS8） |
| `TRUST_PROXY` | 置于反代后若需识别 `https`，设为 `1` |

### 支付宝（正式收款）

在 [支付宝开放平台](https://open.alipay.com/) 创建应用，并**签约与本仓库接口一致的产品**：本服务使用 **`alipay.trade.page.pay`（电脑网站支付）**，仅开通「手机网站支付」或「当面付」而未开通「电脑网站支付」时，跳转支付宝常见错误 **`insufficient-isv-permissions`（ISV权限不足）**——需在开放平台 **产品中心** 为当前 App 签约 **电脑网站支付** 并待审核生效。完成签约后获取：

| 变量名 | 说明 |
|--------|------|
| `ALIPAY_APP_ID` | 开放平台「应用 APPID」 |
| `ALIPAY_APP_PRIVATE_KEY` | **应用私钥**（你本地生成 RSA2 密钥对中的私钥，PEM 格式；可写成一行并用 `\n` 表示换行） |
| `ALIPAY_PUBLIC_KEY` | **支付宝公钥**（开放平台「查看支付宝公钥」，用于验签异步通知；**不是**应用公钥） |
| `ALIPAY_GATEWAY` | 可选。默认 `https://openapi.alipay.com/gateway.do`；沙箱为 `https://openapi.alipaydev.com/gateway.do` |

**获取方式摘要：**

1. 登录开放平台 → 控制台 → 创建应用 → 产品中心签约 **「电脑网站支付」**（与 `alipay.trade.page.pay` 对应）；勿仅签约手机网站支付后仍用本接口。  
2. 「开发信息」中设置接口加签方式（RSA2），上传「应用公钥」后，保存平台返回的「支付宝公钥」→ 填入 `ALIPAY_PUBLIC_KEY`。  
3. 你本地用工具生成的 PKCS8 私钥 → 填入 `ALIPAY_APP_PRIVATE_KEY`。  
4. 在开放平台「应用信息」中配置 **授权回调地址**（与 `PUBLIC_BASE_URL` + 路径一致，外网可访问），异步通知指向 `https://你的域名/api/alipay/notify`。

当前 `server/index.mjs` 已实现 **电脑网站支付** `alipay.trade.page.pay`（返回 `payUrl`）、**同步跳转页** `/pay/return` 与 **异步通知** `/api/alipay/notify`（`checkNotifySignV2` / `checkNotifySign` 验签）。

**常见报错（支付宝黄色调试页）**

| 错误代码 | 含义与处理 |
|----------|------------|
| `insufficient-isv-permissions` | 当前 App 未签约或未生效 **电脑网站支付**；在开放平台产品中心完成签约后再试。 |
| 沙箱与正式混用 | 沙箱须使用 `ALIPAY_GATEWAY=https://openapi.alipaydev.com/gateway.do` 及沙箱 AppID/密钥；正式环境用 `openapi.alipay.com`。 |

客户端在创建真实支付订单后，会在界面 **错误/提示区** 显示服务端下发的简要排查说明（便于用户未截图时也能看到）。

---

## 3. SSH 自动部署支付服务（工作流 `deploy-pay-server`）

在 Release 构建及可选的「发布元数据」步骤完成后，Runner 会通过 **SSH** 将仓库内 **`server/`** 目录以 **tar 流** 同步到服务器 `~/plantuml-pay-server/`，并执行 **`docker compose up -d --build`**（**不依赖**本机或服务器安装 `rsync`）。

| Secret / Variable | 必填 | 说明 |
|-------------------|------|------|
| `SSH_HOST` | 部署时必填 | 服务器 IP 或域名（**不要**带 `http://`） |
| `SSH_SECRET` | 与 `SSH_HOST` 同时配置时必填 | **OpenSSH 私钥全文**（`-----BEGIN ... PRIVATE KEY-----` …）；**不是** root 登录密码，也不是 `.pub` 公钥 |
| `SSH_USER` | 可选 | 登录用户名，未配置时默认为 **`root`** |

**重要：`SSH_SECRET` 绝对不能填服务器登录密码。** 本工作流使用 `ssh` 的 **公钥认证**（`BatchMode=yes`），不会、也无法用密码登录。密码既不是合法私钥，也不应出现在 GitHub（有泄露风险）。若曾把真实密码粘贴进 Secret，请 **立即修改服务器登录密码**，并把 GitHub 里的 `SSH_SECRET` 改成下面生成的 **私钥**。

**正确配置步骤（在本机或任意电脑执行一次即可）**

1. 生成 **无口令** 的部署专用密钥（不要对 CI 用的 key 设 passphrase）：

   ```bash
   ssh-keygen -t ed25519 -f ./gha-deploy-key -N ""
   ```

2. 把 **公钥** 追加到服务器的 `authorized_keys`（把 `USER`、`HOST` 换成你的 `SSH_USER` / `SSH_HOST`）：

   ```bash
   ssh-copy-id -i ./gha-deploy-key.pub USER@HOST
   ```

   若不能用 `ssh-copy-id`，可手动把 `gha-deploy-key.pub` 的一行内容追加到服务器上 `~/.ssh/authorized_keys`，并保证 `~/.ssh` 权限为 `700`、`authorized_keys` 为 `600`。

3. 在 GitHub → 仓库 → **Settings → Secrets and variables → Actions** 中，编辑 **`SSH_SECRET`**：打开文件 **`gha-deploy-key`（无 .pub 后缀的那份）**，**全文复制**（含 `BEGIN` / `END` 行），粘贴保存。**不要**粘贴 `.pub` 文件，也不要粘贴密码。

4. 删除本机临时文件 `gha-deploy-key` 与 `gha-deploy-key.pub`（私钥已进 GitHub Secret 后，本机副本按需保留备份或删除）。

若未配置 `SSH_HOST`，该 Job 会跳过部署且不报错（也不会加载 `SSH_SECRET`）。

**SSH Secret 常见问题（`ssh-add` / `error in libcrypto`）**

- 私钥须为 **未设置口令**（无 passphrase）的部署专用密钥；有口令时 CI 无法交互输入会失败。
- 从 Windows 记事本复制进 GitHub Secret 时容易带入 **`\\r\\n`**，会导致 OpenSSL 解析失败；请在 Linux/macOS 终端用 `cat id_ed25519` 复制，或在 Secret 中确保为 **Unix 换行（LF）**。
- 确认粘贴的是 **私钥** 全文，且首尾无多余 `%`、空格或说明文字。

**服务器需预先**：安装 Docker 与 Docker Compose 插件；在 `~/plantuml-pay-server/` 首次部署时 **GitHub Actions 会从 `.env.example` 自动生成 `.env` 占位**（因 CI 从不同步真实 `.env`），你仍需 **SSH 登录编辑** `~/plantuml-pay-server/.env` 填入支付宝等密钥后再按需重启容器。同步方式为 **tar 覆盖解压**：仓库里已删除的文件**不会**从服务器目录自动删除（与旧版 `rsync --delete` 不同）；若需完全一致可偶尔手动清理目标目录。CI 打包时已排除 `.env`，**不会**覆盖你已在服务器上配置好的 `.env`。

---

## 4. 客户端指向支付服务（可选）

Electron 主进程默认请求 `http://39.105.11.3:8848`（可通过环境变量覆盖）：

| 环境变量 | 说明 |
|----------|------|
| `STUDIO_PAY_API_BASE` | 例如 `http://39.105.11.3:8848`，不要末尾 `/` |

打包后的用户机器可在启动脚本或快捷方式上设置该变量，指向你的正式 HTTPS 域名。

### 浏览器访问 `http://<公网IP>:8848` 出现「响应时间太长」/ `ERR_CONNECTION_TIMED_OUT`

这表示**请求在到达应用之前就被丢弃或未应答**，通常**不是**仓库里 Node 程序的逻辑 Bug（本服务在容器内监听 `0.0.0.0:8848`，`docker-compose` 已映射 `8848:8848`）。请按顺序排查：

1. **云厂商安全组（最常见）**  
   在阿里云 ECS 控制台 → 实例 → **安全组** → **入方向规则**，为 **TCP 8848** 增加允许规则（来源可先设为 `0.0.0.0/0` 做验证，确认后再收紧为你的办公网 IP）。未放行时，公网访问会一直超时。

2. **系统防火墙**  
   SSH 登录服务器执行 `sudo ufw status` 或检查 `firewalld`/`iptables`，若启用则需放行 **8848/tcp**（或先临时关闭防火墙验证）。

3. **容器是否在跑**  
   `cd ~/plantuml-pay-server && docker compose ps`，确认 `studio-pay-server` 为 `running`。若未启动：`docker compose up -d` 并查看 `docker compose logs`。

4. **本机与端口**  
   在服务器上执行 `curl -sS -m 3 http://127.0.0.1:8848/api/health`；若本机通、外网不通，几乎可断定是**安全组或上游防火墙**。

生产环境建议通过 **HTTPS + 域名**（备案域名反代到 8848）对外提供服务，而不是长期暴露裸 `http://IP:8848`。

---

## 5. 与支付宝相关的 GitHub Secrets（汇总表）

仅当你打算在 **GitHub Actions 内** 调用支付宝接口（一般不需要；推荐在自建服务器持有私钥）时才在 GitHub 配置：

| Secret 名称（示例） | 取值来源 |
|---------------------|----------|
| `ALIPAY_APP_ID` | 开放平台应用 APPID |
| `ALIPAY_APP_PRIVATE_KEY` | 应用私钥 PEM（极敏感，优先只放在自建服务器） |
| `ALIPAY_PUBLIC_KEY` | 支付宝公钥（验签） |

本仓库默认设计：**私钥只部署在自建服务器的 `server/.env` 中**，GitHub Actions 不保存支付宝私钥；GitHub 侧可配置 `SSH_*` 与发布元数据 Token 以完成部署与版本信息上报。

