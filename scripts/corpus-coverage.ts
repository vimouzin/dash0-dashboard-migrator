// Query-level coverage over every dashboard and monitor in DataDog/integrations-core.
//
//   npx tsx scripts/corpus-coverage.ts <integrations-core dir> [--report report.json] [--json out.json] [--md out.md]
//
// --report adds the PANEL and ALERT tables from a `dd2dash0 migrate --no-import` run over the same folder
// (T8's report.json), so the query-level and pipeline-level numbers sit side by side.
//
// It walks <dir>/*/assets/dashboards/*.json and <dir>/*/assets/monitors/*.json and runs each query/monitor through
// T4 (metrics) and T12 (logs). It is deterministic and uses no network. It measures TRANSLATION coverage:
// "translated" = status is not `manual`. It does NOT measure whether the translated query returns data in Dash0
// (that needs the metric to exist there; see the `unmapped names` column), and it says nothing about widget types
// (T5) or layout.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadMappings, worst } from "../src/ir/index.js";
import type { Status } from "../src/ir/index.js";
import { coverageCollector, type CoverageItem, type QueryKind } from "../src/report/query-coverage.js";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = args.find((a, i) => !a.startsWith("--") && !["--json", "--md", "--report"].includes(args[i - 1] ?? ""));
if (!root || !existsSync(root)) {
  console.error("usage: tsx scripts/corpus-coverage.ts <integrations-core dir> [--report report.json] [--json out.json] [--md out.md]");
  process.exit(2);
}

// Resolved from this file, so the script works from any working directory.
const mappingsDir = join(import.meta.dirname, "..", "mappings");
const maps = loadMappings(mappingsDir);

// The classification lives in src/report/query-coverage.ts, shared with every run's report.
type Kind = QueryKind;
type Item = CoverageItem & { integration: string };
const collector = coverageCollector(mappingsDir, maps);
const items = collector.items as Item[];
const skipped = collector.skipped;
const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);
const doDashboard = (file: string, integration: string) => collector.dashboard(JSON.parse(readFileSync(file, "utf8")), integration);
const doMonitor = (file: string, integration: string) => collector.monitor(JSON.parse(readFileSync(file, "utf8")), integration);

const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
let nDash = 0;
let nMon = 0;
for (const integ of dirs) {
  for (const [sub, fn] of [["dashboards", doDashboard], ["monitors", doMonitor]] as const) {
    const dir = join(root, integ, "assets", sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      try {
        fn(join(dir, f), integ);
        if (sub === "dashboards") nDash++;
        else nMon++;
      } catch (e) {
        skip(`unreadable ${sub} file (${(e as Error).message.slice(0, 40)})`);
      }
    }
  }
}

// ---------------- report ----------------
for (const i of items) i.integration = i.group;
const KINDS: Kind[] = ["metric formula / query", "legacy q", "log query", "log formula", "metric monitor", "log monitor"];
const STATUSES: Status[] = ["exact", "exact-under", "bounded", "manual"];
const pct = (a: number, b: number) => (b === 0 ? "-" : `${((100 * a) / b).toFixed(1)}%`);

interface Row {
  kind: Kind;
  scope: "all" | "distinct";
  total: number;
  counts: Record<Status, number>;
  translated: number;
  unmapped: number;
  invalid: number;
}
const rows: Row[] = [];
for (const scope of ["all", "distinct"] as const) {
  for (const kind of KINDS) {
    let xs = items.filter((i) => i.kind === kind);
    if (scope === "distinct") {
      const seen = new Map<string, Item>();
      for (const i of xs) {
        const prev = seen.get(i.key);
        seen.set(i.key, prev ? { ...i, status: worst(prev.status, i.status), unmapped: prev.unmapped || i.unmapped } : i);
      }
      xs = [...seen.values()];
    }
    const counts = Object.fromEntries(STATUSES.map((s) => [s, xs.filter((i) => i.status === s).length])) as Record<Status, number>;
    rows.push({ kind, scope, total: xs.length, counts, translated: xs.length - counts.manual, unmapped: xs.filter((i) => i.status !== "manual" && i.unmapped).length, invalid: xs.filter((i) => i.invalid).length });
  }
}

const out: string[] = [];
out.push(`# Corpus coverage (query level)`);
out.push("");
out.push(`Source: ${nDash} dashboards and ${nMon} monitors under \`${root}\`. Deterministic; no network.`);
out.push("");
out.push("**Translated** = not `manual`. **exact / exact-under / bounded** follow the status lattice (exact-under and bounded are the brief's \"approximate\").");
out.push("**Unmapped names** = translated results that keep a Datadog metric name because the mapping table has no entry (valid PromQL, but it returns data only if the OTel metric has that name). This measures translation, not data availability.");
for (const scope of ["distinct", "all"] as const) {
  out.push("");
  out.push(scope === "distinct" ? "## Distinct queries / monitors" : "## Every occurrence");
  out.push("");
  out.push("| Type | Total | exact | exact-under | bounded | manual | Translated | Unmapped names |");
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows.filter((x) => x.scope === scope))
    out.push(`| ${r.kind} | ${r.total} | ${r.counts.exact} | ${r["counts"]["exact-under"]} | ${r.counts.bounded} | ${r.counts.manual} | ${pct(r.translated, r.total)} | ${r.unmapped} |`);
}
out.push("");
out.push("## Why items stay manual (distinct, top 12 per type)");
for (const kind of KINDS) {
  const m = new Map<string, number>();
  const seen = new Set<string>();
  for (const i of items.filter((x) => x.kind === kind && x.status === "manual")) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    m.set(i.reason ?? "unknown", (m.get(i.reason ?? "unknown") ?? 0) + 1);
  }
  if (!m.size) continue;
  out.push("");
  out.push(`**${kind}**: ` + [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `\`${c}\` ${n}`).join(", "));
}
out.push("");
out.push("## Not attempted (outside T4/T12; listed so the denominators are honest)");
out.push("");
for (const [k, v] of [...skipped.entries()].sort((a, b) => b[1] - a[1])) out.push(`- ${k}: ${v}`);
const invalid = rows.filter((r) => r.scope === "all").reduce((a, r) => a + r.invalid, 0);
out.push("");
out.push(`Emitted PromQL that failed lezer validation: ${invalid} (must be 0).`);

// ---------------- which unmapped metrics matter most ----------------
// Counted once per distinct query/monitor (not per finding), only where the result was otherwise translated.
const perMetric = new Map<string, { uses: number; integrations: Set<string> }>();
const perIntegration = new Map<string, Set<string>>();
{
  const seen = new Set<string>();
  for (const i of items) {
    if (i.status === "manual" || seen.has(i.key)) continue;
    seen.add(i.key);
    for (const n of new Set(i.unmappedNames)) {
      const m = perMetric.get(n) ?? { uses: 0, integrations: new Set<string>() };
      m.uses++;
      m.integrations.add(i.integration);
      perMetric.set(n, m);
      const set = perIntegration.get(i.integration) ?? new Set<string>();
      set.add(n);
      perIntegration.set(i.integration, set);
    }
  }
}
out.push("");
out.push(`## Mapping work by impact (${perMetric.size} distinct unmapped metrics across ${perIntegration.size} integrations)`);
out.push("");
out.push("Integrations with the most unmapped metrics used in translated queries and monitors:");
out.push("");
out.push("| Integration | Unmapped metrics used |");
out.push("|---|---:|");
for (const [k, v] of [...perIntegration.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 25)) out.push(`| ${k} | ${v.size} |`);
out.push("");
out.push("Single metrics used by the most distinct queries and monitors:");
out.push("");
out.push("| Metric | Distinct queries | Integrations |");
out.push("|---|---:|---|");
for (const [k, v] of [...perMetric.entries()].sort((a, b) => b[1].uses - a[1].uses || a[0].localeCompare(b[0])).slice(0, 25))
  out.push(`| \`${k}\` | ${v.uses} | ${[...v.integrations].sort().slice(0, 4).join(", ")}${v.integrations.size > 4 ? ", ..." : ""} |`);

// ---------------- pipeline level (T8 report.json) ----------------
let pipeline: unknown = undefined;
if (flag("--report")) {
  const rep = JSON.parse(readFileSync(flag("--report")!, "utf8")) as {
    summary: { dashboards: number; alerts: number };
    items: { kind: "panel" | "alert"; status: string; widget_type?: string; findings?: { code: string; status: string }[] }[];
  };
  const blocker = (it: (typeof rep.items)[number]) => it.findings?.find((f) => f.status === "manual" || f.status === "unsupported")?.code ?? "(none)";
  const tally = (kind: "panel" | "alert") => {
    const xs = rep.items.filter((i) => i.kind === kind);
    const by: Record<string, number> = {};
    for (const i of xs) by[i.status] = (by[i.status] ?? 0) + 1;
    const why = new Map<string, number>();
    for (const i of xs.filter((x) => x.status === "manual" || x.status === "unsupported")) why.set(blocker(i), (why.get(blocker(i)) ?? 0) + 1);
    return { total: xs.length, by, why: [...why.entries()].sort((a, b) => b[1] - a[1]) };
  };
  const panels = tally("panel");
  const alerts = tally("alert");
  const widgets = new Map<string, number>();
  for (const i of rep.items.filter((x) => x.kind === "panel" && x.status === "unsupported")) widgets.set(i.widget_type ?? "?", (widgets.get(i.widget_type ?? "?") ?? 0) + 1);
  pipeline = { panels, alerts, unsupportedWidgets: Object.fromEntries(widgets) };
  const row = (name: string, t: ReturnType<typeof tally>) => {
    const g = (s: string) => t.by[s] ?? 0;
    return `| ${name} | ${t.total} | ${g("exact")} | ${g("exact-under")} | ${g("bounded")} | ${g("manual")} | ${g("unsupported")} | ${pct(t.total - g("manual") - g("unsupported"), t.total)} |`;
  };
  out.push("");
  out.push(`## Pipeline level: \`dd2dash0 migrate\` over the same folder (${rep.summary.dashboards} dashboards, ${rep.summary.alerts} monitors)`);
  out.push("");
  out.push("Every panel and alert the T8 pipeline emits. T8 emits one panel per dashboard widget (including notes, images and other widgets without queries), so this counts widgets, not queries; the query-level tables above count queries. `unsupported` = widget type with no Dash0 panel (a Markdown placeholder holds the original).");
  out.push("");
  out.push("| Item | Total | exact | exact-under | bounded | manual | unsupported | Translated |");
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  out.push(row("panels", panels));
  out.push(row("alerts", alerts));
  out.push("");
  out.push("**Why panels are manual or unsupported** (first blocking finding): " + panels.why.slice(0, 14).map(([c, n]) => `\`${c}\` ${n}`).join(", "));
  out.push("");
  out.push("**Unsupported widget types**: " + [...widgets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `${c} ${n}`).join(", "));
  out.push("");
  out.push("**Why alerts are manual**: " + alerts.why.slice(0, 10).map(([c, n]) => `\`${c}\` ${n}`).join(", "));
}

const md = out.join("\n");
console.log(md);
if (flag("--md")) writeFileSync(flag("--md")!, md + "\n");
if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify(
      {
        dashboards: nDash,
        monitors: nMon,
        rows,
        skipped: Object.fromEntries(skipped),
        unmappedMetrics: [...perMetric.entries()].sort((a, b) => b[1].uses - a[1].uses || a[0].localeCompare(b[0])).slice(0, 300).map(([name, v]) => ({ name, uses: v.uses, integrations: [...v.integrations].sort() })),
        pipeline,
      },
      null,
      2,
    ) + "\n");
if (invalid > 0) process.exit(1);
