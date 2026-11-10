// Datadog log_stream / list_stream -> Dash0 LogTable panel (rule logs.stream).
// The log search (parsed by T12's parseLogSearch) becomes Dash0 AttributeFilters, which are AND-ed. Deterministic,
// no I/O. Fail closed: a search with no AND-of-filters form (OR across keys, NOT over a group, wildcard free text)
// returns `manual` and T5 keeps the placeholder.
//
// Dash0 LogTable spec (docs, verified 2026-11-07): {filters?: AttributeFilter[], sort?: {sortField?, sortDirection?},
// maxLogEntries?, showAttributePreview?, activeColumns?}. AttributeFilter: {key, operator, value? | values?}, operators
// is, is_not, is_set, is_not_set, is_one_of, is_not_one_of, gt, gte, lt, lte, matches, does_not_match, contains,
// does_not_contain, starts_with, does_not_start_with, ends_with, does_not_end_with.
// Note: Dash0's negative operators only match records that HAVE the attribute; Datadog's `-key:v` also matches
// records without it. That gap is the assumption A.logtable-negation.
import type { Finding, Panel, Status } from "../../ir/index.js";
import { worst } from "../../ir/index.js";
import { parseLogSearch, type LogNode, type LogValue } from "../../parse/logsearch/index.js";
import type { LogAttributes } from "../logs/index.js";

export interface AttributeFilter {
  key: string;
  operator: string;
  value?: string;
  values?: string[];
}

export interface LogTableSpec {
  filters?: AttributeFilter[];
  sort?: { sortDirection: "asc" | "desc" };
}

export interface LogTableTranslation {
  status: Status;
  /** null when the search has no filter form (the caller keeps a placeholder). */
  spec: LogTableSpec | null;
  rules: string[];
  /** Assumption ids (A.*). */
  assumptions: string[];
  findings: Finding[];
}

/** Assumption wording (requested from T17 along with the logs.stream.* rows). */
export const LOGTABLE_ASSUMPTIONS: Record<string, string> = {
  "A.logtable-keys": "Dash0 LogTable filter keys are the dotted forms of the dash0.logs labels (service.name, otel.log.severity.range, otel.log.body)",
  "A.logtable-negation": "records filtered by a negation carry the attribute (Dash0's negative operators skip records without it; Datadog's -key:v keeps them)",
  "A.numeric-attr": "the attribute holds numbers, so Dash0 compares it numerically as Datadog does",
  "A.log-source": "logs carry Datadog's `source` as a `source` attribute (set by the shipper); OTel has no built-in equivalent",
  "A.log-attr-default": "a log attribute without a table entry keeps its name in OTel (dots become underscores in the label)",
  "A.log-fulltext": "Datadog's free-text match of a word equals a case-insensitive substring match on the log body",
  "A.severity-map": "the Datadog status maps to the OTel severity range listed in mappings/log-attributes.yaml (no 1:1 level)",
  "A.var-default": "a free-form template variable (no tag key) is left at its default '*', so dropping it filters nothing",
  "A.all-indexes": "every Datadog log index is queried (Dash0 has no indexes)",
  "A.style": "fonts, colours, alignment, legend placement and free-layout positions are not part of the panel's meaning",
};

/**
 * Datadog reserved key -> OTel attribute key for LogTable filters. Each must be the dotted form of the dash0.logs
 * label in mappings/log-attributes.yaml (a test checks this). trace_id is left out: its label (otel_log_trace_id) is
 * a log-record field whose filter key isn't verified, so it fails closed.
 */
const RESERVED_KEYS: Record<string, string> = {
  service: "service.name",
  host: "host.name",
  env: "deployment.environment.name",
  version: "service.version",
  source: "source",
};
export const SEVERITY_KEY = "otel.log.severity.range";
export const BODY_KEY = "otel.log.body";
export const RESERVED_FILTER_KEYS: Readonly<Record<string, string>> = RESERVED_KEYS;

class Manual extends Error {}

class Lowerer {
  rules: string[] = ["logs.stream"];
  assumptions: string[] = ["A.logtable-keys"];
  findings: Finding[] = [];
  status: Status = "exact-under";
  constructor(
    readonly attributes: LogAttributes,
    readonly variables: Record<string, { tag: string | null }>,
    readonly itemId: string,
  ) {}

  use(rule: string, assumptions: string[] = [], status: Status = assumptions.length ? "exact-under" : "exact"): void {
    if (!this.rules.includes(rule)) this.rules.push(rule);
    for (const a of assumptions) if (!this.assumptions.includes(a)) this.assumptions.push(a);
    this.status = worst(this.status, status);
  }
  find(status: Finding["status"], code: string, message: string, original?: string, assumptions: string[] = []): void {
    if (this.findings.some((f) => f.code === code && f.message === message)) return;
    this.findings.push({
      status,
      code,
      message,
      itemKind: "panel",
      itemId: this.itemId,
      ...(status === "exact-under" && { ruleId: code }),
      ...(assumptions.length && { assumptions: assumptions.map((a) => LOGTABLE_ASSUMPTIONS[a] ?? a) }),
      ...(original !== undefined && { original }),
    });
  }
  /**
   * Fail closed. `reason` is the specific construct (kept in the message); the finding code is the catalog's:
   * query.parse_error for a search that doesn't parse (logs.unparsed), query.datasource otherwise (widget.logs).
   */
  manual(reason: string, message: string, original?: string): never {
    this.find("manual", reason === "log.search.parse" ? "query.parse_error" : "query.datasource", `${message} [${reason}]`, original);
    throw new Manual(message);
  }

  key(k: string): string {
    if (k.startsWith("@")) {
      const a = k.slice(1);
      this.use("log.match.attr", ["A.log-attr-default"]);
      return this.attributes.renames[a] ?? a;
    }
    const res = this.attributes.reserved[k];
    if (res) {
      const key = RESERVED_KEYS[k];
      if (!key) this.manual("logs.stream.key", `the reserved attribute '${k}' has no verified LogTable filter key`, k);
      if (res.status === "exact") this.use("log.match.reserved");
      else this.use("log.match.reserved.approx", ["A.log-source"]);
      return key;
    }
    // A tag without '@' (region, kube_namespace ...): a resource attribute of the same name.
    this.use("log.match.attr", ["A.log-attr-default"]);
    return this.attributes.renames[k] ?? k;
  }

  filters(n: LogNode | null): AttributeFilter[] {
    if (n === null) return [];
    switch (n.type) {
      case "and":
        return n.items.flatMap((i) => this.filters(i));
      case "or": {
        // Same key, no negation: key:a OR key:b is one is_one_of / matches filter.
        const terms = n.items.filter((i): i is Extract<LogNode, { type: "term" }> => i.type === "term" && !i.negated);
        if (terms.length !== n.items.length || new Set(terms.map((t) => t.key)).size !== 1)
          this.manual("logs.stream.or", "OR across different keys (or with free text) has no AND-of-filters form in a LogTable");
        return [this.term(terms[0]!.key, terms.flatMap((t) => t.values), false)];
      }
      case "not":
        return this.manual("logs.stream.not", "NOT over a compound log search has no LogTable filter form");
      case "range":
        return this.range(n.key, n.raw);
      case "var":
        return this.variable(n.name, n.negated);
      case "text":
        return [this.text(n.value, n.quoted, n.negated)];
      case "term":
        return [this.term(n.key, n.values, n.negated)];
    }
  }

  negation(): void {
    this.use("logs.stream.negation", ["A.logtable-negation"]);
  }

  term(k: string, values: LogValue[], negated: boolean): AttributeFilter {
    if (k === "status") return this.severity(values, negated);
    const key = this.key(k);
    this.use("log.match.value");
    if (negated) this.negation();
    if (values.length === 1 && !values[0]!.quoted && values[0]!.text === "*") return { key, operator: negated ? "is_not_set" : "is_set" };
    const parts = values.map((v) => segments(v));
    if (parts.every((p) => p.length === 1 && typeof p[0] === "string") || parts.every((p) => p.length === 0)) {
      const lits = parts.map((p) => (p[0] as string | undefined) ?? "");
      if (lits.length === 1) return { key, operator: negated ? "is_not" : "is", value: lits[0]! };
      return { key, operator: negated ? "is_not_one_of" : "is_one_of", values: [...new Set(lits)] };
    }
    if (parts.length === 1) {
      const p = parts[0]!;
      // *v*, v*, *v with one literal run: the dedicated string operators.
      const lit = p.filter((s): s is string => typeof s === "string");
      if (lit.length === 1 && p.length >= 2 && p.length <= 3) {
        const lead = p[0] === STAR;
        const trail = p[p.length - 1] === STAR;
        const op = lead && trail ? "contains" : trail ? "starts_with" : lead ? "ends_with" : null;
        if (op) return { key, operator: negated ? NEGATED[op]! : op, value: lit[0]! };
      }
    }
    const re = `^(${parts.map((p) => p.map((s) => (s === STAR ? ".*" : escapeRe(s))).join("")).join("|")})$`;
    return { key, operator: negated ? "does_not_match" : "matches", value: re };
  }

  severity(values: LogValue[], negated: boolean): AttributeFilter {
    const ranges = values.map((v) => {
      const s = this.attributes.severity[v.text.toLowerCase()];
      if (!s || v.text.includes("*")) this.manual("log.status.unknown", `status:${v.text} has no OTel severity range`, `status:${v.text}`);
      if (s.status === "exact") this.use("log.match.status");
      else this.use("log.match.status.approx", ["A.severity-map"]);
      return s.range;
    });
    if (negated) this.negation();
    const uniq = [...new Set(ranges)];
    if (uniq.length === 1) return { key: SEVERITY_KEY, operator: negated ? "is_not" : "is", value: uniq[0]! };
    return { key: SEVERITY_KEY, operator: negated ? "is_not_one_of" : "is_one_of", values: uniq };
  }

  text(value: string, quoted: boolean, negated: boolean): AttributeFilter {
    const segs = quoted ? [value] : segments({ text: value, quoted: false });
    if (segs.some((s) => s === STAR)) this.manual("logs.stream.text.wildcard", `free text with a wildcard (${value}) has no LogTable filter form`, value);
    this.use("log.match.text", ["A.log-fulltext"]);
    if (negated) this.negation();
    return { key: BODY_KEY, operator: negated ? "does_not_contain" : "contains", value: (segs[0] as string | undefined) ?? "" };
  }

  range(k: string, raw: string): AttributeFilter[] {
    const key = this.key(k);
    const num = (s: string) => {
      const t = s.trim();
      if (!/^-?\d+(\.\d+)?$/.test(t)) this.manual("logs.stream.range", `range bound '${t}' on ${k} is not a number`, `${k}:${raw}`);
      return t;
    };
    this.use("logs.stream.range", ["A.numeric-attr"]);
    const cmp = /^(>=|<=|>|<)\s*(.+)$/.exec(raw.trim());
    if (cmp) {
      const op = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" }[cmp[1]!]!;
      return [{ key, operator: op, value: num(cmp[2]!) }];
    }
    const br = /^([[{])\s*(\S+)\s+TO\s+(\S+)\s*([\]}])$/.exec(raw.trim());
    if (!br) return this.manual("logs.stream.range", `range ${raw} on ${k} is not understood`, `${k}:${raw}`);
    const out: AttributeFilter[] = [];
    if (br[2] !== "*") out.push({ key, operator: br[1] === "[" ? "gte" : "gt", value: num(br[2]!) });
    if (br[3] !== "*") out.push({ key, operator: br[4] === "]" ? "lte" : "lt", value: num(br[3]!) });
    return out;
  }

  variable(name: string, negated: boolean): AttributeFilter[] {
    // T5 pins every template variable to '*' (D-21), so a variable in the search filters nothing.
    const def = this.variables[name];
    if (negated) this.manual("log.var.negated", `negated template variable $${name}`, `-$${name}`);
    if (def && def.tag !== null) this.manual("logs.stream.var", `template variable $${name} on ${def.tag} has no LogTable filter form`, `$${name}`);
    this.use("log.match.var.dropped", ["A.var-default"]);
    this.find("exact-under", "log.match.var.dropped", `template variable $${name} dropped from the log search (exact while it is left at '*')`, `$${name}`, ["A.var-default"]);
    return [];
  }
}

const NEGATED: Record<string, string> = { contains: "does_not_contain", starts_with: "does_not_start_with", ends_with: "does_not_end_with" };
const STAR = Symbol("*");
type Seg = string | typeof STAR;

/** Unquoted value -> literal runs and `*` wildcards (backslash escapes a character). Quoted values are literal. */
function segments(v: LogValue): Seg[] {
  if (v.quoted) return v.text === "" ? [] : [v.text];
  const out: Seg[] = [];
  let cur = "";
  for (let i = 0; i < v.text.length; i++) {
    const c = v.text[i]!;
    if (c === "\\" && i + 1 < v.text.length) cur += v.text[++i];
    else if (c === "*") {
      if (cur) out.push(cur);
      cur = "";
      if (out[out.length - 1] !== STAR) out.push(STAR);
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The search string, indexes, columns and sort of a log_stream / list_stream panel (both IR shapes from T2). */
function streamParts(p: Panel): { search: string; indexes: string[]; columns: unknown[]; sort: { column?: string; order?: string } | null } {
  const q = p.requests[0]?.queries[0];
  const raw = (q?.raw ?? {}) as Record<string, any>;
  const def = ((p.original as any)?.definition ?? {}) as Record<string, any>;
  if (p.sourceType === "log_stream") {
    return { search: q?.expr ?? "", indexes: Array.isArray(raw.indexes) ? raw.indexes : [], columns: Array.isArray(raw.columns) ? raw.columns : [], sort: def.sort ?? null };
  }
  const query = (raw.query ?? {}) as Record<string, any>;
  return {
    search: q?.expr ?? "",
    indexes: Array.isArray(query.indexes) ? query.indexes : [],
    columns: Array.isArray(raw.columns) ? raw.columns : [],
    sort: query.sort ?? null,
  };
}

/** log_stream / list_stream panel -> LogTable spec. */
export function translateLogStream(p: Panel, attributes: LogAttributes, variables: Record<string, { tag: string | null }>, itemId: string): LogTableTranslation {
  const l = new Lowerer(attributes, variables, itemId);
  const fail = (): LogTableTranslation => ({ status: "manual", spec: null, rules: l.rules, assumptions: l.assumptions, findings: l.findings });
  try {
    if (p.requests.length !== 1 || p.requests[0]!.queries.length !== 1) l.manual("logs.stream.shape", "the log stream does not have exactly one query");
    const { search, indexes, columns, sort } = streamParts(p);
    const parsed = parseLogSearch(search);
    const filters = parsed.ok ? l.filters(parsed.value) : l.manual("log.search.parse", `log search does not parse: ${parsed.error.message} at ${parsed.error.pos}`, search);
    if (indexes.length && !indexes.every((i) => i === "*")) {
      l.use("log.indexes", ["A.all-indexes"]);
      l.find("exact-under", "log.indexes", `log indexes ${indexes.join(",")} have no Dash0 counterpart; showing all logs`, undefined, ["A.all-indexes"]);
    }
    if (columns.length) {
      l.use("panel.style", ["A.style"]);
      l.find("exact-under", "panel.style", "the stream's column choice is not migrated; the LogTable shows Dash0's default columns", JSON.stringify(columns), ["A.style"]);
    }
    const spec: LogTableSpec = {};
    if (filters.length) spec.filters = filters;
    const order = sort?.order;
    if ((order === "asc" || order === "desc") && (sort?.column === undefined || /^(time|timestamp)$/.test(String(sort.column)))) spec.sort = { sortDirection: order };
    l.find("exact-under", "logs.stream", `log stream shown as a Dash0 LogTable with ${filters.length} filter${filters.length === 1 ? "" : "s"}`, search, l.assumptions.filter((a) => a === "A.logtable-keys"));
    return { status: l.status, spec, rules: l.rules, assumptions: l.assumptions, findings: l.findings };
  } catch (e) {
    if (e instanceof Manual) return fail();
    throw e;
  }
}
