#!/usr/bin/env bash
# Download (if needed) and serve the 4-bit MLX export on :8080.
# Requires mlx-lm: `pip install mlx-lm` (Apple silicon).
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${DEMO_DIR}/models/opline-0.8b/mlx-4bit"

bash "${DEMO_DIR}/scripts/fetch-model.sh"

PY="${MLX_PYTHON:-}"
if [ -z "${PY}" ]; then
  for candidate in python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1 && "${candidate}" -c "import mlx_lm" >/dev/null 2>&1; then
      PY="${candidate}"
      break
    fi
  done
fi

if [ -z "${PY}" ]; then
  cat >&2 <<'EOF'
ERROR: no python with mlx-lm found on PATH.

Install it on Apple silicon:
  pip install mlx-lm        # or: uv tool install mlx-lm

Then re-run `npm run model`. If mlx-lm lives in a specific interpreter or
virtualenv, point at it directly:
  MLX_PYTHON=/path/to/python npm run model
EOF
  exit 1
fi

if ! "${PY}" -c "import mlx_lm" >/dev/null 2>&1; then
  echo "ERROR: ${PY} cannot import mlx_lm." >&2
  echo "Install it with: ${PY} -m pip install mlx-lm" >&2
  exit 1
fi

exec "${PY}" -m mlx_lm server --model "${MODEL}" --port 8080 \
  --chat-template-args '{"enable_thinking":false}'
