"""Pin Datadog's OpenTelemetry Metrics Mapping table, and report mapping drift.

Development-time only (issue #105); the converter never imports this file.

Write mode fetches the page once with urllib (or reads a saved copy), keeps every table row
(#171; #105 kept only our fixture services' prefixes), dedupes and sorts them, and writes
fixtures/datadog/otel-mapping.yaml. By default it stores the metric names only: Datadog's
website terms (https://www.datadoghq.com/legal/terms/) restrict copying site content, so storing
the filter, transform and integration columns waits for a decision on issue #105
(`--all-columns` stores them).

Report mode compares every entry in mappings/datadog/*.json with the table: target names and
scales that disagree, filters (reported only), and gaps (Datadog metrics used in
fixtures/cases/** that the table covers but no mapping file maps). It reads the pinned file, or
the full page with --from-file.

Usage:
  uv run scripts/pin_otel_mapping.py                                   # download, write the pin
  uv run scripts/pin_otel_mapping.py --from-file page.md --fetched YYYY-MM-DD
  uv run scripts/pin_otel_mapping.py --report [--from-file page.md]
  uv run scripts/pin_otel_mapping.py --check                           # rebuild == committed pin
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

import yaml

URL = "https://docs.datadoghq.com/opentelemetry/mapping/metrics_mapping.md"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "datadog" / "otel-mapping.yaml"
# Ignored local copy of the page for --check; the page itself is not committed (#105 terms).
PAGE_CACHE = ROOT / "out" / "otelmapping" / "metrics_mapping.md"
MAPPINGS = ROOT / "mappings" / "datadog"
CASES = ROOT / "fixtures" / "cases"

HEADER = ["otel", "datadog", "description", "filter", "transform", "Integration"]
NAME_COLUMNS = ["datadog", "otel"]
ALL_COLUMNS = ["datadog", "otel", "filter", "transform", "integration"]
# fixtures/cases/<service> -> mappings/datadog/<stem>.json, where the names differ.
CASE_MAPPING = {"docker_daemon": "docker", "redisdb": "redis"}

_FILTER = re.compile(r"(?:`[^`]+`: `[^`]*`[, ]*)+")
_FILTER_PAIR = re.compile(r"`([^`]+)`: `([^`]*)`")
_TRANSFORM = re.compile(r"× \S+|Rename attribute key `[^`]+` to `[^`]+`")
_SCALE = re.compile(r"× (\S+)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_METRIC = re.compile(r"([A-Za-z_][\w.]*)\{")

Row = dict[str, Any]


# --------------------------------------------------------------------------- table


def _cells(line: str) -> list[str]:
    return [" ".join(cell.split()) for cell in line.strip()[1:-1].split("|")]


def _sort_key(row: Row) -> tuple[str, ...]:
    flt = json.dumps(row.get("filter") or {}, sort_keys=True)
    return (row["datadog"], row["otel"], flt, row.get("transform", ""), row.get("integration", ""))


def parse_table(text: str) -> list[Row]:
    """Rows of the page's mapping table, all columns, deduped and sorted."""
    lines = [line for line in text.splitlines() if line.startswith("|")]
    if not lines or _cells(lines[0]) != HEADER:
        raise ValueError(f"unexpected table header: {_cells(lines[0]) if lines else None}")
    seen: dict[str, Row] = {}
    for line in lines[2:]:
        cells = _cells(line)
        if len(cells) == 6:
            otel, datadog, _, flt, transform, integration = cells
        elif len(cells) == 5:  # filter or transform is missing; tell them apart by shape
            otel, datadog, _, extra, integration = cells
            flt, transform = (extra, "") if _FILTER.fullmatch(extra) else ("", extra)
        elif len(cells) == 4:
            otel, datadog, _, integration = cells
            flt = transform = ""
        else:
            raise ValueError(f"unexpected row with {len(cells)} cells: {line[:120]}")
        if (flt and not _FILTER.fullmatch(flt)) or (
            transform and not _TRANSFORM.fullmatch(transform)
        ):
            raise ValueError(f"unrecognized filter or transform cell: {line[:200]}")
        row = {
            "datadog": datadog,
            "otel": otel,
            "filter": dict(_FILTER_PAIR.findall(flt)),
            "transform": transform,
            "integration": _LINK.sub(r"\1", integration),
        }
        seen.setdefault(json.dumps(row, sort_keys=True), row)
    return sorted(seen.values(), key=_sort_key)


def render_pin(rows: list[Row], columns: list[str], fetched: str) -> str:
    kept: dict[str, Row] = {}
    for row in rows:
        projected = {c: row[c] for c in columns if row[c]}
        kept.setdefault(json.dumps(projected, sort_keys=True), projected)
    body = {
        "source": URL,
        "fetched": fetched,
        "columns": columns,
        "rows": sorted(kept.values(), key=_sort_key),
    }
    header = (
        "# Pinned rows of Datadog's OpenTelemetry Metrics Mapping table (issue #105).\n"
        "# Generated by scripts/pin_otel_mapping.py; do not edit by hand.\n"
        "# Datadog's website terms restrict copying: https://www.datadoghq.com/legal/terms/\n"
    )
    return header + yaml.safe_dump(body, sort_keys=False, allow_unicode=True, width=1000)


def load_pin(path: Path = OUT) -> tuple[list[str], list[Row]]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    return list(doc["columns"]), list(doc["rows"])


def fetch(url: str = URL) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "thinchackdash-pin-otel-mapping"})
    with urllib.request.urlopen(request, timeout=120) as response:
        text: str = response.read().decode("utf-8")
    return text


def check(pin: Path = OUT, page: Path = PAGE_CACHE, get: Any = fetch) -> tuple[bool, str]:
    """Rebuild the pin twice from the cached page (downloaded once if missing) and compare
    both with the committed pin. Differences mean nondeterminism or a changed page."""
    if not page.is_file():
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(get(), encoding="utf-8")
    doc = yaml.safe_load(pin.read_text(encoding="utf-8"))
    text = page.read_text(encoding="utf-8")
    first, second = (render_pin(parse_table(text), doc["columns"], doc["fetched"]) for _ in "ab")
    pairs = {(r["datadog"], r["otel"]) for r in doc["rows"]}
    summary = f"{len(pairs)} pairs, {len({d for d, _ in pairs})} Datadog names"
    if first != second:
        return False, "FAIL: two rebuilds differ (nondeterministic)"
    if first != pin.read_text(encoding="utf-8"):
        return (
            False,
            f"FAIL: rebuild from {page} differs from {pin.name}; "
            "delete the page to re-download, or re-pin",
        )
    return True, f"OK: rebuilt twice from {page}, identical to {pin.name} ({summary})"


# --------------------------------------------------------------------------- comparison


def table_scale(transform: str) -> float:
    """The factor a table transform applies; 1 when there is none or it only renames."""
    match = _SCALE.fullmatch(transform or "")
    return float(match.group(1)) if match else 1.0


def entry_problems(
    name: str, entry: dict[str, Any], columns: list[str], rows: list[Row]
) -> list[str]:
    """Target-name and scale disagreements between one mapping entry and the table."""
    target = (entry.get("target") or {}).get("name")
    matching = [r for r in rows if r["datadog"] == name]
    if target is None or not matching:
        return []
    allowed = sorted({r["otel"] for r in matching})
    if target not in allowed:
        return [f"target {target} is not in the table: {', '.join(allowed)}"]
    if "transform" not in columns:
        return []
    scales = sorted({table_scale(r.get("transform", "")) for r in matching if r["otel"] == target})
    if not any(math.isclose(float(entry["scale"]), s) for s in scales):
        wanted = ", ".join(f"{s:g}" for s in scales)
        return [f"scale {float(entry['scale']):g}, the table applies {wanted}"]
    return []


def mapping_files(directory: Path = MAPPINGS) -> dict[str, dict[str, dict[str, Any]]]:
    """Raw `metrics` dict of every mapping file, by file stem."""
    return {
        path.stem: json.loads(path.read_text(encoding="utf-8"))["metrics"]
        for path in sorted(directory.glob("*.json"))
    }


def case_metrics(directory: Path = CASES) -> dict[str, set[str]]:
    """Datadog metric names used in fixtures/cases/**, by mapping-file stem."""
    used: dict[str, set[str]] = {}
    for path in sorted(directory.rglob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        stem = CASE_MAPPING.get(doc["service"], doc["service"])
        names = used.setdefault(stem, set())
        for request in doc.get("requests") or []:
            for query in request.get("queries") or []:
                if isinstance(query.get("query"), str):
                    names.update(_METRIC.findall(query["query"]))
    return used


def _filter_note(name: str, entry: dict[str, Any], rows: list[Row]) -> str | None:
    """The table's filters and transforms for this entry's pair, next to the entry's matchers."""
    target = (entry.get("target") or {}).get("name")
    notes = set()
    for r in rows:
        if r["datadog"] == name and r["otel"] == target:
            parts = [f"{k}={v}" for k, v in r.get("filter", {}).items()]
            parts += [r["transform"]] if r.get("transform") else []
            if parts:
                notes.add(", ".join(parts))
    if not notes:
        return None
    matchers = ", ".join(f"{k}={v}" for k, v in sorted((entry.get("matchers") or {}).items()))
    return f"table {' | '.join(sorted(notes))}; matchers {matchers or '-'}"


def report(columns: list[str], rows: list[Row], source: str) -> str:
    files = mapping_files()
    used = case_metrics()
    covered = {r["datadog"] for r in rows}
    mapped = {name for metrics in files.values() for name in metrics}
    lines = [f"Vendor table: {source} ({len(rows)} rows; columns {', '.join(columns)})"]
    for stem in sorted(set(files) | set(used)):
        metrics = files.get(stem, {})
        problems: list[str] = []
        notes: list[str] = []
        for name in sorted(metrics):
            problems += [
                f"  {name}: {p}" for p in entry_problems(name, metrics[name], columns, rows)
            ]
            note = _filter_note(name, metrics[name], rows) if "filter" in columns else None
            notes += [f"  {name}: filter {note}"] if note else []
        names = used.get(stem, set())
        gaps = sorted((names & covered) - mapped)
        targets = sum(": target " in p for p in problems)
        lines.append(
            f"{stem}: {len(metrics)} entries, {len(set(metrics) & covered)} in table, "
            f"{targets} target and {len(problems) - targets} scale disagreements; "
            f"cases use {len(names)} metrics, {len(names & covered)} in table, {len(gaps)} gaps"
        )
        lines += problems + notes
        for gap in gaps:
            otel = ", ".join(sorted({r["otel"] for r in rows if r["datadog"] == gap}))
            lines.append(f"  {gap}: gap, table {otel}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pin Datadog's OTel mapping rows; report drift.")
    parser.add_argument("--from-file", type=Path, help="saved copy of the page (markdown)")
    parser.add_argument("--fetched", help="fetch date for the header (YYYY-MM-DD)")
    parser.add_argument("--out", type=Path, default=OUT, help="pin file to write or read")
    parser.add_argument(
        "--all-columns", action="store_true", help="also store filter, transform, integration"
    )
    parser.add_argument(
        "--report", action="store_true", help="compare the mappings with the table; write nothing"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="rebuild the pin from the cached page twice and compare with the committed pin",
    )
    args = parser.parse_args(argv)

    if args.check:
        ok, message = check(args.out, args.from_file or PAGE_CACHE)
        print(message)
        return 0 if ok else 1

    if args.report:
        if args.from_file:
            rows = parse_table(args.from_file.read_text(encoding="utf-8"))
            sys.stdout.write(report(ALL_COLUMNS, rows, str(args.from_file)))
        else:
            columns, rows = load_pin(args.out)
            shown = args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out
            sys.stdout.write(report(columns, rows, str(shown)))
        return 0

    if args.from_file and not args.fetched:
        parser.error("--from-file needs --fetched (the date the saved copy was fetched)")
    fetched = args.fetched or datetime.datetime.now(datetime.UTC).date().isoformat()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fetched):
        parser.error("--fetched must be YYYY-MM-DD")
    text = args.from_file.read_text(encoding="utf-8") if args.from_file else fetch()
    columns = ALL_COLUMNS if args.all_columns else NAME_COLUMNS
    rows = parse_table(text)
    args.out.write_text(render_pin(rows, columns, fetched), encoding="utf-8")
    print(f"wrote {args.out} ({len(rows)} table rows kept, columns {', '.join(columns)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
