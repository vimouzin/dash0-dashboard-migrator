// Stages around the translation: ingest, logs, validate, canonical, emit.
import type { RuleDef } from "../types.js";
import { EPS_RATE, section } from "./build.js";

const ingest = section("ingest", "T2", "planned", "plan 00; dash0-migrator skill (key facts)");
const ingestImpl = section("ingest", "T2", "implemented", "T2 src/sources/datadog (PR #7, merged)");
const logs = section("logs", "T12", "planned", "plan 01 §1; maths.md §8");
const log = section("logs", "T12", "implemented", "T12 src/translate/logs (PR #13); docs/research/dash0.md (dash0.logs labels, LIVE)");
const validate = section("validate", "T4", "implemented", "dash0-migrator rule 3");
const preflight = section("validate", "T7", "implemented", "T7 PR #5");
const canon = section("canonical", "T13", "planned", "plan 02 rule 5; plan 03 §5");
const emitT7 = section("emit", "T7", "implemented", "T7 PR #5; D-30, D-31");
const emitT8 = section("emit", "T8", "planned", "plan 04 §3; plan 03 §5");

/** T12's LOG_RULES ids, in T12's order. */
export const T12_TABLE_IDS = [
  "log.count",
  "log.cardinality",
  "log.match.reserved",
  "log.match.reserved.approx",
  "log.match.attr",
  "log.match.value",
  "log.match.status",
  "log.match.status.approx",
  "log.match.text",
  "log.match.var",
  "log.match.var.dropped",
  "log.group_by",
  "log.group_by.limit",
  "log.group_by.multi-limit",
  "log.group_by.exclude-missing",
  "log.range.integer",
  "log.or.inclusion-exclusion",
  "log.monitor.formula",
  "log.indexes",
  "log.monitor.count",
  "log.scalar.window",
] as const;

export const PIPELINE_RULES: RuleDef[] = [
  // ---------- ingest ----------
  ingest("ingest.monitor.unwrap", 10, "exact", "integrations-core monitor file {version, definition: {...}}", "the definition object"),
  ingest("ingest.numbers", 20, "exact", 'numbers stored as strings ("90", "0")', "numbers"),
  ingestImpl("source.unreadable", 40, "manual", "a source file that can't be read or parsed (broken JSON/YAML, empty file, several YAML documents)", "nothing from that file is migrated; the file and the parser's message are reported"),
  ingest("ingest.keep-raw", 30, "exact", "every source item", "raw JSON kept next to its IR node (rule 4), sha256 → certificate.sourceHash"),

  // ---------- logs ----------
  // Implemented by T12 (PR #13): mirrors LOG_RULES in src/translate/logs id for id (tests/rules/conformance.test.ts).
  log("log.count", 10, "exact-under", "log query, compute count, search Q, group_by g", 'sum by (g) (increase({otel_metric_name="dash0.logs", m(Q)}[w]))', {
    assumptions: ["A.log-count", "A.align", "A.boundary"],
    requires: ["probe:log-labels", "probe:log-increase-exact"],
    evidence: ["unit", "live:dash0-4110", "live:log-increase-exact"],
    note: "Dash0's increase(dash0.logs[w]) is the exact number of records in the window (live, maths.md §4a-logs), not an extrapolated counter: no rate error term. Monitors (log.monitor.*) stay bounded: a check rule has not been probed.",
  }),
  log("log.cardinality", 20, "exact-under", "cardinality of @a", "count by (g) (sum by (g, a) (increase(...[w])) > 0)", { assumptions: ["A.log-count", "A.align", "A.boundary"], requires: ["probe:log-labels", "probe:log-increase-exact"], evidence: ["unit", "live:dash0-4110", "live:log-increase-exact"] }),
  log("log.match.reserved", 30, "exact", "service / host / env / version:x", "the resource label (service_name, ...)", { requires: ["probe:log-labels"] }),
  log("log.match.reserved.approx", 40, "exact-under", "source:x", 'source="x" (no OTel counterpart)', { assumptions: ["A.log-source"] }),
  log("log.match.attr", 50, "exact-under", "@a.b:x", 'a_b="x" (renames from mappings/log-attributes.yaml applied)', { assumptions: ["A.log-attr-default"], requires: ["probe:log-labels"] }),
  log("log.match.value", 60, "exact", "k:v, k:v*, k:(a OR b), k:*, and their negations", '=, =~"^v.*$", =~"^(a|b)$", =~".+", != / !~'),
  log("log.match.status", 70, "exact", "status:error", 'otel_log_severity_range="ERROR"', { requires: ["probe:log-labels"] }),
  log("log.match.status.approx", 80, "exact-under", "status:critical / notice / ok / ...", "the nearest OTel severity range", { assumptions: ["A.severity-map"], requires: ["probe:log-labels"] }),
  log("log.match.text", 90, "exact-under", "free text w", 'otel_log_body=~"(?i).*w.*"', { assumptions: ["A.log-fulltext"], requires: ["probe:log-labels"] }),
  log("log.match.var", 100, "exact-under", "$var on a facet", 'label=~"^($var)$"', { assumptions: ["A.var-regex"] }),
  log("log.match.var.dropped", 110, "exact-under", "$var without a facet", "dropped while it is '*'", { assumptions: ["A.var-default"] }),
  log("log.group_by", 120, "exact", "group_by facets", "by (labels)"),
  log("log.group_by.limit", 130, "exact-under", "one facet with a limit N", "topk(N, ...) (bottomk for asc)", { assumptions: ["A.top-stable"] }),
  log("log.group_by.multi-limit", 140, "exact-under", "several facets with limits", "by (labels), limits not applied", { assumptions: ["A.group-limit"] }),
  log("log.group_by.exclude-missing", 150, "exact", "should_exclude_missing: true", 'label!="" for each group-by label'),
  log("log.range.integer", 155, "exact", "@a:>=500 / @a:[200 TO 299] on integer attributes", "a=~ an exact regex over the decimal digits"),
  log("log.or.inclusion-exclusion", 157, "exact-under", "count(A OR B ...) across different keys (up to 3 branches)", "sum of counts by inclusion-exclusion", { assumptions: ["A.log-count", "A.align", "A.boundary"], requires: ["probe:log-increase-exact"], evidence: ["unit", "proof:log-or", "exhaustive:E5", "live:log-increase-exact"] }),
  log("log.indexes", 160, "exact-under", "indexes other than '*'", "all logs (Dash0 has no indexes)", { assumptions: ["A.all-indexes"] }),
  log("log.monitor.count", 170, "bounded", "logs(Q).rollup(count).by(g).last(W) op T", "sum by (g) (increase(...[W])) op $__threshold", { assumptions: ["A.log-count"], epsilon: EPS_RATE, requires: ["probe:log-labels"], evidence: ["unit", "proof:T3"] }),
  log("log.monitor.formula", 175, "bounded", 'formula("...").last(W) over log queries', "the formula over windowed counts", { assumptions: ["A.log-count"], epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  log("log.scalar.window", 180, "exact-under", "scalar log query: query_value, top list, table (Datadog aggregates over the whole timeframe)", "the same count over [$__range] (not one [$__interval] bucket); the panel shows the last value", {
    assumptions: ["A.log-count", "A.log-range"],
    requires: ["probe:range-var", "probe:log-increase-exact"],
    evidence: ["unit", "live:log-increase-exact"],
    note: "T5 must set the stat/top-list calculation to last-number for these queries. A formula that mixes a scalar log count with a per-interval value fails closed (finding log.scalar.mixed, rule arith.scalar-log-mixed). The whole-range total was exact live (5,660 of 5,660 records).",
  }),
  // Still planned: not in T12 yet.
  logs("logs.rate", 200, "bounded", "log count shown as a rate", 'sum by (<labels>) (rate({otel_metric_name="dash0.logs", …}[1m]))', { epsilon: EPS_RATE, requires: ["probe:log-labels"], evidence: ["proof:T3"] }),
  log("log.or.cross-key", 185, "manual", "OR across different keys (or with free text) beyond what inclusion-exclusion covers: more than 3 branches, or outside a count", "no output: not a matcher set"),
  log("log.measure", 190, "manual", "avg / sum / min / max / percentile of a log measure (@attr)", "no output: dash0.logs only counts log records", {
    note: "Ali is checking whether Dash0's signal-to-metrics can derive such a metric without guessing (hub #285).",
  }),
  log("log.status.unknown", 192, "manual", "status:<value> with no OTel severity range in mappings/log-attributes.yaml (or a wildcard status)", "no output: there is no severity range to match, so any guess would count different logs"),
  log("log.monitor.shape", 195, "manual", "log monitor or log formula monitor whose query shape has no rule", "no output; the original monitor query is kept"),
  logs("logs.stream", 230, "manual", "log_stream / list_stream widget", "placeholder until the LogTable schema comes from T0"),
  logs("logs.unparsed", 999, "manual", "log search the log-search parser does not accept", "no output; original kept", { fallback: true, findingCode: "query.parse_error" }),

  // ---------- validate ----------
  validate("validate.promql", 10, "exact", "every emitted PromQL string", "must parse with @prometheus-io/lezer-promql"),
  validate("promql.invalid", 20, "manual", "emitted PromQL that does not parse", "nothing emitted; error finding (never a broken query)"),
  preflight("validate.preflight", 30, "exact", "every DashboardDefinition / PrometheusAlertRule", "preflightDashboard / preflightCheckRule against Dash0's OpenAPI types"),

  // ---------- canonical ----------
  canon("canonical.matchers", 10, "exact", "label matchers", "sorted by label name, then operator"),
  canon("canonical.json", 20, "exact", "output JSON", "keys sorted, numbers in shortest round-trip form"),
  canon("canonical.hash", 30, "exact", "canonical output", "sha256 → certificate.outputHash; same input gives the same bytes (determinism test M2)"),

  // ---------- emit ----------
  emitT7("emit.id", 10, "exact", "every dashboard and check rule", 'id "dd-<source id>", so re-runs overwrite (idempotent)'),
  emitT7("emit.single-item", 20, "exact", "import", "one POST per item (/api/import/dashboard, /api/import/check-rule), never the all-or-nothing bulk call"),
  emitT7("emit.rules-disabled", 30, "exact", "imported check rules", "enabled: false unless --enable-rules (D-30)"),
  emitT7("emit.readback", 40, "exact", "after import", "GET by id and compare the normalised payload; mismatch is an error finding"),
  emitT8("emit.certificate", 50, "exact", "every source item", "one report.json entry with its certificate: hashes, rules, status, assumptions, ε, checks"),
  emitT8("emit.no-silent-drop", 60, "exact", "the whole run", "count(source items) = count(report items); otherwise the run fails"),
];
