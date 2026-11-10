import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FilterSelect } from "@/components/items/FilterSelect";
import { DetailDrawer } from "@/components/detail/DetailDrawer";
import { ReasonChips } from "@/components/items/ReasonChips";
import { typeLabel } from "@/lib/presentation";
import { StatusBadge, ReviewBadge, itemClasses } from "@/components/status-ui";
import { useReport } from "@/lib/report-store";
import { displayTitle, fidelityLabel, isTextNote, STATUSES } from "@/lib/report";
import { metaFor, COPY } from "@/lib/status";
import { isReviewable } from "@/lib/review";

export const Route = createFileRoute("/items")({
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "Items · Migration Review Console" },
      {
        name: "description",
        content:
          "Every widget and the check rule from the migration report, filterable by status and group.",
      },
      { property: "og:title", content: "Items · Migration Review Console" },
      { property: "og:description", content: "Every migrated widget and alert in one table." },
    ],
  }),
  component: ItemsPage,
});

function ItemsPage() {
  const { report, review } = useReport();
  const [search, setSearch] = useState("");
  const [fidelity, setFidelity] = useState("all");
  const [decision, setDecision] = useState("all");
  const [kind, setKind] = useState("non-group");
  const [group, setGroup] = useState("all");
  const [notesOpen, setNotesOpen] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const groups = [...new Set(report.items.flatMap((i) => (i.group ? [i.group] : [])))];
  const items = report.items.filter((i) => {
    const d = review.decisions[i.id]?.decision ?? (isReviewable(i) ? "pending" : "not-required");
    return (
      (fidelity === "all" || i.status === fidelity) &&
      (decision === "all" || d === decision) &&
      (kind === "all" || (kind === "non-group" ? i.kind !== "group" : i.kind === kind)) &&
      (group === "all" || i.group === group) &&
      [i.id, i.title ?? "", ...i.source_queries, ...i.promql]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  });
  const sections = [
    { key: "exact-under", label: "Exact if", status: "exact" },
    ...STATUSES.map((status) => ({ key: status, label: metaFor(status).label, status })),
    { key: "notes", label: "Text notes · copied as text", status: "exact" },
  ];
  return (
    <div className="space-y-5 px-8 py-7">
      <div className="flex items-baseline gap-3">
        <h2 className="text-4xl font-semibold">Items</h2>
        <span className="font-mono text-sm text-muted-foreground">{items.length}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search items"
          placeholder="Search title, ID or query"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-60"
        />
        {["all", ...STATUSES].map((status) => (
          <Button
            key={status}
            variant="outline"
            className={cn("console-chip h-7", fidelity === status && "border-primary text-primary")}
            onClick={() => setFidelity(status)}
          >
            {fidelity === status && <span className="size-1.5 bg-primary" />}
            {status === "all" ? "All fidelity" : status === "no_data" ? "No metric" : status}
          </Button>
        ))}
        {[
          { value: "non-group", label: "All items" },
          { value: "widget", label: "Widgets" },
          { value: "monitor", label: "Check rules" },
        ].map((k) => (
          <Button
            key={k.value}
            variant="outline"
            className={cn("console-chip h-7", kind === k.value && "border-primary text-primary")}
            onClick={() => setKind(k.value)}
          >
            {k.label}
          </Button>
        ))}
        <FilterSelect
          label="Group"
          value={group}
          onChange={setGroup}
          options={[
            { value: "all", label: "All groups" },
            ...groups.map((g) => ({ value: g, label: g })),
          ]}
        />
      </div>
      <div className="items-columns section-label border-b px-3 py-2">
        {["Title", "ID", "Group", "Type", "Reasons", "Target", "Review", ""].map((h, n) => (
          <span key={n}>{h}</span>
        ))}
      </div>
      {sections.map((section) => {
        const rows = items.filter((i) =>
          section.key === "notes"
            ? isTextNote(i)
            : !isTextNote(i) &&
              (section.key === "exact-under"
                ? i.claim === "exact-under"
                : i.status === section.status && i.claim !== "exact-under"),
        );
        if (!rows.length) return null;
        return (
          <section key={section.key} className="border-t border-rule">
            <div className="flex h-9 items-center gap-2">
              {section.key === "notes" ? (
                <Button
                  variant="ghost"
                  className="section-label h-7 px-0"
                  onClick={() => setNotesOpen((v) => !v)}
                >
                  {notesOpen ? "−" : "+"} {section.label}
                </Button>
              ) : (
                <StatusBadge status={section.status} conditional={section.key === "exact-under"} />
              )}
              <span className="font-mono text-xs text-muted-foreground">{rows.length}</span>
            </div>
            {(section.key !== "notes" || notesOpen) &&
              rows.map((i) => (
                <div
                  key={i.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${i.id}`}
                  onClick={() => setOpened(i.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setOpened(i.id);
                  }}
                  className={cn(
                    "items-columns min-h-11 cursor-pointer items-center border-b px-3 text-xs hover:bg-surface",
                    opened === i.id && "border-l-2 border-l-primary bg-accent",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {!isTextNote(i) && (
                      <span className={cn("size-2.5 shrink-0", itemClasses(i).fill)} />
                    )}
                    <span className="truncate text-sm font-medium">{displayTitle(i)}</span>
                  </div>
                  <code className="whitespace-nowrap text-[11px] text-muted-foreground">
                    {i.id}
                  </code>
                  <span className="truncate text-body">{i.group ?? "n/a"}</span>
                  <span className="font-mono text-[10px] uppercase text-muted-foreground">
                    {typeLabel(i)}
                  </span>
                  <div className="flex min-w-0 items-start gap-1 py-1">
                    <ReasonChips codes={i.reason_codes.slice(0, 2)} />
                    {i.reason_codes.length > 2 && (
                      <span className="font-mono text-[10px]">+{i.reason_codes.length - 2}</span>
                    )}
                  </div>
                  <span className="break-words font-mono text-[11px] leading-4 text-body">
                    {i.target_panel ?? "n/a"}
                  </span>
                  <div>
                    {isReviewable(i) ? (
                      <ReviewBadge item={i} decision={review.decisions[i.id]?.decision} />
                    ) : (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        Not required
                      </span>
                    )}
                  </div>
                  <ArrowRight className="size-3 text-muted-foreground" />
                </div>
              ))}
          </section>
        );
      })}
      {items.length === 0 && (
        <p className="py-12 text-center text-muted-foreground">{COPY.empty}</p>
      )}
      <DetailDrawer
        item={report.items.find((i) => i.id === opened)}
        close={() => setOpened(null)}
      />
    </div>
  );
}
