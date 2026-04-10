#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${GLM_ENV_FILE:-$SCRIPT_DIR/.env.glm}"
PROJECT_DIR="$SCRIPT_DIR"

if [[ $# -gt 0 && -d "$1" ]]; then
  PROJECT_DIR="$(cd "$1" && pwd)"
  shift
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

export GLM_API_BASE="${GLM_API_BASE:-https://open.bigmodel.cn/api/coding/paas/v4}"
export GLM_MODEL="${GLM_MODEL:-glm-5.1}"
export GLM_PROXY_PORT="${GLM_PROXY_PORT:-3827}"
export GLM_MAX_TOKENS="${GLM_MAX_TOKENS:-131072}"
export GLM_TEMPERATURE="${GLM_TEMPERATURE:-0.2}"

if [[ -z "${GLM_API_KEY:-}" ]]; then
  echo "[ERROR] GLM_API_KEY is not set."
  echo "[ERROR] Create \"$ENV_FILE\" from \".env.glm.example\" or export GLM_API_KEY in your shell."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js was not found in PATH."
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[ERROR] bun was not found in PATH."
  exit 1
fi

export ANTHROPIC_API_KEY="$GLM_API_KEY"
export ANTHROPIC_BASE_URL="http://localhost:$GLM_PROXY_PORT"

echo "============================================================"
echo "  Starting GLM proxy + free-code"
echo "============================================================"
echo ""
echo "  Model:      $GLM_MODEL"
echo "  GLM API:    $GLM_API_BASE"
echo "  Proxy port: $GLM_PROXY_PORT"
echo "  Work dir:   $PROJECT_DIR"
echo ""

if curl -s "http://localhost:$GLM_PROXY_PORT/health" >/dev/null 2>&1; then
  echo "[1/2] Reusing GLM proxy on port $GLM_PROXY_PORT."
else
  echo "[1/2] Starting GLM proxy in the background..."
  (
    cd "$SCRIPT_DIR"
    node glm-proxy.mjs
  ) >/dev/null 2>&1 &

  for _ in $(seq 1 15); do
    sleep 1
    if curl -s "http://localhost:$GLM_PROXY_PORT/health" >/dev/null 2>&1; then
      break
    fi
  done

  if ! curl -s "http://localhost:$GLM_PROXY_PORT/health" >/dev/null 2>&1; then
    echo "[ERROR] GLM proxy failed to become healthy."
    exit 1
  fi

  echo "[OK] GLM proxy started."
fi

echo "[2/2] Starting free-code in the current terminal..."
echo ""

cd "$PROJECT_DIR"
bun run "$SCRIPT_DIR/src/entrypoints/cli.tsx" --model "$GLM_MODEL" "$@"
