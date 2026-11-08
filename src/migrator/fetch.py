"""run_fetch: download selected source assets unchanged into a folder `convert` reads."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from migrator.http import HttpSend, urllib_send
from migrator.input import InputError
from migrator.source.asset import FetchingProvider, FetchSelection
from migrator.source.provider import get_provider


def run_fetch(
    source: str,
    sel: FetchSelection,
    out: str,
    env: Mapping[str, str | None],
    send: HttpSend = urllib_send,
) -> list[str]:
    """Return the relative paths written. Raises InputError or the provider's fetch error."""
    provider = get_provider(source)
    if not callable(getattr(provider, "fetch", None)):
        raise InputError(f"--source '{source}' does not support fetch")
    return cast(FetchingProvider, provider).fetch(sel, env, out, send)
