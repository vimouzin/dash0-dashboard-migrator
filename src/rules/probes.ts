// Capability probes: facts about Dash0 or Datadog that a rule depends on and that nobody has confirmed yet.
// A rule that `requires` an open probe stays planned. When a probe is answered, record it here with the evidence.

export interface Probe {
  question: string;
  how: string;
  answer: "open" | "yes" | "no";
}

export const PROBES = {
  "probe:anchored": {
    question: "Does Dash0 accept increase(x[1m] anchored)?",
    how: "LIVE 2026-11-08 (Ali, org thinc_bavarian_big_ben, query API): increase(x[5m] anchored) and rate(x[W] anchored) are accepted and APPLIED (values differ from the plain form and move in whole scrape-sized steps; a made-up modifier is a parse error). rate anchored = increase anchored / W exactly (ratio 60.00 at every point for W = 60 s). A window with no new sample gives no point, not 0. The reference evaluator (src/semantics anchoredIncrease) equals Dash0 exactly on a live Redis counter: 0 difference over 36 points (W = 60 s and 300 s). Dashboards only: a check rule with anchored has not been probed.",
    answer: "yes",
  },
  "probe:at-modifier": {
    question: "Does Dash0 accept the @ end() modifier in queries?",
    how: "LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben): @ end() accepted by the query API; 935/935 queries with the new constructs accepted (hub #278). That test did NOT show that a dashboard substitutes $__range: see probe:range-var.",
    answer: "yes",
  },
  "probe:range-var": {
    question: "Does a Dash0 dashboard substitute $__range with its visible time range in panel queries (and a stat panel with calculation last-number show the value at the end of that range)?",
    how: "LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben), visual check on a throwaway dashboard (the query API does not substitute variables, so only a rendered panel can answer): a StatChart (calculation last-number) over sum(increase({otel_metric_name=\"dash0.logs\", service_name=\"frontend\"}[$__range])) equalled the same query over a fixed [5m] with the picker at 5m (about 3k) and over a fixed [1h] with the picker at 1h (about 32k). 15m was not read. Import also accepted calculation last-number, and it rendered the last value. TimeSeriesTable (spec {}, what T5 emits for top lists and tables), same org, 1h picker, read by Ali: the panel `time() - E` showed 212 = seconds since E at the moment the page was loaded, i.e. the table shows the LAST point of the range, not the first or the mean; and sum by (service_name) (increase({otel_metric_name=\"dash0.logs\"}[$__range])) equalled the fixed-[1h] control to the digit (frontend-proxy 57.013K, frontend 31.783K, product-catalog 20.981K, checkout 8.174K) and differed from the fixed-[5m] control. The table was read at 1h only.",
    answer: "yes",
  },
  "probe:lt-threshold": {
    question: "How does Dash0 compare $__threshold for `<` expressions (is higher always worse)?",
    how: "maths.md §11 probe 5, T0 check-rule export",
    answer: "open",
  },
  "probe:threshold-label": {
    question: "Does Dash0 expose which threshold fired (failed / degraded) as a label usable in annotation templates?",
    how: "T0: fire a test rule and read its notification payload",
    answer: "open",
  },
  "probe:statchart-calculation": {
    question: "Which StatChart `calculation` names does Dash0 accept (mean, max, min, sum, last)?",
    how: "T0: export a StatChart with each calculation",
    answer: "open",
  },
  "probe:listvariable": {
    question: "Does Dash0 import accept Perses ListVariable + PrometheusLabelValuesVariable, or only Dash0FilterVariable?",
    how: "plan 00 open question; T7 dry-run import of a dashboard with one ListVariable",
    answer: "open",
  },
  "probe:row-height": {
    question: "Is one Dash0 grid row as tall as one Datadog grid row?",
    how: "T0: compare a golden export with the Datadog source",
    answer: "open",
  },
  "probe:collapse": {
    question: "Does Dash0 honour Grid display.collapse.open for titled sections?",
    how: "T0: export a dashboard with one collapsed group",
    answer: "open",
  },
  "probe:piechart": {
    question: "Does Dash0 render a Perses PieChart from a PromQL query with a grouping?",
    how: "LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben), read on a rendered throwaway dashboard at the 1h picker: a PieChart over sum by (service_name) (increase({otel_metric_name=\"dash0.logs\"}[$__range])) renders one slice per service (import accepted calculation last-number and mode value). Two pies with the same query, one with calculation last-number and one with spec {}, were proportionally identical but had DIFFERENT absolute values, so the default calculation is not last-number: always set it. Not checked: that the last-number pie's absolute values equal the fixed-window control to the digit (the table in the same probe did).",
    answer: "yes",
  },
  "probe:log-increase-exact": {
    question: "Is increase({otel_metric_name=\"dash0.logs\", ...}[w]) the exact number of log records whose timestamp is in the window?",
    how: "LIVE 2026-11-08 (Ali, org thinc_bavarian_big_ben): logs sent over OTLP with controlled timestamps (never on a boundary) and known counts. 60 s windows: 18 of 18 minutes exact incl. empty ones (375 logs); 60 s windows by severity, bursts up to 600 per minute: 40 of 40 (group, minute) cells exact, no value in an empty cell (5,660 logs); 300 s windows 4 of 4; the whole 1200 s range at its end 5,660 of 5,660; cardinality count(sum by (attr)(increase) > 0) 15 of 15 minutes. Plain and anchored give the same values. It is not a sampled cumulative counter.",
    answer: "yes",
  },
  "probe:log-labels": {
    question: "What are the label names for severity and body on {otel_metric_name=\"dash0.logs\"}?",
    how: "LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben): severity otel_log_severity_range / otel_log_severity_text, body otel_log_body (unanchored regex), attributes with dots as underscores; docs/research/dash0.md \"dash0.logs labels\", dash0-team 71e47aa",
    answer: "yes",
  },
  "probe:dd-formula-join": {
    question: "In a Datadog formula over queries with different groupings, do unmatched groups drop?",
    how: "maths.md §11 probe 3",
    answer: "open",
  },
} as const satisfies Record<string, Probe>;

export type ProbeId = keyof typeof PROBES;
