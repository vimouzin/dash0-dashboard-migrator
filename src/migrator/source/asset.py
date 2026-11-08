"""The SourceProvider interface and the shapes it exchanges with shared code."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from migrator.http import HttpSend, urllib_send
from migrator.input import InputFile
from migrator.target import CompileResult, Diagnostic


class SourceFetchError(Exception):
    """A provider's API request failed. Providers raise it from fetch(); the shared
    CLI maps it to exit code 1 without knowing which source raised it."""


@dataclass(frozen=True)
class SourceAsset:
    source_id: str
    kind: Literal["dashboard", "monitor"]
    title: str
    raw: Any
    body: dict[str, Any]


@dataclass(frozen=True)
class MappingFile:
    """One mapping file, read by shared code: its file name and parsed JSON.

    The provider validates and merges the files into its own mapping table."""

    source_id: str
    raw: Any


@dataclass(frozen=True)
class CompileOptions:
    project: str = "datadog-migration"


@dataclass(frozen=True)
class FetchSelection:
    """Explicit IDs to fetch from a source API (plan 10)."""

    dashboard_ids: tuple[str, ...] = ()
    monitor_ids: tuple[str, ...] = ()


@dataclass
class ProviderLoadResult:
    assets: list[SourceAsset] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)


class SourceProvider(Protocol):
    @property
    def id(self) -> str: ...

    def load(self, files: list[InputFile]) -> ProviderLoadResult: ...

    def compile(
        self, assets: list[SourceAsset], mappings: list[MappingFile], options: CompileOptions
    ) -> CompileResult: ...


class FetchingProvider(SourceProvider, Protocol):
    """A provider that can also fetch assets from its API by explicit ID (optional)."""

    def fetch(
        self,
        sel: FetchSelection,
        env: Mapping[str, str | None],
        out: str,
        send: HttpSend = urllib_send,
    ) -> list[str]: ...
