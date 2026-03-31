#!/usr/bin/env bash
set -euo pipefail

echo "Searching for legacy trigger patterns..."

git grep -n "startsWith('/')" || true
git grep -n "startsWith(\"/\")" || true
git grep -n "startsWith('#')" || true
git grep -n "startsWith(\"#\")" || true
git grep -n "\\/(\\|#)" -- src || true
git grep -n "\\/(\\|#)" -- || true

echo "Done."
