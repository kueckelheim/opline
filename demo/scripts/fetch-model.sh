#!/usr/bin/env bash
# Download the 4-bit GGUF of erknog/opline-0.8b (~517 MB) into demo/models.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DEMO_DIR}/models/gguf"
MODEL="${DEST}/opline-0.8b-Q4_K_M.gguf"

if [ -f "${MODEL}" ]; then
  echo "model already present: ${MODEL}"
  exit 0
fi

if ! command -v hf >/dev/null 2>&1; then
  echo "ERROR: the 'hf' CLI is missing. Install it with:" >&2
  echo "  curl -LsSf https://hf.co/cli/install.sh | bash" >&2
  echo "(or 'pip install huggingface_hub[cli]')" >&2
  exit 1
fi

mkdir -p "${DEST}"
hf download erknog/opline-0.8b opline-0.8b-Q4_K_M.gguf --local-dir "${DEST}"
echo "model ready: ${MODEL}"
