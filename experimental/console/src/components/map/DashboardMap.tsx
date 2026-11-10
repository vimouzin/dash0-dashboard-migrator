import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Flag, Eye, FileText } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { itemClasses } from "@/components/status-ui";
import { useReport } from "@/lib/report-store";
import { buildMapLayout, type PlacedGroup } from "@/lib/layout";
type CompactGroup = PlacedGroup & { tracks: number[] };
import { displayTitle, isTextNote, noSamplesYet, type ReportItem } from "@/lib/report";
import { metaFor } from "@/lib/status";
import { explainCode } from "@/lib/reason-codes";
import { typeLabel } from "@/lib/presentation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ROW = 28; // px per Datadog row unit
const GAP = 2;
const MIN_TILE = 28;

function WidgetBox({ item, style }: { item: ReportItem; style: React.CSSProperties }) {
  const { selectedId, select, review } = useReport();
  const m = metaFor(item.status);
  const c = itemClasses(item);
  const Icon = isTextNote(item) ? FileText : m.icon;
  const d = review.decisions[item.id]?.decision;
  const DIcon =
    d === "approved" ? Check : d === "flagged" ? Flag : d === "acknowledged" ? Eye : null;
  const selected = selectedId === item.id;
  const note = isTextNote(item);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          data-tone={
            item.status === "exact" && item.claim === "exact-under" ? "conditional" : m.token
          }
          onClick={() => select(item.id)}
          style={{ ...style, minHeight: MIN_TILE }}
          className={cn(
            "map-tile group relative flex h-auto min-w-0 flex-col items-start justify-start gap-0.5 whitespace-normal rounded-[2px] px-1.5 py-1 text-left transition",
            note
              ? "border border-dashed border-note-border bg-background text-muted-foreground"
              : "border border-border border-l-4 bg-background text-foreground",
            selected
              ? "z-10 outline-2 outline-primary outline-offset-0 bg-accent"
              : "hover:border-foreground",
          )}
        >
          {note ? (
            <span className="font-mono text-[10px] text-muted-foreground">TEXT</span>
          ) : (
            <>
              <div className="flex w-full min-w-0 items-center gap-1.5">
                <span className={cn("size-2.5 shrink-0", c.fill)} aria-label={m.label} />
                <span className="truncate font-mono text-[10px] uppercase text-muted-foreground">
                  {typeLabel(item)}
                </span>
                {DIcon && <DIcon className="ml-auto size-3 shrink-0" aria-label={d} />}
              </div>
              <span className="line-clamp-2 w-full text-sm font-medium leading-4">
                {item.title || item.id}
              </span>
            </>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        <div className="font-semibold">{item.title || displayTitle(item)}</div>
        <div className="text-xs opacity-80">
          {item.widget_type} · {item.id}
        </div>
        <div className="mt-1">
          {m.label}
          {noSamplesYet(item) ? " · No samples yet" : ""}
        </div>
        {item.reason_codes.map((rc) => (
          <div key={rc} className="mt-1 text-xs">
            <p>{explainCode(rc) ?? "No explanation supplied."}</p>
            <code className="block font-mono text-xs opacity-80">{rc}</code>
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function GroupSection({ g, row }: { g: CompactGroup; row: number }) {
  return (
    <section
      style={{ gridColumn: `${g.x + 1} / span ${g.w}` }}
      className="flex min-w-0 flex-col border-t border-rule pt-1"
    >
      <h3 className="section-label mb-1 flex items-center justify-between px-1 leading-4">
        <span className="truncate">{g.title}</span>
        <span className="tabular text-xs font-normal">{g.widgets.length}</span>
      </h3>
      <div
        className="grid flex-1"
        style={{
          gridTemplateColumns: `repeat(${g.cols ?? g.w}, minmax(0, 1fr))`,
          // Rows keep at least row*weight px but stretch to the band height, so shorter groups have no empty strip.
          gridTemplateRows: g.tracks
            .map((weight) => `minmax(${Math.max(14, row * weight)}px, ${weight}fr)`)
            .join(" "),
          gap: GAP,
        }}
      >
        {g.widgets.map(({ item, box }) => (
          <div
            key={item.id}
            className={cn("flex", box.h >= 3 && "tall group")}
            style={{
              gridColumn: `${box.x + 1} / span ${box.w}`,
              gridRow: `${box.y + 1} / span ${box.h}`,
            }}
          >
            <WidgetBox
              item={item}
              style={{ width: "100%", height: isTextNote(item) ? "50%" : "100%" }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function DashboardMap() {
  const { report } = useReport();
  const layout = useMemo(() => {
    const original = buildMapLayout(report.items);
    return {
      ...original,
      bands: original.bands.map((band) => ({
        groups: band.groups.map((g) => {
          const boundaries = [
            ...new Set([0, ...g.widgets.flatMap(({ box }) => [box.y, box.y + box.h])]),
          ].sort((a, b) => a - b);
          const widgets = g.widgets.map(({ item, box }) => ({
            item,
            box: {
              ...box,
              y: boundaries.indexOf(box.y),
              h: boundaries.indexOf(box.y + box.h) - boundaries.indexOf(box.y),
            },
          }));
          const tracks = boundaries.slice(0, -1).map((_, y) => {
            const occupants = widgets.filter(({ box }) => y >= box.y && y < box.y + box.h);
            return occupants.length && occupants.every(({ item }) => isTextNote(item)) ? 0.5 : 1;
          });
          return { ...g, widgets, tracks };
        }),
      })),
    };
  }, [report]);
  const container = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry?.contentRect.height ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const units = layout.bands.reduce(
    (sum, band) =>
      sum + Math.max(1, ...band.groups.map((g) => g.tracks.reduce((a, b) => a + b, 0))),
    0,
  );
  const row = Math.max(
    ROW,
    (height - 4 - (layout.grouped ? 32 : 0) - layout.bands.length * 33 - units * GAP) /
      Math.max(1, units),
  );

  return (
    <div ref={container} className="flex h-full min-h-0 flex-col">
      <div className="map-canvas flex min-w-0 flex-col gap-2">
        {layout.grouped && (
          <div
            className="section-label px-1 leading-4"
            title="The report has no group layouts, so groups are built from each widget's group field."
          >
            Grouped overview
          </div>
        )}
        {layout.bands.map((b, i) => (
          <div
            key={i}
            className="grid gap-0.5"
            style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}
          >
            {b.groups.map((g) => (
              <GroupSection key={g.title} g={g} row={row} />
            ))}
          </div>
        ))}
        {layout.unplaced.length > 0 && (
          <section className="rounded-md bg-surface p-1">
            <h3 className="mb-1 px-1 text-sm font-semibold text-muted-foreground">
              Unplaced (no group or layout in the report)
            </h3>
            <div className="grid grid-cols-6 gap-1">
              {layout.unplaced.map((it) => (
                <WidgetBox key={it.id} item={it} style={{}} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
