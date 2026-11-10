import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReport } from "@/lib/report-store";
import { buildReviewJson, importPlan, planText } from "@/lib/review";
import { COPY } from "@/lib/status";

export function PlanSummary() {
  const { report, review } = useReport();
  return (
    <code className="break-words font-mono text-xs text-body">
      {planText(importPlan(report, review))}
    </code>
  );
}

export function ExportButton() {
  const { report, review, sha } = useReport();
  const [confirming, setConfirming] = useState(false);
  const plan = importPlan(report, review);
  const noName = !review.reviewer.trim();

  const download = () => {
    if (!sha) return;
    const blob = new Blob([JSON.stringify(buildReviewJson(report, sha, review), null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "review.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setConfirming(false);
  };

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-warn-foreground">
          {plan.pending} items still pending. Export anyway?
        </span>
        <Button size="sm" onClick={download}>
          Export
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <Button
      disabled={noName || !sha}
      title={noName ? "Enter a reviewer name on the Review page first" : COPY.export}
      onClick={() => (plan.pending > 0 ? setConfirming(true) : download())}
    >
      <Download /> Export review.json
    </Button>
  );
}

export function ReviewerInput() {
  const { review, setReviewer } = useReport();
  return (
    <input
      value={review.reviewer}
      onChange={(e) => setReviewer(e.target.value)}
      placeholder="Reviewer name"
      aria-label="Reviewer name"
      className="h-9 w-44 rounded-md border border-input bg-surface px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
