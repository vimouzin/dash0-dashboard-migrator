// T4: Datadog query AST (src/parse) -> PromQL AST, rule by rule. Deterministic, no I/O.
// Fail closed (plan 02 §2 rule 2): a construct without a rule makes the whole query `manual`, with no PromQL.
import type { Expr, MetricQuery, MonitorQuery, ScopeExpr } from "../../parse/index.js";
import { validatePromQL } from "../../validate/promql.js";
import { mapSelectors, render, type Duration, type PMatcher, type PNode } from "./promql.js";
import { ASSUMPTIONS, RULES, type AssumptionId, type RuleId } from "./rules.js";
import { worst, type FormulaEnv, type Finding, type LoweredRef, type MetricMapping, type QueryTranslation, type Status, type TranslateContext } from "./types.js";

class Manual extends Error {}

const SPACE_AGGS = new Set(["avg", "sum", "min", "max", "count"]);
const ROLLUP_FNS = new Set(["avg", "sum", "min", "max", "count"]);
const TIMESHIFT_FNS: Record<string, number> = { hour_before: 3600, day_before: 86400, week_before: 604800 };
const UNARY_MAPS: Record<string, RuleId> = { abs: "map.abs", log2: "map.log2", log10: "map.log10" };

interface Lowered {
  node: PNode;
  /** Output labels after space aggregation (sorted), or null for a scalar/number. */
  groups: string[] | null;
  /**
   * The same query with its time aggregation replaced by rate() over the OTel counter. Only set for a sum/avg over a
   * Datadog gauge that holds a running total (ddKind gauge, OTel counter), which is what per_second() and friends need.
   */
  rateForm?: PNode;
  /** rateForm comes from a plain gauge (needs the A.monotonic assumption). */
  rateFormGauge?: boolean;
  /** The query already aggregates over the whole monitor window (sum(last_W) with .as_count()): no subquery. */
  windowed?: boolean;
}

/** top/bottom shortcuts: top10, bottom5_max, top_mean ... -> [k, N, method]. */
const TOP_SHORTCUT = /^(top|bottom)(\d+)?(?:_(mean|min|max|last|area|l2norm|norm))?$/;

const PER_UNIT: Record<string, number> = { per_second: 1, per_minute: 60, per_hour: 3600 };

/** Datadog percentile aggregator: p50, p95, p99.9 ... */
const PERCENTILE = /^p(\d+(?:\.\d+)?)$/;

class Lowerer {
  rules: RuleId[] = [];
  /** Merged from formula refs translated elsewhere (LoweredRef). */
  external: { status: Status; rules: string[]; assumptions: string[] }[] = [];
  extraAssumptions: AssumptionId[] = [];
  findings: Finding[] = [];

  /** Set by translateMonitor for sum(last_W): the window in seconds, so .as_count() can become increase(x[W]). */
  monitorSumWindow?: number;
  /** A metric was lowered as a window total (increase over W); see translateMonitor. */
  sawWindowed = false;
  /** Set by translateMonitor: the evaluation window W in seconds. */
  monitorWindow?: number;
  /**
   * A formula may not combine a scalar log query (one count over [$__range], T12 rule log.scalar.window) with a
   * per-bucket one (a metric, or a log time series): the two cover different windows, so the result would mean nothing.
   */
  sawScalarLog = false;
  sawPerBucket = false;
  private checkWindows(): void {
    if (this.sawScalarLog && this.sawPerBucket)
      this.manual("log.scalar.mixed", "a scalar log count (over the whole range) is combined with a per-interval value; the windows differ, so there is no faithful translation");
  }

  constructor(
    readonly ctx: TranslateContext,
    readonly interval: Duration,
    /** Inside a monitor's 1m-step subquery the rollup is aligned by construction. */
    readonly monitor: boolean,
  ) {}

  use(rule: RuleId): void {
    if (!this.rules.includes(rule)) this.rules.push(rule);
  }
  assume(a: AssumptionId): void {
    if (!this.extraAssumptions.includes(a)) this.extraAssumptions.push(a);
  }
  /** Record a CONTRACT-001 finding. Assumption ids are expanded to their checkable wording. */
  find(
    status: Finding["status"],
    code: string,
    message: string,
    opts: { ruleId?: RuleId; assumptions?: AssumptionId[]; original?: unknown } = {},
  ): void {
    // A formula can reference the same query twice (`query1 / (query1 + query2)`): report each finding once.
    if (this.findings.some((f) => f.code === code && f.message === message)) return;
    const original = opts.original === undefined ? undefined : typeof opts.original === "string" ? opts.original : JSON.stringify(stripSpans(opts.original));
    this.findings.push({
      status,
      code,
      message,
      itemKind: this.monitor ? "alert" : "query",
      itemId: this.ctx.where ?? "",
      ...(opts.ruleId !== undefined && { ruleId: opts.ruleId }),
      ...(opts.assumptions?.length && { assumptions: opts.assumptions.map((a) => ASSUMPTIONS[a]) }),
      ...(original !== undefined && { original }),
    });
  }
  /** Dashboard counter rules use the `.anchored` rule ids; monitors keep the extrapolated ones. */
  private counterRule(id: "time.unmapped.counter" | "time.unmapped.suffix-counter" | "time.as_count.counter" | "time.as_rate.counter" | "time.ddrate.plain" | "time.rollup.counter" | "time.count.default" | "time.count.counter"): RuleId {
    return this.monitor ? id : (`${id}.anchored` as RuleId);
  }

  manual(code: string, message: string, original?: unknown): never {
    this.find("manual", code, message, { original });
    throw new Manual(message);
  }

  label(ddTag: string): string {
    const mapped = this.ctx.tag?.(ddTag);
    if (mapped !== undefined) return mapped;
    const label = ddTag.replace(/[^A-Za-z0-9_]/g, "_");
    this.use("label.default");
    this.find("exact-under", "tag.unmapped", `tag '${ddTag}' has no tag-table entry; using label '${label}'`, {
      ruleId: "label.default",
      assumptions: ["A.tag-default"],
    });
    return label;
  }

  // ---------- expressions ----------

  expr(e: Expr, env?: FormulaEnv): Lowered {
    switch (e.type) {
      case "number":
        return { node: { k: "num", value: e.value }, groups: null };
      case "paren":
        return this.expr(e.expr, env);
      case "neg": {
        this.use("arith.neg");
        const x = this.expr(e.expr, env);
        return { node: { k: "neg", expr: x.node }, groups: x.groups, ...(x.windowed && { windowed: true }) };
      }
      case "metric":
        return this.metric(e, []);
      case "postfix": {
        // Unwind the chain: q.a().b() -> base q, calls [a, b] in application order.
        const calls = [];
        let base: Expr = e;
        while (base.type === "postfix") {
          calls.unshift(base.call);
          base = base.target;
        }
        if (base.type !== "metric") this.manual("query.postfix.non-metric", "postfix function on a non-metric expression");
        return this.metric(base, calls);
      }
      case "binary":
        return this.binary(e.op, e.left, e.right, env);
      case "ref": {
        const target = env?.get(e.name);
        if (!target) this.manual("formula.ref.unknown", `formula references unknown query '${e.name}'`);
        if ("type" in target && target.type === "lowered") return this.lowered(target);
        return this.expr(target, env);
      }
      case "call":
        return this.call(e, env);
    }
  }

  /** A ref translated elsewhere: take its tree, carry its claim and findings into this result. */
  lowered(ref: LoweredRef): Lowered {
    if (ref.status === "manual") {
      for (const f of ref.findings) if (!this.findings.some((x) => x.code === f.code && x.message === f.message)) this.findings.push(f);
      this.manual("formula.ref.manual", "the formula uses a query that could not be translated");
    }
    if (ref.rules.includes("log.scalar.window")) this.sawScalarLog = true;
    else this.sawPerBucket = true;
    this.checkWindows();
    this.external.push({ status: ref.status, rules: ref.rules, assumptions: ref.assumptions });
    for (const f of ref.findings) if (!this.findings.some((x) => x.code === f.code && x.message === f.message)) this.findings.push(f);
    return { node: ref.node, groups: ref.groups };
  }

  binary(op: "+" | "-" | "*" | "/", left: Expr, right: Expr, env?: FormulaEnv): Lowered {
    const l = this.expr(left, env);
    const r = this.expr(right, env);
    if (l.groups && r.groups) {
      if (l.groups.join(",") !== r.groups.join(","))
        this.manual(
          "arith.group-mismatch",
          `arithmetic between different group-bys (${l.groups.join(",") || "none"} vs ${r.groups.join(",") || "none"}) needs explicit vector matching`,
        );
      this.use("arith.same-groups");
    } else this.use("arith.number");
    if (op === "/" && r.node.k === "num" && r.node.value === 0)
      this.manual("arith.div-zero", "division by the constant 0: Datadog drops the points, PromQL would return ±Inf/NaN");
    if (op === "/" && r.groups) this.use("arith.div");
    // sum(last_W):…as_count() is a window total. Totals stay totals only under linear arithmetic:
    // a ± b of two totals, or a total scaled by a constant. Anything else (a/b, a*b, a + 5) is summed per
    // bucket by Datadog and can't be taken from the window totals, so the monitor fails closed.
    let windowed = false;
    if (l.windowed || r.windowed) {
      const linear =
        op === "+" || op === "-"
          ? !!(l.windowed && r.windowed)
          : op === "*"
            ? (l.windowed && r.groups === null) || (r.windowed && l.groups === null)
            : !!(l.windowed && r.groups === null);
      if (!linear) this.manual("monitor.as_count", `sum(last_W) with .as_count() combined by '${op}' is not a window total; no rule`);
      windowed = true;
    }
    return { node: { k: "binary", op, lhs: l.node, rhs: r.node }, groups: l.groups ?? r.groups, ...(windowed && { windowed: true }) };
  }

  call(e: Extract<Expr, { type: "call" }>, env?: FormulaEnv): Lowered {
    const exprArg = (i: number): Expr => {
      const a = e.args[i];
      if (a?.type !== "expr") this.manual("fn.args", `${e.name}(): argument ${i + 1} must be a query`);
      return a.expr;
    };
    const numArg = (i: number): number => {
      const a = e.args[i];
      const x = a?.type === "expr" ? a.expr : null;
      if (x?.type === "number") return x.value;
      if (x?.type === "neg" && x.expr.type === "number") return -x.expr.value;
      this.manual("fn.args", `${e.name}(): argument ${i + 1} must be a number`);
    };

    const unary = UNARY_MAPS[e.name];
    if (unary && e.args.length === 1) {
      this.use(unary);
      const x = this.expr(exprArg(0), env);
      return { node: { k: "call", fn: e.name, args: [x.node] }, groups: x.groups };
    }
    if ((e.name === "clamp_min" || e.name === "clamp_max") && e.args.length === 2) {
      this.use(`map.${e.name}`);
      const x = this.expr(exprArg(0), env);
      return { node: { k: "call", fn: e.name, args: [x.node, { k: "num", value: numArg(1) }] }, groups: x.groups };
    }
    // round(q): nearest integer.
    if (e.name === "round" && e.args.length === 1) {
      const x = this.expr(exprArg(0), env);
      this.use("fn.round");
      return { node: { k: "call", fn: "round", args: [x.node] }, groups: x.groups };
    }

    // exclude_null(q): drop the N/A group, i.e. series that lack a group-by label.
    if (e.name === "exclude_null" && e.args.length === 1) {
      const x = this.expr(exprArg(0), env);
      this.use("fn.exclude_null");
      const labels = x.groups ?? [];
      const node = labels.length
        ? mapSelectors(x.node, (sel) => ({ ...sel, matchers: [...sel.matchers, ...labels.filter((l) => !sel.matchers.some((m) => m.label === l && m.op === "!=" && m.value === "")).map((label) => ({ label, op: "!=" as const, value: "" }))] }))
        : x.node;
      return { node, groups: x.groups };
    }

    // max(a, b) / min(a, b): pointwise. With a constant it is a clamp; between queries a filter-or.
    if ((e.name === "max" || e.name === "min") && e.args.length === 2) {
      const a = this.expr(exprArg(0), env);
      const b = this.expr(exprArg(1), env);
      const clamp = e.name === "max" ? "clamp_min" : "clamp_max";
      if (a.groups === null && b.groups === null) this.manual("fn.max_min.constants", `${e.name}() of two constants`);
      if (a.groups === null || b.groups === null) {
        const [q, n] = a.groups === null ? [b, a] : [a, b];
        if (n.node.k !== "num") this.manual("fn.max_min.args", `${e.name}(): the scalar argument must be a number`);
        this.use("fn.max_min.scalar");
        return { node: { k: "call", fn: clamp, args: [q.node, n.node] }, groups: q.groups };
      }
      if (a.groups.join(",") !== b.groups.join(",")) this.manual("arith.group-mismatch", `${e.name}() between different group-bys`);
      this.use("fn.max_min.series");
      const cmp = e.name === "max" ? ">=" : "<=";
      return { node: { k: "binary", op: "or", lhs: { k: "binary", op: cmp, lhs: a.node, rhs: b.node }, rhs: b.node }, groups: a.groups };
    }

    // top/bottom: rank and keep N series. topk ranks per step; Datadog ranks once over the window (A.top-stable).
    const short = TOP_SHORTCUT.exec(e.name);
    if (short && (e.name !== "top" && e.name !== "bottom" ? e.args.length === 1 : e.args.length >= 1 && e.args.length <= 4)) {
      let k = short[1] === "top" ? "topk" : "bottomk";
      let n = short[2] !== undefined ? Number(short[2]) : 10;
      if (e.name === "top" || e.name === "bottom") {
        if (e.args.length >= 2) n = numArg(1);
        const order = e.args[3];
        // bottom()'s direction argument isn't documented the same way as top()'s: don't guess which way it flips.
        if (order && e.name === "bottom") this.manual("fn.top.args", "bottom() with an explicit order: semantics not confirmed");
        if (order) {
          if (order.type !== "string" || !["asc", "desc"].includes(order.value)) this.manual("fn.top.args", `${e.name}(): order must be 'asc' or 'desc'`);
          if (order.value === "asc") k = k === "topk" ? "bottomk" : "topk";
        }
        const method = e.args[2];
        if (method && (method.type !== "string" || !["mean", "min", "max", "last", "area", "l2norm", "norm", "sum"].includes(method.value)))
          this.manual("fn.top.args", `${e.name}(): unknown ranking method`);
      }
      if (!Number.isInteger(n) || n <= 0) this.manual("fn.top.args", `${e.name}(): N must be a positive integer`);
      const x = this.expr(exprArg(0), env);
      this.use("fn.top");
      return { node: { k: "call", fn: k, args: [{ k: "num", value: n }, x.node] }, groups: x.groups };
    }

    if ((e.name === "cutoff_min" || e.name === "cutoff_max") && e.args.length === 2) {
      const x = this.expr(exprArg(0), env);
      this.use("fn.cutoff");
      const op = e.name === "cutoff_min" ? ">=" : "<=";
      return { node: { k: "binary", op, lhs: x.node, rhs: { k: "num", value: numArg(1) } }, groups: x.groups };
    }

    if ((e.name === "count_not_null" || e.name === "count_nonzero") && e.args.length === 1) {
      const x = this.expr(exprArg(0), env);
      this.use(`fn.${e.name}`);
      const inner: PNode = e.name === "count_nonzero" ? { k: "binary", op: "!=", lhs: x.node, rhs: { k: "num", value: 0 } } : x.node;
      // No matching series means 0 in Datadog, and no data in PromQL: add the zero explicitly (the result has no labels).
      const count: PNode = { k: "agg", op: "count", by: [], expr: inner };
      return { node: { k: "binary", op: "or", lhs: count, rhs: { k: "call", fn: "vector", args: [{ k: "num", value: 0 }] } }, groups: [] };
    }

    if (e.name === "default_zero" && e.args.length === 1) {
      const x = this.expr(exprArg(0), env);
      if (x.groups === null) this.manual("fn.default_zero.scalar", "default_zero() of a constant");
      if (x.groups.length > 0) {
        // Zero for every series seen in the dashboard's range: the same query over [$__range] @ end(), times 0.
        // Dashboards: series seen in the visible range ($__range @ end()). Monitors: series seen in the evaluation window.
        if (!this.monitor && this.interval !== "$__interval")
          this.manual("fn.default_zero.grouped", "default_zero() over a grouped query with a fixed interval has no series set to fill");
        if (this.monitor && this.monitorWindow === undefined) this.manual("fn.default_zero.grouped", "default_zero() in a monitor without a window");
        const ranged = this.monitor
          ? mapSelectors(x.node, (sel) => ({ ...sel, range: this.monitorWindow! }))
          : mapSelectors(x.node, (sel) => ({ ...sel, range: "$__range", at: "end()" }));
        this.use(this.monitor ? "fn.default_zero.grouped.monitor" : "fn.default_zero.grouped");
        const zeros: PNode = { k: "binary", op: "*", lhs: { k: "num", value: 0 }, rhs: ranged };
        return { node: { k: "binary", op: "or", lhs: x.node, rhs: zeros }, groups: x.groups };
      }
      this.use("fn.default_zero.single");
      return { node: { k: "binary", op: "or", lhs: x.node, rhs: { k: "call", fn: "vector", args: [{ k: "num", value: 0 }] } }, groups: x.groups };
    }

    if (e.name === "derivative" && e.args.length === 1) {
      const x = this.expr(exprArg(0), env);
      if (!x.rateForm) this.manual("fn.derivative.kind", "derivative() has a rule only for sum/avg over a Datadog gauge that holds an OTel counter's running total");
      this.use(x.rateFormGauge ? "fn.per_unit.gauge" : "fn.derivative.counter");
      return { node: x.rateForm, groups: x.groups };
    }

    // per_second/per_minute/per_hour: the change per unit of a running total, i.e. k * rate() over the counter.
    if (PER_UNIT[e.name] !== undefined && e.args.length === 1) {
      const x = this.expr(exprArg(0), env);
      if (!x.rateForm)
        this.manual(
          "fn.per_unit.kind",
          `${e.name}() has a rule only for sum/avg over a Datadog gauge that holds an OTel counter's running total`,
        );
      this.use(x.rateFormGauge ? "fn.per_unit.gauge" : "fn.per_unit.counter");
      const k = PER_UNIT[e.name]!;
      const node: PNode = k === 1 ? x.rateForm : { k: "binary", op: "*", lhs: { k: "num", value: k }, rhs: x.rateForm };
      return { node, groups: x.groups };
    }

    // diff: each point minus the previous one, one rollup interval earlier. monotonic_diff keeps only increases.
    if ((e.name === "diff" || e.name === "monotonic_diff") && e.args.length === 1) {
      const x = this.expr(exprArg(0), env);
      // Datadog diffs each series before space aggregation; that commutes only with sum/avg (and linear arithmetic).
      if (!linearInSeries(x.node)) this.manual(`fn.${e.name}.agg`, `${e.name}() over max/min/count or non-linear functions isn't exact`);
      const step = this.interval;
      const shifted = mapSelectors(x.node, (sel) => {
        if (sel.offset === undefined || sel.offset === 0) return { ...sel, offset: step };
        if (typeof sel.offset === "number" && typeof step === "number") return { ...sel, offset: sel.offset + step };
        this.manual("fn.diff.offset", "diff() over a query that already has a variable offset");
      });
      const delta: PNode = { k: "binary", op: "-", lhs: x.node, rhs: shifted };
      if (e.name === "diff") {
        this.use("fn.diff");
        return { node: delta, groups: x.groups };
      }
      this.use("fn.monotonic_diff");
      return { node: { k: "binary", op: ">=", lhs: delta, rhs: { k: "num", value: 0 } }, groups: x.groups };
    }

    let shift: number | undefined;
    if (e.name === "timeshift" && e.args.length === 2) shift = -numArg(1);
    else if (TIMESHIFT_FNS[e.name] && e.args.length === 1) shift = TIMESHIFT_FNS[e.name];
    if (shift !== undefined) {
      if (!(shift > 0) || !Number.isInteger(shift)) this.manual("fn.timeshift.future", `${e.name}(): only whole-second shifts into the past are supported`);
      this.use("map.timeshift");
      const x = this.expr(exprArg(0), env);
      const node = mapSelectors(x.node, (s) => {
        if (typeof s.offset === "string") this.manual("fn.timeshift.offset", `${e.name}() over a query that already has a variable offset`);
        return { ...s, offset: (s.offset ?? 0) + shift! };
      });
      return { node, groups: x.groups };
    }
    this.manual(`fn.${e.name}`, `no exact rule for Datadog function ${e.name}()`);
  }

  // ---------- metric query ----------

  metric(m: MetricQuery, calls: { name: string; args: import("../../parse/index.js").Arg[] }[]): Lowered {
    this.sawPerBucket = true;
    this.checkWindows();
    if (m.valueFilter) this.manual("query.value-filter", "distribution value filters (v: ...) have no PromQL equivalent");

    let mapping: MetricMapping | undefined = this.ctx.metric?.(m.metric);
    const mapped = mapping !== undefined;
    if (!mapping) {
      // The table can know a metric and still have no usable OTel equivalent: never query a metric that doesn't exist.
      const why = this.ctx.availability?.(m.metric) ?? "unmapped";
      if (why === "no_equivalent") this.manual("metric.no_equivalent", `${m.metric}: the OTel receiver emits no equivalent metric`);
      if (why === "derived") this.manual("metric.derived", `${m.metric}: the equivalent is an expression over several OTel metrics (not translated yet)`);
      if (why === "needs_transform") this.manual("metric.needs_transform", `${m.metric}: the mapping needs a scale or sumBy transform, but the context did not pass it to T4`);
    }
    // Datadog's declared kind (metadata.csv) for a metric without a curated entry.
    let hint = mapping ? undefined : this.ctx.ddKind?.(m.metric);
    // No metadata.csv entry: an OpenMetrics-style counter name (.count/.total) queried with .as_count()/.as_rate()
    // carries two independent signals that it is a monotonic count.
    const percentile = PERCENTILE.exec(m.spaceAgg ?? "");
    const countModifier = calls.some((c) => c.name === "as_count" || c.name === "as_rate");
    if (!mapping && hint === undefined && this.ctx.ddKind && countModifier && /\.(count|total)$/.test(m.metric)) {
      hint = "count";
      this.use(this.counterRule("time.unmapped.suffix-counter"));
    }
    if (mapping) this.use("select.metric.mapped");
    else if (hint) {
      // A distribution only has a rule for its percentiles (fn.histogram.quantile); avg:/sum:/... on it stay manual.
      if (hint === "distribution" && !percentile)
        this.manual("metric.distribution", `${m.metric} is a Datadog distribution; only pXX: on it has a rule (fn.histogram.quantile)`);
      this.use("select.metric.kind-metadata");
      this.find("exact-under", "metric.unmapped", `no mapping for ${m.metric}; kept the Datadog name, kind ${hint} from metadata.csv`, {
        ruleId: "select.metric.kind-metadata",
        assumptions: ["A.kind-metadata"],
      });
      mapping =
        hint === "gauge"
          ? { otel: m.metric, kind: "gauge", ddKind: "gauge" }
          : hint === "distribution"
            ? { otel: m.metric, kind: "histogram", ddKind: "distribution" }
            : { otel: m.metric, kind: "counter", ddKind: hint };
    } else {
      this.use("select.metric.unmapped");
      this.find("exact-under", "metric.unmapped", `no mapping for ${m.metric}; kept the Datadog name and assumed a gauge`, {
        ruleId: "select.metric.unmapped",
        assumptions: ["A.kind-gauge"],
      });
      mapping = { otel: m.metric, kind: "gauge" };
    }
    const kindKnown = mapped || hint !== undefined;

    if (mapping.status === "approximate") {
      this.use("select.metric.approximate");
      this.find("bounded", "metric.approximate", `${m.metric} -> ${mapping.otel} is an approximate mapping${mapping.note ? `: ${mapping.note}` : ""}`, {
        ruleId: "select.metric.approximate",
      });
    }

    // Mapping-table labels select the right OTel series (redis.cpu.sys -> redis.cpu.time{state="sys"}). The table names
    // OTel attributes as emitted (k8s.container.status.state); Dash0 exposes them with dots as underscores.
    const labelMatchers: PMatcher[] = Object.entries(mapping.labels ?? {}).map(([label, value]) => ({ label: label.replace(/\./g, "_"), op: "=", value }));
    if (labelMatchers.length) this.use("select.labels");
    const scopeMatchers = this.scope(m.scope);
    const clash = scopeMatchers.find((s) => labelMatchers.some((l) => l.label === s.label));
    if (clash) this.manual("select.labels.clash", `the query filters on '${clash.label}', which the mapping already fixes`);
    const matchers: PMatcher[] = [{ label: "otel_metric_name", op: "=", value: mapping.otel }, ...labelMatchers, ...scopeMatchers];

    // select.metric.transform: Datadog value = scale × OTel value, and the OTel metric splits Datadog's series by the
    // extra sumBy labels. Guards that need only the selector run here; the time-aggregation guard runs below.
    const scale = mapping.scale;
    const sumBy = [...new Set((mapping.sumBy ?? []).map((l) => l.replace(/\./g, "_")))].sort();
    const transform = scale !== undefined || sumBy.length > 0;
    if (scale !== undefined && !(scale > 0 && Number.isFinite(scale)))
      this.manual("metric.needs_transform", `${m.metric}: scale ${scale} is not positive; min/max would swap under it, so no exact rewrite is applied`);
    if (sumBy.length) {
      const by = new Set(m.groupBy.map((t) => this.ctx.tag?.(t) ?? t.replace(/[^A-Za-z0-9_]/g, "_")));
      const hit = sumBy.find((l) => by.has(l) || matchers.some((x) => x.label === l));
      if (hit !== undefined)
        this.manual("metric.needs_transform", `${m.metric}: the query filters or groups on '${hit}', which the mapping sums away (Datadog has no such tag)`);
    }

    if (percentile) return this.percentile(m, percentile[1]!, mapping, kindKnown, matchers, calls, scale, sumBy);

    // Effective kind. Datadog's own kind decides the time aggregation when the table gives it (T1 kindTransform):
    // a Datadog gauge stays a gauge even when the OTel receiver emits a counter; a Datadog RATE on an OTel counter
    // means a plain query already shows per-second values, so it needs rate() (D-18).
    let kind = mapping.kind;
    let ddRate = false;
    const unmappedCounter = !mapped && hint !== undefined && hint !== "gauge";
    // A curated row saying Datadog COUNT on an OTel counter (kinds checked against the sources by the mapping logic
    // gates): the per-interval deltas telescope to increase() over the bucket (maths.md T4c), like time.count.default.
    const curatedCount = mapped && mapping.ddKind === "count" && kind === "counter";
    if (mapping.ddKind !== undefined) {
      if (mapping.ddKind === "gauge" && kind !== "histogram") kind = "gauge";
      else if (mapping.ddKind === "rate" && kind === "counter") ddRate = true;
      else if (!(unmappedCounter && mapping.ddKind === "count") && !curatedCount)
        this.manual("time.kind", `Datadog ${mapping.ddKind} stored as an OTel ${kind}: no tested rule yet`);
    }
    if (unmappedCounter) this.use(this.counterRule("time.unmapped.counter"));

    // Time aggregation, Datadog order: per series first.
    let fn = "avg";
    let width: Duration = this.interval;
    let explicitRollup = false;
    let counterMode: "increase" | "rate" | null = null;
    let fillZero = false;
    for (const c of calls) {
      if (c.name === "rollup") {
        const f = c.args[0];
        const s = c.args[1];
        if (f?.type !== "word" || !ROLLUP_FNS.has(f.value)) this.manual("time.rollup.fn", `.rollup(): unsupported function`, c);
        fn = f.value;
        if (s) {
          const n = s.type === "expr" && s.expr.type === "number" ? s.expr.value : NaN;
          if (!Number.isInteger(n) || n <= 0) this.manual("time.rollup.width", ".rollup(): width must be whole seconds");
          if (this.monitor && n !== 60) this.manual("time.rollup.monitor-width", "monitor queries support only 60 s rollups");
          width = n;
        }
        if (c.args.length > 2) this.manual("time.rollup.args", ".rollup(): too many arguments");
        explicitRollup = true;
      } else if (c.name === "as_count" && this.monitor && kind !== "gauge" && this.monitorSumWindow === undefined) {
        this.manual("monitor.as_count", ".as_count() in a monitor other than sum(last_W): Datadog evaluates it on a sum path we don't model yet");
      } else if (c.name === "as_count" || c.name === "as_rate") {
        // .as_count()/.as_rate() suggest a count or rate metric, so don't lean on the gauge assumption here.
        if (!kindKnown) this.manual("time.kind-unknown", `.${c.name}() on ${m.metric}: its kind is unknown (no mapping entry), so the time aggregation can't be chosen`);
        // A curated row whose ddKind (rate) comes from the check source: Datadog's own metadata types these metrics as GAUGE
        // (live 2026-11-08: redis.net.commands, 21 of 22 such rows), where .as_count()/.as_rate() do nothing and return the stored
        // per-second values. T4 assumes a RATE-typed metric (as_count = sum of count deltas); which one applies depends on the
        // account's metric type, which the table cannot tell, so there is no faithful translation.
        if (ddRate)
          this.manual("time.kind", `.${c.name}() on ${m.metric}: Datadog types this metric as a gauge (then .${c.name}() has no effect) or a rate (then it counts); the mapping cannot tell which`);
        if (kind === "gauge") this.use(`time.${c.name}.gauge`);
        else if (kind === "counter") {
          this.use(this.counterRule(c.name === "as_count" ? "time.as_count.counter" : "time.as_rate.counter"));
          counterMode = c.name === "as_count" ? "increase" : "rate";
        } else if (kind === "delta" && c.name === "as_count") {
          this.use("time.as_count.delta");
          fn = "sum";
        } else this.manual(`time.${c.name}.${kind}`, `.${c.name}() on a ${kind} metric has no exact rule`);
      } else if (c.name === "fill") {
        const a = c.args[0];
        const zero = (a?.type === "word" && a.value === "zero") || (a?.type === "expr" && a.expr.type === "number" && a.expr.value === 0);
        if (c.args.length >= 1 && c.args.length <= 2 && a?.type === "word" && a.value === "null") this.use("time.fill.null");
        else if (c.args.length >= 1 && c.args.length <= 2 && zero) fillZero = true;
        else this.manual("time.fill", ".fill() other than null has no exact rule (PromQL does not fill gaps)");
      } else if (c.name === "weighted" && c.args.length === 0) {
        this.use("time.weighted");
      } else this.manual(`fn.${c.name}`, `no exact rule for .${c.name}()`);
    }
    if (ddRate && !counterMode) {
      this.use(this.counterRule("time.ddrate.plain"));
      counterMode = "rate";
    }
    if (((unmappedCounter && hint === "count") || curatedCount) && !counterMode) {
      if (explicitRollup && fn !== "sum") this.manual("time.rollup.counter", `.rollup(${fn}) on a COUNT metric has no rule`);
      if (explicitRollup) this.use(this.counterRule("time.rollup.counter"));
      this.use(this.counterRule(curatedCount ? "time.count.counter" : "time.count.default"));
      counterMode = "increase";
    }
    if ((kind === "counter" && !counterMode) || kind === "histogram" || (kind === "delta" && fn !== "sum"))
      this.manual("time.kind", `a ${kind} metric needs an explicit .as_count()/.as_rate() to fix its time aggregation`);
    if (counterMode && explicitRollup) {
      const ok = (counterMode === "increase" && fn === "sum") || (counterMode === "rate" && fn === "avg");
      if (!ok) this.manual("time.rollup.counter", `.rollup(${fn}) combined with ${counterMode}() has no rule`);
      this.use(this.counterRule("time.rollup.counter"));
    }

    // sum(last_W):q.as_count() in a monitor: the window's total count is increase over the whole window.
    const windowed = this.monitorSumWindow !== undefined && counterMode === "increase";
    if (windowed) {
      if (explicitRollup) this.manual("time.rollup.counter", ".rollup() combined with a counter rate has no exact rule");
      width = this.monitorSumWindow!;
    }
    // Dashboards: `anchored` (maths.md T4, T4c, T10a) takes its baseline from the last sample before the window and does not
    // extrapolate, so the window is the rollup width itself and needs no $__rate_interval. Monitors keep the extrapolated forms:
    // a check rule with `anchored` has not been probed.
    const anchored = counterMode !== null && !this.monitor;
    // rate()/increase() without `anchored` need at least two samples per window; on dashboards use Perses' $__rate_interval for that.
    const range: Duration = counterMode && !anchored && width === "$__interval" ? "$__rate_interval" : width;
    const sel: PNode = { k: "selector", matchers, range, ...(anchored && { anchored: true }) };
    let inner: PNode;
    if (counterMode) inner = { k: "call", fn: counterMode, args: [sel] };
    else {
      this.use(this.monitor ? "time.rollup.monitor-bucket" : explicitRollup ? "time.rollup.explicit" : "time.rollup.default");
      inner = { k: "call", fn: `${fn}_over_time`, args: [sel] };
    }
    // sumBy: Datadog rolls up the SUM over the split series. sum_over_time, avg_over_time, rate and increase are linear
    // in the samples, so sum_L f(x_L) = f(sum_L x_L) (sum_over_time always; the others when the split series share
    // sample timestamps, A.sumby-together). min/max/count_over_time are not linear: fail closed.
    if (sumBy.length && !counterMode && (fn === "min" || fn === "max" || fn === "count"))
      this.manual("metric.needs_transform", `${m.metric}: .rollup(${fn}) over a series the mapping sums by ${sumBy.join(", ")}: ${fn}_over_time does not commute with the sum`);
    if (transform) {
      this.use("select.metric.transform");
      if (sumBy.length && (counterMode || fn !== "sum")) this.use("select.metric.transform.sumby");
    }

    // Space aggregation.
    let agg = m.spaceAgg;
    if (agg === null) {
      this.use("space.default-avg");
      agg = "avg";
    } else if (!SPACE_AGGS.has(agg)) this.manual("space.agg", `space aggregator ${agg}: needs a histogram mapping`);
    else this.use("space.agg");
    const by = [...new Set(m.groupBy.map((t) => this.label(t)))].sort();
    // Why select.metric.transform is exact (k = scale > 0, L = sumBy):
    //   per series  Datadog's series is d = k * sum_L x_L. Every time aggregation T4 emits is homogeneous of degree 1
    //               for k > 0: f(k*y) = k*f(y) for avg/sum/min/max_over_time, rate and increase (rate's reset check
    //               compares neighbours and its extrapolation clamp uses value ratios: both unchanged by k > 0);
    //               count_over_time is unchanged (degree 0). Linearity in L is the guard above.
    //   space       sum without (L) leaves exactly Datadog's series (the same labels minus L), so the outer
    //               avg/sum/min/max/count by (G) runs over Datadog's population. sum/avg/min/max are homogeneous for
    //               k > 0 (min/max keep their order; k < 0 would swap them, so it fails closed); count is unchanged.
    //   so          agg_G(T(k * sum_L x)) = k * agg_G(sum without (L) (T(x))) unless T or agg is a count, where the
    //               scale drops out. k is applied once, outermost on the metric query.
    const spaceIn: PNode = sumBy.length ? { k: "agg", op: "sum", by: sumBy, without: true, expr: inner } : inner;
    const scaled = scale !== undefined && agg !== "count" && (counterMode !== null || fn !== "count");
    const withScale = (n: PNode): PNode => (scaled ? { k: "binary", op: "*", lhs: { k: "num", value: scale! }, rhs: n } : n);
    const node: PNode = withScale({ k: "agg", op: agg as "avg", by, expr: spaceIn });
    const rateOf = (range: Duration): PNode => {
      const r: PNode = { k: "call", fn: "rate", args: [{ k: "selector", matchers, range }] };
      return withScale({ k: "agg", op: agg as "avg", by, expr: sumBy.length ? { k: "agg", op: "sum", by: sumBy, without: true, expr: r } : r });
    };
    // For per_second() and friends: the derivative of a sum/avg of running totals is the sum/avg of their rates.
    const runningTotal = mapping.ddKind === "gauge" && mapping.kind === "counter" && !counterMode && !explicitRollup;
    if (fillZero) {
      if (by.length > 0 || this.monitor) this.manual("time.fill", ".fill(zero) on a grouped query (or in a monitor): PromQL can't fill gaps per series");
      this.use("time.fill.zero.single");
      return { node: { k: "binary", op: "or", lhs: node, rhs: { k: "call", fn: "vector", args: [{ k: "num", value: 0 }] } }, groups: by };
    }
    if (windowed) {
      this.sawWindowed = true;
      return { node, groups: by, windowed: true };
    }
    if (kind === "gauge" && !counterMode && !explicitRollup && !runningTotal && (agg === "sum" || agg === "avg")) {
      const rateRange: Duration = width === "$__interval" ? "$__rate_interval" : width;
      return { node, groups: by, rateForm: rateOf(rateRange), rateFormGauge: true };
    }
    if ((runningTotal || (kind === "counter" && counterMode !== null && !explicitRollup)) && (agg === "sum" || agg === "avg")) {
      const rateRange: Duration = width === "$__interval" ? "$__rate_interval" : width;
      return { node, groups: by, rateForm: rateOf(rateRange) };
    }
    return { node, groups: by };
  }

  /**
   * fn.histogram.quantile (maths.md §12, Theorem T11): Datadog `pXX:m{f} by {g}` on a distribution merges every matching
   * series per group into one DDSketch and reads the XX-th percentile. The PromQL counterpart merges the OTel histogram's
   * buckets per group the same way and interpolates inside the bucket holding the rank:
   *   histogram_quantile(0.XX, sum by (le, g) (rate({otel_metric_name="<otel>", f}[w])))
   * T11a: the quantile depends only on the ratios of the bucket counts, so rate/increase/raw counts give the same value
   * and the window w only picks which samples are in. T11b: |P - DD| <= w_b + g + 1%·x. Bounded, never exact.
   * `sum by (le, g)` works whether Dash0 serves the histogram natively (no le label: Dash0's own documented example) or
   * as le-labelled buckets under the same name; a `_bucket`-suffixed name would not (A.histogram-buckets).
   */
  percentile(
    m: MetricQuery,
    digits: string,
    mapping: MetricMapping,
    kindKnown: boolean,
    matchers: PMatcher[],
    calls: { name: string; args: import("../../parse/index.js").Arg[] }[],
    scale: number | undefined,
    sumBy: string[],
  ): Lowered {
    const agg = m.spaceAgg!;
    if (!kindKnown)
      this.manual("fn.histogram.kind-unknown", `${agg}:${m.metric}: no mapping entry or metadata.csv kind says it is a distribution, so there are no buckets to take the quantile from`);
    if (mapping.kind !== "histogram")
      this.manual("fn.histogram.kind", `${agg}:${m.metric}: the mapping says it is an OTel ${mapping.kind}; a percentile needs an OTel histogram`);
    if (mapping.ddKind !== undefined && mapping.ddKind !== "distribution")
      this.manual("fn.histogram.kind", `${agg}:${m.metric}: the mapping says Datadog stores it as a ${mapping.ddKind}; pXX: needs a Datadog distribution`);
    if (calls.length) this.manual("fn.histogram.modifier", `.${calls[0]!.name}() on a percentile query (${agg}:) has no tested rule`);
    // 99.9 / 100 is 0.9990000000000001 in floating point: round to the digits Datadog's name can carry.
    const q = Number((Number(digits) / 100).toFixed(digits.length + 2));
    if (!(q > 0 && q < 1)) this.manual("fn.histogram.kind", `${agg}: the quantile must be strictly between p0 and p100`);
    const by = [...new Set(m.groupBy.map((t) => this.label(t)))].sort();
    if (by.includes("le")) this.manual("fn.histogram.le", `${agg}: grouping by 'le' clashes with histogram_quantile's bucket label`);
    // Window: rate() needs two samples, so dashboards use $__rate_interval; a monitor's inner query runs on 1m buckets.
    const range: Duration = this.interval === "$__interval" ? "$__rate_interval" : this.interval;
    // scale k > 0: the quantile of k·x is k times the quantile of x (bucket bounds scale with the values). sumBy labels
    // need nothing: sum by (le, g) already adds up every series that differs only in labels outside g.
    if (scale !== undefined || sumBy.length) this.use("select.metric.transform");
    this.use("fn.histogram.quantile");
    const merged: PNode = { k: "agg", op: "sum", by: ["le", ...by], expr: { k: "call", fn: "rate", args: [{ k: "selector", matchers, range }] } };
    const hq: PNode = { k: "call", fn: "histogram_quantile", args: [{ k: "num", value: q }, merged] };
    const node: PNode = scale !== undefined ? { k: "binary", op: "*", lhs: { k: "num", value: scale }, rhs: hq } : hq;
    return { node, groups: by };
  }

  // ---------- scope -> matchers ----------

  scope(s: ScopeExpr | null): PMatcher[] {
    if (!s || s.type === "all") {
      this.use("scope.all");
      return [];
    }
    if (s.type === "and") {
      const out = s.items.flatMap((i) => this.scope(i));
      const isVar = (m: PMatcher) => /^\^\(\$[^)]+\)\$$/.test(m.value);
      const positives = out.filter((m) => m.op === "=" || m.op === "=~");
      const literals = positives.filter((m) => !isVar(m)).map((m) => m.label);
      if (new Set(literals).size !== literals.length)
        this.manual("scope.same-key", "the same tag key appears twice in one scope; Datadog's meaning is ambiguous here", s);
      const labels = positives.map((m) => m.label);
      if (new Set(labels).size !== labels.length) this.use("scope.same-key.var");
      return out;
    }
    if (s.type === "var") return this.variable(s.name, s.negated);
    if (s.type === "in") {
      this.use("scope.in");
      return [{ label: this.label(s.key), op: s.negated ? "!~" : "=~", value: `^(${s.values.map(pattern).join("|")})$` }];
    }
    if (s.type === "or") {
      const tags = s.items.filter((i): i is Extract<ScopeExpr, { type: "tag" }> => i.type === "tag" && !i.negated && i.key !== null);
      const keys = new Set(tags.map((t) => t.key));
      if (tags.length !== s.items.length || keys.size !== 1)
        this.manual("scope.or.cross-key", "OR across different tag keys is not a matcher set", s);
      this.use("scope.or.same-key");
      return [{ label: this.label(tags[0]!.key!), op: "=~", value: `^(${tags.map((t) => pattern(t.value)).join("|")})$` }];
    }
    if (s.type === "not") {
      const inner = s.expr;
      if (inner.type === "tag" && !inner.negated) {
        this.use("scope.not");
        return this.tag({ ...inner, negated: true });
      }
      if (inner.type === "var" && !inner.negated) return this.variable(inner.name, true);
      if (inner.type === "in" && !inner.negated) {
        this.use("scope.not.set");
        return [{ label: this.label(inner.key), op: "!~", value: `^(${inner.values.map(pattern).join("|")})$` }];
      }
      if (inner.type === "or") {
        // NOT (k:a OR k:b) -> k!~"^(a|b)$" when every branch is a positive tag on the same key.
        const tags = inner.items.filter((i): i is Extract<ScopeExpr, { type: "tag" }> => i.type === "tag" && !i.negated && i.key !== null && !i.value.startsWith("$"));
        if (tags.length === inner.items.length && new Set(tags.map((t) => t.key)).size === 1) {
          this.use("scope.not.set");
          return [{ label: this.label(tags[0]!.key!), op: "!~", value: `^(${tags.map((t) => pattern(t.value)).join("|")})$` }];
        }
      }
      this.manual("scope.not.complex", "NOT over a compound filter has no matcher form", s);
    }
    return this.tag(s);
  }

  tag(t: Extract<ScopeExpr, { type: "tag" }>): PMatcher[] {
    if (t.key === null) this.manual("scope.bare-tag", `bare tag '${t.value}' has no key to map to a label`, t);
    const label = this.label(t.key);
    if (t.value.startsWith("$")) {
      // `topic:$queue.value`: a template variable used as the value of a fixed key.
      this.use(t.negated ? "scope.var.negated" : "scope.var");
      return [{ label, op: t.negated ? "!~" : "=~", value: `^(${t.value.replace(/\.(value|key)$/, "")})$` }];
    }
    if (t.value.includes("*")) {
      this.use("scope.tag.wildcard");
      return [{ label, op: t.negated ? "!~" : "=~", value: `^${pattern(t.value)}$` }];
    }
    this.use(t.negated ? "scope.tag.neq" : "scope.tag.eq");
    return [{ label, op: t.negated ? "!=" : "=", value: t.value }];
  }

  variable(name: string, negated: boolean): PMatcher[] {
    const raw = this.ctx.variables?.[name];
    // A variable with an empty prefix ("") is free-form, the same as no prefix.
    const def = raw && raw.tag !== null && raw.tag.trim() === "" ? { tag: null } : raw;
    if (negated && (!def || def.tag === null))
      this.manual("scope.var.negated", `negated free-form template variable $${name}: its value is a whole tag, which no matcher can exclude`);
    if (!def || def.tag === null) {
      // Free-form variable (Datadog `$scope` with no prefix): its value is a whole tag, which no single matcher can take.
      // At its default value `*` it filters nothing, so dropping it is exact under that assumption.
      this.assume("A.var-default");
      this.find("exact-under", "scope.var.free-form", `template variable $${name} has no tag key; dropped (exact while it is left at '*')`, {
        assumptions: ["A.var-default"],
      });
      return [];
    }
    this.use(negated ? "scope.var.negated" : "scope.var");
    return [{ label: this.label(def.tag), op: negated ? "!~" : "=~", value: `^($${name})$` }];
  }

  // ---------- result ----------

  result(node: PNode | null): QueryTranslation {
    let status: Status = "exact";
    const assumptions: string[] = [];
    for (const id of this.rules) {
      const r = RULES[id];
      status = worst(status, r.status);
      for (const a of r.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
    }
    for (const a of this.extraAssumptions) {
      status = worst(status, "exact-under");
      if (!assumptions.includes(a)) assumptions.push(a);
    }
    const rules: string[] = [...this.rules];
    for (const x of this.external) {
      status = worst(status, x.status);
      for (const a of x.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
      for (const id of x.rules) if (!rules.includes(id)) rules.push(id);
    }
    if (!node) return { status: "manual", promql: null, rules, assumptions: [], findings: this.findings };
    const promql = render(node);
    const v = validatePromQL(promql);
    if (!v.ok) {
      this.find("manual", "promql.invalid", `emitted PromQL does not parse: ${v.errors.map((x) => x.message).join("; ")}`, { original: promql });
      return { status: "manual", promql: null, rules, assumptions: [], findings: this.findings };
    }
    return { status, promql, rules, assumptions: assumptions.sort(), findings: this.findings };
  }
}

/** True if every space aggregation is sum/avg and the arithmetic is linear (± of terms, scaling by constants). */
function linearInSeries(n: PNode): boolean {
  switch (n.k) {
    case "agg": {
      if (n.without || (n.op !== "sum" && n.op !== "avg")) return false;
      // select.metric.transform's sum without (sumBy) (...) is linear too.
      const e = n.expr.k === "agg" && n.expr.op === "sum" && n.expr.without ? n.expr.expr : n.expr;
      return e.k === "call" && /_over_time$|^rate$|^increase$/.test(e.fn);
    }
    case "neg":
      return linearInSeries(n.expr);
    case "binary":
      if (n.op === "+" || n.op === "-") return linearInSeries(n.lhs) && linearInSeries(n.rhs);
      if (n.op === "*") return (n.lhs.k === "num" && linearInSeries(n.rhs)) || (n.rhs.k === "num" && linearInSeries(n.lhs));
      if (n.op === "/") return n.rhs.k === "num" && linearInSeries(n.lhs);
      return false;
    default:
      return false;
  }
}

/** AST fragment without source spans, for a finding's `original`. */
function stripSpans(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripSpans);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).filter(([k]) => k !== "span").map(([k, v]) => [k, stripSpans(v)]));
  return x;
}

/** Datadog wildcard value -> regex body. `*` matches anything; every other character is literal. */
function pattern(v: string): string {
  return v
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
}

function run(ctx: TranslateContext, interval: Duration, monitor: boolean, f: (l: Lowerer) => PNode): QueryTranslation & { node: PNode | null } {
  const l = new Lowerer(ctx, interval, monitor);
  let node: PNode | null = null;
  try {
    node = f(l);
  } catch (e) {
    if (!(e instanceof Manual)) throw e;
  }
  const r = l.result(node);
  return { ...r, node: r.promql ? node : null };
}

/** A dashboard query or formula. `env` maps formula refs (`query1`) to their parsed queries. */
export function translateQuery(e: Expr, ctx: TranslateContext = {}, env?: FormulaEnv): QueryTranslation {
  const { node: _n, ...r } = run(ctx, ctx.interval ?? "$__interval", false, (l) => l.expr(e, env).node);
  return r;
}

export interface MonitorTranslation extends QueryTranslation {
  /** Dash0 check-rule thresholds; the expression always ends in `> $__threshold` or `>= $__threshold`. */
  thresholds: { failed: number; degraded?: number } | null;
  /** True when `<`/`<=` was turned into `-(expr) > $__threshold` (maths.md T7): the alert value shown is negated. */
  negated: boolean;
}

/** A metric/query alert monitor. `critical`/`warning` come from options.thresholds (critical defaults to the query's threshold). */
export function translateMonitor(
  mq: MonitorQuery,
  opts: { critical?: number; warning?: number } = {},
  ctx: TranslateContext = {},
): MonitorTranslation {
  let thresholds: MonitorTranslation["thresholds"] = null;
  let negated = false;
  const r = run(ctx, 60, true, (l) => {
    if (mq.windowKind !== "last") l.manual("monitor.window.kind", `${mq.window} windows are not supported (only last_*)`);
    if (!["avg", "sum", "min", "max"].includes(mq.timeAgg)) l.manual("monitor.time-agg", `monitor time aggregation ${mq.timeAgg}()`);
    if (mq.windowSeconds % 60 !== 0) l.manual("monitor.window.width", "monitor window must be whole minutes");
    // sum(last_W):q.as_count(): the window total is increase over the whole window (no 1m subquery).
    if (mq.timeAgg === "sum" && !mq.change) l.monitorSumWindow = mq.windowSeconds;
    l.monitorWindow = mq.windowSeconds;
    const lowered = l.expr(mq.query);
    let expr: PNode;
    if (!lowered.windowed && l.sawWindowed)
      l.manual("monitor.as_count", "sum(last_W) with .as_count() inside a function: the window total can't be taken from per-bucket values");
    if (lowered.windowed) {
      l.use("monitor.sum.as_count");
      expr = lowered.node;
    } else {
      l.use("monitor.window");
      expr = { k: "call", fn: `${mq.timeAgg}_over_time`, args: [{ k: "subquery", expr: lowered.node, range: mq.windowSeconds, step: 60 }] };
    }

    // change(fn(last_W), last_C): X - X offset C; pct_change: 100 * (X - X offset C) / X offset C.
    if (mq.change) {
      const c = mq.change.compareWindowSeconds;
      if (c % 60 !== 0) l.manual("monitor.change.window", "change() compare window must be whole minutes");
      const before = mapSelectors(expr, (sel) => {
        if (typeof sel.offset === "string") return l.manual("monitor.change.offset", "change() over a query with a variable offset");
        return { ...sel, offset: (sel.offset ?? 0) + c };
      });
      l.use("monitor.change");
      const delta: PNode = { k: "binary", op: "-", lhs: expr, rhs: before };
      if (mq.change.kind === "change") expr = delta;
      else {
        l.use("arith.div");
        expr = { k: "binary", op: "*", lhs: { k: "num", value: 100 }, rhs: { k: "binary", op: "/", lhs: delta, rhs: before } };
      }
    }

    // The query's threshold is what Datadog evaluates; options.thresholds.critical should equal it.
    const crit = mq.threshold;
    if (opts.critical !== undefined && opts.critical !== crit) {
      l.assume("A.query-threshold");
      l.find("exact-under", "monitor.threshold.mismatch", `options.thresholds.critical (${opts.critical}) differs from the query threshold (${crit}); using the query's`, {
        assumptions: ["A.query-threshold"],
      });
    }
    let op: ">" | ">=" = ">"; // every other branch below either sets it or throws
    if (mq.op === ">" || mq.op === ">=") {
      l.use("monitor.cmp.gt");
      op = mq.op;
      thresholds = { failed: crit, ...(opts.warning !== undefined ? { degraded: opts.warning } : {}) };
    } else if (mq.op === "<" || mq.op === "<=") {
      l.use("monitor.cmp.lt");
      op = mq.op === "<" ? ">" : ">=";
      negated = true;
      expr = { k: "neg", expr };
      thresholds = { failed: -crit, ...(opts.warning !== undefined ? { degraded: -opts.warning } : {}) };
    } else {
      // == T / != T: compare the distance to T against a threshold of 0 (one level only: Dash0 runs the expression once per threshold).
      if (opts.warning !== undefined) l.manual("monitor.cmp.eq.warning", `comparator ${mq.op} with a warning threshold has no check-rule form`);
      l.use("monitor.cmp.eq");
      const dist: PNode = { k: "call", fn: "abs", args: [{ k: "binary", op: "-", lhs: expr, rhs: { k: "num", value: crit } }] };
      expr = mq.op === "==" ? { k: "neg", expr: dist } : dist;
      op = mq.op === "==" ? ">=" : ">";
      thresholds = { failed: 0 };
    }
    return { k: "binary", op, lhs: expr, rhs: { k: "placeholder", name: "$__threshold" } };
  });
  const { node: _n, ...rest } = r;
  if (!rest.promql) {
    thresholds = null;
    negated = false;
  }
  return { ...rest, thresholds, negated };
}
