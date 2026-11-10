// Datadog query AST (T3). Local to src/parse until the IR (T1) lands; T4 lowers this to PromQL.
// Every node carries a `span` into the source string so findings and the report can point at it.

export interface Span {
  start: number; // inclusive offset into the source string
  end: number; // exclusive
}

// ---------- scope: the part inside {...} ----------

export type ScopeExpr =
  | { type: "all"; span: Span } // `*`
  | { type: "tag"; key: string | null; value: string; negated: boolean; span: Span } // `env:prod`, `!host:a`, `-host:a`, bare `prod`
  | { type: "var"; name: string; field: string | null; negated: boolean; span: Span } // `$scope`, `$env.value`
  | { type: "in"; key: string; values: string[]; negated: boolean; span: Span } // `kind IN (a,b)`, `kind NOT IN (a,b)`
  | { type: "and"; items: ScopeExpr[]; span: Span } // `,` or `AND`
  | { type: "or"; items: ScopeExpr[]; span: Span }
  | { type: "not"; expr: ScopeExpr; span: Span };

// ---------- metric expressions ----------

/** Argument of a function or postfix call: an expression, a quoted string, a bare word (e.g. `sum`, `null`), or `name=value`. */
export type Arg =
  | { type: "expr"; expr: Expr; span: Span }
  | { type: "string"; value: string; span: Span }
  | { type: "word"; value: string; span: Span }
  | { type: "tags"; tags: string[]; span: Span } // `{ a, b }`, e.g. `sum(q, {availability_group_name})`
  | { type: "named"; name: string; value: Arg; span: Span };

/** `.as_count()`, `.rollup(sum, 60)`, `.fill(null)` ... Parsed generically; T4 decides what each means. */
export interface PostfixCall {
  name: string;
  args: Arg[];
  span: Span;
}

export interface MetricQuery {
  type: "metric";
  /** `avg|sum|min|max|count|pNN`, or null for the legacy form without an aggregator. */
  spaceAgg: string | null;
  /** Distribution value filter, `count(v: v>=0):metric` -> `{ op: ">=", value: 0 }`. */
  valueFilter: { op: Comparator; value: number } | null;
  metric: string;
  /** null when the query has no `{...}` at all (legacy form). */
  scope: ScopeExpr | null;
  groupBy: string[];
  span: Span;
}

export type Expr =
  | MetricQuery
  | { type: "number"; value: number; raw: string; span: Span }
  | { type: "ref"; name: string; span: Span } // formula reference: `query1`, `a`
  | { type: "call"; name: string; args: Arg[]; span: Span } // `diff(q)`, `top(q, 10, 'mean', 'desc')`
  | { type: "postfix"; target: Expr; call: PostfixCall; span: Span } // `q.as_count()`
  | { type: "binary"; op: "+" | "-" | "*" | "/"; left: Expr; right: Expr; span: Span }
  | { type: "neg"; expr: Expr; span: Span }
  | { type: "paren"; expr: Expr; span: Span };

// ---------- monitor queries ----------

export type Comparator = ">" | ">=" | "<" | "<=" | "==" | "!=";

export interface MonitorQuery {
  type: "monitor";
  /** `avg|sum|min|max|...` from `avg(last_5m)`. */
  timeAgg: string;
  /** `last_5m` etc. Kept raw, plus parsed seconds. `current_1h` (calendar-aligned) and `next_12h` (forecast) also parse. */
  window: string;
  windowKind: "last" | "current" | "next";
  windowSeconds: number;
  /** `change(avg(last_5m),last_1h)` / `pct_change(...)`: compare against the value one `compareWindow` earlier. */
  change: { kind: "change" | "pct_change"; compareWindow: string; compareWindowSeconds: number } | null;
  query: Expr;
  op: Comparator;
  threshold: number;
  span: Span;
}

export interface ParseError {
  message: string;
  /** Offset into the source string where parsing failed. */
  pos: number;
  source: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseError };
