# Orchestrator handoff: engine alignment

**Target:** a deterministic CLI that converts Datadog dashboards (and metric monitors) into Perses dashboards (and Prometheus/Dash0 check rules), with a per-item report. **No LLM takes part in any conversion step** (`AGENTS.md`).

**State:** plans 01–10 are implemented and merged, and their plan files are removed (see git history or `main-pre-rip`). The code and tests are the source of truth. [00-context.md](00-context.md) is the shared spec: rules, decisions, diagnostic codes, outcome model.

Vendor-table follow-up [#171](https://github.com/XNotAGuestX/thinchackdash/issues/171) /
[#175](https://github.com/XNotAGuestX/thinchackdash/issues/175): the full pin covers 2,065
Datadog names. The deterministic generator produces 194 draft mappings, all `reviewed: null`,
and skips 1,871 names with reasons. Unit pairs must have an explicit scale rule; Kubernetes
CPU values are scaled from cores to nanocores by 10⁹. Catalog conflicts and unknown or
incompatible units remain blocked. This includes the three conflicting Kubernetes memory /
filesystem definitions. Run `uv run scripts/generate_vendor_mappings.py --check` (or
`--skipped` for reasons). Mapping sign-off and live semantic verification remain outstanding.

**This file** is the only open plan. An orchestrator runs it with one agent per issue, many in parallel. The user asked for parallel execution of this handoff on 2026-11-07. Epic: [#104](https://github.com/XNotAGuestX/thinchackdash/issues/104).

**Goal:** make every translation demonstrably right, cheapest evidence first:
1. Datadog's own OTel mapping table;
2. Datadog metric types;
3. documented semantics;
4. a read-only Dash0 smoke check;
5. last, an advisory Agent0 opinion.

## Widget time-window follow-up

[#158](https://github.com/XNotAGuestX/thinchackdash/issues/158), branch `158-timepin-panels`: shared widget-option handling accepts empty `time: {}` as a no-op and supported pinned `live_span` windows as approved `TIMEPIN` approximations for every supported widget type, including future types and a pin matching the initial `1h` duration. Values reduced over the dashboard range can change. Unknown time shapes and independent query/mapping blockers remain blocked. See [REMARKS.md](../REMARKS.md). No live verification is claimed by this offline compiler change.

## Waves

General-input follow-up [#167](https://github.com/XNotAGuestX/thinchackdash/issues/167), branch
`167-general-inputs`, implements items 1 + 2 + 5 from Felix's current request: reject runs with
no recognized assets, return exit 2 with visible warnings for skipped files, and inspect exact
metric-name mapping coverage before compilation. The report and terminal list missing names,
their source locations and unparsed queries. Mixed-integration dashboards use the complete
supplied mapping table independently of filenames. No target option or bundle extraction is
added. SourceProvider methods and translation semantics remain unchanged. Review of
[PR #168](https://github.com/XNotAGuestX/thinchackdash/pull/168) found no blocking issues;
the required check passed (993 tests, 621 skipped), and Felix authorized the merge.

Current-session extension tracks (2026-11-08): [#162](https://github.com/XNotAGuestX/thinchackdash/issues/162) broadens metric-monitor arithmetic, [#163](https://github.com/XNotAGuestX/thinchackdash/issues/163) adds high-impact deterministic function approximations, [#164](https://github.com/XNotAGuestX/thinchackdash/issues/164) propagates the distinct `best_effort` category, and [#165](https://github.com/XNotAGuestX/thinchackdash/issues/165) verifies cases empirically against the retained shared telemetry stream. These tracks run in parallel under Felix's explicit request. Approximate functions carry tags and never bypass missing mappings or other unsupported semantics. Merge remains subject to Felix's review.

Implementation is consolidated on `164-best-effort-outcomes` for one final review: **971 tests passed / 621 skipped**, lint and strict typing passed, and one real extension comparison passed **8/8** with full coverage. Four more pinned Kafka panels and one Redis arithmetic monitor now convert. The review also carries #159's retained-stream implementation as a dependency. No additional review/test cycles are planned after these passing checks; the next action is Felix's concrete review/merge. Details and limitations: [STATUS.md](../STATUS.md), [LIVE_EXTENSIONS.md](../LIVE_EXTENSIONS.md).

Every issue is self-contained: summary, context, files, acceptance criteria, verify commands, stop conditions and the shared Definition of Done. Start a wave-2 issue once its "Depends on" issues are merged.

| Wave | Issue | Work | Owns (files) | Merge |
|---|---|---|---|---|
| 1 | [#105](https://github.com/XNotAGuestX/thinchackdash/issues/105) | **Vendor table**: pin Datadog's OTel mapping rows, check mappings, report gaps | new script, fixture, test | any time |
| 1 | [#106](https://github.com/XNotAGuestX/thinchackdash/issues/106) | **Metric types**: pin `metadata.csv`, check mapping `kind` | pin script, new fixtures, test | any time |
| 1 | [#107](https://github.com/XNotAGuestX/thinchackdash/issues/107) | **Default aggregator**: `avg` + `DEFAULT_AGGREGATOR_APPLIED` | `compile_query.py`, goldens | hotspot, 1st |
| 1 | [#108](https://github.com/XNotAGuestX/thinchackdash/issues/108) | **Template-variable promotion** per mapped query (#96 R1) | `dashboard.py` `_promote_variables`, goldens | hotspot, 2nd |
| 1 | [#109](https://github.com/XNotAGuestX/thinchackdash/issues/109) | **Panel heights**: documented layout scale | `dashboard.py` `_GridBuilder`, goldens | hotspot, 3rd |
| 1 | [#123](https://github.com/XNotAGuestX/thinchackdash/issues/123) | **Mapping table**: `--mapping` takes a folder or repeats; all files merge into one table; `system.*` moves to `host.json`; file-level `labels` | `cli.py`, `convert.py`, `mapping.py`, `mappings/datadog/*.json`, `build_expected.py`, goldens | hotspot, 4th |
| 1 | [#110](https://github.com/XNotAGuestX/thinchackdash/issues/110) | **Smoke check**: read-only Dash0 query per panel → `smoke.json` | new script, test | any time |
| 2 | [#111](https://github.com/XNotAGuestX/thinchackdash/issues/111)–[#115](https://github.com/XNotAGuestX/thinchackdash/issues/115) | **Mapping evidence per service** (postgres, kafka, redis, nginx, docker): vendor row or deviation, type match, both sources in `ref`, gaps, golden | `mappings/datadog/<svc>.json`, own golden | any time; postgres is a hotspot |
| 2 | [#116](https://github.com/XNotAGuestX/thinchackdash/issues/116)–[#120](https://github.com/XNotAGuestX/thinchackdash/issues/120) | **Datadog functions**: `.weighted()`, `top()`, `.as_count()`/`.as_rate()`, `abs()`, `.rollup()`/`.fill()`; exact translation or documented block | `compile_query.py`/`formula.py`, goldens | hotspot, one at a time |
| 3 | [#121](https://github.com/XNotAGuestX/thinchackdash/issues/121) | **Agent0 review** (advisory): per-panel `same / different / unsure` → `agent0-check.json`, flagged separately; `status: error` if the call fails | new script, test | last |

Dependencies:
- #111–#115 need #105, #106 and #123.
- #116–#120 need #107; #118 also needs #106.
- #121 needs #110.

## Merge order (hotspot:converter)

Issues labelled `hotspot:converter` change the converter and regenerate `fixtures/expected/postgres-p1/` and `expected.yaml`. Agents may work on them in parallel, but they merge **one at a time**:

1. #107
2. #108
3. #109
4. #123
5. #111 (Postgres golden refresh)
6. the function issues, in any order

Before each merge, the agent:
1. rebases on `main`;
2. regenerates the goldens (`uv run migrator convert …` as in the golden test, and `uv run scripts/build_expected.py <svc>/<id>`);
3. reruns `uv run migrator check`.

All other issues own disjoint files and merge whenever they are green.

## Agent protocol

1. **Read** `AGENTS.md`, this file, [00-context.md](00-context.md) and the issue, including its comments.
2. **Claim:** assign the issue to XNotAGuestX and comment the branch name. Work in your own worktree, on branch `<issue>-<slug>`, from current `main`.
3. **Stay in scope:** change only the files listed under **Files**. Any other need is a comment on the issue, not an edit.
4. **Stop and ask** (comment, then wait) on the issue's stop conditions:
   - semantics the docs leave open;
   - any approximation;
   - live writes;
   - new dependencies.
5. **Finish:**
   - the PR says `Closes #<n>`;
   - it carries the evidence for every acceptance criterion (commands and real output);
   - `uv run migrator check` passes;
   - set the board status to `In review`.
6. **Merge:** XNotAGuestX reviews. Felix, or an agent acting for him with his go-ahead, merges, following the merge order above.
7. **Report:** at handoff, comment on the issue (template in `docs/STATUS.md`). Update this table only when an issue closes or the plan changes.

Mapping rules for #111–#115 are written out in each issue. The agent never sets `reviewed`; a human does that in the PR review.

## Human-only items (no agent issue)

- **Mapping sign-off:** set `reviewed` in the #111–#115 PRs.
- **Expectation decisions:** #96 R2, R5 and R6 go into `fixtures/expected/<svc>/<id>/overrides.yaml`.
- **Assumed defaults:** confirm A1–A3 (`00-context.md` §3).
- **Durable demo telemetry** (B2, #4):
  - record in `docs/DEMO.md` how the local OTel Demo with the Dash0 exporter starts (repo, version, compose command, env var names);
  - check before each rehearsal that `max by (postgresql_database_name) (postgresql.backends)` has data for the last 30 minutes.
- **Threshold crossing for the demo:** `scripts/hold-pg-connections.sh <count> <seconds>`. At current ≈ 8 and max = 100:
  - `N = 75` gives ≈ 0.83, past the 0.8 warning;
  - `N = 85` gives ≈ 0.93, past the 0.9 critical.

  Hold each step longer than 15 minutes, with the demo check enabled; that is a live write and needs Felix's go-ahead.
- **Submission (#2), only on Felix's request:**
  1. fork `vimouzin/dash0-dashboard-migrator`, push a feature branch (no forced unrelated history);
  2. secret gate: `git grep -nE "auth_[A-Za-z0-9]{8,}|DD_API_KEY=.+|DASH0_AUTH_TOKEN=.+"` must print nothing;
  3. open the PR with offline, mocked and live evidence kept separate.

## Horizon: live Datadog ([#122](https://github.com/XNotAGuestX/thinchackdash/issues/122))

The live asset-`fetch` round trip remains tracked and unverified:
- the live `fetch` round trip (code merged, offline-tested);
- targeted numeric spot checks for function semantics the docs leave open.

Felix expanded this horizon on 2026-11-08 into an **on-demand comparison environment**
([#146](https://github.com/XNotAGuestX/thinchackdash/issues/146), branch `146-live-comparison`).
It reuses pinned full OTel Demo images, collects shared samples, publishes converted demo
assets and checks read-back and numeric parity, with independently defined workloads/tests
and a default 3% per-series mean tolerance. See [LIVE_COMPARE.md](../LIVE_COMPARE.md).
Offline tests and a local-only startup/metric smoke are verified. The authorized `.env` PAT
and Dash0 token passed live query authentication on 2026-11-08; the supplied `DD_API_KEY`
also passed ingestion-key validation. The real run passed 4/6 cases at 3%; connection gauge
and monitor values differed by 3.2787% and failed. Follow-up: [#148](https://github.com/XNotAGuestX/thinchackdash/issues/148).
The script loads `.env` automatically; see [STATUS.md](../STATUS.md#live-shared-sample-comparison-2026-11-08)
for the numeric outcome and recorded import IDs.
Compiler semantics, mappings and review status are unchanged.

Felix requested broader live coverage on 2026-11-08 in [#157](https://github.com/XNotAGuestX/thinchackdash/issues/157):
28 cases across PostgreSQL, Redis, NGINX, Kafka, host and Docker, including approved assumed
and approximated outcomes from pending PR #156. Its retained-stream lifecycle starts without
a measurement wait and reuses completed historical windows for subsequent suites. The
infrastructure suite is a two-minute smoke at the unchanged 3% tolerance; the original
default suite keeps its ten-minute window. Live numeric parity does not certify the tagged
behavior differences. See [LIVE_COMPARE.md](../LIVE_COMPARE.md#reuse-a-running-stream).

## Open decisions and blockers

- **Local demo backend** ([#177](https://github.com/XNotAGuestX/thinchackdash/issues/177)):
  Felix additionally authorized explicit Agent0 recommendations for blocked items
  only: three calls per local server session, then contact sales at sandy@dash0.com.
  Recommendations never run automatically or change compiler output. Tests for this
  addition are deferred at Felix's explicit request.
  minimal `backend/` HTTP adapter stacked on frontend PR #174, explicitly requested by
  Felix. Upload JSON or run the pinned demo through the existing offline converter;
  show exact row categories and diagnostics. Dashboard failures remain hidden as
  requested. Publishing, numeric comparison and streamed progress are unavailable;
  see [the mismatch list](../../backend/README.md#frontendbackend-mismatches).

- **A1** target vocabulary = names and labels as found in Dash0. *Assumed default.*
- **A2** alert output = Prometheus rule group + Dash0 check rule. *Assumed default.*
- **A3** monitor strictness = approximate and warn on a reviewed allowlist, block the rest. *Assumed default.*
- **B1** Dash0 token: resolved.
- **B2** demo telemetry owner: open (#4).
- **B3** Datadog account: horizon (#122).
- **Starter/fork relationship:** open (#2).
