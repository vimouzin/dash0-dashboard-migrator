#!/usr/bin/env bash
# One command for the local Perses viewer (issue #144). Development aid only.
#
# Starts the compose stack (127.0.0.1 only), converts every integration under
# fixtures/datadog/integrations-core/ into out/convert/<name>, loads the dashboards with
# load_local.py, then stays in the foreground; Ctrl-C stops the stack. See README.md here.
#
# DASH0_AUTH_TOKEN (and optional DASH0_API_URL, DASH0_DATASET) come from the environment or the
# repo's .env. They are never printed. Any placeholder token shows the layout without data.
# Nothing is sent to Dash0 except the dashboards' own PromQL, through the datasource proxy.
#
# Usage: scripts/review/up.sh            (PERSES_PORT=18080 scripts/review/up.sh if 8080 is taken)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f scripts/review/docker-compose.yaml)
PORT="${PERSES_PORT:-8080}"
URL="http://localhost:$PORT"

command -v docker >/dev/null || { echo "docker not found: install and start Docker Desktop first" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop first" >&2; exit 1; }
command -v uv >/dev/null || { echo "uv not found: see README.md" >&2; exit 1; }

if [[ -z "${DASH0_AUTH_TOKEN:-}" && -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
if [[ -z "${DASH0_AUTH_TOKEN:-}" ]]; then
  echo "DASH0_AUTH_TOKEN is not set (environment or .env)." >&2
  echo "Set it, or run with DASH0_AUTH_TOKEN=placeholder to see the layout without data." >&2
  exit 1
fi

trap '"${COMPOSE[@]}" down >/dev/null 2>&1 || true; echo "viewer stopped"' EXIT
"${COMPOSE[@]}" up -d

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "$URL/api/v1/health" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "$URL/api/v1/health" || { echo "Perses did not come up on $URL" >&2; exit 1; }

runs=()
for dir in fixtures/datadog/integrations-core/*/; do
  name="$(basename "$dir")"
  [[ -d "$dir/dashboards" ]] || continue
  out="out/convert/$name"
  rm -rf "$out"
  # Exit 2 means some widgets are partial or blocked: expected, the dashboards are still written.
  uv run migrator convert --source datadog --input "$dir" --mapping mappings/datadog --out "$out" >/dev/null || [[ $? -eq 2 ]]
  runs+=("$out")
done

uv run scripts/review/load_local.py "${runs[@]}" --perses-url "$URL"
echo
echo "Viewer running at $URL (Ctrl-C to stop)"
"${COMPOSE[@]}" logs -f --no-log-prefix perses >/dev/null
