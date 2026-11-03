#!/bin/bash
# Run every check a gate must pass: server lint + tests (on the local test
# MySQL), client lint + type-check + production build into a temp dir (so
# client/dist is never touched). Uses Node 24 via nvm.
set -euo pipefail
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 24 >/dev/null
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
echo "node $(node -v)"
echo "== server lint";  (cd "$ROOT/server" && npx eslint .)
echo "== server tests"; (cd "$ROOT/server" && test/db/start-test-mysql.sh >/dev/null && npm test 2>&1 | tail -8)
echo "== client lint";  (cd "$ROOT/client" && npx eslint .)
echo "== client typecheck"; (cd "$ROOT/client" && npx tsc -b)
OUT=$(mktemp -d)
echo "== client build -> $OUT"; (cd "$ROOT/client" && npx vite build --outDir "$OUT" --emptyOutDir 2>&1 | tail -4)
rm -rf "$OUT"
echo "== all checks passed"
