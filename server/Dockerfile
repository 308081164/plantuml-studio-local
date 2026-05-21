# PlantUML 本地工作室 — 支付与发布元数据小后端
# bookworm-slim：与常见 npm 包兼容性更好；Alpine 上偶发出现生产依赖不完整或 ESM 解析异常。
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# 单独一层完成 npm，避免与后续 node 在同一 shell 内串联时触发 npm「Exit handler never called」竞态
RUN npm ci --omit=dev --no-audit --no-fund
# 用 require 自检（与运行时 CJS 解析一致）；勿用 import('express') — Node ESM 易误走 legacyMainResolve 指向 index.js
RUN node -e "require('express'); require('alipay-sdk'); require('plantuml-encoder'); console.log('deps ok')"

COPY index.mjs online-deepseek.mjs load-env.mjs ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8848

# 数据目录（可被 compose volume 挂载覆盖）
ENV STUDIO_SERVER_DATA_DIR=/app/data

CMD ["node", "index.mjs"]
