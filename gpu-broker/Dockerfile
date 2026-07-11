# Minimal, dependency-free broker. Bare node runs broker.mjs; no npm install needed.
FROM node:22-alpine
WORKDIR /app
COPY broker.mjs ./
# config.json is bind-mounted at runtime (see docker-compose.yml), not baked in.
ENV BROKER_CONFIG=/app/config.json
ENTRYPOINT ["node", "broker.mjs"]
