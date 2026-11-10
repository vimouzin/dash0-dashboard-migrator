// Datadog metric / formula / monitor query parser (T3).
// Hand-written, scannerless recursive descent. Deterministic, no I/O, no LLM.
// Grammar (informal):
//   expr     := add
//   add      := mul (('+'|'-') mul)*
//   mul      := unary (('*'|'/') unary)*
//   unary    := '-' unary | postfix
//   postfix  := primary ('.' IDENT '(' args ')')*
//   primary  := NUMBER | '(' expr ')' | IDENT '(' args ')' | metric | ref
//   metric   := [AGG ':'] NAME ['{' scope '}'] ['by' '{' tag (',' tag)* '}']
//   scope    := or ; or := and ('OR' and)* ; and := unary ((','|'AND') unary)*
//   sunary   := 'NOT' sunary | '(' or ')' | '*' | ['!'|'-'] ('$'VAR | TAG) | KEY ['NOT'] 'IN' '(' v (',' v)* ')'
//   monitor  := [('change'|'pct_change') '(' TAGG '(' WIN ')' ',' WIN ')' | TAGG '(' WIN ')'] ':' expr CMP NUMBER

import type {
  Arg,
  Comparator,
  Expr,
  MetricQuery,
  MonitorQuery,
  ParseResult,
  PostfixCall,
  ScopeExpr,
  Span,
} from "./ast.js";

type Mode = "query" | "formula";

class Fail extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

const SPACE_AGG = /^(avg|sum|min|max|count|p\d+(\.\d+)?)$/;
const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const METRIC_CHAR = /[A-Za-z0-9_.]/;
const COMPARATORS: Comparator[] = [">=", "<=", "==", "!=", ">", "<"];
const WINDOW_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000 };

const MAX_DEPTH = 200;

class Parser {
  pos = 0;
  depth = 0;
  constructor(
    readonly src: string,
    readonly mode: Mode,
  ) {}

  // ---------- low-level helpers ----------

  fail(message: string, pos = this.pos): never {
    throw new Fail(message, pos);
  }
  peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }
  eof(): boolean {
    return this.pos >= this.src.length;
  }
  ws(): void {
    while (/\s/.test(this.peek())) this.pos++;
  }
  span(start: number): Span {
    return { start, end: this.pos };
  }
  expect(ch: string): void {
    this.ws();
    if (this.peek() !== ch) this.fail(`expected '${ch}' but found ${this.describe()}`);
    this.pos++;
  }
  describe(): string {
    return this.eof() ? "end of input" : `'${this.peek()}'`;
  }
  ident(): string {
    const start = this.pos;
    if (!IDENT_START.test(this.peek())) this.fail(`expected an identifier but found ${this.describe()}`);
    while (IDENT_CHAR.test(this.peek())) this.pos++;
    return this.src.slice(start, this.pos);
  }
  /**
   * Keyword (case-insensitive) at the current position, after whitespace. Does not consume.
   * It must be followed by whitespace, '(' , '{' or the end, so tags like `not-ready` or `not.flag:1` stay tags.
   */
  atKeyword(kw: string): boolean {
    const save = this.pos;
    this.ws();
    const after = this.src[this.pos + kw.length] ?? "";
    const ok =
      this.src.slice(this.pos, this.pos + kw.length).toUpperCase() === kw.toUpperCase() && (after === "" || /[\s({]/.test(after));
    this.pos = save;
    return ok;
  }
  keyword(kw: string): void {
    this.ws();
    this.pos += kw.length;
  }
  end(): void {
    this.ws();
    if (!this.eof()) this.fail(`unexpected ${this.describe()}`);
  }

  // ---------- expressions ----------

  expr(): Expr {
    if (++this.depth > MAX_DEPTH) this.fail(`nesting deeper than ${MAX_DEPTH} levels`);
    try {
      return this.add();
    } finally {
      this.depth--;
    }
  }

  add(): Expr {
    const start = (this.ws(), this.pos);
    let left = this.mul();
    for (;;) {
      this.ws();
      const op = this.peek();
      if (op !== "+" && op !== "-") return left;
      this.pos++;
      const right = this.mul();
      left = { type: "binary", op, left, right, span: this.span(start) };
    }
  }

  mul(): Expr {
    const start = (this.ws(), this.pos);
    let left = this.unary();
    for (;;) {
      this.ws();
      const op = this.peek();
      if (op !== "*" && op !== "/") return left;
      this.pos++;
      const right = this.unary();
      left = { type: "binary", op, left, right, span: this.span(start) };
    }
  }

  unary(): Expr {
    this.ws();
    const start = this.pos;
    if (this.peek() === "-") {
      this.pos++;
      if (++this.depth > MAX_DEPTH) this.fail(`nesting deeper than ${MAX_DEPTH} levels`);
      let expr: Expr;
      try {
        expr = this.unary();
      } finally {
        this.depth--;
      }
      return { type: "neg", expr, span: this.span(start) };
    }
    if (this.peek() === "+") {
      if (++this.depth > MAX_DEPTH) this.fail(`nesting deeper than ${MAX_DEPTH} levels`);
      this.pos++; // unary plus is a no-op: `anomalies(+ avg:a{*}, ...)`
      try {
        return this.unary();
      } finally {
        this.depth--;
      }
    }
    return this.postfix(this.primary());
  }

  postfix(target: Expr): Expr {
    // `.name(` after the target; whitespace is allowed before the dot and before '('.
    while (/^\s*\.[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(this.src.slice(this.pos))) {
      this.ws();
      const callStart = this.pos;
      this.pos++;
      const name = this.ident();
      const args = this.args(true);
      const call: PostfixCall = { name, args, span: this.span(callStart) };
      target = { type: "postfix", target, call, span: { start: target.span.start, end: this.pos } };
    }
    return target;
  }

  primary(): Expr {
    this.ws();
    const start = this.pos;
    const c = this.peek();
    if (c === "(") {
      this.pos++;
      const expr = this.expr();
      this.expect(")");
      return { type: "paren", expr, span: this.span(start) };
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(this.peek(1)))) return this.number();
    if (!IDENT_START.test(c)) this.fail(`expected a query, number or '(' but found ${this.describe()}`);

    let word = this.ident();
    // `p99.9:` - ident() stops at '.', so take the decimal part of a percentile aggregator here.
    if (/^p\d+$/.test(word) && this.peek() === "." && /[0-9]/.test(this.peek(1))) {
      this.pos++;
      while (/[0-9]/.test(this.peek())) this.pos++;
      word = this.src.slice(start, this.pos);
      if (this.peek() !== ":") this.fail(`expected ':' after ${word}`);
    }
    if (this.peek() === ":") {
      if (!SPACE_AGG.test(word)) this.fail(`unknown space aggregator '${word}'`, start);
      this.pos++;
      return this.metric(start, word, this.pos, null);
    }
    if (this.peek() === "(" && SPACE_AGG.test(word) && /^\(\s*v\s*:/.test(this.src.slice(this.pos))) {
      const valueFilter = this.valueFilter();
      if (this.peek() !== ":") this.fail(`expected ':' after ${word}(v: ...)`);
      this.pos++;
      return this.metric(start, word, this.pos, valueFilter);
    }
    if (this.peek() === "(") {
      const args = this.args(false);
      return { type: "call", name: word, args, span: this.span(start) };
    }
    // In a formula a bare identifier is a query reference, also when a postfix call follows (`query1.rollup(sum, 60)`).
    const postfixNext = /^\s*\.[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(this.src.slice(this.pos));
    if (this.mode === "formula" && this.peek() !== "{" && (this.peek() !== "." || postfixNext)) {
      return { type: "ref", name: word, span: this.span(start) };
    }
    this.pos = start; // legacy form: bare metric name, no aggregator
    return this.metric(start, null, start, null);
  }

  /** `(v: v>=0)` on a distribution aggregator. */
  valueFilter(): { op: Comparator; value: number } {
    this.expect("(");
    this.ws();
    if (this.ident() !== "v") this.fail("expected 'v' in value filter");
    this.expect(":");
    this.ws();
    if (this.ident() !== "v") this.fail("expected 'v' in value filter");
    const op = this.comparator();
    const value = this.signedNumber();
    this.expect(")");
    return { op, value };
  }

  comparator(): Comparator {
    this.ws();
    const op = COMPARATORS.find((c) => this.src.startsWith(c, this.pos));
    if (!op) this.fail(`expected a comparator (> >= < <= == !=) but found ${this.describe()}`);
    this.pos += op.length;
    return op;
  }

  signedNumber(): number {
    this.ws();
    const neg = this.peek() === "-";
    if (neg || this.peek() === "+") {
      this.pos++;
      this.ws();
    }
    const num = this.number();
    const value = num.type === "number" ? num.value : NaN;
    return neg ? -value : value;
  }

  number(): Expr {
    const start = this.pos;
    const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (!m) this.fail("expected a number");
    this.pos += m[0].length;
    return { type: "number", value: Number(m[0]), raw: m[0], span: this.span(start) };
  }

  metric(
    start: number,
    spaceAgg: string | null,
    nameStart: number,
    valueFilter: MetricQuery["valueFilter"],
  ): MetricQuery {
    this.pos = nameStart;
    if (!IDENT_START.test(this.peek())) this.fail(`expected a metric name but found ${this.describe()}`);
    while (METRIC_CHAR.test(this.peek())) this.pos++;
    // `metric.as_count()` without a scope: the last dotted segment is a postfix call, not part of the name.
    if (this.peek() === "(") {
      const dot = this.src.lastIndexOf(".", this.pos - 1);
      if (dot <= nameStart) this.fail("expected a metric name, not a function call", nameStart);
      this.pos = dot;
    }
    let metric = this.src.slice(nameStart, this.pos);
    if (metric.endsWith(".")) this.fail("metric name ends with '.'", this.pos - 1);

    let scope: ScopeExpr | null = null;
    if (this.peek() === "{") {
      this.pos++;
      this.ws();
      if (this.peek() === "}") this.fail("empty scope '{}'");
      scope = this.scopeOr();
      this.expect("}");
    }

    const groupBy: string[] = [];
    if (this.atKeyword("by")) {
      this.keyword("by");
      this.expect("{");
      groupBy.push(...this.tagList());
    }
    return { type: "metric", spaceAgg, valueFilter, metric, scope, groupBy, span: this.span(start) };
  }

  /** Tag names after an opening '{', through the closing '}'. */
  tagList(): string[] {
    const tags: string[] = [];
    for (;;) {
      this.ws();
      const tagStart = this.pos;
      while (!/[\s,{}()]/.test(this.peek()) && !this.eof()) this.pos++;
      if (this.pos === tagStart) this.fail(`expected a tag name in '{...}' but found ${this.describe()}`);
      tags.push(this.src.slice(tagStart, this.pos));
      this.ws();
      if (this.peek() !== ",") break;
      this.pos++;
    }
    this.expect("}");
    return tags;
  }

  /**
   * `(arg, arg, ...)`. `wordsForBareIdents`: in postfix args (`rollup(sum, 60)`, `fill(null)`) a bare identifier is a word.
   * In function args it is a query (`abs(uptime)`) or, in a formula, a ref (`per_minute(query1)`).
   */
  args(wordsForBareIdents: boolean): Arg[] {
    this.expect("(");
    const args: Arg[] = [];
    this.ws();
    if (this.peek() === ")") {
      this.pos++;
      return args;
    }
    for (;;) {
      args.push(this.arg(wordsForBareIdents));
      this.ws();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() === ")") {
        this.pos++;
        return args;
      }
      this.fail(`expected ',' or ')' in argument list but found ${this.describe()}`);
    }
  }

  arg(wordsForBareIdents: boolean): Arg {
    this.ws();
    const start = this.pos;
    const c = this.peek();
    if (c === "'" || c === '"') {
      this.pos++;
      let value = "";
      for (;;) {
        if (this.eof()) this.fail("unterminated string", start);
        const ch = this.peek();
        this.pos++;
        if (ch === c) break;
        if (ch === "\\") {
          if (this.eof()) this.fail("unterminated string", start);
          value += this.peek(); // `\'` -> `'`, `\\` -> `\`
          this.pos++;
        } else value += ch;
      }
      return { type: "string", value, span: this.span(start) };
    }
    if (c === "{") {
      this.pos++;
      const tags = this.tagList();
      return { type: "tags", tags, span: this.span(start) };
    }
    if (IDENT_START.test(c)) {
      const word = this.ident();
      const afterWord = this.pos;
      this.ws();
      if (this.peek() === "=" && this.peek(1) !== "=") {
        this.pos++;
        const value = this.arg(true);
        return { type: "named", name: word, value, span: this.span(start) };
      }
      const next = this.peek();
      if ((next === "," || next === ")") && wordsForBareIdents) {
        this.pos = afterWord;
        return { type: "word", value: word, span: this.span(start) };
      }
      this.pos = start;
    }
    const expr = this.expr();
    return { type: "expr", expr, span: this.span(start) };
  }

  // ---------- scope ----------

  scopeOr(): ScopeExpr {
    if (++this.depth > MAX_DEPTH) this.fail(`scope nesting deeper than ${MAX_DEPTH} levels`);
    try {
      return this.scopeOrInner();
    } finally {
      this.depth--;
    }
  }

  scopeOrInner(): ScopeExpr {
    this.ws();
    const start = this.pos;
    const items = [this.scopeAnd()];
    while (this.atKeyword("OR")) {
      this.keyword("OR");
      items.push(this.scopeAnd());
    }
    return items.length === 1 ? items[0]! : { type: "or", items, span: this.span(start) };
  }

  scopeAnd(): ScopeExpr {
    this.ws();
    const start = this.pos;
    const items = [this.scopeUnary()];
    for (;;) {
      this.ws();
      if (this.peek() === ",") {
        this.pos++;
      } else if (this.atKeyword("AND")) {
        this.keyword("AND");
      } else break;
      items.push(this.scopeUnary());
    }
    return items.length === 1 ? items[0]! : { type: "and", items, span: this.span(start) };
  }

  scopeUnary(): ScopeExpr {
    this.ws();
    const start = this.pos;
    if (this.atKeyword("NOT") && !/^NOT\s+IN(?=[\s(])/i.test(this.src.slice(this.pos))) {
      this.keyword("NOT");
      const expr = this.scopeUnary();
      return { type: "not", expr, span: this.span(start) };
    }
    const c = this.peek();
    if (c === "(") {
      this.pos++;
      const inner = this.scopeOr();
      this.expect(")");
      return inner;
    }
    let negated = false;
    if (c === "!" || c === "-") {
      negated = true;
      this.pos++;
      this.ws();
    }
    if (this.peek() === "$") {
      this.pos++;
      // Variable names may contain '-' and '.' (`$availability-zone`, `$openai.user.api_key`);
      // a trailing `.value` / `.key` is the field accessor.
      const nameStart = this.pos;
      while (/[A-Za-z0-9_.\-]/.test(this.peek())) this.pos++;
      let name = this.src.slice(nameStart, this.pos);
      if (!/^[A-Za-z0-9_]/.test(name)) this.fail("expected a template variable name", nameStart);
      let field: string | null = null;
      const m = /^(.+)\.(value|key)$/.exec(name);
      if (m) {
        name = m[1]!;
        field = m[2]!;
      }
      return { type: "var", name, field, negated, span: this.span(start) };
    }
    const tokStart = this.pos;
    while (!/[\s,{}()]/.test(this.peek()) && !this.eof()) this.pos++;
    const tok = this.src.slice(tokStart, this.pos);
    if (!tok) this.fail(`expected a tag filter but found ${this.describe()}`);
    if (tok === "*" && !negated) return { type: "all", span: this.span(start) };

    // `key IN (...)` / `key NOT IN (...)`
    let inNegated = false;
    if (/^\s*NOT\s+IN(?=[\s(])/i.test(this.src.slice(this.pos))) {
      this.keyword("NOT");
      inNegated = true;
    }
    if (this.atKeyword("IN")) {
      this.keyword("IN");
      this.expect("(");
      const values: string[] = [];
      for (;;) {
        this.ws();
        const vStart = this.pos;
        while (!/[\s,()]/.test(this.peek()) && !this.eof()) this.pos++;
        if (this.pos === vStart) this.fail(`expected a value in IN (...) but found ${this.describe()}`);
        values.push(this.src.slice(vStart, this.pos));
        this.ws();
        if (this.peek() === ",") {
          this.pos++;
          continue;
        }
        break;
      }
      this.expect(")");
      return { type: "in", key: tok, values, negated: negated !== inNegated, span: this.span(start) };
    }
    if (inNegated) this.fail("expected 'IN' after 'NOT'");

    const colon = tok.indexOf(":");
    const key = colon < 0 ? null : tok.slice(0, colon);
    const value = colon < 0 ? tok : tok.slice(colon + 1);
    return { type: "tag", key, value, negated, span: this.span(start) };
  }

  // ---------- monitors ----------

  window(): { raw: string; kind: MonitorQuery["windowKind"]; seconds: number } {
    this.ws();
    const start = this.pos;
    const m = /^(last|current|next)_(\d+)(mo|[smhdw])\b/.exec(this.src.slice(this.pos));
    if (!m) this.fail(`expected a window like last_5m but found ${this.describe()}`, start);
    this.pos += m[0].length;
    return { raw: m[0], kind: m[1] as MonitorQuery["windowKind"], seconds: Number(m[2]) * WINDOW_UNITS[m[3]!]! };
  }

  monitor(): MonitorQuery {
    this.ws();
    const start = this.pos;
    let change: MonitorQuery["change"] = null;
    let timeAgg = this.ident();
    let win: ReturnType<Parser["window"]>;
    if (timeAgg === "change" || timeAgg === "pct_change") {
      const kind = timeAgg;
      this.expect("(");
      this.ws();
      timeAgg = this.ident();
      this.expect("(");
      win = this.window();
      this.expect(")");
      this.expect(",");
      const cmp = this.window();
      this.expect(")");
      change = { kind, compareWindow: cmp.raw, compareWindowSeconds: cmp.seconds };
    } else {
      this.expect("(");
      win = this.window();
      this.expect(")");
    }
    this.expect(":");
    const query = this.expr();
    const op = this.comparator();
    const threshold = this.signedNumber();
    this.end();
    return {
      type: "monitor",
      timeAgg,
      window: win.raw,
      windowKind: win.kind,
      windowSeconds: win.seconds,
      change,
      query,
      op,
      threshold,
      span: this.span(start),
    };
  }
}

function run<T>(src: string, mode: Mode, f: (p: Parser) => T): ParseResult<T> {
  const p = new Parser(src, mode);
  try {
    return { ok: true, value: f(p) };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { message: e.message, pos: e.pos, source: src } };
    // Last line of defence for the "never throws on bad input" contract (e.g. stack exhaustion).
    if (e instanceof RangeError) return { ok: false, error: { message: `input too complex: ${e.message}`, pos: p.pos, source: src } };
    throw e;
  }
}

/** A single metric query or query expression, e.g. `avg:redis.mem.used{$scope} by {host}.rollup(avg,60)`. */
export function parseQuery(src: string): ParseResult<Expr> {
  return run(src, "query", (p) => {
    const e = p.expr();
    p.end();
    return e;
  });
}

/** Legacy widget `q`: one or more comma-separated query expressions. */
export function parseQueryList(src: string): ParseResult<Expr[]> {
  return run(src, "query", (p) => {
    const list = [p.expr()];
    p.ws();
    while (p.peek() === ",") {
      p.pos++;
      list.push(p.expr());
      p.ws();
    }
    p.end();
    return list;
  });
}

/** Widget formula, e.g. `100 * query1 / (query1 + query2)`. Bare identifiers are query references. */
export function parseFormula(src: string): ParseResult<Expr> {
  return run(src, "formula", (p) => {
    const e = p.expr();
    p.end();
    return e;
  });
}

/** Metric/query alert monitor query, e.g. `avg(last_5m):avg:system.cpu.user{*} by {host} > 90`. */
export function parseMonitorQuery(src: string): ParseResult<MonitorQuery> {
  return run(src, "query", (p) => p.monitor());
}

/** Render a parse error with a caret under the failing position, for reports and test output. */
export function formatParseError(err: { message: string; pos: number; source: string }): string {
  return `${err.message} at ${err.pos}\n  ${err.source}\n  ${" ".repeat(err.pos)}^`;
}
