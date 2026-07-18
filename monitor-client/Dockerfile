# Debian-based (not alpine) on purpose: the NVIDIA container toolkit injects the *host's* glibc-linked
# nvidia-smi into the container, which will not run against musl.
FROM node:22-slim
WORKDIR /app
COPY monitor.mjs ./
# Lets the NVIDIA runtime inject nvidia-smi + the driver libs. Harmless on a box with no GPU.
ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=utility
USER node
ENTRYPOINT ["node", "monitor.mjs"]
