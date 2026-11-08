"""Recognize, unwrap and identify Datadog dashboards and monitors."""

from __future__ import annotations

import json
from typing import Any

from migrator.input import InputError, InputFile
from migrator.source.asset import SourceAsset
from migrator.target import Diagnostic


def _recognize(raw: Any) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    if isinstance(raw.get("widgets"), list) and isinstance(raw.get("layout_type"), str):
        return "dashboard", raw
    definition = raw.get("definition")
    if (
        isinstance(definition, dict)
        and isinstance(definition.get("query"), str)
        and isinstance(definition.get("type"), str)
    ):
        return "monitor", definition
    if (
        isinstance(raw.get("query"), str)
        and isinstance(raw.get("type"), str)
        and isinstance(raw.get("options"), dict)
    ):
        return "monitor", raw
    return None


def recognize_assets(files: list[InputFile]) -> tuple[list[SourceAsset], list[Diagnostic]]:
    assets: list[SourceAsset] = []
    diagnostics: list[Diagnostic] = []
    for f in files:
        try:
            raw = json.loads(f.text)
        except json.JSONDecodeError as err:
            raise InputError(f"INVALID_JSON: {f.source_id}: {err}") from err
        found = _recognize(raw)
        if found is None:
            diagnostics.append(
                Diagnostic(
                    code="UNSUPPORTED_ASSET_KIND",
                    severity="warning",
                    source_id=f.source_id,
                    source_path="",
                    message="File is not a recognized Datadog dashboard or monitor; skipped.",
                    suggested_action="Remove the file from the input or check its format.",
                )
            )
            continue
        kind, body = found
        title_key = "title" if kind == "dashboard" else "name"
        raw_title = body.get(title_key)
        title = raw_title if isinstance(raw_title, str) else ""
        assets.append(
            SourceAsset(
                source_id=f.source_id,
                kind=kind,  # type: ignore[arg-type]
                title=title,
                raw=raw,
                body=body,
            )
        )
    return assets, diagnostics
