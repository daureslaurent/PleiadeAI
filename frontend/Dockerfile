# --- Build Stage ---
FROM node:22-alpine AS builder
WORKDIR /app

# Accept build arguments from docker-compose. Default to empty → the client uses same-origin
# relative URLs (works behind the Caddy edge without baking a host in). Compose passes these explicitly.
ARG VITE_API_URL=""
ARG VITE_WS_URL=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

COPY package*.json ./
RUN npm ci
COPY . .
# monaco + mermaid + syntax-highlighter push Rollup past Node's default ~2GB heap cap. Pairs with
# build.rollupOptions.maxParallelFileOps in vite.config.ts.
#
# The cap is a GC dial, not just a ceiling: V8 collects lazily while it has headroom, so a *higher*
# cap costs real RSS. Measured on this graph (6166 modules) — 3072: 2.95GB/31s, 2048: 2.40GB/32s,
# 1536: 2.00GB/40s, 1280: OOM. 2048 buys ~550MB for no build-time cost while keeping a healthy margin
# over the ~1.4GB live set. Drop to 1536 if the box is tighter and you'll trade ~8s for another 400MB.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN npm run build

# --- Production Serving Stage ---
FROM nginx:1.25-alpine AS runner
# Copy built static client files to Nginx public directory
COPY --from=builder /app/dist /usr/share/nginx/html
# SPA routing fallback (BrowserRouter) — serves index.html for unknown client routes.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]