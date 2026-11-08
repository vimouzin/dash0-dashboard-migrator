"""Expected-vs-actual HTML report of a pytest run (written by conftest.py, opened in a browser).

Each request case records the Datadog request, the expectation and what the converter produced;
this module renders them as one self-contained page: failures first and expanded, PromQL shown
side by side with a line diff when the canonical forms differ. Development aid only.
"""

from __future__ import annotations

import difflib
import json
from html import escape
from typing import Any

STATUS_ORDER = {"failed": 0, "error": 1, "passed": 2}

CSS = """
body{font:14px system-ui,sans-serif;margin:1.5rem;color:#1d1d1f}
h1{font-size:1.3rem;margin:0 0 .5rem}
.summary span{margin-right:1rem;font-weight:600}
.failed,.error{color:#b3261e}.passed{color:#1e7d32}
details{border:1px solid #ddd;border-radius:6px;margin:.4rem 0;padding:.3rem .6rem}
details[data-status=failed],details[data-status=error]{border-color:#e3a6a1;background:#fff8f7}
summary{cursor:pointer}
summary code{font-size:12px;color:#555}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:.6rem 0}
.grid h3{font-size:.9rem;margin:.2rem 0}
pre{background:#f5f5f7;padding:.5rem;border-radius:4px;white-space:pre-wrap;word-break:break-all;
font-size:12px;margin:.2rem 0}
.bad{outline:2px solid #e3a6a1}
.msg{color:#b3261e;font-family:monospace;font-size:12px;white-space:pre-wrap}
table.diff{font:12px monospace;border-collapse:collapse;width:100%}
table.diff td{padding:0 .3rem;vertical-align:top;white-space:pre-wrap;word-break:break-all}
.diff_add{background:#d7f5dd}.diff_chg{background:#fff1b8}.diff_sub{background:#ffd7d5}
.diff_header,.diff_next{color:#999}
label{margin-left:1rem}
"""

SCRIPT = """
document.getElementById('hide-passed').addEventListener('change', e => {
  document.querySelectorAll('details[data-status=passed]')
    .forEach(d => d.style.display = e.target.checked ? 'none' : '');
});
"""


def _side(title: str, side: dict[str, Any], mismatch: set[str]) -> str:
    def block(key: str, text: str) -> str:
        cls = ' class="bad"' if key in mismatch else ""
        return f"<pre{cls}>{escape(text)}</pre>"

    errors, warnings = ", ".join(side["errors"]) or "-", ", ".join(side["warnings"]) or "-"
    codes = f"errors: {errors}\nwarnings: {warnings}"
    return (
        f"<div><h3>{escape(title)}</h3>"
        + block("outcome", f"outcome: {side['outcome']}")
        + block("promql", "\n\n".join(side["promql"]) or "(no PromQL)")
        + block("codes", codes)
        + "</div>"
    )


def _entry(rec: dict[str, Any]) -> str:
    exp, act = rec["expected"], rec["actual"]
    mismatch = set(rec["mismatch"])
    tags = " ".join(f"≠ {m}" for m in rec["mismatch"]) or "match"
    head = (
        f'<summary><b class="{rec["status"]}">{rec["status"].upper()}</b> '
        f"{escape(rec['case_id'])} <code>{escape(tags)}"
        f"{'' if rec['reviewed'] else ' · unreviewed'}</code></summary>"
    )
    body = ""
    if rec["message"]:
        body += f'<div class="msg">{escape(rec["message"])}</div>'
    body += (
        '<div class="grid">'
        + _side("Expected", exp, mismatch)
        + _side("Actual (converter)", act, mismatch)
        + "</div>"
    )
    if "promql" in mismatch:
        diff = difflib.HtmlDiff(wrapcolumn=80).make_table(
            exp["canonical"], act["canonical"], "expected (canonical)", "actual (canonical)"
        )
        body += f"<h3>Canonical PromQL diff</h3>{diff}"
    body += (
        "<h3>Datadog request</h3>"
        f"<pre>{escape(json.dumps(rec['source'], indent=2, sort_keys=True))}</pre>"
    )
    opened = " open" if rec["status"] != "passed" else ""
    return f'<details data-status="{rec["status"]}"{opened}>{head}{body}</details>'


def render(records: list[dict[str, Any]]) -> str:
    records = sorted(records, key=lambda r: (STATUS_ORDER.get(r["status"], 9), r["case_id"]))
    counts = {s: sum(r["status"] == s for r in records) for s in STATUS_ORDER}
    summary = "".join(f'<span class="{s}">{n} {s}</span>' for s, n in counts.items() if n)
    return (
        "<!doctype html><html><head><meta charset=utf-8>"
        "<title>Converter: expected vs actual</title>"
        f"<style>{CSS}</style></head><body>"
        "<h1>Converter: expected vs actual (request cases)</h1>"
        f'<div class="summary">{summary}'
        '<label><input type="checkbox" id="hide-passed"> hide passed</label></div>'
        + "".join(_entry(r) for r in records)
        + f"<script>{SCRIPT}</script></body></html>\n"
    )
