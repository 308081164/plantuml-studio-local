# PlantUML 本地工作室 — 支付与发布元数据小后端
# bookworm-slim：与常见 npm 包兼容性更好；Alpine 上偶发出现生产依赖不完整或 ESM 解析异常。
FROM node:20-bookworm-slim

WORKDIR /app

# Node 20 镜像自带的 npm 在部分 Docker/CI 环境下会打出「Exit handler never called」并以 0 退出，
# 实际 node_modules 不完整（express 缺失）。先升级到 npm 10 最新补丁再安装依赖。
RUN npm install -g npm@10.9.2 && npm --version

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && test -f node_modules/express/package.json \
  && node -e "require('express'); require('alipay-sdk'); require('plantuml-encoder'); console.log('deps ok')"

COPY index.mjs online-deepseek.mjs load-env.mjs ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8848

# 数据目录（可被 compose volume 挂载覆盖）
ENV STUDIO_SERVER_DATA_DIR=/app/data

CMD ["node", "index.mjs"]
