import { createFileRoute } from "@tanstack/react-router";
import { Bell, ExternalLink } from "lucide-react";
import { DashboardMap } from "@/components/map/DashboardMap";
import { DetailPanel } from "@/components/detail/DetailPanel";
import { ReviewBadge, StatusBadge, classesFor } from "@/components/status-ui";
import { PlanSummary, ExportButton, ReviewerInput } from "@/components/ImportPlan";
import { useReport } from "@/lib/report-store";
import { metaFor } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { STATUSES, widgetBreakdown } from "@/lib/report";
import { importPlan } from "@/lib/review";
import { metricWidgetsLine, textAndLogsLine } from "@/lib/presentation";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/map")({
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "Dashboard map · Migration Review Console" },
      {
        name: "description",
        content:
          "The Datadog Redis dashboard redrawn, every widget coloured by how faithfully it was translated to Dash0.",
      },
      { property: "og:title", content: "Dashboard map · Migration Review Console" },
      {
        property: "og:description",
        content: "What survived the Datadog to Dash0 migration, widget by widget.",
      },
    ],
  }),
  component: MapPage,
});

function MapPage() {
  const { report, selectedId } = useReport();
  const counts = widgetBreakdown(report.items);
  const pending = importPlan(report, useReport().review).pending;
  const liveUrl = report.items.find((i) => i.dash0?.url)?.dash0?.url;
  const selected =
    report.items.find((i) => i.id === selectedId) ??
    report.items.find((i) => i.kind === "monitor") ??
    report.items[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-6 pt-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="section-label mb-2 break-words">
              Source dashboard · {report.run.source ?? "not recorded"}
            </div>
            <h2 className="text-[32px] font-semibold leading-tight">
              What survived the migration?
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs">{pending} decisions pending</span>
            {liveUrl ? (
              <Button asChild variant="outline">
                <a href={liveUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open live dashboard in Dash0
                </a>
              </Button>
            ) : (
              <Button variant="outline" disabled>
                <ExternalLink />
                Not imported yet
              </Button>
            )}
          </div>
        </div>
        <div className="mt-5 grid grid-cols-[minmax(0,62fr)_minmax(0,38fr)] gap-6">
          <div>
            <div className="grid grid-cols-3 divide-x divide-border">
              {[
                { value: counts.metrics, label: "metric widgets" },
                { value: counts.differences, label: "translated with known differences" },
                { value: counts.manual, label: "can't migrate automatically" },
              ].map((n) => (
                <div key={n.label} className="min-w-0 px-4 first:pl-0">
                  <div className="console-number">{n.value}</div>
                  <p className="mt-2 font-mono text-[10px] uppercase leading-4">{n.label}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              {metricWidgetsLine(counts)}
            </p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {textAndLogsLine(counts)} · {counts.checkRules} check rule
            </p>
          </div>
          <div
            className="flex flex-wrap content-center items-start gap-2"
            aria-label="Status legend"
          >
            {STATUSES.map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
            {report.items.some((i) => i.claim === "exact-under") && (
              <StatusBadge status="exact" conditional />
            )}
          </div>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,62fr)_minmax(0,38fr)]">
        <div className="min-h-0 min-w-0 px-4 py-3" data-testid="map-canvas">
          <DashboardMap />
        </div>
        <aside className="min-h-0 min-w-0 border-l bg-surface">
          {selected && (
            <DetailPanel key={selected.id} item={selected} className="detail-sticky h-full" />
          )}
        </aside>
      </div>
    </div>
  );
}
