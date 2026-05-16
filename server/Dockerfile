# PlantUML 本地工作室 — 支付与发布元数据小后端
# bookworm-slim：与常见 npm 包兼容性更好；Alpine 上偶发出现生产依赖不完整或 ESM 解析异常。
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && node --input-type=module -e "import('express').then(()=>process.exit(0)).catch((e)=>{console.error(e);process.exit(1)})"

COPY index.mjs online-deepseek.mjs load-env.mjs ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8848

# 数据目录（可被 compose volume 挂载覆盖）
ENV STUDIO_SERVER_DATA_DIR=/app/data

CMD ["node", "index.mjs"]
