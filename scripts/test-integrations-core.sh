#!/usr/bin/env bash
# Test dd2dash0 against the dashboards and monitors in DataDog/integrations-core, the repository the Dash0 case names.
#
#   npm run integrations-core              # fetch (once) and run the whole guided flow over it: dry run, nothing imported
#   npm run integrations-core -- --update  # pull the latest integrations-core first
#
# Fetches only */assets/dashboards/*.json and */assets/monitors/*.json (~40 MB, a sparse shallow clone) into
# .corpus/integrations-core (gitignored), then runs `dd2dash0 --yes --dry-run --input <it>` and prints the result card.
# Exit code 0 means every dashboard and check rule passed the pre-import checks. Reports go to .corpus/run/.
set -euo pipefail
cd "$(dirname "$0")/.."
dir=.corpus/integrations-core
if [ ! -d "$dir/.git" ]; then
  mkdir -p .corpus
  git clone --quiet --depth 1 --filter=blob:none --sparse https://github.com/DataDog/integrations-core "$dir"
  git -C "$dir" sparse-checkout set --no-cone '/*/assets/dashboards/*.json' '/*/assets/monitors/*.json'
elif [ "${1:-}" = "--update" ]; then
  git -C "$dir" pull --quiet --depth 1
fi
echo "integrations-core $(git -C "$dir" rev-parse --short HEAD): $(ls "$dir"/*/assets/dashboards/*.json | wc -l | tr -d ' ') dashboards, $(ls "$dir"/*/assets/monitors/*.json | wc -l | tr -d ' ') monitors"
rm -rf .corpus/run
exec npx tsx src/cli.ts --yes --dry-run --input "$dir" --out .corpus/run
