#!/usr/bin/env bash
# demo/stt/setup-local.sh
#
# One-time, idempotent installer for press-to-speak: the NeMo-Speech.cpp v0.1.0
# release binary (macOS) plus the nvidia/nemotron-speech-streaming-en-0.6b q8_0
# GGUF (~600MB, skipped entirely when the CLI cache already has it).
#
# Usage: npm run stt:setup   (from demo/)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/bin"
MODELS_DIR="${SCRIPT_DIR}/models"

VERSION="0.1.0"
URL_BASE="https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${VERSION}/"
GGUF_URL="https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/main/nemotron-speech-streaming-en-0.6b.q8_0.gguf"
GGUF_FILE="${MODELS_DIR}/nemotron-speech-streaming-en-0.6b.q8_0.gguf"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "${OS}/${ARCH}" in
  Darwin/arm64)  ASSET="nemo-speech-${VERSION}-macos-aarch64-metal.tar.gz" ;;
  Darwin/x86_64) ASSET="nemo-speech-${VERSION}-macos-x86_64-cpu.tar.gz" ;;
  *) echo "ERROR: unsupported platform ${OS}/${ARCH}." >&2; exit 1 ;;
esac

mkdir -p "${BIN_DIR}" "${MODELS_DIR}"

find_binary() {
  find "${BIN_DIR}" -type f -name 'nemo-speech' -print -quit 2>/dev/null || true
}

BIN="$(find_binary)"
if [ -n "${BIN}" ] && [ -x "${BIN}" ]; then
  echo "==> nemo-speech binary already installed at ${BIN} — skipping download."
else
  TARBALL="${BIN_DIR}/${ASSET}"
  echo "==> Downloading ${URL_BASE}${ASSET}"
  curl -fSL --retry 3 -o "${TARBALL}" "${URL_BASE}${ASSET}"
  [ -s "${TARBALL}" ] || { echo "ERROR: empty tarball: ${TARBALL}" >&2; exit 1; }
  tar -xzf "${TARBALL}" -C "${BIN_DIR}"
  rm -f "${TARBALL}"
  BIN="$(find_binary)"
  [ -n "${BIN}" ] || { echo "ERROR: 'nemo-speech' not found after extracting ${ASSET}." >&2; exit 1; }
  chmod +x "${BIN}"
fi

# The CLI caches pulled models under ~/Library/Caches/NeMoSpeech (macOS);
# check it before pulling so re-runs never touch the network when cached.
find_cached_gguf() {
  local cache_root="${XDG_CACHE_HOME:-${HOME}/Library/Caches}/NeMoSpeech/models"
  find "${cache_root}" -type f -name 'nemotron-speech-streaming-en-0.6b*.gguf' -print -quit 2>/dev/null || true
}

if [ -f "${GGUF_FILE}" ]; then
  echo "==> GGUF model already present at ${GGUF_FILE}."
elif [ -n "$(find_cached_gguf)" ]; then
  echo "==> Model already in the CLI cache ($(find_cached_gguf)) — skipping pull."
else
  echo "==> Pulling model: ${BIN} pull nemotron-en (~600MB q8_0 GGUF)"
  if "${BIN}" pull nemotron-en; then
    echo "==> Model pulled into the CLI cache."
  else
    echo "==> 'nemo-speech pull' failed — falling back to direct HuggingFace download."
    curl -fSL --retry 3 -o "${GGUF_FILE}" "${GGUF_URL}"
    [ -s "${GGUF_FILE}" ] || { echo "ERROR: model download failed: ${GGUF_FILE}" >&2; exit 1; }
  fi
fi

echo
echo "==> Setup complete. Start the server: npm run stt:serve"