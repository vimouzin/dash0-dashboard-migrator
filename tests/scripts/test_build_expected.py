"""Overlay rules in scripts/build_expected.py for OTel metrics inside and outside the dataset."""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path

import build_expected as be
import pytest
import render_oracle_prompt as rp
import run_oracle as ro
import yaml

KEY = "nginx/NGINX-Metrics_dashboard"


def selector(name: str, kind: str) -> str:
    return f'sum({{otel_metric_name="{name}", otel_metric_type="{kind}"}})'


def catalog_only_metric(kind: str = "sum") -> str:
    """A metric OpenTelemetry defines that the dataset snapshot does not contain."""
    present = be.dataset_metrics()
    return str(
        next(n for n, m in be.otel_catalog().items() if n not in present and m["type"] == kind)
    )


def test_dataset_metric_needs_no_note() -> None:
    assert be.metric_availability([selector("nginx.connections_accepted", "sum")]) == ([], [], [])


def test_catalog_metric_outside_the_dataset_is_reported_as_absent() -> None:
    name = catalog_only_metric()
    undefined, absent, mismatched = be.metric_availability([selector(name, "sum")])
    assert (undefined, absent, mismatched) == ([], [name], [])


def test_unknown_metric_is_undefined() -> None:
    assert be.metric_availability([selector("made.up.metric", "gauge")])[0] == ["made.up.metric"]


def test_type_mismatch_is_reported_for_absent_metrics() -> None:
    name = catalog_only_metric("sum")
    assert be.metric_availability([selector(name, "gauge")])[2] == [
        f"{name} is sum in {be.otel_catalog()[name]['sources'][0]}, PromQL selects gauge"
    ]


@pytest.fixture
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A copy of the inputs build() reads, with ROOT pointing at it."""
    case_rel = Path("fixtures/cases") / f"{KEY}.yaml"
    case = yaml.safe_load((be.ROOT / case_rel).read_text())
    for rel in (
        case_rel,
        Path(case["source"]["fixture"]),
        Path("fixtures/oracle/agent0") / KEY / "answer.yaml",
        Path("fixtures/otel/catalog.yaml"),
        Path("fixtures/oracle/dash0_default_metrics.yaml"),
    ):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(be.ROOT / rel, tmp_path / rel)
    monkeypatch.setattr(be, "ROOT", tmp_path)
    be.otel_catalog.cache_clear()
    be.dataset_metrics.cache_clear()
    yield tmp_path
    be.otel_catalog.cache_clear()
    be.dataset_metrics.cache_clear()


def rewrite_answer(root: Path, source_path: str, promql: list[str]) -> None:
    path = root / "fixtures/oracle/agent0" / KEY / "answer.yaml"
    items = yaml.safe_load(path.read_text())
    for item in items:
        if item["source_path"] == source_path:
            item.update(outcome="translated", promql=promql)
    path.write_text(yaml.safe_dump(items))


def first_single_formula_request() -> str:
    case = yaml.safe_load((be.ROOT / "fixtures/cases" / f"{KEY}.yaml").read_text())
    return str(
        next(r["source_path"] for r in case["requests"] if len(r["formulas"]) <= 1 and r["queries"])
    )


def test_build_keeps_translation_with_dataset_block(sandbox: Path) -> None:
    sp = first_single_formula_request()
    name = catalog_only_metric()
    rewrite_answer(sandbox, sp, [selector(name, "sum")])
    entry = next(r for r in be.build(KEY)["requests"] if r["source_path"] == sp)
    assert entry["expected"]["outcome"] == "translated"
    assert entry["dataset"] == {
        "available": False,
        "missing_metrics": [name],
        "otel_sources": be.otel_catalog()[name]["sources"],
    }


def test_build_blocks_metric_unknown_to_otel(sandbox: Path) -> None:
    sp = first_single_formula_request()
    rewrite_answer(sandbox, sp, [selector("made.up.metric", "sum")])
    entry = next(r for r in be.build(KEY)["requests"] if r["source_path"] == sp)
    assert entry["expected"] == {"outcome": "blocked", "errors": ["MISSING_METRIC_MAPPING"]}
    assert "dataset" not in entry
    assert "made.up.metric" in entry["notes"][0]


def test_validation_requires_otel_source_outside_the_dataset() -> None:
    case = ro.load_case(KEY)
    sp = first_single_formula_request()
    items = [
        {"source_path": r["source_path"], "outcome": "blocked", "reason": "x"}
        for r in case["requests"]
    ]
    items[[r["source_path"] for r in case["requests"]].index(sp)] = {
        "source_path": sp,
        "outcome": "translated",
        "promql": ["q"],
        "in_dataset": "no",
    }
    with pytest.raises(ro.AnswerError, match="needs otel_source"):
        ro.validate_answer(yaml.safe_dump(items), case)
    items[[r["source_path"] for r in case["requests"]].index(sp)]["otel_source"] = [
        "x/metadata.yaml"
    ]
    ro.validate_answer(yaml.safe_dump(items), case)


def test_prompt_lists_otel_candidates_with_dataset_presence() -> None:
    case = yaml.safe_load((be.ROOT / "fixtures/cases/kafka/kafka_dashboard.yaml").read_text())
    lines = rp.candidate_lines(case)
    zookeeper = [line for line in lines if line.startswith("- zookeeper.")]
    assert zookeeper and all("not in dataset" in line for line in zookeeper)
    assert any(
        line.startswith("- kafka.message.count ") and "; in dataset;" in line for line in lines
    )
    assert lines == sorted(lines)
