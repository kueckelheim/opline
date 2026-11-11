#!/usr/bin/env bash
# Download (if needed) and serve the 4-bit MLX export on :8080.
# Requires mlx-lm on an Apple silicon mac; `npm run model:setup` installs it
# into demo/.venv-mlx, which is picked up automatically below.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${DEMO_DIR}/models/opline-0.8b/mlx-4bit"
VENV="${MLX_VENV:-${DEMO_DIR}/.venv-mlx}"

bash "${DEMO_DIR}/scripts/fetch-model.sh"

# Accepts a path to an interpreter, or to a virtualenv root.
has_mlx() {
  local py="$1"
  [ -d "${py}" ] && py="${py}/bin/python"
  [ -f "${py}" ] && [ -x "${py}" ] || return 1
  "${py}" -c "import mlx_lm" >/dev/null 2>&1
}

find_python() {
  local candidate
  if [ -n "${MLX_PYTHON:-}" ] && has_mlx "${MLX_PYTHON}"; then
    echo "${MLX_PYTHON}"
    return 0
  fi
  if has_mlx "${VENV}"; then
    echo "${VENV}/bin/python"
    return 0
  fi
  for candidate in python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1 && has_mlx "$(command -v "${candidate}")"; then
      command -v "${candidate}"
      return 0
    fi
  done
  return 1
}

PY="$(find_python || true)"

# First run on a fresh checkout: build the local venv instead of failing.
if [ -z "${PY}" ]; then
  echo "==> mlx-lm not found — running first-time setup."
  bash "${DEMO_DIR}/scripts/setup-model.sh"
  PY="$(find_python || true)"
fi

if [ -z "${PY}" ]; then
  cat >&2 <<EOF
ERROR: no python with mlx-lm found.

Tried: \$MLX_PYTHON, ${VENV}, python3/python on PATH.

Install it into the project venv:
  npm run model:setup

Or point at an existing interpreter/virtualenv:
  MLX_PYTHON=/path/to/python npm run model
EOF
  exit 1
fi

echo "==> Serving ${MODEL} on http://127.0.0.1:8080 (python: ${PY})"

exec "${PY}" -m mlx_lm server --model "${MODEL}" --port 8080 \
  --chat-template-args '{"enable_thinking":false}'
