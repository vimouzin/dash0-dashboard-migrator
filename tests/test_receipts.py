from __future__ import annotations

import json
from pathlib import Path

import pytest

from migrator.input import InputError
from migrator.receipts import (
    RECEIPTS_FILE,
    Receipt,
    decide,
    load_receipts,
    record_receipt,
    save_receipts,
)

API = "https://api.example.dash0.com"


def receipt(path: str = "dashboards/a.json", **kw: object) -> Receipt:
    base: dict[str, object] = {
        "path": path,
        "sha256": "s1",
        "apiUrl": API,
        "dataset": "default",
        "status": "imported",
        "id": "id-1",
        "httpStatus": 200,
    }
    base.update(kw)
    return Receipt.model_validate(base)


def test_absent_file_is_empty(tmp_path: Path) -> None:
    assert load_receipts(tmp_path) == []


def test_round_trip_is_sorted_and_camel_case(tmp_path: Path) -> None:
    b, a = receipt("b.json"), receipt("a.json", status="unknown", id=None, httpStatus=None)
    save_receipts(tmp_path, [b, a])
    text = (tmp_path / RECEIPTS_FILE).read_text()
    data = json.loads(text)
    assert [r["path"] for r in data] == ["a.json", "b.json"]
    assert "apiUrl" in data[0] and "httpStatus" not in data[0] and "id" not in data[0]
    assert text.endswith("\n")
    assert load_receipts(tmp_path) == [a, b]


def test_save_is_byte_stable(tmp_path: Path) -> None:
    rs = [receipt("b.json"), receipt("a.json")]
    save_receipts(tmp_path, rs)
    first = (tmp_path / RECEIPTS_FILE).read_bytes()
    save_receipts(tmp_path, list(reversed(rs)))
    assert (tmp_path / RECEIPTS_FILE).read_bytes() == first


def test_invalid_json_is_input_error(tmp_path: Path) -> None:
    (tmp_path / RECEIPTS_FILE).write_text("{nope")
    with pytest.raises(InputError, match="not valid JSON"):
        load_receipts(tmp_path)


@pytest.mark.parametrize(
    "doc",
    [
        {"x": 1},
        [{"path": "a", "sha256": "s", "apiUrl": API, "dataset": "d", "status": "done"}],
        [{"path": "a", "sha256": "s", "apiUrl": API, "dataset": "d", "status": "failed", "z": 1}],
        [{"path": "", "sha256": "s", "apiUrl": API, "dataset": "d", "status": "failed"}],
        [
            {
                "path": "a",
                "sha256": "s",
                "apiUrl": API,
                "dataset": "d",
                "status": "failed",
                "httpStatus": "500",
            }
        ],
    ],
)
def test_malformed_is_input_error(tmp_path: Path, doc: object) -> None:
    (tmp_path / RECEIPTS_FILE).write_text(json.dumps(doc))
    with pytest.raises(InputError, match="malformed"):
        load_receipts(tmp_path)


def test_record_replaces_same_key_only() -> None:
    old = receipt(status="failed", httpStatus=400, id=None)
    other_dataset = receipt(dataset="other")
    new = receipt(status="imported")
    out = record_receipt([old, other_dataset], new)
    assert out == sorted([new, other_dataset], key=lambda r: r.key)


def test_decide_matrix() -> None:
    p = "dashboards/a.json"
    assert decide([], p, "s1", API, "default") == "publish"
    assert decide([receipt(p, status="unknown")], p, "s1", API, "default") == "reject-unknown"
    assert decide([receipt(p)], p, "s1", API, "default") == "skip-unchanged"
    assert decide([receipt(p)], p, "s2", API, "default") == "reject-changed"
    assert decide([receipt(p, status="failed")], p, "s2", API, "default") == "publish"
    # a receipt for another destination does not count
    assert decide([receipt(p)], p, "s1", API, "other") == "publish"
    assert decide([receipt(p)], p, "s1", "https://other", "default") == "publish"


def test_decide_compares_the_name_prefix() -> None:
    p = "dashboards/a.json"
    tagged = receipt(p, namePrefix="demo-")
    assert decide([tagged], p, "s1", API, "default", "demo-") == "skip-unchanged"
    assert decide([tagged], p, "s1", API, "default") == "reject-changed"
    assert decide([receipt(p)], p, "s1", API, "default", "demo-") == "reject-changed"
    assert decide([receipt(p, status="failed", namePrefix="x-")], p, "s1", API, "default") == (
        "publish"
    )
