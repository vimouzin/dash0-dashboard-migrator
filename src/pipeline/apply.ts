// `dd2dash0 apply plan/ --approved review.json` (CONTRACT-003 §7): import what a person approved, and nothing they
// didn't. Refuses (exit 2) on a changed plan, a review of another plan, source drift, disallowed decisions or pending
// bounded panels. Continues past individual import failures (exit 1) because every import is idempotent: a re-run
// retries only what's missing or failed. Target drift (hand edits in Dash0) needs T7's per-item read-back: not yet.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ingestDatadog } from "../sources/datadog/index.js";
import { canonicalJson, importAll, type Dash0Config, type DashboardDefinition, type Manifest, type PrometheusAlertRule } from "../targets/dash0/index.js";
import type { Report, ReportItem } from "../report/types.js";
import { inputHashOf } from "./migrate.js";
import { verifyPlan } from "./plan-lock.js";
import { checkReview, parseReview, ReviewError, type ReviewCheck, type ReviewDecision, type ReviewItem } from "./review.js";
import { toReviewItem } from "./review-session.js";

export interface ApplyOptions {
  planDir: string;
  reviewFile: string;
  enableRules?: boolean;
  allowPending?: boolean;
  /** Write the approved payloads to plan/apply/dash0 without importing (rehearsal). */
  dryRun?: boolean;
  /** Skip the source drift check (the source isn't reachable, or the user knows it changed). */
  skipSourceCheck?: boolean;
  dash0?: Dash0Config;
  /** Working directory that relative source paths in the plan resolve against. Default: process.cwd(). */
  cwd?: string;
}

export type ApplyOutcome =
  | { kind: "refused"; reasons: string[]; warnings: string[] }
  | { kind: "done"; ok: boolean; manifest: Manifest; review: ReviewCheck; imported: { dashboards: number; rules: number }; skippedAlerts: string[]; placeholders: string[]; warnings: string[]; reportFile: string };

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);


/** Markdown placeholder for a panel the reviewer flagged; same shape as T5's placeholders, plus the reviewer's note. */
export function flaggedPlaceholder(item: ReportItem, note: string): string {
  const lines = [`**Not migrated (flagged in review):** Datadog \`${item.widget_type}\` widget${item.title ? ` "${item.title}"` : ""}.`, ""];
  if (note.trim()) lines.push(`Reviewer's note: ${note.trim()}`, "");
  if (item.reason_codes.length) lines.push(`Reasons: ${item.reason_codes.join(", ")}`, "");
  if (item.source_queries.length) lines.push("Original queries:", "", ...item.source_queries.map((q) => "    " + q), "");
  lines.push(`See the migration report: \`${item.id}\`.`);
  return lines.join("\n");
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
}

export async function runApply(o: ApplyOptions): Promise<ApplyOutcome> {
  const warnings: string[] = [];
  // 1. The plan is intact.
  const plan = verifyPlan(o.planDir);
  if (!plan.ok) return { kind: "refused", reasons: [`the plan changed since it was written:`, ...plan.problems.map((p) => `  ${p}`)], warnings };

  // 2. The review binds to this plan and only makes allowed decisions.
  const reportText = readFileSync(join(o.planDir, "report.json"));
  const report = JSON.parse(reportText.toString("utf8")) as Report;
  let review;
  try {
    review = parseReview(readFileSync(o.reviewFile, "utf8"), o.reviewFile);
  } catch (e) {
    if (e instanceof ReviewError || (e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "refused", reasons: [(e as Error).message], warnings };
    throw e;
  }
  const items = report.items.map(toReviewItem).filter((x): x is ReviewItem => x !== null);
  const check = checkReview(review, { planHash: plan.planHash, reportSha256: sha(reportText), items });
  warnings.push(...check.warnings);
  const reasons = check.errors.map((e) => e.message);
  if (check.pending.length && !o.allowPending) reasons.push(`${check.pending.length} approximate panel(s) have no decision (approve or flag them, or pass --allow-pending): ${check.pending.join(", ")}`);
  if (reasons.length) return { kind: "refused", reasons, warnings };

  // 3. The Datadog source still is what the plan translated.
  if (!o.skipSourceCheck) {
    const src = (plan.lock.config as { source?: { kind: string; path?: string }; only?: "dashboards" | "monitors" }).source;
    const only = (plan.lock.config as { only?: "dashboards" | "monitors" }).only;
    const input = src?.kind === "folder" && src.path ? (isAbsolute(src.path) ? src.path : resolve(o.cwd ?? process.cwd(), src.path)) : undefined;
    const now = await ingestDatadog({ ...(input ? { input } : { api: true }), ...(only ? { only } : {}) });
    if (inputHashOf(now) !== plan.lock.inputHash) return { kind: "refused", reasons: ["the Datadog source changed since the plan was made: re-run `dd2dash0 plan` and review again"], warnings };
  } else warnings.push("source drift check skipped (--skip-source-check)");

  // 4. Payloads per decision.
  const byId = new Map(report.items.map((i) => [i.id, i]));
  const dashboards = readJsonDir<DashboardDefinition>(join(o.planDir, "dash0", "dashboards"));
  const byOrigin = new Map(dashboards.map((d) => [d.metadata.dash0Extensions?.id ?? "", d]));
  const placeholders: string[] = [];
  for (const [id, d] of check.decisions) {
    const item = byId.get(id)!;
    if (item.kind !== "panel" || d.decision !== "flagged") continue;
    const dash = item.target ? byOrigin.get(item.target.dash0Id) : undefined;
    const key = lastSegment(id);
    const panel = dash?.spec.panels[key];
    if (!dash || !panel) return { kind: "refused", reasons: [`flagged panel ${id} not found in the plan's payloads (dashboard ${item.target?.dash0Id ?? "?"}, panel ${key})`], warnings };
    dash.spec.panels[key] = flagPanel(panel, item, d);
    placeholders.push(id);
  }
  const rules = readJsonDir<PrometheusAlertRule>(join(o.planDir, "dash0", "check-rules"));
  const approvedRuleIds = new Set(
    report.items.filter((i) => i.kind === "alert" && check.decisions.get(i.id)?.decision === "approved" && i.target).map((i) => i.target!.dash0Id),
  );
  const approvedRules = rules.filter((r) => r.id !== undefined && approvedRuleIds.has(r.id));

  // 5. Import (idempotent: dashboards PUT by origin, rules imported by their UUID).
  const outDir = join(o.planDir, "apply");
  mkdirSync(outDir, { recursive: true });
  const manifest = await importAll(
    { dashboards, rules: approvedRules },
    { dryRun: !!o.dryRun, outDir: join(outDir, "dash0"), ...(o.enableRules !== undefined && { enableRules: o.enableRules }), ...(!o.dryRun && o.dash0 ? { config: o.dash0 } : {}) },
  );

  // 6. The post-apply report: the plan's report with each item's target and read-back from this import.
  const result = (kind: "dashboard" | "check-rule", id: string) => manifest.results.find((r) => r.kind === kind && r.id === id);
  const applied: Report = {
    ...report,
    run: { ...report.run, planHash: plan.planHash },
    summary: {
      ...report.summary,
      import: { mode: o.dryRun ? "dry-run" : "live", written: manifest.summary["dry-run"], imported: manifest.summary.imported, failed: manifest.summary.failed, rejected: manifest.summary["rejected-preflight"], readBackMatch: manifest.summary.readBackMatch },
    },
    items: report.items.map((i) => {
      if (!i.target) return i;
      const r = result(i.target.kind, i.target.dash0Id);
      if (!r) return { ...i, target: { ...i.target, action: i.kind === "alert" ? "skipped-in-review" : i.target.action, readBack: "skipped" } };
      return {
        ...i,
        target: { ...i.target, action: r.action, readBack: r.readBack.state },
        certificate: { ...i.certificate, checks: { ...i.certificate.checks, importedReadBack: r.readBack.state === "skipped" ? null : r.readBack.state === "match" } },
      };
    }),
  };
  const reportFile = join(outDir, "report.json");
  writeFileSync(reportFile, canonicalJson(applied) + "\n");

  const ok = manifest.summary.failed === 0 && manifest.summary["rejected-preflight"] === 0;
  return {
    kind: "done",
    ok,
    manifest,
    review: check,
    imported: { dashboards: dashboards.length, rules: approvedRules.length },
    // Only monitors that have a check rule can be "not imported"; manual monitors never had one.
    skippedAlerts: check.skippedAlerts.filter((id) => byId.get(id)?.target),
    placeholders,
    warnings,
    reportFile,
  };
}

function flagPanel(panel: DashboardDefinition["spec"]["panels"][string], item: ReportItem, d: ReviewDecision): DashboardDefinition["spec"]["panels"][string] {
  return {
    ...panel,
    spec: {
      ...panel.spec,
      plugin: { kind: "Markdown", spec: { text: flaggedPlaceholder(item, d.note) } },
      queries: [],
    },
  } as DashboardDefinition["spec"]["panels"][string];
}
