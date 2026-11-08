"""Pin the Prometheus series of Datadog's OpenMetrics checks from integrations-core (#185).

Development-time only; deterministic and LLM-free. Each OpenMetrics check's test fixtures
(`<integration>/tests/fixtures/*`) hold real exposition captured from the exporter. This
script downloads them at the pinned commit into `out/integrations-core-fixtures/` (not
committed, ~36 MB), verifies every Git blob SHA, and writes only the extracted facts:
`fixtures/datadog/integrations-core/openmetrics-series.json` with, per integration, each
sample name, its `# TYPE` and its label names, plus the source paths and blob SHAs.

Usage:
  uv run scripts/pin_openmetrics_series.py           # list fixtures via the GitHub API, rewrite
  uv run scripts/pin_openmetrics_series.py --check   # rebuild from the pinned sources, compare
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures" / "datadog" / "integrations-core"
CHECKS = FIXTURES / "openmetrics-blobs.json"
OUT = FIXTURES / "openmetrics-series.json"
CACHE = ROOT / "out" / "integrations-core-fixtures"
SHA = "a9b9e42b7e484861ecbd1f5919da7c52a694b74d"
REPO = "DataDog/integrations-core"
_SKIP = (".py", ".yaml", ".yml", ".json", ".crt", ".key", ".pem", ".conf", ".ini", ".cfg")
_SAMPLE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+\S+")
_TYPE = re.compile(r"^#\s*TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(\w+)")
_LABEL = re.compile(r'\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*,?')
_FAMILY_SUFFIXES = ("_total", "_created", "_bucket", "_sum", "_count", "_gcount", "_gsum")


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 (fixed hosts)
        return bytes(response.read())


def fixture_list(get: Any = _get) -> dict[str, str]:
    """Path -> blob SHA of each OpenMetrics integration's test fixture at the commit."""
    integrations = {p.split("/")[0] for p in json.loads(CHECKS.read_text(encoding="utf-8"))}
    tree = json.loads(get(f"https://api.github.com/repos/{REPO}/git/trees/{SHA}?recursive=1"))
    if tree.get("truncated"):
        raise SystemExit("GitHub returned a truncated tree")
    return {
        e["path"]: e["sha"]
        for e in tree["tree"]
        if e["type"] == "blob"
        and e["path"].split("/")[0] in integrations
        and "/tests/fixtures/" in e["path"]
        and not e["path"].endswith(_SKIP)
    }


def fetch(path: str, blob: str, get: Any = _get) -> bytes:
    cached = CACHE / path
    if not cached.is_file():
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(get(f"https://raw.githubusercontent.com/{REPO}/{SHA}/{path}"))
    data = cached.read_bytes()
    if blob_sha(data) != blob:
        raise SystemExit(f"{path}: blob SHA mismatch (delete {cached} and retry)")
    return data


def parse_exposition(text: str) -> dict[str, tuple[str, set[str]]]:
    """Sample name -> (type, label names) from Prometheus or OpenMetrics text."""
    types: dict[str, str] = {}
    samples: dict[str, set[str]] = {}
    for line in text.splitlines():
        line = line.strip()
        if (t := _TYPE.match(line)) is not None:
            types[t.group(1)] = t.group(2).lower()
            continue
        if line.startswith("#") or (m := _SAMPLE.match(line)) is None:
            continue
        labels = {lm.group(1) for lm in _LABEL.finditer(m.group(3) or "")}
        samples.setdefault(m.group(1), set()).update(labels)
    out: dict[str, tuple[str, set[str]]] = {}
    for name, labels in samples.items():
        family = types.get(name)
        if family is None:
            family = next(
                (types[name[: -len(s)]] for s in _FAMILY_SUFFIXES
                 if name.endswith(s) and name[: -len(s)] in types),
                "",
            )
            if family not in ("counter", "histogram", "summary", "gaugehistogram"):
                family = ""
        out[name] = (family, labels)
    return out


def build(sources: dict[str, bytes]) -> dict[str, Any]:
    series: dict[str, dict[str, dict[str, Any]]] = {}
    for path in sorted(sources):
        try:
            text = sources[path].decode("utf-8")
        except UnicodeDecodeError:
            continue
        integ = series.setdefault(path.split("/")[0], {})
        for name, (mtype, labels) in parse_exposition(text).items():
            entry = integ.setdefault(name, {"types": [], "labels": []})
            entry["types"] = sorted(set(entry["types"]) | {mtype})
            entry["labels"] = sorted(set(entry["labels"]) | labels)
    return {
        "commit": SHA,
        "sources": {p: blob_sha(sources[p]) for p in sorted(sources)},
        "series": {i: dict(sorted(s.items())) for i, s in sorted(series.items()) if s},
    }


def render(body: dict[str, Any]) -> str:
    return json.dumps(body, indent=1, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="exit 1 if the pin is stale")
    args = parser.parse_args(argv)
    if args.check:
        listing = json.loads(OUT.read_text(encoding="utf-8"))["sources"]
    else:
        listing = fixture_list()
    text = render(build({p: fetch(p, b) for p, b in listing.items()}))
    series = json.loads(text)["series"]
    summary = f"{len(listing)} fixtures, {len(series)} integrations, "
    summary += f"{sum(len(s) for s in series.values())} series"
    if args.check:
        same = OUT.read_text(encoding="utf-8") == text
        print(f"{'OK' if same else 'STALE'}: {OUT.name} ({summary})")
        return 0 if same else 1
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({summary})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
