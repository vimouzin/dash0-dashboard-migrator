import type { Report, ReportItem } from "./report";

export type Decision = "approved" | "flagged" | "acknowledged";
export interface DecisionEntry {
  decision: Decision;
  note: string;
  at: string;
}
export interface ReviewState {
  reviewer: string;
  decisions: Record<string, DecisionEntry>;
  checklist: Record<string, Record<string, boolean>>;
}
export const emptyReview = (): ReviewState => ({ reviewer: "", decisions: {}, checklist: {} });

export const CHECK_RULE_CHECKLIST: { key: string; label: string }[] = [
  { key: "comparator", label: "Comparator and units" },
  { key: "window", label: "5-minute window" },
  {
    key: "severity",
    label: "Datadog warning to Dash0 degraded (DEGRADED), critical to failed (CRITICAL)",
  },
  { key: "missing", label: "Missing-data behaviour" },
  { key: "routing", label: "Notification routing (not migrated)" },
];

/** Groups and exact widgets are not reviewed. */
export function isReviewable(i: ReportItem): boolean {
  if (i.kind === "group") return false;
  if (i.kind === "monitor") return true;
  return i.status !== "exact";
}

/** Which decisions are allowed for an item. */
export function allowedDecisions(i: ReportItem): Decision[] {
  if (!isReviewable(i)) return [];
  if (i.kind === "monitor") return ["approved", "flagged"];
  if (i.status === "approximate") return ["approved", "flagged"];
  return ["acknowledged"];
}

export function checklistComplete(state: ReviewState, id: string): boolean {
  const c = state.checklist[id] ?? {};
  return CHECK_RULE_CHECKLIST.every((k) => c[k.key]);
}

export function decisionLabel(i: ReportItem, d?: Decision): string {
  if (!d) return "Pending";
  if (d === "approved")
    return i.kind === "widget" && i.status === "approximate"
      ? "Approved, still approximate"
      : "Approved";
  if (d === "flagged") return "Flagged";
  return "Acknowledged";
}

export function decisionMeaning(i: ReportItem, d: Decision): string {
  if (i.kind === "monitor")
    return d === "approved" ? "Import the check rule." : "Do not import the check rule.";
  if (d === "approved") return "Import the translated panel.";
  if (d === "flagged") return "Import a placeholder panel with the note.";
  return "Imported as a placeholder panel.";
}

export interface ImportPlan {
  translated: number;
  placeholders: number;
  checkRules: { total: number; approved: number };
  pending: number;
  reviewable: number;
}

export function importPlan(report: Report, state: ReviewState): ImportPlan {
  let translated = 0,
    placeholders = 0,
    pending = 0,
    reviewable = 0;
  const checkRules = { total: 0, approved: 0 };
  for (const i of report.items) {
    if (i.kind === "group") continue;
    const d = state.decisions[i.id]?.decision;
    if (isReviewable(i)) {
      reviewable++;
      if (!d) pending++;
    }
    if (i.kind === "monitor") {
      checkRules.total++;
      if (d === "approved") checkRules.approved++;
      continue;
    }
    if (i.status === "exact") translated++;
    else if (i.status === "approximate") {
      if (d === "approved") translated++;
      else if (d === "flagged") placeholders++;
    } else placeholders++;
  }
  return { translated, placeholders, checkRules, pending, reviewable };
}

export function planText(p: ImportPlan): string {
  const rule =
    p.checkRules.total === 0
      ? "0 check rules"
      : `${p.checkRules.total} check rule${p.checkRules.total > 1 ? "s" : ""} (${p.checkRules.approved === p.checkRules.total ? "approved" : "not approved"})`;
  return `Plan: 1 dashboard (${p.translated} translated panels, ${p.placeholders} placeholders), ${rule}. ${p.pending} items pending.`;
}

export function buildReviewJson(report: Report, sha: string, state: ReviewState) {
  const items = new Map(report.items.map((i) => [i.id, i]));
  return {
    schema_version: "1",
    report_sha256: sha,
    reviewer: state.reviewer,
    decisions: Object.entries(state.decisions)
      .filter(([id, d]) => {
        const item = items.get(id);
        return (
          item &&
          allowedDecisions(item).includes(d.decision) &&
          (item.kind !== "monitor" || d.decision !== "approved" || checklistComplete(state, id))
        );
      })
      .map(([id, d]) => ({ id, decision: d.decision, note: d.note })),
  };
}

export const storageKey = (sha: string) => `mrc-review:${sha}`;
