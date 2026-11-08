"""General-purpose inputs use exact mappings, with no empty-success path."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from migrator.cli import main
from migrator.convert import ConvertOptions, ConvertResult, run_convert
from migrator.input import InputError
from migrator.report import format_summary

MAPPINGS = "mappings/datadog"
METRICS = ["postgresql.connections", "redis.mem.used", "system.cpu.idle"]


def dashboard(queries: list[str]) -> dict[str, Any]:
    return {
        "title": "General overview",
        "layout_type": "ordered",
        "widgets": [
            {"definition": {"type": "timeseries", "requests": [{"q": query}]}}
            for query in queries
        ],
    }


def write_source(path: Path, document: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document))
    return path


def convert(root: Path, inputs: list[Path], mappings: list[str] | None = None) -> ConvertResult:
    return run_convert(ConvertOptions(
        "datadog", [str(path) for path in inputs], mappings or [MAPPINGS], str(root)
    ))


def tree(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*")
            if path.is_file()}


def artifacts(root: Path) -> dict[str, bytes]:
    return {name: data for name, data in tree(root).items() if name.startswith("dashboards/")}


def cli(source: Path, output: Path) -> int:
    return main([
        "convert", "--source", "datadog", "--input", str(source),
        "--mapping", MAPPINGS, "--out", str(output),
    ])


@pytest.mark.parametrize("document", [{}, [], {"dashboards": []}, [dashboard([])]])
def test_unsupported_only_input_fails_without_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], document: Any
) -> None:
    source = write_source(tmp_path / "everything.json", document)
    output = tmp_path / "out"
    assert cli(source, output) == 1
    error = capsys.readouterr().err
    assert "NO_SUPPORTED_ASSETS" in error
    assert "UNSUPPORTED_ASSET_KIND: everything.json" in error
    assert not output.exists()


def test_empty_folder_fails_without_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "empty"
    source.mkdir()
    output = tmp_path / "out"
    assert cli(source, output) == 1
    assert "NO_SUPPORTED_ASSETS" in capsys.readouterr().err
    assert not output.exists()


def test_malformed_json_stays_an_input_error_without_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "bundle.json"
    source.write_text('{"dashboards": [')
    output = tmp_path / "out"
    assert cli(source, output) == 1
    assert "INVALID_JSON" in capsys.readouterr().err
    assert not output.exists()


def test_mixed_supported_and_skipped_files_exit_2_and_show_warning(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "input"
    write_source(source / "good.json", dashboard(["avg:postgresql.connections{*}"]))
    bad = write_source(source / "bundle.json", {"dashboards": []})
    output = tmp_path / "out"
    assert cli(source, output) == 2
    terminal = capsys.readouterr().out
    assert "UNSUPPORTED_ASSET_KIND: input/bundle.json" in terminal
    assert "skipped files: 1" in terminal
    assert artifacts(output)
    report = json.loads((output / "report.json").read_text())
    assert report["summary"]["dashboards"]["translated"] == 1
    assert report["summary"]["skippedFiles"] == 1
    assert (output / "source/input/bundle.json").read_bytes() == bad.read_bytes()


def test_general_dashboard_uses_all_mappings_and_is_repeatable(tmp_path: Path) -> None:
    source = write_source(tmp_path / "general.json", dashboard([f"avg:{m}{{*}}" for m in METRICS]))
    first = convert(tmp_path / "one", [source])
    assert first.exit_code == 0
    coverage = first.report["mappingCoverage"]
    assert coverage["parsedQueries"] == 3
    assert [(m["metric"], m["mapped"]) for m in coverage["metrics"]] == [
        (name, True) for name in METRICS
    ]
    assert coverage["unparsedQueries"] == []
    convert(tmp_path / "two", [source])
    assert tree(tmp_path / "one") == tree(tmp_path / "two")
    assert str(tmp_path) not in json.dumps(first.report)


def test_file_folder_and_unrelated_names_produce_identical_dashboards(tmp_path: Path) -> None:
    document = dashboard([f"avg:{m}{{*}}" for m in METRICS])
    source = write_source(tmp_path / "misc/general.json", document)
    unrelated = write_source(tmp_path / "unrelated/anything.json", document)
    for name, path in [("file", source), ("folder", source.parent), ("renamed", unrelated)]:
        result = convert(tmp_path / name, [path])
        assert result.exit_code == 0
    assert artifacts(tmp_path / "file") == artifacts(tmp_path / "folder")
    assert artifacts(tmp_path / "file") == artifacts(tmp_path / "renamed")


def test_mapping_directory_repeated_files_and_combined_file_are_equivalent(tmp_path: Path) -> None:
    source = write_source(tmp_path / "general.json", dashboard([f"avg:{m}{{*}}" for m in METRICS]))
    paths = sorted(Path(MAPPINGS).glob("*.json"))
    metrics = {}
    for path in paths:
        raw = json.loads(path.read_text())
        for name, entry in raw["metrics"].items():
            # File defaults must be expanded when making a single mapping file.
            metrics[name] = {"labels": raw.get("labels", {}), **entry}
    combined = write_source(tmp_path / "all.json", {
        "version": 1, "source": "datadog", "metrics": metrics,
    })
    variants = [[MAPPINGS], [str(p) for p in reversed(paths)], [str(combined)]]
    runs = [convert(tmp_path / str(i), [source], mapping) for i, mapping in enumerate(variants)]
    assert all(run.exit_code == 0 for run in runs)
    assert runs[0].report["mappingCoverage"] == runs[1].report["mappingCoverage"]
    assert runs[0].report["mappingCoverage"] == runs[2].report["mappingCoverage"]
    assert artifacts(tmp_path / "0") == artifacts(tmp_path / "1") == artifacts(tmp_path / "2")


def test_missing_metrics_are_grouped_with_every_source_location(tmp_path: Path) -> None:
    missing = "company.custom.requests"
    source = write_source(tmp_path / "general.json", dashboard([
        "avg:postgresql.connections{*}", f"avg:{missing}{{*}}", f"sum:{missing}{{*}}",
    ]))
    result = convert(tmp_path / "out", [source])
    assert result.exit_code == 2
    [metric] = [m for m in result.report["mappingCoverage"]["metrics"] if not m["mapped"]]
    assert metric == {"metric": missing, "mapped": False, "locations": [
        {"sourceId": "general.json", "sourcePath": f"widgets[{i}].definition.requests[0].q"}
        for i in [1, 2]
    ]}
    assert [i["outcome"] for i in result.report["items"] if i["kind"] == "widget"] == [
        "translated", "blocked", "blocked",
    ]
    terminal = format_summary(result.report, result.slugs)
    assert f"MISSING_METRIC_MAPPING: {missing}" in terminal
    assert "general.json:widgets[2].definition.requests[0].q" in terminal


@pytest.mark.parametrize("query", [
    "avg:company.custom.requests{*} trailing",
    "anomalies(avg:company.custom.requests{*}, 'basic', 2)",
    None,
])
def test_unparsed_queries_never_count_a_recognized_prefix(tmp_path: Path, query: Any) -> None:
    document = dashboard(["avg:postgresql.connections{*}"])
    document["widgets"].append({"definition": {"type": "timeseries", "requests": [{"q": query}]}})
    source = write_source(tmp_path / "general.json", document)
    result = convert(tmp_path / "out", [source])
    assert result.exit_code == 2
    coverage = result.report["mappingCoverage"]
    assert coverage["parsedQueries"] == 1
    assert [m["metric"] for m in coverage["metrics"]] == ["postgresql.connections"]
    [unparsed] = coverage["unparsedQueries"]
    assert unparsed["sourcePath"] == "widgets[1].definition.requests[0].q"
    assert "1 unparsed queries" in format_summary(result.report, result.slugs)


def test_mapping_presence_does_not_override_semantic_blockers(tmp_path: Path) -> None:
    source = write_source(
        tmp_path / "general.json", dashboard(["avg:postgresql.connections{*}.fill(0)"])
    )
    result = convert(tmp_path / "out", [source])
    assert result.report["mappingCoverage"]["metrics"][0]["mapped"] is True
    assert result.report["mappingCoverage"]["unparsedQueries"] == []
    assert result.exit_code == 2
    assert not artifacts(tmp_path / "out")
    assert any(d["code"] == "UNSUPPORTED_QUERY_FUNCTION" for d in result.report["diagnostics"])


def test_coverage_includes_groups_and_unsupported_widgets_but_ignores_other_data_sources(
    tmp_path: Path,
) -> None:
    document = dashboard([])
    document["widgets"] = [{"definition": {"type": "group", "widgets": [
        {"definition": {"type": "heatmap", "requests": [{"queries": [
            {"data_source": "metrics", "name": "q", "query": "avg:company.custom.requests{*}"},
            {"data_source": "logs", "name": "logs", "query": "service:example"},
        ]}]}},
    ]}}]
    source = write_source(tmp_path / "general.json", document)
    result = convert(tmp_path / "out", [source])
    coverage = result.report["mappingCoverage"]
    assert coverage["parsedQueries"] == 1
    [metric] = coverage["metrics"]
    assert metric["metric"] == "company.custom.requests"
    assert metric["locations"][0]["sourcePath"] == (
        "widgets[0].definition.widgets[0].definition.requests[0].queries[0].query"
    )
    assert coverage["unparsedQueries"] == []
    assert result.exit_code == 2


@pytest.mark.parametrize("wrapped", [False, True])
def test_monitor_arithmetic_coverage_keeps_original_source_locations(
    tmp_path: Path, wrapped: bool
) -> None:
    monitor = {
        "name": "Ratio", "type": "query alert",
        "query": "avg(last_5m):avg:redis.mem.used{*} / avg:company.custom.limit{*} > 0.9",
        "options": {"thresholds": {"critical": 0.9}},
    }
    source = write_source(
        tmp_path / "monitor.json", {"definition": monitor} if wrapped else monitor
    )
    result = convert(tmp_path / "out", [source])
    coverage = result.report["mappingCoverage"]
    assert coverage["parsedQueries"] == 1
    assert [(m["metric"], m["mapped"]) for m in coverage["metrics"]] == [
        ("company.custom.limit", False), ("redis.mem.used", True),
    ]
    assert coverage["metrics"][0]["locations"] == [{
        "sourceId": "monitor.json", "sourcePath": "definition.query" if wrapped else "query",
    }]
    assert result.exit_code == 2
    assert result.report["summary"]["monitors"]["blocked"] == 1


def test_input_order_preserves_coverage_diagnostics_and_output_bytes(tmp_path: Path) -> None:
    first = write_source(tmp_path / "first.json", dashboard(["avg:company.custom.requests{*}"]))
    second = write_source(
        tmp_path / "second.json", dashboard(["avg:postgresql.connections{*} bad"])
    )
    convert(tmp_path / "one", [first, second])
    convert(tmp_path / "two", [second, first])
    assert tree(tmp_path / "one") == tree(tmp_path / "two")


def test_duplicate_mapping_remains_an_input_error(tmp_path: Path) -> None:
    source = write_source(tmp_path / "general.json", dashboard(["avg:postgresql.connections{*}"]))
    original = Path(MAPPINGS) / "postgres.json"
    copy = write_source(tmp_path / "copy.json", json.loads(original.read_text()))
    with pytest.raises(InputError, match="defined in both"):
        convert(tmp_path / "out", [source], [str(original), str(copy)])
    assert not (tmp_path / "out").exists()


def test_one_missing_series_blocks_the_entire_widget(tmp_path: Path) -> None:
    document = dashboard([])
    document["widgets"] = [{"definition": {"type": "timeseries", "requests": [{"queries": [
        {"data_source": "metrics", "name": f"q{i}", "query": f"avg:{metric}{{*}}"}
        for i, metric in enumerate(["postgresql.connections", "company.custom.requests"])
    ]}]}}]
    source = write_source(tmp_path / "general.json", document)
    result = convert(tmp_path / "out", [source])
    assert result.exit_code == 2
    assert not artifacts(tmp_path / "out")
    coverage = result.report["mappingCoverage"]
    assert coverage["parsedQueries"] == 2
    assert [m["metric"] for m in coverage["metrics"] if not m["mapped"]] == [
        "company.custom.requests"
    ]
    assert any(d["code"] == "MISSING_METRIC_MAPPING" for d in result.report["diagnostics"])


def test_unparsed_monitor_is_explicit_without_metric_inference(tmp_path: Path) -> None:
    source = write_source(tmp_path / "monitor.json", {
        "definition": {"name": "Unsupported", "type": "query alert",
                       "query": "avg(last_5m):anomalies(avg:postgresql.connections{*}) > 0.9"},
    })
    result = convert(tmp_path / "out", [source])
    assert result.exit_code == 2
    coverage = result.report["mappingCoverage"]
    assert coverage["parsedQueries"] == 0
    assert coverage["metrics"] == []
    [unparsed] = coverage["unparsedQueries"]
    assert unparsed["sourcePath"] == "definition.query"
