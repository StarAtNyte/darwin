#!/usr/bin/env bash
# Vendor SIEGE's guard library into vendor/siege so DARWIN builds from one clone.
# Usage: scripts/sync-siege.sh [path-to-siege-checkout]   (default: ../siege)
set -euo pipefail
SRC="${1:-$(dirname "$0")/../../siege}"
DST="$(dirname "$0")/../vendor/siege"
[ -f "$SRC/src/index.ts" ] || { echo "no SIEGE checkout at $SRC" >&2; exit 1; }
rm -rf "$DST"
mkdir -p "$DST/src"
cp "$SRC/src/index.ts" "$DST/src/"
cp -r "$SRC/src/mandate" "$SRC/src/llm" "$SRC/src/adapters" "$SRC/src/baseline" "$DST/src/"
cp "$SRC/LICENSE" "$DST/"
cat > "$DST/package.json" <<JSON
{
  "name": "siege",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Vendored SIEGE Mandate guard library (https://github.com/StarAtNyte/near-siege). Do not edit; run scripts/sync-siege.sh.",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@anthropic-ai/sdk": "^1.4.0" }
}
JSON
echo "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)" > "$DST/SOURCE_COMMIT"
echo "vendored SIEGE $(cat "$DST/SOURCE_COMMIT") into $DST"
