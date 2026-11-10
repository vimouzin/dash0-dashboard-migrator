## Lovable

A Lovable project exists as Henry's personal sandbox only. It is not part of the team's workflow and nothing in this fork syncs with it. Work on a branch in the fork and open a PR. Do not edit anything here through Lovable.

## Project rules

- All report.json field names and parsing live only in `src/lib/report.ts`; the CLI may rename fields, so this keeps renames to one file.
- The app is browser-only: no backend, no network calls, no AI, no translation logic (hackathon rule: translation must be deterministic in the CLI).
- Review decisions are stored in localStorage keyed by the SHA-256 of the loaded report text, so decisions never carry across reports.
- The map packs groups in file order into 12-column bands (Datadog group `y` values restart); widgets keep their relative grid inside the group.
- Items and Review share the same detail drawer and decision controls so edits remain consistent with the map.
- Derive widget categories and optional claim fidelity in report.ts so report field changes remain centralized.
- Review queue ordering lives in a browser-safe helper and exports validate decision eligibility and check-rule ticks to prevent invalid sign-off.
- Display-only type tags and short reason labels live in `src/lib/presentation.ts`; parsing remains centralized and independent of styling.
- Bulk acknowledgement eligibility lives with review queue helpers and only permits nonempty unsupported/no-equivalent widget groups; every decision still passes the shared store validation.
- Map presentation collapses redundant source row boundaries and halves note tiles while retaining file-order bands and relative horizontal positions, so the projector view fits without changing parsed geometry.
- Shared detail supports stacked map and three-column drawer layouts; query text breaks only at explicit whitespace/operator opportunities to preserve metric names.

## Handover rules

- Browser-only. No AI calls and no network calls (the only fetch is the same-origin `/report.json` from the public folder).
- All report parsing and `report.json` field names live only in `src/lib/report.ts`.
- Every number shown is computed from the loaded file; never hard-code counts.
- Never show confidence scores.
- `review.json` keeps `report_sha256` and the `approved` / `flagged` / `acknowledged` decision values unchanged.
- Package manager is Bun (`bun.lock`). Work on a branch, not `main`.

## Real report contract

These are the CLI's actual field names (`dd2dash0.report/v1`, checked against a real `--dry-run` report kept as `src/test/fixtures/cli-report.redis.json`). `src/lib/report.ts` is the only file that maps them; change a name there and nowhere else.

- **Item kind:** `panel` becomes widget and `alert` becomes monitor. The CLI writes no group items, so the map builds groups from each widget's `group` field.
- **Claims in `status`:** `exact-under`, `bounded` and `manual` appear in `status` and are claims. They give console status exact, approximate and unsupported. `exact` and `unsupported` stay statuses. A separate `claim` field is also accepted; `status` wins.
- **Condition text:** for `exact-under`, taken from the item's `findings[].assumptions` sentences (the first one plus a count).
- **`certificate.checks`:** `parses` becomes `verification.promql_valid` (only when the item has PromQL); `importedReadBack` becomes `verification.imported` (`null` means not tested).
- **`target`:** `dash0Id` becomes `dash0.asset_id` and `action` becomes `dash0.import_status`. There is no URL until a real import.
- **`run`:** `tool` and `version` give the tool version; `inputHash` is the source hash; `mappingFiles` (joined) is the mapping version. The top-level `schema` is the schema version. The CLI records no `run.source` or commit, so the console shows "not recorded".
- **`summary`:** `summary.byKind.panel` gives widget counts and `summary.byKind.alert` gives monitor counts, with the claim words folded into console statuses.
- **Reason codes:** `reason_codes` use the CLI's dotted names (for example `metric.approximate`). Explanations and chip labels live in `src/lib/reason-codes.ts` and `src/lib/presentation.ts`; an unknown code shows as itself.

Never hard-code counts. Every number shown is computed from the loaded file, including the metric widget, text note and log panel counts.
