"""The voice copilot endpoint keeps the API key server-side and returns only a signed URL."""

from __future__ import annotations

import io
import json
from typing import Any
from urllib.error import HTTPError

import pytest

from backend import copilot


class FakeResponse(io.BytesIO):
    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


def test_missing_settings_fail_without_calling_elevenlabs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(copilot, "setting", lambda name: "")
    monkeypatch.setattr(copilot, "urlopen", lambda *a, **k: pytest.fail("must not call out"))
    with pytest.raises(copilot.CopilotError, match="ELEVENLABS_API_KEY") as error:
        copilot.signed_url()
    assert error.value.status == 503


def test_signed_url_sends_key_as_header_and_returns_only_the_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = {"ELEVENLABS_API_KEY": "secret-key", "ELEVENLABS_AGENT_ID": "agent_123"}
    monkeypatch.setattr(copilot, "setting", lambda name: values.get(name, ""))
    seen: dict[str, Any] = {}

    def fake_urlopen(request: Any, timeout: float) -> FakeResponse:
        seen["url"], seen["key"] = request.full_url, request.get_header("Xi-api-key")
        return FakeResponse(json.dumps({"signed_url": "wss://api.elevenlabs.io/x?sig=1"}).encode())

    monkeypatch.setattr(copilot, "urlopen", fake_urlopen)
    result = copilot.signed_url()
    assert result == {"signedUrl": "wss://api.elevenlabs.io/x?sig=1"}
    assert seen["url"] == (
        "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_123"
    )
    assert seen["key"] == "secret-key"
    assert "secret-key" not in json.dumps(result)


def test_upstream_refusal_is_reported_without_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    values = {"ELEVENLABS_API_KEY": "secret-key", "ELEVENLABS_AGENT_ID": "agent_123"}
    monkeypatch.setattr(copilot, "setting", lambda name: values.get(name, ""))

    def refuse(request: Any, timeout: float) -> FakeResponse:
        raise HTTPError(request.full_url, 401, "Unauthorized", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(copilot, "urlopen", refuse)
    with pytest.raises(copilot.CopilotError, match="HTTP 401") as error:
        copilot.signed_url()
    assert error.value.status == 502
    assert "secret-key" not in str(error.value)


def test_speech_uses_the_agents_voice_and_caches_audio(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    values = {"ELEVENLABS_API_KEY": "secret-key", "ELEVENLABS_AGENT_ID": "agent_123"}
    monkeypatch.setattr(copilot, "setting", lambda name: values.get(name, ""))
    monkeypatch.setattr(copilot, "VOICE_CACHE", tmp_path)
    monkeypatch.setattr(copilot, "_voice", {})
    calls: list[str] = []

    def fake_urlopen(request: Any, timeout: float) -> FakeResponse:
        calls.append(request.full_url)
        if "/convai/agents/" in request.full_url:
            return FakeResponse(json.dumps({"conversation_config": {"tts": {"voice_id": "v42"}}}).encode())
        body = json.loads(request.data)
        assert body["text"] == "Hi, I'm Jarvis."
        assert request.get_header("Xi-api-key") == "secret-key"
        return FakeResponse(b"ID3-mp3-bytes")

    monkeypatch.setattr(copilot, "urlopen", fake_urlopen)
    assert copilot.speech({"text": "Hi, I'm Jarvis."}) == b"ID3-mp3-bytes"
    assert copilot.speech({"text": "Hi, I'm Jarvis."}) == b"ID3-mp3-bytes"
    assert calls == [
        "https://api.elevenlabs.io/v1/convai/agents/agent_123",
        "https://api.elevenlabs.io/v1/text-to-speech/v42?output_format=mp3_44100_128",
    ]  # The second line came from the disk cache.


@pytest.mark.parametrize("payload", [{}, {"text": ""}, {"text": "x" * 401}, ["text"]])
def test_speech_rejects_bad_text_before_calling_out(
    payload: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(copilot, "urlopen", lambda *a, **k: pytest.fail("must not call out"))
    with pytest.raises(copilot.CopilotError) as error:
        copilot.speech(payload)
    assert error.value.status == 400
