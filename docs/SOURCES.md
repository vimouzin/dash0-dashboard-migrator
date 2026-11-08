# Challenge and technical references

Reviewed during handoff preparation on 2026-11-07. API payloads and schema versions must be confirmed during implementation; no live API requests were made in this task.

## Explicit user requirement: first priority

The user requires deterministic conversion before every other objective and prohibits **all LLM involvement in translation from a source to Perses**. Apply the same deterministic-only rule to query and alert conversion. This is stricter than merely prohibiting a simple LLM wrapper: hybrid conversion, optional model-based inference, repair, and fallback paths are also prohibited. Codex and Claude can assist implementation, but cannot act as translators in the migration workflow.

## User-provided challenge

Source: the supplied “Dash0 HACKATHON CHALLENGE — Breaking Observability Vendor Lock-In” pasted document. This handoff captures its engineering requirements; the original supplied brief remains the authority for challenge/submission details.

Required outcome:

- Ingest a Datadog dashboard and alert through APIs or exports; the proposed project workflow also calls for a source API connection.
- Use deterministic parsing, translation rules, schema mappings, and explicit validation. A simple LLM rewriting wrapper is disqualified.
- Target Perses dashboards, PromQL queries, and Dash0 check rules based on Prometheus alert concepts/extensions.
- Identify unsupported functionality and preserve original configurations for reference.
- Demonstrate the resulting dashboard and alert within Dash0. Prioritize Datadog before any additional vendor.
- Provide a migration summary with successes, warnings, and manual intervention items.

Challenge submission workflow:

1. Fork [vimouzin/dash0-dashboard-migrator](https://github.com/vimouzin/dash0-dashboard-migrator).
2. Clone the fork and work on a dedicated feature branch.
3. Push the branch to the fork and open a PR against the original repository's `main` branch.
4. Include implementation summary, features, setup/usage, and known limitations.

The starter showed only a README when reviewed. The local remote differs; no fork relationship was verified by this task.

Challenge account setup: use the EU region for both vendors and a Dash0 organization name starting with `thinc`. Account/trial details in the brief should be checked in the actual signup flow. Use a single team organization and invite teammates as needed; no invitations were sent during initialization.

## Official technical references

| Reference | Use |
| --- | --- |
| [Dash0 API overview](https://www.dash0.com/docs/api-reference) | Actual organization API endpoint, bearer authentication, dataset selection, and OpenAPI download |
| [Dash0 dashboard import](https://www.dash0.com/docs/api-reference/operations/post/api/import/dashboard) | `POST /api/import/dashboard`; Perses-compatible body and import behavior |
| [Dash0 check-rule import](https://www.dash0.com/docs/api-reference/operations/post/api/import/check-rule) | `POST /api/import/check-rule`; check-rule fields and threshold extension |
| [Perses dashboard specification](https://perses.dev/docs/perses/latest/api/dashboard/) | Panels, queries, datasource references, and layouts; confirm Dash0 plugin compatibility separately |
| [Datadog dashboard read API](https://docs.datadoghq.com/api/latest/dashboards/get-a-dashboard/) | Selected dashboard retrieval and source JSON shape |
| [Datadog monitor API](https://docs.datadoghq.com/api/latest/monitors/) | Selected metric monitor retrieval and options |
| [Datadog API/application keys](https://docs.datadoghq.com/account_management/api-app-keys/) | Read access uses the appropriate API/application key pair; an ingestion API key alone is insufficient |
| [Prometheus alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) | Condition expressions, pending duration, labels, and annotations |
| [Prometheus query functions](https://prometheus.io/docs/prometheus/latest/querying/functions/) | Target range functions and metric type semantics |
| [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/) | Reference to consult for any proposed standard metric/attribute mapping; no automatic universal mapping is assumed |
| [Datadog integrations-core](https://github.com/DataDog/integrations-core) | Official dashboard/monitor asset examples suggested by the challenge; defer broad integration coverage |

Use primary documentation and actual sanitized exports for payload contracts. Record the schema/version or retrieval date used by the implementation. The generic Perses specification does not establish that every plugin/version is supported by Dash0.

The check-rule import page's prose mentions a nested ID location while its request schema exposes a top-level `id`. Resolve that discrepancy against the current schema and an actual request during phase 0; start create-only with IDs omitted. Do not copy dashboard ID handling into the check-rule emitter.
