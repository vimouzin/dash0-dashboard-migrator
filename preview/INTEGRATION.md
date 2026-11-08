# Frontend and local backend

Start from the repository root:

```sh
uv run python -m backend.server --port 3001
```

Open <http://localhost:3001/>. Choose or drag Datadog JSON files into the drop zone,
pick a sample, or leave the selection empty for the pinned Postgres demo, then click
**Convert**. The real deterministic compiler runs synchronously and the page shows its
actual report. Download results to retain the generated artifacts. No account
credentials are needed.

Samples live in `preview/samples/` and go through the same upload as picked files:
`checkout_dashboard.json` (a fictional online shop checkout dashboard: request volume,
error rate, p95 latency, cart cache, orders database, host CPU) and
`checkout_error_rate_monitor.json` (alert when the checkout error rate is above 5%).
With the current mappings the converter returns 4 translated, 1 assumed, 1 best effort
and 2 blocked widgets; the monitor is blocked. Error rate, latency and the monitor use
Datadog APM trace metrics (`trace.http.request.*`), which have no reviewed mapping yet.

While the request runs, the run screen shows the dial and three steps (Read, Translate,
Check) with minimum durations, so a fast answer is still visible. Once the report
arrives its items are revealed on the dial in their real outcome colours and sort into
the columns. Nothing is streamed or simulated per item; the mock's step boxes, values
and publish button stay in `?mock=1`.

See [backend/README.md](../backend/README.md) for the API, limits and the complete
**frontend/backend mismatch list**: publishing, numeric comparison, progress,
dashboard visibility, AI, review state, target queries and configuration.

`backend.js` is the only HTTP adapter. `load(files)` POSTs file names and text to
`/api/convert` and maps the returned `report.items` to widget/monitor rows.
`MigrateBackend.result` retains `{report, manifest, exitCode, artifacts}` for download.
`process(item)` does nothing for real results; conversion is already finished.
Errors are shown on the start screen; there is no automatic mock fallback.

Blocked items in backend mode have an explicit **Ask AI** action: `/api/suggest`
calls Agent0 for a draft recommendation. The backend enforces three calls per local
server session, then prompts contact with sales at sandy@dash0.com. No automatic
AI requests, outcome changes or publishing. Set `DASH0_AUTH_TOKEN` in `.env` or the
environment to enable it; saved-report mode cannot request recommendations.

| Compiler outcome | UI column | Row category |
| --- | --- | --- |
| `translated` | Translated | Translated |
| `approximated` | Converted with remarks / Review | Approximated |
| `assumed` | Converted with remarks / Review | Assumed |
| `best_effort` | Converted with remarks / Review | Best effort |
| `partial` | Converted with remarks / Review | Partial (currently dashboard-only and hidden) |
| `blocked` | Blocked | Blocked |

Translated drawers show no warnings. Other drawers show warning/remark short names
without descriptions or examples; blocked errors retain their message/action.
Full diagnostics are preserved in the download.
Review is a visual grouping: compiler outcomes and manifest eligibility are
untouched. Dashboard rows/failures stay hidden per Felix; the full report is
preserved in the download. API acceptance and semantic verification are not run.

## Saved reports and mock design

`?report=reports/report.json` still reads a same-origin report, with the same category
labels and unavailable features flagged. It has no generated artifact bundle.

`?mock=1` is the explicit sample-data design demo. Its progress, publishing,
numeric values and AI interactions are simulated. They are never used for a real run.
To serve only saved reports or mock mode, `node preview/serve.mjs` still works;
the Python backend is required for the default conversion flow.
