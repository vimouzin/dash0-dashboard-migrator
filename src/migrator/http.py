"""A minimal injectable HTTP layer over urllib, so destination and source clients
can be tested with fakes. No retries, no translation logic."""

from __future__ import annotations

import http.client
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes | None = None
    timeout: float = 30.0


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class HttpTransportError(Exception):
    """The request may or may not have reached the server (timeout, reset, DNS, ...)."""


HttpSend = Callable[[HttpRequest], HttpResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: urllib would forward the Authorization header to the
    target and turn a POST into a GET. A 3xx comes back as a plain HttpResponse."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)

# Errors after the request may have started: the server may or may not have acted.
# http.client.HTTPException (IncompleteRead, BadStatusLine, ...) is not an OSError.
_TRANSPORT_ERRORS = (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException)


def _transport_error(err: BaseException) -> HttpTransportError:
    reason = getattr(err, "reason", None) or err
    return HttpTransportError(f"{type(err).__name__}: {reason}")


def urllib_send(req: HttpRequest) -> HttpResponse:
    """Default transport. Every HTTP status (including 3xx, which is never followed)
    becomes an HttpResponse; anything else (timeouts, connection errors, truncated
    responses) becomes HttpTransportError."""
    request = urllib.request.Request(
        req.url, data=req.body, headers=dict(req.headers), method=req.method
    )
    try:
        with _OPENER.open(request, timeout=req.timeout) as resp:
            return HttpResponse(status=resp.status, body=resp.read())
    except urllib.error.HTTPError as err:
        try:
            body = err.read()
        except _TRANSPORT_ERRORS as read_err:
            raise _transport_error(read_err) from read_err
        return HttpResponse(status=err.code, body=body)
    except _TRANSPORT_ERRORS as err:
        raise _transport_error(err) from err
