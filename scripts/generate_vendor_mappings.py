"""Generate draft mapping entries from Datadog's pinned OpenTelemetry mapping table (#175).

Development-time only; deterministic and LLM-free. The converter reads the output like any
other mapping file. Every entry is `reviewed: null` until a human reviews it.

Inputs (all pinned in the repo):
  fixtures/datadog/otel-mapping.yaml             vendor name pairs, filter, transform
  fixtures/otel/catalog.yaml                     OTel type, monotonicity, unit
  fixtures/datadog/integrations-core/*/metadata.csv   Datadog type, unit, per-unit

A verified entry (no assumption) is written when every fact is known and consistent:
- one distinct (otel, filter, transform) for the Datadog name; no attribute-rename transform
- the OTel metric is in the catalog and is a gauge or a sum (no histogram)
- the Datadog type is known; its kind (rule of tests/datadog/test_metric_types.py:
  rate/count or per-second gauge -> rate, other gauge -> gauge) fits the OTel type:
  gauge kind <- OTel gauge or non-monotonic sum; rate kind <- OTel monotonic sum
- the catalog has no conflicts and the units have an explicit, compatible scale rule

Otherwise the table row is still used (#188): the entry gets `assumption: OTELTABLE`
(remarks.py) and its `ref` names the unconfirmed fact.
- Several table targets: the first by (usable catalog type, not only from a deprecated
  integration, no transform, row key).
- OTel type and monotonicity come from the catalog; when it lacks the metric or conflicts,
  from the Datadog kind (rate -> monotonic sum, else gauge). The kind is rate only for a
  monotonic sum the Datadog type does not mark as a gauge; otherwise gauge (the raw value).
- Scale: the explicit unit rule, else the table's `× N`, else 1.
- An attribute-rename transform becomes a label (Datadog tag <- OTel attribute).
Still skipped, so they keep blocking as MISSING_METRIC_MAPPING: names already mapped or listed
as a gap in another mapping file (those files take precedence), Datadog names carrying a tag
filter, multi-value filters (they need a sum over attribute values), OTel histograms, a unit
rule and table factor that disagree, and non-positive or non-finite factors.

Filters become matchers (attribute dots -> underscores, as Dash0 exposes attributes in PromQL
and as the existing mapping files do). Labels: `host -> host_name`, the convention of
existing host mappings.

Usage:
  uv run scripts/generate_vendor_mappings.py          # write mappings/datadog/vendor-table.json
  uv run scripts/generate_vendor_mappings.py --check  # exit 1 if the file is stale
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
PIN = ROOT / "fixtures" / "datadog" / "otel-mapping.yaml"
CATALOG = ROOT / "fixtures" / "otel" / "catalog.yaml"
METADATA = ROOT / "fixtures" / "datadog" / "integrations-core"
MAPPINGS = ROOT / "mappings" / "datadog"
OUT = MAPPINGS / "vendor-table.json"
LABELS = {"host": "host_name"}
_LABEL = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_SCALE = re.compile(r"× (\S+)")
_RENAME = re.compile(r"Rename attribute key `([^`]+)` to `([^`]+)`")
ASSUMPTION = "OTELTABLE"

# Target sample -> Datadog value, after rate() for monotonic sums. Physical factors use
# the pinned metadata's units (SI nano/micro/milli, IEC mebi); named count pairs come
# from the vendor rows and the pinned receiver definitions. A bare OTel "1" is a count
# only for these explicit source units, never for byte/time/CPU quantities.
# No fallback for empty units, unfamiliar spellings or incompatible dimensions.
UNIT_SCALES: dict[tuple[str, str], float] = {
    ("byte", "By"): 1.0,
    ("byte", "{bytes}"): 1.0,
    ("mebibyte", "By"): 1.0 / 1024**2,
    ("core", "{cpu}"): 1.0,
    ("nanocore", "{cpu}"): 1e9,
    ("second", "s"): 1.0,
    ("second", "{seconds}"): 1.0,
    ("second", "{ms}"): 0.001,
    ("millisecond", "ms"): 1.0,
    ("millisecond", "s"): 1000.0,
    ("microsecond", "us"): 1.0,
    ("percent", "%"): 1.0,
    ("fraction", "%"): 0.01,
    ("fraction", "1"): 1.0,
    ("block", "{blks_read}"): 1.0,
    ("buffer", "{buffers}"): 1.0,
    ("connection", "{connections}"): 1.0,
    ("fault", "{faults}"): 1.0,
    ("file", "{files}"): 1.0,
    ("hit", "{blks_hit}"): 1.0,
    ("lock", "{deadlock}"): 1.0,
    ("message", "{messages}"): 1.0,
    ("process", "{processes}"): 1.0,
    ("read", "{operations}"): 1.0,
    ("record", "{ record }"): 1.0,
    ("request", "{request}"): 1.0,
    ("request", "{requests}"): 1.0,
    ("stage", "{ stage }"): 1.0,
    ("table", "{table}"): 1.0,
    ("task", "{ task }"): 1.0,
    ("thread", "{workers}"): 1.0,
    ("write", "{operations}"): 1.0,
}
for _count_unit in (
    "block", "connection", "error", "file", "hit", "miss", "operation", "page",
    "query", "read", "row", "table", "thread", "wait", "write",
):
    UNIT_SCALES[(_count_unit, "1")] = 1.0


def datadog_types() -> dict[str, dict[str, str]]:
    types: dict[str, dict[str, str]] = {}
    for path in sorted(METADATA.glob("*/metadata.csv")):
        with path.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                row["source"] = f"{path.parent.name}/metadata.csv"
                types.setdefault(row["metric_name"], row)
    return types


def expected_kind(row: dict[str, str]) -> str | None:
    if row["metric_type"] in ("rate", "count"):
        return "rate"
    if row["metric_type"] == "gauge":
        return "rate" if row.get("per_unit_name") == "second" else "gauge"
    return None


def existing_names(directory: Path, skip: Path) -> set[str]:
    names: set[str] = set()
    for path in sorted(directory.glob("*.json")):
        if path != skip:
            doc = json.loads(path.read_text(encoding="utf-8"))
            names |= set(doc["metrics"]) | set(doc.get("gaps", {}))
    return names


def build(
    rows: list[dict[str, Any]],
    catalog: dict[str, Any],
    types: dict[str, dict[str, str]],
    taken: set[str],
    fetched: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Mapping file body and, per skipped Datadog name, the reason."""
    by_name: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for r in rows:
        key = json.dumps([r["otel"], r.get("filter") or {}, r.get("transform") or ""])
        by_name[r["datadog"]][key].add(r.get("integration") or "")
    metrics: dict[str, Any] = {}
    skipped: dict[str, str] = {}
    for name in sorted(by_name):
        reason, entry = _entry(name, set(by_name[name]), catalog, types, taken, fetched)
        if entry is None and name not in taken:
            why, entry = _assumed_entry(name, by_name[name], catalog, types, fetched, reason)
            reason = why or reason
        if entry is None:
            skipped[name] = reason
        else:
            metrics[name] = entry
    body = {"version": 1, "source": "datadog", "labels": LABELS, "metrics": metrics}
    return body, skipped


def _entry(
    name: str,
    candidates: set[str],
    catalog: dict[str, Any],
    types: dict[str, dict[str, str]],
    taken: set[str],
    fetched: str,
) -> tuple[str, dict[str, Any] | None]:
    if name in taken:
        return "already in a mapping file", None
    if "{" in name:
        return "Datadog name carries a tag filter", None
    if len(candidates) != 1:
        return f"{len(candidates)} distinct table targets", None
    otel, flt, transform = json.loads(next(iter(candidates)))
    if any(", " in str(v) for v in flt.values()):
        return "multi-value filter needs a sum over attribute values", None
    if transform and not _SCALE.fullmatch(transform):
        return f"transform not supported: {transform}", None
    try:
        scale = float(_SCALE.fullmatch(transform).group(1)) if transform else 1.0  # type: ignore[union-attr]
    except ValueError:
        return f"transform not numeric: {transform}", None
    matchers = {k.replace(".", "_"): v for k, v in sorted(flt.items())}
    if not all(_LABEL.fullmatch(k) for k in matchers):
        return "filter attribute is not a label name", None
    o = catalog.get(otel)
    if o is None:
        return f"{otel} not in the OTel catalog", None
    if o.get("conflicts"):
        return f"{otel} has conflicting OTel definitions: {'; '.join(o['conflicts'])}", None
    dd = types.get(name)
    kind = expected_kind(dd) if dd else None
    if kind is None:
        return "Datadog type unknown", None
    if o["type"] == "gauge" or (o["type"] == "sum" and not o["monotonic"]):
        if kind != "gauge":
            return f"Datadog kind {kind} vs OTel non-cumulative {o['type']}", None  # type: ignore[index]
    elif o["type"] == "sum" and o["monotonic"]:
        if kind != "rate":
            return f"Datadog kind {kind} vs OTel cumulative sum", None  # type: ignore[index]
    else:
        return f"OTel type {o['type']} not supported", None
    assert dd is not None
    source_unit = dd.get("unit_name", "") + (
        f"/{dd['per_unit_name']}" if dd.get("per_unit_name") else ""
    )
    if dd.get("per_unit_name") not in (None, "", "second"):
        return f"Datadog per-unit not supported: {dd['per_unit_name']}", None
    unit_scale = UNIT_SCALES.get((dd.get("unit_name", ""), o["unit"]))
    if unit_scale is None:
        return f"unit pair not supported: {source_unit or '-'} <- {o['unit'] or '-'}", None
    if transform and not math.isclose(scale, unit_scale, rel_tol=1e-12, abs_tol=0.0):
        return f"table scale {scale:g} conflicts with unit scale {unit_scale:g}", None
    scale = unit_scale
    filt = ", ".join(f"{k}: {v}" for k, v in sorted(flt.items()))
    ref = (
        f"Generated by scripts/generate_vendor_mappings.py. Vendor: fixtures/datadog/"
        f"otel-mapping.yaml {name} -> {otel}"
        + (f", filter {filt}" if filt else "")
        + (f", transform {transform}" if transform else "")
        + f" (fetched {fetched}). Datadog: integrations-core {dd['source']} "
        f"{dd['metric_type']}, unit {source_unit or '-'}. OTel: fixtures/otel/catalog.yaml "
        f"{o['type']}{' monotonic' if o['monotonic'] else ''}, unit {o['unit'] or '-'} "
        f"({', '.join(o['sources'])}). Not checked against Dash0 data."
    )
    if not transform and scale != 1:
        ref += f" vendor deviation: table omits scale; explicit unit rule requires {scale:g}."
    entry: dict[str, Any] = {
        "kind": kind,
        "target": {"name": otel, "type": o["type"]},
        "sourceUnit": source_unit,
        "targetUnit": o["unit"] or "",
        "scale": int(scale) if scale.is_integer() else scale,
        "ref": ref,
        "reviewed": None,
    }
    if matchers:
        entry["matchers"] = matchers
    return "", entry


def _label(attribute: str) -> str:
    label = re.sub(r"[^a-zA-Z0-9_]", "_", attribute)
    return label if _LABEL.fullmatch(label) else f"_{label}"


def _usable(otel: str, catalog: dict[str, Any]) -> bool:
    o = catalog.get(otel)
    return o is not None and not o.get("conflicts") and o["type"] in ("gauge", "sum")


def _assumed_entry(
    name: str,
    candidates: dict[str, set[str]],
    catalog: dict[str, Any],
    types: dict[str, dict[str, str]],
    fetched: str,
    unconfirmed: str,
) -> tuple[str, dict[str, Any] | None]:
    """An OTELTABLE entry built from the table row, or the reason the name stays blocked."""
    if "{" in name:
        return "Datadog name carries a tag filter", None

    def rank(key: str) -> tuple[bool, bool, bool, str]:
        otel, _, transform = json.loads(key)
        deprecated = all("deprecated" in i for i in candidates[key])
        return (not _usable(otel, catalog), deprecated, bool(transform), key)

    key = min(candidates, key=rank)
    otel, flt, transform = json.loads(key)
    if any(", " in str(v) for v in flt.values()):
        return "multi-value filter needs a sum over attribute values", None
    table_scale: float | None = None
    rename: tuple[str, str] | None = None
    if transform:
        scale_m, rename_m = _SCALE.fullmatch(transform), _RENAME.fullmatch(transform)
        if scale_m:
            try:
                table_scale = float(scale_m.group(1))
            except ValueError:
                return f"transform not numeric: {transform}", None
            if not math.isfinite(table_scale) or table_scale <= 0:
                return f"transform not a positive factor: {transform}", None
        elif rename_m:
            rename = (rename_m.group(1), rename_m.group(2))
        else:
            return f"transform not supported: {transform}", None
    o = catalog.get(otel)
    dd = types.get(name)
    dd_kind = expected_kind(dd) if dd else None
    if o is not None and not o.get("conflicts"):
        if o["type"] not in ("gauge", "sum"):
            return f"OTel type {o['type']} not supported", None
        otype, monotonic, target_unit = o["type"], bool(o["monotonic"]), o["unit"] or ""
        otel_text = (
            f"fixtures/otel/catalog.yaml {otype}{' monotonic' if monotonic else ''}, "
            f"unit {target_unit or '-'} ({', '.join(o['sources'])})"
        )
    else:
        otype = "sum" if dd_kind == "rate" else "gauge"
        monotonic, target_unit = dd_kind == "rate", ""
        otel_text = f"type {otype}{' monotonic' if monotonic else ''} from the Datadog kind"
    kind = "rate" if otype == "sum" and monotonic and dd_kind != "gauge" else "gauge"
    unit = dd.get("unit_name", "") if dd else ""
    per_unit = dd.get("per_unit_name", "") if dd else ""
    source_unit = unit + (f"/{per_unit}" if per_unit else "")
    unit_scale = UNIT_SCALES.get((unit, target_unit))
    if (
        unit_scale is not None
        and table_scale is not None
        and not math.isclose(unit_scale, table_scale, rel_tol=1e-12, abs_tol=0.0)
    ):
        return f"table scale {table_scale:g} conflicts with unit scale {unit_scale:g}", None
    if unit_scale is not None:
        scale, scale_text = unit_scale, "explicit unit rule"
    elif table_scale is not None:
        scale, scale_text = table_scale, "table transform"
    else:
        scale, scale_text = 1.0, "assumed"
    filt = ", ".join(f"{k}: {v}" for k, v in sorted(flt.items()))
    datadog_text = (
        f"integrations-core {dd['source']} {dd['metric_type']}, unit {source_unit or '-'}"
        if dd
        else "not in the pinned metadata.csv files"
    )
    chosen = (
        f" Chosen from {len(candidates)} table targets (usable catalog type, not deprecated, "
        "no transform, then row key)."
        if len(candidates) > 1
        else ""
    )
    ref = (
        f"Generated by scripts/generate_vendor_mappings.py under {ASSUMPTION} (#188). Vendor: "
        f"fixtures/datadog/otel-mapping.yaml {name} -> {otel}"
        + (f", filter {filt}" if filt else "")
        + (f", transform {transform}" if transform else "")
        + f" (fetched {fetched}). Unconfirmed: {unconfirmed}.{chosen}"
        + f" Datadog: {datadog_text}. OTel: {otel_text}. Scale {scale:g} ({scale_text})."
        + " Not checked against Dash0 data."
    )
    entry: dict[str, Any] = {
        "kind": kind,
        "target": {"name": otel, "type": otype},
        "sourceUnit": source_unit,
        "targetUnit": target_unit,
        "scale": int(scale) if scale.is_integer() else scale,
        "ref": ref,
        "reviewed": None,
        "assumption": ASSUMPTION,
    }
    matchers = {_label(k): str(v) for k, v in sorted(flt.items())}
    if matchers:
        entry["matchers"] = matchers
    if rename:
        entry["labels"] = {**LABELS, _label(rename[1]): _label(rename[0])}
    return "", entry


def render(body: dict[str, Any]) -> str:
    return json.dumps(body, indent=2, ensure_ascii=False) + "\n"


def generate(out: Path = OUT) -> tuple[str, dict[str, str]]:
    pin = yaml.safe_load(PIN.read_text(encoding="utf-8"))
    if "filter" not in pin["columns"] or "transform" not in pin["columns"]:
        raise SystemExit("the pin lacks filter/transform columns; re-pin with --all-columns")
    catalog = yaml.safe_load(CATALOG.read_text(encoding="utf-8"))
    taken = existing_names(MAPPINGS, out)
    body, skipped = build(pin["rows"], catalog, datadog_types(), taken, pin["fetched"])
    return render(body), skipped


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
