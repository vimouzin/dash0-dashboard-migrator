"""run_convert: input -> provider -> writers -> report. Offline; no network I/O."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from migrator.input import InputError, collect_input_files
from migrator.report import exit_code_for, manifest_entry, summarize
from migrator.source.asset import CompileOptions, MappingFile
from migrator.source.provider import get_provider
from migrator.target import ValidationLevels
from migrator.version import COMPILER_VERSION
from migrator.write import sha256, stable_stringify, to_yaml

Format = Literal["json", "yaml"]


@dataclass(frozen=True)
class ConvertOptions:
    source: str
    inputs: list[str]
    mapping: list[str]  # mapping files or directories (--mapping, repeatable)
    out: str
    format: Format = "json"
    project: str = "datadog-migration"


@dataclass(frozen=True)
class ConvertResult:
    report: dict[str, Any]
    manifest: dict[str, Any]
    exit_code: Literal[0, 1, 2]
    slugs: dict[str, str]


def _write(out: Path, rel: str, text: str) -> str:
    target = out / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return sha256(text)


def _read_mappings(paths: list[str]) -> list[tuple[str, str, Any]]:
    """Read --mapping paths: files, or directories (their *.json, non-recursive).

    Returns (file name, text, parsed JSON), sorted by file name. File names must be unique."""
    found: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            inside = sorted(c for c in p.glob("*.json") if c.is_file())
            if not inside:
                raise InputError(f"no mapping files (*.json) in {raw}")
            found.extend(inside)
        else:
            found.append(p)
    out: dict[str, tuple[str, str, Any]] = {}
    for p in found:
        if p.name in out:
            raise InputError(f"duplicate mapping file name: {p.name}")
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as err:
            raise InputError(f"cannot read mapping: {p}: {err.strerror}") from err
        try:
            out[p.name] = (p.name, text, json.loads(text))
        except json.JSONDecodeError as err:
            raise InputError(f"invalid mapping: {p}: {err}") from err
    return [out[name] for name in sorted(out)]


def run_convert(opts: ConvertOptions) -> ConvertResult:
    provider = get_provider(opts.source)
    out = Path(opts.out)
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise InputError(f"output directory is not empty: {opts.out}")
    files = collect_input_files(opts.inputs)
    mappings = _read_mappings(opts.mapping)

    loaded = provider.load(files)
    if not loaded.assets:
        details = "; ".join(f"{d.code}: {d.source_id}: {d.message}" for d in loaded.diagnostics)
        message = "NO_SUPPORTED_ASSETS: no recognized dashboards or monitors in the input."
        raise InputError(f"{message} {details}" if details else message)
    result = provider.compile(
        loaded.assets,
        [MappingFile(name, raw) for name, _, raw in mappings],
        CompileOptions(project=opts.project),
    )

    out.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    for f in files:
        rel = f"source/{f.source_id}"
        entries.append(manifest_entry(rel, "source", f.source_id, _write(out, rel, f.text), None))

    outcomes = {(i.source_id, i.kind): i.outcome for i in result.items if i.source_path == ""}
    remarks = {(i.source_id, i.kind): i.remarks for i in result.items if i.source_path == ""}
    ext = "yaml" if opts.format == "yaml" else "json"
    for art in result.dashboards:
        text = to_yaml(art.dashboard) if ext == "yaml" else stable_stringify(art.dashboard)
        rel = f"dashboards/{art.slug}.{ext}"
        outcome = outcomes.get((art.source_id, "dashboard"))
        tags = remarks.get((art.source_id, "dashboard"), ())
        digest = _write(out, rel, text)
        entries.append(manifest_entry(rel, "dashboard", art.source_id, digest, outcome, tags))
    for rule in result.rules:
        outcome = outcomes.get((rule.source_id, "monitor"))
        tags = remarks.get((rule.source_id, "monitor"), ())
        group = rule.prometheus_rule_group
        text = to_yaml(group) if ext == "yaml" else stable_stringify(group)
        rel = f"rules/{rule.slug}.prometheus.{ext}"
        digest = _write(out, rel, text)
        entries.append(
            manifest_entry(rel, "prometheus-rule", rule.source_id, digest, outcome, tags)
        )
        rel = f"check-rules/{rule.slug}.json"
        digest = _write(out, rel, stable_stringify(rule.check_rule))
        entries.append(manifest_entry(rel, "check-rule", rule.source_id, digest, outcome, tags))

    emitted = bool(result.dashboards or result.rules)
    validation = ValidationLevels(
        # Emitted artifacts already passed the provider's syntax and schema checks;
        # anything that failed was blocked with TARGET_VALIDATION_FAILED instead.
        syntax="passed" if emitted else "not_run",
        schema="passed" if emitted else "not_run",
    )
    report: dict[str, Any] = {
        "reportVersion": 1,
        "provider": provider.id,
        "compilerVersion": COMPILER_VERSION,
        "format": opts.format,
        "mapping": [{"sourceId": name, "sha256": sha256(text)} for name, text, _ in mappings],
        "summary": summarize(result.items, len(loaded.diagnostics)),
        "items": [i.to_dict() for i in result.items],
        "diagnostics": [d.to_dict() for d in loaded.diagnostics + result.diagnostics],
        "validation": validation.to_dict(),
    }
    if result.mapping_coverage is not None:
        report["mappingCoverage"] = result.mapping_coverage.to_dict()
    _write(out, "report.json", stable_stringify(report))
    manifest: dict[str, Any] = {
        "manifestVersion": 1,
        "provider": provider.id,
        "compilerVersion": COMPILER_VERSION,
        "format": opts.format,
        "entries": sorted(entries, key=lambda e: e["path"]),
    }
    _write(out, "manifest.json", stable_stringify(manifest))
    slugs = {a.source_id: a.slug for a in result.dashboards}
    return ConvertResult(
        report, manifest, exit_code_for(result.items, len(loaded.diagnostics)), slugs
    )
