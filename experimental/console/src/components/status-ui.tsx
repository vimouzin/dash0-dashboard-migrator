import { Check, Flag, CircleDot, Eye } from "lucide-react";
import { STATUSES, type Counts, type ReportItem } from "@/lib/report";
import { metaFor, STATUS_META } from "@/lib/status";
import { decisionLabel, type Decision } from "@/lib/review";
import { cn } from "@/lib/utils";

// Literal class names so Tailwind keeps them.
export const STATUS_CLASSES: Record<
  string,
  { fg: string; bg: string; border: string; fill: string }
> = {
  exact: {
    fg: "text-status-exact",
    bg: "bg-status-exact-bg",
    border: "border-status-exact-edge",
    fill: "bg-status-exact-edge",
  },
  conditional: {
    fg: "text-status-conditional",
    bg: "bg-status-conditional-bg",
    border: "border-status-conditional-edge",
    fill: "bg-status-conditional-edge",
  },
  approx: {
    fg: "text-status-approx",
    bg: "bg-status-approx-bg",
    border: "border-status-approx-edge",
    fill: "bg-status-approx-edge",
  },
  nodata: {
    fg: "text-status-nodata",
    bg: "bg-status-nodata-bg",
    border: "border-status-nodata-edge",
    fill: "bg-status-nodata-edge",
  },
  unsupported: {
    fg: "text-status-unsupported",
    bg: "bg-status-unsupported-bg",
    border: "border-status-unsupported-edge",
    fill: "bg-status-unsupported-edge",
  },
  failed: {
    fg: "text-status-failed",
    bg: "bg-status-failed-bg",
    border: "border-status-failed-edge",
    fill: "bg-status-failed-edge",
  },
};
export const classesFor = (status: string) =>
  STATUS_CLASSES[metaFor(status).token] ??
  (STATUS_CLASSES["nodata"] as { fg: string; bg: string; border: string; fill: string });
export const itemClasses = (item: ReportItem) =>
  item.status === "exact" && item.claim === "exact-under"
    ? (STATUS_CLASSES["conditional"] ?? classesFor(item.status))
    : classesFor(item.status);

export function StatusBadge({
  status,
  label,
  size = "sm",
  conditional = false,
}: {
  status: string;
  label?: string | undefined;
  size?: "sm" | "lg";
  conditional?: boolean;
}) {
  const m = metaFor(status);
  const c = conditional
    ? (STATUS_CLASSES["conditional"] ?? classesFor(status))
    : classesFor(status);
  const short = conditional
    ? (label ?? "Exact if")
    : status === "no_data"
      ? "No metric"
      : (label ?? m.label);
  return (
    <span className={cn("console-chip", c.fg)}>
      <span className={cn("size-2.5 shrink-0", c.fill)} aria-hidden />
      {short}
    </span>
  );
}

export function ReviewBadge({
  item,
  decision,
}: {
  item: ReportItem;
  decision?: Decision | undefined;
}) {
  const Icon =
    decision === "approved" || decision === "acknowledged"
      ? Check
      : decision === "flagged"
        ? Flag
        : null;
  return (
    <span
      className={cn(
        "review-badge inline-flex h-[22px] items-center gap-1.5 rounded-[2px] px-2 font-mono text-[10px] uppercase whitespace-nowrap",
        decision === "approved"
          ? "bg-accent text-primary"
          : decision === "flagged"
            ? "bg-warn text-warn-foreground"
            : "bg-muted text-body",
      )}
    >
      {Icon && <Icon className="size-3" aria-hidden />}
      {decisionLabel(item, decision)}
    </span>
  );
}

export function StatusBar({
  counts,
  showLabels = true,
  className,
}: {
  counts: Counts;
  showLabels?: boolean;
  className?: string;
}) {
  const total = STATUSES.reduce((a, s) => a + counts[s], 0) || 1;
  return (
    <div
      className={cn("flex w-full overflow-hidden rounded-md", className)}
      role="img"
      aria-label={STATUSES.map((s) => `${STATUS_META[s].label} ${counts[s]}`).join(", ")}
    >
      {STATUSES.map((s) => {
        const n = counts[s];
        const c = classesFor(s);
        const Icon = STATUS_META[s].icon;
        return (
          <div
            key={s}
            className={cn(
              "flex min-w-0 items-center gap-1.5 px-2.5 text-sm font-medium",
              c.bg,
              c.fg,
              n === 0 && "px-2",
            )}
            style={{ flexGrow: n === 0 ? 0 : n / total, flexBasis: "auto", flexShrink: 1 }}
            title={`${STATUS_META[s].label}: ${n}`}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="tabular font-semibold">{n}</span>
            {showLabels && n > 0 && <span className="truncate">{STATUS_META[s].short}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function NA() {
  return <span className="text-muted-foreground">n/a</span>;
}
