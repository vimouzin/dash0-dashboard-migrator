// report.json (canonical, deterministic), report.md (for humans and the PR), and the terminal summary.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../targets/dash0/index.js";
import type { Report, ReportItem, ReportStatus } from "./types.js";

const ORDER: ReportStatus[] = ["exact", "exact-under", "bounded", "manual", "unsupported"];
const pct = (x: number) => `${(Math.floor(x * 1000) / 10).toFixed(1)}%`;

export function writeReport(r: Report, outDir: string): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, "report.json");
  const md = join(outDir, "report.md");
  writeFileSync(json, canonicalJson(r) + "\n");
  writeFileSync(md, renderMarkdown(r));
  return { json, md };
}

export function renderMarkdown(r: Report): string {
  const s = r.summary;
  const L: string[] = [];
  L.push(`# dd2dash0 migration report`, "");
  L.push(`Tool ${r.run.version} · input \`${r.run.inputHash.slice(0, 12)}\` · output \`${r.run.outputHash.slice(0, 12)}\` · mode **${String(r.run.options.mode)}**`, "");
  L.push(`**${s.dashboards} dashboards, ${s.alerts} monitors.** Coverage over query panels (notes excluded): exact or exact-under **${pct(s.coverageExact)}**, translated (incl. bounded) **${pct(s.coverageTranslated)}**.`, "");
  L.push("| | " + ORDER.join(" | ") + " |", "|---|" + ORDER.map(() => "---:").join("|") + "|");
  for (const [k, v] of Object.entries(s.byKind)) L.push(`| ${k} | ${ORDER.map((o) => v[o] ?? 0).join(" | ")} |`);
  L.push("");
  if (s.import) L.push(importLine(s.import) + ".", "");
  L.push("Status meanings: **exact**, same numbers for any data. **exact-under**, exact while the listed assumptions hold. **bounded**, within a stated error. **manual**, not translated (the original is kept). **unsupported**, no Dash0 equivalent (placeholder panel).", "");

  const dashboards = [...new Set(r.items.filter((i) => i.kind === "panel").map((i) => i.dashboard!))];
  for (const d of dashboards) {
    L.push(`## Dashboard: ${d}`, "", "| Panel | Datadog type | Status | Reason codes |", "|---|---|---|---|");
    for (const i of r.items.filter((x) => x.dashboard === d)) L.push(`| ${esc(i.title)} | ${i.widget_type} | ${i.status} | ${i.reason_codes.join(", ")} |`);
    L.push("");
  }
  const alerts = r.items.filter((i) => i.kind === "alert");
  if (alerts.length) {
    L.push("## Monitors → check rules", "", "| Monitor | Status | Thresholds | Reason codes |", "|---|---|---|---|");
    for (const a of alerts) L.push(`| ${esc(a.title)} | ${a.status} | ${a.thresholds ? `failed ${a.thresholds.failed}${a.thresholds.degraded !== undefined ? `, degraded ${a.thresholds.degraded}` : ""}` : "-"} | ${a.reason_codes.join(", ")} |`);
    L.push("");
    for (const a of alerts.filter((x) => x.promql.length)) L.push(`- **${esc(a.title)}**: \`${a.promql[0]}\``);
    L.push("");
  }
  const actions = r.items.flatMap((i) => (i.manual_actions ?? []).map((m) => `- ${esc(i.title)}: ${m}`));
  if (actions.length) L.push("## Manual follow-ups", "", ...actions, "");
  L.push("## Findings by code", "", "| Code | Count |", "|---|---:|", ...Object.entries(s.findingsByCode).map(([c, n]) => `| ${c} | ${n} |`), "");
  return L.join("\n");
}

export function summaryLines(r: Report, files: { json: string; md: string }): string[] {
  const s = r.summary;
  const line = (label: string, v: Partial<Record<ReportStatus, number>> | undefined) =>
    `  ${label.padEnd(8)} ${ORDER.map((o) => `${o} ${v?.[o] ?? 0}`).join("  ")}`;
  const out = [
    `dd2dash0 ${r.run.version}: ${s.dashboards} dashboards, ${s.alerts} monitors`,
    line("panels", s.byKind.panel),
    line("alerts", s.byKind.alert),
    `  coverage (query panels): exact/exact-under ${pct(s.coverageExact)}, translated ${pct(s.coverageTranslated)}`,
  ];
  if (s.import) out.push(`  ${importLine(s.import)}`);
  out.push(`  output hash ${r.run.outputHash.slice(0, 16)} (same input -> same hash)`, `  report: ${files.json}`, `          ${files.md}`);
  return out;
}

function importLine(i: NonNullable<Report["summary"]["import"]>): string {
  return i.mode === "dry-run"
    ? `dry run: ${i.written} Dash0 payloads written, ${i.rejected} rejected by preflight (nothing imported)`
    : `import: ${i.imported} imported, ${i.readBackMatch} read back identical, ${i.failed} failed, ${i.rejected} rejected by preflight`;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
export type { ReportItem };
