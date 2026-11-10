// Plan algebra shared by Datadog and PromQL (plan 03 §1, dash0-team workspace).
// A Datadog query lowers to a plan whose time aggregation runs in "bucket" mode;
// the PromQL we emit corresponds to a plan in "window" mode. The reference evaluator
// (evaluate.ts) gives both a meaning over in-memory series, so translation rules can be
// checked against each other on the same data. Times are Unix seconds.

export type Labels = Readonly<Record<string, string>>;

export interface Sample {
  readonly t: number;
  readonly v: number;
}

export interface Series {
  readonly labels: Labels; // "__name__" holds the metric name for raw series
  readonly samples: readonly Sample[]; // strictly increasing t
}

export type Store = readonly Series[];

/** Evaluation timestamps: start, start+step, ... <= end. */
export interface Grid {
  readonly start: number;
  readonly end: number;
  readonly step: number;
}

/**
 * bucket: Datadog rollup. Buckets [kW, (k+1)W) aligned to Unix time, labelled with their start kW.
 * window: PromQL range. Window (t-W, t] ending at each evaluation time t (left-open, Prometheus 3).
 */
export type Mode = "bucket" | "window";

export interface Matcher {
  readonly label: string;
  readonly type: "=" | "!=" | "=~" | "!~";
  readonly value: string;
}

export type TimeFn = "avg" | "sum" | "min" | "max" | "count" | "last";
export type SpaceFn = "avg" | "sum" | "min" | "max" | "count";
export type ArithOp = "+" | "-" | "*" | "/";
export type CompareOp = ">" | ">=" | "<" | "<=";

export type Plan =
  /** Raw series of one metric, filtered by label matchers. */
  | { readonly op: "select"; readonly metric: string; readonly matchers?: readonly Matcher[] }
  /** PromQL instant selector: the latest sample in (t - lookback, t]. Default lookback 300 s. */
  | { readonly op: "instant"; readonly lookback?: number; readonly input: Plan }
  /** Datadog rollup (bucket) or PromQL <fn>_over_time (window) over raw samples. */
  | { readonly op: "timeAgg"; readonly fn: TimeFn; readonly width: number; readonly mode: Mode; readonly input: Plan }
  /**
   * PromQL rate / increase over raw counter samples, window mode.
   * anchored=false: Prometheus extrapolatedRate. anchored=true: the baseline is the latest sample at or before t-W,
   * with no extrapolation.
   */
  | {
      readonly op: "counter";
      readonly fn: "increase" | "rate";
      readonly width: number;
      readonly anchored?: boolean;
      readonly input: Plan;
    }
  /** Aggregation across series at each timestamp, grouped by the listed labels (PromQL `by`, Datadog `by {}`). */
  | { readonly op: "spaceAgg"; readonly fn: SpaceFn; readonly by: readonly string[]; readonly input: Plan }
  /** Point-wise arithmetic. Series are matched on all labels except __name__, or on `on` when it is given. */
  | {
      readonly op: "binary";
      readonly operator: ArithOp;
      readonly left: Plan;
      readonly right: Plan;
      readonly on?: readonly string[];
    }
  | { readonly op: "const"; readonly value: number }
  | { readonly op: "neg"; readonly input: Plan }
  /**
   * fn over an inner aligned expression across a range.
   * window (PromQL subquery fn_over_time(inner[range:res])): inner is evaluated at multiples of res in (t-range, t].
   * bucket (Datadog monitor `fn(last_<range>)`): inner bucket values whose bucket [kres, (k+1)res) lies inside
   * [t-range, t).
   */
  | {
      readonly op: "subquery";
      readonly fn: TimeFn;
      readonly range: number;
      readonly resolution: number;
      readonly mode: Mode;
      readonly input: Plan;
    }
  /** Keeps only the points where `value op threshold` holds (PromQL filter comparison, Datadog monitor condition). */
  | { readonly op: "compare"; readonly operator: CompareOp; readonly threshold: number; readonly input: Plan };

export interface EvalOptions {
  /** Prometheus anchors regex matchers (^...$). Dash0 matches them unanchored (Dash0 PromQL patterns doc). */
  readonly regex?: "anchored" | "unanchored";
}
