"""Read-only Dash0 smoke check of a `migrator convert` run (development time only).

Runs every translated panel query of a run directory against the Dash0 Prometheus
API and flags panels with no data or implausible values. The result is semantic
evidence, kept separate from the deterministic report (AGENTS.md): it never changes
report.json, and nothing under src/ imports this script.

Usage:
  uv run scripts/smoke_check.py RUN_DIR [--start ISO] [--end ISO] [--step 60s]

  RUN_DIR has manifest.json and the dashboards it lists (Perses, JSON or YAML).
  The window defaults to the hour before now; times without a zone are UTC.

Env: DASH0_AUTH_TOKEN (required, never printed), DASH0_API_URL (default
https://api.eu-west-1.aws.dash0.com), DASH0_DATASET (default `default`).

Only GET <api>/api/prometheus/api/v1/query_range is sent; nothing is written to Dash0.

Per PrometheusTimeSeriesQuery: `$__rate_interval` becomes `5m` and every dashboard
variable (`$name`, `${name}`) becomes `.*`. Recorded: series count, min and max over
all finite samples. Flags:
  query_error           the query failed (HTTP status, transport, response shape)
  no_data               no series in the window
  nan                   a sample is NaN or +/-Inf
  negative              min < 0 for a query using rate, irate, increase or count
  percent_out_of_range  max > 100 where the panel unit is `percent`

Writes RUN_DIR/smoke.json (sorted by dashboard, then panel; no timestamps besides the
requested window), prints one line per panel query, and exits 1 on any flag, 0 on
none, 2 on a usage or input error (nothing written).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import yaml

from migrator.destination.dash0 import Dash0Config, _clip, read_dash0_config
from migrator.http import HttpRequest, HttpSend, HttpTransportError, urllib_send
from migrator.input import InputError
from migrator.write import stable_stringify

DEFAULT_API_URL = "https://api.eu-west-1.aws.dash0.com"
DEFAULT_DATASET = "default"
QUERY_RANGE_PATH = "/api/prometheus/api/v1/query_range"
RATE_INTERVAL = "5m"
VARIABLE_VALUE = ".*"
DEFAULT_WINDOW = dt.timedelta(hours=1)
TIMEOUT_S = 30.0
OUTPUT = "smoke.json"

_STEP = re.compile(r"^[1-9][0-9]*[smh]$")
_QUOTED = re.compile(r'"(?:[^"\\]|\\.)*"')
_RATE_OR_COUNT = re.compile(
    r"\b(?:rate|irate|increase|count|count_over_time)\s*(?:\(|by\b|without\b)"
)


@dataclass(frozen=True)
class Window:
    start: str
    end: str
    step: str


@dataclass(frozen=True)
class PanelQuery:
    dashboard: str
    panel: str
    index: int
    query: str  # after substitution, as sent
    percent: bool


# --------------------------------------------------------------------------- inputs


def substitute(query: str, variables: Sequence[str]) -> str:
    """`$__rate_interval` -> 5m, then each variable `$name` / `${name}` -> `.*`."""
    out = _replace_variable(query, "__rate_interval", RATE_INTERVAL)
    for name in variables:
        out = _replace_variable(out, name, VARIABLE_VALUE)
    return out


def _replace_variable(text: str, name: str, value: str) -> str:
    n = re.escape(name)
    return re.sub(rf"\$(?:\{{{n}\}}|{n}(?!\w))", lambda _: value, text)


def is_rate_or_count(query: str) -> bool:
    return bool(_RATE_OR_COUNT.search(_QUOTED.sub('""', query)))


def _panel_unit(plugin_spec: Mapping[str, Any]) -> Any:
    """Perses keeps the unit at yAxis.format.unit (TimeSeriesChart) or format.unit."""
    y_axis = plugin_spec.get("yAxis")
    if isinstance(y_axis, dict) and isinstance(y_axis.get("format"), dict):
        return y_axis["format"].get("unit")
    fmt = plugin_spec.get("format")
    return fmt.get("unit") if isinstance(fmt, dict) else None


def _natural(key: str) -> list[int | str]:
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", key)]


def _load(path: Path) -> Any:
    text = path.read_text(encoding="utf-8")
    return json.loads(text) if path.suffix == ".json" else yaml.safe_load(text)


def load_panel_queries(run: Path) -> list[PanelQuery]:
    """Every PrometheusTimeSeriesQuery of the run's dashboards, sorted by dashboard,
    then panel key (natural order), then query index."""
    manifest = _load(run / "manifest.json")
    out: list[PanelQuery] = []
    for entry in manifest.get("entries", []):
        if entry.get("kind") != "dashboard":
            continue
        body = _load(run / entry["path"])
        spec = body["spec"]
        variables = [v["spec"]["name"] for v in spec.get("variables") or []]
        for key, panel in (spec.get("panels") or {}).items():
            pspec = panel.get("spec") or {}
            percent = _panel_unit((pspec.get("plugin") or {}).get("spec") or {}) == "percent"
            for i, q in enumerate(pspec.get("queries") or []):
                plugin = (q.get("spec") or {}).get("plugin") or {}
                if plugin.get("kind") != "PrometheusTimeSeriesQuery":
                    continue
                query = substitute(plugin["spec"]["query"], variables)
                out.append(PanelQuery(body["metadata"]["name"], key, i, query, percent))
    return sorted(out, key=lambda p: (p.dashboard, _natural(p.panel), p.index))


def _parse_time(text: str) -> dt.datetime:
    value = dt.datetime.fromisoformat(text)
    return value if value.tzinfo else value.replace(tzinfo=dt.UTC)


def _iso(value: dt.datetime) -> str:
    return value.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_window(start: str | None, end: str | None, step: str, now: dt.datetime) -> Window:
    if not _STEP.match(step):
        raise ValueError(f"--step must look like 60s, 5m or 1h, got {step!r}")
    end_t = _parse_time(end) if end else now
    start_t = _parse_time(start) if start else end_t - DEFAULT_WINDOW
    window = Window(_iso(start_t), _iso(end_t), step)
    if window.start >= window.end:
        raise ValueError("--start must be before --end")
    return window


def read_config(env: Mapping[str, str]) -> Dash0Config:
    merged = {
        "DASH0_API_URL": env.get("DASH0_API_URL") or DEFAULT_API_URL,
        "DASH0_DATASET": env.get("DASH0_DATASET") or DEFAULT_DATASET,
        "DASH0_AUTH_TOKEN": env.get("DASH0_AUTH_TOKEN"),
    }
    return read_dash0_config(merged)


# --------------------------------------------------------------------------- query


class _QueryFailed(Exception):
    pass


def query_range(query: str, window: Window, cfg: Dash0Config, send: HttpSend) -> list[Any]:
    """GET query_range once. Returns the matrix result; raises _QueryFailed (redacted)."""
    params = urlencode(
        {"query": query, "start": window.start, "end": window.end, "step": window.step}
    )
    request = HttpRequest(
        method="GET",
        url=f"{cfg.api_url}{QUERY_RANGE_PATH}?{params}",
        headers={
            "Authorization": f"Bearer {cfg.token}",
            "Dash0-Dataset": cfg.dataset,
            "Accept": "application/json",
        },
        timeout=TIMEOUT_S,
    )
    try:
        response = send(request)
    except HttpTransportError as err:
        raise _QueryFailed(_clip(str(err), cfg.token)) from None
    text = response.body.decode("utf-8", errors="replace")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = None
    if not response.ok or not isinstance(payload, dict) or payload.get("status") != "success":
        detail = payload.get("error") if isinstance(payload, dict) else None
        message = detail if isinstance(detail, str) else text
        raise _QueryFailed(_clip(f"HTTP {response.status}: {message}", cfg.token))
    data = payload.get("data")
    if (
        not isinstance(data, dict)
        or data.get("resultType") != "matrix"
        or not isinstance(data.get("result"), list)
    ):
        raise _QueryFailed(f"HTTP {response.status}: not a matrix result")
    return list(data["result"])


def _sample_values(result: list[Any]) -> list[float]:
    try:
        return [float(value) for series in result for _, value in series["values"]]
    except (KeyError, TypeError, ValueError):
        raise _QueryFailed("unexpected sample shape") from None


def check(pq: PanelQuery, window: Window, cfg: Dash0Config, send: HttpSend) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "dashboard": pq.dashboard,
        "panel": pq.panel,
        "query": pq.query,
        "series": None,
        "min": None,
        "max": None,
        "flags": [],
        "error": None,
    }
    try:
        result = query_range(pq.query, window, cfg, send)
        values = _sample_values(result)
    except _QueryFailed as err:
        entry["flags"] = ["query_error"]
        entry["error"] = str(err)
        return entry
    finite = [v for v in values if math.isfinite(v)]
    low = min(finite) if finite else None
    high = max(finite) if finite else None
    flags: list[str] = []
    if not result:
        flags.append("no_data")
    if len(finite) < len(values):
        flags.append("nan")
    if low is not None and low < 0 and is_rate_or_count(pq.query):
        flags.append("negative")
    if high is not None and high > 100 and pq.percent:
        flags.append("percent_out_of_range")
    entry.update(series=len(result), min=low, max=high, flags=flags)
    return entry


def _num(value: float | None) -> str:
    return "-" if value is None else f"{value:.6g}"


def format_line(pq: PanelQuery, entry: Mapping[str, Any]) -> str:
    series = "-" if entry["series"] is None else str(entry["series"])
    line = (
        f"{pq.dashboard} {pq.panel}#{pq.index} series={series} "
        f"min={_num(entry['min'])} max={_num(entry['max'])} "
        f"flags={','.join(entry['flags']) or '-'}"
    )
    return f"{line} ({entry['error']})" if entry["error"] else line


# --------------------------------------------------------------------------- main


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only Dash0 smoke check of a run.")
    parser.add_argument("run", type=Path, help="run directory written by migrator convert")
    parser.add_argument("--start", help="window start, ISO 8601 (default: end - 1h)")
    parser.add_argument("--end", help="window end, ISO 8601 (default: now)")
    parser.add_argument("--step", default="60s", help="query_range step (default: 60s)")
    return parser.parse_args(argv)


def main(
    argv: Sequence[str] | None = None,
    env: Mapping[str, str] | None = None,
    send: HttpSend = urllib_send,
    now: dt.datetime | None = None,
) -> int:
    args = _parse_args(argv)
    try:
        cfg = read_config(os.environ if env is None else env)
        window = make_window(args.start, args.end, args.step, now or dt.datetime.now(dt.UTC))
        queries = load_panel_queries(args.run)
    except (
        InputError,
        ValueError,
        OSError,
        yaml.YAMLError,
        KeyError,
        TypeError,
        AttributeError,
    ) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    entries: list[dict[str, Any]] = []
    for pq in queries:
        entry = check(pq, window, cfg, send)
        entries.append(entry)
        print(format_line(pq, entry))

    doc = {
        "dataset": cfg.dataset,
        "window": {"start": window.start, "end": window.end},
        "panels": entries,
    }
    (args.run / OUTPUT).write_text(stable_stringify(doc), encoding="utf-8")
    flagged = sum(1 for e in entries if e["flags"])
    print(f"{len(entries)} queries, {flagged} flagged, wrote {args.run / OUTPUT}", file=sys.stderr)
    return 1 if flagged else 0


if __name__ == "__main__":
    sys.exit(main())
