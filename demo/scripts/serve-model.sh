#!/usr/bin/env bash
# Download (if needed) and serve the 4-bit GGUF on :8080 with llama.cpp.
# Requires llama-server on PATH (or LLAMA_SERVER pointing at the binary).
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${DEMO_DIR}/models/gguf/opline-0.8b-Q4_K_M.gguf"

bash "${DEMO_DIR}/scripts/fetch-model.sh"

SERVER="${LLAMA_SERVER:-}"
if [ -z "${SERVER}" ] && command -v llama-server >/dev/null 2>&1; then
  SERVER="$(command -v llama-server)"
fi

if [ -z "${SERVER}" ] || [ ! -x "${SERVER}" ]; then
  cat >&2 <<EOF
ERROR: llama-server not found.

Install llama.cpp:
  macOS:  brew install llama.cpp
  other:  https://github.com/ggml-org/llama.cpp (release binaries or build from source)

Or point at an existing binary:
  LLAMA_SERVER=/path/to/llama-server npm run model
EOF
  exit 1
fi

echo "==> Serving ${MODEL} on http://127.0.0.1:8080 (llama-server: ${SERVER})"

exec "${SERVER}" -m "${MODEL}" --host 127.0.0.1 --port 8080 --jinja --ctx-size 2048 \
  --chat-template-kwargs '{"enable_thinking":false}'
