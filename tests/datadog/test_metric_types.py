"""Mapping `kind` must fit the Datadog metric type (issue #106).

Datadog types come from every integrations-core `metadata.csv`, pinned by
`scripts/pin-integrations-core.sh` and listed in `metadata-blobs.json`. Host metrics
(`system.*`) come from Agent core checks, so `SYSTEM_TYPES` cites their type per metric.

Rule:
- Datadog `rate` or `count` -> `kind: rate`.
- Datadog `gauge` with `per_unit_name` `second` -> `kind: rate`. An Agent check
  submits a counter with `self.rate()`, and Datadog stores it in-app as GAUGE
  (`IN_APP_TYPES`), so `metadata.csv` lists it as `gauge` per second.
- Any other `gauge` -> `kind: gauge`.
- `expression` entries are skipped. A metric with no known type is reported as unknown.

`type deviation: <reason>` in `ref` opts an entry out: the report lists it as `deviation`
instead of `mismatch`. Use it where the Datadog value is derived from a counter the
type columns don't show, e.g. `redis.cpu.sys` (`self.rate()` without a per-second unit)
or `docker.cpu.user` (percent gauge mapped to cumulative `container.cpu.usage.usermode`).

The test is strict only for entries with `reviewed` set. Print the report for all
entries with `uv run python -m tests.datadog.test_metric_types`.
"""

from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from tests.datadog.helpers import entry, raw_mapping

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures/datadog/integrations-core"
MAPPINGS = ROOT / "mappings/datadog"
SHA = "a9b9e42b7e484861ecbd1f5919da7c52a694b74d"

IN_APP_TYPES = "https://docs.datadoghq.com/metrics/types/#submission-types-and-datadog-in-app-types"
SYSTEM_DOC = "https://docs.datadoghq.com/integrations/system/#metrics"
NETWORK_CSV = f"https://github.com/DataDog/integrations-core/blob/{SHA}/network/metadata.csv"

# Git blob SHAs of every `<svc>/metadata.csv` at the pinned commit (recursive Git tree, #175).
UPSTREAM_BLOBS: dict[str, str] = json.loads((FIXTURES / "metadata-blobs.json").read_text())


@dataclass(frozen=True)
class DatadogType:
    metric_type: str
    per_unit: str
    source: str


SYSTEM_TYPES = {
    "system.cpu.idle": DatadogType("gauge", "", SYSTEM_DOC),
    "system.cpu.iowait": DatadogType("gauge", "", SYSTEM_DOC),
    "system.cpu.stolen": DatadogType("gauge", "", SYSTEM_DOC),
    "system.cpu.system": DatadogType("gauge", "", SYSTEM_DOC),
    "system.cpu.user": DatadogType("gauge", "", SYSTEM_DOC),
    "system.load.1": DatadogType("gauge", "", SYSTEM_DOC),
    "system.load.5": DatadogType("gauge", "", SYSTEM_DOC),
    "system.load.15": DatadogType("gauge", "", SYSTEM_DOC),
    "system.net.bytes_rcvd": DatadogType("gauge", "second", NETWORK_CSV),
    "system.net.bytes_sent": DatadogType("gauge", "second", NETWORK_CSV),
}


def load_types() -> dict[str, DatadogType]:
    types = dict(SYSTEM_TYPES)
    for path in sorted(FIXTURES.glob("*/metadata.csv")):
        source = f"{path.parent.name}/metadata.csv"
        with path.open(newline="") as f:
            for row in csv.DictReader(f):
                types[row["metric_name"]] = DatadogType(
                    row["metric_type"], row["per_unit_name"], source
                )
    return types


def expected_kind(t: DatadogType) -> str | None:
    if t.metric_type in ("rate", "count"):
        return "rate"
    if t.metric_type == "gauge":
        return "rate" if t.per_unit == "second" else "gauge"
    return None


def verdict(kind: str, t: DatadogType | None) -> str:
    if kind == "expression":
        return "skip"
    expected = expected_kind(t) if t else None
    if expected is None:
        return "unknown"
    return "ok" if kind == expected else "mismatch"


def mapping_entries(mapping_dir: Path) -> list[tuple[str, str, dict[str, Any]]]:
    # Only the raw `metrics` dict: other top-level keys may come and go.
    out = []
    for path in sorted(mapping_dir.glob("*.json")):
        for name, e in sorted(json.loads(path.read_text())["metrics"].items()):
            out.append((path.name, name, e))
    return out


def report(mapping_dir: Path = MAPPINGS, reviewed_only: bool = False) -> list[str]:
    types = load_types()
    lines = []
    for file, name, e in mapping_entries(mapping_dir):
        if reviewed_only and e.get("reviewed") is None:
            continue
        t = types.get(name)
        v = verdict(e["kind"], t)
        if v == "mismatch" and "type deviation:" in e.get("ref", ""):
            v = "deviation"
        if v in ("mismatch", "unknown", "deviation"):
            dd = f"{t.metric_type}/{t.per_unit or '-'} ({t.source})" if t else "-"
            reviewed = "reviewed" if e.get("reviewed") is not None else "unreviewed"
            lines.append(f"{v} {file} {name}: kind={e['kind']} datadog={dd} {reviewed}")
    return lines


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def test_pinned_metadata_is_byte_identical_to_upstream() -> None:
    pinned = {p.parent.name: p for p in FIXTURES.glob("*/metadata.csv")}
    assert sorted(pinned) == sorted(UPSTREAM_BLOBS)
    for svc, blob in UPSTREAM_BLOBS.items():
        assert git_blob_sha(pinned[svc].read_bytes()) == blob, svc


def test_reviewed_entries_fit_the_datadog_type() -> None:
    assert [line for line in report(reviewed_only=True) if line.startswith("mismatch")] == []


@pytest.mark.parametrize(
    ("metric", "kind"),
    [
        ("postgresql.rows_fetched", "gauge"),  # gauge row/second: Agent self.rate()
        ("kafka.kraft.broker_metadata.metadata_apply_error_count", "gauge"),  # rate
        ("postgresql.bgwriter.buffers_alloc", "gauge"),  # count
        ("redis.mem.used", "rate"),  # plain gauge
    ],
)
def test_reviewed_entry_with_wrong_kind_fails(tmp_path: Path, metric: str, kind: str) -> None:
    raw = raw_mapping(**{metric: entry(kind=kind)})
    (tmp_path / "synthetic.json").write_text(json.dumps(raw))
    lines = report(tmp_path, reviewed_only=True)
    assert len(lines) == 1
    assert lines[0].startswith(f"mismatch synthetic.json {metric}:")


def test_unreviewed_mismatch_is_reported_but_not_strict(tmp_path: Path) -> None:
    raw = raw_mapping(**{"redis.mem.used": entry(kind="rate", reviewed=None)})
    (tmp_path / "synthetic.json").write_text(json.dumps(raw))
    assert report(tmp_path, reviewed_only=True) == []
    assert report(tmp_path) == [
        "mismatch synthetic.json redis.mem.used: kind=rate "
        "datadog=gauge/- (redisdb/metadata.csv) unreviewed"
    ]


def test_type_deviation_in_ref_opts_out(tmp_path: Path) -> None:
    raw = raw_mapping(
        **{
            "redis.cpu.sys": entry(
                kind="rate", ref="type deviation: submitted with self.rate() (RATE_KEYS)"
            )
        }
    )
    (tmp_path / "synthetic.json").write_text(json.dumps(raw))
    lines = report(tmp_path, reviewed_only=True)
    assert lines == [
        "deviation synthetic.json redis.cpu.sys: kind=rate "
        "datadog=gauge/- (redisdb/metadata.csv) reviewed"
    ]
    assert [line for line in lines if line.startswith("mismatch")] == []


def test_expression_is_skipped_and_unknown_metric_is_reported(tmp_path: Path) -> None:
    raw = raw_mapping(
        **{
            "postgresql.percent_usage_connections": entry(kind="expression"),
            "made.up.metric": entry(),
        }
    )
    (tmp_path / "synthetic.json").write_text(json.dumps(raw))
    assert report(tmp_path) == [
        "unknown synthetic.json made.up.metric: kind=gauge datadog=- reviewed"
    ]


if __name__ == "__main__":
    lines = report()
    print("\n".join(lines))
    print(f"{len(mapping_entries(MAPPINGS))} entries, {len(lines)} reported")
