#!/usr/bin/env bash
#
# install-flash-attn.sh — install flash-attn without a 30–45 min source compile.
#
# flash-attn ships prebuilt wheels on its GitHub releases, one per
# (torch major.minor × CUDA bucket × C++11-ABI × cpython) combination. Compiling
# from source is the slow default; matching the right prebuilt wheel installs in
# seconds. This script detects the environment from the already-installed torch,
# resolves the matching wheel URL, downloads it, and only falls back to a source
# build (with a bounded MAX_JOBS so it doesn't OOM) when no wheel matches.
#
# Runs at image-build time AFTER torch is installed. Portable across GPU hosts:
# it reads torch/CUDA/python/ABI at build time rather than hard-coding a URL.
#
# Env:
#   FLASH_ATTN_VERSION  flash-attn release to install (default 2.6.3)
#   MAX_JOBS            parallel compile jobs for the source fallback (default 4)
set -euo pipefail

FLASH_ATTN_VERSION="${FLASH_ATTN_VERSION:-2.6.3}"
MAX_JOBS="${MAX_JOBS:-4}"

# --- Detect the build environment from the installed torch -------------------
# Emits: "<torch_mm> <cuda_bucket> <abi> <pytag>"  e.g. "2.4 cu123 FALSE cp310"
read -r TORCH_MM CUDA_BUCKET ABI PYTAG < <(python - <<'PY'
import sys, torch

# torch.__version__ -> "2.4.1+cu121"; keep major.minor only.
torch_mm = ".".join(torch.__version__.split("+")[0].split(".")[:2])

# flash-attn buckets CUDA by major line, not exact minor. Its 2.6.x releases
# publish cu118 (CUDA 11) and cu123 (CUDA 12) builds. Map to the nearest bucket.
cuda = torch.version.cuda or ""
major = cuda.split(".")[0] if cuda else ""
bucket = {"11": "cu118", "12": "cu123"}.get(major, f"cu{major}x" if major else "cpu")

# PyTorch pip wheels are built with _GLIBCXX_USE_CXX11_ABI=0 -> "FALSE".
abi = "TRUE" if torch._C._GLIBCXX_USE_CXX11_ABI else "FALSE"

pytag = f"cp{sys.version_info.major}{sys.version_info.minor}"
print(torch_mm, bucket, abi, pytag)
PY
)

WHEEL="flash_attn-${FLASH_ATTN_VERSION}+${CUDA_BUCKET}torch${TORCH_MM}cxx11abi${ABI}-${PYTAG}-${PYTAG}-linux_x86_64.whl"
WHEEL_URL="https://github.com/Dao-AILab/flash-attention/releases/download/v${FLASH_ATTN_VERSION}/${WHEEL}"

echo "==> flash-attn ${FLASH_ATTN_VERSION}: torch ${TORCH_MM} / ${CUDA_BUCKET} / cxx11abi=${ABI} / ${PYTAG}"
echo "==> Trying prebuilt wheel: ${WHEEL}"

if curl -fSL --retry 3 --retry-delay 2 -o "/tmp/${WHEEL}" "${WHEEL_URL}"; then
  echo "==> Installing prebuilt wheel (fast path)"
  pip install "/tmp/${WHEEL}"
  rm -f "/tmp/${WHEEL}"
else
  echo "WARNING: no prebuilt wheel at ${WHEEL_URL}"
  echo "==> Falling back to source compile with MAX_JOBS=${MAX_JOBS} (slow: 30-45 min)"
  pip install ninja
  MAX_JOBS="${MAX_JOBS}" pip install "flash-attn==${FLASH_ATTN_VERSION}" --no-build-isolation
fi

python -c "import flash_attn; print('==> flash-attn', flash_attn.__version__, 'installed OK')"
