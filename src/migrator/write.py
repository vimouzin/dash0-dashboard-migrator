"""Deterministic writers: sorted JSON/YAML, slugs and hashes."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

import yaml

_NON_SLUG = re.compile(r"[^a-z0-9]+")
_SLUG_MAX = 64


def stable_stringify(value: Any) -> str:
    """JSON with recursively sorted keys, 2-space indent and a trailing newline."""
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def to_yaml(value: Any) -> str:
    """YAML with sorted map entries, block style."""
    return yaml.safe_dump(value, sort_keys=True, allow_unicode=True, default_flow_style=False)


def slugify(title: str) -> str:
    slug = _NON_SLUG.sub("-", title.lower()).strip("-")
    slug = slug[:_SLUG_MAX].rstrip("-")
    return slug or "dashboard"


def assign_slugs(titles: list[str]) -> list[str]:
    """Slugify in order; later collisions get -2, -3, ..."""
    used: set[str] = set()
    out: list[str] = []
    for title in titles:
        base = slugify(title)
        slug, n = base, 1
        while slug in used:
            n += 1
            slug = f"{base}-{n}"
        used.add(slug)
        out.append(slug)
    return out


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
