# Integration guide

For engineers working on the Migration Review Console in the team's migrator fork (`console/`, draft PR #23) and wiring it to the real CLI.

## 1. What it is and the hard rules

A browser app for reviewing a Datadog-to-Dash0 migration. It reads the `report.json` the CLI writes, shows an overview, a dashboard map, an items list and a review queue, and exports the reviewer's decisions as `review.json`.

Hard rules. Do not break these:

- **Browser only.** No backend, no login.
- **No AI and no network calls.** The only fetch is the same-origin `/report.json` from the public folder.
- **No translation logic.** Translation must be deterministic and lives in the CLI. The app only displays and reviews.
- **Parsing only in `src/lib/report.ts`.** It is the only file that knows `report.json` field names. If the CLI renames a field, fix it there and nowhere else.
- **Every number shown is computed from the loaded file.** Never hard-code counts.
- **No confidence scores.**
- **`review.json` keeps `report_sha256` and the `approved` / `flagged` / `acknowledged` values unchanged.** The CLI depends on them.

## 2. Run and build

Needs Node 22+. Bun runs through npx, no global install needed (`bun.lock` is the lockfile).

```sh
cd console
npx bun install
npx bun run dev        # prints the address, usually http://localhost:8080 (Vite uses the next free port if it is taken)
npx bun run build
npx bun run test       # vitest
npx bun run lint
```

`npx bun run shots` takes 1920x1080 screenshots into `shots/` and checks for horizontal overflow at 1920 and 1440. It needs the dev server running; set `SHOTS_URL` if the URL differs. It also needs Playwright's Chromium (`npx playwright install chromium`).

## 3. Data contract

### 3.1 The real CLI report (what the console reads today)

The CLI (`migrate`, schema `dd2dash0.report/v1`) writes a `report.json` with the top-level keys `schema`, `run`, `summary`, `findings` and `items`. A real dry-run report on the Redis fixtures is kept at `src/test/fixtures/cli-report.redis.json`. The parser was run against it, and the mapping below is covered by tests in `src/test/cli-report.test.ts` (pass on this branch).

| What the CLI writes                                                                   | How the console reads it                                                                                                                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| item `kind`: `panel`, `alert`                                                         | widget, monitor. The CLI writes no `group` items.                                                                                                               |
| item `status`: `exact-under`, `bounded`, `manual`                                     | claims. They give console status `exact`, `approximate`, `unsupported`. `unsupported` stays a status. A separate `claim` field is also accepted; `status` wins. |
| `findings[].assumptions` (sentences)                                                  | the "Exact if ..." text for `exact-under`: the first sentence plus "(+N more assumptions)".                                                                     |
| `certificate.checks.parses`                                                           | `verification.promql_valid`, only when the item has PromQL (the CLI's value is true for an item with no PromQL).                                                |
| `certificate.checks.importedReadBack`                                                 | `verification.imported`; `null` means not tested.                                                                                                               |
| `target.dash0Id`, `target.action`                                                     | `dash0.asset_id`, `dash0.import_status`. There is no URL.                                                                                                       |
| `run.tool` and `run.version`; `run.inputHash`; `run.mappingFiles`; top-level `schema` | tool version; source hash; mapping version (files joined); schema version.                                                                                      |
| `summary.byKind.panel`, `summary.byKind.alert`                                        | widget and monitor counts, with the CLI's claim words folded into console statuses.                                                                             |
| `reason_codes`                                                                        | chips. Explanation text comes from `src/lib/reason-codes.ts`, which covers the 11 codes in the Redis fixture.                                                   |
| `layout`                                                                              | the widget's `{x, y, w, h}` box. In the Redis report the values are on a 24-column grid, relative to the widget's group.                                        |

**What the console cannot show yet**, because the CLI does not write it:

- **Group layouts.** The CLI writes no group items, so the map builds groups from each widget's `group` field, sizes each from its widgets' own boxes, and is labelled "Grouped overview".
- **`run.source`.** Shown as "not recorded". The commit is also "not recorded".
- **`summary.metrics`.** The "Map metrics" step on Overview shows "not run".
- **Reason-code explanations from the CLI.** Only the 11 codes the console already knows have text; any other code shows as itself with "No explanation supplied".
- **A Dash0 link.** `dash0.url` is empty, so no "Open in Dash0" link appears.
- **`verification.returns_data`.** Not written by the CLI, so no "No samples yet" marker.

**Planned, not built:** CONTRACT-003 (PR #28 of the fork, draft) proposes group items with layouts, `run.source`, `summary.metrics`, an explanation per reason code, a suggested review order, a link and verification fields after import, and a plan hash for `review.json`. Treat any of it as a proposal until it is merged and the console has been run against it.

### 3.2 Accepted input (the console's own schema)

This is the shape `src/lib/report.ts` accepts. The bundled sample uses it directly; the real CLI report is mapped onto it as in 3.1.

Top level. Only `items` is required; without an `items` array the file is rejected.

| Field                                                                                                                 | Used for                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `items` (required, array)                                                                                             | Everything below                                                                       |
| `schema_version`                                                                                                      | Shown only                                                                             |
| `run.tool_version`, `run.source`, `run.source_commit`, `run.source_sha256`, `run.mapping_version`, `run.rule_version` | Run info                                                                               |
| `SAMPLE`                                                                                                              | If present, the sample banner is shown (see section 4)                                 |
| `summary.widgets`, `summary.monitors`                                                                                 | Counts per status plus `total`; each missing number falls back to a count from `items` |
| `summary.metrics.mapped`, `.total`, `.no_equivalent`                                                                  | Metric coverage                                                                        |
| `summary.numerical.passed`, `.failed`                                                                                 | Numbers-check count                                                                    |
| `diagnostics` (array)                                                                                                 | Kept, passed through                                                                   |

Each entry in `items`:

| Field                                                                      | Required | Notes                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                       | **yes**  | String. Numbers are converted to strings. Decisions are keyed by it.                                                                                                                                             |
| `status`                                                                   | **yes**  | `exact`, `approximate`, `no_data`, `unsupported` or `failed`; the CLI's `exact-under`, `bounded` and `manual` are also accepted (see 3.1). May be omitted if `claim` is set.                                     |
| `kind`                                                                     | no       | `group`, `widget` or `monitor` (the CLI's `panel` and `alert` are also accepted). If missing it is inferred from the id: starts with `group` is a group, starts with `monitor` is a monitor, otherwise a widget. |
| `claim`                                                                    | no       | `exact`, `exact-under`, `bounded` or `manual`. Any other value is ignored.                                                                                                                                       |
| `condition`                                                                | no       | Text used with `exact-under`.                                                                                                                                                                                    |
| `title`, `widget_type`, `group`, `source_path`, `target_panel`, `notes`    | no       | Display text. `widget_type` of `note` is a text note; `list_stream` and `log_stream` are log panels.                                                                                                             |
| `layout`, `target_layout`                                                  | no       | `{x, y, w, h}`. Needs numeric `w` and `h`, otherwise treated as absent. `x` and `y` default to 0.                                                                                                                |
| `source_queries`, `source_formula`, `promql`, `reason_codes`               | no       | Array of strings. A single string is wrapped into an array. Missing means empty.                                                                                                                                 |
| `thresholds.degraded`, `thresholds.failed`                                 | no       | Numbers, for the check rule.                                                                                                                                                                                     |
| `verification.schema_valid`, `.promql_valid`, `.imported`, `.returns_data` | no       | Booleans. Anything else (including `null` and missing) is kept as `null`, which means "not tested". `returns_data: false` shows "No samples yet".                                                                |
| `verification.numeric_check`                                               | no       | Kept as is.                                                                                                                                                                                                      |
| `dash0.asset_id`, `dash0.url`, `dash0.import_status`                       | no       | Strings or `null`. A `dash0.url` shows an "Open in Dash0" link.                                                                                                                                                  |

An item with no `id`, or with neither `status` nor a usable `claim`, is skipped and a warning is recorded.

How `claim`, `condition` and unknown statuses are handled:

- If `status` is missing, it is derived from `claim`: `exact` and `exact-under` give `exact`; `bounded` gives `approximate`; `manual` gives `unsupported`. If both are present, `status` wins.
- `status: "exact"` with `claim: "exact-under"` is shown as "Exact if <condition>" (or "condition not supplied"). It stays `exact`, so it needs no review.
- An unrecognised `status` string is kept. It gets a neutral "unknown" look and is counted in `total` only, not in any status count. Add the name to `report.ts` and `src/lib/status.ts` to support it.
- Review eligibility follows `status`, not `claim`: groups and exact widgets are never reviewed; every monitor is.

### 3.3 review.json (output)

Exported from the Review page as `review.json`:

```json
{
  "schema_version": "1",
  "report_sha256": "<SHA-256 hex of the exact report.json text that was loaded>",
  "reviewer": "name typed by the reviewer",
  "decisions": [{ "id": "widget-4.1", "decision": "approved", "note": "" }]
}
```

- `report_sha256` is computed in the browser from the raw file text, byte for byte. The CLI must hash the same bytes (the file it wrote) and refuse a `review.json` that does not match. (CONTRACT-003 proposes a plan hash as well, keeping `report_sha256` accepted; not built.)
- Only valid decisions are written. Invalid ones are dropped: a decision not allowed for the item, or a check rule marked `approved` before all five checklist ticks.
- Allowed decisions: approximate widget gives `approved` or `flagged`; unsupported, no-equivalent and failed widgets give `acknowledged` only; check rule gives `approved` or `flagged`; groups and exact widgets get none.
- Decisions are also kept in the reviewer's localStorage under `mrc-review:<sha>`, so they never carry across reports.

What each decision means for import (the console's decision table; the CLI side that reads it is not built yet):

| Item                                        | Decision          | Import does                                   |
| ------------------------------------------- | ----------------- | --------------------------------------------- |
| Exact widget                                | none needed       | Imports the translated panel                  |
| Approximate widget                          | `approved`        | Imports the translated panel                  |
| Approximate widget                          | `flagged`         | Imports a placeholder panel with the note     |
| Approximate widget                          | no decision       | Not decided; the console counts it as pending |
| Unsupported, no-equivalent or failed widget | `acknowledged`    | Always a placeholder panel                    |
| Check rule                                  | `approved`        | Imports the check rule                        |
| Check rule                                  | `flagged` or none | Does not import the check rule                |

## 4. How a report reaches the console

On start the app fetches `/report.json`, which is `public/report.json`. If the file exists and parses, it is loaded as real data and the sample banner is hidden. If it is missing or invalid, the bundled sample (`src/data/report.sample.json`) is shown with a banner. The sample is a prediction written by hand, not tool output. The **Load report.json** button in the sidebar loads a file from disk instead.

To produce a real report, see "How to get a real report.json" in `README.md`. A real example is `src/test/fixtures/cli-report.redis.json`.

The banner also shows if the file itself contains a top-level `SAMPLE` key, so the CLI must not write one.

## 5. Where it lives in the fork

`console/` is a self-contained package (its own `package.json`, `bun.lock`, lint, test and TypeScript config) in draft PR #23. It was copied from the sandbox repo `henryxli-spec/mapwise-report-review` at commit `f395907`; changes now happen in the fork. `src/routeTree.gen.ts` is generated by TanStack Router; do not edit it by hand. The files in `src/lib/` for error reporting come from the original sandbox project and do nothing here; they can stay.

**Blocker for merging:** the fork's root test run (`npx vitest run` at the repo root) has no config and picks up `console/src/test/*`, which fail there. On this branch, 5 console test files fail at the root and 20 root files pass. The root test config needs an exclude for `console/**` (planned in merge train 2). The root `tsconfig.json` includes only `src/**/*.ts`, so type-checking is not affected.

One-command smoke test:

```sh
cd console && npx bun install --frozen-lockfile && npx bun run test && npx bun run build
```

## 6. Tasks for the team board

All seven are on the board. U1 is Henry's, U2 is Michael's; Michael has said he takes U2 to U7 after the merge. Everything in the CLI rows is planned, not built.

| ID  | Owner role                    | Task                                                                                                                                        | Files                                                                                            | Acceptance check                                                                                                                                    |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Fork maintainer               | Copy the app into `console/` and open a PR.                                                                                                 | `console/**`, root test exclude                                                                  | The smoke test passes in `console/`. Root tests and tsc do not touch `console/`.                                                                    |
| U2  | CLI engineer                  | Get the CLI's report to the console. CONTRACT-003 (PR #28, draft) proposes serving the console with the run's report instead of copying it. | CLI report writer and serve command                                                              | The console loads the CLI's report with no sample banner. The warnings list is empty.                                                               |
| U3  | CLI engineer                  | CLI reads `review.json` with `--approved` and checks `report_sha256`.                                                                       | CLI import command                                                                               | A `review.json` from a different `report.json` is refused with a clear error. A matching one imports per the table in section 3.3.                  |
| U4  | Console engineer              | Map the new report fields (after CONTRACT-003 is agreed). Change `src/lib/report.ts` only.                                                  | `src/lib/report.ts`, `src/test/report.test.ts`, `src/test/cli-report.test.ts`                    | Counts on Overview match the CLI's own summary. The real-report fixture still parses. No other file changed for a rename.                           |
| U5  | CLI engineer                  | After import, fill `dash0.url` and the `verification` fields, then re-write `report.json`.                                                  | CLI import step                                                                                  | Items show "Open in Dash0" and verified chips. The new file has a new hash, so old decisions do not carry over.                                     |
| U6  | Front-end engineer            | Projector polish on real data.                                                                                                              | `src/styles.css`, `src/components/map/DashboardMap.tsx`, `src/components/detail/DetailPanel.tsx` | `npx bun run shots` reports no overflow at 1920x1080 and 1440x900. Approve, Flag and Acknowledge are visible on the map without scrolling the page. |
| U7  | Front-end engineer (optional) | Evidence tab for the numbers check.                                                                                                         | `src/lib/report.ts` (read `numeric_check`), a new component under `src/components/`              | Each item with a `numeric_check` shows its result. Counts come from the file.                                                                       |

What each person decides: Michael owns the console code after the merge. Henry decides what the screens say to the demo (wording, labels, Overview and the map). Please check with Henry before changing what a screen says.

## 7. Known gaps

- **The sample data is predicted.** `src/data/report.sample.json` was written by hand to match the expected CLI output. Its numbers are not results.
- **Commands are provisional.** The `--approved` flag and the import command in U3 are the planned shape, not final, and are not built.
- **Status names are mapped in `report.ts`.** The CLI writes `exact-under`, `bounded` and `manual` in `status`; they are mapped to `exact`, `approximate` and `unsupported` there. If the CLI uses different names, change the mapping there.
- **Bad `/report.json` falls back silently.** If the file exists but does not parse, the app shows the sample with its banner and no error. Check the banner.
- **Dev port.** Vite uses 8080 and moves to the next free port if it is taken; use the address it prints.
- **Not shown yet:** see the list in section 3.1.
- **Not tested:** installing with plain `npm` instead of Bun, and the screenshots script on a machine without Playwright's Chromium.
