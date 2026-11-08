"""Dash0 HTTP client: import and read-back only. No translation logic here.

Create-only: never sends metadata.dash0Extensions or a check-rule id. No retries.
An ambiguous result (transport error, any 5xx, a 2xx without an id) is "unknown",
which the receipts (07.T3) refuse to republish.

Verified live on 2026-11-07 (plan 07 Task 1): POST /api/import/check-rule returns
the rule with its new id at "id". POST /api/import/dashboard returns the stored
dashboard *without* any id, so the id is found by listing GET /api/dashboards
(items {id, name, dataset}, name = metadata.name) before and after the import and
taking the one new item with the dashboard's metadata.name.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote, urlsplit

from migrator.http import (
    HttpRequest,
    HttpResponse,
    HttpSend,
    HttpTransportError,
    urllib_send,
)
from migrator.input import InputError
from migrator.target import Dash0CheckRule, PersesDashboard

# Verified live (plan 07 Task 1): the check-rule import response carries the id here.
CHECK_RULE_ID_PATH: tuple[str, ...] = ("id",)

REQUEST_TIMEOUT_S = 30.0
MESSAGE_MAX = 500
# A 5xx means the request reached a server (Dash0 or a proxy in front of it) that
# then failed; Dash0 may already have created the asset. Only a 4xx is a definite
# rejection that created nothing, so only a 4xx may be republished.
AMBIGUOUS_STATUS_MIN = 500
_ENV_NAMES = ("DASH0_API_URL", "DASH0_AUTH_TOKEN", "DASH0_DATASET")

ImportKind = Literal["dashboard", "check-rule"]


@dataclass(frozen=True)
class Dash0Config:
    api_url: str
    token: str
    dataset: str


@dataclass(frozen=True)
class Imported:
    id: str
    http_status: int
    status: Literal["imported"] = "imported"


@dataclass(frozen=True)
class Failed:
    http_status: int | None  # None: nothing was sent (e.g. the pre-import listing failed)
    message: str
    status: Literal["failed"] = "failed"


@dataclass(frozen=True)
class Unknown:
    message: str
    status: Literal["unknown"] = "unknown"


PublishOutcome = Imported | Failed | Unknown


def read_dash0_config(env: Mapping[str, str | None]) -> Dash0Config:
    """Raise InputError("missing env: A, B") naming only the variables, never their values."""
    missing = [name for name in _ENV_NAMES if not (env.get(name) or "").strip()]
    if missing:
        raise InputError(f"missing env: {', '.join(missing)}")
    api_url = (env["DASH0_API_URL"] or "").strip().rstrip("/")
    parts = urlsplit(api_url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise InputError("DASH0_API_URL must be an http(s) URL")
    return Dash0Config(
        api_url=api_url,
        token=(env["DASH0_AUTH_TOKEN"] or "").strip(),
        dataset=(env["DASH0_DATASET"] or "").strip(),
    )


def _redact(text: str, token: str) -> str:
    return text.replace(token, "<redacted>") if token else text


def _clip(text: str, token: str) -> str:
    return _redact(text, token)[:MESSAGE_MAX]


def _url(cfg: Dash0Config, path: str) -> str:
    return f"{cfg.api_url}{path}?dataset={quote(cfg.dataset, safe='')}"


def _headers(cfg: Dash0Config, with_body: bool) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {cfg.token}", "Accept": "application/json"}
    if with_body:
        headers["Content-Type"] = "application/json"
    return headers


def _dig(value: Any, path: tuple[str, ...]) -> Any:
    cur = value
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _decode(body: bytes) -> str:
    return body.decode("utf-8", errors="replace")


def _post_import(
    kind: ImportKind, body: Mapping[str, Any], cfg: Dash0Config, send: HttpSend
) -> Failed | Unknown | _Accepted:
    """POST once. Returns a Failed/Unknown outcome, or the parsed 2xx JSON body."""
    request = HttpRequest(
        method="POST",
        url=_url(cfg, f"/api/import/{kind}"),
        headers=_headers(cfg, with_body=True),
        body=json.dumps(body).encode("utf-8"),
        timeout=REQUEST_TIMEOUT_S,
    )
    try:
        response: HttpResponse = send(request)
    except HttpTransportError as err:
        # The request may have reached Dash0; never assume it didn't.
        return Unknown(_clip(f"{err}; the {kind} may or may not exist in Dash0", cfg.token))

    text = _decode(response.body)
    if response.status >= AMBIGUOUS_STATUS_MIN:
        return Unknown(
            _clip(
                f"HTTP {response.status} (server error); the {kind} may or may not exist "
                f"in Dash0: {text}",
                cfg.token,
            )
        )
    if not response.ok:
        return Failed(http_status=response.status, message=_clip(text, cfg.token))

    try:
        return _Accepted(response.status, json.loads(text))
    except json.JSONDecodeError:
        return Unknown(_clip(f"HTTP {response.status} with a non-JSON body: {text}", cfg.token))


@dataclass(frozen=True)
class _Accepted:
    http_status: int
    body: Any


class _ListError(Exception):
    def __init__(self, message: str, http_status: int | None) -> None:
        super().__init__(message)
        self.http_status = http_status


def _dashboard_ids_named(name: str, cfg: Dash0Config, send: HttpSend) -> set[str]:
    """IDs of the dataset's dashboards whose metadata.name is `name`. Raises _ListError."""
    request = HttpRequest(
        method="GET",
        url=_url(cfg, "/api/dashboards"),
        headers=_headers(cfg, with_body=False),
        timeout=REQUEST_TIMEOUT_S,
    )
    try:
        response = send(request)
    except HttpTransportError as err:
        raise _ListError(_clip(f"listing dashboards failed: {err}", cfg.token), None) from None
    text = _decode(response.body)
    if not response.ok:
        raise _ListError(
            _clip(f"listing dashboards failed: HTTP {response.status}: {text}", cfg.token),
            response.status,
        )
    try:
        items = json.loads(text)
    except json.JSONDecodeError:
        items = None
    if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
        raise _ListError(
            _clip(f"listing dashboards returned an unexpected shape: {text}", cfg.token),
            response.status,
        )
    return {
        i["id"] for i in items if i.get("name") == name and isinstance(i.get("id"), str) and i["id"]
    }


def publish_dashboard(
    body: PersesDashboard, cfg: Dash0Config, send: HttpSend = urllib_send
) -> PublishOutcome:
    metadata = body.get("metadata")
    if isinstance(metadata, dict) and "dash0Extensions" in metadata:
        raise InputError(
            "refusing to publish a dashboard with metadata.dash0Extensions (create-only)"
        )
    name = metadata.get("name") if isinstance(metadata, dict) else None
    if not isinstance(name, str) or not name:
        raise InputError("refusing to publish a dashboard without metadata.name")
    try:
        before = _dashboard_ids_named(name, cfg, send)
    except _ListError as err:
        # Nothing has been sent yet, so this is a definite failure.
        return Failed(http_status=err.http_status, message=f"{err}; nothing was imported")

    accepted = _post_import("dashboard", body, cfg, send)
    if not isinstance(accepted, _Accepted):
        return accepted
    reconcile = "the dashboard was probably created, reconcile before republishing"
    try:
        new = _dashboard_ids_named(name, cfg, send) - before
    except _ListError as err:
        return Unknown(_clip(f"HTTP {accepted.http_status} but {err}; {reconcile}", cfg.token))
    if len(new) != 1:
        return Unknown(
            _clip(
                f"HTTP {accepted.http_status} but found {len(new)} new dashboards named "
                f"{name!r}; {reconcile}",
                cfg.token,
            )
        )
    return Imported(id=new.pop(), http_status=accepted.http_status)


def publish_check_rule(
    body: Dash0CheckRule, cfg: Dash0Config, send: HttpSend = urllib_send
) -> PublishOutcome:
    if "id" in body:
        raise InputError("refusing to publish a check rule with an id (create-only)")
    accepted = _post_import("check-rule", body, cfg, send)
    if not isinstance(accepted, _Accepted):
        return accepted
    new_id = _dig(accepted.body, CHECK_RULE_ID_PATH)
    if not isinstance(new_id, str) or not new_id:
        return Unknown(
            f"HTTP {accepted.http_status} but no id at {'.'.join(CHECK_RULE_ID_PATH)}; the "
            "check-rule was probably created, reconcile before republishing"
        )
    return Imported(id=new_id, http_status=accepted.http_status)


def read_back(
    kind: ImportKind, asset_id: str, cfg: Dash0Config, send: HttpSend = urllib_send
) -> Any:
    """GET the asset by ID. Raises RuntimeError with a redacted message on failure."""
    quoted = quote(asset_id, safe="")
    path = (
        f"/api/dashboards/{quoted}"
        if kind == "dashboard"
        else (f"/api/alerting/check-rules/{quoted}")
    )
    request = HttpRequest(
        method="GET",
        url=_url(cfg, path),
        headers=_headers(cfg, with_body=False),
        timeout=REQUEST_TIMEOUT_S,
    )
    try:
        response = send(request)
    except HttpTransportError as err:
        raise RuntimeError(_clip(f"read-back of {kind} failed: {err}", cfg.token)) from None
    text = _decode(response.body)
    if not response.ok:
        raise RuntimeError(
            _clip(f"read-back of {kind} failed: HTTP {response.status}: {text}", cfg.token)
        )
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(
            _clip(f"read-back of {kind} returned non-JSON: {text}", cfg.token)
        ) from None
