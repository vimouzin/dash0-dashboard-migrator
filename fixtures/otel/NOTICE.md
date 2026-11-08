# Pinned OpenTelemetry metric definitions

Byte copies of upstream files, used only at development time to decide whether an OTel metric exists
at all (`scripts/build_otel_catalog.py` → `catalog.yaml`, read by `scripts/build_expected.py` and
`scripts/render_oracle_prompt.py`). Never read by the converter. Fetched 2026-11-07 via the GitHub API.

| Directory | Repository | Tag | Commit | License | Files |
|---|---|---|---|---|---|
| `collector-contrib/` | https://github.com/open-telemetry/opentelemetry-collector-contrib | v0.165.0 | f56f9a38c9864e892af542f1dbd28f475d6779dc | Apache-2.0 (`collector-contrib/LICENSE`) | every `receiver/**/metadata.yaml` and `scraper/**/metadata.yaml` outside `testdata/` (128 files; all receivers since #175) |
| `semantic-conventions/` | https://github.com/open-telemetry/semantic-conventions | v1.45.0 | fb30ca17193b551473b1f43c315482918ab6987c | Apache-2.0 (`semantic-conventions/LICENSE`) | `model/**/*metrics.yaml` (all 41) |
| `java-contrib/` | https://github.com/open-telemetry/opentelemetry-java-contrib | v1.62.1 | 1ae854568c0f76e658354c2cf7b18a097e998ed8 | Apache-2.0 (`java-contrib/LICENSE`) | `jmx-scraper/src/main/resources/{kafka,kafka-consumer,kafka-producer}.yaml` |

Note: in collector-contrib v0.165.0 the ZooKeeper metrics live in `scraper/zookeeperscraper/`; the
receiver's own `metadata.yaml` defines none.

To update: fetch the same paths at a new tag, update this table, run `uv run scripts/build_otel_catalog.py`,
then rebuild the expectations.
