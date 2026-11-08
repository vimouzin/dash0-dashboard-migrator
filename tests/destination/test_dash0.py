from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest

from migrator.destination.dash0 import (
    Dash0Config,
    Failed,
    Imported,
    Unknown,
    publish_check_rule,
    publish_dashboard,
    read_back,
    read_dash0_config,
)
from migrator.http import HttpRequest, HttpResponse, HttpTransportError
from migrator.input import InputError
from migrator.target import Dash0CheckRule, PersesDashboard

TOKEN = "auth_secret_TOKEN_123"
CFG = Dash0Config(api_url="https://api.example.dash0.com", token=TOKEN, dataset="my data/set")

DASHBOARD = cast(PersesDashboard, {"kind": "Dashboard", "metadata": {"name": "d"}, "spec": {}})
RULE = cast(
    Dash0CheckRule,
    {"name": "r", "expression": "up == 0", "thresholds": {"failed": 1}, "interval": "1m"},
)


class FakeSend:
    """Replays responses in order; the last one repeats."""

    def __init__(self, *responses: HttpResponse | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[HttpRequest] = []

    def __call__(self, req: HttpRequest) -> HttpResponse:
        self.requests.append(req)
        response = self.responses[min(len(self.requests), len(self.responses)) - 1]
        if isinstance(response, Exception):
            raise response
        return response


def ok(body: Any, status: int = 200) -> FakeSend:
    return FakeSend(HttpResponse(status, json.dumps(body).encode()))


def raw(status: int, text: str) -> FakeSend:
    return FakeSend(HttpResponse(status, text.encode()))


def listing(*items: tuple[str, str]) -> HttpResponse:
    body = [{"id": i, "name": n, "dataset": "default"} for i, n in items]
    return HttpResponse(200, json.dumps(body).encode())


# The live import response (2026-11-07): the stored dashboard, with no id in it.
IMPORTED_BODY = HttpResponse(
    200, json.dumps({**DASHBOARD, "metadata": {"name": "d", "version": 1}}).encode()
)


def dash_send(import_response: HttpResponse | Exception) -> FakeSend:
    """List (old "d" exists) -> import -> list (one new "d")."""
    return FakeSend(
        listing(("old", "d"), ("x", "other")),
        import_response,
        listing(("old", "d"), ("x", "other"), ("new", "d")),
    )


# --- config -----------------------------------------------------------------


def test_config_reports_missing_names_only() -> None:
    with pytest.raises(InputError, match="^missing env: DASH0_AUTH_TOKEN, DASH0_DATASET$"):
        read_dash0_config({"DASH0_API_URL": "https://x", "DASH0_AUTH_TOKEN": " "})


def test_config_strips_trailing_slash() -> None:
    cfg = read_dash0_config(
        {"DASH0_API_URL": "https://x.dash0.com/", "DASH0_AUTH_TOKEN": "t", "DASH0_DATASET": "d"}
    )
    assert cfg == Dash0Config("https://x.dash0.com", "t", "d")


def test_config_rejects_non_http_url() -> None:
    with pytest.raises(InputError, match="http"):
        read_dash0_config(
            {"DASH0_API_URL": "ftp://x", "DASH0_AUTH_TOKEN": "t", "DASH0_DATASET": "d"}
        )


# --- publish ----------------------------------------------------------------


def test_dashboard_request_shape() -> None:
    send = dash_send(IMPORTED_BODY)
    assert publish_dashboard(DASHBOARD, CFG, send) == Imported(id="new", http_status=200)
    before, req, after = send.requests
    for listed in (before, after):
        assert listed.method == "GET"
        assert listed.url == "https://api.example.dash0.com/api/dashboards?dataset=my%20data%2Fset"
        assert listed.body is None
    assert req.method == "POST"
    assert req.url == "https://api.example.dash0.com/api/import/dashboard?dataset=my%20data%2Fset"
    assert req.headers["Authorization"] == f"Bearer {TOKEN}"
    assert req.headers["Accept"] == "application/json"
    assert req.headers["Content-Type"] == "application/json"
    assert req.timeout == 30.0
    assert req.body is not None and json.loads(req.body) == DASHBOARD


def test_check_rule_request_and_id() -> None:
    send = ok({"id": "rule-1"}, status=201)
    assert publish_check_rule(RULE, CFG, send) == Imported(id="rule-1", http_status=201)
    assert send.requests[0].url.startswith(
        "https://api.example.dash0.com/api/import/check-rule?dataset="
    )


def test_refuses_dashboard_with_dash0_extensions_before_request() -> None:
    send = ok({})
    body = cast(PersesDashboard, {"metadata": {"name": "d", "dash0Extensions": {"id": "x"}}})
    with pytest.raises(InputError, match="create-only"):
        publish_dashboard(body, CFG, send)
    assert send.requests == []


def test_refuses_check_rule_with_id_before_request() -> None:
    send = ok({})
    body = cast(Dash0CheckRule, {**RULE, "id": "x"})
    with pytest.raises(InputError, match="create-only"):
        publish_check_rule(body, CFG, send)
    assert send.requests == []


def test_refuses_dashboard_without_name_before_request() -> None:
    send = ok([])
    with pytest.raises(InputError, match="metadata.name"):
        publish_dashboard(cast(PersesDashboard, {"metadata": {}, "spec": {}}), CFG, send)
    assert send.requests == []


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_server_errors_are_unknown(status: int) -> None:
    # The asset may already exist, so a 5xx must never allow a blind republish.
    out = publish_dashboard(DASHBOARD, CFG, dash_send(HttpResponse(status, b"server error")))
    assert isinstance(out, Unknown)
    assert f"HTTP {status}" in out.message
    out = publish_check_rule(RULE, CFG, raw(status, "server error"))
    assert isinstance(out, Unknown)


def test_transport_error_is_unknown() -> None:
    send = dash_send(HttpTransportError("TimeoutError: timed out"))
    out = publish_dashboard(DASHBOARD, CFG, send)
    assert isinstance(out, Unknown)
    assert "may or may not exist" in out.message
    assert len(send.requests) == 2  # no listing after an ambiguous import


def test_other_non_2xx_is_failed_and_clipped() -> None:
    out = publish_dashboard(DASHBOARD, CFG, dash_send(HttpResponse(400, b"x" * 2000)))
    assert isinstance(out, Failed)
    assert out.http_status == 400
    assert len(out.message) == 500


def test_unauthorized_is_failed_with_status_401() -> None:
    out = publish_check_rule(RULE, CFG, raw(401, "unauthorized"))
    assert isinstance(out, Failed)
    assert out.http_status == 401


def test_redirect_status_is_failed() -> None:
    out = publish_dashboard(DASHBOARD, CFG, dash_send(HttpResponse(302, b"")))
    assert isinstance(out, Failed)
    assert out.http_status == 302


def test_non_json_2xx_is_unknown() -> None:
    out = publish_dashboard(DASHBOARD, CFG, dash_send(HttpResponse(200, b"<html>")))
    assert isinstance(out, Unknown)


# --- dashboard id discovery (the import response has no id) -------------------


@pytest.mark.parametrize(
    "first",
    [HttpResponse(401, b"unauthorized"), HttpResponse(403, b"forbidden")],
)
def test_listing_auth_failure_before_import_is_failed_and_sends_nothing(
    first: HttpResponse,
) -> None:
    send = FakeSend(first, IMPORTED_BODY)
    out = publish_dashboard(DASHBOARD, CFG, send)
    assert isinstance(out, Failed)
    assert out.http_status == first.status  # 401/403 still stops the run
    assert "nothing was imported" in out.message
    assert [r.method for r in send.requests] == ["GET"]


@pytest.mark.parametrize(
    "first",
    [HttpTransportError("down"), HttpResponse(200, b"{}"), HttpResponse(200, b"[1]")],
)
def test_listing_error_before_import_is_failed_and_sends_nothing(
    first: HttpResponse | Exception,
) -> None:
    send = FakeSend(first, IMPORTED_BODY)
    out = publish_dashboard(DASHBOARD, CFG, send)
    assert isinstance(out, Failed)
    assert [r.method for r in send.requests] == ["GET"]


@pytest.mark.parametrize(
    "after",
    [
        listing(("old", "d")),  # nothing new
        listing(("old", "d"), ("n1", "d"), ("n2", "d")),  # two new: ambiguous
        HttpResponse(500, b"down"),
        HttpTransportError("reset"),
    ],
)
def test_import_without_exactly_one_new_dashboard_is_unknown(
    after: HttpResponse | Exception,
) -> None:
    send = FakeSend(listing(("old", "d")), IMPORTED_BODY, after)
    out = publish_dashboard(DASHBOARD, CFG, send)
    assert isinstance(out, Unknown)
    assert "reconcile" in out.message
    assert [r.method for r in send.requests] == ["GET", "POST", "GET"]


def test_new_dashboard_ignores_other_names() -> None:
    send = FakeSend(listing(), IMPORTED_BODY, listing(("n1", "other"), ("n2", "d")))
    assert publish_dashboard(DASHBOARD, CFG, send) == Imported(id="n2", http_status=200)


def test_check_rule_2xx_without_id_is_unknown() -> None:
    out = publish_check_rule(RULE, CFG, ok({"name": "r"}))
    assert isinstance(out, Unknown)
    assert "no id at id" in out.message


def test_empty_id_is_unknown() -> None:
    assert isinstance(publish_check_rule(RULE, CFG, ok({"id": ""})), Unknown)


@pytest.mark.parametrize(
    "send",
    [
        raw(401, f"invalid token {TOKEN}"),
        raw(502, f"echo {TOKEN}"),
        raw(200, f"not json {TOKEN}"),
        FakeSend(HttpTransportError(f"reset while sending {TOKEN}")),
    ],
)
def test_token_never_leaks_into_outcome(send: FakeSend) -> None:
    out = publish_check_rule(RULE, CFG, send)
    assert not isinstance(out, Imported)
    assert TOKEN not in out.message
    assert "<redacted>" in out.message


@pytest.mark.parametrize(
    "send",
    [
        FakeSend(HttpResponse(401, f"invalid token {TOKEN}".encode())),
        FakeSend(listing(), HttpResponse(502, f"echo {TOKEN}".encode())),
        FakeSend(listing(), IMPORTED_BODY, HttpResponse(500, f"list {TOKEN}".encode())),
    ],
)
def test_token_never_leaks_from_dashboard_publish(send: FakeSend) -> None:
    out = publish_dashboard(DASHBOARD, CFG, send)
    assert not isinstance(out, Imported)
    assert TOKEN not in out.message
    assert "<redacted>" in out.message


# --- read-back --------------------------------------------------------------


def test_read_back_dashboard_url_and_body() -> None:
    send = ok({"kind": "Dashboard"})
    assert read_back("dashboard", "a/b", CFG, send) == {"kind": "Dashboard"}
    (req,) = send.requests
    assert req.method == "GET"
    assert req.url == "https://api.example.dash0.com/api/dashboards/a%2Fb?dataset=my%20data%2Fset"
    assert "Content-Type" not in req.headers


def test_read_back_check_rule_url() -> None:
    send = ok({"id": "r"})
    read_back("check-rule", "r", CFG, send)
    assert "/api/alerting/check-rules/r?" in send.requests[0].url


def test_read_back_failure_is_redacted() -> None:
    with pytest.raises(RuntimeError, match="HTTP 404") as info:
        read_back("dashboard", "x", CFG, raw(404, f"nope {TOKEN}"))
    assert TOKEN not in str(info.value)


def test_read_back_transport_error_raises() -> None:
    with pytest.raises(RuntimeError, match="read-back"):
        read_back("dashboard", "x", CFG, FakeSend(HttpTransportError("down")))


# --- recorded live responses (plan 07 Task 1, 2026-11-07) ----------------------

LIVE = Path(__file__).resolve().parents[2] / "fixtures" / "dash0" / "live-2026-11-07"


def _live(name: str) -> Any:
    return json.loads((LIVE / name).read_text(encoding="utf-8"))


def _resp(body: Any) -> HttpResponse:
    return HttpResponse(200, json.dumps(body).encode())


def test_live_dashboard_import_response_has_no_id_and_listing_finds_it() -> None:
    imported = _live("dashboard-import-response.json")
    after = _live("dashboards-list-after-import.json")
    assert "id" not in json.dumps(imported["metadata"])  # why the listing is needed
    name = imported["metadata"]["name"]
    before = [i for i in after if i["name"] != name]
    body = cast(PersesDashboard, {"kind": "Dashboard", "metadata": {"name": name}, "spec": {}})
    send = FakeSend(_resp(before), _resp(imported), _resp(after))
    out = publish_dashboard(body, CFG, send)
    assert out == Imported(id="eebfaf39-969d-4fe3-b379-9234d77e1937", http_status=200)


def test_live_check_rule_import_response_carries_the_id() -> None:
    send = FakeSend(_resp(_live("check-rule-import-response.json")))
    out = publish_check_rule(RULE, CFG, send)
    assert out == Imported(id="987f6f55-cda3-4afe-b742-71d68b42e267", http_status=200)
