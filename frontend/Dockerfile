# --- Build Stage ---
FROM node:22-alpine AS builder
WORKDIR /app

# Accept build arguments from docker-compose. Default to empty → the client uses same-origin
# relative URLs (works behind the Caddy edge without baking a host in). Compose passes these explicitly.
ARG VITE_API_URL=""
ARG VITE_WS_URL=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

# Build-time feature flags (see src/lib/features.ts and FRONTEND_BUILD_WEIGHT_PLAN.md). `0` keeps
# the dependency out of the module graph entirely, which is the only thing that actually lowers the
# build's memory ceiling — the existing React.lazy splits defer the *download*, not the compile.
ARG VITE_FEATURE_MERMAID=1
ARG VITE_FEATURE_MONACO=1
ARG VITE_FEATURE_NOVNC=1
ENV VITE_FEATURE_MERMAID=$VITE_FEATURE_MERMAID
ENV VITE_FEATURE_MONACO=$VITE_FEATURE_MONACO
ENV VITE_FEATURE_NOVNC=$VITE_FEATURE_NOVNC

COPY package*.json ./
RUN npm ci
COPY . .

# The heap cap is a GC dial, not just a ceiling: V8 collects lazily while it has headroom, so a
# *higher* cap costs real RSS — every configuration measures peak RSS within ~150 MB of whatever the
# cap is set to. The useful question is therefore not "how much does this build use" but "how low can
# the cap go before it OOMs", and the feature flags above are what move that floor:
#
#   flags              modules   lowest cap that builds
#   full                 6278    2048   (1536 fails)
#   mermaid off          4378    1280   (1024 fails)
#   mermaid+monaco off   3160     512    (384 fails)
#
# Note the first row: at the full feature set the floor *is* the 2048 default, so a full build has no
# margin left at all. That is why a small host dies here. Turning mermaid off buys back a factor of
# ~1.6 on the cap and ~30% of the module graph on its own.
ARG FRONTEND_BUILD_HEAP_MB=2048
ENV NODE_OPTIONS=--max-old-space-size=$FRONTEND_BUILD_HEAP_MB
RUN npm run build

# --- Production Serving Stage ---
FROM nginx:1.25-alpine AS runner
# Copy built static client files to Nginx public directory
COPY --from=builder /app/dist /usr/share/nginx/html
# SPA routing fallback (BrowserRouter) — serves index.html for unknown client routes.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
