// Two levels of words for every translated item (CONTRACT-003 §5.4 `explain`): a technical line for the terminal and a
// plain sentence for the web UI. Both are fixed templates over the catalog, so the same item always reads the same,
// in every view. Nothing here decides anything: it only phrases a status the translators already computed.
import type { Status } from "../ir/index.js";
import { ASSUMPTIONS } from "./assumptions.js";
import { resolveCode, rule } from "./index.js";

/**
 * One plain clause per assumption, written to finish "Same result as in Datadog, as long as …".
 * tests/rules/plain.test.ts requires an entry for every id in ASSUMPTIONS. Extra entries are allowed so assumptions
 * arriving in open PRs (#21, #26) already have their wording when those PRs merge.
 */
export const PLAIN_ASSUMPTIONS: Record<string, string> = {
  "A.align": "both tools cut time into the same buckets",
  "A.boundary": "no data point lands exactly on the edge of a time bucket",
  "A.kind-gauge": "the metric is a plain measurement (we found no table entry to confirm its type)",
  "A.monitor-rollup-60s": "Datadog checks the monitor on one-minute buckets",
  "A.nonzero-denominator": "the value you divide by is never zero",
  "A.var-default": "the dashboard filter is left on 'all'",
  "A.var-regex": "the dashboard filter only contains plain values",
  "A.tag-default": "the Datadog tag has the same name in OpenTelemetry (dots become underscores)",
  "A.query-threshold": "the threshold in the monitor's query is the one that counts",
  "A.dd-per-unit": "Datadog computes per-second values from consecutive points of a growing total (documented, not yet checked)",
  "A.no-reset": "the counter does not restart from zero inside the time window (how Datadog treats a restart is not yet checked)",
  "A.regular-sampling": "the data points arrive at an even interval that divides the chart's time step",
  "A.no-gaps": "every time bucket has data",
  "A.kind-metadata": "the metric type Datadog's integration declares is correct",
  "A.otel-counter": "the OpenTelemetry metric with this name is a growing counter",
  "A.top-stable": "the ranking of the series stays the same over the time range",
  "A.static-tags": "each series keeps its tags for the whole time range",
  "A.dd-count-default": "Datadog shows this count per interval by default (documented, not yet checked)",
  "A.kind-suffix": "a metric whose name ends in .count or .total is a growing count",
  "A.mono-diff": "Datadog drops the drops caused by counter resets",
  "A.same-key-and": "Datadog applies a fixed filter and a dashboard filter on the same tag together",
  "A.at-range": "the dashboard's time range decides which series get filled with zero",
  "A.monotonic": "the measurement only grows between resets",
  "A.sumby-together": "the per-database (or per-label) parts that get added up are collected at the same moments",
  "A.histogram-buckets": "Dash0 lets the percentile read the histogram's buckets under its OpenTelemetry name (not yet checked on a live histogram)",
  "A.histogram-samples": "Datadog's distribution and the OpenTelemetry histogram record the same values",
  "A.finite-quantile": "the percentile is below the histogram's largest bucket boundary",
  "A.both-present": "both values exist at the same moment",
  "A.log-count": "Dash0 receives the same log records Datadog indexed",
  "A.log-source": "the log shipper sets the Datadog 'source' as an attribute",
  "A.log-attr-default": "the log attribute keeps its name in OpenTelemetry",
  "A.log-fulltext": "Datadog's free-text search matches words regardless of case",
  "A.group-limit": "the number of groups stays within the widget's limit",
  "A.severity-map": "the Datadog log status maps to the OpenTelemetry severity listed in our table",
  "A.all-indexes": "all Datadog log indexes are included",
  "A.log-range": "the panel shows the total over the dashboard's whole time range",
  "A.logtable-keys": "Dash0's log table uses the same field names as its log metrics",
  "A.logtable-negation": "records filtered out by a 'not' condition carry that field",
  "A.numeric-attr": "the attribute holds numbers",
  "A.same-samples": "both tools receive the same data points",
  "A.full-window": "every series has data for the whole monitor window",
  "A.no-new-groups": "no new host or group appears during Datadog's grace period",
  "A.eval-1m": "Datadog checks the monitor once a minute",
  "A.notify-manual": "notifications are set up again by hand in Dash0",
  "A.label-rename": "nothing relies on the tag's old spelling",
  "A.msg-conditional": "readers can tell critical from warning by the alert's threshold",
  "A.msg-recovery": "text meant only for recovery notifications isn't needed",
  "A.no-data-manual": "the 'no data' alert is set up again by hand",
  "A.notify-wider": "the channel may also get notifications Datadog didn't send it",
  "A.msg-length": "the shortened alert text is enough (the full text stays in the report)",
  "A.msg-verbatim": "an unknown template token may appear as plain text",
  "A.style": "colours, fonts and exact positions don't change the meaning",
  "A.row-height": "a Dash0 grid row is as tall as a Datadog grid row",
  "A.var-values": "the filter's values are the same in Dash0 as in Datadog",
  "A.table-single-query": "the table has a single query and default sorting",
  "A.alt-view": "the numbers per group are what matters, not how they are drawn",
  "A.table-columns": "all columns of the table are grouped the same way and default sorting is fine",
  "A.top-uniform": "all ranked series have data at the same moments and no two tie",
  "A.top-unlimited": "showing all series, unranked, is acceptable for now",
  "A.agg-default": "the panel uses Datadog's default average",
  "A.stat-first": "only the panel's first query matters",
};

export type ExplainStatus = Status | "unsupported";

export interface ExplainInput {
  status: ExplainStatus;
  /** Catalog rule ids applied, in order. */
  rules: string[];
  /** Assumption ids behind an exact-under (or bounded) status. */
  assumptions: string[];
  epsilon?: string[];
  /** For manual items: the finding codes that made it manual (first one explains it). */
  reasons?: string[];
}

const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const clauses = (ids: string[]) => [...new Set(ids)].map((a) => PLAIN_ASSUMPTIONS[a] ?? ASSUMPTIONS[a as keyof typeof ASSUMPTIONS] ?? a);

/** The rule's own reason with the "no output:" prefix removed, as a sentence. */
function manualReason(code: string | undefined): string {
  const r = code ? resolveCode(code) : undefined;
  if (!r) return "no translation rule covers it.";
  const text = r.emit.replace(/^no output[;:]?\s*/i, "").trim();
  return text ? `${text}${/[.!?]$/.test(text) ? "" : "."}` : `${r.match}: no translation rule.`;
}

export function explainPlain(x: ExplainInput): string {
  switch (x.status) {
    case "exact":
      return "Same result as in Datadog.";
    case "exact-under":
      return `Same result as in Datadog, as long as ${join(clauses(x.assumptions))}.`;
    case "bounded": {
      const base = "Close to Datadog's result: small differences are possible at the edges of each time window, within a stated bound.";
      return x.assumptions.length ? `${base} It also assumes ${join(clauses(x.assumptions))}.` : base;
    }
    case "manual":
      return `Not migrated automatically: ${manualReason(x.reasons?.[0])} The original is kept so a person can rebuild it.`;
    case "unsupported":
      return "Dash0 has no panel for this kind of widget; a placeholder keeps the original.";
  }
}

export function explainTechnical(x: ExplainInput): string {
  const rules = x.rules.filter((id) => resolveCode(id) !== undefined);
  const claim =
    x.status === "exact-under"
      ? `exact-under(${[...new Set(x.assumptions)].join(", ")})`
      : x.status === "bounded"
        ? `bounded(ε: ${(x.epsilon ?? []).length ? (x.epsilon ?? []).map((e) => e.split(" (")[0]).join("; ") : "see rule"})`
        : x.status;
  const why = x.status === "manual" && x.reasons?.length ? ` [${x.reasons.join(", ")}]` : "";
  return `${rules.length ? rules.join(" + ") : "(no rules)"}: ${claim}${why}`;
}

/** Both levels at once. */
export function explain(x: ExplainInput): { technical: string; plain: string } {
  return { technical: explainTechnical(x), plain: explainPlain(x) };
}

/** Exported for tests: a rule's plain manual reason. */
export const _manualReason = (id: string) => manualReason(rule(id).id);
