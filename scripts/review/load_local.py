"""Load Perses dashboards from run directories into a LOCAL Perses (development/review only).

Reads run directories in the `migrator publish` format (manifest.json + dashboards/): those written
by `migrator convert --out <dir>` (project `datadog-migration`). Checks each dashboard's
sha256 against the manifest, then talks to the Perses REST API:

  * creates each dashboard's project (and its `dash0` Secret + default Prometheus Datasource) when
    missing (docker-compose.yaml provisions only `oracle-review`),
  * POSTs each dashboard, or PUTs it when it already exists,
  * GETs it back and checks name, project and spec came back unchanged,
  * prints the dashboard URL with the absolute review window (start/end in epoch ms).

Never sends a token: the Secret only names the file /run/secrets/dash0_auth_token, which docker
compose fills from $DASH0_AUTH_TOKEN inside the container. Only DASH0_API_URL and DASH0_DATASET
(not secret) are read here. stdlib urllib only; never talks to Dash0.

Perses API docs: https://github.com/perses/perses/tree/v0.55.1/docs/api (project.md, datasource.md,
secret.md, dashboard.md). URL time params: `start`/`end` as epoch milliseconds
(perses/shared plugin-system/src/runtime/TimeRangeProvider/query-params.ts).

Usage: uv run scripts/review/load_local.py [<run dir> ...] [--perses-url http://localhost:8080]
       (pass one or more `migrator convert --out` dirs)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote, urlencode

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNS = ROOT / "out" / "oracle-review"
DEFAULT_PERSES_URL = "http://localhost:8080"
PROJECT = "oracle-review"
SECRET = "dash0"
DATASOURCE = "dash0"
TOKEN_FILE = "/run/secrets/dash0_auth_token"
DEFAULT_DASH0_API_URL = "https://api.eu-west-1.aws.dash0.com"
# The only window with receiver data in the Dash0 `default` dataset.
WINDOW_START = "2026-11-07T14:05:00Z"
WINDOW_END = "2026-11-07T15:21:00Z"
TIMEOUT_S = 10
PROMETHEUS_ENDPOINTS = [
    ("/api/v1/labels", "POST"),
    ("/api/v1/series", "POST"),
    ("/api/v1/metadata", "GET"),
    ("/api/v1/query", "POST"),
    ("/api/v1/query_range", "POST"),
    ("/api/v1/parse_query", "POST"),
    ("/api/v1/label/([a-zA-Z0-9_-]+)/values", "GET"),
]


class Opener(Protocol):
    def open(self, request: urllib.request.Request, timeout: float) -> Any: ...


class PersesError(RuntimeError):
    pass


def epoch_ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def dashboard_url(base: str, name: str, project: str = PROJECT) -> str:
    query = urlencode({"start": epoch_ms(WINDOW_START), "end": epoch_ms(WINDOW_END)})
    return f"{base.rstrip('/')}/projects/{quote(project, safe='')}/dashboards/{quote(name, safe='')}?{query}"


class Client:
    """Minimal Perses REST client. `opener` is injectable for tests (urllib OpenerDirector shape)."""

    def __init__(self, base: str, opener: Opener | None = None, timeout: float = TIMEOUT_S):
        self.base = base.rstrip("/")
        self.opener: Opener = opener or urllib.request.build_opener()
        self.timeout = timeout

    def request(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        data = None if body is None else json.dumps(body, sort_keys=True).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=self.timeout) as resp:
                status, raw = int(resp.status), resp.read()
        except urllib.error.HTTPError as err:
            status, raw = err.code, err.read()
        except urllib.error.URLError as err:
            raise PersesError(f"{method} {self.base}{path}: {err.reason}") from None
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = raw.decode("utf-8", "replace")
        return status, payload

    def ensure(self, collection: str, name: str, body: dict[str, Any]) -> str:
        """Create `body` under `collection` unless `<collection>/<name>` exists. Returns what happened."""
        status, payload = self.request("GET", f"{collection}/{quote(name, safe='')}")
        if status == 200:
            return "exists"
        if status != 404:
            raise PersesError(f"GET {collection}/{name}: HTTP {status}: {payload}")
        status, payload = self.request("POST", collection, body)
        if status not in (200, 201):
            raise PersesError(f"POST {collection}: HTTP {status}: {payload}")
        return "created"


# --------------------------------------------------------------------------- resources


def project_body(project: str = PROJECT) -> dict[str, Any]:
    display = "Oracle review (issue 87)" if project == PROJECT else project
    return {"kind": "Project", "metadata": {"name": project}, "spec": {"display": {"name": display}}}


def secret_body(project: str = PROJECT) -> dict[str, Any]:
    return {
        "kind": "Secret",
        "metadata": {"name": SECRET, "project": project},
        "spec": {"authorization": {"type": "Bearer", "credentialsFile": TOKEN_FILE}},
    }


def datasource_body(env: Mapping[str, str], project: str = PROJECT) -> dict[str, Any]:
    """Same datasource docker-compose.yaml provisions; URL and dataset from env (not secret)."""
    api = (env.get("DASH0_API_URL") or DEFAULT_DASH0_API_URL).strip().rstrip("/")
    dataset = (env.get("DASH0_DATASET") or "default").strip()
    return {
        "kind": "Datasource",
        "metadata": {"name": DATASOURCE, "project": project},
        "spec": {
            "default": True,
            "display": {"name": f"Dash0 ({dataset})"},
            "plugin": {
                "kind": "PrometheusDatasource",
                "spec": {
                    "proxy": {
                        "kind": "HTTPProxy",
                        "spec": {
                            "url": f"{api}/api/prometheus",
                            "secret": SECRET,
                            "headers": {"Dash0-Dataset": dataset},
                            "allowedEndpoints": [
                                {"endpointPattern": p, "method": m} for p, m in PROMETHEUS_ENDPOINTS
                            ],
                        },
                    }
                },
            },
        },
    }


def ensure_project(client: Client, env: Mapping[str, str], project: str = PROJECT) -> list[str]:
    p = f"/api/v1/projects/{quote(project, safe='')}"
    return [
        f"project {project}: {client.ensure('/api/v1/projects', project, project_body(project))}",
        f"secret {SECRET}: {client.ensure(p + '/secrets', SECRET, secret_body(project))}",
        f"datasource {DATASOURCE}: "
        f"{client.ensure(p + '/datasources', DATASOURCE, datasource_body(env, project))}",
    ]


def upsert_dashboard(client: Client, dashboard: dict[str, Any]) -> str:
    project, name = dashboard["metadata"]["project"], dashboard["metadata"]["name"]
    collection = f"/api/v1/projects/{quote(project, safe='')}/dashboards"
    path = f"{collection}/{quote(name, safe='')}"
    status, payload = client.request("GET", path)
    if status == 200:
        method, target, verb = "PUT", path, "updated"
    elif status == 404:
        method, target, verb = "POST", collection, "created"
    else:
        raise PersesError(f"GET {path}: HTTP {status}: {payload}")
    status, payload = client.request(method, target, dashboard)
    if status not in (200, 201):
        raise PersesError(f"{method} {target}: HTTP {status}: {payload}")
    return verb


def verify_dashboard(client: Client, dashboard: dict[str, Any]) -> list[str]:
    """GET the dashboard back; problems if name, project or spec differ from what was sent."""
    project, name = dashboard["metadata"]["project"], dashboard["metadata"]["name"]
    status, got = client.request("GET", f"/api/v1/projects/{quote(project, safe='')}/dashboards/{quote(name, safe='')}")
    if status != 200 or not isinstance(got, dict):
        return [f"GET returned HTTP {status}"]
    problems = []
    meta = got.get("metadata") or {}
    if meta.get("name") != name or meta.get("project") != project:
        problems.append(f"metadata differs: {meta.get('project')}/{meta.get('name')}")
    if got.get("kind") != dashboard["kind"]:
        problems.append(f"kind differs: {got.get('kind')}")
    if prune_empty(got.get("spec")) != prune_empty(dashboard["spec"]):
        problems.append("spec differs from the rendered file")
    return problems


def prune_empty(value: Any) -> Any:
    """Drop empty strings, lists and objects recursively.

    Perses omits empty fields on read (observed with v0.55.1: `variables: []`, `queries: []` and
    `description: ""` come back absent), so those are not differences.
    """
    if isinstance(value, dict):
        pruned = {k: prune_empty(v) for k, v in value.items()}
        return {k: v for k, v in pruned.items() if v not in ("", [], {}, None)}
    if isinstance(value, list):
        return [prune_empty(v) for v in value]
    return value


# --------------------------------------------------------------------------- runs


def run_dirs(args: list[str]) -> list[Path]:
    if args:
        return [Path(a) for a in args]
    return sorted(p.parent for p in DEFAULT_RUNS.rglob("manifest.json"))


def load_run(run: Path) -> list[dict[str, Any]]:
    """Dashboards of one run dir, sha256-checked against manifest.json (as `migrator publish` does)."""
    manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
    out = []
    for entry in manifest.get("entries", []):
        if entry.get("kind") != "dashboard":
            continue
        data = (run / entry["path"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise PersesError(f"{run / entry['path']}: sha256 mismatch with manifest.json; re-render")
        out.append(json.loads(data))
    return out


def main(argv: list[str] | None = None, opener: Opener | None = None, env: Mapping[str, str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("runs", nargs="*", metavar="<run dir>")
    ap.add_argument("--perses-url", default=os.environ.get("PERSES_URL", DEFAULT_PERSES_URL))
    args = ap.parse_args(argv)
    runs = run_dirs(args.runs)
    if not runs:
        ap.error(f"no run dirs given (none under {DEFAULT_RUNS}); pass a `migrator convert --out` dir")
    client = Client(args.perses_url, opener)
    failed = False
    try:
        dashboards = [d for run in runs for d in load_run(run)]  # every sha256 check before any write
        for project in sorted({d["metadata"]["project"] for d in dashboards}):
            for line in ensure_project(client, os.environ if env is None else env, project):
                print(line)
        for dashboard in dashboards:
            verb = upsert_dashboard(client, dashboard)
            problems = verify_dashboard(client, dashboard)
            failed |= bool(problems)
            status = "verified" if not problems else "MISMATCH: " + "; ".join(problems)
            print(f"{verb} {dashboard['metadata']['name']} ({status})")
            meta = dashboard["metadata"]
            print(f"  {dashboard_url(args.perses_url, meta['name'], meta['project'])}")
    except PersesError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
