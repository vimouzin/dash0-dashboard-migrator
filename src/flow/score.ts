// Step 6 of the guided flow: the four headline numbers, per item and in total, and the run's report.md / report.json.
// Denominator: EVERY item found (every panel of every kind, including notes, plus every monitor); groups are
// containers and are not items. Percentages are rounded DOWN, never up.
//   translated  exact + exact-under + approved bounded
//   landed      imported and read back from Dash0 as a match (placeholders count: they did land)
//   live        returns data in Dash0, out of items with a query where at least one side has data (+ query errors)
//   success     translated AND landed AND not a live-data failure (live, no data anywhere, or no query)
import { writeFileSync } from "node:fs";
import { coverageHeadline, pct1, type QueryCoverage, type QueryTypeRow } from "../report/query-coverage.js";
import { join } from "node:path";
import type { Report, ReportItem } from "../report/types.js";
import { reportHtml } from "./report-html.js";
import type { BatchResult } from "./review.js";
import type { Live, LiveResult } from "./verify.js";

export interface Row {
  id: string;
  kind: "panel" | "alert";
  title: string;
  dashboard: string | null;
  widget: string;
  status: string;
  decision: string;
  translated: boolean;
  /** null: not measured (dry run). */
  landed: boolean | null;
  landedDetail: string;
  /** null: not measured. */
  live: Live | null;
  liveDetail?: string;
  success: boolean | null;
  reasons: string[];
  manualActions: string[];
  sourceQueries: string[];
  promql: string[];
  thresholds?: { failed: number; degraded?: number };
  enabled?: boolean;
}

export interface Num {
  count: number;
  total: number;
  pct: number;
}
export interface Score {
  total: number;
  panels: number;
  monitors: number;
  translated: Num;
  landed: Num | null;
  live: Num | null;
  success: Num | null;
  liveCounts: Record<Live, number> | null;
  topGaps: [string, number][];
}

const num = (count: number, total: number): Num => ({ count, total, pct: total ? Math.floor((count * 100) / total) : 0 });

export function decisionsOf(review: BatchResult, items: ReportItem[]): Map<string, string> {
  const m = new Map<string, string>();
  const rulesA = new Set(review.rulesApproved);
  const rulesR = new Set(review.rulesRejected);
  for (const i of items) {
    if (i.kind === "alert") m.set(i.id, rulesA.has(i.id) ? "approved" : rulesR.has(i.id) ? "rejected" : i.status === "manual" || i.status === "unsupported" ? "not a rule" : "-");
    else if (i.kind === "panel") {
      if (i.status === "bounded") m.set(i.id, review.boundedFlagged ? "placeholder (not approved)" : "approved");
      else if (i.status === "manual" || i.status === "unsupported") m.set(i.id, "placeholder");
      else m.set(i.id, "as translated");
    }
  }
  return m;
}

export function rowsOf(applied: Report, decisions: Map<string, string>, live: Map<string, LiveResult> | null, measuredLanding: boolean, enabled: Set<string> = new Set()): Row[] {
  const rows: Row[] = [];
  for (const i of applied.items) {
    if (i.kind !== "panel" && i.kind !== "alert") continue;
    const decision = decisions.get(i.id) ?? "-";
    const translated = i.status === "exact" || i.status === "exact-under" || (i.status === "bounded" && decision === "approved");
    const rb = i.target?.readBack ?? "none";
    const landed = !measuredLanding ? null : i.target ? rb === "match" : false;
    const landedDetail = !i.target ? (i.kind === "alert" ? "no check rule (not translatable)" : "no target") : i.target.action === "skipped-in-review" ? "not imported (rejected in review)" : `${i.target.action}, read-back ${rb}`;
    const l = live?.get(i.id) ?? null;
    const liveOk = l === null ? null : l.live === "live" || l.live === "no-data" || l.live === "n/a";
    const success = landed === null ? null : translated && landed && (liveOk ?? true);
    rows.push({
      id: i.id,
      kind: i.kind,
      title: i.title,
      dashboard: i.dashboard,
      widget: i.widget_type,
      status: i.status,
      decision,
      translated,
      landed,
      landedDetail,
      live: l?.live ?? null,
      ...(l?.cause || l?.error ? { liveDetail: l.cause ?? l.error } : {}),
      success,
      reasons: i.reason_codes,
      manualActions: i.manual_actions ?? [],
      sourceQueries: i.source_queries,
      promql: i.promql,
      ...(i.thresholds ? { thresholds: i.thresholds } : {}),
      ...(i.kind === "alert" && i.target ? { enabled: enabled.has(i.target.dash0Id) } : {}),
    });
  }
  return rows;
}

export function scoreOf(rows: Row[]): Score {
  const total = rows.length;
  const measuredLanding = rows.some((r) => r.landed !== null);
  const measuredLive = rows.some((r) => r.live !== null);
  const lc: Record<Live, number> = { live: 0, missing: 0, "no-data": 0, error: 0, "n/a": 0 };
  for (const r of rows) if (r.live) lc[r.live]++;
  const gaps = new Map<string, number>();
  for (const r of rows) if (!r.translated || r.success === false) for (const c of new Set(r.reasons)) gaps.set(c, (gaps.get(c) ?? 0) + 1);
  return {
    total,
    panels: rows.filter((r) => r.kind === "panel").length,
    monitors: rows.filter((r) => r.kind === "alert").length,
    translated: num(rows.filter((r) => r.translated).length, total),
    landed: measuredLanding ? num(rows.filter((r) => r.landed).length, total) : null,
    live: measuredLive ? num(lc.live, lc.live + lc.missing + lc.error) : null,
    success: measuredLanding ? num(rows.filter((r) => r.success).length, total) : null,
    liveCounts: measuredLive ? lc : null,
    topGaps: [...gaps.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5),
  };
}

const fmt = (n: Num | null) => (n ? `${n.count}/${n.total}  ${n.pct}%` : "not measured");
const mark = (b: boolean | null) => (b === null ? "–" : b ? "✓" : "✗");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export interface RunFacts {
  version: string;
  source: string;
  target: string;
  mode: "live" | "dry-run";
  inputHash: string;
  outputHash: string;
  planHash: string;
  windowSeconds: number;
  startedAt: string;
}

/** "fn.anomalies 46 · monitor.as_count 13": why the rest of a query type stays with a person. */
export const reasonsText = (r: QueryTypeRow, n = 3) => r.reasons.slice(0, n).map(([c, k]) => `${c} ${k}`).join(" · ");

/** The "coverage by query type" section, Markdown. */
export function coverageMarkdown(c: QueryCoverage): string[] {
  if (!c.total) return [];
  const L = ["## Coverage by query type", "", coverageHeadline(c), "", "| Type | Distinct | Translated | Exact under a stated condition | Why the rest stays with a person |", "|---|---:|---:|---:|---|"];
  for (const r of c.rows) L.push(`| ${r.label} | ${r.total} | ${pct1(r.translated, r.total)} | ${pct1(r.exact, r.total)} | ${cell(reasonsText(r)) || "–"} |`);
  L.push("");
  const notes = ["Distinct: the same query in two widgets counts once, at its worst result. Percentages round down."];
  if (c.anomalyMonitors) notes.push(`Anomaly monitors (${c.anomalyMonitors}) count as metric monitors. They stay with a person, because dd2dash0 doesn't guess.`);
  const sk = Object.entries(c.skipped).reduce((a, [, n]) => a + n, 0);
  if (sk) notes.push(`Not counted: ${sk} request(s) on other data sources (${Object.entries(c.skipped).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(", ")}).`);
  L.push(...notes.map((n) => `${n}  `), "");
  return L;
}

export function reportMarkdown(score: Score, rows: Row[], facts: RunFacts, coverage?: QueryCoverage): string {
  const L: string[] = [];
  L.push(`# dd2dash0 migration report`, "");
  L.push(`${facts.source} → ${facts.target} · ${score.panels} panels, ${score.monitors} monitors · ${facts.mode === "live" ? "live import" : "dry run (nothing imported)"} · ${facts.startedAt}`, "");
  L.push(`| | count | % |`, `|---|---|---|`);
  for (const [name, n, what] of [
    ["**Success**", score.success, "translated and landed and not missing data"],
    ["Translated", score.translated, "exact, exact-under, or approved bounded"],
    ["Landed", score.landed, "imported and read back from Dash0"],
    ["Live", score.live, "returns data in Dash0 when Datadog has data (last 1 h)"],
  ] as const)
    L.push(`| ${name} (${what}) | ${n ? `${n.count}/${n.total}` : "not measured"} | ${n ? `${n.pct}%` : "–"} |`);
  L.push("", "Percentages are rounded down. Every panel (including notes) and every monitor counts.", "");

  // Funnel
  L.push(`## Funnel`, "");
  const found = score.total;
  const tr = score.translated.count;
  const la = score.landed?.count;
  const su = score.success?.count;
  L.push(`found ${found} → translated ${tr} (−${found - tr})${la !== undefined ? ` → landed ${la}` : ""}${su !== undefined ? ` → success ${su}` : ""}`);
  if (score.liveCounts) {
    const c = score.liveCounts;
    L.push("", `Live data check (last ${facts.windowSeconds / 60} min): live ${c.live} · missing in Dash0 ${c.missing} · query error ${c.error} · no data on either side ${c["no-data"]} · no query ${c["n/a"]}`);
  }
  if (score.topGaps.length) L.push("", `Top gaps: ${score.topGaps.map(([c, n]) => `\`${c}\` ×${n}`).join(" · ")}`);
  L.push("");
  if (coverage) L.push(...coverageMarkdown(coverage));

  // Per dashboard
  const panels = rows.filter((r) => r.kind === "panel");
  const dashboards = [...new Set(panels.map((r) => r.dashboard ?? "(no dashboard)"))];
  for (const d of dashboards) {
    const ps = panels.filter((r) => (r.dashboard ?? "(no dashboard)") === d);
    const ok = ps.filter((r) => r.success).length;
    L.push(`## Dashboard: ${d}`, "", `${ps.length} panels · success ${score.success ? `${ok}/${ps.length}` : "not measured"}`, "");
    L.push(`| panel | widget | claim | decision | translated | landed | live | reasons |`, `|---|---|---|---|---|---|---|---|`);
    for (const r of ps) L.push(`| ${cell(r.title || "(untitled)")} | ${r.widget} | ${r.status} | ${r.decision} | ${mark(r.translated)} | ${mark(r.landed)} | ${r.live ?? "–"} | ${cell(r.reasons.join(", "))} |`);
    L.push("");
  }

  // Monitors
  const mons = rows.filter((r) => r.kind === "alert");
  if (mons.length) {
    L.push(`## Monitors`, "");
    for (const r of mons) {
      L.push(`### ${r.title || r.id}`, "");
      L.push(`claim **${r.status}** · decision ${r.decision} · landed ${mark(r.landed)} (${r.landedDetail}) · live ${r.live ?? "–"}${r.enabled !== undefined ? ` · ${r.enabled ? "enabled" : "disabled"}` : ""}`, "");
      for (const q of r.sourceQueries) L.push(`- Datadog: \`${q}\``);
      for (const q of r.promql) L.push(`- PromQL: \`${q}\``);
      if (r.thresholds) L.push(`- thresholds: failed > ${r.thresholds.failed}${r.thresholds.degraded !== undefined ? `, degraded > ${r.thresholds.degraded}` : ""}`);
      if (r.reasons.length) L.push(`- reasons: ${r.reasons.join(", ")}`);
      L.push("");
    }
  }

  // Failures
  const failures = rows.filter((r) => !r.translated || r.landed === false || r.live === "missing" || r.live === "error");
  L.push(`## What needs attention (${failures.length})`, "");
  if (!failures.length) L.push("Nothing.", "");
  for (const r of failures) {
    const why: string[] = [];
    if (!r.translated) why.push(`not translated exactly (${r.status}${r.decision.startsWith("placeholder") ? ", landed as a placeholder with the original query" : ""})`);
    if (r.landed === false) why.push(`did not land: ${r.landedDetail}`);
    if (r.live === "missing") why.push(`Datadog has data, Dash0 has none: ${r.liveDetail ?? ""}`);
    if (r.live === "error") why.push(`Dash0 rejected the query: ${r.liveDetail ?? ""}`);
    L.push(`- **${cell(r.title || r.id)}**${r.dashboard ? ` (${cell(r.dashboard)})` : ""}: ${why.join("; ")}${r.reasons.length ? ` · codes ${r.reasons.join(", ")}` : ""}`);
    for (const a of r.manualActions) L.push(`  - to do: ${a}`);
  }
  L.push("");

  L.push(`## Run`, "");
  L.push(`- dd2dash0 ${facts.version} · plan ${facts.planHash.slice(0, 16)}`);
  L.push(`- input hash ${facts.inputHash.slice(0, 16)} · output hash ${facts.outputHash.slice(0, 16)} (same input + same version → same output hash)`);
  L.push(`- live window: last ${facts.windowSeconds / 60} min, presence only (values are not compared)`);
  L.push(`- translation is deterministic: parsers, rules and mapping tables; no LLM is involved`);
  return L.join("\n") + "\n";
}

export function writeRunReport(dir: string, score: Score, rows: Row[], facts: RunFacts, coverage?: QueryCoverage): { md: string; json: string; html: string } {
  const md = join(dir, "report.md");
  const json = join(dir, "report.json");
  const html = join(dir, "report.html");
  writeFileSync(md, reportMarkdown(score, rows, facts, coverage));
  writeFileSync(json, JSON.stringify({ schema: "dd2dash0.run/v1", facts, score, ...(coverage ? { queryCoverage: coverage } : {}), items: rows }, null, 2) + "\n");
  writeFileSync(html, reportHtml(score, rows, facts, coverage));
  return { md, json, html };
}

export function summaryText(score: Score, facts: RunFacts, extra: { rulesImported: number; rulesOn?: number; manualMonitors: number; reportMd: string }): string[] {
  return [
    `dd2dash0  ${score.panels} panels, ${score.monitors} monitors  ${facts.source} -> ${facts.target}`,
    `  success     ${fmt(score.success)}`,
    `  translated  ${fmt(score.translated)}   landed ${fmt(score.landed)}   live ${fmt(score.live)}`,
    ...(score.topGaps.length ? [`  top gaps    ${score.topGaps.slice(0, 3).map(([c, n]) => `${c} x${n}`).join(" · ")}`] : []),
    `  rules       ${extra.rulesImported} ${facts.mode === "live" ? `imported (${extra.rulesOn ?? 0} on, ${extra.rulesImported - (extra.rulesOn ?? 0)} off)` : "written (dry run)"}${extra.manualMonitors ? ` · ${extra.manualMonitors} monitor(s) not translatable` : ""}`,
    `  report      ${extra.reportMd}`,
  ];
}
