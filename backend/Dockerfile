# --- Build Stage ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# --- Runtime Stage ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install Python 3 + bash for dynamic skill execution and the `bash` terminal tool, plus the
# Docker CLI so the backend can build per-agent isolation images and run/exec their containers
# through the mounted host /var/run/docker.sock (see docker-compose.yml). openssh-client backs the
# Isolation page's "scan host key" / "test connection" actions for the `ssh` network mode.
# tzdata gives Python's zoneinfo the IANA database (skills doing timezone math need it).
RUN apk add --no-cache python3 make g++ bash docker-cli openssh-client tzdata

# Working directory used by the `bash` terminal tool (BASH_CWD).
RUN mkdir -p /workspace

COPY package*.json ./
RUN npm ci --only=production

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# MongoDB migrations + their config: applied automatically at boot (see src/db/migrate.ts) so an
# app update / restart never runs new code against an un-migrated schema. Plain CommonJS, no build step.
COPY migrate-mongo-config.js ./
COPY migrations ./migrations

EXPOSE 4000
CMD ["node", "dist/index.js"]