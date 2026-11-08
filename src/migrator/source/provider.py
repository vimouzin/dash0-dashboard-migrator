"""Static provider table selected by --source. Not a plugin framework."""

from __future__ import annotations

from collections.abc import Mapping

from migrator.input import InputError
from migrator.source.asset import (
    CompileOptions,
    FetchingProvider,
    FetchSelection,
    ProviderLoadResult,
    SourceAsset,
    SourceProvider,
)
from migrator.source.datadog import DATADOG_PROVIDER

PROVIDERS: Mapping[str, SourceProvider] = {"datadog": DATADOG_PROVIDER}


def get_provider(provider_id: str) -> SourceProvider:
    provider = PROVIDERS.get(provider_id)
    if provider is None:
        known = ", ".join(sorted(PROVIDERS))
        raise InputError(f"unknown --source '{provider_id}'; known: {known}")
    return provider


__all__ = [
    "PROVIDERS",
    "CompileOptions",
    "FetchSelection",
    "FetchingProvider",
    "ProviderLoadResult",
    "SourceAsset",
    "SourceProvider",
    "get_provider",
]
