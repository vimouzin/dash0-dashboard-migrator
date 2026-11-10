# sources/datadog

Task **T2** · scope `src/sources/datadog/**` · Datadog → IR (CONTRACT-001/002).

`ingestDatadog({input} | {api: true}, only?)` returns `IngestResult {dashboards, alerts, findings}`.

| File | What |
|---|---|
| `normalize.ts` | Pure. `dashboardFromDatadog` and `alertFromDatadog`, one per JSON document |
| `ingest.ts` | I/O. `ingestFolder(dir)` reads `.json`, `.yaml` and `.yml` exports at any depth in sorted order. YAML is parsed with the YAML 1.2 core schema; a duplicate key or several documents in one file is a `source.unreadable` finding. `ingestApi()` calls `GET /api/v1/dashboard`, `/api/v1/dashboard/{id}` and `/api/v1/monitor` (paged) on `api.<DD_SITE>`, default `datadoghq.eu`, with `DD-API-KEY` and `DD-APPLICATION-KEY` |

Normalisation:
- **Widget → panel kind:**
  - timeseries → `timeseries`; query_value → `stat`; toplist → `toplist`; query_table → `table`; note and free_text → `markdown`;
  - log_stream, and list_stream over logs → `logs`;
  - everything else → `unsupported` with a `widget.unsupported` finding. The widget is kept, so T5 renders a placeholder.
- **Requests:**
  - the new `queries` + `formulas` format, keeping `name`, `data_source` and `aggregator`;
  - legacy `{q}` becomes one query `q0` with no formulas;
  - hostmap's object-shaped `requests`;
  - list_stream's nested `query`;
  - log_stream's widget-level `query`.
- **Groups:** become `Group` with their panels. Layout stays in Datadog units (12 columns), and T5 rescales it.
- **Template variables:** `prefix` → `tagKey`. `$scope` (`prefix: null`) → `tagKey: null`.
- **Monitors:**
  - the integrations-core `{version, definition}` wrapper is unwrapped;
  - `thresholds.{critical, warning, critical_recovery, warning_recovery}` are mapped;
  - numbers stored as strings (`"renotify_interval": "0"`) are coerced;
  - every other option stays in `options` for T6 to map or report.
- **Ids:** an API export's `id` wins; otherwise the file name is the id.
- **Bad files:** unparseable or unrecognised files become `source.unreadable` findings, and the run continues.
