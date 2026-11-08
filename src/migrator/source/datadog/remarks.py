"""Remark tags: the approved reasons an item may convert although it is not an exact translation.

Converted-with-remarks categories (docs/REMARKS.md):

- ``approximated``: the conversion is exact except for one documented, minor behaviour the
  target lacks (a widget's own time range, a monitor's grace period).
- ``assumed``: the exact Datadog metric has no OTel counterpart, but the value is rebuilt
  deterministically from OTel data under a stated, high-confidence assumption (an aggregation
  over attributes, a derived expression). Mapping entries reference these tags in ``assumption``.
- ``best_effort``: a documented query function is implemented with deterministic sample/window
  approximations. Live measurements apply to tested workloads, not every possible input.

Every tag needs manual approval. A tag whose ``approved`` is None keeps blocking, exactly as
without it. Only a human reviewer sets ``approved``, in the PR that adds or changes the tag;
agents leave it None. Converted items carry their tags into the report, the manifest and the
emitted artifacts (panel and dashboard descriptions, check-rule labels).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Category = Literal["approximated", "assumed", "best_effort"]


@dataclass(frozen=True)
class Approval:
    by: str
    date: str  # YYYY-MM-DD


@dataclass(frozen=True)
class Remark:
    category: Category
    summary: str  # what differs from the source, shown with the tag
    evidence: str  # documentation that bounds the difference
    approved: Approval | None


_PERSES_DASHBOARD = "https://perses.dev/docs/perses/latest/api/dashboard/"
_DASH0_PANELS = "https://www.dash0.com/docs/dash0/dashboards/configure-panels"
_DD_MONITOR_OPTIONS = "https://docs.datadoghq.com/monitors/configuration/"
# Decision A3 (docs/handoff/00-context.md §3): approximate and warn on a reviewed allowlist.
# These monitor options were approximated under A3 before remark tags existed (plan 06).
_A3 = Approval("Felix (A3 allowlist, docs/handoff/00-context.md §3)", "2026-11-08")
_FELIX = Approval("Felix", "2026-11-08")
# Current-session instruction explicitly requests weighted/custom-PromQL and other useful
# deterministic approximations, tagged best_effort and checked empirically case by case.
_FUNCTIONS = Approval("Felix (explicit best-effort function request, #163/#164)", "2026-11-08")
_ASCOUNT = Approval("Felix (explicit best-effort .as_count() request, #181)", "2026-11-08")
_PROMLABEL = Approval("Felix (explicit Prometheus label mapping request, #185)", "2026-11-08")
_OTELTABLE = Approval("Felix (explicit full OTel mapping table request, #188)", "2026-11-08")

REMARKS: dict[str, Remark] = {
    "WEIGHTED": Remark(
        category="best_effort",
        summary=(
            "Weighted sum uses raw sample sums normalized by the fullest selected series in "
            "the rate window. Datadog's submission cadence and graph buckets are unavailable; "
            "unequal cadence, sparse series and resource churn can change the result."
        ),
        evidence="https://docs.datadoghq.com/dashboards/guide/how-weighted-works/",
        approved=_FUNCTIONS,
    ),
    "ROLLUP": Remark(
        category="best_effort",
        summary=(
            "Rollup uses a trailing PromQL sample window before space aggregation, instead of "
            "Datadog's UNIX-aligned graph buckets. An omitted interval follows the target rate "
            "window. Boundary values and sparse-series weights can differ."
        ),
        evidence="https://docs.datadoghq.com/dashboards/functions/rollup/",
        approved=_FUNCTIONS,
    ),
    "ASRATE": Remark(
        category="best_effort",
        summary=(
            "Rate uses the mapped cumulative counter and PromQL rate window. Datadog's "
            "interpolation, source type metadata and rollup buckets can differ from PromQL's "
            "counter-reset and extrapolation behavior."
        ),
        evidence="https://docs.datadoghq.com/metrics/custom_metrics/type_modifiers/",
        approved=_FUNCTIONS,
    ),
    "ASCOUNT": Remark(
        category="best_effort",
        summary=(
            "Count per interval uses PromQL increase() of the mapped cumulative counter over "
            "the panel step ($__interval). Datadog counts per UNIX-aligned rollup bucket; "
            "bucket width, alignment, counter extrapolation and resets can differ."
        ),
        evidence="https://docs.datadoghq.com/metrics/custom_metrics/type_modifiers/",
        approved=_ASCOUNT,
    ),
    # --- approximated -------------------------------------------------------------------
    # Datadog widget `time: {"live_span": X}` pins the widget to its own time frame. Neither
    # Perses nor Dash0 has a per-panel time range: Perses has only the dashboard `duration`,
    # "the default time range to use on the initial load of the dashboard", and a Panel has
    # display, plugin, queries and links (_PERSES_DASHBOARD); Dash0's panel settings are
    # "Name, Description, Group, Hide Header, Header Color" (_DASH0_PANELS).
    # Felix extended this approved lost-window approximation to reducing panels in #158.
    "TIMEPIN": Remark(
        category="approximated",
        summary=(
            "Datadog pinned this widget to its own time frame; Perses and Dash0 panels have no "
            "per-panel time range, so it follows the dashboard time picker. Values reduced over "
            "that range, including query values and rankings, can change."
        ),
        evidence=f"{_PERSES_DASHBOARD} {_DASH0_PANELS}",
        approved=_FELIX,
    ),
    "FULLWINDOW": Remark(
        category="approximated",
        summary=(
            "Datadog waits for a full evaluation window (require_full_window); Dash0 evaluates "
            "partial windows, so a new series can alert early."
        ),
        evidence=_DD_MONITOR_OPTIONS,
        approved=_A3,
    ),
    "NEWHOST": Remark(
        category="approximated",
        summary=(
            "Datadog skips new hosts for a grace period (new_host_delay); Dash0 has none, so a "
            "new host can alert right after it starts reporting."
        ),
        evidence=_DD_MONITOR_OPTIONS,
        approved=_A3,
    ),
    # --- assumed ------------------------------------------------------------------------
    "AGG": Remark(
        category="assumed",
        summary=(
            "No OTel metric carries the Datadog value directly; it is rebuilt by aggregating OTel "
            "series over an attribute (for example summing states)."
        ),
        evidence="see the mapping entry's ref",
        approved=None,
    ),
    "DERIVED": Remark(
        category="assumed",
        summary=(
            "No OTel metric carries the Datadog value directly; it is computed from other OTel "
            "metrics with an expression."
        ),
        evidence="see the mapping entry's ref",
        approved=_FELIX,
    ),
    # Datadog toplist: one value per series (the query's time aggregator over the window), then
    # the top or bottom N by `limit` {count, order}. Perses BarChart reduces each series with
    # `calculation` and orders by `sort`, but has no count field (spec fields: calculation,
    # format, sort, mode, orientation, groupBy, isStacked, visual; perses/plugins@57910ac
    # barchart/schemas/bar.cue). Placed in `assumed` by Felix's decision (2026-11-08): the
    # displayed set is wider than the source.
    "TOPN": Remark(
        category="assumed",
        summary=(
            "Datadog showed only the top (or bottom) N series; the Perses bar chart has no limit, "
            "so it shows every series in the same order. The first N bars match."
        ),
        evidence=(
            "https://docs.datadoghq.com/dashboards/widgets/top_list/ "
            "https://github.com/perses/plugins/blob/57910acf0bf979561e13c6c28ea487ce86b2433f/"
            "barchart/schemas/bar.cue"
        ),
        approved=_FELIX,
    ),
    "ATTRVAL": Remark(
        category="assumed",
        summary=(
            "The Datadog metric is one slice of an OTel metric, selected by an attribute value "
            "that the OTel definition does not enumerate."
        ),
        evidence="see the mapping entry's ref",
        approved=None,
    ),
    # OpenMetrics checks (#185): Datadog scrapes a Prometheus endpoint and tags each sample
    # with its labels (renamed by the check's rename_labels). Collected with the OTel
    # Prometheus receiver, Dash0 keeps the raw Prometheus name and labels; the scrape target
    # is `instance`, there is no `host_name` (checked live in Dash0, issue #185).
    "PROMLABEL": Remark(
        category="assumed",
        summary=(
            "The Datadog metric is assumed to be the Prometheus series its OpenMetrics check "
            "scrapes, collected by the OTel Prometheus receiver under the name and labels seen "
            "in the check's test exposition. Datadog tags are those labels (after the check's "
            "rename_labels); host is the scrape target instance."
        ),
        evidence=(
            "https://docs.datadoghq.com/developers/custom_checks/prometheus/ "
            "https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/"
            "receiver/prometheusreceiver"
        ),
        approved=_PROMLABEL,
    ),
    # Datadog's OpenTelemetry metrics mapping table names the OTel counterpart, but a fact the
    # converter needs is not confirmed by the pinned OTel catalog or Datadog metadata (#188).
    "OTELTABLE": Remark(
        category="assumed",
        summary=(
            "The OTel metric is the counterpart named in Datadog's OpenTelemetry mapping table, "
            "but the pinned OTel and Datadog metadata do not confirm every fact: the target "
            "type, the unit scale, an attribute rename, or the choice among several table "
            "targets. The mapping entry's ref names the unconfirmed fact."
        ),
        evidence="https://docs.datadoghq.com/opentelemetry/mapping/metrics_mapping/",
        approved=_OTELTABLE,
    ),
    "SEMANTIC": Remark(
        category="assumed",
        summary=(
            "The Datadog and OTel metrics measure the same thing, but their documented "
            "definitions differ in scope; the value is close, not identical."
        ),
        evidence="see the mapping entry's ref",
        approved=_FELIX,
    ),
}


def approved(tag: str) -> Remark | None:
    """The remark if it is listed and approved, else None (the item keeps blocking)."""
    entry = REMARKS.get(tag)
    return entry if entry is not None and entry.approved is not None else None


def describe(tags: list[str]) -> str:
    """Panel or check-rule text for the tags: `[TAG] summary` per tag, in the given order."""
    return " ".join(f"[{tag}] {REMARKS[tag].summary}" for tag in tags)
