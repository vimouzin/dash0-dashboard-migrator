"""Run the development-only live comparison harness; see docs/LIVE_COMPARE.md."""

from __future__ import annotations

import signal

from live_compare_support.runner import main


def interrupted(signum: int, frame: object) -> None:
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
