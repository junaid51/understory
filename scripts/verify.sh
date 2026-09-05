#!/usr/bin/env bash
# Runs every gate and fails on the first failure. Deliberately does not pipe a
# gate into grep: a pipeline's exit status is its last command's, which is how
# two commits in this repository landed with lint errors in them.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "→ typecheck"; npm run --silent typecheck
echo "→ lint";      npm run --silent lint
echo "→ format";    npm run --silent format
echo "→ test";      npm run --silent test
echo "✓ all gates passed"
