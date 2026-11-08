"""Offline tests for scripts/pin_otel_mapping.py --check (#171)."""

from __future__ import annotations

from pathlib import Path

import pin_otel_mapping as pin  # type: ignore[import-not-found]

HEADER = "| otel | datadog | description | filter | transform | Integration |\n| - | - | - | - | - | - |\n"
PAGE = HEADER + (
    "| redis.clients.blocked | redis.clients.blocked | d | [redis](x) |\n"
    "| apache.requests | apache.net.request_per_s | d | [apache](x) |\n"
)


def _pin(tmp_path: Path, page: str = PAGE) -> Path:
    path = tmp_path / "otel-mapping.yaml"
    path.write_text(pin.render_pin(pin.parse_table(page), pin.NAME_COLUMNS, "2026-11-08"))
    return path


def test_all_rows_are_kept() -> None:
    assert [r["datadog"] for r in pin.parse_table(PAGE)] == [
        "apache.net.request_per_s",
        "redis.clients.blocked",
    ]


def test_check_passes_and_downloads_missing_page_once(tmp_path: Path) -> None:
    calls: list[int] = []

    def get() -> str:
        calls.append(1)
        return PAGE

    page = tmp_path / "cache" / "page.md"
    ok, message = pin.check(_pin(tmp_path), page, get)
    assert ok, message
    assert "2 pairs, 2 Datadog names" in message
    assert pin.check(_pin(tmp_path), page, get)[0]
    assert len(calls) == 1


def test_check_fails_when_page_changed(tmp_path: Path) -> None:
    page = tmp_path / "page.md"
    page.write_text(PAGE + "| nginx.requests | nginx.net.request_per_s | d | [nginx](x) |\n")
    ok, message = pin.check(_pin(tmp_path), page)
    assert not ok
    assert message.startswith("FAIL: rebuild from")
