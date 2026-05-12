# PlantUML 本地工作室 — 支付与发布元数据小后端
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.mjs online-deepseek.mjs load-env.mjs ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8848

# 数据目录（可被 compose volume 挂载覆盖）
ENV STUDIO_SERVER_DATA_DIR=/app/data

CMD ["node", "index.mjs"]
