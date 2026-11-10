// The order every item goes through. A dashboard query walks ingest → … → arith → widget → … → emit;
// a monitor walks ingest → classify → parse → … → monitor → alert → message → validate → canonical → emit.
import type { StageDef } from "./types.js";

export const STAGES: readonly StageDef[] = [
  { id: "ingest", title: "Ingest and normalise", unit: "source item", total: false, summary: "Read the source JSON, unwrap containers, coerce types, keep the raw original." },
  { id: "classify", title: "Classify the item", unit: "monitor", total: true, summary: "Decide which pipeline a monitor goes through; anything unknown stops here as manual." },
  { id: "parse", title: "Parse", unit: "query string", total: true, summary: "Datadog query / formula / monitor strings → AST (T3). Unparseable text is manual with the original kept." },
  { id: "select", title: "Select the metric", unit: "metric reference", total: true, summary: "Datadog metric → OTel metric through the mapping table." },
  { id: "scope", title: "Scope filters", unit: "filter term", total: false, summary: "Datadog tag filters → PromQL label matchers. The parser's grammar enumerates the forms." },
  { id: "kind", title: "Metric-kind check", unit: "metric reference", total: false, summary: "Plan 03 §3: the source kind decides which time aggregation is legal." },
  { id: "time", title: "Time aggregation", unit: "postfix or rollup call", total: false, summary: "Rollups, .as_count(), .as_rate(), fill(). Datadog aggregates time first." },
  { id: "space", title: "Space aggregation", unit: "aggregation", total: false, summary: "avg/sum/min/max/count by {tags}, applied after time aggregation." },
  { id: "function", title: "Functions", unit: "function call", total: true, summary: "Pointwise and window functions. Every Datadog function is listed; unknown ones are manual." },
  { id: "arith", title: "Arithmetic and formulas", unit: "binary or unary operation", total: false, summary: "Formulas over named queries, constants, division." },
  { id: "monitor", title: "Monitor query", unit: "monitor query part (window, time aggregation, comparator)", total: true, summary: "The monitor's window, time aggregation and comparator around the translated inner query." },
  { id: "alert", title: "Check-rule assembly", unit: "monitor field or option", total: true, summary: "Thresholds, ids, labels and every monitor option. Each option is a rule; none is dropped." },
  { id: "message", title: "Message → annotations", unit: "template token", total: true, summary: "Deterministic Mustache token rewrite into Go-template annotations." },
  { id: "widget", title: "Widget → panel", unit: "widget", total: true, summary: "One mapper per Datadog widget type; anything else becomes a Markdown placeholder with the original." },
  { id: "panel", title: "Panel options", unit: "panel attribute", total: false, summary: "Units, markers and visual options on a panel a widget rule produced." },
  { id: "layout", title: "Layout and groups", unit: "widget position or group", total: false, summary: "12-column Datadog grid → 24-column Perses grid; groups → titled sections." },
  { id: "variable", title: "Template variables", unit: "template variable", total: true, summary: "Datadog template variables → Perses / Dash0 variables or pinned defaults." },
  { id: "logs", title: "Log queries", unit: "log query or search term", total: true, summary: "Datadog log search and log widgets/monitors → dash0.logs counts (plan 01 §1)." },
  { id: "validate", title: "Validate", unit: "emitted artefact", total: false, summary: "Every output parses and passes preflight before it may be emitted." },
  { id: "canonical", title: "Canonical form and hash", unit: "emitted artefact", total: false, summary: "One spelling per meaning, so the output hash is a function of the input only." },
  { id: "emit", title: "Import and report", unit: "emitted artefact or run", total: false, summary: "Idempotent single-item import, read-back, and a certificate for every source item." },
];
