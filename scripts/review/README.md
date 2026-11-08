# Local Perses viewer for converter output

Development aid: view `migrator convert --out` dashboards in a local Perses (v0.55.1, bound to
`127.0.0.1`). Nothing is sent to Dash0 except the dashboards' own PromQL, through the datasource proxy.

One command (issue #144): starts the stack, converts every integration under
`fixtures/datadog/integrations-core/` into `out/convert/<name>`, loads them and prints each URL. It
reads `DASH0_*` from the environment or `.env` (never printed), stays in the foreground and stops the
stack on Ctrl-C. The desktop app can start it as the `viewer` entry in `.claude/launch.json`.

```sh
scripts/review/up.sh                     # PERSES_PORT=18080 scripts/review/up.sh if 8080 is taken
DASH0_AUTH_TOKEN=placeholder scripts/review/up.sh   # layout only, no data
```

The same steps by hand:

```sh
export DASH0_AUTH_TOKEN=...      # required by compose (any placeholder shows layout only); never commit it
export DASH0_API_URL=https://api.eu-west-1.aws.dash0.com   # optional, this is the default
export DASH0_DATASET=default     # optional, this is the default
docker compose -f scripts/review/docker-compose.yaml up -d   # PERSES_PORT=18080 if 8080 is taken

uv run migrator convert --source datadog --input fixtures/datadog/integrations-core/postgres \
  --mapping mappings/datadog --out out/convert/postgres
uv run scripts/review/load_local.py out/convert/postgres --perses-url http://localhost:8080
```

`load_local.py` creates the dashboards' project with a `dash0` Secret and default Prometheus
datasource (proxy to `$DASH0_API_URL/api/prometheus`, header `Dash0-Dataset: $DASH0_DATASET`; the token
reaches the container only as the compose secret file `/run/secrets/dash0_auth_token`), POSTs or PUTs
each dashboard, checks the read-back and prints each URL with the 2026-11-07 14:05–15:21 UTC window
(the only receiver data in `default`).

Stop and discard everything: `docker compose -f scripts/review/docker-compose.yaml down -v`.
