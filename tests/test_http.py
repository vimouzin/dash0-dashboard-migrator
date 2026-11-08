"""urllib_send against a real local server: truncation and redirects."""

from __future__ import annotations

import socket
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, cast

import pytest

from migrator.destination.dash0 import Dash0Config, Unknown, publish_check_rule
from migrator.http import HttpRequest, HttpTransportError, urllib_send
from migrator.target import Dash0CheckRule

_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})
_PROXY_VARS = ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Override the root guard for this module: allow loopback only.

    These tests need a real local server. Outbound connections stay blocked, and
    proxy variables are cleared so urllib connects to 127.0.0.1 directly.
    """
    for name in _PROXY_VARS:
        monkeypatch.delenv(name, raising=False)
    real_create = socket.create_connection
    real_connect = socket.socket.connect

    def check(address: Any) -> None:
        host = address[0] if isinstance(address, tuple) else address
        if host not in _LOOPBACK:
            raise RuntimeError("only loopback connections are allowed in tests/test_http.py")

    def create_connection(address: Any, *args: Any, **kwargs: Any) -> socket.socket:
        check(address)
        return real_create(address, *args, **kwargs)

    def connect(self: socket.socket, address: Any) -> None:
        check(address)
        real_connect(self, address)

    monkeypatch.setattr(socket, "create_connection", create_connection)
    monkeypatch.setattr(socket.socket, "connect", connect)


def test_guard_still_blocks_outbound_connections() -> None:
    with pytest.raises(RuntimeError, match="only loopback"):
        socket.create_connection(("192.0.2.1", 80), timeout=1)


RULE = cast(
    Dash0CheckRule,
    {"name": "r", "expression": "up == 0", "thresholds": {"failed": 1}, "interval": "1m"},
)
Handler = Callable[[socket.socket], None]


def read_request(conn: socket.socket) -> None:
    """Read the whole request (headers and Content-Length body) before replying;
    unread bytes would turn the server's close into a TCP reset."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(65536)
        if not chunk:
            return
        data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n")[1:]:
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length":
            length = int(value.strip())
    while len(body) < length:
        chunk = conn.recv(65536)
        if not chunk:
            return
        body += chunk


@contextmanager
def raw_server(handle: Handler) -> Iterator[str]:
    """Serve one connection with a hand-written HTTP response."""
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    def run() -> None:
        conn, _ = srv.accept()
        with conn:
            read_request(conn)
            handle(conn)
            # Half-close and drain, so the client sees EOF rather than a reset.
            conn.shutdown(socket.SHUT_WR)
            conn.settimeout(2)
            try:
                while conn.recv(65536):
                    pass
            except OSError:
                pass

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        thread.join(timeout=5)
        srv.close()


def truncated(status: int) -> Handler:
    def handle(conn: socket.socket) -> None:
        conn.sendall(
            f"HTTP/1.1 {status} X\r\nContent-Length: 100\r\nConnection: close\r\n\r\n"
            '{"met'.encode()
        )

    return handle


def test_truncated_2xx_body_is_a_transport_error() -> None:
    with raw_server(truncated(200)) as url, pytest.raises(HttpTransportError) as exc:
        urllib_send(HttpRequest("POST", url, body=b"{}", timeout=5))
    assert "IncompleteRead" in str(exc.value)


def test_truncated_error_body_is_a_transport_error() -> None:
    with raw_server(truncated(500)) as url, pytest.raises(HttpTransportError):
        urllib_send(HttpRequest("GET", url, timeout=5))


def test_truncated_import_response_is_unknown() -> None:
    with raw_server(truncated(200)) as url:
        cfg = Dash0Config(api_url=url, token="tok", dataset="default")
        out = publish_check_rule(RULE, cfg)
    assert isinstance(out, Unknown)


def test_redirect_is_not_followed() -> None:
    def handle(conn: socket.socket) -> None:
        conn.sendall(
            b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/x\r\n"
            b"Content-Length: 0\r\nConnection: close\r\n\r\n"
        )

    with raw_server(handle) as url:
        resp = urllib_send(
            HttpRequest("POST", url, headers={"Authorization": "Bearer t"}, body=b"{}")
        )
    assert resp.status == 302
    assert not resp.ok
