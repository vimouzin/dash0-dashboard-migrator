# dd2dash0

**Move your Datadog dashboards and monitors to Dash0 with one command, and get a report that tells you exactly what made it.**

`dd2dash0` reads your Datadog account and translates every dashboard to a **Perses** dashboard, every query to **PromQL**, and every monitor to a **Dash0 check rule**. It imports them into Dash0, reads each item back, checks that the new queries return real data, and prints how well it went.

Translation is **deterministic**: a Datadog query parser, rule tables and metric mapping tables do the work. **No AI model touches your queries.** Anything that can't be translated exactly is never dropped: it lands as a placeholder panel holding the original query, and the report says why.

It runs in your terminal, because the people who migrate monitoring are engineers, and engineers live there. No web app to log in to, no account to create.

**Tested on Datadog's own dashboards.** All 516 dashboards and 329 monitors in [DataDog/integrations-core](https://github.com/DataDog/integrations-core) run through end to end: **92.4% of 14,172 distinct queries and monitors translate, and 89.4% are exact under a stated condition** ([details](#tested-against-datadogintegrations-core)). One command repeats it: `npm run integrations-core`.

## Quick start

Download one file and run it. No Node, no clone, no install, no folder of extras:

```bash
# macOS, Apple silicon (M1-M4)
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-macos-arm64.tar.gz | tar xz && ./dd2dash0
```
```bash
# macOS, Intel
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-macos-x64.tar.gz | tar xz && ./dd2dash0
```
```bash
# Linux x64 (use dd2dash0-linux-arm64 on ARM)
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-linux-x64.tar.gz | tar xz && ./dd2dash0
```
Windows: download `dd2dash0-windows-x64.zip` from [Releases](https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest), unzip it, and run `.\dd2dash0.exe` in PowerShell.

The archive holds one file, `dd2dash0`, with everything inside it (the mapping tables included). `SHA256SUMS.txt` on the release lists the checksums. If macOS refuses a browser download ("cannot be opened"), run `xattr -d com.apple.quarantine dd2dash0` once; downloading with `curl` as above avoids this.

## What a run looks like

A real run against our Datadog trial and Dash0 org (1 dashboard, 1 monitor; v0.5.0, live import). Since v0.5.5 the run also prints the coverage by query type after Translate (shown [below](#tested-against-datadogintegrations-core)):

```
╭──────────────────────────────────────────╮
│ ◆ dd2dash0 0.5.0                         │
│   Datadog → Dash0 · deterministic, no AI │
╰──────────────────────────────────────────╯

● Keys
  ⎿ Datadog  datadoghq.eu · API key …b57c · app key …e17s  ✓
  ⎿ Dash0    api.europe-west4.gcp.dash0.com · default · token …Waoy  ✓

● Translate  1 dashboard · 1 monitor → 37 items  0.5s
  ⎿ 21 exact-under · 10 bounded · 5 manual · 1 unsupported

● Review
  Import 10 approximate panels? They are translated within a proven error bound.  › Yes, import them
  ⎿ 6 panel(s) can't be translated exactly; they become placeholder panels with the original Datadog query.
  Import this check rule?  › Yes, import it (it starts off)

● Import  1 dashboard · 1 check rule  1.2s
● Verify  read back 2/2 · 22/22 queries return data  0.7s

╭─ Result ───────────────────────────────────────────────╮
│ success     ███████████████░░░    31/37   83%          │
│ translated  ███████████████░░░    31/37   83%          │
│ landed      ██████████████████    37/37  100%          │
│ live        ██████████████████    22/22  100%          │
│                                                        │
│ gaps   metric.no_equivalent ×5 · widget.unsupported ×1 │
│ rules  1 imported (0 on, 1 off)                        │
│ report report.html · report.md                         │
╰────────────────────────────────────────────────────────╯
```

What the numbers mean (each counts every panel, including notes, and every monitor; percentages round down):

| Number | Meaning |
|---|---|
| **translated** | exact, exact under stated conditions, or approximate within a proven bound and approved by you |
| **landed** | imported into Dash0 and read back identical (placeholders count: they landed) |
| **live** | the migrated query returns data in Dash0 when the Datadog query has data (last hour) |
| **success** | translated, landed, and not missing data |

Every run writes `dd2dash0-run/<time>/report.html` (open it in a browser), `report.md` and `report.json`, with every panel and monitor, its claim, the original Datadog query, the PromQL, and what to do by hand where needed.

## See the engine: `dd2dash0 explain`

No wrapper, no model: a parser, mapping tables and a rule table with a claim for every rule. `explain` shows one query going through exactly the code a migration runs:

```
$ dd2dash0 explain "avg:redis.mem.used{env:prod} by {host}.rollup(avg, 60)"

● Parse  recursive-descent parser, Datadog query grammar → AST  0.62 ms
  └─ .rollup(avg, 60)
     └─ metric redis.mem.used
        ├─ space agg: avg
        ├─ scope: env:prod
        └─ group by: host

● Map  332 curated metric mappings · 36,828 Datadog metric kinds
  ⎿ redis.mem.used → redis.memory.used  gauge · exact  mappings/datadog/redisdb.yaml
  ⎿ tag host → host_name
  ⎿ tag env → deployment_environment_name

● Rules  4 applied from the rule table  3.12 ms
  ⎿ select.metric.mapped  exact        Datadog metric -> {otel_metric_name=...} through the mapping table
  ⎿ scope.tag.eq          exact        key:value -> key="value"
  ⎿ time.rollup.explicit  exact-under  .rollup(fn, s) -> fn_over_time(x[s])
  ⎿ space.agg             exact        avg|sum|min|max|count by {tags} -> PromQL aggregation by (labels)

● PromQL  parsed by the official PromQL grammar (lezer-promql) ✓
  avg by (host_name) (avg_over_time({otel_metric_name="redis.memory.used", deployment_environment_name="prod"}[1m]))

● Claim  exact-under
  ⎿ equal to Datadog's result whenever these conditions hold:
  ⎿ A.align     PromQL evaluation step equals the Datadog rollup width and timestamps are Unix-aligned
  ⎿ A.boundary  no sample lies exactly on a bucket boundary
```

It explains monitors too (`avg(last_5m):… > 90` → a Dash0 check rule with `failed`/`degraded` thresholds), and points at the exact character where a query doesn't parse.

## Terminal or browser

`dd2dash0` first asks where you want to work. **Here, in this terminal**, or **in the browser**: the same tool on a one-time page on your own computer (127.0.0.1, a secret link, no account, nothing hosted). The browser page is not a second app. The migration still runs in your terminal's process, and the page draws exactly what the terminal would show: the same step tree, colors, spinners and questions, answered with the same keys (arrows, Enter, numbers, `y`/`n`). Drop your `.env` onto the page to add keys. `--web` skips the question.

## What you need

| Key | Where to find it |
|---|---|
| Datadog API key | Datadog → Organization Settings → API Keys |
| Datadog application key | Organization Settings → Application Keys (needs `dashboards_read`, `monitors_read`) |
| Datadog site | `datadoghq.eu`, `datadoghq.com`, `us5.datadoghq.com`, … |
| Dash0 API URL | Dash0 → Settings → Endpoints → **API** (not the ingress/OTLP endpoint) |
| Dash0 auth token | Dash0 → Settings → Auth Tokens |
| Dash0 dataset | usually `default` |

Have a `.env` already? dd2dash0 reads `./.env` by itself, and offers env-looking files it finds in the current folder or `~/Downloads` (`prod.env`, `.env.local`, `env.example copy.txt`, …) as the first choice. Point at any file with `--env <file>`. Or **drag it into the terminal window** (or paste its contents) when dd2dash0 asks; in the browser, drop it on the page or pick it with **choose a file…**: it reads the keys, shows only their last four characters, and checks each one with a read-only call. Other common names work too (`DATADOG_API_KEY`, `DD_APPLICATION_KEY`, `DASH0_TOKEN`, …). You can also type them one by one (a dot per character, never the key), or enter them on a one-time page on your own computer (`--browser`: 127.0.0.1 only, secret link, closes after use).

Saved once, they live in `~/.config/dd2dash0/.env` (only you can read it) and work from any folder. dd2dash0 looks in the environment, then `./.env`, then that file.

## What it does, step by step

1. **Keys**: finds, asks for, and checks the six values above.
2. **Translate**: reads every dashboard and monitor from the Datadog API and translates them. Nothing is written yet.
3. **Review**: one question for all approximate panels, one per monitor (arrow keys). Panels that can't be translated exactly become placeholders with the original query.
4. **Import**: dashboards and check rules go into Dash0. Re-runs replace, never duplicate. New check rules start **off**, so nobody gets paged by surprise; a rule that already exists keeps its on/off state.
5. **Verify**: reads every item back from Dash0 and runs every migrated query against the last hour of data, next to the original Datadog query.
6. **Report**: the result card, `report.html`, `report.md`, `report.json`. At the end it offers to turn the approved rules on (default no) and to open the report.

Commands: `dd2dash0` (the guided migration), `dd2dash0 explain "<query>"`. Options: `--yes` (no questions: keys from the environment, `.env` or the saved file, approve approximate panels and translatable monitors), `--only dashboards|monitors`, `--dry-run` (import nothing), `--input <dir>` (Datadog JSON exports instead of the API), `--env <file>` (keys from any file), `--web` (run it in the browser), `--browser` (only the key page), `--out <dir>`, `--help`. Exit codes: 0 all good, 1 something failed (see the report), 2 refused, 3 usage or key error. Scripting commands (`plan`, `review --terminal`, `apply`, `migrate`) are listed by `--help-advanced`.

## How it works

```
Datadog API ──► parse (Datadog query grammar → AST) ──► IR (dashboards, panels, queries, alerts)
            ──► translate (PromQL + Perses panels + Dash0 check rules, every step emits findings)
            ──► validate (PromQL parses, Perses shape, preflight) ──► import (Dash0 API) ──► read back
            ──► verify (Dash0 query API vs Datadog query API, last hour) ──► report
```

- **Deterministic**: the same input and version always give the same output (the report carries an output hash to prove it).
- **Honest claims**: every item is `exact`, `exact-under` (exact if stated conditions hold), `bounded` (within a proven error), `manual` or `unsupported`. Nothing is rounded up.
- **Metric mappings**: Datadog integration metrics map to their OpenTelemetry receiver equivalents through `mappings/` (Redis, PostgreSQL, NGINX, system/host metrics).
- **Monitors**: become Prometheus alerting rules with Dash0's threshold extension (`critical` → `failed`, `warning` → `degraded`).

## Known limits

- Monitors that use Datadog-only functions (anomaly detection, forecasts, outliers) can't become a PromQL rule. They are listed in the report with the reason, not imported.
- Metrics with no OpenTelemetry equivalent keep their Datadog name and are flagged (`metric.no_equivalent`): the panel lands, but Dash0 may have no series by that name.
- Datadog Agent integrations not in `mappings/` translate structurally, with every unmapped metric flagged.
- The arrow-key prompts are not tested on Windows yet.

## Tested against DataDog/integrations-core

The Dash0 case names [DataDog/integrations-core](https://github.com/DataDog/integrations-core): Datadog's own dashboards and monitors for every integration (516 dashboards, 329 monitors). One command fetches just those files and runs the whole guided flow over them, as a dry run:

```bash
npm run integrations-core
```

```
● Translate  516 dashboards · 329 monitors → 14614 items  5.4s
  ⎿ 12111 exact-under · 302 bounded · 1499 manual · 702 unsupported
● Import  516 dashboards · 184 check rules (dry run, nothing imported)
  translated  12413/14614   84%
```

Every run also reports **coverage by query type**: every distinct query and monitor in the source, run through the same translators, split the way a Datadog user thinks of them. Over integrations-core:

```
● By query type  14,172 distinct queries and monitors
  ⎿ Legacy queries   ████████████████▓░   96.7%  1555/1607  time.kind 26 · metric.derived 9
  ⎿ Log monitors     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░   93.7%  30/32  log.monitor.shape 2
  ⎿ Log queries      ████████████████░░   93.4%  4177/4472  log.measure 292 · log.or.cross-key 2
  ⎿ Log formulas     ████████████████░░   92.8%  2100/2261  log.measure 152 · fn.throughput 5
  ⎿ Metric queries   ███████████████▓░░   91.1%  5030/5520  metric.no_equivalent 200 · time.kind-unknown 81
  ⎿ Metric monitors  ███████████▓▓░░░░░   72.8%  204/280  fn.anomalies 46 · monitor.as_count 13
  ⎿ 92.4% of 14,172 distinct queries and monitors translate, and 89.4% are exact under a stated condition.
```

Solid is exact under a stated condition, shaded is within a proven bound, and what stays with a person is named with its reason (46 metric monitors use `anomalies()`: we don't guess). The same section is in `report.html`, `report.md` and `report.json` (`queryCoverage`), for whatever you migrate.

Every dashboard and every translatable monitor passes the pre-import checks (exit 0). What doesn't translate is listed per item in `.corpus/run/report.html`, never dropped: mostly widget types with no Dash0 panel (`widget.unsupported`), queries on non-metric data sources, and the 145 monitors that use Datadog-only functions such as `anomalies()` or metrics with no OTel equivalent.

"Translates" counts valid PromQL. Where a metric has no row in `mappings/datadog/`, the query keeps its Datadog name and returns data only if your Collector emits that name, so the mapping tables matter more than the percentage. With the Kubernetes tables (`kubernetes.yaml`, `kubernetes_state.yaml`), 514 more queries point at real kubeletstats / k8s_cluster metrics, and 185 that would have drawn an empty panel now say there is no equivalent. That's why the percentage went down from 93.7%.

## Run from source

```bash
git clone https://github.com/amirgulubayli/dash0-dashboard-migrator && cd dash0-dashboard-migrator
npm ci
npx tsx src/cli.ts                                              # the guided flow
npx tsx src/cli.ts --dry-run --input fixtures/datadog           # offline: translate the bundled fixtures, import nothing
npm test                                                        # the test suite
```

Needs Node 22+. Pushing a tag `v<version>` (matching the version in `package.json` and `src/cli.ts`) builds every platform and publishes a release (`.github/workflows/release.yml`).

`experimental/` holds parked extras (a web review console, a live viewer and voice narrator). They are not part of the CLI.
