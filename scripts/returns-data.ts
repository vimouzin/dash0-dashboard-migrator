// Does the translated PromQL actually return data in Dash0?
//
//   npx tsx --env-file=.env scripts/returns-data.ts <report.json> [--json out.json] [--md out.md]
//                                                   [--range 1h] [--step 60] [--concurrency 4] [--limit N]
//
// Input: the report.json of a `dd2dash0 migrate` run. For every panel/alert with PromQL, each query is run READ-ONLY
// (a RANGE query over --range, default 1h, step 60 s: any point of any series counts, as CONTRACT-003 §5.5 says; GET
// /api/prometheus/api/v1/query_range) after replacing the dashboard placeholders. Nothing is written.
//   $__interval -> 1m, $__rate_interval -> 5m, $__range -> --range (default 1h), template variables -> .*
//   alerts: the trailing `> $__threshold` is removed, so the question is "does the metric have data", not "is it firing".
// Per item: all | partial | none | error | n/a. An empty result is NOT necessarily a translation error: the source may
// not send the metric, or its labels differ. The cause hint says which case is likelier; it does not prove it.
// Output is a sidecar (keyed by item id) meant to be folded into report.json's checks.returnsData; it is time dependent,
// so it is never part of the deterministic report hash.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Returns = "all" | "partial" | "none" | "error" | "n/a";
export interface PrepareOpts {
  range: string;
  interval: string;
  rateInterval: string;
}
export const DEFAULTS: PrepareOpts = { range: "1h", interval: "1m", rateInterval: "5m" };

/** Dashboard/alert placeholders -> concrete values. Alerts lose their trailing threshold comparison. */
export function prepare(promql: string, kind: "panel" | "alert", o: PrepareOpts = DEFAULTS): string {
  let q = promql;
  if (kind === "alert") q = q.replace(/\s*(?:>=|>)\s*\$__threshold\s*$/, "");
  return q
    .replace(/\$__rate_interval/g, o.rateInterval)
    .replace(/\$__interval/g, o.interval)
    .replace(/\$__range/g, o.range)
    .replace(/\$__threshold/g, "0")
    .replace(/\$(?!__)[A-Za-z_]\w*/g, ".*");
}

export interface Outcome {
  /** true: at least one series; false: empty; null: the query errored. */
  returns: boolean | null;
  series: number;
  error?: string;
}

export interface Env {
  base: string;
  token: string;
  dataset: string;
  /** How far back to look, in seconds (the --range). */
  rangeSeconds: number;
  /** Range query step in seconds. */
  step: number;
  /** Unix seconds, injectable for tests. */
  now?: () => number;
}

/** "15m", "1h", "2d", "90s" -> seconds. Throws on anything else, so a typo in --range fails loudly. */
export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration '${s}' (use e.g. 30m, 1h, 2d)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

/**
 * One RANGE query over the last `env.rangeSeconds`: it returns data when ANY series has ANY point in that window
 * (a metric scraped every 10 minutes, or one that stopped 20 minutes ago, still counts as present).
 * Retries 429 and 5xx with backoff (Dash0 rate-limits), never throws.
 */
export async function runQuery(query: string, env: Env, fetchFn: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<Outcome> {
  const end = Math.floor((env.now ?? (() => Date.now() / 1000))());
  const start = end - env.rangeSeconds;
  const url = `${env.base.replace(/\/$/, "")}/api/prometheus/api/v1/query_range?dataset=${encodeURIComponent(env.dataset)}&query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${env.step}`;
  let last = "no response";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetchFn(url, { headers: { Authorization: `Bearer ${env.token}` } });
      if (r.status === 429 || r.status >= 500) {
        last = `HTTP ${r.status}`;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const j = (await r.json().catch(() => ({}))) as { status?: string; data?: { resultType?: string; result?: unknown }; error?: string; message?: string };
      if (r.status !== 200 || j.status !== "success") return { returns: null, series: 0, error: String(j.error ?? j.message ?? `HTTP ${r.status}`).slice(0, 200) };
      const res = j.data?.result;
      // matrix: [{metric, values: [[t, v], ...]}]. A series with no points does not count.
      const series = Array.isArray(res) ? res.filter((s) => !Array.isArray((s as { values?: unknown }).values) || ((s as { values: unknown[] }).values.length > 0)).length : 0;
      return { returns: series > 0, series };
    } catch (e) {
      last = String((e as Error).message ?? e);
      await sleep(1000 * 2 ** attempt);
    }
  }
  return { returns: null, series: 0, error: last };
}

/** An errored query makes the item `error` (it should not happen: the query was validated); otherwise all/partial/none. */
export function classify(outcomes: Outcome[]): Returns {
  if (outcomes.length === 0) return "n/a";
  if (outcomes.some((o) => o.returns === null)) return "error";
  const n = outcomes.filter((o) => o.returns).length;
  return n === outcomes.length ? "all" : n === 0 ? "none" : "partial";
}

/** Why an empty result is likely. A hint from the report's own findings, not a proof. */
export function likelyCause(reasonCodes: string[], returns: Returns): string | undefined {
  if (returns !== "none" && returns !== "partial") return undefined;
  const hints: string[] = [];
  if (reasonCodes.includes("metric.unmapped")) hints.push("the metric kept its Datadog name (not in the mapping table), so Dash0 probably has no series by that name");
  if (reasonCodes.includes("metric.approximate")) hints.push("the metric mapping is approximate (a different OTel metric stands in for it): check that series exists");
  if (reasonCodes.includes("tag.unmapped") || reasonCodes.includes("label.default")) hints.push("a label kept its Datadog name (dots become underscores): that label may not exist on the Dash0 series");
  if (hints.length === 0) hints.push("no series matched in the checked window: the source may not send this metric, or its labels differ from the translation");
  return hints.join("; ");
}

export interface ItemInput {
  id?: string;
  kind: "panel" | "alert" | "group";
  title?: string;
  dashboard?: string;
  status: string;
  widget_type?: string;
  promql?: string[];
  reason_codes?: string[];
}
export interface ItemResult {
  id: string;
  kind: string;
  title: string;
  dashboard: string;
  status: string;
  returnsData: Returns;
  queries: { promql: string; checked: string; returns: boolean | null; series: number; error?: string }[];
  likelyCause?: string;
}

export function summarize(items: ItemResult[]): Record<Returns, number> & { items: number } {
  const s = { all: 0, partial: 0, none: 0, error: 0, "n/a": 0, items: items.length };
  for (const i of items) s[i.returnsData]++;
  return s;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const file = args.find((a, i) => !a.startsWith("--") && !["--json", "--md", "--range", "--step", "--concurrency", "--limit"].includes(args[i - 1] ?? ""));
  if (!file) {
    console.error("usage: tsx --env-file=.env scripts/returns-data.ts <report.json> [--json out.json] [--md out.md] [--range 1h] [--step 60] [--concurrency 4] [--limit N]");
    process.exit(2);
  }
  const { DASH0_API_URL, DASH0_AUTH_TOKEN, DASH0_DATASET } = process.env;
  if (!DASH0_API_URL || !DASH0_AUTH_TOKEN) {
    console.error("DASH0_API_URL and DASH0_AUTH_TOKEN are required (the check is read-only).");
    process.exit(2);
  }
  const range = flag("--range") ?? DEFAULTS.range;
  let rangeSeconds: number;
  try {
    rangeSeconds = parseDuration(range);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const env: Env = { base: DASH0_API_URL, token: DASH0_AUTH_TOKEN, dataset: DASH0_DATASET || "default", rangeSeconds, step: Number(flag("--step") ?? 60) };
  const opts: PrepareOpts = { ...DEFAULTS, range };
  const report = JSON.parse(readFileSync(file, "utf8")) as { items: ItemInput[] };
  let items = report.items.filter((i) => i.kind === "panel" || i.kind === "alert");
  const limit = Number(flag("--limit") ?? 0);
  if (limit > 0) items = items.slice(0, limit);

  // Distinct prepared queries only: a corpus repeats the same query many times.
  const prepared = new Map<string, Outcome | null>();
  const forItem = items.map((i) => (i.promql ?? []).map((q) => ({ q, checked: prepare(q, i.kind as "panel" | "alert", opts) })));
  for (const list of forItem) for (const { checked } of list) prepared.set(checked, null);
  const todo = [...prepared.keys()];
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Number(flag("--concurrency") ?? 4)) }, async () => {
    while (next < todo.length) {
      const q = todo[next++]!;
      prepared.set(q, await runQuery(q, env));
      if (++done % 200 === 0) console.error(`  ${done}/${todo.length} queries`);
    }
  });
  await Promise.all(workers);

  const results: ItemResult[] = items.map((i, idx) => {
    const queries = forItem[idx]!.map(({ q, checked }) => ({ promql: q, checked, ...prepared.get(checked)! }));
    const returnsData = classify(queries);
    const cause = likelyCause(i.reason_codes ?? [], returnsData);
    return { id: i.id ?? `item-${idx}`, kind: i.kind, title: i.title ?? "", dashboard: i.dashboard ?? "", status: i.status, returnsData, queries, ...(cause && { likelyCause: cause }) };
  });
  const summary = summarize(results);
  const out = { generatedAt: new Date().toISOString(), dataset: env.dataset, window: { range: opts.range, step: env.step, interval: opts.interval, rateInterval: opts.rateInterval }, distinctQueries: todo.length, summary, items: results };
  if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify(out, null, 2) + "\n");

  const pct = (n: number) => (summary.items - summary["n/a"] === 0 ? "-" : `${((100 * n) / (summary.items - summary["n/a"])).toFixed(1)}%`);
  const md: string[] = [];
  md.push("# Returns-data check", "");
  md.push(`Dataset \`${env.dataset}\`, ${todo.length} distinct queries run read-only (range query over the last ${opts.range}, step ${env.step}s: any point of any series counts; \`$__range\`=${opts.range}). Empty is not necessarily wrong: see the cause hints.`, "");
  md.push("| Result | Items | Share of items with queries |", "|---|---:|---:|");
  for (const k of ["all", "partial", "none", "error"] as const) md.push(`| ${k} | ${summary[k]} | ${pct(summary[k])} |`);
  md.push(`| n/a (no query: notes, placeholders, manual) | ${summary["n/a"]} | |`, "");
  const byDash = new Map<string, Record<Returns, number>>();
  for (const r of results) {
    const d = byDash.get(r.dashboard || "(alerts)") ?? { all: 0, partial: 0, none: 0, error: 0, "n/a": 0 };
    d[r.returnsData]++;
    byDash.set(r.dashboard || "(alerts)", d);
  }
  if (byDash.size <= 60) {
    md.push("| Dashboard | all | partial | none | error |", "|---|---:|---:|---:|---:|");
    for (const [k, v] of [...byDash.entries()].sort((a, b) => a[0].localeCompare(b[0]))) md.push(`| ${k} | ${v.all} | ${v.partial} | ${v.none} | ${v.error} |`);
    md.push("");
  }
  const empties = results.filter((r) => r.returnsData === "none" || r.returnsData === "partial").slice(0, 20);
  if (empties.length) {
    md.push("## First items with no data", "");
    for (const r of empties) md.push(`- ${r.kind} **${r.title || r.id}** (${r.dashboard || "alert"}): ${r.returnsData}. ${r.likelyCause ?? ""}`);
  }
  const text = md.join("\n");
  console.log(text);
  if (flag("--md")) writeFileSync(flag("--md")!, text + "\n");
  if (summary.error > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
