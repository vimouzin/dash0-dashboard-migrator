"""Offline tests for scripts/smoke_check.py (read-only Dash0 smoke check, #110)."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
import smoke_check as sc  # type: ignore[import-not-found]

from migrator.http import HttpRequest, HttpResponse, HttpTransportError

TOKEN = "auth_secret_token_value"
ENV = {"DASH0_AUTH_TOKEN": TOKEN}
WINDOW = ["--start", "2026-11-07T14:05:00Z", "--end", "2026-11-07T15:21:00Z"]

RATE_Q = 'sum by (db) (rate({otel_metric_name="pg.rows", db=~"^($db)$"}[$__rate_interval]))'
GAUGE_Q = '{otel_metric_name="pg.temp"}'
PCT_Q = '{otel_metric_name="pg.util"} * 100'


def query(text: str) -> dict[str, Any]:
    return {
        "kind": "TimeSeriesQuery",
        "spec": {"plugin": {"kind": "PrometheusTimeSeriesQuery", "spec": {"query": text}}},
    }


def panel(queries: list[str], plugin_spec: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "kind": "Panel",
        "spec": {
            "display": {"name": "p"},
            "plugin": {"kind": "TimeSeriesChart", "spec": plugin_spec or {}},
            "queries": [query(q) for q in queries],
        },
    }


def dashboard(name: str, panels: dict[str, Any], variables: list[str]) -> dict[str, Any]:
    return {
        "kind": "Dashboard",
        "metadata": {"name": name, "project": "p"},
        "spec": {
            "variables": [{"kind": "ListVariable", "spec": {"name": v}} for v in variables],
            "panels": panels,
        },
    }


def write_run(tmp_path: Path, dashboards: list[dict[str, Any]]) -> Path:
    run = tmp_path / "run"
    (run / "dashboards").mkdir(parents=True)
    entries = []
    for d in dashboards:
        path = f"dashboards/{d['metadata']['name']}.json"
        (run / path).write_text(json.dumps(d), encoding="utf-8")
        entries.append({"kind": "dashboard", "path": path})
    entries.append({"kind": "source", "path": "source/x.json"})
    (run / "manifest.json").write_text(json.dumps({"entries": entries}), encoding="utf-8")
    return run


@pytest.fixture
def run(tmp_path: Path) -> Path:
    return write_run(
        tmp_path,
        [
            dashboard(
                "pg",
                {
                    "widget-10": panel([GAUGE_Q]),
                    "widget-2": panel([RATE_Q, GAUGE_Q]),
                    "widget-3": panel([PCT_Q], {"yAxis": {"format": {"unit": "percent"}}}),
                    "widget-4": {"kind": "Panel", "spec": {"plugin": {"kind": "Markdown"}}},
                },
                ["db"],
            ),
            dashboard("host", {"widget-0": panel([GAUGE_Q])}, []),
        ],
    )


def matrix(*series: list[str]) -> HttpResponse:
    result = [
        {"metric": {"i": str(i)}, "values": [[1.0 + n, v] for n, v in enumerate(values)]}
        for i, values in enumerate(series)
    ]
    body = {"status": "success", "data": {"resultType": "matrix", "result": result}}
    return HttpResponse(200, json.dumps(body).encode())


Reply = HttpResponse | BaseException


class FakeSend:
    """Fake HTTP opener: answers by the sent PromQL; unknown queries get one series of 1."""

    def __init__(self, replies: dict[str, Reply] | None = None) -> None:
        self.replies = replies or {}
        self.requests: list[HttpRequest] = []

    def __call__(self, req: HttpRequest) -> HttpResponse:
        self.requests.append(req)
        reply = self.replies.get(self.params(req)["query"], matrix(["1"]))
        if isinstance(reply, BaseException):
            raise reply
        return reply

    @staticmethod
    def params(req: HttpRequest) -> dict[str, str]:
        return {k: v[0] for k, v in parse_qs(urlsplit(req.url).query).items()}


SENT_RATE = sc.substitute(RATE_Q, ["db"])


def smoke(
    run: Path, send: FakeSend, env: dict[str, str] | None = None, argv: list[str] = WINDOW
) -> tuple[int, dict[str, Any]]:
    code = sc.main([str(run), *argv], env=ENV if env is None else env, send=send)
    return code, json.loads((run / "smoke.json").read_text(encoding="utf-8"))


def by_query(doc: dict[str, Any], text: str) -> dict[str, Any]:
    """The first pg entry with this query (GAUGE_Q appears in two panels)."""
    return next(p for p in doc["panels"] if p["query"] == text and p["dashboard"] == "pg")


# --------------------------------------------------------------------------- substitutions


def test_substitutes_rate_interval_and_promoted_variables() -> None:
    assert SENT_RATE == 'sum by (db) (rate({otel_metric_name="pg.rows", db=~"^(.*)$"}[5m]))'
    assert sc.substitute('x{a=~"${db}"}', ["db"]) == 'x{a=~".*"}'


def test_substitution_leaves_longer_names_and_unknown_variables() -> None:
    assert sc.substitute('x{a=~"$db_name", b=~"$host"}', ["db"]) == 'x{a=~"$db_name", b=~"$host"}'


def test_sends_substituted_query_as_read_only_get(run: Path) -> None:
    send = FakeSend()
    smoke(run, send)
    req = next(r for r in send.requests if FakeSend.params(r)["query"] == SENT_RATE)
    assert req.method == "GET" and req.body is None
    assert req.url.startswith(
        "https://api.eu-west-1.aws.dash0.com/api/prometheus/api/v1/query_range?"
    )
    assert FakeSend.params(req) == {
        "query": SENT_RATE,
        "start": "2026-11-07T14:05:00Z",
        "end": "2026-11-07T15:21:00Z",
        "step": "60s",
    }
    assert req.headers["Authorization"] == f"Bearer {TOKEN}"
    assert req.headers["Dash0-Dataset"] == "default"


def test_env_overrides_api_url_and_dataset(run: Path) -> None:
    send = FakeSend()
    env = {**ENV, "DASH0_API_URL": "https://api.example.test/", "DASH0_DATASET": "demo"}
    _, doc = smoke(run, send, env)
    assert doc["dataset"] == "demo"
    assert send.requests[0].url.startswith("https://api.example.test/api/prometheus/")
    assert send.requests[0].headers["Dash0-Dataset"] == "demo"


# --------------------------------------------------------------------------- flags


def test_clean_run_records_series_min_max_and_exits_0(run: Path) -> None:
    send = FakeSend({SENT_RATE: matrix(["0", "2.5"], ["1"])})
    code, doc = smoke(run, send)
    assert code == 0
    assert by_query(doc, SENT_RATE) == {
        "dashboard": "pg",
        "panel": "widget-2",
        "query": SENT_RATE,
        "series": 2,
        "min": 0.0,
        "max": 2.5,
        "flags": [],
        "error": None,
    }


def test_no_data(run: Path) -> None:
    code, doc = smoke(run, FakeSend({GAUGE_Q: matrix()}))
    assert code == 1
    entry = by_query(doc, GAUGE_Q)
    assert (entry["series"], entry["min"], entry["max"]) == (0, None, None)
    assert entry["flags"] == ["no_data"]


@pytest.mark.parametrize("bad", ["NaN", "+Inf", "-Inf"])
def test_nan_and_inf(run: Path, bad: str) -> None:
    code, doc = smoke(run, FakeSend({GAUGE_Q: matrix(["3", bad, "4"])}))
    assert code == 1
    entry = by_query(doc, GAUGE_Q)
    assert (entry["min"], entry["max"], entry["flags"]) == (3.0, 4.0, ["nan"])


def test_negative_only_for_rate_or_count(run: Path) -> None:
    replies: dict[str, Reply] = {SENT_RATE: matrix(["-1"]), GAUGE_Q: matrix(["-5"])}
    code, doc = smoke(run, FakeSend(replies))
    assert code == 1
    assert by_query(doc, SENT_RATE)["flags"] == ["negative"]
    assert by_query(doc, GAUGE_Q)["flags"] == []


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("rate(x[5m])", True),
        ("sum(irate(x[5m]))", True),
        ("increase(x[1h])", True),
        ("count by (a) (x)", True),
        ("count_over_time(x[5m])", True),
        ('{otel_metric_name="a.rate(", b="count by"}', False),
        ('{otel_metric_name="tup_rate"}', False),
        ("max(x)", False),
    ],
)
def test_is_rate_or_count(text: str, expected: bool) -> None:
    assert sc.is_rate_or_count(text) is expected


def test_percent_out_of_range_only_for_percent_unit(run: Path) -> None:
    replies: dict[str, Reply] = {PCT_Q: matrix(["99", "100.5"]), GAUGE_Q: matrix(["250"])}
    code, doc = smoke(run, FakeSend(replies))
    assert code == 1
    assert by_query(doc, PCT_Q)["flags"] == ["percent_out_of_range"]
    assert by_query(doc, GAUGE_Q)["flags"] == []


def test_percent_unit_on_stat_chart_format(tmp_path: Path) -> None:
    stat = panel([PCT_Q], {"format": {"unit": "percent"}})
    run = write_run(tmp_path, [dashboard("pg", {"widget-0": stat}, [])])
    _, doc = smoke(run, FakeSend({PCT_Q: matrix(["101"])}))
    assert doc["panels"][0]["flags"] == ["percent_out_of_range"]


def test_flags_combine_in_fixed_order(run: Path) -> None:
    _, doc = smoke(run, FakeSend({SENT_RATE: matrix(["NaN", "-2"])}))
    assert by_query(doc, SENT_RATE)["flags"] == ["nan", "negative"]


@pytest.mark.parametrize(
    "reply",
    [
        HttpResponse(400, b'{"status":"error","errorType":"bad_data","error":"parse error"}'),
        HttpResponse(401, f"bad token {TOKEN}".encode()),
        HttpResponse(200, b"not json"),
        HttpResponse(200, b'{"status":"success","data":{"resultType":"vector","result":[]}}'),
        HttpResponse(200, b'{"status":"success","data":{"resultType":"matrix","result":[{}]}}'),
        HttpTransportError(f"TimeoutError: timed out {TOKEN}"),
    ],
)
def test_query_error(run: Path, reply: Reply, capsys: pytest.CaptureFixture[str]) -> None:
    code, doc = smoke(run, FakeSend({GAUGE_Q: reply}))
    assert code == 1
    entry = by_query(doc, GAUGE_Q)
    assert entry["flags"] == ["query_error"]
    assert (entry["series"], entry["min"], entry["max"]) == (None, None, None)
    assert entry["error"]
    out = capsys.readouterr()
    assert TOKEN not in (run / "smoke.json").read_text() + out.out + out.err


# --------------------------------------------------------------------------- output


def test_output_sorted_and_byte_identical(run: Path, capsys: pytest.CaptureFixture[str]) -> None:
    replies: dict[str, Reply] = {SENT_RATE: matrix(["0.25", "7"]), GAUGE_Q: matrix(["1"])}
    smoke(run, FakeSend(replies))
    first = (run / "smoke.json").read_bytes()
    lines = capsys.readouterr().out.splitlines()
    smoke(run, FakeSend(replies))
    assert (run / "smoke.json").read_bytes() == first

    doc = json.loads(first)
    assert doc["window"] == {"start": "2026-11-07T14:05:00Z", "end": "2026-11-07T15:21:00Z"}
    assert [(p["dashboard"], p["panel"]) for p in doc["panels"]] == [
        ("host", "widget-0"),
        ("pg", "widget-2"),
        ("pg", "widget-2"),
        ("pg", "widget-3"),
        ("pg", "widget-10"),
    ]
    assert [p["query"] for p in doc["panels"]][1:3] == [SENT_RATE, GAUGE_Q]
    assert lines == [
        "host widget-0#0 series=1 min=1 max=1 flags=-",
        "pg widget-2#0 series=1 min=0.25 max=7 flags=-",
        "pg widget-2#1 series=1 min=1 max=1 flags=-",
        "pg widget-3#0 series=1 min=1 max=1 flags=-",
        "pg widget-10#0 series=1 min=1 max=1 flags=-",
    ]


def test_default_window_is_the_hour_before_now(run: Path) -> None:
    now = dt.datetime(2026, 11, 7, 15, 21, 30, 999, tzinfo=dt.UTC)
    sc.main([str(run)], env=ENV, send=FakeSend(), now=now)
    doc = json.loads((run / "smoke.json").read_text())
    assert doc["window"] == {"start": "2026-11-07T14:21:30Z", "end": "2026-11-07T15:21:30Z"}


@pytest.mark.parametrize(
    ("env", "argv", "message"),
    [
        ({}, WINDOW, "missing env: DASH0_AUTH_TOKEN"),
        (ENV, [*WINDOW, "--step", "1 minute"], "--step"),
        (ENV, ["--start", "2026-11-07T15:00:00Z", "--end", "2026-11-07T14:00:00Z"], "before"),
        (ENV, ["--start", "yesterday"], "Invalid isoformat"),
    ],
)
def test_usage_errors_exit_2_without_requests(
    run: Path,
    env: dict[str, str],
    argv: list[str],
    message: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    send = FakeSend()
    assert sc.main([str(run), *argv], env=env, send=send) == 2
    assert send.requests == []
    assert not (run / "smoke.json").exists()
    assert message in capsys.readouterr().err


def test_missing_run_dir_exits_2(tmp_path: Path) -> None:
    assert sc.main([str(tmp_path / "nope"), *WINDOW], env=ENV, send=FakeSend()) == 2
