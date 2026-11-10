# CONTRACT-003: plan / review / apply, report.json v2 and review.json (DRAFT, rev 2)

Owner: Michael (T8 + U2). Status: **DRAFT rev 2.** It folds in Henry's and Ali's reviews of rev 1 and the agreed CLI/web UI spec. Code follows only after the team agrees.
Changes from rev 1 are listed in §10.

## 1. Why
- **The CLI is the product.** Dash0 asks for a CLI-first tool, and an engineer must be able to plan, review and apply a migration from the terminal alone.
- **The web UI follows the CLI.** The UI (Henry's console, `console/`) adds visuals: it shows the CLI's data and decides nothing.
- **Gaps today:**
  - There's no reviewed path from translation to import.
  - The review isn't tied to the payloads that get imported.
  - The report lacks what the UI needs: groups, coverage, explanations, rule flow, gaps, links.

## 2. Principles
1. **Additive report.** Every v1 field keeps its name, type and meaning. A v1 reader (the console's `src/lib/report.ts` at `8c3e65a`) keeps working. `schema` becomes `"dd2dash0.report/v2"`.
2. **Deterministic.** Same input + config → byte-identical plan: canonical JSON, sorted keys, trailing newline, no timestamps, no model.
3. **The CLI decides, the UI shows.** Every number, label, sentence, order and verdict comes from CLI files. No AI and no external network in either.
4. **No guessed values.** A field the CLI can't fill truthfully is `null`.
5. **Nothing silent.** Every refusal names the items and the reason. Every Dash0 failure carries its trace id.

## 3. Commands (`src/cli.ts`, HOT)
```
dd2dash0 plan   [--config dd2dash0.yaml] (--input <dir> | --api) [--select <glob>…] [--out plan/]
dd2dash0 review plan/ [--terminal] [--port 4317]
dd2dash0 apply  plan/ --approved plan/review.json [--enable-rules] [--allow-pending] [--force] [--verify-data] [--ui]
dd2dash0 migrate …        # one-shot: plan + apply of everything, as today (kept for scripts and the live dry runs)
dd2dash0 diff planA/ planB/
dd2dash0 parity plan/     # T10's compare script folded in: fills checks.parity (§5.5)
```
**Config:** an optional `dd2dash0.yaml`:
```yaml
source: { kind: api, site: datadoghq.eu }   # or { kind: folder, path: ./exports }
select: ["redis*"]
mappings: ./mappings
channels: ./mappings/notification-channels.yaml
dash0: { dataset: default, orgId: f22d83d8-… }   # orgId only builds UI links
enableRules: false
allowPending: false
verifyData: false
```
- **Precedence:** flags override the file. Secrets come only from env / `.env` and never appear in a config or a plan.
- **Recorded:** the resolved config is written into `plan.lock` and `report.json` (`run.config`).

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | some imports failed |
| 2 | refused: plan hash, drift, pending items or a disallowed decision |
| 3 | usage or config error |

## 4. The plan directory
```
plan/
  plan.lock     # canonical JSON: { schema: "dd2dash0.plan/v1", inputHash, catalogHash, config, files: { "<relative path>": "<sha256>" } }
  report.json   # v2 (§5)
  report.md
  events.jsonl
  dash0/dashboards/<origin>.json
  dash0/check-rules/<uuid>.json
  parity/<item>.json     # optional, written by `dd2dash0 parity`
  review.json            # written by `review`; not in plan.lock
  apply/                 # written by `apply`: report.json (post-import), import-manifest.json; not in plan.lock
```
- **The plan hash** is `sha256(plan.lock bytes)`. It covers every report and payload file, so a hand edit to *any* of them voids a review.
- **Sharing:** paths are relative; zip the folder to share it.

## 5. report.json v2: additions

### 5.1 `run`
| Field | Type | Meaning |
|---|---|---|
| `run.source` | `{ kind: "api" \| "folder"; site: string \| null; path: string \| null }` | Where the input came from (relative path as given) |
| `run.toolCommit` | `string \| null` | CLI build commit from a build stamp, else `null`. Never read from the working tree at run time |
| `run.catalogHash` | `string` | sha256 of the canonical rule catalog: the rule version behind this report |
| `run.config` | object | The resolved config (§3), without secrets |
| `run.planHash` | `string` | The plan hash (§4). Present in `plan/report.json`; `apply/report.json` keeps the plan's hash |

### 5.2 `summary`
| Field | Type | Meaning |
|---|---|---|
| `summary.metrics` | `{ total; mapped; approximate; derived; needsTransform; noEquivalent; unmapped }` | Counts over distinct Datadog metric names in metric queries; the parts add up to `total` |
| `summary.groups` | `number` | Group items |
| `summary.reviewOrder` | `string[]` | Items **that need a decision** (§6), in this order: (1) status `manual`, `unsupported`, then `bounded`; (2) alerts before panels; (3) more findings first; (4) `id`. Items that are `exact` or `exact-under` are **not** included: they need no decision (they import as translated) |
| `summary.gaps` | `{ code; panels; fixKind: "mapping" \| "rule" \| "dash0-limit" \| "source"; example: string }[]` | Codes ranked by the number of panels they block (gap ranking view) |
| `summary.flow` | `{ construct; ruleId; claim; count }[]` | Aggregated from every item's `certificate.rules` and the catalog: Datadog construct → rule → claim (rule-flow view). `construct` is the rule's catalog stage, plus the Datadog function name where there is one |

### 5.3 Top level
| Field | Type | Meaning |
|---|---|---|
| `reasonCodes` | `Record<code, { label; explanation; plain; catalogRule: string \| null }>` | Exactly one entry per code used in this file's `reason_codes` and `findings`. `label`: 2–4 words. `explanation`: technical, 1–2 sentences. `plain`: one sentence. All come from the rule catalog |

**Invariant, enforced by a test:** every code resolves to a catalog row or a rule's `findingCode`. There's no free-text fallback. Ali's corpus check found 14 codes that don't resolve yet:
- **The T5 codes PR #16 adds:** `layout.clamped`, `widget.toplist.unranked`, `query.empty`, `widget.query_value.default-agg`.
- **Manual outcomes with no row yet:** `fn.autosmooth`, `fn.throughput`, `fn.rate`, `fn.forecast`, `fn.ewma_3`, `fn.ewma_10`, `fn.outliers`, `fn.calendar_shift`, `fn.sum`, `source.unreadable`.

T17 (Michael) adds the rows, and the corpus/fixture conformance test (Ali offered `tests/cli/report-codes.test.ts`) keeps it that way.

### 5.4 Items
**Group items (new kind `"group"`):** one per Datadog group, placed before its panels.

| Field | Value |
|---|---|
| `id` | `dd-dash-<dashboard>/<group widget id>` |
| `title`, `dashboard` | group title, dashboard title |
| `widget_type` | `"group"` |
| `group`, `group_id` | `null` |
| `layout` | Dash0 Grid section (24 columns) |
| `source_layout` | Datadog group position (12 columns, dashboard-relative) |
| `status` | `"exact"` |
| `source_queries`, `promql`, `reason_codes`, `findings` | `[]` |
| `certificate.rules` | `["layout.group"]` |
| `target` | the dashboard's |

**Panel and alert items, new fields:**

| Field | Type | Meaning |
|---|---|---|
| `group_id` | `string \| null` | Parent group item's id. The console matches groups **by id**, not by title |
| `source_layout` | `{x,y,w,h} \| null` | **Datadog** position, 12 columns, relative to its group. **The console's map uses this.** The existing `layout` stays the Dash0 position (24 columns) |
| `condition` | `string \| null` | For `exact-under`: the item's assumptions as plain sentences, joined with "; ". Otherwise `null` |
| `explain` | `{ technical: string; plain: string }` | From catalog templates over the item's rules. Example: technical "time.rollup.explicit: exact-under(A.align, A.boundary)"; plain "Same values as Datadog as long as both tools line their minutes up the same way." |
| `decision_required` | `boolean` | `true` exactly for the items in `summary.reviewOrder` |

### 5.5 After apply (`apply/report.json`) and parity
| Field | Type | Meaning |
|---|---|---|
| `target.url` | `string \| null` | Dash0 link (§5.6), or `null` when `dash0.orgId` isn't configured or the id isn't resolved |
| `target.dash0Uid` | `string \| null` | Dash0's internal id, resolved from `GET /api/dashboards` (origin → id) after the PUT |
| `certificate.checks.importedReadBack` | `boolean \| null` | As in v1 |
| `certificate.checks.returnsData` | `boolean \| null` | With `--verify-data`: every PromQL of the item returned at least one series over `--verify-window` (default 1h). `null` = not checked |
| `certificate.checks.parity` | `{ window; points; maxAbsErr; tolerance; ok } \| null` | From `dd2dash0 parity`. `tolerance` = the rule's ε, or the float bound for exact claims (maths.md T9). Series go in `plan/parity/<item>.json` |

### 5.6 Dash0 link format (from Ali's decoding of a real link, #543; **one click still to confirm**)
- **Format:** `https://app.dash0.com/dashboards?org=<ORG_UUID>&s=<STATE>`, where `STATE = base64url(zlib(JSON))` with padding percent-encoded, and `JSON = {"/dashboards":{"list":{"open":true,"id":"<DASHBOARD_UID>"}}}`.
- **Org id:** `ORG_UUID` comes from config (`dash0.orgId` / `DASH0_ORG_ID`); it can't be derived from the token.
- **Dashboard id:** `DASHBOARD_UID` is Dash0's internal id, not our origin.
- **Check rules:** the link format isn't known, so `target.url = null` for check rules until it's probed.

## 6. review.json (written by `review` or the console)
```json
{ "schema_version": "1", "plan_sha256": "<plan hash>", "report_sha256": "<sha256 of plan/report.json bytes>",
  "reviewer": "name", "decisions": [{ "id": "<item id>", "decision": "approved" | "flagged" | "acknowledged", "note": "" }] }
```
- **Binding:** `apply` checks `plan_sha256`. During the switch, a review that has only `report_sha256` is accepted if it matches the report bytes, with a warning that payload edits aren't covered.
- **Allowed decisions** (console rules):

  | Item | Allowed |
  |---|---|
  | `bounded` panel | `approved` \| `flagged` |
  | `manual` / `unsupported` panel | `acknowledged` |
  | alert | `approved` \| `flagged` |
  | `exact` / `exact-under` item | none (`decision_required: false`) |

## 7. Review and apply behaviour
- **`review`** serves the prebuilt console (`dist/console/`) at `/`, the plan's report at `/report.json`, and the live viewer at `/live`.
  - **Saving:** decisions go to `plan/review.json` through `POST /api/review` on the same local server.
  - **Live:** `/events` streams progress.
  - **`--terminal`** walks `summary.reviewOrder`. It shows the Datadog query, PromQL, `explain.technical`, reasons and the condition; keys are `a` approve, `f` flag + note, `k` acknowledge, `s` skip, `q` quit (progress saved). It writes the same `review.json`.
- **`apply`:**
  1. **Hash check:** verify the plan hash (exit 2 on mismatch).
  2. **Source drift:** re-read the Datadog sources; if the input hash differs, exit 2 ("source changed since plan").
  3. **Target drift:** for each item already in Dash0, read it back. If it differs from what the previous apply wrote (a hand edit), refuse that item unless `--force`.
  4. **Import per decision:**

     | Item | Decision | Apply does |
     |---|---|---|
     | `exact` / `exact-under` panel | none needed | import translated |
     | `bounded` panel | `approved` | import translated |
     | `bounded` panel | `flagged` | Markdown placeholder: original query + note + reasons (T5's placeholder rule) |
     | `bounded` panel | none | refuse, listing ids (`--allow-pending` imports translated) |
     | `manual` / `unsupported` panel | any | placeholder, as is |
     | alert | `approved` | import (disabled unless `--enable-rules`) |
     | alert | `flagged` / none | skip, listed |

     Dashboards are imported with `PUT /api/dashboards/{origin}`, check rules with `POST /api/import/check-rule` and their UUIDv5 id (T7). Both are idempotent.
  5. **Failures:** continue past them and record each with Dash0's trace id. Exit 1 if any failed. A re-run retries only what's missing or failed.
  6. **Report:** write `apply/report.json` with `target`, `target.url`, `target.dash0Uid`, the read-back result and, with `--verify-data`, `returnsData`.

## 8. Terminal output
- **On a TTY:** colour (hand-written ANSI), a progress line per dashboard, the summary table with block-character coverage bars, and a next-step hint.
- **Piped or `--json`:** plain lines, or one JSON event per line (the `events.jsonl` events).

## 9. Tests
- **Report shape:**
  - the v1 field names and types are pinned against a v1 fixture
  - the reason-code invariant holds (§5.3)
  - `summary.reviewOrder` = exactly the items with `decision_required`
- **Determinism:** `plan` twice gives byte-identical files and plan hash. `apply` twice changes nothing in Dash0 and leaves `apply/report.json` byte-identical apart from fields Dash0 returns.
- **Refusals:** a mismatched plan hash, source drift, target drift, a disallowed decision and pending bounded panels each exit 2, naming the ids.
- **Web UI:** console unit tests for the new fields (the old fixture still parses), plus **one Playwright e2e** on the fixtures: plan → review in the browser → approve/flag → save → apply in dry-run → check the result.

## 10. Changes from rev 1

**Rev 3:** `ruleSpans` removed (Ali, hub #661): it needs changes inside T4/T12 lowering before the freeze, for a visual-only gain. The query view shows the Datadog query, the PromQL and the rule list with `explain` texts. Per-part highlighting can come back later as an optional field.

- **Commands:** `migrate --dry-run` + `import --approved` becomes `plan` / `review` / `apply` (plus `diff` and `parity`), with a config file and exit codes.
- **Review binding:** the review binds to the **plan hash** (all report and payload files), with `report_sha256` kept as a transition alias.
- **Review order (Henry):** exact-under items are excluded and `decision_required` is added.
- **Henry's other points:** a per-item `condition`, `group_id` matching, and `source_layout` confirmed for the map.
- **Reason codes (Ali):** the invariant is enforced, with no fallback; the 14 unresolved codes are listed for T17 and `plain` is added. Plus `explain` (technical + plain), `summary.gaps` and `summary.flow` for the visual views.
- **Links:** the `target.url` format is filled in from Ali's decoding (#543), with `target.dash0Uid` and `dash0.orgId` config; check-rule links stay `null`.
- **Drift checks:** for the source and the target.
