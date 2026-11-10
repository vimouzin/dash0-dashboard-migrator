// review.json (CONTRACT-003 §6): parse it and check it against a plan before `apply` imports anything.
// The console and `review --terminal` write it; `apply` refuses on any error here (exit code 2).
// Not wired into the CLI yet.

export type Decision = "approved" | "flagged" | "acknowledged";

export interface ReviewDecision {
  id: string;
  decision: Decision;
  note: string;
}

export interface ReviewFile {
  schema_version: "1";
  plan_sha256?: string;
  report_sha256?: string;
  reviewer: string;
  decisions: ReviewDecision[];
}

/** What the check needs to know about each report item. */
export interface ReviewItem {
  id: string;
  kind: "group" | "panel" | "alert";
  status: "exact" | "exact-under" | "bounded" | "manual" | "unsupported";
  title?: string;
}

export interface ReviewProblem {
  code: "plan.mismatch" | "report.mismatch" | "review.unknown-id" | "review.not-allowed" | "review.duplicate" | "review.unbound";
  message: string;
  ids: string[];
}

export interface ReviewCheck {
  ok: boolean;
  errors: ReviewProblem[];
  warnings: string[];
  /** Decision per item id, for the valid entries. */
  decisions: Map<string, ReviewDecision>;
  /** Bounded panels with no decision. `apply` refuses them unless --allow-pending (CONTRACT-003 §7). */
  pending: string[];
  /** Alerts that won't be imported: flagged or undecided (a check rule needs an explicit approval). */
  skippedAlerts: string[];
}

const DECISIONS = new Set<Decision>(["approved", "flagged", "acknowledged"]);

export class ReviewError extends Error {}

export function parseReview(text: string, file = "review.json"): ReviewFile {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new ReviewError(`${file}: not valid JSON (${(e as Error).message})`);
  }
  const r = j as Partial<ReviewFile> | null;
  if (!r || typeof r !== "object") throw new ReviewError(`${file}: expected an object`);
  if (r.schema_version !== "1") throw new ReviewError(`${file}: schema_version must be "1"`);
  if (!Array.isArray(r.decisions)) throw new ReviewError(`${file}: decisions must be an array`);
  const decisions: ReviewDecision[] = r.decisions.map((d, i) => {
    const x = d as Partial<ReviewDecision>;
    if (typeof x?.id !== "string" || !x.id) throw new ReviewError(`${file}: decisions[${i}].id must be a non-empty string`);
    if (!DECISIONS.has(x.decision as Decision)) throw new ReviewError(`${file}: decisions[${i}].decision must be approved, flagged or acknowledged`);
    return { id: x.id, decision: x.decision as Decision, note: typeof x.note === "string" ? x.note : "" };
  });
  return {
    schema_version: "1",
    ...(typeof r.plan_sha256 === "string" && { plan_sha256: r.plan_sha256 }),
    ...(typeof r.report_sha256 === "string" && { report_sha256: r.report_sha256 }),
    reviewer: typeof r.reviewer === "string" ? r.reviewer : "",
    decisions,
  };
}

/** The decisions a reviewer may make for an item (console rules). Empty: the item needs no decision. */
export function allowedDecisions(item: ReviewItem): Decision[] {
  if (item.kind === "group") return [];
  if (item.kind === "alert") return item.status === "manual" || item.status === "unsupported" ? ["acknowledged"] : ["approved", "flagged"];
  if (item.status === "bounded") return ["approved", "flagged"];
  if (item.status === "manual" || item.status === "unsupported") return ["acknowledged"];
  return []; // exact, exact-under: imported as translated
}

/** True when apply must have a decision before importing the item (it's in summary.reviewOrder). */
export function decisionRequired(item: ReviewItem): boolean {
  return allowedDecisions(item).length > 0;
}

export function checkReview(review: ReviewFile, ctx: { planHash: string; reportSha256: string; items: ReviewItem[] }): ReviewCheck {
  const errors: ReviewProblem[] = [];
  const warnings: string[] = [];
  if (review.plan_sha256 !== undefined) {
    if (review.plan_sha256 !== ctx.planHash)
      errors.push({ code: "plan.mismatch", ids: [], message: `review.json was made for plan ${review.plan_sha256.slice(0, 12)}, but this plan is ${ctx.planHash.slice(0, 12)}: review the current plan again` });
  } else if (review.report_sha256 !== undefined) {
    if (review.report_sha256 !== ctx.reportSha256)
      errors.push({ code: "report.mismatch", ids: [], message: `review.json was made for report ${review.report_sha256.slice(0, 12)}, but this plan's report is ${ctx.reportSha256.slice(0, 12)}` });
    else warnings.push("review.json binds only to report.json (report_sha256): edits to the Dash0 payloads are not covered; re-export it from a current console to bind it to the plan");
  } else errors.push({ code: "review.unbound", ids: [], message: "review.json has neither plan_sha256 nor report_sha256" });

  const byId = new Map(ctx.items.map((i) => [i.id, i]));
  const decisions = new Map<string, ReviewDecision>();
  const unknown: string[] = [];
  const dup: string[] = [];
  const notAllowed: string[] = [];
  for (const d of review.decisions) {
    const item = byId.get(d.id);
    if (!item) unknown.push(d.id);
    else if (decisions.has(d.id)) dup.push(d.id);
    else if (!allowedDecisions(item).includes(d.decision)) notAllowed.push(`${d.id} (${d.decision} on a ${item.status} ${item.kind})`);
    else decisions.set(d.id, d);
  }
  if (unknown.length) errors.push({ code: "review.unknown-id", ids: unknown, message: `decisions for items not in this plan: ${unknown.join(", ")}` });
  if (dup.length) errors.push({ code: "review.duplicate", ids: dup, message: `more than one decision for: ${dup.join(", ")}` });
  if (notAllowed.length) errors.push({ code: "review.not-allowed", ids: notAllowed, message: `decisions not allowed for their item: ${notAllowed.join("; ")}` });

  const pending = ctx.items.filter((i) => i.kind === "panel" && i.status === "bounded" && !decisions.has(i.id)).map((i) => i.id);
  const skippedAlerts = ctx.items.filter((i) => i.kind === "alert" && decisions.get(i.id)?.decision !== "approved").map((i) => i.id);
  return { ok: errors.length === 0, errors, warnings, decisions, pending, skippedAlerts };
}
