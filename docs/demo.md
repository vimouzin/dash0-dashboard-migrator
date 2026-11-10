# Live demo runbook (team dry run)

Spec: `.plans/live-migration-demo-spec.md` in the dash0-team workspace. Owner: Michael (T10).

What it shows:
1. The Datadog Redis overview dashboard and its `high_mem` monitor, with live Redis data.
2. One command, `dd2dash0`: it checks the keys, pulls both items from the Datadog API, translates them with rules only, asks two questions, imports them into Dash0, reads them back, checks the migrated queries return data, and prints the result card.
3. The migrated dashboard in Dash0 drawing the same Redis's live data, and the `high_mem` check rule (imported switched off).
4. The same command again: the same ids are replaced, nothing is duplicated, and the output hash is unchanged.

## 0. Prerequisites (once)
| What | Who |
|---|---|
| Redis + OTel collector → Dash0 (Henry's bundle) running | Ali (running on his machine) |
| `datadog-agent` container with the redisdb check in the same bundle, `DD_SITE=datadoghq.eu`. Check: `redis.mem.used` shows in Datadog's Metrics Explorer | Ali |
| Datadog `DD_API_KEY` / `DD_APP_KEY`, sent privately (never on the hub) | Ali → Michael |
| A **valid** Dash0 auth token in `thinc_bavarian_big_ben` with import + read rights. The token ending `…Waoy` was revoked on 2026-11-08 (Dash0 answers 401); make a new one | Michael (Settings → Auth Tokens) |

## 1. Get dd2dash0
Either the release binary (what the audience would use):
```bash
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-macos-arm64.tar.gz | tar xz
./dd2dash0 --version
```
or from source on `feature/datadog-to-dash0` (then use `npx tsx src/cli.ts` wherever this page says `dd2dash0`):
```bash
git fetch origin && git switch --detach origin/feature/datadog-to-dash0
npm ci && npm run typecheck && npm test
```

Keys: dd2dash0 looks in the environment, then `./.env`, then `~/.config/dd2dash0/.env`. If none has them, it asks: drag the `.env` into the terminal window, type them, or use `--browser`. The names are those in `.env.example` (`DD_SITE`, `DD_API_KEY`, `DD_APP_KEY`, `DASH0_API_URL`, `DASH0_AUTH_TOKEN`, `DASH0_DATASET`). Never paste them into chat or the hub, and keep the terminal's key step off the projector until it shows only the last four characters.

## 2. Seed Datadog (idempotent)
```bash
npx tsx --env-file=.env scripts/demo/seed-datadog.ts --dry-run
npx tsx --env-file=.env scripts/demo/seed-datadog.ts
```
It creates or updates the Redis overview dashboard and the `high_mem` monitor from the fixtures, marked `[dd2dash0-demo]` / tagged `dd2dash0-demo`. It refuses a monitor whose message has an `@handle`, so nobody gets paged. It prints both Datadog URLs and writes them to `out/demo/datadog-ids.json`.

Wait about 5 minutes after the Agent starts so the Datadog panels have data. The **live** number counts the last hour, so the collector must be running at pitch time.

## 3. The run
```bash
# a. preview: translate and write payloads, import nothing
dd2dash0 --dry-run
# b. the real run: keys, translate, review (two questions), import, verify, result card
dd2dash0
# c. again: everything is replaced in place, and the output hash is the same
dd2dash0 --yes
# the engine on one query (no keys needed)
dd2dash0 explain "avg:redis.mem.used{*} by {host}"
```
The reads cover every custom dashboard and monitor in the Datadog trial; today that's the two seeded items. Each run writes `dd2dash0-run/<time>/` with `report.html`, `report.md` and `report.json` (the hashes are at the bottom of `report.md`). Offline fallback, no accounts: `dd2dash0 --dry-run --input fixtures/datadog` (from a source checkout).

## 4. Browser checklist (Michael drives)
1. **Datadog dashboard** (URL from step 2). The memory, clients and commands panels draw lines.
2. **Terminal:** read the result card line by line:
   - **translated**, **landed**, **live** and **success**, each as a count and a percentage
   - **gaps**: the finding codes of what didn't translate exactly
   - **rules**: imported, and how many are on or off
   - then open `report.html`
3. **Dash0:** Dashboards → the migrated Redis overview. Live lines in the memory, CPU and clients panels. Placeholders for widgets with no PromQL equivalent show the original query and the reason.
4. **Dash0:** Alerting → check rules → `[Redis] High memory consumption`:
   - off (it was imported switched off; the run's last question offers to turn it on, default no)
   - thresholds failed 90 / degraded 70
   - the subquery expression
   - the description rewritten with `{{ $value }}`
5. **Run 3c:** same ids, no duplicate dashboard or rule, the same output hash in `report.md`.

## 5. Pass bar
1. The Dash0 dashboard draws live data.
2. Every source widget and the monitor are in the report (nothing dropped), and every non-exact panel shows its reason.
3. `high_mem` is in Dash0, off, with `{failed: 90, degraded: 70}`, and the read-back matches.
4. Run 2 changes nothing: same ids, same hash.

Informational only: compare 2–3 panel values side by side. Small gaps are expected, because the Agent and the collector sample Redis at different moments (maths.md §9.1, e_D).

## 5b. The incident (both alerts fire)
`scripts/demo/incident.ts` causes a real `high_mem` incident on the demo Redis, so the Datadog monitor and the Dash0 rule migrated from it both fire. Show it in each product's own UI: Datadog → Monitors, and Dash0 → Alerting. (`dd2dash0 watch`, `dd2dash0 proof` and the console's Incident view were never merged; they are not part of the CLI.)

It only ever writes and deletes keys named `dd2dash0:flood:*`, each with a TTL (default 1 h). It refuses to run when:
- `maxmemory` is 0 (it would fill the host instead);
- the eviction policy is `allkeys-*` and `--allow-eviction` isn't given (that would evict the load generator's keys).

Run it where the demo Redis is reachable (Ali's stack), with `REDIS_URL` or `--url`:
```bash
npx tsx scripts/demo/incident.ts status                    # memory used / max, policy, flood keys
npx tsx scripts/demo/incident.ts flood --dry-run           # what it would write
npx tsx scripts/demo/incident.ts flood                     # fill to 95% of maxmemory (high_mem: critical 90, warning 70)
npx tsx scripts/demo/incident.ts reset                     # delete the flood keys; both alerts recover
```
The Dash0 rule only fires once it is switched **on**: turn it on in Dash0, or answer yes to the last question of a run.

**Host scope.** Ali's bundle labels every metric `host.name=dash0-live-redis`, the same name as the Datadog Agent's host. Another collector also sends a small `redis.memory.used` series with `host_name="docker-desktop"` to the same org. If it's still running, the unscoped rule averages it in and Dash0 reads far lower than Datadog. Stop that collector, or scope the demo monitor to `host:dash0-live-redis`.

## 6. Reset
```bash
npx tsx --env-file=.env scripts/demo/reset-dash0.ts --out dd2dash0-run/<time>/plan/apply          # lists what it would delete
npx tsx --env-file=.env scripts/demo/reset-dash0.ts --out dd2dash0-run/<time>/plan/apply --yes    # deletes only those
```
It deletes only items that run imported, read from `<out>/dash0/import-manifest.json`: dashboards by their `dd-…` origin, and check rules by their UUIDv5 id. Nothing else in the shared org is touched.

## 7. When something fails
| Symptom | First check |
|---|---|
| Check-rule import 400 `id` | The id must be a UUID: T6 sends UUIDv5 of the Datadog monitor id, and Import Check Rule upserts by it (Ali's probe). A `dd-…` id means an old build |
| Check-rule import 400 template | The description must parse as a Go template. T6 escapes Mustache; check the rule's annotations in `dd2dash0-run/<time>/plan/dash0/check-rules/` |
| Keys step: "Dash0 rejected the auth token" | The token is revoked or wrong (HTTP 401). Make a new one; the Datadog keys are checked separately |
| Datadog panels empty | `agent status` on Ali's machine: is the redisdb check OK? Template variables default `*` |
| Dash0 panels empty, data arriving | Compare the panel's PromQL metric names with what the collector sends. Post a mismatch in `dash0-promql` |
| Read-back "mismatch" on dashboards | Known (hub #210): T7's normaliser differs from what Dash0 returns. Not a demo blocker |
| Merge conflict building the preview branch | Ask the two PR owners; don't resolve it inside the demo branch. The demo from §1 is unaffected |
| A deleted dashboard still "reads back" | Dash0's DELETE is a soft delete: GET by origin still returns it, with `dash0.com/deleted-at`. Not yet tested: whether re-importing to that origin brings it back |
