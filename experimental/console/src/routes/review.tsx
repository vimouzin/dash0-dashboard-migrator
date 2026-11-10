import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, RotateCcw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { FilterSelect } from "@/components/items/FilterSelect";
import { DetailDrawer } from "@/components/detail/DetailDrawer";
import { DecisionControl } from "@/components/detail/DetailPanel";
import { StatusBadge } from "@/components/status-ui";
import { ReviewerInput, ExportButton, PlanSummary } from "@/components/ImportPlan";
import { useReport } from "@/lib/report-store";
import { displayTitle, fidelityLabel } from "@/lib/report";
import { canAcknowledgeAll, reviewQueue } from "@/lib/review-queue";
import { reasonLabel, typeLabel } from "@/lib/presentation";
import { ReasonChips } from "@/components/items/ReasonChips";
import { cn } from "@/lib/utils";
import { COPY } from "@/lib/status";

export const Route = createFileRoute("/review")({
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "Review · Migration Review Console" },
      {
        name: "description",
        content: "Approve, flag or acknowledge each non-exact translation before import.",
      },
      { property: "og:title", content: "Review · Migration Review Console" },
      {
        property: "og:description",
        content: "Human sign-off before anything is imported into Dash0.",
      },
    ],
  }),
  component: ReviewPage,
});

function ReviewPage() {
  const { report, review, clearDecisions, decide } = useReport();
  const [filter, setFilter] = useState("all");
  const [opened, setOpened] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const queue = reviewQueue(report.items);
  const reviewed = queue.filter((i) => review.decisions[i.id]).length;
  const pending = queue.find((i) => !review.decisions[i.id]);
  const visible = queue.filter(
    (i) =>
      filter === "all" ||
      (filter === "pending" ? !review.decisions[i.id] : !!review.decisions[i.id]),
  );
  const rules = visible.filter((i) => i.kind === "monitor");
  const groups = [
    ...new Set(
      visible
        .filter((i) => i.kind !== "monitor")
        .map((i) => `${i.status}:${i.reason_codes[0] ?? "other"}`),
    ),
  ].map((key) => ({
    key,
    items: visible.filter(
      (i) => i.kind !== "monitor" && `${i.status}:${i.reason_codes[0] ?? "other"}` === key,
    ),
  }));
  const steps = [
    { label: "Check rule", items: queue.filter((i) => i.kind === "monitor"), anchor: "check-rule" },
    ...["failed", "unsupported", "no_data", "approximate"].map((status) => ({
      label:
        status === "no_data"
          ? "No equivalent metric"
          : status.charAt(0).toUpperCase() + status.slice(1),
      items: queue.filter((i) => i.kind !== "monitor" && i.status === status),
      anchor: status,
    })),
    { label: "Export", items: queue, anchor: "export" },
  ];
  const current = steps.findIndex((s) => s.items.some((i) => !review.decisions[i.id]));
  return (
    <div className="flex min-h-full flex-col">
      <div className="grid flex-1 grid-cols-[240px_minmax(0,1fr)]">
        <aside className="border-r px-5 py-7">
          <div className="sticky top-7 border p-4">
            <div className="pointer-events-none absolute bottom-12 left-[29px] top-10 w-px bg-border" />
            {steps.map((step, index) => {
              const done = step.items.filter((i) => review.decisions[i.id]).length;
              return (
                <Button
                  key={step.label}
                  variant="ghost"
                  className="relative mb-3 h-auto w-full justify-start gap-3 whitespace-normal px-0 py-2 text-left"
                  onClick={() =>
                    document
                      .getElementById(step.anchor)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center border font-mono text-xs",
                      index === current
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border",
                    )}
                  >
                    {step.items.length > 0 && done === step.items.length
                      ? "✓"
                      : String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <span className="block text-sm">{step.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {done} / {step.items.length}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </aside>
        <div className="mx-auto w-full max-w-[1440px] min-w-0 flex-1 space-y-5 px-6 py-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-4xl font-semibold">Review</h2>
            <ReviewerInput />
          </div>
          <p className="text-sm text-body">Human decision needed before import</p>
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-mono text-xs">
              {reviewed} / {queue.length} reviewed
            </span>
            <Progress
              value={queue.length ? (reviewed / queue.length) * 100 : 100}
              className="h-1 w-36 shrink-0"
            />
            <Button
              variant="outline"
              disabled={!pending}
              onClick={() => {
                if (pending) setOpened(pending.id);
              }}
            >
              <ArrowRight /> Next unreviewed
            </Button>
          </div>
          <div className="flex flex-wrap justify-between gap-3 border-b pb-4">
            <FilterSelect
              label="Queue filter"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All items" },
                { value: "pending", label: "Pending" },
                { value: "decided", label: "Decided" },
              ]}
            />
            {confirmClear ? (
              <div className="flex items-center gap-2">
                <span className="text-sm">Clear all decisions and checklist ticks?</span>
                <Button
                  variant="destructive"
                  onClick={() => {
                    clearDecisions();
                    setConfirmClear(false);
                  }}
                >
                  Clear
                </Button>
                <Button variant="ghost" onClick={() => setConfirmClear(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="ghost" disabled={!reviewed} onClick={() => setConfirmClear(true)}>
                <RotateCcw /> Clear decisions
              </Button>
            )}
          </div>
          {rules.map((i) => (
            <article id="check-rule" key={i.id} className="border-t border-rule py-5">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-5">
                <div>
                  <h3 className="section-label mb-3">Check rule</h3>
                  <Button
                    variant="ghost"
                    className="h-auto max-w-full whitespace-normal p-0 text-left text-lg"
                    onClick={() => setOpened(i.id)}
                  >
                    {displayTitle(i)} <ExternalLink />
                  </Button>
                  <code className="my-2 block text-xs text-muted-foreground">{i.id}</code>
                  <StatusBadge status={i.status} label={fidelityLabel(i)} />
                  <p className="mt-3 text-sm text-body">
                    Warning {i.thresholds?.degraded ?? "n/a"}%, critical{" "}
                    {i.thresholds?.failed ?? "n/a"}%
                  </p>
                  <div className="mt-3">
                    <ReasonChips codes={i.reason_codes} />
                  </div>
                </div>
                <DecisionControl item={i} hidePrompt />
              </div>
            </article>
          ))}
          {groups.map(({ key, items }) => {
            const first = items[0];
            if (!first) return null;
            const canBulk = canAcknowledgeAll(items);
            const undecided = items.filter((i) => !review.decisions[i.id]);
            return (
              <section key={key} id={first.status} className="border-t border-rule">
                <div className="mb-1 mt-6 flex items-center justify-between gap-3 border-b py-2 flex-wrap">
                  <h3 className="flex items-center gap-2 font-mono text-xs">
                    <StatusBadge status={first.status} />
                    <span>
                      {reasonLabel(first.reason_codes[0] ?? "Other differences")} · {items.length}
                    </span>
                  </h3>
                  {canBulk && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!undecided.length}
                      onClick={() => items.forEach((i) => decide(i.id, "acknowledged"))}
                    >
                      Acknowledge all {items.length}
                    </Button>
                  )}
                </div>
                {items.map((i) => (
                  <article
                    key={i.id}
                    className="flex min-h-12 items-center justify-between gap-4 border-b py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <Button
                        variant="ghost"
                        className="h-auto max-w-full justify-start whitespace-normal p-0 text-left text-sm"
                        onClick={() => setOpened(i.id)}
                      >
                        {displayTitle(i)}
                      </Button>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                        <code>{i.id}</code>
                        <span>{i.group ?? "n/a"}</span>
                        <span className="font-mono">{typeLabel(i)}</span>
                      </div>
                    </div>
                    <div className="min-w-0 max-w-[480px] shrink-0">
                      <DecisionControl item={i} compact hidePrompt />
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
          {visible.length === 0 && (
            <p className="py-12 text-center text-muted-foreground">{COPY.empty}</p>
          )}
        </div>
      </div>
      <footer
        id="export"
        className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-4 border-t bg-background px-8 py-4"
      >
        <div className="min-w-0 flex-1">
          <PlanSummary />
        </div>
        <ExportButton />
      </footer>
      <DetailDrawer
        item={report.items.find((i) => i.id === opened)}
        close={() => setOpened(null)}
      />
    </div>
  );
}
