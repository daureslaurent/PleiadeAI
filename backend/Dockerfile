# --- Build Stage ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# --- Runtime Stage ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install Python 3 for the dynamic skill execution environment
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

EXPOSE 4000
CMD ["node", "dist/index.js"]