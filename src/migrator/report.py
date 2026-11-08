"""report.json, manifest.json and the terminal summary."""

from __future__ import annotations

from typing import Any, Literal

from migrator.target import ItemResult, Outcome

OUTCOMES: tuple[Outcome, ...] = (
    "translated", "approximated", "assumed", "best_effort", "partial", "blocked"
)
# Converted outcomes: eligible to publish without a flag. The remark categories (approximated,
# assumed) are published as their own groups and carry their tags (docs/REMARKS.md).
CONVERTED: tuple[Outcome, ...] = ("translated", "approximated", "assumed", "best_effort")
ManifestKind = Literal["dashboard", "prometheus-rule", "check-rule", "source"]


def _counts() -> dict[str, int]:
    return {o: 0 for o in OUTCOMES}


def summarize(items: list[ItemResult], skipped_files: int) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "dashboards": _counts(),
        "widgets": _counts(),
        "monitors": _counts(),
        "skippedFiles": skipped_files,
    }
    for item in items:
        summary[f"{item.kind}s"][item.outcome] += 1
    return summary


def exit_code_for(items: list[ItemResult], skipped_files: int = 0) -> Literal[0, 2]:
    return 2 if skipped_files or any(i.outcome != "translated" for i in items) else 0


def manifest_entry(
    path: str,
    kind: ManifestKind,
    source_id: str,
    digest: str,
    outcome: Outcome | None,
    remarks: tuple[str, ...] = (),
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "path": path,
        "kind": kind,
        "sourceId": source_id,
        "sha256": digest,
        "outcome": outcome,
        "eligible": outcome in CONVERTED,
    }
    if remarks:
        entry["remarks"] = list(remarks)
    return entry


def format_summary(report: dict[str, Any], slugs: dict[str, str]) -> str:
    """Dashboards and monitors grouped and aligned, then a totals table."""
    items = report["items"]
    dashboards: list[tuple[str, str, str]] = []
    monitors: list[tuple[str, str, str]] = []
    for item in items:
        outcome = item["outcome"].upper()
        if item["kind"] == "dashboard":
            widgets = [
                w for w in items if w["kind"] == "widget" and w["sourceId"] == item["sourceId"]
            ]
            done = sum(1 for w in widgets if w["outcome"] in CONVERTED)
            detail = f"{done}/{len(widgets)} widgets"
            for category in CONVERTED[1:]:
                n = sum(1 for w in widgets if w["outcome"] == category)
                if n:
                    detail += f", {n} {category}"
            if item.get("remarks"):
                detail += f" [{' '.join(item['remarks'])}]"
            name = slugs.get(item["sourceId"], item["sourceId"])
            dashboards.append((outcome, name, detail))
        elif item["kind"] == "monitor":
            tags = f"[{' '.join(item['remarks'])}]" if item.get("remarks") else ""
            monitors.append((outcome, item["sourceId"], tags))

    lines: list[str] = []
    for title, section in (("Dashboards", dashboards), ("Monitors", monitors)):
        if not section:
            continue
        name_w = max(len(name) for _, name, _ in section)
        lines.append(title)
        for outcome, name, detail in section:
            lines.append(f"  {outcome:<12}  {name:<{name_w}}  {detail}".rstrip())
        lines.append("")

    s = report["summary"]
    header = "".join(f"{o:>14}" for o in OUTCOMES)
    lines.append(f"{'Totals':<12}{header}")
    for kind in ("dashboards", "widgets", "monitors"):
        lines.append(f"  {kind:<10}" + "".join(f"{s[kind][o]:>14}" for o in OUTCOMES))
    lines.append(f"  skipped files: {s['skippedFiles']}")
    skipped = [d for d in report.get("diagnostics", []) if d["code"] == "UNSUPPORTED_ASSET_KIND"]
    if skipped:
        lines.extend(["", "Skipped inputs"])
        for diagnostic in skipped:
            lines.append(
                f"  {diagnostic['code']}: {diagnostic['sourceId']}: {diagnostic['message']}"
            )
    coverage = report.get("mappingCoverage")
    if coverage is not None:
        metrics = coverage["metrics"]
        mapped = sum(metric["mapped"] for metric in metrics)
        unparsed = coverage["unparsedQueries"]
        lines.extend([
            "",
            "Mapping coverage (metric names only; translation may still be blocked)",
            f"  {mapped}/{len(metrics)} parsed metric names mapped; "
            f"{coverage['parsedQueries']} parsed queries; {len(unparsed)} unparsed queries",
        ])
        for metric in metrics:
            if not metric["mapped"]:
                lines.append(f"  MISSING_METRIC_MAPPING: {metric['metric']}")
                for location in metric["locations"]:
                    lines.append(f"    {location['sourceId']}:{location['sourcePath']}")
        for diagnostic in unparsed:
            lines.append(
                f"  UNPARSED {diagnostic['sourceId']}:{diagnostic['sourcePath']}: "
                f"{diagnostic['code']}: {diagnostic['message']}"
            )
    return "\n".join(lines)
