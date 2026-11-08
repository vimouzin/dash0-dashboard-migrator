"""Literal credential loading and PAT authentication, with no real credentials."""

from __future__ import annotations

import json
from typing import Any

import live_compare_support.credentials as credentials  # type: ignore[import-not-found]
import live_compare_support.queries as queries  # type: ignore[import-not-found]
import live_compare_support.runner as runner  # type: ignore[import-not-found]
import pytest

from migrator.http import HttpRequest, HttpResponse
from migrator.input import InputError
from tests.scripts.test_live_compare_run import Clock, DockerStub, Vendors, args


def test_dotenv_quotes_comments_aliases_and_unrelated_credentials(tmp_path):
    path = tmp_path / ".env"
    path.write_text(
        'export DATADOG_PAT="token#literal" # comment\n'
        "DASH0_AUTH_TOKEN='dash token'\nDD_API_KEY=key#literal # comment\n"
        "ANTHROPIC_API_KEY=unused-secret\n"
    )
    values = credentials.read_env_file(path)
    assert values["DD_BEARER_TOKEN"] == "token#literal"
    assert values["DASH0_AUTH_TOKEN"] == "dash token"
    assert values["DD_API_KEY"] == "key#literal"
    assert "ANTHROPIC_API_KEY" not in values


def test_dotenv_never_executes_or_interpolates_values(tmp_path):
    marker = tmp_path / "must-not-exist"
    path = tmp_path / ".env"
    value = f"$(touch {marker})"
    path.write_text(f"DATADOG_PAT={value}\nDASH0_AUTH_TOKEN='${{HOME}}`whoami`'\n")
    values = credentials.read_env_file(path)
    assert values["DD_BEARER_TOKEN"] == value
    assert values["DASH0_AUTH_TOKEN"] == "${HOME}`whoami`"
    assert not marker.exists()


def test_shell_overrides_file_including_pat_alias(tmp_path):
    path = tmp_path / ".env"
    path.write_text("DD_BEARER_TOKEN=file-token\nDASH0_AUTH_TOKEN=file-dash\n")
    values = credentials.load_environment(
        {"DATADOG_PAT": "shell-token", "DASH0_AUTH_TOKEN": "shell-dash"}, path
    )
    assert values["DD_BEARER_TOKEN"] == "shell-token"
    assert values["DASH0_AUTH_TOKEN"] == "shell-dash"
    assert values["DASH0_API_URL"] == "https://api.eu-west-1.aws.dash0.com"


@pytest.mark.parametrize(
    "line",
    ['DATADOG_PAT="private-secret', "DATADOG_PAT=secret\nDATADOG_PAT=other-secret", "DD_API_KEY"],
)
def test_invalid_assignments_do_not_echo_values(tmp_path, line):
    path = tmp_path / ".env"
    path.write_text(line)
    with pytest.raises(InputError) as error:
        credentials.read_env_file(path)
    assert "secret" not in str(error.value)


def test_pat_query_config_does_not_require_application_key_or_expose_token():
    cfg = credentials.read_query_config({"DATADOG_PAT": "fake-private-pat"})
    assert cfg.headers == {"Authorization": "Bearer fake-private-pat"}
    assert cfg.base_url == "https://api.datadoghq.eu"
    assert "fake-private-pat" not in repr(cfg)


def test_blank_template_bearer_does_not_hide_configured_pat():
    cfg = credentials.read_query_config({"DD_BEARER_TOKEN": "", "DATADOG_PAT": "private-pat"})
    assert cfg.headers == {"Authorization": "Bearer private-pat"}


def test_legacy_query_keys_still_work():
    cfg = credentials.read_query_config({"DD_API_KEY": "api", "DD_APP_KEY": "app"})
    assert cfg.headers == {"DD-API-KEY": "api", "DD-APPLICATION-KEY": "app"}


def test_pat_header_used_only_for_queries_and_api_key_for_ingestion_validation():
    requests: list[HttpRequest] = []

    def send(request: HttpRequest) -> HttpResponse:
        requests.append(request)
        if request.url.endswith("/validate"):
            return HttpResponse(200, b'{"valid":true}')
        body = {
            "data": {
                "type": "timeseries_response",
                "attributes": {
                    "series": [],
                    "times": [],
                    "values": [],
                },
            }
        }
        return HttpResponse(200, json.dumps(body).encode())

    cfg = credentials.read_query_config({"DATADOG_PAT": "private-pat"})
    queries.query_source(queries.BoundQuery([], "a", "unused"), 0, 60, 60, cfg, send)
    queries.validate_ingestion_key("private-api-key", cfg, send)
    assert requests[0].headers["Authorization"] == "Bearer private-pat"
    assert requests[1].headers == {"DD-API-KEY": "private-api-key"}


def test_dotenv_cli_uses_pat_and_records_precise_missing_ingestion_key(tmp_path):
    path = tmp_path / ".env"
    path.write_text("DATADOG_PAT=private-pat\nDASH0_AUTH_TOKEN=private-dash\n")
    vendors, clock = Vendors(), Clock()
    out = tmp_path / "run"
    DockerStub.calls = []
    assert (
        runner.main(
            args(out, "--env-file", str(path)), {}, vendors.send, DockerStub, clock.now, clock.sleep
        )
        == 1
    )
    report = json.loads((out / "comparison.json").read_text())
    assert report["authentication"] == {"datadogQuery": "passed", "dash0Query": "passed"}
    assert "DD_API_KEY in .env" in report["error"]
    assert "start" not in DockerStub.calls and not vendors.imports()
    assert "private-pat" not in json.dumps(report) and "private-dash" not in json.dumps(report)


def test_dotenv_pat_and_ingestion_key_complete_fake_run(tmp_path):
    path = tmp_path / ".env"
    path.write_text(
        "DATADOG_PAT=private-pat\nDD_API_KEY=private-key\nDASH0_AUTH_TOKEN=private-dash\n"
    )
    vendors, clock = Vendors(), Clock()
    DockerStub.calls, DockerStub.interrupt = [], False
    assert (
        runner.main(
            args(tmp_path / "run", "--env-file", str(path)),
            {},
            vendors.send,
            DockerStub,
            clock.now,
            clock.sleep,
        )
        == 0
    )
    assert len(vendors.imports()) == 2


def test_default_dotenv_loaded_without_mutating_process_environment(tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text("DATADOG_PAT=file-pat\nDASH0_AUTH_TOKEN=file-dash\n")
    monkeypatch.setattr(runner, "ROOT", tmp_path)
    monkeypatch.setattr(runner.os, "environ", {})
    captured: dict[str, Any] = {}

    def capture(cli: Any, env: dict[str, str], *rest: Any) -> int:
        captured.update(env)
        return 0

    monkeypatch.setattr(runner, "execute", capture)
    assert runner.main(args(tmp_path / "run")) == 0
    assert captured["DD_BEARER_TOKEN"] == "file-pat"
    assert not runner.os.environ
    captured.clear()
    assert runner.main(args(tmp_path / "run", "--no-env-file")) == 0
    assert "DD_BEARER_TOKEN" not in captured


def test_all_credential_aliases_redacted():
    values = {
        "DATADOG_PAT": "pat-secret",
        "DD_BEARER_TOKEN": "bearer-secret",
        "DD_API_KEY": "api-secret",
        "DD_APP_KEY": "app-secret",
        "DASH0_AUTH_TOKEN": "dash-secret",
    }
    message = runner.redact(" ".join(values.values()), values)
    assert all(value not in message for value in values.values())
