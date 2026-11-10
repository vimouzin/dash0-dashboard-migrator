// Datadog log-search query parser (T12). Hand-written recursive descent: deterministic, no I/O, no LLM.
// Grammar (informal):
//   query  := or
//   or     := and ('OR' and)*
//   and    := unary (('AND' | <whitespace>) unary)*
//   unary  := ('-' | 'NOT') unary | atom
//   atom   := '(' or ')' | '$'VAR | KEY ':' value | '"phrase"' | WORD
//   value  := '(' v ('OR' v)* ')' | '"quoted"' | CMP NUMBER | '[' a 'TO' b ']' | WORD (may contain * wildcards)
// Keys: reserved (source, service, host, status, env, ...) or facets (@attr.path).

export type LogNode =
  | { type: "term"; key: string; values: LogValue[]; negated: boolean; pos: number } // key:(a OR b) has several values
  | { type: "range"; key: string; raw: string; pos: number } // @x:>100, @x:[1 TO 5]
  | { type: "var"; name: string; negated: boolean; pos: number } // $Host
  | { type: "text"; value: string; quoted: boolean; negated: boolean; pos: number } // free-text search
  | { type: "and"; items: LogNode[] }
  | { type: "or"; items: LogNode[] }
  | { type: "not"; expr: LogNode };

/** A value: literal text (quoted or not) with `*` wildcards when unquoted. */
export interface LogValue {
  text: string;
  quoted: boolean;
}

export type LogParseResult = { ok: true; value: LogNode | null } | { ok: false; error: { message: string; pos: number; source: string } };

class Fail extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

// A word runs until whitespace, a paren, or a quote. Escaped characters (\: \( \ ) are part of the word.
const WORD_STOP = /[\s()"]/;
const MAX_DEPTH = 100;

class Parser {
  pos = 0;
  depth = 0;
  constructor(readonly src: string) {}

  fail(message: string, pos = this.pos): never {
    throw new Fail(message, pos);
  }
  peek(o = 0): string {
    return this.src[this.pos + o] ?? "";
  }
  ws(): void {
    while (/\s/.test(this.peek())) this.pos++;
  }
  eof(): boolean {
    this.ws();
    return this.pos >= this.src.length;
  }
  keyword(kw: string): boolean {
    this.ws();
    const after = this.src[this.pos + kw.length] ?? "";
    if (this.src.startsWith(kw, this.pos) && (after === "" || /[\s(]/.test(after))) {
      this.pos += kw.length;
      return true;
    }
    return false;
  }
  atKeyword(kw: string): boolean {
    const save = this.pos;
    const ok = this.keyword(kw);
    this.pos = save;
    return ok;
  }

  or(): LogNode {
    if (++this.depth > MAX_DEPTH) this.fail(`nesting deeper than ${MAX_DEPTH} levels`);
    try {
      const items = [this.and()];
      while (this.keyword("OR")) items.push(this.and());
      return items.length === 1 ? items[0]! : { type: "or", items };
    } finally {
      this.depth--;
    }
  }

  and(): LogNode {
    const items = [this.unary()];
    for (;;) {
      if (this.keyword("AND")) {
        items.push(this.unary());
        continue;
      }
      this.ws();
      if (this.pos >= this.src.length || this.peek() === ")" || this.atKeyword("OR")) break;
      items.push(this.unary()); // implicit AND
    }
    return items.length === 1 ? items[0]! : { type: "and", items };
  }

  unary(): LogNode {
    this.ws();
    if (this.keyword("NOT")) return negate(this.unary());
    if (this.peek() === "-" && this.peek(1) !== "" && !/\s/.test(this.peek(1))) {
      this.pos++;
      return negate(this.atom());
    }
    return this.atom();
  }

  atom(): LogNode {
    this.ws();
    const start = this.pos;
    const c = this.peek();
    if (c === "") this.fail("unexpected end of query");
    if (c === "(") {
      this.pos++;
      const inner = this.or();
      this.ws();
      if (this.peek() !== ")") this.fail("expected ')'");
      this.pos++;
      return inner;
    }
    if (c === ")") this.fail("unexpected ')'");
    if (c === '"') return { type: "text", value: this.quoted(), quoted: true, negated: false, pos: start };
    if (c === "$") {
      this.pos++;
      const m = /^[A-Za-z0-9_.-]+/.exec(this.src.slice(this.pos));
      if (!m) this.fail("expected a template variable name");
      this.pos += m[0].length;
      return { type: "var", name: m[0].replace(/\.(value|key)$/, ""), negated: false, pos: start };
    }
    // key:value, or a bare word. Find an unescaped ':' inside the word.
    const word = this.word();
    const colon = findColon(word);
    if (colon < 0) return { type: "text", value: unescape(word), quoted: false, negated: false, pos: start };
    const key = unescape(word.slice(0, colon));
    if (!key) this.fail("empty key before ':'", start);
    const rest = word.slice(colon + 1);
    if (rest === "") {
      // key:(a OR b) or key:"quoted" follows directly
      if (this.peek() === "(") {
        const g = this.valueGroup();
        // key:(a b) means both values (AND); key:(a OR b) means either.
        if (g.op === "and") return { type: "and", items: g.values.map((v) => ({ type: "term" as const, key, values: [v], negated: false, pos: start })) };
        return { type: "term", key, values: g.values, negated: false, pos: start };
      }
      if (this.peek() === '"') return { type: "term", key, values: [{ text: this.quoted(), quoted: true }], negated: false, pos: start };
      if (this.peek() === "[" || this.peek() === "{") return { type: "range", key, raw: this.word(), pos: start };
      this.fail(`expected a value after '${key}:'`);
    }
    if (/^[<>]=?/.test(rest) || /^[[{]/.test(rest)) return { type: "range", key, raw: rest, pos: start };
    return { type: "term", key, values: [{ text: unescape(rest), quoted: false }], negated: false, pos: start };
  }

  word(): string {
    const start = this.pos;
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === "\\" && this.pos + 1 < this.src.length) {
        this.pos += 2;
        continue;
      }
      if (WORD_STOP.test(ch)) {
        // A range like [1 TO 5] is one value; keep scanning inside brackets.
        if (/\s/.test(ch) && /[[{]/.test(this.src.slice(start, this.pos)) && !/[\]}]/.test(this.src.slice(start, this.pos))) {
          this.pos++;
          continue;
        }
        break;
      }
      this.pos++;
    }
    if (this.pos === start) this.fail(`unexpected '${this.peek()}'`);
    return this.src.slice(start, this.pos);
  }

  quoted(): string {
    const start = this.pos;
    this.pos++; // opening quote
    let out = "";
    while (this.pos < this.src.length && this.peek() !== '"') {
      if (this.peek() === "\\" && this.pos + 1 < this.src.length) this.pos++;
      out += this.peek();
      this.pos++;
    }
    if (this.peek() !== '"') this.fail("unterminated quoted string", start);
    this.pos++;
    return out;
  }

  /** key:(a OR b OR "c d"), or key:(a b) for "both" (one operator per group). */
  valueGroup(): { values: LogValue[]; op: "or" | "and" } {
    this.pos++; // (
    const values: LogValue[] = [];
    let op: "or" | "and" | null = null;
    for (;;) {
      this.ws();
      if (this.peek() === '"') values.push({ text: this.quoted(), quoted: true });
      else {
        const w = this.word();
        values.push({ text: unescape(w), quoted: false });
      }
      this.ws();
      if (this.peek() === ")") {
        this.pos++;
        return { values, op: op ?? "or" };
      }
      const next: "or" | "and" = this.keyword("OR") ? "or" : (this.keyword("AND"), "and");
      if (op !== null && op !== next) this.fail("mixed AND/OR inside key:(...)");
      op = next;
    }
  }
}

function negate(n: LogNode): LogNode {
  if (n.type === "term" || n.type === "var" || n.type === "text") return { ...n, negated: !n.negated };
  return { type: "not", expr: n };
}

function findColon(word: string): number {
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "\\") {
      i++;
      continue;
    }
    if (word[i] === ":") return i;
  }
  return -1;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/** Parse a Datadog log-search query. Empty or `*` means "all logs" (value null). Never throws on bad input. */
export function parseLogSearch(src: string): LogParseResult {
  const trimmed = src.trim();
  if (trimmed === "" || trimmed === "*") return { ok: true, value: null };
  const p = new Parser(src);
  try {
    const value = p.or();
    if (!p.eof()) p.fail(`unexpected '${p.peek()}'`);
    return { ok: true, value };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { message: e.message, pos: e.pos, source: src } };
    if (e instanceof RangeError) return { ok: false, error: { message: `query too complex: ${e.message}`, pos: p.pos, source: src } };
    throw e;
  }
}
