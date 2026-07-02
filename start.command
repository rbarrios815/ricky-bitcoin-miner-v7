#!/bin/sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install Node.js, then run start.command again."
  printf '\nPress Return to close.'
  read answer
  exit 1
fi

PORT=8792
export PORT
echo "Starting corrected Reward Miner build on http://127.0.0.1:${PORT}"
node server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

READY=0
ATTEMPT=0
while [ "$ATTEMPT" -lt 20 ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo
    echo "The corrected miner server did not start. Review the error above."
    printf '\nPress Return to close.'
    read answer
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    READY=1
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.25
done

if [ "$READY" -ne 1 ]; then
  echo
  echo "The corrected miner did not become ready on port ${PORT}."
  printf '\nPress Return to close.'
  read answer
  exit 1
fi

open "http://127.0.0.1:${PORT}/?version=reward-v8-ui-fix2"
wait "$SERVER_PID"
