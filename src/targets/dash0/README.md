# targets/dash0

Task **T7** · scope `src/targets/dash0/**` · Dash0 client. `schema.ts` is HOT (T5 and T6 build these shapes).

| File | What |
|---|---|
| `schema.ts` | `PrometheusAlertRule`, `CheckThresholds`, `DashboardDefinition`, `PersesPanel`, `GridLayout`, from Dash0's OpenAPI spec and the dash0-cli fixtures |
| `preflight.ts` | Pure checks before sending: `$__threshold` needs thresholds, duration format, id format, every layout `$ref` resolves, the 24-column grid, no unplaced panels, `kind: "Dashboard"` (never the CR form), the 256 KB body limit. `dash0Id(sourceId)` gives `dd-<slug>` |
| `client.ts` | `Dash0Client`: `POST /api/import/check-rule` (Import Check Rule, upsert by UUID `id`), `PUT /api/dashboards/{origin}` (upsert by origin), and `GET` by the same keys. Bearer auth, `?dataset=`, retries 429/502/503/504 (honours `Retry-After`), `Dash0ApiError` with `traceId`. The token never appears in errors |
| `target.ts` | `importAll({dashboards, rules}, {dryRun, outDir, enableRules, config})`: preflight, then dry-run or upsert, then read back and compare (durations normalised, since Dash0 returns `1m0s`). Writes canonical payloads (dry run) and `import-manifest.json` with a sha256 per payload |

Decisions applied:
- One item per request. The bulk check-rules call rejects the whole batch on one bad item (D-31).
- **Idempotent re-runs** (probed live on Dash0 2026-11-07, dash0-team `docs/research/dash0.md`). This settles D-32.
  - **Check rules** use the Import Check Rule API the brief names. It upserts by `id` when the id is a **UUID**; T6 sets a deterministic UUIDv5 of the Datadog monitor id. A non-UUID id is rejected (400), so preflight requires a UUID.
  - **Dashboards** use `PUT /api/dashboards/{origin}`, with origin = `metadata.dash0Extensions.id` = `dd-<datadog dashboard id>` (T5). The Import Dashboard API ignores an origin, so it can't stay idempotent.
- `missing` on read-back means the write succeeded but the GET by id/origin found nothing.
- Check rules are imported **disabled** unless `enableRules` (D-30).

Smoke test (one dashboard plus the high-memory rule; the 18:00 gate):
```
npx tsx --env-file=.env scripts/dash0-smoke.ts            # dry run into out/smoke/
npx tsx --env-file=.env scripts/dash0-smoke.ts --live     # import + read back
```
