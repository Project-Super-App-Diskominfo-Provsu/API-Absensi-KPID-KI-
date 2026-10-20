FROM node:24-bookworm-slim AS build
ENV ONNXRUNTIME_NODE_INSTALL=skip
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1
COPY tsconfig*.json ./
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "--env-file-if-exists=/app/.env", "dist/server.js"]
