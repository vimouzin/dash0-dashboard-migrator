// The review session both front ends share (CONTRACT-003 §6-7): which items need a decision and in what order,
// how a decision is recorded, and how review.json is written. `dd2dash0 review --terminal` walks it in the terminal;
// `dd2dash0 review` serves it to the console. Deterministic: the order depends only on the report.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report, ReportItem } from "../report/types.js";
import { verifyPlan } from "./plan-lock.js";
import { allowedDecisions, checkReview, parseReview, type Decision, type ReviewDecision, type ReviewFile, type ReviewItem } from "./review.js";

const STATUS_RANK: Record<string, number> = { manual: 0, unsupported: 1, bounded: 2, "exact-under": 3, exact: 4 };

export function toReviewItem(i: ReportItem): ReviewItem | null {
  if (i.kind !== "panel" && i.kind !== "alert") return null;
  return { id: i.id, kind: i.kind, status: i.status, title: i.title };
}

/**
 * Items that need a decision, in review order: manual, unsupported, then bounded; alerts before panels (a wrong alert
 * costs more than a wrong chart); more findings first; then id. Exact and exact-under items need none.
 */
export function reviewQueue(report: Report): ReportItem[] {
  return report.items
    .filter((i) => {
      const r = toReviewItem(i);
      return r !== null && allowedDecisions(r).length > 0;
    })
    .sort(
      (a, b) =>
        (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
        (a.kind === b.kind ? 0 : a.kind === "alert" ? -1 : 1) ||
        b.findings.length - a.findings.length ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

export interface ReviewSession {
  planDir: string;
  report: Report;
  planHash: string;
  reportSha256: string;
  queue: ReportItem[];
  decisions: Map<string, ReviewDecision>;
  reviewer: string;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const REVIEW_FILE = "review.json";

/** Open a plan for review. Refuses a plan whose files changed; resumes an existing review.json of the same plan. */
export function openReview(planDir: string, reviewer: string): ReviewSession {
  const plan = verifyPlan(planDir);
  if (!plan.ok) throw new Error(`the plan changed since it was written, run 'dd2dash0 plan' again:\n  ${plan.problems.join("\n  ")}`);
  const bytes = readFileSync(join(planDir, "report.json"));
  const report = JSON.parse(bytes.toString("utf8")) as Report;
  const s: ReviewSession = { planDir, report, planHash: plan.planHash, reportSha256: sha(bytes), queue: reviewQueue(report), decisions: new Map(), reviewer };
  const existing = join(planDir, REVIEW_FILE);
  if (existsSync(existing)) {
    const prev = parseReview(readFileSync(existing, "utf8"), existing);
    const check = checkReview(prev, { planHash: s.planHash, reportSha256: s.reportSha256, items: itemsOf(report) });
    if (check.ok) {
      s.decisions = check.decisions;
      if (prev.reviewer && !reviewer) s.reviewer = prev.reviewer;
    }
  }
  return s;
}

export function itemsOf(report: Report): ReviewItem[] {
  return report.items.map(toReviewItem).filter((x): x is ReviewItem => x !== null);
}

/** Record one decision. Throws if it isn't allowed for the item (the console's rules). */
export function decide(s: ReviewSession, id: string, decision: Decision, note = ""): void {
  const item = s.report.items.find((i) => i.id === id);
  const r = item ? toReviewItem(item) : null;
  if (!r) throw new Error(`no reviewable item ${id}`);
  if (!allowedDecisions(r).includes(decision)) throw new Error(`${decision} is not allowed for a ${r.status} ${r.kind} (${id})`);
  s.decisions.set(id, { id, decision, note });
}

/** review.json for this session: bound to the plan hash (and the report hash, for older console exports). */
export function reviewFile(s: ReviewSession): ReviewFile {
  const order = new Map(s.queue.map((i, n) => [i.id, n]));
  const decisions = [...s.decisions.values()].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || (a.id < b.id ? -1 : 1));
  return { schema_version: "1", plan_sha256: s.planHash, report_sha256: s.reportSha256, reviewer: s.reviewer, decisions };
}

/** Write plan/review.json atomically (write + rename), so an interrupted review never leaves half a file. */
export function saveReview(s: ReviewSession): string {
  const path = join(s.planDir, REVIEW_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(reviewFile(s), null, 2) + "\n");
  renameSync(tmp, path);
  return path;
}

/** The assumptions behind an item, as sentences (findings carry them already phrased). */
export function conditionOf(i: ReportItem): string[] {
  return [...new Set(i.findings.flatMap((f) => f.assumptions ?? []))];
}
