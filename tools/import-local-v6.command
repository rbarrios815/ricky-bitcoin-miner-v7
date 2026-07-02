#!/bin/bash
set -euo pipefail

EXPECTED_BRANCH="merge/v6-reward-v7-dashboard-20260701"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="${V6_SOURCE:-$REPO_ROOT/../ricky-browser-miner-v6}"
DEST_DIR="$REPO_ROOT/legacy-v6-source"

cd "$REPO_ROOT"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "This importer must run on branch: $EXPECTED_BRANCH"
  echo "Current branch: ${CURRENT_BRANCH:-detached HEAD}"
  echo "Run: git fetch origin && git switch $EXPECTED_BRANCH"
  exit 1
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Could not find the v6 source folder at: $SOURCE_DIR"
  echo "Expected the v6 and v7 folders to sit beside each other in Downloads."
  echo "Override the location with: V6_SOURCE=/full/path/to/ricky-browser-miner-v6 ./tools/import-local-v6.command"
  exit 1
fi

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"

rsync -a \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='__pycache__/' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='secrets*' \
  --exclude='config.local.*' \
  "$SOURCE_DIR/" "$DEST_DIR/"

cat > "$DEST_DIR/LOCAL_IMPORT_NOTE.md" <<EOF
# Local v6 source import

Imported from Ricky's local reward-mode source folder for controlled comparison with v7.

- Source folder name: $(basename "$SOURCE_DIR")
- Imported UTC: $(date -u +'%Y-%m-%dT%H:%M:%SZ')
- Deliberately excluded: Git metadata, dependencies, caches, logs, environment files, private keys, certificates, and local-secret configuration.

Do not treat this snapshot as production-ready until the v6 reward path is diffed and tested on the integration branch.
EOF

if [[ -z "$(find "$DEST_DIR" -type f -not -name 'LOCAL_IMPORT_NOTE.md' -print -quit)" ]]; then
  echo "The import produced no source files. Nothing was committed."
  exit 1
fi

git add legacy-v6-source
if git diff --cached --quiet; then
  echo "No v6 source changes were detected."
  exit 0
fi

git commit -m "chore: import local v6 reward-mode source for integration"
git push origin "$EXPECTED_BRANCH"

echo
echo "v6 source imported and pushed successfully."
echo "Integration branch: $EXPECTED_BRANCH"
