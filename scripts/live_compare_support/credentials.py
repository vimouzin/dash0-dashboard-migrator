"""Literal .env loading and query credentials. Never evaluates shell expressions."""

from __future__ import annotations

import re
import shlex
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from migrator.input import InputError
from migrator.source.datadog.api import DEFAULT_SITE, SAFE_SITE, read_datadog_config

VARIABLES = frozenset(
    {
        "DATADOG_PAT",
        "DD_BEARER_TOKEN",
        "DD_API_KEY",
        "DD_APP_KEY",
        "DD_SITE",
        "DASH0_AUTH_TOKEN",
        "DASH0_API_URL",
        "DASH0_OTLP_ENDPOINT",
        "DASH0_DATASET",
    }
)
DEFAULT_ENDPOINTS = {
    "DASH0_API_URL": "https://api.eu-west-1.aws.dash0.com",
    "DASH0_OTLP_ENDPOINT": "https://ingress.eu-west-1.aws.dash0.com",
}


def canonical(values: Mapping[str, str]) -> dict[str, str]:
    out = dict(values)
    if not out.get("DD_BEARER_TOKEN") and out.get("DATADOG_PAT"):
        out["DD_BEARER_TOKEN"] = out["DATADOG_PAT"]
    return out


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, raw = line.partition("=")
        key = key.strip()
        # Other application credentials, including model credentials, are not loaded.
        if key not in VARIABLES:
            continue
        if not separator or key in values:
            raise InputError(f"invalid or duplicate .env assignment on line {line_number}")
        raw = raw.strip()
        try:
            if raw.startswith(("'", '"')):
                parts = shlex.split(raw, comments=True, posix=True)
                if len(parts) != 1:
                    raise ValueError
                value = parts[0]
            else:
                value = re.split(r"\s+#", raw, maxsplit=1)[0].rstrip()
            if "\x00" in value or "\r" in value or "\n" in value:
                raise ValueError
        except ValueError:
            # Parser exceptions can echo the source line; never propagate them.
            raise InputError(f"invalid .env value on line {line_number}") from None
        values[key] = value
    return canonical(values)


def load_environment(env: Mapping[str, str], path: Path | None) -> dict[str, str]:
    file_values = read_env_file(path) if path is not None else {}
    return {**DEFAULT_ENDPOINTS, **file_values, **canonical(env)}


@dataclass(frozen=True)
class QueryConfig:
    base_url: str
    headers: Mapping[str, str] = field(repr=False)


def read_query_config(env: Mapping[str, str]) -> QueryConfig:
    values = canonical(env)
    bearer = values.get("DD_BEARER_TOKEN", "").strip()
    if bearer:
        site = values.get("DD_SITE", "").strip() or DEFAULT_SITE
        if not SAFE_SITE.fullmatch(site):
            raise InputError("DD_SITE must be a bare Datadog site hostname")
        return QueryConfig(f"https://api.{site}", {"Authorization": f"Bearer {bearer}"})
    legacy = read_datadog_config(values)
    return QueryConfig(
        legacy.base_url,
        {
            "DD-API-KEY": legacy.api_key,
            "DD-APPLICATION-KEY": legacy.app_key,
        },
    )
