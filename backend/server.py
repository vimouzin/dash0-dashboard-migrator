"""Serve the preview and one synchronous, offline conversion endpoint."""

from __future__ import annotations

import argparse
import json
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast
from urllib.parse import urlsplit

from backend.ai import AiHelp, HelpError
from backend.copilot import CopilotError, signed_url, speech
from migrator.convert import ConvertOptions, run_convert
from migrator.input import InputError

ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 10 * 1024 * 1024


def convert_request(payload: Any) -> dict[str, Any]:
    """Use uploaded files or the pinned demo; return the compiler's actual output."""
    if not isinstance(payload, dict) or not isinstance(payload.get("files", []), list):
        raise InputError("Expected an object with a files array.")
    files = payload.get("files", [])
    with TemporaryDirectory(prefix="migrator-preview-") as temporary:
        base = Path(temporary)
        inputs: list[str] = []
        names: set[str] = set()
        for entry in files:
            if not isinstance(entry, dict):
                raise InputError("Each file needs a name and text.")
            name, text = entry.get("name"), entry.get("text")
            if (
                not isinstance(name, str)
                or not name.endswith(".json")
                or "/" in name
                or "\\" in name
                or "\x00" in name
                or not isinstance(text, str)
            ):
                raise InputError("Each file needs a plain .json filename and text content.")
            if name in names:
                raise InputError(f"Duplicate filename: {name}")
            names.add(name)
            path = base / "input" / name
            path.parent.mkdir(exist_ok=True)
            path.write_text(text, encoding="utf-8")
            inputs.append(str(path))
        if not inputs:
            inputs = [str(ROOT / "fixtures/datadog/integrations-core/postgres")]
        out = base / "output"
        result = run_convert(ConvertOptions(
            source="datadog", inputs=inputs, mapping=[str(ROOT / "mappings/datadog")], out=str(out)
        ))
        return {
            "report": result.report,
            "manifest": result.manifest,
            "exitCode": result.exit_code,
            "artifacts": {
                path.relative_to(out).as_posix(): path.read_text(encoding="utf-8")
                for path in sorted(out.rglob("*")) if path.is_file()
            },
        }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT / "preview"), **kwargs)

    def _json(self, status: int, data: dict[str, Any]) -> None:
        body = json.dumps(data, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        route = urlsplit(self.path).path
        if route not in ("/api/convert", "/api/suggest", "/api/copilot/session", "/api/copilot/speech"):
            self._json(404, {"error": "Unknown endpoint."})
            return
        # This local tool only accepts JSON from its own page, never cross-origin forms.
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self._json(415, {"error": "Send application/json."})
            return
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            self._json(403, {"error": "Use the page served by this backend."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                self._json(413, {"error": "Request must contain JSON and be at most 10 MiB."})
                return
            payload = json.loads(self.rfile.read(length))
            help_session = cast("Server", self.server).ai
            if route == "/api/copilot/speech":
                audio = speech(payload)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(audio)
                return
            if route == "/api/copilot/session":
                result = signed_url()
            elif route == "/api/convert":
                result = help_session.remember(convert_request(payload))
            else:
                result = help_session.suggest(payload)
        except CopilotError as error:
            self._json(error.status, {"error": str(error)})
            return
        except HelpError as error:
            self._json(error.status, {
                "error": str(error), "ai": cast("Server", self.server).ai.info()
            })
            return
        except (InputError, ValueError, UnicodeError) as error:
            self._json(400, {"error": str(error)})
            return
        except Exception:
            self._json(500, {"error": "Conversion failed. Check the local backend terminal."})
            raise
        self._json(200, result)


class Server(HTTPServer):
    def __init__(self, address: tuple[str, int]) -> None:
        self.ai = AiHelp()
        super().__init__(address, Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3001)
    args = parser.parse_args()
    with Server(("127.0.0.1", args.port)) as server:
        print(f"Local migration UI: http://localhost:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
