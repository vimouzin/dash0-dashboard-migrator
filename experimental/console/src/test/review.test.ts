import { describe, expect, it } from "vitest";
import sample from "@/data/report.sample.json?raw";
import { parseReport, type ReportItem } from "@/lib/report";
import {
  allowedDecisions,
  buildReviewJson,
  CHECK_RULE_CHECKLIST,
  checklistComplete,
  emptyReview,
  importPlan,
  isReviewable,
} from "@/lib/review";
import { canAcknowledgeAll, reviewQueue } from "@/lib/review-queue";
const parsed = parseReport(sample);
if (!parsed.ok) throw new Error(parsed.error);
const report = parsed.report;
function item(kind: ReportItem["kind"], status: string): ReportItem {
  return {
    id: "test",
    kind,
    status,
    source_queries: [],
    source_formula: [],
    promql: [],
    reason_codes: [],
    raw: {},
  };
}

describe("Review rules", () => {
  it("permits bulk acknowledgement only for no-equivalent and unsupported widget groups", () => {
    expect(canAcknowledgeAll([item("widget", "no_data"), item("widget", "unsupported")])).toBe(
      true,
    );
    expect(canAcknowledgeAll([item("widget", "no_data"), item("widget", "approximate")])).toBe(
      false,
    );
    expect(canAcknowledgeAll([item("monitor", "unsupported")])).toBe(false);
    expect(canAcknowledgeAll([item("widget", "failed")])).toBe(false);
    expect(canAcknowledgeAll([])).toBe(false);
  });
  it("excludes groups and exact widgets", () => {
    expect(isReviewable(item("group", "approximate"))).toBe(false);
    expect(isReviewable(item("widget", "exact"))).toBe(false);
    expect(reviewQueue(report.items)).toHaveLength(30);
  });
  it("allows approve or flag for approximate widgets", () =>
    expect(allowedDecisions(item("widget", "approximate"))).toEqual(["approved", "flagged"]));
  it.each(["unsupported", "no_data", "failed"])(
    "allows only acknowledgment for %s widgets",
    (status) => expect(allowedDecisions(item("widget", status))).toEqual(["acknowledged"]),
  );
  it("requires all five check-rule ticks", () => {
    const state = emptyReview();
    CHECK_RULE_CHECKLIST.slice(0, 4).forEach((c) => {
      state.checklist["rule"] = { ...state.checklist["rule"], [c.key]: true };
    });
    expect(CHECK_RULE_CHECKLIST).toHaveLength(5);
    expect(checklistComplete(state, "rule")).toBe(false);
    state.checklist["rule"] = { ...state.checklist["rule"], routing: true };
    expect(checklistComplete(state, "rule")).toBe(true);
  });
  it("orders check rule before failed, unsupported, no equivalent and approximate", () => {
    expect(
      reviewQueue([
        item("widget", "approximate"),
        { ...item("widget", "no_data"), id: "n" },
        { ...item("widget", "unsupported"), id: "u" },
        { ...item("widget", "failed"), id: "f" },
        { ...item("monitor", "approximate"), id: "m" },
      ]).map((i) => i.id),
    ).toEqual(["m", "f", "u", "n", "test"]);
  });
  it("counts live pending decisions and builds the exact export shape", () => {
    const state = emptyReview();
    state.reviewer = "Reviewer";
    state.decisions["widget-4.1"] = { decision: "approved", note: "Checked", at: "ignored" };
    expect(importPlan(report, state).pending).toBe(29);
    expect(buildReviewJson(report, "a".repeat(64), state)).toEqual({
      schema_version: "1",
      report_sha256: "a".repeat(64),
      reviewer: "Reviewer",
      decisions: [{ id: "widget-4.1", decision: "approved", note: "Checked" }],
    });
  });
  it("omits group, exact and invalid rule approvals from export", () => {
    const state = emptyReview();
    for (const id of ["group-1", "widget-1.1", "monitor-high_mem"])
      state.decisions[id] = { decision: "approved", note: "", at: "" };
    expect(buildReviewJson(report, "hash", state).decisions).toEqual([]);
  });
});
