#!/usr/bin/env bash
# Download the 4-bit MLX export of erknog/opline-0.8b (424 MB) into demo/models.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DEMO_DIR}/models/opline-0.8b"

if [ -f "${DEST}/mlx-4bit/config.json" ]; then
  echo "model already present: ${DEST}/mlx-4bit"
  exit 0
fi

if ! command -v hf >/dev/null 2>&1; then
  echo "ERROR: the 'hf' CLI is missing. Install it with:" >&2
  echo "  curl -LsSf https://hf.co/cli/install.sh | bash" >&2
  echo "(or 'pip install huggingface_hub[cli]')" >&2
  exit 1
fi

mkdir -p "${DEST}"
hf download erknog/opline-0.8b --include "mlx-4bit/*" --local-dir "${DEST}"
echo "model ready: ${DEST}/mlx-4bit"
