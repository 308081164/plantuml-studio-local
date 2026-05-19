# 月度密钥服务（可选部署）

为客户端「月度解锁密钥」提供 **登记**（管理员）与 **核销**（终端用户，一次性）接口。数据默认写入本目录下 `data/monthly-keys.json`（可视为轻量数据库；生产可换 SQLite）。

## 快速启动

```bash
cd server
cp .env.example .env
# 编辑 .env：设置 MONTHLY_KEYS_ADMIN_TOKEN
npm install
npm start
```

健康检查：`GET /api/health`

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/monthly-keys` | Header：`Authorization: Bearer <MONTHLY_KEYS_ADMIN_TOKEN>`，Body：`{"key":"STM-..."}` 登记密钥 |
| POST | `/api/license/redeem-monthly` | Body：`{"key":"STM-...","hw_id":"<64位hex>"}` 核销，成功返回 `valid_until`（约 31 天后自然日） |

客户端环境变量：`STUDIO_MONTHLY_SERVER_URL`（根 URL，无末尾 `/`）。

## 与密钥生成器配合

1. 在 **PlantUML密钥生成器** 的「月度密钥」页生成密钥并「向服务器登记」。
2. 用户在本机客户端「帮助 → 授权激活」中粘贴密钥并核销。

永久 / 限时 **软件激活码**（Ed25519）逻辑不变，仍由同一生成器的「生成激活码」页签发。
