import type { ReportItem } from "./report";
import { isReviewable } from "./review";
import { RISK_ORDER } from "./status";

export function reviewQueue(items: ReportItem[]) {
  return items.filter(isReviewable).sort((a, b) => {
    const risk =
      (a.kind === "monitor" ? 0 : (RISK_ORDER[a.status] ?? 8)) -
      (b.kind === "monitor" ? 0 : (RISK_ORDER[b.status] ?? 8));
    return risk || (a.reason_codes[0] ?? "").localeCompare(b.reason_codes[0] ?? "");
  });
}

/** Bulk acknowledgement is restricted to homogeneous placeholder-only widget groups. */
export function canAcknowledgeAll(items: ReportItem[]): boolean {
  return (
    items.length > 0 &&
    items.every(
      (item) =>
        item.kind === "widget" && (item.status === "no_data" || item.status === "unsupported"),
    )
  );
}
