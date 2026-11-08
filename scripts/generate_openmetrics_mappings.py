"""Generate draft mapping entries for Datadog OpenMetrics checks (#185).

Development-time only; deterministic and LLM-free. Every entry is `reviewed: null` and uses
the `assumed` tag PROMLABEL (remarks.py): the target is the Prometheus series as the OTel
Prometheus receiver stores it in Dash0 (raw sample name, labels as scraped; checked live,
#185), and Datadog tags are the series' Prometheus labels.

Inputs (pinned in the repo, integrations-core a9b9e42):
  fixtures/datadog/integrations-core/<integration>/checks/*.py   check.py, metrics.py
  fixtures/datadog/integrations-core/<integration>/metadata.csv  Datadog names and types
  fixtures/datadog/integrations-core/openmetrics-series.json     sample names, # TYPE and
      label names from the checks' test exposition (scripts/pin_openmetrics_series.py)

The Python files are parsed with `ast`, never imported or executed. A metric map pair is
`'<prometheus name>': '<datadog suffix>'` or `{'name': '<datadog suffix>'}` in any dict
literal; pairs with a custom `type` transformer are ignored. A Datadog name in the
integration's metadata.csv resolves when it is exactly `<namespace>.<suffix>` or
`<namespace>.<suffix>.count`, and `<namespace>` is a string literal in the same check files.

Rules; anything else is skipped and keeps blocking:
- the Datadog name resolves to exactly one target across all matching pairs and integrations
- gauge, no `.count` suffix, not per second -> gauge on the sample `<name>`, which the
  exposition types gauge or untyped
- count/rate, or `<suffix>.count` of type count without `.sum`/`.bucket`/`.quantile`
  siblings (a histogram or summary) -> rate, type sum, on whichever one of `<name>_total`
  and `<name>` the exposition has as a counter sample
- the check's `rename_labels` dicts agree
- the name is not already mapped or listed as a gap in another mapping file
Labels: each label of the exposed sample, under its Datadog tag name (rename_labels applied),
and `host -> instance` (the scrape target; these series have no host_name) unless the
sample has its own `host` label.

Usage:
  uv run scripts/generate_openmetrics_mappings.py          # write mappings/datadog/openmetrics.json
  uv run scripts/generate_openmetrics_mappings.py --check  # exit 1 if the file is stale
"""

from __future__ import annotations

import argparse
import ast
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures" / "datadog" / "integrations-core"
SERIES = FIXTURES / "openmetrics-series.json"
MAPPINGS = ROOT / "mappings" / "datadog"
OUT = MAPPINGS / "openmetrics.json"
SHA = "a9b9e42"
_PROM = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$")
_DOTTED = re.compile(r"^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$")
_LABEL = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_SIBLINGS = (".sum", ".bucket", ".quantile")

Series = dict[str, dict[str, list[str]]]  # sample name -> {"types": [...], "labels": [...]}


def _str(node: ast.AST | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _str_dict(node: ast.AST) -> dict[str, ast.AST] | None:
    if not isinstance(node, ast.Dict) or None in node.keys:
        return None
    keys = [_str(k) for k in node.keys]
    if any(k is None for k in keys):
        return None
    return dict(zip(keys, node.values, strict=True))  # type: ignore[arg-type]


def parse_check(sources: list[str]) -> tuple[set[tuple[str, str]], set[str], list[dict[str, str]]]:
    """(metric map pairs, string literals, rename_labels dicts) of one integration's files."""
    pairs: set[tuple[str, str]] = set()
    literals: set[str] = set()
    renames: list[dict[str, str]] = []
    nested: set[int] = set()  # {'name': ...} values: parsed with their parent dict
    for source in sources:
        for node in ast.walk(ast.parse(source)):
            if (text := _str(node)) is not None:
                literals.add(text)
            if isinstance(node, ast.keyword) and node.arg == "rename_labels":
                if (r := _str_dict(node.value)) is not None:
                    renames.append({k: _str(v) or "" for k, v in r.items()})
            d = _str_dict(node)
            if d is None or id(node) in nested:
                continue
            if "rename_labels" in d and (r := _str_dict(d["rename_labels"])) is not None:
                renames.append({k: _str(v) or "" for k, v in r.items()})
            for key, value in d.items():
                inner = _str_dict(value)
                if inner is not None:
                    nested.add(id(value))
                if inner is None:
                    name = _str(value)
                else:
                    name = _str(inner["name"]) if set(inner) == {"name"} else None
                if name and _PROM.fullmatch(key) and _DOTTED.fullmatch(name):
                    pairs.add((key, name))
    return pairs, literals, renames


def _sample(series: Series, names: tuple[str, ...], types: set[str]) -> tuple[str, str | None]:
    """The single sample among `names` whose exposed types are all in `types`."""
    hits = [n for n in names if n in series and set(series[n]["types"]) <= types]
    if len(hits) == 1:
        return "", hits[0]
    if hits:
        return "both " + " and ".join(hits) + " exposed", None
    seen = [f"{n} ({'/'.join(series[n]['types']) or 'untyped'})" for n in names if n in series]
    return ("exposed as " + ", ".join(seen)) if seen else "not in the test exposition", None


def resolve(
    name: str,
    row: dict[str, str],
    names: set[str],
    pairs: set[tuple[str, str]],
    literals: set[str],
    series: Series,
) -> tuple[str, tuple[str, str] | None]:
    """Reason and (kind, Prometheus sample) for one Datadog name of the integration."""
    targets: set[tuple[str, str]] = set()
    reasons: set[str] = set()
    for prom, suffix in pairs:
        for tail, counted in ((f".{suffix}", False), (f".{suffix}.count", True)):
            if not name.endswith(tail) or name[: -len(tail)] not in literals:
                continue
            mtype, per = row["metric_type"], row.get("per_unit_name", "")
            kind = None
            if counted:
                base = name[: -len(".count")]
                if mtype != "count":
                    reasons.add(f".count of Datadog type {mtype}")
                elif any(base + s in names for s in _SIBLINGS):
                    reasons.add("histogram or summary count")
                else:
                    kind = "rate"
            elif mtype in ("count", "rate"):
                kind = "rate"
            elif mtype == "gauge" and per == "second":
                reasons.add("per-second gauge")
            elif mtype == "gauge":
                kind = "gauge"
            else:
                reasons.add(f"Datadog type {mtype or '-'}")
            if kind == "rate":
                total = prom if prom.endswith("_total") else prom + "_total"
                why, sample = _sample(series, tuple(dict.fromkeys((total, prom))), {"counter"})
            elif kind == "gauge":
                why, sample = _sample(series, (prom,), {"gauge", "untyped", ""})
            else:
                continue
            if sample is None:
                reasons.add(why)
            else:
                targets.add((kind, sample))
    if len(targets) == 1:
        return "", next(iter(targets))
    if len(targets) > 1:
        return f"{len(targets)} distinct Prometheus targets", None
    return "; ".join(sorted(reasons)) or "no metric map pair", None


def _renames(renames: list[dict[str, str]]) -> dict[str, str] | None:
    """Prometheus label -> Datadog tag, or None if the check's rename_labels disagree."""
    merged: dict[str, str] = {}
    for rename in renames:
        for prom, tag in rename.items():
            if merged.get(prom, tag) != tag or not tag:
                return None
            merged[prom] = tag
    if len(set(merged.values())) != len(merged):
        return None
    return merged


def _labels(prom_labels: list[str], renames: dict[str, str]) -> dict[str, str] | None:
    labels: dict[str, str] = {}
    for label in prom_labels:
        tag = renames.get(label, label)
        if tag in labels or not _LABEL.fullmatch(label):
            return None
        labels[tag] = label
    labels.setdefault("host", "instance")
    return labels


def build(
    integrations: dict[str, tuple[list[str], list[dict[str, str]]]],
    series: dict[str, Series],
    taken: set[str],
) -> tuple[dict[str, Any], dict[str, str]]:
    """Mapping file body and, per skipped Datadog name, the reason.

    `integrations`: name -> (check file sources, metadata.csv rows); `series`: name ->
    exposed samples (openmetrics-series.json)."""
    found: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    skipped: dict[str, str] = {}
    for integ in sorted(integrations):
        sources, rows = integrations[integ]
        pairs, literals, rename_dicts = parse_check(sources)
        renames = _renames(rename_dicts)
        exposed = series.get(integ, {})
        names = {r["metric_name"] for r in rows}
        for row in rows:
            name = row["metric_name"]
            reason, target = resolve(name, row, names, pairs, literals, exposed)
            if target is None:
                skipped.setdefault(name, f"{integ}: {reason}")
                continue
            if renames is None:
                skipped.setdefault(name, f"{integ}: conflicting rename_labels")
                continue
            labels = _labels(exposed[target[1]]["labels"], renames)
            if labels is None:
                skipped.setdefault(name, f"{integ}: two labels share one Datadog tag")
                continue
            found[name].append((integ, _entry(integ, row, target, labels, renames)))
    metrics: dict[str, Any] = {}
    for name in sorted(found):
        entries = {json.dumps(e[1], sort_keys=True) for e in found[name]}
        if name in taken:
            skipped[name] = "already in a mapping file"
        elif len(entries) > 1:
            skipped[name] = "integrations disagree: " + ", ".join(i for i, _ in found[name])
        else:
            metrics[name] = found[name][0][1]
            skipped.pop(name, None)
    return {"version": 1, "source": "datadog", "metrics": metrics}, dict(sorted(skipped.items()))


def _entry(
    integ: str,
    row: dict[str, str],
    target: tuple[str, str],
    labels: dict[str, str],
    renames: dict[str, str],
) -> dict[str, Any]:
    kind, prom = target
    per = row.get("per_unit_name")
    unit = row.get("unit_name", "") + (f"/{per}" if per else "")
    renamed = ", ".join(f"{t} <- {p}" for p, t in sorted(renames.items()) if labels.get(t) == p)
    return {
        "kind": kind,
        "target": {"name": prom, "type": "sum" if kind == "rate" else "gauge"},
        "sourceUnit": unit,
        "targetUnit": unit,
        "scale": 1,
        "labels": labels,
        "assumption": "PROMLABEL",
        "ref": (
            f"Generated by scripts/generate_openmetrics_mappings.py from integrations-core "
            f"{SHA} {integ}/checks (metric map), {integ}/metadata.csv ({row['metric_type']}"
            f"{', ' + unit if unit else ''}) and openmetrics-series.json (test exposition "
            f"sample {prom}). Labels as exposed"
            + (f", rename_labels: {renamed}" if renamed else "")
            + "; host is the scrape target instance. Not checked against Dash0 data."
        ),
        "reviewed": None,
    }


def load(fixtures: Path = FIXTURES) -> dict[str, tuple[list[str], list[dict[str, str]]]]:
    out: dict[str, tuple[list[str], list[dict[str, str]]]] = {}
    for checks in sorted(fixtures.glob("*/checks")):
        sources = [p.read_text(encoding="utf-8") for p in sorted(checks.glob("*.py"))]
        with (checks.parent / "metadata.csv").open(newline="", encoding="utf-8") as f:
            out[checks.parent.name] = (sources, list(csv.DictReader(f)))
    return out


def existing_names(directory: Path, skip: Path) -> set[str]:
    names: set[str] = set()
    for path in sorted(directory.glob("*.json")):
        if path != skip:
            doc = json.loads(path.read_text(encoding="utf-8"))
            names |= set(doc["metrics"]) | set(doc.get("gaps", {}))
    return names


def generate(out: Path = OUT) -> tuple[str, dict[str, str]]:
    series = json.loads(SERIES.read_text(encoding="utf-8"))["series"]
    body, skipped = build(load(), series, existing_names(MAPPINGS, out))
    return json.dumps(body, indent=2, ensure_ascii=False) + "\n", skipped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="exit 1 if the output is stale")
    parser.add_argument("--skipped", action="store_true", help="print skipped names and reasons")
    args = parser.parse_args(argv)
    text, skipped = generate()
    count = len(json.loads(text)["metrics"])
    if args.skipped:
        for name, reason in skipped.items():
            print(f"{name}: {reason}")
    if args.check:
        same = OUT.is_file() and OUT.read_text(encoding="utf-8") == text
        print(f"{'OK' if same else 'STALE'}: {OUT.name} ({count} entries, {len(skipped)} skipped)")
        return 0 if same else 1
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({count} entries, {len(skipped)} skipped)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
