# PleiadeAI fine-tune service — CUDA + Axolotl (QLoRA/DeepSpeed) + llama.cpp (GGUF) + Node API.
#
# The `-devel` CUDA image is required: bitsandbytes / flash-attn / DeepSpeed build CUDA
# extensions against the toolkit headers at install time.
#
# BUILD PROFILES (set via finetune/.env → compose build args). The base image, torch
# build, and flash-attn version must match the GPU architecture:
#   • Ampere/Turing (e.g. 3060, 2070S):  CUDA 12.1 / torch 2.4.1 cu121 / flash-attn 2.6.3  (default)
#   • Blackwell     (e.g. 50-series):    CUDA 12.8 / torch 2.7.1 cu128 / flash-attn 2.8.3
# Blackwell (sm_120) CANNOT run on the CUDA 12.1 base — it needs the 12.8 toolkit.
ARG CUDA_IMAGE=nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04
FROM ${CUDA_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/root/.cache/huggingface

# Pin the Axolotl and llama.cpp revisions — do NOT track a moving branch (see plan Risk #1).
ARG AXOLOTL_REF=v0.6.0
ARG LLAMACPP_REF=b4519
ARG TORCH_VERSION=2.4.1
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu121
ARG FLASH_ATTN_VERSION=2.6.3

# --- System deps: Python 3.10, build toolchain, cmake (llama.cpp), git, curl ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-dev \
      git curl ca-certificates build-essential cmake ninja-build \
      libopenblas-dev pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

# --- PyTorch (CUDA wheels; index + version set per build profile) ---
RUN pip install --upgrade pip packaging wheel \
    && pip install "torch==${TORCH_VERSION}" --index-url "${TORCH_INDEX_URL}"

# --- Axolotl from source (pinned) + training deps (deepspeed, bitsandbytes) ---
# flash-attn is installed separately by install-flash-attn.sh, which prefers a
# prebuilt wheel over a 30-45 min source compile. It's kept out of the axolotl
# extras because `.[flash-attn]` builds under pip isolation (no torch visible ->
# "No module named 'torch'") and always compiles from source.
COPY scripts/install-flash-attn.sh /opt/install-flash-attn.sh
RUN chmod +x /opt/install-flash-attn.sh \
    && git clone --depth 1 --branch "${AXOLOTL_REF}" https://github.com/axolotl-ai-cloud/axolotl /opt/axolotl \
    && cd /opt/axolotl \
    && pip install -e '.[deepspeed]' \
    && FLASH_ATTN_VERSION="${FLASH_ATTN_VERSION}" /opt/install-flash-attn.sh \
    && pip install "gguf>=0.10.0" sentencepiece protobuf

# --- llama.cpp (pinned): convert_hf_to_gguf.py + llama-quantize for GGUF export ---
RUN git clone --depth 1 --branch "${LLAMACPP_REF}" https://github.com/ggerganov/llama.cpp /opt/llama.cpp \
    && cd /opt/llama.cpp \
    && pip install -r requirements.txt \
    && cmake -B build -DLLAMA_CURL=OFF \
    && cmake --build build --config Release -j --target llama-quantize

# --- Node.js 20 (NodeSource) ---
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Build the TypeScript API ---
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates
RUN npm run build

EXPOSE 8088
CMD ["node", "dist/server.js"]
