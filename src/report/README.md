# report

Task **T8** · scope `src/report/**` (with `src/cli.ts` and `src/pipeline/**`).

`report.json` uses schema `dd2dash0.report/v1`. It follows Henry's proposal (dash0-team `docs/report-schema-proposal.md`) for the flat item fields the review console reads, with CONTRACT-001 findings `{status, code, message, itemKind, itemId, ...}`.
- **One item per widget and per monitor:** `id, kind, title, widget_type, dashboard, group, layout (24-col), source, source_queries, source_formula, promql[], status, reason_codes, certificate, findings, thresholds?, manual_actions?, target`.
- **Status** is `exact | exact-under | bounded | manual`, plus `unsupported` for placeholder panels of widget types Dash0 has no panel for.
- **Certificate:** `sourceHash`, `outputHash`, `rules`, `assumptions`, `epsilon?`, `checks.parses` (lezer-promql), and `checks.importedReadBack` (null when not imported).
- **Summary:**
  - counts by kind and status;
  - `coverageExact` and `coverageTranslated` over query panels (notes excluded), floored and never rounded up;
  - findings by code;
  - the import summary.
- **Deterministic:** no timestamps. `run.outputHash` = sha256 over the items, so the same input gives the same bytes.

`report.md` renders the same data for people (and the PR). The terminal summary is printed by the CLI.
