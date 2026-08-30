# Multi-stage build: web PWA → single Node container serving API + static app.
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --no-audit --no-fund
COPY server/ .
COPY --from=webbuild /web/dist /app/web/dist
ENV NODE_ENV=production PORT=4000 PACKCOMPLY_DATA_DIR=/data
VOLUME /data
EXPOSE 4000
# TLS terminates at the reverse proxy in deployment (see ARCHITECTURE.md).
CMD ["npx", "tsx", "src/index.ts"]
