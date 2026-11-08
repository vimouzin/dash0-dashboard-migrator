from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from migrator.cli import main
from migrator.convert import ConvertOptions, run_convert
from migrator.http import HttpRequest, HttpResponse, HttpTransportError
from migrator.input import InputError
from migrator.publish import PublishOptions, run_publish
from migrator.receipts import RECEIPTS_FILE, load_receipts

TOKEN = "dash0_TOKEN_secret"
ENV = {
    "DASH0_API_URL": "https://api.example.dash0.com",
    "DASH0_AUTH_TOKEN": TOKEN,
    "DASH0_DATASET": "default",
}
CHECK = "check-rules/postgres-number-of-connections-is-approaching-connection-limit-o.json"
DASH_METRICS = "dashboards/postgres-metrics.json"
DASH_OVERVIEW = "dashboards/postgres-overview.json"


class DashOk:
    """A successful dashboard import; like live Dash0, its response carries no id."""

    def __init__(self, new_id: str) -> None:
        self.new_id = new_id


class FakeSend:
    """A stand-in Dash0. Answers POSTs in order from `responses` and records them in
    `requests`; answers GET /api/dashboards from its own state (recorded in `gets`).
    A DashOk response registers the posted dashboard under its metadata.name.
    """

    def __init__(self, *responses: HttpResponse | DashOk | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[HttpRequest] = []
        self.gets: list[HttpRequest] = []
        self.dashboards: list[dict[str, str]] = []

    def __call__(self, req: HttpRequest) -> HttpResponse:
        if req.method == "GET":
            self.gets.append(req)
            assert req.url.split("?")[0].endswith("/api/dashboards")
            return HttpResponse(200, json.dumps(self.dashboards).encode())
        self.requests.append(req)
        res = self.responses.pop(0)
        if isinstance(res, Exception):
            raise res
        if isinstance(res, DashOk):
            body = json.loads(req.body or b"{}")
            name = body["metadata"]["name"]
            self.dashboards.append({"id": res.new_id, "name": name, "dataset": "default"})
            return HttpResponse(200, json.dumps(body).encode())
        return res


def dashboard_ok(i: str) -> DashOk:
    return DashOk(i)


def rule_ok(i: str) -> HttpResponse:
    return HttpResponse(200, json.dumps({"id": i}).encode())


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    out = tmp_path / "run"
    run_convert(
        ConvertOptions(
            source="datadog",
            inputs=["fixtures/datadog/integrations-core/postgres"],
            mapping=["mappings/datadog"],
            out=str(out),
        )
    )
    return out


def edit_manifest(run_dir: Path, entry_path: str, **changes: object) -> None:
    m = json.loads((run_dir / "manifest.json").read_text())
    for e in m["entries"]:
        if e["path"] == entry_path:
            e.update(changes)
    (run_dir / "manifest.json").write_text(json.dumps(m))


def test_dry_run_makes_no_requests(run_dir: Path) -> None:
    send = FakeSend()
    r = run_publish(PublishOptions(str(run_dir), dry_run=True, allow_partial=True), ENV, send)
    assert send.requests == []
    dry = [line for line in r.lines if line.startswith("DRY-RUN POST ")]
    assert len(dry) == 3
    # Groups in order: translated, approximated, assumed, partial. The check rule is
    # approximated (A3 options); both dashboards are partial, one carrying the DERIVED tag of a
    # converted widget. Each line names its category and tags.
    assert dry[0].startswith(
        "DRY-RUN POST https://api.example.dash0.com/api/import/check-rule?dataset=default  "
        "[Postgres] Number of connections"
    )
    assert dry[0].endswith("(publish)  [approximated: NEWHOST FULLWINDOW]")
    assert sorted(line.rsplit("  ", 1)[1] for line in dry[1:]) == [
        "[partial: DERIVED]",
        "[partial: TOPN SEMANTIC ASCOUNT OTELTABLE]",
    ]
    assert not (run_dir / RECEIPTS_FILE).exists()


def test_rejects_paths_outside_the_run_dir(run_dir: Path) -> None:
    (run_dir.parent / "x.json").write_text("{}")
    edit_manifest(run_dir, CHECK, path="../x.json")
    send = FakeSend()
    r = run_publish(PublishOptions(str(run_dir)), ENV, send)
    assert r.exit_code == 1
    assert send.requests == []
    assert "escapes the run directory" in r.lines[0]


def test_rejects_hash_mismatch(run_dir: Path) -> None:
    target = run_dir / CHECK
    target.write_text(target.read_text().replace('"1m"', '"2m"', 1))
    send = FakeSend()
    r = run_publish(PublishOptions(str(run_dir)), ENV, send)
    assert (r.exit_code, send.requests) == (1, [])
    assert "sha256 mismatch" in r.lines[0]


def test_rejects_invalid_body_even_with_matching_hash(run_dir: Path) -> None:
    target = run_dir / CHECK
    body = json.loads(target.read_text())
    body["id"] = "existing"  # would overwrite in Dash0
    text = json.dumps(body)
    target.write_text(text)
    edit_manifest(run_dir, CHECK, sha256=hashlib.sha256(text.encode()).hexdigest())
    send = FakeSend()
    r = run_publish(PublishOptions(str(run_dir)), ENV, send)
    assert (r.exit_code, send.requests) == (1, [])
    assert "failed validation" in r.lines[0]


def test_stops_on_auth_failure(run_dir: Path) -> None:
    send = FakeSend(HttpResponse(401, f"bad token {TOKEN}".encode()))
    r = run_publish(PublishOptions(str(run_dir), allow_partial=True), ENV, send)
    assert len(send.requests) == 1
    assert r.exit_code == 1
    assert any(line.startswith("stopping: HTTP 401") for line in r.lines)
    assert all(TOKEN not in line for line in r.lines)


def test_partial_requires_allow_partial(run_dir: Path) -> None:
    send = FakeSend(rule_ok("r1"))
    r = run_publish(PublishOptions(str(run_dir)), ENV, send)
    assert r.exit_code == 2
    assert [req.url.split("?")[0].rsplit("/", 1)[1] for req in send.requests] == ["check-rule"]
    assert f"SKIP {DASH_METRICS}  (partial; pass --allow-partial to publish)" in r.lines

    send = FakeSend(dashboard_ok("d1"), dashboard_ok("d2"))
    r = run_publish(PublishOptions(str(run_dir), allow_partial=True), ENV, send)
    # check rule unchanged from the first run; both dashboards published now
    assert len(send.requests) == 2
    assert any(line.startswith(f"UNCHANGED {CHECK}") for line in r.lines)
    assert r.exit_code == 2  # replication_delay was still blocked in convert


def test_writes_receipts_per_asset(run_dir: Path) -> None:
    send = FakeSend(rule_ok("r1"), HttpResponse(400, b"bad dashboard"), dashboard_ok("d2"))
    r = run_publish(PublishOptions(str(run_dir), allow_partial=True), ENV, send)
    assert r.exit_code == 1
    saved = {x.path: x for x in load_receipts(run_dir)}
    assert (saved[CHECK].status, saved[CHECK].id) == ("imported", "r1")
    assert (saved[DASH_METRICS].status, saved[DASH_METRICS].http_status) == ("failed", 400)
    # The dashboard id comes from listing Dash0 before and after the import.
    assert (saved[DASH_OVERVIEW].status, saved[DASH_OVERVIEW].id) == ("imported", "d2")
    assert len(send.gets) == 3  # before each dashboard import; after only on a 2xx
    assert r.receipts == sorted(saved.values(), key=lambda x: x.key)


def test_unknown_result_blocks_republish(run_dir: Path) -> None:
    send = FakeSend(HttpTransportError("TimeoutError: timed out"))
    r = run_publish(PublishOptions(str(run_dir)), ENV, send)
    assert r.exit_code == 1
    assert load_receipts(run_dir)[0].status == "unknown"

    send = FakeSend()
    r = run_publish(PublishOptions(str(run_dir)), ENV, send)
    assert (r.exit_code, send.requests) == (1, [])
    assert any(line.startswith(f"REFUSED {CHECK}") for line in r.lines)


def test_server_error_blocks_republish(run_dir: Path) -> None:
    # A 5xx may have created the asset, so it is "unknown" and a rerun refuses it.
    run = run_publish(PublishOptions(str(run_dir)), ENV, FakeSend(HttpResponse(500, b"oops")))
    assert run.exit_code == 1
    assert load_receipts(run_dir)[0].status == "unknown"
    send = FakeSend()
    again = run_publish(PublishOptions(str(run_dir)), ENV, send)
    assert send.requests == []
    assert any(line.startswith("REFUSED") for line in again.lines)


def test_failed_asset_is_retried_on_next_run(run_dir: Path) -> None:
    run_publish(PublishOptions(str(run_dir)), ENV, FakeSend(HttpResponse(400, b"bad")))
    send = FakeSend(rule_ok("r1"))
    run_publish(PublishOptions(str(run_dir)), ENV, send)
    assert len(send.requests) == 1
    assert load_receipts(run_dir)[0].status == "imported"


def test_prometheus_rules_and_sources_are_never_sent(run_dir: Path) -> None:
    send = FakeSend(rule_ok("r1"), dashboard_ok("d1"), dashboard_ok("d2"))
    run_publish(PublishOptions(str(run_dir), allow_partial=True), ENV, send)
    kinds = [req.url.split("?")[0].rsplit("/", 1)[1] for req in send.requests]
    assert kinds == ["check-rule", "dashboard", "dashboard"]


def test_missing_env_names_variables_only(run_dir: Path) -> None:
    with pytest.raises(InputError, match="^missing env: DASH0_AUTH_TOKEN$"):
        run_publish(PublishOptions(str(run_dir)), {**ENV, "DASH0_AUTH_TOKEN": ""}, FakeSend())


def test_cli_dry_run(
    run_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    code = main(["publish", "--from", str(run_dir), "--dry-run"])
    out = capsys.readouterr().out
    assert code == 2
    assert "DRY-RUN POST" in out and TOKEN not in out


def test_name_prefix_renames_sent_bodies_not_files(run_dir: Path) -> None:
    before = {p: (run_dir / p).read_bytes() for p in (CHECK, DASH_METRICS, DASH_OVERVIEW)}
    send = FakeSend(rule_ok("r1"), dashboard_ok("d1"), dashboard_ok("d2"))
    run = run_publish(
        PublishOptions(str(run_dir), allow_partial=True, name_prefix="demo-"), ENV, send
    )
    assert run.exit_code == 2, run.lines  # replication_delay is still blocked
    bodies = [json.loads(r.body or b"{}") for r in send.requests]
    assert bodies[0]["name"].startswith("demo-[Postgres] Number of connections")
    assert bodies[1]["metadata"]["name"] == "demo-postgres-metrics"
    assert bodies[1]["spec"]["display"]["name"] == "demo-Postgres - Metrics"
    assert bodies[2]["spec"]["display"]["name"] == "demo-Postgres - Overview"
    # The artifacts on disk (and so their sha256) are unchanged.
    assert {p: (run_dir / p).read_bytes() for p in before} == before
    assert all(r.name_prefix == "demo-" for r in run.receipts)
    saved = json.loads((run_dir / "import-results.json").read_text())
    assert {r["namePrefix"] for r in saved} == {"demo-"}
    # The listing matches the prefixed metadata.name, so the right ids are recorded.
    assert {r["path"]: r["id"] for r in saved} == {
        CHECK: "r1",
        DASH_METRICS: "d1",
        DASH_OVERVIEW: "d2",
    }


def test_name_prefix_shows_in_dry_run(run_dir: Path) -> None:
    run = run_publish(
        PublishOptions(str(run_dir), dry_run=True, name_prefix="demo-"), ENV, FakeSend()
    )
    assert any("demo-[Postgres] Number of connections" in line for line in run.lines)


def test_rerun_with_same_prefix_is_unchanged_other_prefix_refused(run_dir: Path) -> None:
    opts = PublishOptions(str(run_dir), name_prefix="demo-")
    run_publish(opts, ENV, FakeSend(rule_ok("r1")))
    again = run_publish(opts, ENV, FakeSend())
    assert any(line.startswith("UNCHANGED") for line in again.lines)
    for other in (None, "demo2-"):
        send = FakeSend()
        run = run_publish(PublishOptions(str(run_dir), name_prefix=other), ENV, send)
        assert run.exit_code == 1
        assert any("another --name-prefix" in line for line in run.lines)
        assert send.requests == []


@pytest.mark.parametrize("prefix", ["", "Demo-", "demo_", "-demo", "{{x}}", "a" * 33, "demo "])
def test_rejects_invalid_name_prefix(run_dir: Path, prefix: str) -> None:
    with pytest.raises(InputError, match="--name-prefix"):
        run_publish(PublishOptions(str(run_dir), name_prefix=prefix), ENV, FakeSend())


def test_cli_name_prefix(
    run_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    code = main(["publish", "--from", str(run_dir), "--dry-run", "--name-prefix", "demo-"])
    assert code == 2
    assert "demo-[Postgres]" in capsys.readouterr().out
    assert main(["publish", "--from", str(run_dir), "--dry-run", "--name-prefix", "BAD"]) == 1
