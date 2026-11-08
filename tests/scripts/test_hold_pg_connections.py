"""Tests for scripts/hold-pg-connections.sh against a stub `docker` on PATH."""

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "hold-pg-connections.sh"
PASSWORD = "s3cret-pw"


def make_stub(
    directory: Path,
    max_conn: int = 100,
    current: int = 8,
    sessions_fail: bool = False,
    report_open: bool = True,
) -> Path:
    """A stub `docker` that answers the read-only queries, records every call, and
    for pg_sleep sessions records its pid and sleeps until killed (or, with
    sessions_fail, exits at once like psql with bad credentials)."""
    session = "exit 2" if sessions_fail else f'echo $$ > "{directory}/child-$$.pid"; exec sleep 300'
    open_count = f'ls "{directory}" | grep -c "^child-"' if report_open else "echo 0"
    stub = directory / "docker"
    stub.write_text(
        "#!/bin/sh\n"
        f'printf \'%s\\n\' "$*" >> "{directory}/calls.log"\n'
        'case "$*" in\n'
        f'  *"show max_connections"*) echo {max_conn} ;;\n'
        '  *"show superuser_reserved_connections"*) echo 3 ;;\n'
        f'  *"count(*) from pg_stat_activity where application_name"*) {open_count} ;;\n'
        f"  *\"backend_type = 'client backend'\"*) echo {current} ;;\n"
        # An unfiltered count also sees 6 background workers.
        f'  *"count(*) from pg_stat_activity"*) echo {current + 6} ;;\n'
        "  *pg_terminate_backend*) echo t ;;\n"
        f"  *pg_sleep*) {session} ;;\n"
        "esac\n"
    )
    stub.chmod(0o755)
    return directory


def env_for(directory: Path, **overrides: str) -> dict[str, str]:
    env = {
        **os.environ,
        "PATH": f"{directory}{os.pathsep}{os.environ.get('PATH', '')}",
        "PG_CONTAINER": "pg",
        "PGUSER": "u",
        "PGDATABASE": "db",
        "PGPASSWORD": PASSWORD,
    }
    env.update(overrides)
    return env


def run(directory: Path, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sh", str(SCRIPT), *args],
        env=env_for(directory, **env),
        capture_output=True,
        text=True,
        timeout=30,
    )


def calls(directory: Path) -> str:
    log = directory / "calls.log"
    return log.read_text() if log.exists() else ""


def default_sigint() -> None:
    """Run in the child before exec: restore SIGINT's default action.

    A process started in the background of a non-interactive shell (a CI step,
    `pytest &`) inherits SIGINT as ignored, and a POSIX shell can't trap a
    signal that was ignored on entry, so the script would never see Ctrl-C.
    """
    signal.signal(signal.SIGINT, signal.SIG_DFL)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for(cond: Callable[[], bool], seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        time.sleep(0.05)


def test_dry_run_prints_count_sessions(tmp_path: Path) -> None:
    stub = make_stub(tmp_path)
    r = run(stub, "70", "900", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert sum("pg_sleep(900)" in line for line in r.stdout.splitlines()) == 70
    # Dry run only ran the three read-only queries.
    assert len(calls(stub).strip().splitlines()) == 3


def test_counts_only_client_backends(tmp_path: Path) -> None:
    # The planned "failed" crossing: 8 client backends + 85 = 93 < 100 - 3.
    stub = make_stub(tmp_path, current=8)
    r = run(stub, "85", "1800", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert "current=8 " in r.stdout
    assert "pid <> pg_backend_pid()" in calls(stub)


def test_never_prints_the_password(tmp_path: Path) -> None:
    stub = make_stub(tmp_path)
    r = run(stub, "2", "10", "--dry-run")
    assert PASSWORD not in r.stdout + r.stderr
    assert PASSWORD not in calls(stub)


def test_refuses_to_exceed_max_connections(tmp_path: Path) -> None:
    stub = make_stub(tmp_path)
    r = run(stub, "95", "60")
    assert r.returncode == 1
    assert "refusing: would exceed max_connections" in r.stderr
    assert not list(stub.glob("child-*"))


def test_keeps_superuser_reserved_headroom(tmp_path: Path) -> None:
    # 8 + 89 = 97 = 100 - 3 reserved: refused; 8 + 88 = 96 is allowed.
    stub = make_stub(tmp_path)
    assert run(stub, "89", "60", "--dry-run").returncode == 1
    assert run(stub, "88", "60", "--dry-run").returncode == 0


def test_psql_failure_is_reported_as_such(tmp_path: Path) -> None:
    stub = tmp_path / "docker"
    stub.write_text("#!/bin/sh\nexit 2\n")
    stub.chmod(0o755)
    r = run(tmp_path, "2", "60", "--dry-run")
    assert r.returncode == 1
    assert "psql failed" in r.stderr


def test_sessions_that_never_open_fail_the_run(tmp_path: Path) -> None:
    stub = make_stub(tmp_path, sessions_fail=True)
    r = run(stub, "2", "60")
    assert r.returncode == 1
    assert "only 0 of 2 sessions are open" in r.stderr
    assert "released" not in r.stdout


@pytest.mark.parametrize("args", [("x", "60"), ("0", "60"), ("2",), ("2", "60", "--nope")])
def test_rejects_bad_arguments(tmp_path: Path, args: tuple[str, ...]) -> None:
    assert run(make_stub(tmp_path), *args).returncode == 1


def test_rejects_missing_container(tmp_path: Path) -> None:
    r = run(make_stub(tmp_path), "2", "60", PG_CONTAINER="")
    assert r.returncode == 1
    assert "PG_CONTAINER" in r.stderr


def test_sigint_cleanup_releases_connections(tmp_path: Path) -> None:
    stub = make_stub(tmp_path)
    # Its own session, so the SIGINT goes to the whole process group, like Ctrl-C.
    proc = subprocess.Popen(
        ["sh", str(SCRIPT), "3", "900"],
        env=env_for(stub),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        preexec_fn=default_sigint,
    )
    try:
        wait_for(lambda: len(list(stub.glob("child-*.pid"))) == 3)
        pids = [int(p.read_text()) for p in stub.glob("child-*.pid")]
        assert all(alive(p) for p in pids)

        os.killpg(proc.pid, signal.SIGINT)
        proc.wait(timeout=10)
        wait_for(lambda: not any(alive(p) for p in pids))
        # Server-side sessions are terminated too: killing `docker exec` does not end psql.
        assert "pg_terminate_backend" in calls(stub)
    finally:
        if proc.poll() is None:
            proc.kill()


@pytest.mark.parametrize(
    ("to_group", "sig", "code"),
    [(True, signal.SIGINT, 130), (False, signal.SIGTERM, 143)],
    ids=["ctrl-c-to-group", "term-to-pid"],
)
def test_signal_during_startup_poll_is_handled_at_once(
    tmp_path: Path, to_group: bool, sig: signal.Signals, code: int
) -> None:
    # Sessions start but are never reported open, so the script stays in its
    # 10 s startup poll. Ctrl-C (SIGINT to the whole group) or TERM to the PID
    # must run the trap at once. (A SIGINT to the PID alone is not tested: bash
    # discards it while a foreground child that didn't die of it is running.)
    stub = make_stub(tmp_path, report_open=False)
    proc = subprocess.Popen(
        ["sh", str(SCRIPT), "2", "900"],
        env=env_for(stub),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        preexec_fn=default_sigint,
    )
    try:
        wait_for(lambda: len(list(stub.glob("child-*.pid"))) == 2)
        pids = [int(p.read_text()) for p in stub.glob("child-*.pid")]
        time.sleep(1.5)  # inside the poll loop
        started = time.monotonic()
        if to_group:
            os.killpg(proc.pid, sig)
        else:
            proc.send_signal(sig)
        assert proc.wait(timeout=5) == code
        assert time.monotonic() - started < 3
        wait_for(lambda: not any(alive(p) for p in pids))
        assert "pg_terminate_backend" in calls(stub)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
