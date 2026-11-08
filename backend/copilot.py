"""Short-lived ElevenLabs signed URLs for the voice copilot. The API key never leaves here.

The copilot only explains the finished report and navigates the UI. It is not part of
the conversion path: it never changes compiler outcomes, artifacts or mappings.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from backend.ai import ROOT, setting

API = "https://api.elevenlabs.io"
VOICE_CACHE = ROOT / ".copilot-voice"
MAX_SPEECH = 400
TTS_MODEL = "eleven_multilingual_v2"
# Calm, steady narration (see preview/DEMO_SCRIPT.md).
VOICE_SETTINGS = {"stability": 0.45, "similarity_boost": 0.75, "style": 0.25, "use_speaker_boost": True}
NOT_CONFIGURED = (
    "Voice copilot is not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID "
    "in the environment or .env, then restart the backend."
)


class CopilotError(Exception):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


def _credentials() -> tuple[str, str, str]:
    key, agent = setting("ELEVENLABS_API_KEY"), setting("ELEVENLABS_AGENT_ID")
    if not key or not agent:
        raise CopilotError(NOT_CONFIGURED, 503)
    return key, agent, (setting("ELEVENLABS_API_URL") or API).rstrip("/")


def _call(url: str, key: str, what: str, body: dict[str, Any] | None = None) -> bytes:
    headers = {"xi-api-key": key}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    try:
        with urlopen(Request(url, data=data, headers=headers), timeout=30) as response:
            return bytes(response.read())
    except HTTPError as error:
        raise CopilotError(f"ElevenLabs refused the {what} request (HTTP {error.code}).", 502)
    except (URLError, TimeoutError):
        raise CopilotError("Could not reach ElevenLabs. Check the network and try again.", 502)


def signed_url() -> dict[str, Any]:
    """Ask ElevenLabs for a single-session WebSocket URL (valid 15 minutes)."""
    key, agent, base = _credentials()
    url = f"{base}/v1/convai/conversation/get-signed-url?{urlencode({'agent_id': agent})}"
    try:
        body = json.loads(_call(url, key, "session"))
    except ValueError:
        raise CopilotError("ElevenLabs returned no signed URL.", 502)
    signed = body.get("signed_url") if isinstance(body, dict) else None
    if not isinstance(signed, str) or not signed.startswith("wss://"):
        raise CopilotError("ElevenLabs returned no signed URL.", 502)
    return {"signedUrl": signed}


_voice: dict[str, str] = {}


def voice_id() -> str:
    """ELEVENLABS_VOICE_ID, else the agent's own voice, so the tour sounds like the agent."""
    if setting("ELEVENLABS_VOICE_ID"):
        return setting("ELEVENLABS_VOICE_ID")
    key, agent, base = _credentials()
    if agent not in _voice:
        try:
            config = json.loads(_call(f"{base}/v1/convai/agents/{quote(agent, safe='')}", key, "agent"))
            voice = config["conversation_config"]["tts"]["voice_id"]
        except (ValueError, KeyError, TypeError):
            raise CopilotError("Could not read the agent's voice. Set ELEVENLABS_VOICE_ID.", 502)
        if not isinstance(voice, str) or not voice:
            raise CopilotError("The agent has no voice. Set ELEVENLABS_VOICE_ID.", 502)
        _voice[agent] = voice
    return _voice[agent]


def speech(payload: Any) -> bytes:
    """MP3 for one short line in the agent's voice. Cached on disk, so a replay costs nothing."""
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_SPEECH:
        raise CopilotError(f"Send {{text}} with 1 to {MAX_SPEECH} characters.", 400)
    key, _, base = _credentials()
    voice = voice_id()
    model = setting("ELEVENLABS_TTS_MODEL") or TTS_MODEL
    digest = hashlib.sha256(f"{voice}\n{model}\n{json.dumps(VOICE_SETTINGS)}\n{text}".encode()).hexdigest()
    cached = VOICE_CACHE / f"{digest}.mp3"
    if cached.is_file():
        return cached.read_bytes()
    audio = _call(
        f"{base}/v1/text-to-speech/{quote(voice, safe='')}?output_format=mp3_44100_128",
        key, "speech", {"text": text, "model_id": model, "voice_settings": VOICE_SETTINGS},
    )
    if not audio:
        raise CopilotError("ElevenLabs returned no audio.", 502)
    VOICE_CACHE.mkdir(exist_ok=True)
    tmp = cached.with_suffix(".part")
    tmp.write_bytes(audio)
    tmp.replace(cached)
    return audio
