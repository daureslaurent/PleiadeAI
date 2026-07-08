#!/usr/bin/env bash
#
# install-flash-attn.sh — install flash-attn without a 30–45 min source compile.
#
# flash-attn ships prebuilt wheels on its GitHub releases, one per
# (torch major.minor × CUDA bucket × C++11-ABI × cpython) combination. Compiling
# from source is the slow default; matching the right prebuilt wheel installs in
# seconds. This script detects the environment from the already-installed torch,
# tries every valid prebuilt wheel for that env, and only falls back to a source
# build (with a bounded MAX_JOBS so it doesn't OOM) when none can be fetched.
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
# We print a single, prefixed marker line and grep for it, so any warnings the
# import may emit on stdout can't be mistaken for the detection result.
DETECT="$(python - <<'PY'
import sys, torch
torch_mm = ".".join(torch.__version__.split("+")[0].split(".")[:2])   # 2.4.1+cu121 -> 2.4
cuda_major = (torch.version.cuda or "").split(".")[0]                  # 12.1 -> 12
try:
    abi = "TRUE" if torch._C._GLIBCXX_USE_CXX11_ABI else "FALSE"
except Exception:
    abi = "FALSE"
pytag = f"cp{sys.version_info.major}{sys.version_info.minor}"          # cp310
print(f"FA_DETECT {torch_mm} {cuda_major} {abi} {pytag}")
PY
)"
read -r _ TORCH_MM CUDA_MAJOR ABI PYTAG <<<"$(echo "$DETECT" | grep '^FA_DETECT ')"

if [[ -z "${TORCH_MM:-}" || -z "${PYTAG:-}" ]]; then
  echo "ERROR: could not detect torch/python from the image" >&2
  echo "$DETECT" >&2
  exit 1
fi
echo "==> flash-attn ${FLASH_ATTN_VERSION}: torch ${TORCH_MM} / CUDA ${CUDA_MAJOR} / cxx11abi=${ABI} / ${PYTAG}"

# flash-attn buckets CUDA by major line, but the tag spelling changed across
# releases: 2.6.x used cu118/cu123, 2.8.x uses cu12/cu13. Offer both spellings for
# the detected major (detected first), so one script serves old and new releases.
case "$CUDA_MAJOR" in
  13) CUDA_BUCKETS="cu13 cu12 cu123" ;;
  12) CUDA_BUCKETS="cu12 cu123 cu118" ;;
  11) CUDA_BUCKETS="cu118 cu11 cu12" ;;
  *)  CUDA_BUCKETS="cu12 cu123 cu118" ;;
esac
# Prefer the detected ABI but try the other too — both exist and detection of the
# ABI is the single most fragile axis across torch builds.
[[ "$ABI" == "TRUE" ]] && ABIS="TRUE FALSE" || ABIS="FALSE TRUE"

REL_BASE="https://github.com/Dao-AILab/flash-attention/releases/download/v${FLASH_ATTN_VERSION}"

# --- Try every valid prebuilt wheel before compiling -------------------------
for bucket in $CUDA_BUCKETS; do
  for abi in $ABIS; do
    wheel="flash_attn-${FLASH_ATTN_VERSION}+${bucket}torch${TORCH_MM}cxx11abi${abi}-${PYTAG}-${PYTAG}-linux_x86_64.whl"
    echo "==> Trying prebuilt wheel: ${wheel}"
    if curl -fSL --retry 3 --retry-delay 2 -o "/tmp/${wheel}" "${REL_BASE}/${wheel}"; then
      echo "==> Installing prebuilt wheel (fast path)"
      pip install "/tmp/${wheel}"
      rm -f "/tmp/${wheel}"
      python -c "import flash_attn; print('==> flash-attn', flash_attn.__version__, 'installed OK (prebuilt)')"
      exit 0
    fi
    echo "    not available, trying next candidate"
  done
done

# --- Source fallback (bounded jobs to avoid OOM) -----------------------------
echo "WARNING: no prebuilt wheel matched this environment"
echo "==> Falling back to source compile with MAX_JOBS=${MAX_JOBS} (slow: 30-45 min)"
pip install ninja
MAX_JOBS="${MAX_JOBS}" pip install "flash-attn==${FLASH_ATTN_VERSION}" --no-build-isolation
python -c "import flash_attn; print('==> flash-attn', flash_attn.__version__, 'installed OK (source)')"
