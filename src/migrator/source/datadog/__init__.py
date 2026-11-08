"""The Datadog source provider: dashboards (plans 04/05) and monitors (plan 06)."""

from __future__ import annotations

from collections.abc import Mapping

from migrator.http import HttpSend, urllib_send
from migrator.input import InputError, InputFile
from migrator.source.asset import (
    CompileOptions,
    FetchSelection,
    MappingFile,
    ProviderLoadResult,
    SourceAsset,
)
from migrator.source.datadog.api import fetch_datadog_assets
from migrator.source.datadog.assets import recognize_assets
from migrator.source.datadog.coverage import inspect_mapping_coverage
from migrator.source.datadog.dashboard import compile_dashboard
from migrator.source.datadog.mapping import parse_mappings
from migrator.source.datadog.monitor import compile_monitor
from migrator.target import CompileResult, DashboardArtifact
from migrator.write import assign_slugs


class DatadogProvider:
    @property
    def id(self) -> str:
        return "datadog"

    def load(self, files: list[InputFile]) -> ProviderLoadResult:
        assets, diagnostics = recognize_assets(files)
        return ProviderLoadResult(assets=assets, diagnostics=diagnostics)

    def fetch(
        self,
        sel: FetchSelection,
        env: Mapping[str, str | None],
        out: str,
        send: HttpSend = urllib_send,
    ) -> list[str]:
        return fetch_datadog_assets(sel, env, out, send)

    def compile(
        self, assets: list[SourceAsset], mappings: list[MappingFile], options: CompileOptions
    ) -> CompileResult:
        parsed = parse_mappings([(m.source_id, m.raw) for m in mappings])
        if not parsed.ok:
            raise InputError("invalid mapping: " + "; ".join(parsed.errors))
        result = CompileResult(mapping_coverage=inspect_mapping_coverage(assets, parsed.mapping))
        dashboards = sorted((a for a in assets if a.kind == "dashboard"), key=lambda a: a.source_id)
        slugs = assign_slugs([a.title for a in dashboards])
        for asset, slug in zip(dashboards, slugs, strict=True):
            comp = compile_dashboard(asset, slug, parsed.mapping, options)
            result.items.extend(comp.items)
            result.diagnostics.extend(comp.diagnostics)
            if comp.dashboard is not None:
                result.dashboards.append(DashboardArtifact(slug, asset.source_id, comp.dashboard))
        monitors = sorted((a for a in assets if a.kind == "monitor"), key=lambda a: a.source_id)
        monitor_slugs = assign_slugs([a.title for a in monitors])
        for asset, slug in zip(monitors, monitor_slugs, strict=True):
            mon = compile_monitor(asset, slug, parsed.mapping)
            result.items.append(mon.item)
            result.diagnostics.extend(mon.diagnostics)
            if mon.rule is not None:
                result.rules.append(mon.rule)
        return result


DATADOG_PROVIDER = DatadogProvider()
