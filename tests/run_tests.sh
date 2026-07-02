#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "Node.js is required for JavaScript tests." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required for server tests." >&2; exit 1; }

node --check sha256.js
node --check record-utils.js
node --check miner-worker.js
node --check app.js
node --check app-render.js
node --check app-runtime.js
node tests/sha256.test.js
node tests/record_metadata.test.js
python3 -m py_compile server.py tests/server_smoke.py
python3 tests/server_smoke.py

echo "All automated v7 handoff tests passed."
