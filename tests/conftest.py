"""pytest hooks: oracle-case markers, --include-unreviewed option and the no-network guard."""

from __future__ import annotations

import socket
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from tests.report_html import render

# --------------------------------------------------------------------------- options

MARKERS = (
    "p0: must pass for the MVP converter (plans 01-04)",
    "p1: dashboard coverage ladder (plan 05)",
    "p2: later coverage (plan 08 services)",
    "unreviewed: expectation not human-reviewed; "
    "skipped unless --include-unreviewed",
)


def pytest_configure(config: pytest.Config) -> None:
    for marker in MARKERS:
        config.addinivalue_line("markers", marker)


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--include-unreviewed",
        action="store_true",
        default=False,
        help="Also run cases whose expectation has not been confirmed by a human.",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if config.getoption("--include-unreviewed"):
        return
    skip = pytest.mark.skip(
        reason=(
            "expectation not human-reviewed yet "
            "(use --include-unreviewed)"
        )
    )
    for item in items:
        if "unreviewed" in item.keywords:
            item.add_marker(skip)


# ------------------------------------------------------------- expected-vs-actual report

REPORT_PATH = Path(__file__).resolve().parent.parent / "out" / "test-report" / "index.html"
_COMPARISON = pytest.StashKey[dict[str, Any]]()
_RECORDS = pytest.StashKey[list[dict[str, Any]]]()


@pytest.fixture
def record_comparison(request: pytest.FixtureRequest) -> Callable[[dict[str, Any]], None]:
    """Store one expected-vs-actual comparison for the HTML report (see tests/report_html.py)."""

    def record(comparison: dict[str, Any]) -> None:
        request.node.stash[_COMPARISON] = comparison

    return record


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]) -> Any:
    report = yield
    comparison = item.stash.get(_COMPARISON, None)
    if call.when == "call" and comparison is not None:
        excinfo = call.excinfo
        if report.passed or excinfo is None:
            status, message = ("passed" if report.passed else "skipped"), ""
        else:
            status = "failed" if excinfo.errisinstance(AssertionError) else "error"
            message = str(excinfo.value)
        records = item.config.stash.setdefault(_RECORDS, [])
        records.append({**comparison, "status": status, "message": message})
    return report


def pytest_sessionfinish(session: pytest.Session) -> None:
    records = session.config.stash.get(_RECORDS, [])
    if records:
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(render(records), encoding="utf-8")


def pytest_terminal_summary(terminalreporter: Any, config: pytest.Config) -> None:
    if config.stash.get(_RECORDS, []):
        terminalreporter.write_line(f"expected vs actual: {REPORT_PATH.as_uri()}")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit tests must never touch the network (compiler is offline, AGENTS.md)."""

    def guard(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("network access is not allowed in unit tests")

    monkeypatch.setattr(socket, "socket", guard)
    monkeypatch.setattr(socket, "create_connection", guard)
