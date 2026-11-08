"""Offline tests for scripts/run_oracle.py (the development-time Agent0 oracle runner)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
import run_oracle as ro
import yaml

ROOT = Path(__file__).resolve().parents[2]
KEY = "nginx/NGINX-Metrics_dashboard"
THREAD_A = "11111111-1111-4111-8111-111111111111"
THREAD_B = "22222222-2222-4222-8222-222222222222"


def spec(key: str = KEY) -> ro.CaseSpec:
    return ro.CaseSpec(key, "default", "advanced", "high")


def job(key: str = KEY, resume: str | None = None) -> ro.Job:
    return ro.Job(spec(key), ro.render_oracle_prompt.render(key), resume)


def good_answer(key: str = KEY) -> str:
    case = ro.load_case(key)
    items = [
        {
            "source_path": r["source_path"],
            "outcome": "blocked",
            "reason": "test",
            "otel_metrics": [],
        }
        for r in case["requests"]
    ]
    return yaml.safe_dump(items, sort_keys=False)


def fenced(body: str, thread: str) -> str:
    return f"```yaml\n{body}```\n\n[Open conversation](https://app.dash0.com/goto/agent0?thread_id={thread}&dataset=default)"


def started(thread: str) -> str:
    return f"Agent0 is still working on your request.\n\nThread ID: `{thread}`\n"


class FakeAgent0:
    """Scripted runTask / waitForTask: each list item is returned or raised in order."""

    def __init__(self, starts: list[Any], waits: list[Any]) -> None:
        self.starts = list(starts)
        self.waits = list(waits)
        self.start_calls: list[str] = []
        self.wait_calls: list[str] = []
        self.active = 0
        self.max_active = 0

    async def _next(self, queue: list[Any]) -> str:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(0)
            item = queue.pop(0)
            if isinstance(item, BaseException):
                raise item
            return str(item)
        finally:
            self.active -= 1

    async def start(self, job: ro.Job) -> str:
        self.start_calls.append(job.spec.key)
        return await self._next(self.starts)

    async def wait(self, thread_id: str, dataset: str, timeout_s: int) -> str:
        self.wait_calls.append(thread_id)
        return await self._next(self.waits)


async def no_sleep(_: float) -> None:
    return None


def make_runner(tmp_path: Path, agent: object, **opts) -> tuple[ro.Runner, ro.State, list[str]]:
    state = ro.State(tmp_path / "state.json")
    built: list[str] = []
    runner = ro.Runner(
        agent,
        state,
        ro.Options(**{"backoff_s": 0, **opts}),
        agent0_dir=tmp_path / "agent0",
        sleep=no_sleep,
        log=lambda _: None,
        build=built.append,
    )
    return runner, state, built


# --------------------------------------------------------------------------- input


def test_default_input_lists_every_extracted_case() -> None:
    specs = ro.load_input(ro.DEFAULT_INPUT)
    extracted = sorted(
        str(p.relative_to(ROOT / "fixtures" / "cases"))[:-5]
        for p in (ROOT / "fixtures" / "cases").rglob("*.yaml")
    )
    assert sorted(s.key for s in specs) == extracted
    assert all(s.dataset == "default" for s in specs)


@pytest.mark.parametrize(
    "doc, message",
    [
        ({"dataset": "default", "dashboards": [{"case": "nope/missing"}]}, "no fixtures/cases"),
        ({"dataset": "default", "dashboards": [{"case": KEY}, {"case": KEY}]}, "duplicate"),
        ({"dataset": "default", "dashboards": [{"case": KEY, "extra": 1}]}, "unknown keys"),
        ({"dashboards": [{"case": KEY}]}, "no dataset"),
        (
            {"dataset": "default", "model_class": "huge", "dashboards": [{"case": KEY}]},
            "model_class",
        ),
        ({"dataset": "default", "dashboards": []}, "non-empty"),
    ],
)
def test_invalid_input_is_rejected(tmp_path: Path, doc: dict[str, Any], message: str) -> None:
    path = tmp_path / "in.json"
    path.write_text(json.dumps(doc))
    with pytest.raises(ro.InputError, match=message):
        ro.load_input(path)


# --------------------------------------------------------------------------- selection


def test_standard_run_selects_only_new_cases_and_resumes_pending(tmp_path: Path) -> None:
    keys = [
        "nginx/NGINX-Metrics_dashboard",
        "nginx/plus_overview",
        "redisdb/overview",
        "kafka/kafka_dashboard",
    ]
    specs = [spec(k) for k in keys]
    prompts = {k: ro.render_oracle_prompt.render(k) for k in keys}
    state = ro.State(tmp_path / "state.json")
    state.update(keys[0], status="done", prompt_sha256=ro.prompt_sha256(prompts[keys[0]]))
    state.update(keys[1], status="done", prompt_sha256="stale")
    state.update(
        keys[2],
        status="pending",
        thread_id=THREAD_A,
        prompt_sha256=ro.prompt_sha256(prompts[keys[2]]),
    )

    jobs, warnings = ro.select_jobs(specs, state, prompts)
    assert [(j.spec.key, j.resume_thread_id) for j in jobs] == [
        (keys[2], THREAD_A),
        (keys[3], None),
    ]
    assert len(warnings) == 1 and keys[1] in warnings[0]

    full, _ = ro.select_jobs(specs, state, prompts, full=True)
    assert [(j.spec.key, j.resume_thread_id) for j in full] == [(k, None) for k in keys]

    only, _ = ro.select_jobs(specs, state, prompts, only={keys[0]})
    assert [(j.spec.key, j.resume_thread_id) for j in only] == [(keys[0], None)]


def test_pending_case_with_changed_prompt_starts_a_new_thread(tmp_path: Path) -> None:
    state = ro.State(tmp_path / "state.json")
    state.update(KEY, status="pending", thread_id=THREAD_A, prompt_sha256="old")
    jobs, _ = ro.select_jobs([spec()], state, {KEY: "new prompt"})
    assert jobs[0].resume_thread_id is None


# --------------------------------------------------------------------------- answers


@pytest.mark.parametrize("key", [s.key for s in ro.load_input(ro.DEFAULT_INPUT)])
def test_recorded_answers_pass_validation(key: str) -> None:
    answer = ROOT / "fixtures" / "oracle" / "agent0" / key / "answer.yaml"
    if not answer.is_file():
        pytest.skip("no recorded answer")
    ro.validate_answer(answer.read_text(), ro.load_case(key))
    assert ro.header_thread_id(answer) is None or len(ro.header_thread_id(answer)) == 36


def test_validation_reports_missing_and_miscounted_requests() -> None:
    case = ro.load_case(KEY)
    items = yaml.safe_load(good_answer())
    first = case["requests"][0]
    items[0] = {
        "source_path": first["source_path"],
        "outcome": "translated",
        "promql": ["a", "b", "c", "d", "e"],
    }
    with pytest.raises(ro.AnswerError, match="PromQL strings"):
        ro.validate_answer(yaml.safe_dump(items), case)
    with pytest.raises(ro.AnswerError, match="no answer for 1"):
        ro.validate_answer(yaml.safe_dump(yaml.safe_load(good_answer())[1:]), case)
    with pytest.raises(ro.AnswerError, match="not valid YAML"):
        ro.validate_answer("- [unclosed", case)


def test_thread_id_and_yaml_block_extraction() -> None:
    assert ro.extract_thread_id(started(THREAD_A)) == THREAD_A
    assert ro.extract_thread_id(fenced("- a: 1\n", THREAD_B)) == THREAD_B
    assert ro.extract_yaml_block(fenced("- a: 1\n", THREAD_B)) == "- a: 1\n"
    assert ro.extract_yaml_block(started(THREAD_A)) is None


# --------------------------------------------------------------------------- runner


def test_happy_path_writes_verbatim_answer_and_marks_done(tmp_path: Path) -> None:
    agent = FakeAgent0([started(THREAD_A)], [fenced(good_answer(), THREAD_A)])
    runner, state, built = make_runner(tmp_path, agent)
    [result] = asyncio.run(runner.run([job()]))

    assert result.status == "done"
    entry = state.get(KEY)
    assert entry["status"] == "done" and entry["thread_id"] == THREAD_A and entry["attempts"] == 1
    assert entry["prompt_sha256"] == ro.prompt_sha256(job().prompt)
    answer = (tmp_path / "agent0" / KEY / "answer.yaml").read_text()
    assert answer.startswith("# Agent0 answer, verbatim.") and THREAD_A in answer.splitlines()[0]
    assert answer.endswith(good_answer())
    assert (tmp_path / "agent0" / KEY / "prompt.md").read_text() == job().prompt
    assert built == [KEY]
    assert json.loads((tmp_path / "state.json").read_text())["cases"][KEY]["status"] == "done"


def test_transport_error_while_waiting_retries_the_same_thread(tmp_path: Path) -> None:
    agent = FakeAgent0(
        [started(THREAD_A)],
        [ConnectionError("reset"), started(THREAD_A), fenced(good_answer(), THREAD_A)],
    )
    runner, state, _ = make_runner(tmp_path, agent)
    [result] = asyncio.run(runner.run([job()]))
    assert result.status == "done"
    assert agent.start_calls == [KEY]
    assert agent.wait_calls == [THREAD_A, THREAD_A, THREAD_A]


def test_invalid_answer_retries_on_a_new_thread(tmp_path: Path) -> None:
    agent = FakeAgent0(
        [started(THREAD_A), started(THREAD_B)],
        [fenced("- nonsense: 1\n", THREAD_A), fenced(good_answer(), THREAD_B)],
    )
    runner, state, _ = make_runner(tmp_path, agent)
    [result] = asyncio.run(runner.run([job()]))
    assert result.status == "done"
    assert len(agent.start_calls) == 2
    assert state.get(KEY)["thread_id"] == THREAD_B and state.get(KEY)["attempts"] == 2


def test_gives_up_after_the_retry_budget(tmp_path: Path) -> None:
    agent = FakeAgent0([ConnectionError("down")] * 3, [])
    runner, state, built = make_runner(tmp_path, agent, retries=2)
    [result] = asyncio.run(runner.run([job()]))
    assert result.status == "failed"
    assert len(agent.start_calls) == 3
    assert state.get(KEY)["status"] == "failed" and "down" in state.get(KEY)["error"]
    assert built == []


def test_resume_waits_on_the_recorded_thread_without_asking_again(tmp_path: Path) -> None:
    agent = FakeAgent0([], [fenced(good_answer(), THREAD_A)])
    runner, state, _ = make_runner(tmp_path, agent)
    [result] = asyncio.run(runner.run([job(resume=THREAD_A)]))
    assert result.status == "done" and agent.start_calls == [] and agent.wait_calls == [THREAD_A]


def test_wait_limit_leaves_the_case_pending_for_the_next_run(tmp_path: Path) -> None:
    ticks = iter(range(0, 10_000, 100))
    agent = FakeAgent0([started(THREAD_A)], [started(THREAD_A)] * 50)
    runner, state, _ = make_runner(tmp_path, agent, max_wait_s=250)
    runner.clock = lambda: float(next(ticks))
    [result] = asyncio.run(runner.run([job()]))
    assert result.status == "pending"
    assert state.get(KEY)["status"] == "pending" and state.get(KEY)["thread_id"] == THREAD_A


def test_parallelism_is_bounded_by_jobs(tmp_path: Path) -> None:
    keys = [s.key for s in ro.load_input(ro.DEFAULT_INPUT)][:5]
    threads = [f"{i}{i}{i}{i}{i}{i}{i}{i}-0000-4000-8000-000000000000" for i in range(5)]
    agent = FakeAgent0([started(t) for t in threads], [])
    answers = {t: fenced(good_answer(k), t) for t, k in zip(threads, keys, strict=True)}

    async def wait(thread_id: str, dataset: str, timeout_s: int) -> str:
        agent.wait_calls.append(thread_id)
        agent.waits = [answers[thread_id]]
        return await agent._next(agent.waits)

    agent.wait = wait  # type: ignore[method-assign]
    runner, state, _ = make_runner(tmp_path, agent, jobs=2)
    results = asyncio.run(runner.run([job(k) for k in keys]))
    assert [r.status for r in results] == ["done"] * 5
    assert agent.max_active <= 2
    assert sorted(state.cases) == sorted(keys)


def test_adopt_existing_records_answers_without_asking(tmp_path: Path) -> None:
    agent0_dir = tmp_path / "agent0"
    (agent0_dir / KEY).mkdir(parents=True)
    (agent0_dir / KEY / "answer.yaml").write_text(
        f"# thread: https://x/?thread_id={THREAD_A}\n- a: 1\n"
    )
    (agent0_dir / KEY / "prompt.md").write_text("p")
    state = ro.State(tmp_path / "state.json")
    adopted = ro.adopt_existing([spec(), spec("redisdb/overview")], state, {}, agent0_dir)
    assert adopted == [KEY]
    assert state.get(KEY)["status"] == "done" and state.get(KEY)["thread_id"] == THREAD_A
    assert state.get(KEY)["prompt_sha256"] == ro.prompt_sha256("p")


# ------------------------------------------------- real MCP client, in-process server


def test_mcp_client_calls_runtask_and_waitfortask_through_the_sdk() -> None:
    pytest.importorskip("mcp", reason="uv group oracle (default) not installed")
    from mcp import Client
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("fake-dash0")
    seen: dict[str, dict[str, Any]] = {}

    @server.tool()
    def runTask(
        message: str,
        dataset: str,
        timeoutSeconds: int = 25,
        modelClass: str = "",
        reasoningEffort: str = "",
    ) -> str:  # noqa: N802,N803
        seen["runTask"] = {
            "dataset": dataset,
            "timeoutSeconds": timeoutSeconds,
            "modelClass": modelClass,
            "reasoningEffort": reasoningEffort,
        }
        return started(THREAD_A)

    @server.tool()
    def waitForTask(threadIdOrUrl: str, dataset: str, timeoutSeconds: int = 300) -> str:  # noqa: N802,N803
        if threadIdOrUrl != THREAD_A:
            raise ValueError("unknown thread")
        return fenced("- a: 1\n", THREAD_A)

    agent = ro.McpAgent0(lambda: Client(server))

    async def go() -> tuple[str, str]:
        text = await agent.start(job())
        return text, await agent.wait(ro.extract_thread_id(text), "default", 5)

    start_text, wait_text = asyncio.run(go())
    assert ro.extract_thread_id(start_text) == THREAD_A
    assert ro.extract_yaml_block(wait_text) == "- a: 1\n"
    assert seen["runTask"] == {
        "dataset": "default",
        "timeoutSeconds": 1,
        "modelClass": "advanced",
        "reasoningEffort": "high",
    }

    with pytest.raises(ro.ToolError, match="waitForTask failed"):
        asyncio.run(agent.wait(THREAD_B, "default", 5))
