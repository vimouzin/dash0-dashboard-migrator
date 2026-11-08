"""One-shot orchestration, read-back evidence and resumable publication."""

from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import json
import math
import operator
import os
import re
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import promql_parser as prom
from pydantic import ValidationError

from live_compare_support.comparison import DataError, Series, compare
from live_compare_support.config import (
    ROOT,
    Case,
    Suite,
    Workload,
    load,
    read_json,
    resolve,
    save_json,
)
from live_compare_support.credentials import load_environment, read_query_config
from live_compare_support.environment import Environment, collector_config
from live_compare_support.queries import (
    BoundQuery,
    pair,
    query_source,
    query_target,
    validate_ingestion_key,
    with_semantic_mode,
)
from migrator.convert import ConvertOptions, run_convert
from migrator.destination.dash0 import Dash0Config, read_back, read_dash0_config
from migrator.http import HttpSend, urllib_send
from migrator.input import InputError
from migrator.publish import PublishOptions, run_publish
from migrator.receipts import load_receipts
from migrator.report import CONVERTED

EnvironmentFactory = Callable[..., Environment]


def compile_suite(suite: Suite, config: Path, directory: Path) -> None:
    run_convert(
        ConvertOptions(
            "datadog",
            [str(resolve(config, p)) for p in suite.inputs],
            [str(resolve(config, p)) for p in suite.mappings],
            str(directory),
        )
    )


def artifact(root: Path, case: Case) -> tuple[str, Any, Any]:
    manifest = read_json(root / "manifest.json")
    kind = "dashboard" if case.kind == "dashboard" else "check-rule"
    entries = [e for e in manifest["entries"] if e["sourceId"] == case.source and e["kind"] == kind]
    sources = [
        e for e in manifest["entries"] if e["sourceId"] == case.source and e["kind"] == "source"
    ]
    if len(sources) != 1:
        raise InputError(f"case {case.id}: sourceId is missing or ambiguous")
    # Tagged artifacts participate in numeric parity; behavior equivalence is separate.
    if len(entries) != 1 or entries[0]["outcome"] not in CONVERTED:
        raise DataError(
            f"case {case.id}: conversion is blocked or partial; inspect compiled/report.json"
        )
    entry = entries[0]
    for item in [sources[0], entry]:
        path = (root / item["path"]).resolve()
        if not path.is_relative_to(root.resolve()):
            raise InputError("manifest path escapes compiled directory")
        if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise InputError("compiled artifact hash mismatch")
    return entry["path"], read_json(root / sources[0]["path"]), read_json(root / entry["path"])


def bind_case(root: Path, case: Case, suite: Suite, run_id: str) -> tuple[str, BoundQuery]:
    path, source, target = artifact(root, case)
    outcome, remarks = conversion_details(root, case)
    if case.expected_outcome is not None and outcome != case.expected_outcome:
        raise DataError(f"case {case.id}: expected {case.expected_outcome}, got {outcome}")
    if case.expected_remarks is not None and sorted(remarks) != sorted(case.expected_remarks):
        raise DataError(
            f"case {case.id}: expected remark tags {case.expected_remarks}, got {remarks}"
        )
    try:
        bound = pair(case, source, target, suite.rate_interval, run_id)
    except (KeyError, IndexError, TypeError, ValueError) as err:
        raise InputError(
            f"case {case.id}: invalid source/target reference ({type(err).__name__})"
        ) from None
    if bound.monitor_window and (
        bound.monitor_window % suite.step_seconds or suite.warmup_seconds < bound.monitor_window
    ):
        raise InputError("monitor window must align to step and fit within warm-up")
    return path, bound


def conversion_details(root: Path, case: Case) -> tuple[str, list[str]]:
    source_path = (
        case.request.rsplit("/definition/requests/", 1)[0]
        .strip("/")
        .replace("/definition/", ".definition.")
        if case.kind == "dashboard"
        else ""
    )
    source_path = re.sub(r"widgets/(\d+)", r"widgets[\1]", source_path)
    source_path = source_path.replace("/", ".")
    matches = [
        item
        for item in read_json(root / "report.json")["items"]
        if item["sourceId"] == case.source
        and item["kind"] == ("widget" if case.kind == "dashboard" else "monitor")
        and item["sourcePath"] == source_path
    ]
    if len(matches) != 1:
        raise DataError(f"case {case.id}: missing conversion outcome")
    return matches[0]["outcome"], matches[0].get("remarks", [])


def validate_readback(expected: Any, actual: Any, kind: str, prefix: str) -> bool:
    expected = copy.deepcopy(expected)
    if not isinstance(actual, dict):
        return False
    if "dash0.com/deleted-at" in actual.get("metadata", {}).get("annotations", {}):
        return False
    if kind == "dashboard":
        expected["metadata"]["name"] = prefix + expected["metadata"]["name"]
        expected["spec"]["display"]["name"] = prefix + expected["spec"]["display"]["name"]
        metadata = actual.get("metadata", {})
        return (
            actual.get("kind") == "Dashboard"
            and actual.get("spec") == expected["spec"]
            and metadata.get("name") == expected["metadata"]["name"]
            and metadata.get("project") == expected["metadata"]["project"]
            and "dash0.com/deleted-at" not in metadata.get("annotations", {})
        )
    expected["name"] = prefix + expected["name"]
    if expected.get("enabled") is not False or actual.get("enabled") is not False:
        return False
    for key, value in expected.items():
        if key in ("interval", "for"):
            if actual.get(key) == value:
                continue
            try:
                if prom.parse_duration(value) != prom.parse_duration(actual.get(key, "")):
                    return False
            except ValueError:
                return False
        elif actual.get(key) != value:
            return False
    return True


def read_assets(
    root: Path, cfg: Dash0Config, prefix: str, send: HttpSend
) -> tuple[dict[str, Any], list[Any]]:
    remote = {}
    evidence = []
    entries = {e["path"]: e for e in read_json(root / "manifest.json")["entries"]}
    for receipt in load_receipts(root):
        if receipt.status != "imported" or not receipt.id:
            evidence.append(
                {
                    "path": receipt.path,
                    "id": receipt.id,
                    "readback": "not_run",
                    "publication": receipt.status,
                }
            )
            continue
        if (receipt.api_url, receipt.dataset, receipt.name_prefix) != (
            cfg.api_url,
            cfg.dataset,
            prefix,
        ):
            raise InputError("receipt belongs to another destination or name prefix")
        kind = entries[receipt.path]["kind"]
        if kind not in ("dashboard", "check-rule"):
            raise InputError("unexpected receipt kind")
        try:
            actual = read_back(kind, receipt.id, cfg, send)
        except RuntimeError:
            evidence.append({"path": receipt.path, "id": receipt.id, "readback": "error"})
            continue
        valid = validate_readback(read_json(root / receipt.path), actual, kind, prefix)
        evidence.append(
            {"path": receipt.path, "id": receipt.id, "readback": "passed" if valid else "failed"}
        )
        if valid:
            remote[receipt.path] = actual
    return remote, evidence


def monitor_values(
    series: list[Series], bound: BoundQuery, times: list[int], step: int
) -> list[Series]:
    reducers: dict[str, Callable[[list[float]], float]] = {
        "avg": lambda v: sum(v) / len(v),
        "min": min,
        "max": max,
        "sum": sum,
    }
    out = []
    expected = set(range(times[0] - bound.monitor_window + step, times[-1] + step, step))
    for s in series:
        if set(s.samples) != expected:
            raise DataError("monitor source lookback has incomplete coverage")
        values = {
            t: reducers[bound.monitor_aggregator](
                [s.samples[x] for x in range(t - bound.monitor_window + step, t + step, step)]
            )
            for t in times
        }
        out.append(Series(s.labels, values))
    return out


def threshold_decisions(series: list[Series], bound: BoundQuery) -> list[Series]:
    operations = {">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le}
    thresholds = bound.thresholds or {}
    # Encode each threshold independently; a critical/degraded mismatch is never
    # hidden by numeric averaging or tolerance.
    out = []
    for s in series:
        for name, threshold in sorted(thresholds.items()):
            out.append(
                Series(
                    {**s.labels, "threshold": name},
                    {
                        t: float(operations[bound.comparator](v, threshold))
                        for t, v in s.samples.items()
                    },
                )
            )
    return out


def redact(message: str, env: Mapping[str, str]) -> str:
    for name in ["DD_API_KEY", "DD_APP_KEY", "DD_BEARER_TOKEN", "DATADOG_PAT", "DASH0_AUTH_TOKEN"]:
        if env.get(name):
            message = message.replace(env[name], "<redacted>")
    return message[:800]


def write_evidence(out: Path, report: dict[str, Any]) -> None:
    save_json(out / "comparison.json", report)
    lines = [
        "# Live comparison",
        "",
        f"Status: **{report['status']}**",
        "",
        f"Dataset: `{report['dataset']}`; run: `{report['runId']}`",
        "",
        "| Case | Conversion | Remarks | Result | Details |",
        "|---|---|---|---|---|",
    ]
    for case in report["cases"]:
        detail = case.get("error", f"{len(case.get('series', []))} matched series")
        lines.append(
            f"| {case['id']} | {case.get('conversionOutcome', '')} | "
            f"{','.join(case.get('remarks', []))} | {case['status']} | {detail.replace('|', '/')} |"
        )
    if report.get("window"):
        lines.extend(["", f"UTC Unix-second window: `{report['window']}`."])
    for case in report["cases"]:
        if case.get("executedTarget"):
            lines.extend(
                [
                    "",
                    f"## {case['id']}",
                    "",
                    "Datadog queries:",
                    "```json",
                    json.dumps(case["sourceQueries"], indent=2),
                    "```",
                    f"Formula: `{case['sourceFormula']}`",
                    "",
                    "Dash0 scoped expression:",
                    "```promql",
                    case["executedTarget"],
                    "```",
                    f"Mode: `{case['mode']}`; relative tolerance "
                    f"{case['relativeTolerancePct']}%; absolute tolerance "
                    f"{case['absoluteTolerance']}.",
                ]
            )
        for s in case.get("series", []):
            lines.extend(
                [
                    "",
                    f"- `{case['id']}` {s['labels']}: Datadog {s['source']}; "
                    f"Dash0 {s['destination']}; coverage {s['coverage']:.0%}; "
                    f"maximum difference {s['maxAbsoluteDifference']:.6g}.",
                ]
            )
        if case.get("thresholdDecisions"):
            lines.extend(["", "Threshold decisions: " + case["thresholdDecisions"]["status"]])
    lines.extend(["", "Asset read-back:"])
    for asset in report.get("assets", []):
        lines.append(f"- `{asset['path']}`: `{asset['id']}` — {asset['readback']}")
    if report.get("error"):
        lines.extend(["", report["error"]])
    lines.extend(["", "Checks remain disabled. This evidence covers only the selected cases."])
    (out / "comparison.md").write_text("\n".join(lines) + "\n")


def fingerprint(
    workload: Workload,
    suite: Suite,
    profile: Path,
    scratch: Path,
    dataset: str,
    env: Mapping[str, str],
    selected: list[str],
) -> str:
    parts = [
        json.dumps(
            [
                workload.model_dump(),
                suite.model_dump(),
                dataset,
                selected,
                env.get("DD_SITE", "datadoghq.eu"),
                env.get("DASH0_API_URL"),
                env.get("DASH0_OTLP_ENDPOINT"),
            ],
            sort_keys=True,
        ).encode(),
        (ROOT / "scripts/live/images.lock.json").read_bytes(),
    ]
    parts.extend(p.read_bytes() for p in sorted(scratch.rglob("*")) if p.is_file())
    parts.extend(resolve(profile, p).read_bytes() for p in workload.seed_sql)
    if workload.feature_flags:
        parts.append(resolve(profile, workload.feature_flags).read_bytes())
    return hashlib.sha256(b"\0".join(parts)).hexdigest()


def stream_fingerprint(
    workload: Workload, profile: Path, dataset: str, env: Mapping[str, str]
) -> str:
    """Bind a stream to its workload/exporters, independently of test-suite selection."""
    values = [
        workload.model_dump(),
        collector_config(workload, "demo-live-fingerprint"),
        dataset,
        env.get("DD_SITE"),
        env.get("DASH0_API_URL"),
        env.get("DASH0_OTLP_ENDPOINT"),
    ]
    parts = [
        json.dumps(values, sort_keys=True).encode(),
        (ROOT / "scripts/live/images.lock.json").read_bytes(),
    ]
    parts.extend(resolve(profile, p).read_bytes() for p in workload.seed_sql)
    if workload.feature_flags:
        parts.append(resolve(profile, workload.feature_flags).read_bytes())
    return hashlib.sha256(b"\0".join(parts)).hexdigest()


def execute(
    args: argparse.Namespace,
    env: Mapping[str, str],
    send: HttpSend,
    make_environment: EnvironmentFactory,
    now: Callable[[], float],
    sleep: Callable[[float], None],
) -> int:
    workload, suite = load(args.dataset_config, Workload), load(args.tests, Suite)
    for p in workload.seed_sql:
        if not resolve(args.dataset_config, p).is_file():
            raise InputError("seed SQL file missing")
    if workload.feature_flags:
        flags = read_json(resolve(args.dataset_config, workload.feature_flags))
        if not isinstance(flags, dict) or not isinstance(flags.get("flags"), dict):
            raise InputError("feature_flags must be a flagd JSON document")
    chosen = set(args.case or [c.id for c in suite.cases])
    if not chosen <= {c.id for c in suite.cases}:
        raise InputError("unknown --case id")
    cases = [c for c in suite.cases if c.id in chosen]
    with tempfile.TemporaryDirectory(prefix="live-compare-") as temp, ExitStack() as resources:
        scratch = Path(temp) / "compiled"
        compile_suite(suite, args.tests, scratch)
        blocked: list[dict[str, Any]] = []
        for case in cases:
            try:
                bind_case(scratch, case, suite, "demo-live-dry-run")
            except DataError as err:
                blocked.append({"id": case.id, "status": "blocked", "error": str(err)})
        if args.dry_run:
            print(
                f"DRY-RUN: {len(cases)} cases, {len(blocked)} blocked; "
                "no containers started or vendor requests sent"
            )
            for item in blocked:
                print(item["error"])
            return 2 if blocked else 0
        run_env = dict(env)
        run_env["DASH0_DATASET"] = args.dash0_dataset
        run_env.setdefault("DD_SITE", "datadoghq.eu")
        cfg, dd = read_dash0_config(run_env), read_query_config(run_env)
        for name in ["DASH0_API_URL", "DASH0_OTLP_ENDPOINT"]:
            url = urlsplit(run_env.get(name, ""))
            if (
                url.scheme != "https"
                or not url.hostname
                or url.username is not None
                or url.query
                or url.fragment
            ):
                raise InputError(
                    f"{name} must be an explicit HTTPS endpoint without credentials/query"
                )
        stream = None
        if args.start_stream or args.stop_stream or args.stream_dir:
            if args.stream_dir is None:
                raise InputError("stream operations require --stream-dir")
            stream_dir = args.stream_dir.resolve()
            stream_dir.mkdir(parents=True, exist_ok=True)
            stream_lock = resources.enter_context((stream_dir / ".lock").open("w"))
            try:
                fcntl.flock(stream_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise InputError("another process owns this stream") from None
            stream_path = stream_dir / "stream.json"
            stream_digest = stream_fingerprint(workload, args.dataset_config, cfg.dataset, run_env)
            if stream_path.exists():
                stream = read_json(stream_path)
                if stream.get("configDigest") != stream_digest and not args.stop_stream:
                    if args.start_stream and stream.get("status") == "stopped":
                        stream["configDigest"] = stream_digest
                    else:
                        raise InputError(
                            "stream workload/destination changed; stop it before restarting"
                        )
                if not re.fullmatch(r"demo-live-[a-f0-9]{12}", stream.get("runId", "")):
                    raise InputError("invalid saved stream identifier")
            elif not args.start_stream:
                raise InputError("stream is missing; use --start-stream first")
            else:
                if any(p.name != ".lock" for p in stream_dir.iterdir()):
                    raise InputError("stream directory contains unrelated files")
                stream = {
                    "runId": "demo-live-" + uuid.uuid4().hex[:12],
                    "configDigest": stream_digest,
                    "status": "starting",
                }
                save_json(stream_path, stream)
            stream_environment = make_environment(
                stream_dir / "runtime", workload, args.dataset_config, stream["runId"], run_env
            )
            if args.stop_stream:
                stream_environment.stop()
                stream["status"] = "stopped"
                save_json(stream_path, stream)
                print("Telemetry stream stopped", flush=True)
                return 0
            if args.start_stream:
                if stream.get("status") == "running":
                    if not stream_environment.healthy():
                        raise DataError("retained stream is unhealthy; stop it before restarting")
                    print(f"Telemetry stream already running: {stream['runId']}", flush=True)
                    return 0
                if not run_env.get("DD_API_KEY", "").strip():
                    raise InputError("DD_API_KEY is required for telemetry ingestion")
                validate_ingestion_key(run_env["DD_API_KEY"].strip(), dd, send)
                # Query authentication is checked before starting an exporter.
                if not cases or blocked:
                    raise DataError("stream startup suite must have no blocked cases")
                _, probe = bind_case(scratch, cases[0], suite, stream["runId"])
                probe = with_semantic_mode(probe, args.datadog_semantic_mode)
                end_probe = int(now()) // suite.step_seconds * suite.step_seconds
                query_source(
                    probe, end_probe - suite.step_seconds, end_probe, suite.step_seconds, dd, send
                )
                query_target(
                    probe, end_probe - suite.step_seconds, end_probe, suite.step_seconds, cfg, send
                )
                try:
                    stream_environment.stop()
                    stream_environment.prepare()
                    stream_environment.start()
                    stream.update(status="running", startedAt=now())
                    save_json(stream_path, stream)
                except BaseException:
                    stream_environment.stop()
                    stream["status"] = "stopped"
                    save_json(stream_path, stream)
                    raise
                print(
                    f"Telemetry stream running: {stream['runId']}; "
                    "startup does not wait for a measurement window",
                    flush=True,
                )
                return 0
            if stream.get("status") != "running" or not stream_environment.healthy():
                raise DataError(
                    "retained stream is stopped or unhealthy; start a healthy stream first"
                )
            end = int(now() - suite.settle_seconds) // suite.step_seconds * suite.step_seconds
            start = end - suite.window_seconds
            if start - suite.warmup_seconds < stream["startedAt"]:
                raise DataError(
                    "stream has insufficient history; leave it running and retry "
                    "(no wait performed)"
                )
        digest = fingerprint(
            workload, suite, args.dataset_config, scratch, cfg.dataset, run_env, sorted(chosen)
        )
        out = args.out.resolve()
        out.mkdir(parents=True, exist_ok=True)
        with (out / ".lock").open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise InputError("another process owns this run directory") from None
            state_path = out / "state.json"
            if state_path.exists():
                state = read_json(state_path)
                if state["configDigest"] != digest:
                    raise InputError(
                        "run inputs/configuration/destination changed; use a new --out"
                    )
                if not re.fullmatch(r"demo-live-[a-f0-9]{12}", state["runId"]):
                    raise InputError("invalid saved run identifier")
                if state.get("publicationInFlight"):
                    raise InputError(
                        "previous publication was interrupted; reconcile Dash0 and "
                        "receipts before clearing publicationInFlight in state.json"
                    )
            else:
                if any(p.name != ".lock" for p in out.iterdir()):
                    raise InputError("output directory is not a live comparison run")
                state = {
                    "runId": stream["runId"] if stream else "demo-live-" + uuid.uuid4().hex[:12],
                    "configDigest": digest,
                    "collectionComplete": False,
                    "publicationInFlight": False,
                }
                if stream:
                    state.update(
                        start=start,
                        end=end,
                        collectionComplete=True,
                        streamDir=str(args.stream_dir.resolve()),
                        namePrefix="demo-live-" + uuid.uuid4().hex[:12] + "-",
                    )
                save_json(state_path, state)
            if stream and (
                state.get("streamDir") != str(args.stream_dir.resolve())
                or state["runId"] != stream["runId"]
            ):
                raise InputError("saved comparison belongs to another stream")
            if not stream and state.get("streamDir"):
                raise InputError("saved comparison requires its --stream-dir")
            compiled = out / "compiled"
            if not compiled.exists():
                import shutil

                shutil.copytree(scratch, compiled)
            else:
                for file in scratch.rglob("*"):
                    if (
                        file.is_file()
                        and (compiled / file.relative_to(scratch)).read_bytes() != file.read_bytes()
                    ):
                        raise InputError("saved conversion artifacts were modified")
            run_id = state["runId"]
            environment = make_environment(
                out / "runtime", workload, args.dataset_config, run_id, run_env
            )
            prefix = state.get("namePrefix", run_id + "-")
            report: dict[str, Any] = {
                "version": 1,
                "runId": run_id,
                "dataset": cfg.dataset,
                "status": "failed",
                "assets": [],
                "cases": list(blocked),
                "querySettings": {"datadogSemanticModeOverride": args.datadog_semantic_mode},
                "stream": {"runId": stream["runId"], "startedAt": stream["startedAt"]}
                if stream
                else None,
            }
            operational_error = False
            try:
                if len(blocked) == len(cases):
                    report["status"] = "blocked"
                    return 2
                first = next(c for c in cases if c.id not in {b["id"] for b in blocked})
                _, preflight = bind_case(compiled, first, suite, run_id)
                preflight = with_semantic_mode(preflight, args.datadog_semantic_mode)
                # Auth/dataset checks happen before containers or publication.
                end_probe = int(now()) // suite.step_seconds * suite.step_seconds
                query_source(
                    preflight,
                    end_probe - suite.step_seconds,
                    end_probe,
                    suite.step_seconds,
                    dd,
                    send,
                )
                query_target(
                    preflight,
                    end_probe - suite.step_seconds,
                    end_probe,
                    suite.step_seconds,
                    cfg,
                    send,
                )
                report["authentication"] = {"datadogQuery": "passed", "dash0Query": "passed"}
                if not run_env.get("DD_API_KEY", "").strip():
                    raise InputError(
                        "Datadog/Dash0 query authentication passed, but metric ingestion requires "
                        "DD_API_KEY in .env; DATADOG_PAT/DD_BEARER_TOKEN authenticates queries "
                        "and does not replace the Collector's ingestion API key"
                    )
                validate_ingestion_key(run_env["DD_API_KEY"].strip(), dd, send)
                report["authentication"]["datadogIngestion"] = "passed"
                if not state["collectionComplete"]:
                    environment.stop()  # clean up only this run after a previous interruption
                    environment.prepare()
                    environment.start()
                    start = (
                        math.ceil((now() + suite.warmup_seconds) / suite.step_seconds)
                        * suite.step_seconds
                    )
                    state.update(start=start, end=start + suite.window_seconds)
                    save_json(state_path, state)
                    until = state["end"] + suite.settle_seconds
                    while now() < until:
                        remaining = until - now()
                        print(
                            f"Collecting shared samples: {math.ceil(remaining)}s remaining",
                            flush=True,
                        )
                        sleep(min(30, remaining))
                    state["collectionComplete"] = True
                    save_json(state_path, state)
                report["window"] = {
                    "start": state["start"],
                    "endExclusive": state["end"],
                    "step": suite.step_seconds,
                }
                state["publicationInFlight"] = True
                save_json(state_path, state)
                published = run_publish(
                    PublishOptions(str(compiled), name_prefix=prefix), run_env, send
                )
                state["publicationInFlight"] = False
                save_json(state_path, state)
                report["publicationExitCode"] = published.exit_code
                report["conversionSummary"] = read_json(compiled / "report.json")["summary"]
                if published.exit_code == 1:
                    operational_error = True
                    report["error"] = (
                        "some publications failed or are ambiguous; inspect import-results.json; "
                        "only successfully read-back assets are compared"
                    )
                remote, report["assets"] = read_assets(compiled, cfg, prefix, send)
                times = list(range(state["start"], state["end"], suite.step_seconds))
                for case in cases:
                    if case.id in {b["id"] for b in blocked}:
                        continue
                    result: dict[str, Any] = {
                        "id": case.id,
                        "mode": case.mode,
                        "relativeTolerancePct": case.relative_tolerance_pct,
                        "absoluteTolerance": case.absolute_tolerance,
                    }
                    outcome, remarks = conversion_details(compiled, case)
                    result.update(conversionOutcome=outcome, remarks=remarks)
                    result["validationScope"] = "shared_sample_numeric_parity"
                    if remarks:
                        result["remarkBehaviorValidation"] = "not_run"
                    try:
                        path, _ = bind_case(compiled, case, suite, run_id)
                        if path not in remote:
                            raise DataError("published asset read-back failed or receipt missing")
                        _, source, _ = artifact(compiled, case)
                        bound = pair(case, source, remote[path], suite.rate_interval, run_id)
                        bound = with_semantic_mode(bound, args.datadog_semantic_mode)
                        result.update(
                            sourceQueries=bound.queries,
                            sourceFormula=bound.formula,
                            executedTarget=bound.target,
                            artifact=path,
                        )
                        lookback = max(0, bound.monitor_window - suite.step_seconds)
                        a = query_source(
                            bound, times[0] - lookback, state["end"], suite.step_seconds, dd, send
                        )
                        b = query_target(
                            bound, times[0], state["end"], suite.step_seconds, cfg, send
                        )
                        if bound.monitor_window:
                            a = monitor_values(a, bound, times, suite.step_seconds)
                        result.update(compare(case, a, b, times))
                        if bound.thresholds:
                            decision_case = case.model_copy(
                                update={
                                    "mode": "per_bucket",
                                    "relative_tolerance_pct": 0,
                                    "absolute_tolerance": 0,
                                    "require_nonzero": False,
                                    "series_labels": {
                                        **case.series_labels,
                                        "threshold": "threshold",
                                    },
                                }
                            )
                            decisions = compare(
                                decision_case,
                                threshold_decisions(a, bound),
                                threshold_decisions(b, bound),
                                times,
                            )
                            result["thresholdDecisions"] = decisions
                            if decisions["status"] != "passed":
                                result["status"] = "failed"
                    except DataError as err:
                        result.update(status="failed", error=str(err))
                    except RuntimeError as err:
                        operational_error = True
                        result.update(status="error", error=redact(str(err), run_env))
                    report["cases"].append(result)
                    print(f"{case.id}: {result['status']}", flush=True)
                report["status"] = (
                    "passed"
                    if (
                        published.exit_code in (0, 2)
                        and not blocked
                        and all(c["status"] == "passed" for c in report["cases"])
                        and all(a["readback"] == "passed" for a in report["assets"])
                    )
                    else "failed"
                )
            except (Exception, KeyboardInterrupt) as err:
                operational_error = True
                report["error"] = redact(
                    "interrupted" if isinstance(err, KeyboardInterrupt) else str(err), run_env
                )
                print(f"error: {report['error']}", flush=True)
            finally:
                if not args.keep_running and not stream:
                    try:
                        environment.stop()
                        report["containers"] = "stopped"
                    except (Exception, KeyboardInterrupt):
                        operational_error = True
                        report.update(status="failed", cleanupError="container cleanup failed")
                else:
                    report["containers"] = "retained"
                write_evidence(out, report)
            return 1 if operational_error else (0 if report["status"] == "passed" else 2)


def main(
    argv: Sequence[str] | None = None,
    env: Mapping[str, str] | None = None,
    send: HttpSend = urllib_send,
    make_environment: EnvironmentFactory = Environment,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    parser = argparse.ArgumentParser(description="On-demand Datadog → Dash0 live comparison")
    parser.add_argument("--dataset-config", required=True, type=Path)
    parser.add_argument("--tests", required=True, type=Path)
    parser.add_argument("--dash0-dataset", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--case", action="append")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--keep-running", action="store_true")
    parser.add_argument(
        "--stream-dir", type=Path, help="reuse an isolated running telemetry stream"
    )
    lifecycle = parser.add_mutually_exclusive_group()
    lifecycle.add_argument(
        "--start-stream",
        action="store_true",
        help="start ingestion and return without warm-up/measurement waits",
    )
    lifecycle.add_argument(
        "--stop-stream", action="store_true", help="stop only the selected telemetry stream"
    )
    parser.add_argument(
        "--datadog-semantic-mode",
        choices=["native", "combined"],
        help="explicit query evaluation override; shared OTel samples use combined",
    )
    env_files = parser.add_mutually_exclusive_group()
    env_files.add_argument(
        "--env-file", type=Path, help="literal .env file (default: repository .env when present)"
    )
    env_files.add_argument("--no-env-file", action="store_true", help="use only shell credentials")
    args = parser.parse_args(argv)
    environment = dict(os.environ if env is None else env)
    try:
        path = args.env_file
        if path is None and env is None and not args.no_env_file and (ROOT / ".env").is_file():
            path = ROOT / ".env"
        environment = load_environment(environment, path)
        if not args.dash0_dataset.strip():
            raise InputError("--dash0-dataset must be nonempty")
        return execute(args, environment, send, make_environment, now, sleep)
    except DataError as err:
        print(f"blocked: {redact(str(err), environment)}")
        return 2
    except (OSError, InputError, ValueError, ValidationError, RuntimeError) as err:
        print(f"error: {redact(str(err), environment)}")
        return 1
