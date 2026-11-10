// PromQL as a structure (dash0-migrator skill rule 3), rendered deterministically:
// matchers sorted, durations in their largest exact unit, minimal parentheses by precedence.

/** Seconds, or a dashboard variable such as "$__interval". */
export type Duration = number | `$${string}`;

export interface PMatcher {
  label: string;
  op: "=" | "!=" | "=~" | "!~";
  value: string;
}

export type PNode =
  | { k: "selector"; matchers: PMatcher[]; range?: Duration; anchored?: boolean; offset?: Duration; at?: "end()" | "start()" }
  | { k: "call"; fn: string; args: PNode[] }
  /** `by` lists the grouping labels; with `without: true` they are the labels aggregated away instead (`sum without (db) (x)`). */
  | { k: "agg"; op: "avg" | "sum" | "min" | "max" | "count"; by: string[]; without?: boolean; expr: PNode }
  | { k: "binary"; op: "+" | "-" | "*" | "/" | ">" | ">=" | "<" | "<=" | "==" | "!=" | "or"; lhs: PNode; rhs: PNode }
  | { k: "num"; value: number }
  | { k: "neg"; expr: PNode }
  | { k: "subquery"; expr: PNode; range: Duration; step: Duration }
  /** A placeholder Dash0 substitutes, e.g. `$__threshold`. */
  | { k: "placeholder"; name: `$${string}` };

// PromQL precedence, loosest first: or < comparisons < + - < * /.
const PREC: Record<string, number> = { or: 0, ">": 1, ">=": 1, "<": 1, "<=": 1, "==": 1, "!=": 1, "+": 2, "-": 2, "*": 3, "/": 3 };

export function formatDuration(d: Duration): string {
  if (typeof d === "string") return d;
  if (!Number.isInteger(d) || d <= 0) throw new Error(`invalid duration ${d}`);
  for (const [unit, s] of [
    ["w", 604800],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ] as const) {
    if (d % s === 0) return `${d / s}${unit}`;
  }
  return `${d}s`;
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "+Inf" : "-Inf";
  return String(n);
}

const escapeString = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function sortMatchers(ms: PMatcher[]): PMatcher[] {
  return [...ms].sort((a, b) =>
    a.label !== b.label
      ? a.label === "otel_metric_name"
        ? -1
        : b.label === "otel_metric_name"
          ? 1
          : a.label < b.label
            ? -1
            : 1
      : a.op !== b.op
        ? (a.op < b.op ? -1 : 1)
        : a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0,
  );
}

export function render(n: PNode): string {
  switch (n.k) {
    case "selector": {
      const m = sortMatchers(n.matchers)
        .map((x) => `${x.label}${x.op}"${escapeString(x.value)}"`)
        .join(", ");
      let s = `{${m}}`;
      if (n.range !== undefined) s += `[${formatDuration(n.range)}]${n.anchored ? " anchored" : ""}`;
      if (n.at) s += ` @ ${n.at}`;
      if (n.offset !== undefined && n.offset !== 0) s += ` offset ${formatDuration(n.offset)}`;
      return s;
    }
    case "call":
      return `${n.fn}(${n.args.map(render).join(", ")})`;
    case "agg":
      return `${n.op}${n.by.length ? ` ${n.without ? "without" : "by"} (${[...n.by].sort().join(", ")})` : ""} (${render(n.expr)})`;
    case "num":
      return formatNumber(n.value);
    case "placeholder":
      return n.name;
    case "neg": {
      const inner = render(n.expr);
      return n.expr.k === "binary" ? `-(${inner})` : `-${inner}`;
    }
    case "subquery":
      return `(${render(n.expr)})[${formatDuration(n.range)}:${formatDuration(n.step)}]`;
    case "binary": {
      const p = PREC[n.op]!;
      const side = (c: PNode, right: boolean) => {
        const s = render(c);
        if (c.k !== "binary") return s;
        const cp = PREC[c.op]!;
        // Left-associative: parenthesise a lower-precedence child, or an equal-precedence right child.
        return cp < p || (right && cp === p) ? `(${s})` : s;
      };
      return `${side(n.lhs, false)} ${n.op} ${side(n.rhs, true)}`;
    }
  }
}

/** Apply `f` to every selector in the tree (used for offset and range rewrites). */
export function mapSelectors(n: PNode, f: (s: Extract<PNode, { k: "selector" }>) => PNode): PNode {
  switch (n.k) {
    case "selector":
      return f(n);
    case "call":
      return { ...n, args: n.args.map((a) => mapSelectors(a, f)) };
    case "agg":
    case "neg":
    case "subquery":
      return { ...n, expr: mapSelectors(n.expr, f) };
    case "binary":
      return { ...n, lhs: mapSelectors(n.lhs, f), rhs: mapSelectors(n.rhs, f) };
    default:
      return n;
  }
}
