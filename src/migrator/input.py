"""Collect input files from --input paths: sorted, recursive, symlinks skipped."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from migrator.write import sha256


class InputError(Exception):
    """Bad arguments or unreadable input; the CLI exits 1."""


@dataclass(frozen=True)
class InputFile:
    source_id: str
    path: str
    text: str
    sha256: str


def _read(path: Path, source_id: str) -> InputFile:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as err:
        raise InputError(
            f"input is not valid UTF-8: {source_id} (byte {err.start}: {err.reason})"
        ) from None
    except OSError as err:
        raise InputError(f"cannot read input: {source_id} ({err.strerror or err})") from None
    return InputFile(source_id=source_id, path=str(path), text=text, sha256=sha256(text))


def _walk(root: Path) -> list[tuple[str, Path]]:
    found: list[tuple[str, Path]] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        base = Path(dirpath)
        # Never descend into symlinked directories.
        dirnames[:] = [d for d in dirnames if not (base / d).is_symlink()]
        for name in filenames:
            p = base / name
            if p.is_symlink() or not name.endswith(".json"):
                continue
            rel = p.relative_to(root).as_posix()
            found.append((f"{root.name}/{rel}", p))
    return found


def collect_input_files(paths: list[str]) -> list[InputFile]:
    entries: list[tuple[str, Path]] = []
    for raw in paths:
        p = Path(raw)
        if not p.exists() and not p.is_symlink():
            raise InputError(f"input not found: {raw}")
        if p.is_dir():
            entries.extend(_walk(p.resolve()))
        else:
            if not p.name.endswith(".json"):
                raise InputError(f"input file must end in .json: {raw}")
            entries.append((p.name, p))
    seen: set[str] = set()
    for source_id, _ in entries:
        if source_id in seen:
            raise InputError(f"DUPLICATE_SOURCE_ID: {source_id}")
        seen.add(source_id)
    entries.sort(key=lambda e: e[0])
    return [_read(path, source_id) for source_id, path in entries]
