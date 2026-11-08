import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any

import pytest
import yaml

from migrator.cli import main
from migrator.convert import ConvertOptions, ConvertResult, Format, run_convert
from migrator.input import InputError, collect_input_files
from migrator.source.provider import get_provider
from migrator.version import COMPILER_VERSION
from migrator.write import assign_slugs, slugify, stable_stringify

SYNTH = Path("fixtures/datadog/synthetic/dashboards")
MAPPING = "mappings/datadog"


def convert(tmp: Path, inputs: list[str], fmt: Format = "json", name: str = "out") -> ConvertResult:
    return run_convert(ConvertOptions("datadog", inputs, [MAPPING], str(tmp / name), fmt))


def tree(root: Path) -> dict[str, bytes]:
    return {
        p.relative_to(root).as_posix(): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_version_matches_pyproject() -> None:
    assert (
        COMPILER_VERSION == tomllib.loads(Path("pyproject.toml").read_text())["project"]["version"]
    )


def test_writers() -> None:
    assert stable_stringify({"b": 1, "a": {"d": [{"z": 1, "y": 2}]}}) == (
        '{\n  "a": {\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n'
        '  "b": 1\n}\n'
    )
    assert slugify("Postgres - Metrics") == "postgres-metrics"
    assert slugify("  ##  ") == "dashboard"
    assert len(slugify("a" * 80)) == 64
    assert assign_slugs(["A b", "a-b", "A B"]) == ["a-b", "a-b-2", "a-b-3"]


def test_inputs_are_sorted_and_symlinks_skipped(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "a").mkdir(parents=True)
    (root / "b.json").write_text("{}")
    (root / "a" / "z.json").write_text("{}")
    (root / "a" / "readme.md").write_text("x")
    (root / "loop").symlink_to(root)
    assert [f.source_id for f in collect_input_files([str(root)])] == [
        "root/a/z.json",
        "root/b.json",
    ]
    with pytest.raises(InputError, match="DUPLICATE_SOURCE_ID: b.json"):
        collect_input_files([str(root / "b.json")] * 2)
    with pytest.raises(InputError, match="input not found"):
        collect_input_files([str(tmp_path / "missing")])


def test_non_utf8_input_is_an_input_error(tmp_path: Path) -> None:
    bad = tmp_path / "latin1.json"
    bad.write_bytes('{"title": "café"}'.encode("latin-1"))
    with pytest.raises(InputError, match=r"input is not valid UTF-8: latin1\.json \(byte 14: "):
        collect_input_files([str(bad)])


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file permissions")
def test_unreadable_input_is_an_input_error(tmp_path: Path) -> None:
    locked = tmp_path / "locked.json"
    locked.write_text("{}")
    locked.chmod(0)
    try:
        with pytest.raises(
            InputError, match=r"cannot read input: locked\.json \(Permission denied\)"
        ):
            collect_input_files([str(locked)])
    finally:
        locked.chmod(0o600)


def test_cli_reports_undecodable_input_without_traceback(tmp_path: Path) -> None:
    bad = tmp_path / "latin1.json"
    bad.write_bytes(b'{"title": "caf\xe9"}')
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "migrator.cli",
            "convert",
            "--source",
            "datadog",
            "--input",
            str(bad),
            "--mapping",
            MAPPING,
            "--out",
            str(tmp_path / "o"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r.returncode == 1
    assert r.stderr.startswith("error: input is not valid UTF-8: latin1.json")
    assert "Traceback" not in r.stderr


def test_unknown_provider() -> None:
    assert get_provider("datadog").id == "datadog"
    with pytest.raises(InputError, match="unknown --source 'grafana'; known: datadog"):
        get_provider("grafana")


def test_writes_one_dashboard_per_non_blocked_source(tmp_path: Path) -> None:
    r = convert(tmp_path, [str(SYNTH / "supported.json"), str(SYNTH / "unsupported.json")])
    assert r.exit_code == 2
    assert sorted(p.name for p in (tmp_path / "out" / "dashboards").iterdir()) == [
        "synthetic-supported.json",
        "synthetic-unsupported.json",
    ]
    manifest = json.loads((tmp_path / "out" / "manifest.json").read_text())
    dash = {
        e["path"]: (e["outcome"], e["eligible"])
        for e in manifest["entries"]
        if e["kind"] == "dashboard"
    }
    assert dash == {
        "dashboards/synthetic-supported.json": ("translated", True),
        "dashboards/synthetic-unsupported.json": ("partial", False),
    }
    report = json.loads((tmp_path / "out" / "report.json").read_text())
    assert report["validation"] == {
        "syntax": "passed",
        "schema": "passed",
        "api": "not_run",
        "semantics": "not_run",
    }


def test_duplicate_titles_get_distinct_slugs(tmp_path: Path) -> None:
    src = tmp_path / "in"
    for sub in ("b", "a"):
        (src / sub).mkdir(parents=True)
        (src / sub / "supported.json").write_text((SYNTH / "supported.json").read_text())
    r = convert(tmp_path, [str(src)])
    assert r.slugs == {
        "in/a/supported.json": "synthetic-supported",
        "in/b/supported.json": "synthetic-supported-2",
    }


def test_yaml_format_round_trips(tmp_path: Path) -> None:
    convert(tmp_path, [str(SYNTH / "supported.json")], "json", "j")
    convert(tmp_path, [str(SYNTH / "supported.json")], "yaml", "y")
    j = json.loads((tmp_path / "j/dashboards/synthetic-supported.json").read_text())
    y = yaml.safe_load((tmp_path / "y/dashboards/synthetic-supported.yaml").read_text())
    assert j == y


def test_convert_is_deterministic_and_copies_sources(tmp_path: Path) -> None:
    inputs = ["fixtures/datadog/integrations-core/postgres", str(SYNTH)]
    convert(tmp_path, inputs, name="one")
    convert(tmp_path, inputs, name="two")
    one, two = tree(tmp_path / "one"), tree(tmp_path / "two")
    assert one == two
    fixture = Path("fixtures/datadog/integrations-core/postgres/monitors/replication_delay.json")
    assert one["source/postgres/monitors/replication_delay.json"] == fixture.read_bytes()


def test_refuses_non_empty_out_and_bad_mapping(tmp_path: Path) -> None:
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "x").write_text("")
    with pytest.raises(InputError, match="output directory is not empty"):
        convert(tmp_path, [str(SYNTH)])
    bad = tmp_path / "bad.json"
    bad.write_text('{"version": 1, "source": "datadog", "metrics": {"m": {"kind": "nope"}}}')
    with pytest.raises(InputError, match="invalid mapping"):
        run_convert(ConvertOptions("datadog", [str(SYNTH)], [str(bad)], str(tmp_path / "o2")))


def test_cli_entry_point_exit_codes(tmp_path: Path) -> None:
    def cli(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "migrator.cli", *args],
            capture_output=True,
            text=True,
            check=False,
        )

    r = cli("convert", "--source", "nope", "--input", "x", "--mapping", "m", "--out", "o")
    assert r.returncode == 1 and "unknown --source 'nope'" in r.stderr
    r = cli(
        "convert",
        "--source",
        "datadog",
        "--input",
        str(SYNTH / "supported.json"),
        "--mapping",
        MAPPING,
        "--out",
        str(tmp_path / "ok"),
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.startswith("Dashboards\n  TRANSLATED    synthetic-supported  2/2 widgets\n")
    # Without --mapping, the whole mappings/<source> folder is the default table.
    r = cli("convert", "--source", "datadog", "--input", PG, "--out", str(tmp_path / "dflt"))
    assert r.returncode == 2, r.stderr
    convert(tmp_path, [PG], name="explicit")
    assert tree(tmp_path / "dflt") == tree(tmp_path / "explicit")


PG = "fixtures/datadog/integrations-core/postgres"


def test_mapping_directory_equals_its_files(tmp_path: Path) -> None:
    run_convert(ConvertOptions("datadog", [PG], [MAPPING], str(tmp_path / "dir")))
    files = [f"{MAPPING}/postgres.json", f"{MAPPING}/host.json", f"{MAPPING}/vendor-table.json"]
    run_convert(ConvertOptions("datadog", [PG], files, str(tmp_path / "two")))
    dir_out, two_out = tree(tmp_path / "dir/dashboards"), tree(tmp_path / "two/dashboards")
    assert dir_out and dir_out == two_out
    report = json.loads((tmp_path / "two/report.json").read_text())
    assert [m["sourceId"] for m in report["mapping"]] == [
        "host.json",
        "postgres.json",
        "vendor-table.json",
    ]
    report = json.loads((tmp_path / "dir/report.json").read_text())
    names = sorted(p.name for p in Path(MAPPING).glob("*.json"))
    assert [m["sourceId"] for m in report["mapping"]] == names


def test_metric_in_two_mapping_files_exits_1_naming_both(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    copy = tmp_path / "copy.json"
    copy.write_text(Path(MAPPING, "host.json").read_text())
    args = ["convert", "--source", "datadog", "--input", PG, "--out", str(tmp_path / "o")]
    assert main([*args, "--mapping", MAPPING, "--mapping", str(copy)]) == 1
    err = capsys.readouterr().err
    assert "metrics.system.cpu.idle: defined in both copy.json and host.json" in err


def test_mapping_paths_need_unique_names_and_files(tmp_path: Path) -> None:
    with pytest.raises(InputError, match="duplicate mapping file name: host.json"):
        run_convert(
            ConvertOptions("datadog", [PG], [MAPPING, f"{MAPPING}/host.json"], str(tmp_path / "a"))
        )
    (tmp_path / "empty").mkdir()
    with pytest.raises(InputError, match="no mapping files"):
        run_convert(ConvertOptions("datadog", [PG], [str(tmp_path / "empty")], str(tmp_path / "b")))


def test_approximated_items_are_converted_and_eligible() -> None:
    from migrator.report import exit_code_for, manifest_entry, summarize
    from migrator.target import ItemResult

    items = [
        ItemResult("d.json", "", "dashboard", "D", "approximated"),
        ItemResult("d.json", "widgets[0]", "widget", "W", "approximated"),
    ]
    assert summarize(items, 0)["widgets"] == {
        "translated": 0,
        "approximated": 1,
        "assumed": 0,
        "best_effort": 0,
        "partial": 0,
        "blocked": 0,
    }
    assert manifest_entry("p", "dashboard", "d.json", "x", "approximated")["eligible"] is True
    assert exit_code_for(items) == 2  # only an all-translated run exits 0


@pytest.mark.parametrize("span", ["1m", "1h"])
def test_pinned_query_value_is_eligible_with_visible_deterministic_remarks(
    tmp_path: Path, span: str
) -> None:
    source = tmp_path / "source.json"
    definition: dict[str, Any] = {
        "type": "query_value",
        "title": "Connections",
        "requests": [{"q": "avg:postgresql.connections{*}", "aggregator": "avg"}],
    }
    dashboard = {"title": "Pinned value", "layout_type": "ordered", "widgets": [
        {"definition": definition}
    ]}
    source.write_text(json.dumps(dashboard))
    convert(tmp_path, [str(source)], name="baseline")
    baseline = json.loads((tmp_path / "baseline/dashboards/pinned-value.json").read_text())
    definition["time"] = {"live_span": span}
    source.write_text(json.dumps(dashboard))
    result = convert(tmp_path, [str(source)], name="pinned")
    assert result.exit_code == 2
    assert [(i["outcome"], i.get("remarks")) for i in result.report["items"]] == [
        ("approximated", ["TIMEPIN"]), ("approximated", ["TIMEPIN"])
    ]
    [diagnostic] = [d for d in result.report["diagnostics"] if d["code"] == "APPROXIMATED"]
    assert (diagnostic["remark"], diagnostic["sourcePath"]) == (
        "TIMEPIN", "widgets[0].definition.time"
    )
    assert span in diagnostic["message"]
    [artifact] = [e for e in result.manifest["entries"] if e["kind"] == "dashboard"]
    assert (artifact["outcome"], artifact["eligible"], artifact["remarks"]) == (
        "approximated", True, ["TIMEPIN"]
    )
    output = json.loads((tmp_path / "pinned" / artifact["path"]).read_text())
    panel = output["spec"]["panels"]["widget-0"]["spec"]
    baseline_panel = baseline["spec"]["panels"]["widget-0"]["spec"]
    assert panel["queries"] == baseline_panel["queries"]
    assert panel["plugin"] == baseline_panel["plugin"]
    assert "[TIMEPIN]" in panel["display"]["description"]
    assert "query values and rankings, can change" in panel["display"]["description"]
    assert "Migration remarks: TIMEPIN" in output["spec"]["display"]["description"]
    assert (tmp_path / "pinned/source/source.json").read_bytes() == source.read_bytes()
    convert(tmp_path, [str(source)], name="again")
    assert tree(tmp_path / "pinned") == tree(tmp_path / "again")
