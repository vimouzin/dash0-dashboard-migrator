from __future__ import annotations

from pathlib import Path

import pytest

from migrator.http import HttpRequest, HttpResponse, HttpTransportError
from migrator.input import InputError
from migrator.source.asset import FetchSelection, SourceFetchError
from migrator.source.datadog.api import (
    fetch_datadog_assets,
    read_datadog_config,
)
from migrator.source.provider import get_provider

API_KEY = "ddapi_SECRET_1"
APP_KEY = "ddapp_SECRET_2"
ENV = {"DD_API_KEY": API_KEY, "DD_APP_KEY": APP_KEY}


class FakeSend:
    def __init__(self, responses: dict[str, HttpResponse | Exception]) -> None:
        self.responses = responses
        self.requests: list[HttpRequest] = []

    def __call__(self, req: HttpRequest) -> HttpResponse:
        self.requests.append(req)
        res = self.responses[req.url]
        if isinstance(res, Exception):
            raise res
        return res


DASH_URL = "https://api.datadoghq.eu/api/v1/dashboard/abc-123"
MON_URL = "https://api.datadoghq.eu/api/v1/monitor/42"
DASH_BYTES = b'{"title":"T",  "widgets":[]}\n'  # odd spacing: bytes must survive exactly
MON_BYTES = b'{"id":42}'


def test_config_missing_names_only() -> None:
    with pytest.raises(InputError, match="^missing env: DD_API_KEY, DD_APP_KEY$"):
        read_datadog_config({})


def test_config_site_default_and_custom() -> None:
    assert read_datadog_config(ENV).base_url == "https://api.datadoghq.eu"
    assert read_datadog_config({**ENV, "DD_SITE": "us5.datadoghq.com"}).base_url == (
        "https://api.us5.datadoghq.com"
    )


@pytest.mark.parametrize("site", ["evil.com/x", "https://datadoghq.eu", "a..b", "UPPER.com"])
def test_config_rejects_unsafe_site(site: str) -> None:
    with pytest.raises(InputError, match="DD_SITE"):
        read_datadog_config({**ENV, "DD_SITE": site})


def test_fetch_writes_exact_bytes_and_sends_keys(tmp_path: Path) -> None:
    send = FakeSend(
        {DASH_URL: HttpResponse(200, DASH_BYTES), MON_URL: HttpResponse(200, MON_BYTES)}
    )
    out = tmp_path / "out"
    written = fetch_datadog_assets(FetchSelection(("abc-123",), ("42",)), ENV, out, send)
    assert written == ["dashboards/abc-123.json", "monitors/42.json"]
    assert (out / "dashboards/abc-123.json").read_bytes() == DASH_BYTES
    assert (out / "monitors/42.json").read_bytes() == MON_BYTES
    req = send.requests[0]
    assert req.method == "GET"
    assert req.headers["DD-API-KEY"] == API_KEY
    assert req.headers["DD-APPLICATION-KEY"] == APP_KEY
    assert req.timeout == 30.0


@pytest.mark.parametrize(
    ("sel", "match"),
    [
        (FetchSelection(), "at least one"),
        (FetchSelection(("../etc",)), "invalid dashboard id"),
        (FetchSelection((), ("4 2",)), "invalid monitor id"),
        (FetchSelection(("a", "a")), "duplicate dashboard id: a"),
    ],
)
def test_validation_happens_before_any_request(
    tmp_path: Path, sel: FetchSelection, match: str
) -> None:
    send = FakeSend({})
    with pytest.raises(InputError, match=match):
        fetch_datadog_assets(sel, ENV, tmp_path / "out", send)
    assert send.requests == []


def test_non_empty_out_dir_rejected_before_request(tmp_path: Path) -> None:
    (tmp_path / "x").write_text("x")
    send = FakeSend({})
    with pytest.raises(InputError, match="not empty"):
        fetch_datadog_assets(FetchSelection(("a",)), ENV, tmp_path, send)
    assert send.requests == []


@pytest.mark.parametrize(
    ("status", "hint"),
    [
        (401, "API key is missing or invalid"),
        (403, "needs the dashboards_read scope"),
        (404, "not found"),
        (429, "rate limited"),
        (500, "request failed"),
    ],
)
def test_http_errors_explain_and_redact(tmp_path: Path, status: int, hint: str) -> None:
    body = f"keys {API_KEY} {APP_KEY} " + "y" * 2000
    send = FakeSend({DASH_URL: HttpResponse(status, body.encode())})
    with pytest.raises(SourceFetchError, match=f"HTTP {status}") as info:
        fetch_datadog_assets(FetchSelection(("abc-123",)), ENV, tmp_path / "out", send)
    msg = str(info.value)
    assert hint in msg
    assert API_KEY not in msg and APP_KEY not in msg
    assert len(msg.split("body: ", 1)[1]) == 500


def test_nothing_written_when_a_later_request_fails(tmp_path: Path) -> None:
    send = FakeSend({DASH_URL: HttpResponse(200, DASH_BYTES), MON_URL: HttpResponse(404, b"")})
    out = tmp_path / "out"
    with pytest.raises(SourceFetchError):
        fetch_datadog_assets(FetchSelection(("abc-123",), ("42",)), ENV, out, send)
    assert not out.exists() or not any(out.iterdir())


def test_transport_error_is_redacted(tmp_path: Path) -> None:
    send = FakeSend({DASH_URL: HttpTransportError(f"reset {API_KEY}")})
    with pytest.raises(SourceFetchError) as info:
        fetch_datadog_assets(FetchSelection(("abc-123",)), ENV, tmp_path / "out", send)
    assert API_KEY not in str(info.value)


def test_datadog_provider_exposes_fetch() -> None:
    assert callable(getattr(get_provider("datadog"), "fetch", None))
