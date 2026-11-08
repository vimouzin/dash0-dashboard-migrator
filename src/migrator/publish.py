"""run_publish: import eligible converted artifacts into one Dash0 dataset.

Create-only, sequential in manifest order, with local receipts. Everything is
validated before the first write. No translation happens here.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, cast

from migrator.destination.dash0 import (
    Dash0Config,
    Failed,
    Imported,
    PublishOutcome,
    publish_check_rule,
    publish_dashboard,
    read_dash0_config,
)
from migrator.http import HttpSend, urllib_send
from migrator.input import InputError
from migrator.receipts import Receipt, decide, load_receipts, record_receipt, save_receipts
from migrator.report import CONVERTED
from migrator.target import Dash0CheckRule, PersesDashboard
from migrator.validation import validate_check_rule, validate_dashboard

PUBLISHABLE: dict[str, Literal["dashboard", "check-rule"]] = {
    "dashboard": "dashboard",
    "check-rule": "check-rule",
}
AUTH_STOP_STATUSES = frozenset({401, 403})
# Lowercase, digits and hyphens only, so the same prefix is valid in a Perses
# metadata.name (^[a-z0-9-]+$) and can never inject a {{...}} template into a name.
NAME_PREFIX_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


@dataclass(frozen=True)
class PublishOptions:
    source_dir: str
    dry_run: bool = False
    allow_partial: bool = False
    # Prepended to each published dashboard's metadata.name and display name and to
    # each check rule's name, e.g. "demo-". Applied at send time: the artifacts on
    # disk, their sha256 and the manifest stay as convert wrote them.
    name_prefix: str | None = None


@dataclass
class PublishRun:
    exit_code: Literal[0, 1, 2]
    receipts: list[Receipt] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _Selected:
    path: str
    kind: Literal["dashboard", "check-rule"]
    sha256: str
    name: str
    body: dict[str, Any]
    outcome: str = "translated"
    remarks: tuple[str, ...] = ()

    def label(self) -> str:
        """`[approximated: TIMEPIN]`, `[partial]`; empty for translated items."""
        if self.outcome == "translated":
            return ""
        tags = f": {' '.join(self.remarks)}" if self.remarks else ""
        return f"  [{self.outcome}{tags}]"


def _read_json(path: Path, what: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise InputError(f"{what} not found: {path.name}") from None
    except (OSError, json.JSONDecodeError) as err:
        raise InputError(f"{what} is not valid JSON: {path.name}: {err}") from None


def _entries(root: Path) -> list[dict[str, Any]]:
    manifest = _read_json(root / "manifest.json", "manifest")
    entries = manifest.get("entries") if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
        raise InputError("manifest is malformed: 'entries' must be a list of objects")
    for i, e in enumerate(entries):
        for key in ("path", "kind", "sha256"):
            if not isinstance(e.get(key), str):
                raise InputError(f"manifest is malformed: entries[{i}].{key} must be a string")
    return cast(list[dict[str, Any]], entries)


def _blocked_items(root: Path) -> list[str]:
    """Top-level report items convert blocked; they have no artifact but still count."""
    report_path = root / "report.json"
    if not report_path.exists():
        return []
    report = _read_json(report_path, "report")
    items = report.get("items", []) if isinstance(report, dict) else []
    return sorted(
        f"{i.get('kind')} {i.get('sourceId')}"
        for i in items
        if isinstance(i, dict) and i.get("sourcePath") == "" and i.get("outcome") == "blocked"
    )


def _load_selected(
    root: Path, entry: dict[str, Any], kind: Literal["dashboard", "check-rule"]
) -> _Selected:
    rel = entry["path"]
    target = (root / rel).resolve()
    if not target.is_relative_to(root):
        raise InputError(f"manifest path escapes the run directory: {rel}")
    try:
        data = target.read_bytes()
    except OSError as err:
        raise InputError(f"cannot read {rel}: {err.strerror}") from None
    digest = hashlib.sha256(data).hexdigest()
    if digest != entry["sha256"]:
        raise InputError(f"sha256 mismatch for {rel}: the file changed after convert")
    try:
        body = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise InputError(f"{rel} is not valid JSON: {err}") from None
    problems = validate_dashboard(body) if kind == "dashboard" else validate_check_rule(body)
    if problems:
        raise InputError(f"{rel} failed validation: " + "; ".join(problems))
    if kind == "dashboard":
        name = str(body["spec"]["display"]["name"])
    else:
        name = str(body["name"])
    remarks = tuple(entry.get("remarks") or ())
    return _Selected(rel, kind, entry["sha256"], name, body, entry["outcome"], remarks)


def _with_prefix(item: _Selected, prefix: str | None) -> _Selected:
    """Return the item renamed with the prefix; the result is validated again."""
    if prefix is None:
        return item
    body = json.loads(json.dumps(item.body))  # deep copy; the on-disk body is untouched
    if item.kind == "dashboard":
        body["metadata"]["name"] = prefix + body["metadata"]["name"]
        body["spec"]["display"]["name"] = prefix + body["spec"]["display"]["name"]
        name = str(body["spec"]["display"]["name"])
        problems = validate_dashboard(body)
    else:
        body["name"] = prefix + body["name"]
        name = str(body["name"])
        problems = validate_check_rule(body)
    if problems:
        raise InputError(
            f"{item.path} with --name-prefix failed validation: " + "; ".join(problems)
        )
    return _Selected(item.path, item.kind, item.sha256, name, body, item.outcome, item.remarks)


def _plan(root: Path, allow_partial: bool) -> tuple[list[_Selected], list[str]]:
    selected: list[_Selected] = []
    excluded: list[str] = []
    for entry in _entries(root):
        kind = PUBLISHABLE.get(entry["kind"])
        if kind is None:
            continue  # sources, Prometheus rule files and anything else are never published
        outcome = entry.get("outcome")
        if outcome in CONVERTED or (outcome == "partial" and allow_partial):
            selected.append(_load_selected(root, entry, kind))
        elif outcome == "partial":
            excluded.append(f"SKIP {entry['path']}  (partial; pass --allow-partial to publish)")
        else:
            excluded.append(f"SKIP {entry['path']}  (outcome {outcome})")
    excluded += [f"SKIP {item}  (blocked in convert)" for item in _blocked_items(root)]
    # Remark categories publish as their own groups after the exact translations
    # (docs/REMARKS.md); each line names the category and its tags.
    order: dict[str, int] = {o: n for n, o in enumerate(CONVERTED)}
    selected.sort(key=lambda item: order.get(item.outcome, len(order)))
    return selected, excluded


def _send(item: _Selected, cfg: Dash0Config, send: HttpSend) -> PublishOutcome:
    if item.kind == "dashboard":
        return publish_dashboard(cast(PersesDashboard, item.body), cfg, send)
    return publish_check_rule(cast(Dash0CheckRule, item.body), cfg, send)


def run_publish(
    opts: PublishOptions, env: Mapping[str, str | None], send: HttpSend = urllib_send
) -> PublishRun:
    """Exit 0: all imported or unchanged; 2: something excluded; 1: any failure,
    unknown result, refusal or validation error. Missing env raises InputError."""
    cfg = read_dash0_config(env)
    prefix = opts.name_prefix
    if prefix is not None and not NAME_PREFIX_RE.fullmatch(prefix):
        raise InputError(
            "--name-prefix must be 1-32 characters of a-z, 0-9 and '-', starting with a "
            "letter or digit"
        )
    root = Path(opts.source_dir).resolve()
    if not root.is_dir():
        raise InputError(f"--from is not a directory: {opts.source_dir}")
    try:
        selected, excluded = _plan(root, opts.allow_partial)
        selected = [_with_prefix(item, prefix) for item in selected]
    except InputError as err:
        return PublishRun(exit_code=1, lines=[f"error: {err}"])

    receipts = load_receipts(root)
    lines = list(excluded)
    failed = False
    for item in selected:
        decision = decide(receipts, item.path, item.sha256, cfg.api_url, cfg.dataset, prefix)
        if opts.dry_run:
            lines.append(
                f"DRY-RUN POST {cfg.api_url}/api/import/{item.kind}?dataset={cfg.dataset}"
                f"  {item.name}  ({decision}){item.label()}"
            )
            continue
        if decision == "skip-unchanged":
            lines.append(f"UNCHANGED {item.path}  (already imported)")
            continue
        if decision == "reject-unknown":
            failed = True
            lines.append(
                f"REFUSED {item.path}  (an earlier import result is unknown; check Dash0 and "
                f"fix import-results.json before republishing)"
            )
            continue
        if decision == "reject-changed":
            failed = True
            lines.append(
                f"REFUSED {item.path}  (changed since it was imported, or imported with "
                f"another --name-prefix; there is no update flow)"
            )
            continue

        outcome = _send(item, cfg, send)
        receipt = Receipt(
            path=item.path,
            sha256=item.sha256,
            apiUrl=cfg.api_url,
            dataset=cfg.dataset,
            status=outcome.status,
            id=outcome.id if isinstance(outcome, Imported) else None,
            httpStatus=outcome.http_status if isinstance(outcome, Imported | Failed) else None,
            message=None if isinstance(outcome, Imported) else outcome.message,
            namePrefix=prefix,
        )
        receipts = record_receipt(receipts, receipt)
        save_receipts(root, receipts)  # after every asset, so a crash keeps what happened
        if isinstance(outcome, Imported):
            lines.append(f"IMPORTED {item.path}  id={outcome.id}{item.label()}")
            continue
        failed = True
        if isinstance(outcome, Failed):
            lines.append(f"FAILED {item.path}  HTTP {outcome.http_status}: {outcome.message}")
            if outcome.http_status in AUTH_STOP_STATUSES:
                lines.append(f"stopping: HTTP {outcome.http_status}; check the token and dataset")
                break
        else:
            lines.append(f"UNKNOWN {item.path}  {outcome.message}")

    exit_code: Literal[0, 1, 2] = 1 if failed else (2 if excluded else 0)
    return PublishRun(exit_code=exit_code, receipts=receipts, lines=lines)
