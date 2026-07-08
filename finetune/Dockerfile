# PleiadeAI fine-tune service — CUDA + Axolotl (QLoRA/DeepSpeed) + llama.cpp (GGUF) + Node API.
#
# The `-devel` CUDA image is required: bitsandbytes / flash-attn / DeepSpeed build CUDA
# extensions against the toolkit headers at install time.
FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/root/.cache/huggingface

# Pin the Axolotl and llama.cpp revisions — do NOT track a moving branch (see plan Risk #1).
ARG AXOLOTL_REF=v0.6.0
ARG LLAMACPP_REF=b4519
ARG TORCH_VERSION=2.4.1

# --- System deps: Python 3.10, build toolchain, cmake (llama.cpp), git, curl ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-dev \
      git curl ca-certificates build-essential cmake ninja-build \
      libopenblas-dev pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

# --- PyTorch (CUDA 12.1 wheels) ---
RUN pip install --upgrade pip packaging wheel \
    && pip install "torch==${TORCH_VERSION}" --index-url https://download.pytorch.org/whl/cu121

# --- Axolotl from source (pinned) + training deps (deepspeed, flash-attn, bitsandbytes) ---
RUN git clone --depth 1 --branch "${AXOLOTL_REF}" https://github.com/axolotl-ai-cloud/axolotl /opt/axolotl \
    && cd /opt/axolotl \
    && pip install -e '.[deepspeed,flash-attn]' \
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
