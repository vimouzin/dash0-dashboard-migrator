#!/usr/bin/env bash
# T10 (optional since the merge train): build the throwaway branch `demo/dry-run` = the integration branch plus the
# heads of still-open PRs, to preview them live before they merge. The demo itself runs from feature/datadog-to-dash0
# (docs/demo.md §1). Never pushed, never a PR; rebuild it whenever a PR moves.
#
#   scripts/demo/build-demo-branch.sh            # worktree next to this one: ../demo
#   DEMO_DIR=/path scripts/demo/build-demo-branch.sh
#   HEADS="a/b c/d" scripts/demo/build-demo-branch.sh   # override the branch list
#
# Stops on a merge conflict and names the branches; it never resolves conflicts itself.
set -euo pipefail

BASE="${BASE:-feature/datadog-to-dash0}"
# Open PRs at Sat 20:40 (#16 #17 #18 #19 #20 #22 #12). Order matters: #22 is stacked on #19. Merged heads are skipped.
DEFAULT_HEADS="michael/claude/catalog-pending-rows michael/claude/yaml-ingest michael/claude/notification-channels amir/claude/logs-wiring michael/claude/t5-layout michael/claude/t6-log-alerts michael/claude/demo-scripts"
HEADS="${HEADS:-$DEFAULT_HEADS}"
BRANCH="demo/dry-run"

REPO="$(git rev-parse --show-toplevel)"
DEMO_DIR="${DEMO_DIR:-$(cd "$REPO/.." && pwd)/demo}"

echo "== fetching origin"
git -C "$REPO" fetch --quiet origin

if [ -d "$DEMO_DIR" ]; then
  current="$(git -C "$DEMO_DIR" rev-parse --abbrev-ref HEAD)"
  if [ "$current" != "$BRANCH" ]; then
    echo "error: $DEMO_DIR exists but is on '$current', not $BRANCH; refusing to touch it" >&2
    exit 1
  fi
  if [ -n "$(git -C "$DEMO_DIR" status --porcelain --untracked-files=no)" ]; then
    echo "error: $DEMO_DIR has uncommitted changes to tracked files; commit or discard them first" >&2
    exit 1
  fi
  echo "== resetting $BRANCH in $DEMO_DIR to origin/$BASE"
  git -C "$DEMO_DIR" reset --quiet --hard "origin/$BASE"
else
  echo "== creating worktree $DEMO_DIR on $BRANCH from origin/$BASE"
  git -C "$REPO" worktree add --quiet -B "$BRANCH" "$DEMO_DIR" "origin/$BASE"
fi

cd "$DEMO_DIR"
mkdir -p out/demo
manifest="out/demo/manifest.json"
{
  echo "{"
  echo "  \"base\": {\"ref\": \"$BASE\", \"sha\": \"$(git rev-parse "origin/$BASE")\"},"
  echo "  \"heads\": ["
} > "$manifest"

first=1
for head in $HEADS; do
  if ! git rev-parse --verify --quiet "origin/$head" >/dev/null; then
    echo "   skip $head (no such branch on origin; merged or renamed?)"
    continue
  fi
  sha="$(git rev-parse "origin/$head")"
  if git merge-base --is-ancestor "$sha" HEAD; then
    echo "   have $head (${sha:0:7})"
  else
    echo "== merging $head (${sha:0:7})"
    if ! git merge --quiet --no-edit -m "demo: merge $head" "origin/$head"; then
      echo "" >&2
      echo "error: merge conflict merging $head into $BRANCH:" >&2
      git diff --name-only --diff-filter=U >&2
      echo "Ask the PR owners to reconcile; this script does not resolve conflicts. ('git merge --abort' in $DEMO_DIR to clean up.)" >&2
      exit 1
    fi
  fi
  [ $first -eq 1 ] || echo "," >> "$manifest"
  printf '    {"ref": "%s", "sha": "%s"}' "$head" "$sha" >> "$manifest"
  first=0
done
printf '\n  ]\n}\n' >> "$manifest"

echo "== npm install"
npm install --no-audit --no-fund --silent
git checkout --quiet -- package-lock.json 2>/dev/null || true

echo "== typecheck + tests"
status=0
npm run -s typecheck || status=1
npx vitest run --reporter=dot 2>&1 | tail -6 || status=1

echo ""
echo "demo branch: $DEMO_DIR ($BRANCH @ $(git rev-parse --short HEAD)); heads recorded in $DEMO_DIR/$manifest"
[ -f .env ] || echo "next: create $DEMO_DIR/.env from .env.example (DD_API_KEY, DD_APP_KEY, DASH0_API_URL, DASH0_AUTH_TOKEN)"
if [ $status -ne 0 ]; then
  echo "WARNING: typecheck or tests are red on the demo branch. Read the failures before demoing." >&2
  exit 2
fi
