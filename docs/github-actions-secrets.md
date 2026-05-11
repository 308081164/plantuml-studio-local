# GitHub Actions 与自建服务器：Secrets 配置说明

本文说明本仓库 **Release on push** 工作流及桌面客户端联调服务器时，需要在 **GitHub → Settings → Secrets and variables → Actions** 中配置的密钥名称与取值来源。

**请勿**将云服务器 SSH 密码、支付宝私钥等敏感信息写入仓库或提交到 git。

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

### 支付宝（正式收款）

在 [支付宝开放平台](https://open.alipay.com/) 创建移动应用或网页支付产品，完成签约后获取：

| 变量名 | 说明 |
|--------|------|
| `ALIPAY_APP_ID` | 开放平台「应用 APPID」 |
| `ALIPAY_APP_PRIVATE_KEY` | **应用私钥**（你本地生成 RSA2 密钥对中的私钥，PEM 格式；可写成一行并用 `\n` 表示换行） |
| `ALIPAY_PUBLIC_KEY` | **支付宝公钥**（开放平台「查看支付宝公钥」，用于验签异步通知；**不是**应用公钥） |
| `ALIPAY_GATEWAY` | 可选。默认 `https://openapi.alipay.com/gateway.do`；沙箱为 `https://openapi.alipaydev.com/gateway.do` |

**获取方式摘要：**

1. 登录开放平台 → 控制台 → 创建应用 → 添加「手机网站支付」等能力。  
2. 「开发信息」中设置接口加签方式（RSA2），上传「应用公钥」后，保存平台返回的「支付宝公钥」→ 填入 `ALIPAY_PUBLIC_KEY`。  
3. 你本地用工具生成的 PKCS8 私钥 → 填入 `ALIPAY_APP_PRIVATE_KEY`。  
4. 在应用内配置「授权回调地址」与「应用网关」等（按所选产品文档）。

当前仓库内 `server/index.mjs` 已实现 **异步通知路由** `/api/alipay/notify` 与验签骨架；**调起支付的真实 `payUrl`** 需你按产品文档在服务端补全 `alipay-sdk` 下单逻辑（占位页见 `/pay/alipay-placeholder`）。

---

## 3. 客户端指向支付服务（可选）

Electron 主进程默认请求 `http://39.105.11.3:8848`（可通过环境变量覆盖）：

| 环境变量 | 说明 |
|----------|------|
| `STUDIO_PAY_API_BASE` | 例如 `http://39.105.11.3:8848`，不要末尾 `/` |

打包后的用户机器可在启动脚本或快捷方式上设置该变量，指向你的正式 HTTPS 域名。

---

## 4. SSH 部署服务器（不推荐把 root 密码放进 GitHub）

若希望通过 CI **SSH 上传构建产物**，建议使用 **SSH 私钥**（如 `DEPLOY_SSH_KEY`）+ `known_hosts`，**不要**把明文 root 密码写入 `Secrets`。

日常运维登录服务器请用密钥或堡垒机，与 CI 解耦。

---

## 5. 与支付宝相关的 GitHub Secrets（汇总表）

仅当你打算在 **GitHub Actions 内** 调用支付宝接口（一般不需要；推荐在自建服务器持有私钥）时才在 GitHub 配置：

| Secret 名称（示例） | 取值来源 |
|---------------------|----------|
| `ALIPAY_APP_ID` | 开放平台应用 APPID |
| `ALIPAY_APP_PRIVATE_KEY` | 应用私钥 PEM（极敏感，优先只放在自建服务器） |
| `ALIPAY_PUBLIC_KEY` | 支付宝公钥（验签） |

本仓库默认设计：**私钥只部署在 39.105.11.3 的 Node 服务上**，GitHub 只推送发布元数据（Bearer Token），降低泄露面。
