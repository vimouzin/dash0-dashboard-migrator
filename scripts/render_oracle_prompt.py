"""Render the fixed Agent0 oracle prompt for one dashboard (development-time only).

Usage: uv run scripts/render_oracle_prompt.py <service>/<dashboard_id> [dataset]
Writes fixtures/oracle/agent0/<service>/<dashboard_id>/prompt.md and prints it.
Deterministic: same case inventory -> same prompt text.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "fixtures" / "otel" / "catalog.yaml"
DATASET_SNAPSHOT = ROOT / "fixtures" / "oracle" / "dash0_default_metrics.yaml"

# Datadog metric prefix (first name segment in the dashboard's queries) -> OTel catalog prefixes
# whose metrics go into the prompt's candidate list. A reviewed, static table: no fuzzy matching.
# `data_streams` (Datadog Data Streams Monitoring) has no OTel counterpart.
OTEL_PREFIXES = {
    "docker": ["container."],
    "jvm": ["jvm."],
    "kafka": ["kafka.", "messaging."],
    "nginx": ["nginx."],
    "postgresql": ["postgresql."],
    "redis": ["redis."],
    "system": ["system."],
    "zookeeper": ["zookeeper."],
}
DATADOG_PREFIX = re.compile(r"(?:^|[:(,\s])([a-z_]+)\.[A-Za-z0-9_.]+\{")


def candidate_lines(case: dict) -> list[str]:
    """Catalog metrics for the Datadog prefixes used in the case, one line each, sorted by name."""
    used = sorted({m for r in case["requests"] for q in r["queries"] for m in DATADOG_PREFIX.findall(q["query"] or "")})
    prefixes = tuple(p for d in used for p in OTEL_PREFIXES.get(d, []))
    if not prefixes:
        return ["(none)"]
    catalog = yaml.safe_load(CATALOG.read_text())
    present = set(yaml.safe_load(DATASET_SNAPSHOT.read_text())["metrics"])
    lines = []
    for name, m in catalog.items():
        if not name.startswith(prefixes):
            continue
        kind = m["type"] if m["type"] != "sum" else ("monotonic sum" if m["monotonic"] else "non-monotonic sum")
        attrs = ", ".join(m["attributes"]) or "none"
        where = "in dataset" if name in present else "not in dataset"
        deprecated = ", deprecated" if m.get("deprecated") else ""
        lines.append(f"- {name} ({kind}, unit {m['unit'] or '-'}{deprecated}; attributes: {attrs}; {where}; {m['sources'][0]})")
    return lines or ["(none)"]


def render(case_key: str, dataset: str = "default") -> str:
    case = yaml.safe_load((ROOT / "fixtures" / "cases" / f"{case_key}.yaml").read_text())
    template = (ROOT / "fixtures" / "oracle" / "PROMPT.md").read_text()
    body = template.split("\n---\n", 1)[1].strip() + "\n"
    def flow(r: dict) -> str:
        item = {
            "source_path": r["source_path"],
            "widget": f"{r['widget_type']}: {r['widget_title']}",
            "queries": {q["name"] or "q": q["query"] for q in r["queries"]},
            "formulas": r["formulas"],
        }
        return "- " + yaml.safe_dump(item, default_flow_style=True, sort_keys=False, allow_unicode=True, width=100000).strip()

    requests = "\n".join(flow(r) for r in case["requests"])
    values = {
        "{dataset}": dataset,
        "{title}": case["title"],
        "{fixture}": case["source"]["file"],
        "{template_variables}": ", ".join(
            f"${v['name']} (tag `{v['prefix']}`, default `{v['default']}`)" if v["prefix"] else f"${v['name']} (default `{v['default']}`)"
            for v in case["template_variables"]
        )
        or "none",
        "{requests_flow}": requests,
        "{otel_candidates}": "\n".join(candidate_lines(case)),
    }
    for key, value in values.items():
        body = body.replace(key, value)
    return body


def main() -> int:
    case_key = sys.argv[1]
    dataset = sys.argv[2] if len(sys.argv) > 2 else "default"
    text = render(case_key, dataset)
    out = ROOT / "fixtures" / "oracle" / "agent0" / case_key / "prompt.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
