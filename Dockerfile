FROM node:24-bookworm-slim AS build
ENV ONNXRUNTIME_NODE_INSTALL=skip
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1
COPY tsconfig*.json ./
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DB_MIGRATE_ON_START=true
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--env-file-if-exists=/app/.env", "dist/server.js"]

# Build explicitly with --target face-worker for the isolated research pilot.
FROM runtime AS face-worker
COPY --chown=node:node models/research/detector.onnx models/research/recognizer.onnx models/research/pad.onnx models/research/manifest.json ./models/research/
ENV FACE_MANIFEST_PATH=/app/models/research/manifest.json FACE_WORKER_PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.FACE_WORKER_PORT||8000)+'/ready',{headers:{authorization:'Bearer '+process.env.FACE_WORKER_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/worker/server.js"]

# Default build remains the API image without research weights.
FROM runtime AS api
