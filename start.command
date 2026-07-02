#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install it, then run this file again."
  read -r -p "Press Return to close..."
  exit 1
fi
python3 server.py --port 8791
