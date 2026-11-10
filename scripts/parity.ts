// Data parity: do the migrated PromQL and the original Datadog query give the same NUMBER on the same data?
//
//   npx tsx --env-file=.env scripts/parity.ts <report.json> --host <host> [--match redis] [--window 30m] [--json out.json]
//
// Needs a source that feeds the SAME host to Datadog (agent) and Dash0 (OTel collector), and READ access to both
// (DD_API_KEY, DD_APP_KEY, DD_SITE; DASH0_API_URL, DASH0_AUTH_TOKEN, DASH0_DATASET). Nothing is written.
//
// For every item with exactly one PromQL query and Datadog source queries that return exactly ONE series each, it
// compares the MEAN over the window: Datadog's mean of the points of each source query (combined with the dashboard
// formula) against the mean of the Dash0 range query (step 60 s). Scoping: Datadog `{...}` -> `{host:<host>}`, `by {..}`
// dropped; Dash0 selectors get host_name="<host>" so a second collector in the org cannot skew the result.
//
// WHAT THIS IS: a spot check on one window and one load pattern. WHAT IT IS NOT: a proof. Read the verdicts so:
//   close     |diff| <= --tol (default 1%)        both sides non-zero: evidence the rule is right
//   trivial   both sides 0 (or both empty)        says nothing (nothing happened in the window)
//   differs   |diff| > tol                        investigate: sampling (bursty gauge, Datadog 15-20 s points vs the
//                                                 rule's per-bucket average) or a translation error
//   skipped   not comparable (several outputs, diff(), grouped series, no Datadog data): reason given
// Gauges that burst (connections) differ legitimately because the rule averages each bucket (assumption A.align).
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Verdict = "close" | "trivial" | "differs" | "skipped";
export interface Row {
  title: string;
  status: string;
  verdict: Verdict;
  datadog?: number;
  dash0?: number;
  diffPct?: number;
  reason?: string;
}

/** Datadog `{...}` scope -> the one host, `by {...}` removed (the host is a single series either way). */
export function scopeDatadog(q: string, host: string): string {
  return q.replace(/ by \{[^}]*\}/, "").replace(/\{[^}]*\}/, `{host:${host}}`);
}

/** Dashboard placeholders -> concrete values, and every selector pinned to the host. */
export function prepareDash0(q: string, host: string, window: string): string {
  return q
    .replace(/\$__rate_interval/g, "5m")
    .replace(/\$__interval/g, "1m")
    .replace(/\$__range/g, window)
    .replace(/\{otel_metric_name="([^"]+)"/g, `{otel_metric_name="$1", host_name="${host}"`);
}

/** Tiny evaluator for Datadog formulas: queryN, numbers, + - * / ( ) and per_minute(x). Returns null if it cannot. */
export function evalFormula(src: string, vars: Record<string, number>): number | null {
  const toks = src.match(/[A-Za-z_]\w*|\d+\.?\d*|[()+\-*/]/g);
  if (!toks || toks.join("") !== src.replace(/\s+/g, "")) return null;
  let p = 0;
  const expr = (): number => {
    let v = term();
    while (toks[p] === "+" || toks[p] === "-") v = toks[p++] === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (toks[p] === "*" || toks[p] === "/") v = toks[p++] === "*" ? v * unary() : v / unary();
    return v;
  };
  const unary = (): number => (toks[p] === "-" ? (p++, -unary()) : atom());
  const atom = (): number => {
    const t = toks[p++];
    if (t === undefined) throw new Error("end");
    if (t === "(") {
      const v = expr();
      if (toks[p++] !== ")") throw new Error("paren");
      return v;
    }
    if (/^\d/.test(t)) return Number(t);
    if (t === "per_minute" && toks[p] === "(") {
      p++;
      const v = expr();
      if (toks[p++] !== ")") throw new Error("paren");
      return v * 60;
    }
    if (t in vars) return vars[t];
    throw new Error(`unknown ${t}`);
  };
  try {
    const v = expr();
    return p === toks.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function verdictOf(dd: number, d0: number, tol: number): { verdict: Verdict; diffPct?: number } {
  if (Math.abs(dd) < 1e-12 && Math.abs(d0) < 1e-12) return { verdict: "trivial" };
  if (Math.abs(dd) < 1e-12) return { verdict: "differs" };
  const diffPct = ((d0 - dd) / Math.abs(dd)) * 100;
  return { verdict: Math.abs(diffPct) <= tol ? "close" : "differs", diffPct };
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const secs = (s: string) => {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`bad duration '${s}'`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
};

interface Env { dd: { site: string; key: string; app: string }; d0: { base: string; token: string; dataset: string } }

async function ddMean(q: string, from: number, to: number, e: Env): Promise<number | "multi" | "none"> {
  const u = `https://api.${e.dd.site}/api/v1/query?from=${from}&to=${to}&query=${encodeURIComponent(q)}`;
  const j = (await (await fetch(u, { headers: { "DD-API-KEY": e.dd.key, "DD-APPLICATION-KEY": e.dd.app } })).json()) as { series?: { pointlist: [number, number | null][] }[] };
  const s = j.series ?? [];
  if (s.length > 1) return "multi";
  const v = s.length ? s[0].pointlist.map((p) => p[1]).filter((x): x is number => x != null) : [];
  return v.length ? mean(v) : "none";
}

async function d0Mean(q: string, from: number, to: number, e: Env): Promise<number | "multi" | "none" | "error"> {
  const u = `${e.d0.base.replace(/\/$/, "")}/api/prometheus/api/v1/query_range?dataset=${encodeURIComponent(e.d0.dataset)}&query=${encodeURIComponent(q)}&start=${from}&end=${to}&step=60`;
  const j = (await (await fetch(u, { headers: { Authorization: `Bearer ${e.d0.token}` } })).json()) as { status?: string; data?: { result?: { values: [number, string][] }[] } };
  if (j.status !== "success") return "error";
  const s = j.data?.result ?? [];
  if (s.length > 1) return "multi";
  const v = s.length ? s[0].values.map((p) => Number(p[1])).filter(Number.isFinite) : [];
  return v.length ? mean(v) : "none";
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k: string, d?: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const file = a.find((x) => !x.startsWith("--"));
  const host = opt("--host");
  if (!file || !host) {
    console.error("usage: tsx --env-file=.env scripts/parity.ts <report.json> --host <host> [--match <text>] [--window 30m] [--tol 1] [--json out.json]");
    process.exit(2);
  }
  const env = process.env;
  for (const k of ["DD_API_KEY", "DD_APP_KEY", "DASH0_API_URL", "DASH0_AUTH_TOKEN"]) if (!env[k]) { console.error(`missing ${k}`); process.exit(2); }
  const e: Env = { dd: { site: env.DD_SITE || "datadoghq.eu", key: env.DD_API_KEY!, app: env.DD_APP_KEY! }, d0: { base: env.DASH0_API_URL!, token: env.DASH0_AUTH_TOKEN!, dataset: env.DASH0_DATASET || "default" } };
  const window = opt("--window", "30m")!;
  const tol = Number(opt("--tol", "1"));
  const to = Math.floor(Date.now() / 1000);
  const from = to - secs(window);
  const match = opt("--match");
  const report = JSON.parse(readFileSync(file, "utf8")) as { items: { title: string; status: string; dashboard?: string; kind?: string; promql?: string[]; source_queries?: string[]; source_formula?: string[] }[] };
  const items = report.items.filter((i) => i.promql?.length && (!match || `${i.dashboard ?? ""} ${i.title}`.toLowerCase().includes(match.toLowerCase())));
  const rows: Row[] = [];
  for (const it of items) {
    const base = { title: it.title, status: it.status };
    const skip = (reason: string) => rows.push({ ...base, verdict: "skipped", reason });
    const sq = it.source_queries ?? [];
    const fx = (it.source_formula ?? []).join("").replace(/^\[\s*|\s*\]$/g, "").replace(/'/g, "").trim();
    if (it.promql!.length !== 1) { skip("several outputs"); continue; }
    if (!sq.length) { skip("no Datadog source query in the report"); continue; }
    if (/diff\(/.test(fx)) { skip("diff() formula"); continue; }
    const vars: Record<string, number> = {};
    let why = "";
    for (let i = 0; i < sq.length; i++) {
      const v = await ddMean(scopeDatadog(sq[i], host), from, to, e);
      if (typeof v !== "number") { why = `Datadog query ${i + 1}: ${v === "multi" ? "several series" : "no data"}`; break; }
      vars[`query${i + 1}`] = v;
    }
    if (why) { skip(why); continue; }
    const ddv = sq.length === 1 && (!fx || /^query1$/.test(fx)) ? vars.query1 : evalFormula(fx.replace(/\s+/g, ""), vars);
    if (ddv === null) { skip(`formula not evaluable: ${fx}`); continue; }
    const d0v = await d0Mean(prepareDash0(it.promql![0], host, window), from, to, e);
    if (typeof d0v !== "number") { skip(`Dash0 query: ${d0v}`); continue; }
    rows.push({ ...base, datadog: ddv, dash0: d0v, ...verdictOf(ddv, d0v, tol) });
  }
  const f = (n?: number) => (n === undefined ? "" : Number(n.toPrecision(5)).toString());
  for (const r of rows) console.log(`${r.verdict.padEnd(8)} ${r.status.padEnd(11)} ${r.title.slice(0, 34).padEnd(34)} ${r.verdict === "skipped" ? r.reason : `DD ${f(r.datadog)}  Dash0 ${f(r.dash0)}  ${r.diffPct === undefined ? "" : r.diffPct.toFixed(2) + "%"}`}`);
  const c = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n${rows.length} items, window ${window}, host ${host}: close ${c("close")}, differs ${c("differs")}, trivial (both 0) ${c("trivial")}, skipped ${c("skipped")}`);
  const j = opt("--json");
  if (j) writeFileSync(j, JSON.stringify({ host, window, tolPct: tol, rows }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(e); process.exit(1); });
