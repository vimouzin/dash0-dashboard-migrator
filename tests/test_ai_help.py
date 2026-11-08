"""AI requires a blocked item and an explicit endpoint request; quota is server-owned."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from backend import ai
from backend.server import convert_request


@pytest.fixture
def session(monkeypatch: pytest.MonkeyPatch) -> ai.AiHelp:
    monkeypatch.setenv("DASH0_AUTH_TOKEN", "test-token")
    result = convert_request({"files": [{"name": "test.json", "text": json.dumps({
        "title": "Test", "layout_type": "ordered", "widgets": [
            {"definition": {"type": "image", "url": "https://example.com/image.png"}},
            {"definition": {"type": "note", "content": "Supported note"}},
        ],
    })}]})
    help_session = ai.AiHelp()
    help_session.remember(result)
    return help_session


def request(session: ai.AiHelp, path: str = "widgets[0]") -> dict[str, Any]:
    return {"runId": session.run_id, "sourceId": "test.json", "sourcePath": path}


def test_only_three_explicit_calls_and_reconversion_does_not_reset_quota(
    session: ai.AiHelp, monkeypatch: pytest.MonkeyPatch
) -> None:
    prompts: list[str] = []

    async def ask(prompt: str) -> str:
        prompts.append(prompt)
        return "Draft conversion"

    monkeypatch.setattr(ai, "ask_agent0", ask)
    original = copy.deepcopy(session.result)
    assert not prompts  # Converting/remembering never asks Agent0.
    for remaining in (2, 1, 0):
        result = session.suggest(request(session))
        assert result["recommendation"] == "Draft conversion"
        assert result["ai"]["remaining"] == remaining
        assert result["applied"] is False
    assert len(prompts) == 3
    assert session.result == original
    assert '"type": "image"' in prompts[0]
    assert "Supported note" not in prompts[0]  # Only the failed item is shared.
    session.remember(original)
    with pytest.raises(ai.HelpError, match="sandy@dash0.com") as error:
        session.suggest(request(session))
    assert error.value.status == 429
    assert len(prompts) == 3


@pytest.mark.parametrize(
    "outcome", ["translated", "approximated", "assumed", "best_effort", "partial"]
)
def test_nonfailed_items_cannot_call_agent0(session: ai.AiHelp, outcome: str) -> None:
    session.result["report"]["items"][1]["outcome"] = outcome
    with pytest.raises(ai.HelpError, match="failed translations"):
        session.suggest(request(session))
    assert session.remaining == 3


def test_dashboard_and_stale_runs_cannot_call_agent0(session: ai.AiHelp) -> None:
    with pytest.raises(ai.HelpError):
        session.suggest(request(session, ""))
    stale = request(session)
    session.remember(session.result)
    with pytest.raises(ai.HelpError, match="again"):
        session.suggest(stale)
    assert session.remaining == 3


def test_agent0_failure_counts_once_without_retry(
    session: ai.AiHelp, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    async def fail(prompt: str) -> str:
        nonlocal calls
        calls += 1
        raise TimeoutError("private upstream details")

    monkeypatch.setattr(ai, "ask_agent0", fail)
    with pytest.raises(ai.HelpError, match="This call was counted") as error:
        session.suggest(request(session))
    assert error.value.status == 502
    assert "private" not in str(error.value)
    assert calls == 1
    assert session.remaining == 2


def test_missing_configuration_does_not_spend_a_call(
    session: ai.AiHelp, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ai, "setting", lambda name: "")
    with pytest.raises(ai.HelpError, match="not configured"):
        session.suggest(request(session))
    assert session.remaining == 3
