"""Read-only Datadog API fetch by explicit ID.

Writes the exact response bytes; no translation happens here. Fetched folders feed
`convert --input <dir>`.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from migrator.http import HttpRequest, HttpSend, HttpTransportError, urllib_send
from migrator.input import InputError
from migrator.source.asset import FetchSelection, SourceFetchError

SAFE_ID = re.compile(r"^[A-Za-z0-9-]+$")
SAFE_SITE = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
REQUEST_TIMEOUT_S = 30.0
BODY_MAX = 500
DEFAULT_SITE = "datadoghq.eu"

FetchKind = Literal["dashboard", "monitor"]


@dataclass(frozen=True)
class DatadogConfig:
    base_url: str
    api_key: str
    app_key: str


@dataclass(frozen=True)
class _Target:
    kind: FetchKind
    id: str
    path: str  # relative output path


def read_datadog_config(env: Mapping[str, str | None]) -> DatadogConfig:
    missing = [n for n in ("DD_API_KEY", "DD_APP_KEY") if not (env.get(n) or "").strip()]
    if missing:
        raise InputError(f"missing env: {', '.join(missing)}")
    site = (env.get("DD_SITE") or "").strip() or DEFAULT_SITE
    if not SAFE_SITE.fullmatch(site):
        raise InputError("DD_SITE must be a bare host such as datadoghq.eu")
    return DatadogConfig(
        base_url=f"https://api.{site}",
        api_key=(env.get("DD_API_KEY") or "").strip(),
        app_key=(env.get("DD_APP_KEY") or "").strip(),
    )


def _redact(text: str, cfg: DatadogConfig) -> str:
    for secret in (cfg.api_key, cfg.app_key):
        if secret:
            text = text.replace(secret, "<redacted>")
    return text


def _targets(sel: FetchSelection) -> list[_Target]:
    out: list[_Target] = []
    groups: tuple[tuple[FetchKind, tuple[str, ...], str], ...] = (
        ("dashboard", sel.dashboard_ids, "dashboards"),
        ("monitor", sel.monitor_ids, "monitors"),
    )
    for kind, ids, folder in groups:
        seen: set[str] = set()
        for asset_id in ids:
            if not SAFE_ID.fullmatch(asset_id):
                raise InputError(f"invalid {kind} id: '{asset_id}' (expected ^[A-Za-z0-9-]+$)")
            if asset_id in seen:
                raise InputError(f"duplicate {kind} id: {asset_id}")
            seen.add(asset_id)
            out.append(_Target(kind, asset_id, f"{folder}/{asset_id}.json"))
    if not out:
        raise InputError("select at least one --dashboard-id or --monitor-id")
    return out


def _explain(status: int, kind: FetchKind) -> str:
    if status == 401:
        return "API key is missing or invalid"
    if status == 403:
        return f"application key lacks read access (needs the {kind}s_read scope)"
    if status == 404:
        return f"{kind} not found in this Datadog site/org"
    if status == 429:
        return "rate limited; retry later"
    return "request failed"


def _get(t: _Target, cfg: DatadogConfig, send: HttpSend) -> bytes:
    request = HttpRequest(
        method="GET",
        url=f"{cfg.base_url}/api/v1/{t.kind}/{t.id}",
        headers={
            "DD-API-KEY": cfg.api_key,
            "DD-APPLICATION-KEY": cfg.app_key,
            "Accept": "application/json",
        },
        timeout=REQUEST_TIMEOUT_S,
    )
    try:
        response = send(request)
    except HttpTransportError as err:
        raise SourceFetchError(_redact(f"fetching {t.kind} {t.id} failed: {err}", cfg)) from None
    if not response.ok:
        body = _redact(response.body.decode("utf-8", errors="replace"), cfg)[:BODY_MAX]
        raise SourceFetchError(
            f"fetching {t.kind} {t.id} failed: HTTP {response.status}: "
            f"{_explain(response.status, t.kind)}; body: {body}"
        )
    return response.body


def fetch_datadog_assets(
    sel: FetchSelection,
    env: Mapping[str, str | None],
    out: str | Path,
    send: HttpSend = urllib_send,
) -> list[str]:
    """Fetch the selected assets, then write them; returns the relative paths written.

    Everything is validated before the first request, and nothing is written unless
    every request succeeded.
    """
    cfg = read_datadog_config(env)
    targets = _targets(sel)
    out_dir = Path(out)
    if out_dir.exists() and (not out_dir.is_dir() or any(out_dir.iterdir())):
        raise InputError(f"output directory is not empty: {out}")

    fetched = [(t.path, _get(t, cfg, send)) for t in targets]
    for rel, data in fetched:
        full = out_dir / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(data)
    return [rel for rel, _ in fetched]
