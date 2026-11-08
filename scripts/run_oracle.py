"""Ask the Agent0 oracle about many dashboards in parallel (development time only).

Agent0 proposes expected test outcomes. Its answers are provenance for
fixtures/expected/ and are reviewed by a human. This script is never part of the
conversion path (AGENTS.md): nothing under src/ imports it, and the converter
never reads its output.

Usage:
  uv run scripts/run_oracle.py [INPUT_JSON] [--jobs N] [--retries N]
                                [--full] [--case SVC/ID ...] [--out-dir DIR]
                                [--adopt-existing] [--dry-run]

  scripts/render_oracle_prompt.py -> fixtures/oracle/agent0/<key>/{prompt.md, answer.yaml}
  -> scripts/build_expected.py. State: fixtures/oracle/agent0/state.json.
  --out-dir DIR            write <DIR>/<key>/... instead, keep state in <DIR>/state.json, and
                           never run build_expected (it only reads fixtures/oracle/agent0).

INPUT_JSON (default fixtures/oracle/dashboards.json):
  {"dataset": "default", "model_class": "advanced", "reasoning_effort": "high",
   "dashboards": [{"case": "postgres/postgresql_dashboard"}, {"case": "...", "dataset": "..."}]}
  Each case must exist as fixtures/cases/<case>.yaml (scripts/extract_cases.py).

State (fixtures/oracle/agent0/state.json) records each case's status, thread ID,
prompt hash, and attempts:
  - Default run: only cases not yet `done`. A `pending` case whose prompt did not
    change resumes waiting on its existing Agent0 thread instead of asking again.
  - --full: ask again for every case in the input.
  - --case: limit the run to these cases and ask again even if they are done.
  - --adopt-existing: record cases that already have an answer.yaml as `done`
    without asking (thread ID taken from the answer header).

Per case: render the fixed prompt (scripts/render_oracle_prompt.py) -> runTask
-> waitForTask until finished -> extract the YAML block -> validate it against the
case -> write prompt.md and answer.yaml verbatim -> scripts/build_expected.py.

Retries: a transport or tool error while waiting retries the same thread (it does
not open a second one). An invalid or empty answer starts a new thread. When the
wait limit is hit, the case stays `pending` with its thread ID and the next run
resumes it.

Auth: DASH0_AUTH_TOKEN (needs read access to the dataset) from the environment or
the repository .env. Endpoint: DASH0_MCP_URL, else DASH0_API_URL + "/mcp". With a
token connection Dash0 may run Agent0 at the organization's default model level;
the requested model class and effort are recorded either way.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import datetime as dt
import hashlib
import json
import os
import random
import re
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_expected  # noqa: E402
import render_oracle_prompt  # noqa: E402

DEFAULT_INPUT = ROOT / "fixtures" / "oracle" / "dashboards.json"
DEFAULT_STATE = ROOT / "fixtures" / "oracle" / "agent0" / "state.json"
AGENT0_DIR = ROOT / "fixtures" / "oracle" / "agent0"
DEFAULT_MCP_URL = "https://api.eu-west-1.aws.dash0.com/mcp"

STATE_VERSION = 1
MODEL_CLASSES = {"light", "standard", "advanced", "premium"}
REASONING_EFFORTS = {"low", "medium", "high", "xhigh", "max"}

THREAD_ID = re.compile(r"(?:thread_id=|Thread ID: `)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
YAML_BLOCK = re.compile(r"```ya?ml[ \t]*\n(.*?)\n```", re.DOTALL)
STILL_WORKING = re.compile(r"still working", re.IGNORECASE)




# --------------------------------------------------------------------------- errors


class InputError(Exception):
    """The input JSON or a case fixture is invalid. Not retried."""


class AnswerError(Exception):
    """Agent0 finished but its answer is unusable. Retried on a new thread."""


class WaitLimit(Exception):
    """Agent0 is still working after --max-wait. The case stays pending."""


# --------------------------------------------------------------------------- input


@dataclasses.dataclass(frozen=True)
class CaseSpec:
    key: str
    dataset: str
    model_class: str | None
    reasoning_effort: str | None


def load_input(path: Path) -> list[CaseSpec]:
    try:
        doc = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise InputError(f"{path}: {exc}") from exc
    if not isinstance(doc, dict):
        raise InputError(f"{path}: top level must be an object")
    unknown = set(doc) - {"dataset", "model_class", "reasoning_effort", "dashboards"}
    if unknown:
        raise InputError(f"{path}: unknown keys {sorted(unknown)}")
    defaults = {k: doc.get(k) for k in ("dataset", "model_class", "reasoning_effort")}
    dashboards = doc.get("dashboards")
    if not isinstance(dashboards, list) or not dashboards:
        raise InputError(f"{path}: 'dashboards' must be a non-empty list")

    specs: list[CaseSpec] = []
    seen: set[str] = set()
    for i, entry in enumerate(dashboards):
        where = f"{path}: dashboards[{i}]"
        if not isinstance(entry, dict) or not isinstance(entry.get("case"), str):
            raise InputError(f"{where}: needs a string 'case' (<service>/<dashboard_id>)")
        unknown = set(entry) - {"case", "dataset", "model_class", "reasoning_effort"}
        if unknown:
            raise InputError(f"{where}: unknown keys {sorted(unknown)}")
        key = entry["case"]
        if key in seen:
            raise InputError(f"{where}: duplicate case {key}")
        if not (ROOT / "fixtures" / "cases" / f"{key}.yaml").is_file():
            raise InputError(f"{where}: no fixtures/cases/{key}.yaml (run scripts/extract_cases.py)")
        merged = {k: entry.get(k, defaults[k]) for k in defaults}
        if not merged["dataset"]:
            raise InputError(f"{where}: no dataset (set it per case or at the top level)")
        if merged["model_class"] is not None and merged["model_class"] not in MODEL_CLASSES:
            raise InputError(f"{where}: model_class must be one of {sorted(MODEL_CLASSES)}")
        if merged["reasoning_effort"] is not None and merged["reasoning_effort"] not in REASONING_EFFORTS:
            raise InputError(f"{where}: reasoning_effort must be one of {sorted(REASONING_EFFORTS)}")
        seen.add(key)
        specs.append(CaseSpec(key, merged["dataset"], merged["model_class"], merged["reasoning_effort"]))
    return specs


def load_case(key: str) -> dict:
    return yaml.safe_load((ROOT / "fixtures" / "cases" / f"{key}.yaml").read_text())


def prompt_sha256(prompt: str) -> str:
    return hashlib.sha256(prompt.encode()).hexdigest()


# --------------------------------------------------------------------------- state


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class State:
    """Durable per-case record; every change is written atomically."""

    def __init__(self, path: Path):
        self.path = path
        self.cases: dict[str, dict[str, Any]] = {}
        if path.exists():
            doc = json.loads(path.read_text())
            if doc.get("version") != STATE_VERSION:
                raise InputError(f"{path}: unsupported state version {doc.get('version')!r}")
            self.cases = doc.get("cases", {})

    def get(self, key: str) -> dict[str, Any] | None:
        return self.cases.get(key)

    def update(self, key: str, **fields: Any) -> None:
        entry = self.cases.setdefault(key, {})
        entry.update(fields)
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        doc = {"version": STATE_VERSION, "cases": {k: self.cases[k] for k in sorted(self.cases)}}
        tmp.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, self.path)


@dataclasses.dataclass(frozen=True)
class Job:
    spec: CaseSpec
    prompt: str
    resume_thread_id: str | None


def select_jobs(
    specs: list[CaseSpec],
    state: State,
    prompts: dict[str, str],
    *,
    full: bool = False,
    only: set[str] | None = None,
) -> tuple[list[Job], list[str]]:
    """Return the jobs to run and warnings (stale done cases that will not be re-asked)."""
    jobs: list[Job] = []
    warnings: list[str] = []
    for spec in specs:
        if only is not None and spec.key not in only:
            continue
        prompt = prompts[spec.key]
        entry = state.get(spec.key) or {}
        same_prompt = entry.get("prompt_sha256") == prompt_sha256(prompt)
        forced = full or only is not None
        if entry.get("status") == "done" and not forced:
            if not same_prompt:
                warnings.append(f"{spec.key}: prompt changed since the answer was recorded (use --case or --full)")
            continue
        resume = None
        if not forced and entry.get("status") == "pending" and entry.get("thread_id") and same_prompt:
            resume = entry["thread_id"]
        jobs.append(Job(spec, prompt, resume))
    return jobs, warnings


# --------------------------------------------------------------------------- answers


def extract_thread_id(text: str) -> str | None:
    match = THREAD_ID.search(text)
    return match.group(1) if match else None


def extract_yaml_block(text: str) -> str | None:
    match = YAML_BLOCK.search(text)
    return match.group(1).strip("\n") + "\n" if match else None


def expected_promql_count(request: dict) -> int:
    return len(request.get("formulas") or []) or 1


def validate_answer(yaml_text: str, case: dict) -> list[dict]:
    """Structural checks only; semantics are reviewed by a human later."""
    try:
        items = yaml.safe_load(yaml_text)
    except yaml.YAMLError as exc:
        raise AnswerError(f"answer is not valid YAML: {exc}") from exc
    if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
        raise AnswerError("answer must be a YAML list of mappings")

    requests = {r["source_path"]: r for r in case["requests"]}
    errors: list[str] = []
    seen: set[str] = set()
    for item in items:
        sp = item.get("source_path")
        if sp not in requests:
            errors.append(f"unknown source_path {sp!r}")
            continue
        if sp in seen:
            errors.append(f"duplicate source_path {sp!r}")
        seen.add(sp)
        outcome = item.get("outcome")
        if outcome == "translated":
            promql = item.get("promql")
            want = expected_promql_count(requests[sp])
            if not isinstance(promql, list) or not all(isinstance(q, str) and q.strip() for q in promql):
                errors.append(f"{sp}: translated needs a list of PromQL strings")
            elif len(promql) != want:
                errors.append(f"{sp}: {len(promql)} PromQL strings for {want} displayed formula(s)")
            # `in_dataset` / `otel_source` came with the OTel-catalog prompt; answers recorded with the
            # older prompt have neither, so they are only checked when present.
            in_dataset = item.get("in_dataset")
            if in_dataset is not None and str(in_dataset).lower() not in ("yes", "no", "partly", "true", "false"):
                errors.append(f"{sp}: in_dataset must be yes, no or partly, got {in_dataset!r}")
            elif str(in_dataset).lower() in ("no", "partly", "false") and not item.get("otel_source"):
                errors.append(f"{sp}: in_dataset {in_dataset!r} needs otel_source")
        elif outcome == "blocked":
            if not item.get("reason"):
                errors.append(f"{sp}: blocked needs a reason")
        else:
            errors.append(f"{sp}: outcome must be translated or blocked, got {outcome!r}")
    missing = sorted(set(requests) - seen)
    if missing:
        errors.append(f"no answer for {len(missing)} request(s): {missing[:3]}{' ...' if len(missing) > 3 else ''}")
    if errors:
        raise AnswerError("; ".join(errors))
    return items


def answer_header(
    job: Job,
    thread_id: str,
    asked_at: str,
    *,
    kind: str = "answer",
    prompt_name: str = "prompt.md",
    note: str = "Provenance only, never test input.",
) -> str:
    model = "/".join(x for x in (job.spec.model_class, job.spec.reasoning_effort) if x) or "connection default"
    what, how = ("answer", "scripts/run_oracle.py") if kind == "answer" else (f"{kind} answer", f"scripts/run_oracle.py --mode {kind}")
    return (
        f"# Agent0 {what}, verbatim. Asked {asked_at} via dash0 MCP runTask ({how},"
        f" requested {model}), dataset {job.spec.dataset}, thread {thread_id},"
        f" prompt: {prompt_name} (sha256 {prompt_sha256(job.prompt)[:12]}).\n"
        f"# {note}\n"
    )


# --------------------------------------------------------------------------- modes


Writer = Callable[[Path, Job, str, str, list[dict], str], None]


@dataclasses.dataclass(frozen=True)
class Mode:
    """The mode-specific parts of a run. Runner, State, McpAgent0, retries and resume are shared."""

    name: str
    render: Callable[[str, str], str]  # (case key, dataset) -> prompt text
    validate: Callable[[str, dict], list[dict]]  # (answer YAML, case) -> items; raises AnswerError
    write: Writer  # (out_dir, job, thread_id, answer YAML, items, asked_at) -> files
    summary: Callable[[list[dict]], str]
    out_dir: Path
    state_path: Path
    prompt_name: str
    answer_name: str
    builds: bool  # run build_expected after an answer


def write_answer_files(out_dir: Path, job: Job, thread_id: str, answer_text: str, items: list[dict], asked_at: str) -> None:
    out = out_dir / job.spec.key
    out.mkdir(parents=True, exist_ok=True)
    (out / "prompt.md").write_text(job.prompt)
    (out / "answer.yaml").write_text(answer_header(job, thread_id, asked_at) + answer_text)


def answer_summary(items: list[dict]) -> str:
    return f"{sum(1 for i in items if i.get('outcome') == 'translated')}/{len(items)} translated"


MODES = ("answer",)


def get_mode(name: str = "answer", out_dir: Path | None = None) -> Mode:
    """The strategy for one mode; paths come from the module constants at call time. With `out_dir`
    the outputs and the default state move there and build_expected never runs."""
    if name == "answer":
        base = out_dir or AGENT0_DIR
        return Mode(
            name="answer",
            render=render_oracle_prompt.render,
            validate=validate_answer,
            write=write_answer_files,
            summary=answer_summary,
            out_dir=base,
            state_path=out_dir / "state.json" if out_dir else DEFAULT_STATE,
            prompt_name="prompt.md",
            answer_name="answer.yaml",
            builds=out_dir is None,
        )
    raise InputError(f"unknown mode {name!r} (one of {', '.join(MODES)})")


def header_thread_id(answer_path: Path) -> str | None:
    head = "".join(answer_path.read_text().splitlines(keepends=True)[:3])
    return extract_thread_id(head)


# --------------------------------------------------------------------------- Agent0 client


class Agent0(Protocol):
    async def start(self, job: Job) -> str:
        """Start a task; return the raw tool text (contains the thread ID, maybe the answer)."""

    async def wait(self, thread_id: str, dataset: str, timeout_s: int) -> str:
        """Wait for a task; return the raw tool text."""


class ToolError(Exception):
    pass


class McpAgent0:
    """Agent0 over the Dash0 MCP server (runTask / waitForTask). One MCP session per call."""

    def __init__(self, connect: Callable[[], contextlib.AbstractAsyncContextManager[Any]]):
        self._connect = connect

    @classmethod
    def over_http(cls, url: str, token: str, read_timeout_s: float = 900.0) -> McpAgent0:
        def connect() -> contextlib.AbstractAsyncContextManager[Any]:
            @contextlib.asynccontextmanager
            async def session() -> AsyncIterator[Any]:
                import httpx2  # installed with `mcp` (uv group "oracle")
                from mcp import Client
                from mcp.client.streamable_http import streamable_http_client

                http = httpx2.AsyncClient(
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=httpx2.Timeout(30.0, read=read_timeout_s),
                )
                async with http:
                    transport = streamable_http_client(url, http_client=http)
                    async with Client(transport, read_timeout_seconds=read_timeout_s) as client:
                        yield client

            return session()

        return cls(connect)

    async def _call(self, tool: str, arguments: dict[str, Any]) -> str:
        async with self._connect() as client:
            result = await client.call_tool(tool, arguments)
        text = "\n".join(getattr(b, "text", "") for b in result.content if getattr(b, "type", None) == "text")
        if result.is_error:
            raise ToolError(f"{tool} failed: {text[:300]}")
        return text

    async def start(self, job: Job) -> str:
        args: dict[str, Any] = {"message": job.prompt, "dataset": job.spec.dataset, "timeoutSeconds": 1}
        if job.spec.model_class:
            args["modelClass"] = job.spec.model_class
        if job.spec.reasoning_effort:
            args["reasoningEffort"] = job.spec.reasoning_effort
        return await self._call("runTask", args)

    async def wait(self, thread_id: str, dataset: str, timeout_s: int) -> str:
        return await self._call(
            "waitForTask", {"threadIdOrUrl": thread_id, "dataset": dataset, "timeoutSeconds": timeout_s}
        )


# --------------------------------------------------------------------------- runner


@dataclasses.dataclass
class Options:
    jobs: int = 3
    retries: int = 3
    max_wait_s: float = 1800.0
    wait_chunk_s: int = 600
    backoff_s: float = 5.0
    build: bool = True


@dataclasses.dataclass
class Result:
    key: str
    status: str  # done | pending | failed
    detail: str = ""


Sleep = Callable[[float], Awaitable[None]]
Log = Callable[[str], None]


class Runner:
    def __init__(
        self,
        agent0: Agent0,
        state: State,
        opts: Options,
        *,
        mode: Mode | None = None,
        agent0_dir: Path | None = None,
        sleep: Sleep = asyncio.sleep,
        clock: Callable[[], float] | None = None,
        log: Log = print,
        build: Callable[[str], None] | None = None,
    ):
        self.agent0 = agent0
        self.state = state
        self.opts = opts
        self.mode = mode or get_mode("answer")
        self.agent0_dir = agent0_dir or self.mode.out_dir  # output root: <dir>/<key>/...
        self.sleep = sleep
        self.clock = clock or (lambda: asyncio.get_running_loop().time())
        self.log = log
        self.build = build if build is not None else build_expected_for

    async def run(self, jobs: list[Job]) -> list[Result]:
        semaphore = asyncio.Semaphore(max(1, self.opts.jobs))

        async def guarded(job: Job) -> Result:
            async with semaphore:
                return await self.run_one(job)

        return list(await asyncio.gather(*(guarded(j) for j in jobs)))

    async def run_one(self, job: Job) -> Result:
        key = job.spec.key
        case = load_case(key)
        thread_id = job.resume_thread_id
        attempts = int((self.state.get(key) or {}).get("attempts", 0)) if thread_id else 0
        failures = 0
        last_error = ""
        while True:
            try:
                answer_text: str | None = None
                if thread_id is None:
                    attempts += 1
                    asked_at = now_iso()
                    text = await self.agent0.start(job)
                    thread_id = extract_thread_id(text)
                    if thread_id is None:
                        raise ToolError("runTask returned no thread ID")
                    self.state.update(
                        key,
                        status="pending",
                        thread_id=thread_id,
                        dataset=job.spec.dataset,
                        model_class=job.spec.model_class,
                        reasoning_effort=job.spec.reasoning_effort,
                        prompt_sha256=prompt_sha256(job.prompt),
                        asked_at=asked_at,
                        attempts=attempts,
                        error=None,
                    )
                    self.log(f"[{key}] started thread {thread_id} (attempt {attempts})")
                    answer_text = extract_yaml_block(text)
                else:
                    self.log(f"[{key}] waiting on thread {thread_id}")
                if answer_text is None:
                    answer_text = await self.wait_for_answer(thread_id, job.spec.dataset)
                items = self.mode.validate(answer_text, case)
                self.write_answer(job, thread_id, answer_text, items)
                summary = self.mode.summary(items)
                self.state.update(key, status="done", answered_at=now_iso(), error=None)
                if self.opts.build and self.mode.builds:
                    self.build(key)
                self.log(f"[{key}] done: {summary}")
                return Result(key, "done", summary)
            except WaitLimit as exc:
                self.state.update(key, status="pending", error=str(exc))
                self.log(f"[{key}] {exc}; rerun to resume thread {thread_id}")
                return Result(key, "pending", str(exc))
            except InputError:
                raise
            except AnswerError as exc:
                last_error = f"invalid answer on thread {thread_id}: {exc}"
                thread_id = None  # ask again on a fresh thread
            except Exception as exc:  # transport, protocol or tool error: same thread if we have one
                last_error = f"{type(exc).__name__}: {exc}"
            failures += 1
            self.state.update(key, error=last_error)
            if failures > self.opts.retries:
                self.state.update(key, status="failed" if thread_id is None else "pending")
                self.log(f"[{key}] giving up after {failures} failure(s): {last_error}")
                return Result(key, "failed", last_error)
            delay = self.opts.backoff_s * (2 ** (failures - 1)) * (1 + random.random() / 2)
            self.log(f"[{key}] retry {failures}/{self.opts.retries} in {delay:.0f}s: {last_error}")
            await self.sleep(delay)

    async def wait_for_answer(self, thread_id: str, dataset: str) -> str:
        deadline = self.clock() + self.opts.max_wait_s
        while True:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise WaitLimit(f"Agent0 still working after {self.opts.max_wait_s:.0f}s")
            chunk = int(max(1, min(self.opts.wait_chunk_s, remaining)))
            text = await self.agent0.wait(thread_id, dataset, chunk)
            block = extract_yaml_block(text)
            if block is not None:
                return block
            if STILL_WORKING.search(text):
                continue
            raise AnswerError(f"no YAML block in the answer: {text[:200]!r}")

    def write_answer(self, job: Job, thread_id: str, answer_text: str, items: list[dict] | None = None) -> None:
        asked_at = (self.state.get(job.spec.key) or {}).get("asked_at") or now_iso()
        if items is None:
            items = self.mode.validate(answer_text, load_case(job.spec.key))
        self.mode.write(self.agent0_dir, job, thread_id, answer_text, items, asked_at)


def build_expected_for(key: str) -> None:
    build_expected.write(key)


def adopt_existing(
    specs: list[CaseSpec],
    state: State,
    prompts: dict[str, str],
    agent0_dir: Path = AGENT0_DIR,
    *,
    prompt_name: str = "prompt.md",
    answer_name: str = "answer.yaml",
) -> list[str]:
    adopted = []
    for spec in specs:
        answer = agent0_dir / spec.key / answer_name
        if state.get(spec.key) or not answer.is_file():
            continue
        prompt_file = agent0_dir / spec.key / prompt_name
        recorded_prompt = prompt_file.read_text() if prompt_file.is_file() else None
        state.update(
            spec.key,
            status="done",
            thread_id=header_thread_id(answer),
            dataset=spec.dataset,
            prompt_sha256=prompt_sha256(recorded_prompt) if recorded_prompt is not None else None,
            adopted=True,
            answered_at=dt.datetime.fromtimestamp(answer.stat().st_mtime, dt.timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            attempts=0,
            error=None,
        )
        adopted.append(spec.key)
    return adopted


# --------------------------------------------------------------------------- CLI


def read_env(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    env_file = ROOT / ".env"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            k, sep, v = line.partition("=")
            if sep and k.strip() == name and v.strip():
                return v.strip().strip("'\"")
    return None


def display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("input", nargs="?", type=Path, default=DEFAULT_INPUT, help="dashboards JSON (default: %(default)s)")
    p.add_argument("--mode", choices=MODES, default="answer", help="answer: propose expectations (the only mode)")
    p.add_argument("--out-dir", type=Path, help="write <DIR>/<key>/... and <DIR>/state.json instead; implies --no-build")
    p.add_argument("--state", type=Path, help="state JSON (default: per mode, see above)")
    p.add_argument("--jobs", "-j", type=int, default=3, help="dashboards asked in parallel (default: 3)")
    p.add_argument("--retries", type=int, default=3, help="retries per dashboard after an error (default: 3)")
    p.add_argument("--full", action="store_true", help="ask again for every dashboard in the input")
    p.add_argument("--case", action="append", metavar="SVC/ID", help="only these cases; asks again even if done")
    p.add_argument("--max-wait", type=float, default=1800.0, help="seconds to wait per thread (default: 1800)")
    p.add_argument("--adopt-existing", action="store_true", help="record existing answer.yaml files as done")
    p.add_argument("--no-build", action="store_true", help="skip scripts/build_expected.py after each answer")
    p.add_argument("--dry-run", action="store_true", help="show what would run; no network")
    args = p.parse_args(argv)
    if args.jobs < 1 or args.retries < 0:
        p.error("--jobs must be >= 1 and --retries >= 0")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        mode = get_mode(args.mode, args.out_dir)
        specs = load_input(args.input)
        only = set(args.case) if args.case else None
        if only:
            unknown = only - {s.key for s in specs}
            if unknown:
                raise InputError(f"--case not in {args.input}: {sorted(unknown)}")
        state = State(args.state or mode.state_path)
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    build = args.no_build is False and mode.builds
    print(
        f"mode {mode.name}: writes {display_path(mode.out_dir)}/<key>/{{{mode.prompt_name}, {mode.answer_name}"
        f"}}, state {display_path(state.path)},"
        f" build_expected: {'yes' if build else 'no'}"
    )
    prompts = {s.key: mode.render(s.key, s.dataset) for s in specs}
    if args.adopt_existing:
        if args.dry_run:
            print("dry run: --adopt-existing not applied")
        else:
            for key in adopt_existing(specs, state, prompts, mode.out_dir, prompt_name=mode.prompt_name, answer_name=mode.answer_name):
                print(f"[{key}] adopted existing {mode.answer_name} as done")
    jobs, warnings = select_jobs(specs, state, prompts, full=args.full, only=only)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    if not jobs:
        print("nothing to do: every selected case is done (use --full or --case to ask again)")
        return 0
    for job in jobs:
        how = f"resume thread {job.resume_thread_id}" if job.resume_thread_id else "new thread"
        print(f"queued {job.spec.key} ({job.spec.dataset}, {how})")
    if args.dry_run:
        return 0

    token = read_env("DASH0_AUTH_TOKEN")
    if not token:
        print("error: DASH0_AUTH_TOKEN is not set (environment or .env)", file=sys.stderr)
        return 2
    url = read_env("DASH0_MCP_URL") or (
        read_env("DASH0_API_URL").rstrip("/") + "/mcp" if read_env("DASH0_API_URL") else DEFAULT_MCP_URL
    )
    opts = Options(jobs=args.jobs, retries=args.retries, max_wait_s=args.max_wait, build=build)
    runner = Runner(McpAgent0.over_http(url, token, read_timeout_s=opts.wait_chunk_s + 120), state, opts, mode=mode)
    results = asyncio.run(runner.run(jobs))

    print()
    for r in results:
        print(f"{r.status:8} {r.key}  {r.detail}")
    return 0 if all(r.status == "done" for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
