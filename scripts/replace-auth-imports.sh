#!/usr/bin/env bash
# Rewrites imports of the removed middleware/authMiddleware.js to middleware/auth.js (idempotent).
set -euo pipefail
cd "$(dirname "$0")/.."
grep -rlE "middleware/authMiddleware(\.js)?['\"]" --include=*.js . --exclude-dir=node_modules | while read -r f; do
  sed -i -E "s#middleware/authMiddleware(\.js)?(['\"])#middleware/auth.js\2#g" "$f"
  echo "updated $f"
done
