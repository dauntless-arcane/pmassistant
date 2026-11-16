# syntax=docker/dockerfile:1

# ---- Stage 1: build the React client (dev deps + vite live only here) ----
FROM node:20.19.5-alpine3.22 AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 2: production-only server dependencies ----
FROM node:20.19.5-alpine3.22 AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 3: runtime image ----
FROM node:20.19.5-alpine3.22
ENV NODE_ENV=production PORT=4000
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=client-build /app/client/dist /app/client/dist
# Logs dir must exist and be writable by the non-root user (also seeds the pm-logs volume).
RUN mkdir -p /app/server/logs && chown -R node:node /app/server/logs
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "src/index.js"]
