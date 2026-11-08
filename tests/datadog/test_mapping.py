import json
from pathlib import Path

from migrator.source.datadog.mapping import MappingInvalid, MappingOk, parse_mapping, parse_mappings
from tests.datadog.helpers import entry, raw_mapping


def no_labels() -> dict[str, object]:
    return {k: v for k, v in entry().items() if k != "labels"}


def errors(raw: object) -> list[str]:
    r = parse_mapping(raw)
    assert isinstance(r, MappingInvalid), r
    return r.errors


def test_accepts_a_minimal_gauge_entry() -> None:
    assert parse_mapping(raw_mapping(**{"postgresql.connections": entry(reviewed=None)})).ok


def test_rejects_dotted_label_names() -> None:
    errs = errors(raw_mapping(**{"postgresql.connections": entry(labels={"db": "db.namespace"})}))
    assert any(e.startswith("metrics.postgresql.connections.labels.db:") for e in errs)


def test_expression_without_filters_placeholder_is_rejected() -> None:
    expr = entry(
        kind="expression",
        expression="sum(foo)",
        outputLabels=[],
        sourceUnit="1",
        targetUnit="1",
    )
    for key in ("target", "matchers", "grain"):
        expr.pop(key, None)
    errs = errors(raw_mapping(**{"postgresql.expr": expr}))
    prefix = "metrics.postgresql.expr.expression:"
    assert any(e.startswith(prefix) and "$filters" in e for e in errs)


def test_rejects_unknown_kind() -> None:
    assert errors(raw_mapping(x=entry(kind="histogram")))


def test_rejects_wrong_source() -> None:
    assert errors({"version": 1, "source": "grafana", "metrics": {}})


def test_rejects_unknown_keys() -> None:
    assert errors(raw_mapping(x=entry(foo=1)))
    assert errors({"version": 1, "source": "datadog", "metrics": {}, "foo": 1})


def test_rate_requires_sum_target() -> None:
    assert errors(raw_mapping(x=entry(kind="rate", target={"name": "a", "type": "gauge"})))


def test_rejects_non_finite_or_non_positive_scale() -> None:
    assert errors(raw_mapping(x=entry(scale=0)))
    assert errors(raw_mapping(x=entry(scale=-1)))


def test_rejects_bad_matcher_and_grain_labels() -> None:
    assert errors(raw_mapping(x=entry(matchers={"a.b": "c"})))
    assert errors(raw_mapping(x=entry(grain={"labels": ["a.b"], "aggregation": "max"})))
    assert errors(raw_mapping(x=entry(grain={"labels": ["a"], "aggregation": "count"})))


def test_every_mapping_file_parses() -> None:
    files = sorted(Path("mappings/datadog").glob("*.json"))
    assert files
    for f in files:
        r = parse_mapping(json.loads(f.read_text()))
        assert r.ok, (f, getattr(r, "errors", None))


def test_entry_without_labels_inherits_the_file_labels() -> None:
    raw = raw_mapping(inherits=no_labels(), own=entry(labels={"instance": "service_instance_id"}))
    r = parse_mapping({**raw, "labels": {"host": "host_name"}})
    assert isinstance(r, MappingOk), r
    assert r.mapping.metrics["inherits"].labels == {"host": "host_name"}
    # An entry's own labels replace the file's whole; they are not merged.
    assert r.mapping.metrics["own"].labels == {"instance": "service_instance_id"}


def test_labels_missing_on_entry_and_file_is_an_error() -> None:
    assert errors(raw_mapping(x=no_labels())) == ["metrics.x.labels: Field required"]


def test_rejects_bad_file_labels() -> None:
    assert errors({**raw_mapping(x=entry()), "labels": {"db": "db.namespace"}})


def test_several_files_merge_into_one_table() -> None:
    a = raw_mapping(**{"m.a": entry()})
    b = {**raw_mapping(**{"m.b": no_labels()}), "labels": {"host": "host_name"}}
    r = parse_mappings([("a.json", a), ("b.json", b)])
    assert isinstance(r, MappingOk), r
    assert sorted(r.mapping.metrics) == ["m.a", "m.b"]
    assert r.mapping.metrics["m.a"].labels == entry()["labels"]
    assert r.mapping.metrics["m.b"].labels == {"host": "host_name"}


def test_metric_in_two_files_is_an_error_naming_both() -> None:
    a, b = raw_mapping(**{"m.a": entry()}), raw_mapping(**{"m.a": entry(scale=2)})
    r = parse_mappings([("a.json", a), ("b.json", b)])
    assert isinstance(r, MappingInvalid)
    assert r.errors == ["metrics.m.a: defined in both a.json and b.json"]


def test_file_errors_name_the_file() -> None:
    r = parse_mappings([("bad.json", raw_mapping(x=entry(kind="nope")))])
    assert isinstance(r, MappingInvalid)
    assert r.errors[0].startswith("bad.json: metrics.x.kind: unknown kind 'nope'")


def test_mapping_directory_parses_as_one_table() -> None:
    files = sorted(Path("mappings/datadog").glob("*.json"))
    r = parse_mappings([(f.name, json.loads(f.read_text())) for f in files])
    assert r.ok, getattr(r, "errors", None)


def test_mapping_entries_state_review_explicitly() -> None:
    # Every entry carries `reviewed` (null until a human reviews it).
    for f in sorted(Path("mappings/datadog").glob("*.json")):
        for name, e in json.loads(f.read_text())["metrics"].items():
            assert "reviewed" in e, (f, name)
