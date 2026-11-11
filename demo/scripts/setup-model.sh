#!/usr/bin/env bash
# demo/scripts/setup-model.sh
#
# One-time, idempotent installer for the MLX runtime behind `npm run model`:
# a project-local virtualenv (demo/.venv-mlx) with mlx-lm in it. No system
# python is touched, so repeated runs and other python projects stay clean.
#
# Usage: npm run model:setup   (from demo/)
#        MLX_VENV=/path/to/venv npm run model:setup

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${MLX_VENV:-${DEMO_DIR}/.venv-mlx}"

if [ "$(uname -sm)" != "Darwin arm64" ]; then
  echo "ERROR: mlx-lm needs macOS on Apple silicon (found: $(uname -sm))." >&2
  echo "The demo model only runs on Apple hardware." >&2
  exit 1
fi

if [ -x "${VENV}/bin/python" ] && "${VENV}/bin/python" -c "import mlx_lm" >/dev/null 2>&1; then
  echo "==> mlx-lm already installed in ${VENV} — skipping."
  exit 0
fi

# Pick an arm64 interpreter. A Rosetta (x86_64) python has no mlx wheels, so
# it is rejected up front instead of failing halfway through the install.
BASE_PY="${MLX_PYTHON:-}"
if [ -z "${BASE_PY}" ]; then
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "${candidate}" >/dev/null 2>&1 \
       && [ "$("${candidate}" -c 'import platform;print(platform.machine())' 2>/dev/null)" = "arm64" ]; then
      BASE_PY="$(command -v "${candidate}")"
      break
    fi
  done
fi

if [ -z "${BASE_PY}" ]; then
  echo "ERROR: no arm64 python3 found on PATH." >&2
  echo "Install one with: brew install python@3.13" >&2
  echo "Then re-run: npm run model:setup" >&2
  exit 1
fi

echo "==> Base interpreter: ${BASE_PY} ($("${BASE_PY}" --version 2>&1))"
echo "==> Creating virtualenv: ${VENV}"

if command -v uv >/dev/null 2>&1; then
  uv venv --python "${BASE_PY}" "${VENV}"
  uv pip install --python "${VENV}/bin/python" mlx-lm
else
  "${BASE_PY}" -m venv "${VENV}"
  "${VENV}/bin/python" -m pip install --upgrade pip >/dev/null
  "${VENV}/bin/python" -m pip install mlx-lm
fi

if ! "${VENV}/bin/python" -c "import mlx_lm" >/dev/null 2>&1; then
  echo "ERROR: mlx-lm import failed after install." >&2
  exit 1
fi

echo "==> mlx-lm ready. Start the server: npm run model"
