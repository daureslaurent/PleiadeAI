# --- Build Stage ---
FROM node:22-alpine AS builder
WORKDIR /app

# Accept build arguments from docker-compose
ARG VITE_API_URL
ARG VITE_WS_URL
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
# Copy custom basic nginx config if routing handles fallbacks (e.g. for SPA routing)
# COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]