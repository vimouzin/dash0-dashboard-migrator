"""Local publish receipts (<run dir>/import-results.json).

They make publishing create-only and stop blind retries after an ambiguous result.
The file keeps camelCase keys (apiUrl, httpStatus) so it reads the same as the spec.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from migrator.input import InputError
from migrator.write import stable_stringify

RECEIPTS_FILE = "import-results.json"

ReceiptStatus = Literal["imported", "failed", "unknown"]
ReceiptDecision = Literal["publish", "skip-unchanged", "reject-changed", "reject-unknown"]


class Receipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True, strict=True)

    path: str = Field(min_length=1)
    sha256: str = Field(min_length=1)
    api_url: str = Field(alias="apiUrl", min_length=1)
    dataset: str = Field(min_length=1)
    status: ReceiptStatus
    id: str | None = None
    http_status: int | None = Field(default=None, alias="httpStatus")
    message: str | None = None
    # The publish --name-prefix the asset was sent with (None: no prefix).
    name_prefix: str | None = Field(default=None, alias="namePrefix")

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.path, self.api_url, self.dataset)


_RECEIPT_LIST = TypeAdapter(list[Receipt])


def load_receipts(directory: str | Path) -> list[Receipt]:
    """[] when the file is absent; InputError when it is malformed."""
    file = Path(directory) / RECEIPTS_FILE
    if not file.exists():
        return []
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise InputError(f"{RECEIPTS_FILE} is not valid JSON: {err}") from None
    try:
        return _RECEIPT_LIST.validate_python(raw)
    except ValidationError as err:
        first = err.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise InputError(f"{RECEIPTS_FILE} is malformed at {where}: {first['msg']}") from None


def save_receipts(directory: str | Path, receipts: list[Receipt]) -> None:
    ordered = sorted(receipts, key=lambda r: r.key)
    data = [r.model_dump(by_alias=True, exclude_none=True) for r in ordered]
    (Path(directory) / RECEIPTS_FILE).write_text(stable_stringify(data), encoding="utf-8")


def record_receipt(receipts: list[Receipt], new: Receipt) -> list[Receipt]:
    """Replace any receipt for the same path and destination with `new`."""
    kept = [r for r in receipts if r.key != new.key]
    return sorted([*kept, new], key=lambda r: r.key)


def decide(
    receipts: list[Receipt],
    path: str,
    sha256: str,
    api_url: str,
    dataset: str,
    name_prefix: str | None = None,
) -> ReceiptDecision:
    existing = next((r for r in receipts if r.key == (path, api_url, dataset)), None)
    if existing is None:
        return "publish"
    if existing.status == "unknown":
        return "reject-unknown"  # a human must reconcile first
    if existing.status == "imported":
        # no update flow: an edited artifact is never pushed over the old one
        same = existing.sha256 == sha256 and existing.name_prefix == name_prefix
        return "skip-unchanged" if same else "reject-changed"
    return "publish"  # a definite HTTP failure created nothing
