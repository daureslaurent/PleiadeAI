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
RUN npm run build

# --- Production Serving Stage ---
FROM nginx:1.25-alpine AS runner
# Copy built static client files to Nginx public directory
COPY --from=builder /app/dist /usr/share/nginx/html
# SPA routing fallback (BrowserRouter) — serves index.html for unknown client routes.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]