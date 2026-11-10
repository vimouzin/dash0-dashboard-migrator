#!/usr/bin/env bash
# Build the one-file dd2dash0 executable: the code plus the mapping tables, embedded with Bun's file loader so the
# executable reads them in place (src/cli.ts defaultMappingsDir). No folders, no README next to it.
#   scripts/release/build.sh [bun target] [outfile]      e.g. bun-darwin-arm64 dist/dd2dash0
set -euo pipefail
cd "$(dirname "$0")/../.."
target="${1:-}"
out="${2:-dist/dd2dash0}"
bun="bun"; command -v bun >/dev/null || bun="npx -y bun@${BUN_VERSION:-1.4.4}"
mkdir -p "$(dirname "$out")"
tables=(mappings/tags.yaml mappings/log-attributes.yaml mappings/notification-channels.yaml mappings/datadog/*.yaml mappings/datadog/_kinds.json)
$bun build src/bin.ts "${tables[@]}" --compile --minify ${target:+--target "$target"} \
  --loader .yaml:file --loader .json:file --asset-naming="[dir]/[name].[ext]" --outfile "$out" >/dev/null
echo "built $out ($(du -h "$out" | cut -f1), ${#tables[@]} tables embedded)"
