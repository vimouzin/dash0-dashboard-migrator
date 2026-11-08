# Usage: testing and improvement loop

- `uv run migrator check` runs ruff, mypy and pytest. Oracle cases (`fixtures/expected/**/expected.yaml`) run only once a human set `reviewed: true`; `uv run pytest --include-unreviewed` runs all of them.
- Oracle cases load every `mappings/datadog/*.json` as one table (`mapping: mappings/datadog` in `expected.yaml`), like `uv run migrator convert` (which defaults to `--mapping mappings/datadog`). `--mapping` also takes single files and repeats.
- After a run with request cases, `out/test-report/index.html` (path printed at the end) compares expected and actual PromQL, outcome and codes per request, failures first.
- A failing case means the converter or the expectation is wrong: fix `src/migrator`, or correct the expectation in `fixtures/expected/<svc>/<id>/overrides.yaml` and rerun `uv run scripts/build_expected.py <svc>/<id>`.
- Refresh source cases: `scripts/pin-integrations-core.sh`, then `uv run scripts/extract_cases.py` (dashboards listed in `fixtures/oracle/dashboards.json`).
- New Agent0 proposals (development time only, needs `DASH0_AUTH_TOKEN`): `uv run scripts/run_oracle.py [--full | --case <svc>/<id>]`; it writes `fixtures/oracle/agent0/<svc>/<id>/answer.yaml` and rebuilds `expected.yaml`.
- View converter output locally: [scripts/review/README.md](scripts/review/README.md).
