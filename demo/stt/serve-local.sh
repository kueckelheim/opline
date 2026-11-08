#!/usr/bin/env bash
# demo/stt/serve-local.sh
#
# NeMo-Speech.cpp STT server (nvidia/nemotron-speech-streaming-en-0.6b q8_0
# GGUF) on 127.0.0.1:$STT_PORT (default 10300).
#
# Endpointing is DISABLED on purpose: the demo's press-to-speak flow finalizes
# by explicitly committing the buffer on mic release. rnnt_right_context 1 =
# 160ms lookahead; if the server rejects that flag we retry without it.
#
# Usage: npm run stt:serve   (run demo/stt/setup-local.sh first)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${STT_PORT:-10300}"
GGUF="${SCRIPT_DIR}/models/nemotron-speech-streaming-en-0.6b.q8_0.gguf"

BIN="$(find "${SCRIPT_DIR}/bin" -type f -name 'nemo-speech' -print -quit 2>/dev/null || true)"
if [ -z "${BIN}" ] || [ ! -x "${BIN}" ]; then
  echo "ERROR: nemo-speech binary not found under ${SCRIPT_DIR}/bin." >&2
  echo "Run: npm run stt:setup" >&2
  exit 1
fi

if [ -f "${GGUF}" ]; then
  MODEL_ARG="${GGUF}"
else
  MODEL_ARG="nemotron-en" # CLI cache populated by `nemo-speech pull`
fi

LOG="$(mktemp)"
echo "==> Serving NeMo-Speech.cpp on 127.0.0.1:${PORT} (model: ${MODEL_ARG})"
"${BIN}" serve \
  --host 127.0.0.1 \
  --port "${PORT}" \
  --asr-model "${MODEL_ARG}" \
  --asr.endpointing.enable=false \
  --asr.streaming.rnnt_right_context 1 \
  2>&1 | tee "${LOG}"
STATUS="${PIPESTATUS[0]}"

if [ "${STATUS}" -ne 0 ] && grep -qiE "unrecognized|unknown|unexpected|invalid|rnnt_right_context" "${LOG}"; then
  echo "" >&2
  echo "==> Server rejected --asr.streaming.rnnt_right_context — retrying without it." >&2
  exec "${BIN}" serve \
    --host 127.0.0.1 \
    --port "${PORT}" \
    --asr-model "${MODEL_ARG}" \
    --asr.endpointing.enable=false
fi

exit "${STATUS}"