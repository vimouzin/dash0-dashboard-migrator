import { Check, Flag, Eye, Undo2, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeBlock, CopyButton } from "@/components/CodeBlock";
import { StatusBadge, ReviewBadge, NA } from "@/components/status-ui";
import { useReport } from "@/lib/report-store";
import { displayTitle, fidelityLabel, noSamplesYet, type ReportItem } from "@/lib/report";
import { metaFor, COPY } from "@/lib/status";
import { explainCode } from "@/lib/reason-codes";
import {
  allowedDecisions,
  CHECK_RULE_CHECKLIST,
  checklistComplete,
  decisionMeaning,
  isReviewable,
  type Decision,
} from "@/lib/review";
import { cn } from "@/lib/utils";

const sourceNoun = (i: ReportItem) =>
  i.kind === "monitor" ? "monitor" : i.kind === "group" ? "group" : "widget";
const targetNoun = (i: ReportItem) =>
  i.kind === "monitor" ? "check rule" : i.kind === "group" ? "section" : "panel";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-1 text-xs font-mono">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 query-line">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="section-label mb-3">{children}</h4>;
}

function verText(v: boolean | null | undefined) {
  return v === true ? "yes" : v === false ? "no" : "not tested";
}

export function ReasonList({ codes }: { codes: string[] }) {
  if (codes.length === 0) return <p className="text-sm text-muted-foreground">No reason codes.</p>;
  return (
    <ol className="space-y-3 text-body">
      {codes.map((c, index) => (
        <li key={c} className="text-sm">
          <p>
            <span className="mr-2 font-mono text-primary">{index + 1}.</span>
            {explainCode(c) ?? "No explanation supplied."}
          </p>
          <code className="mt-0.5 block font-mono text-xs text-muted-foreground">{c}</code>
        </li>
      ))}
    </ol>
  );
}

function manualContext(i: ReportItem) {
  return [
    `Item: ${i.id} (${displayTitle(i)})`,
    `Datadog ${sourceNoun(i)} type: ${i.widget_type ?? "n/a"}`,
    `Status: ${metaFor(i.status).label}`,
    `Reason: ${i.reason_codes.map((c) => `${explainCode(c) ?? "No explanation supplied"} (${c})`).join("; ") || "n/a"}`,
    `Original queries:`,
    ...(i.source_queries.length ? i.source_queries.map((q) => `  ${q}`) : ["  n/a"]),
    i.source_formula.length ? `Formula: ${i.source_formula.join(", ")}` : "",
    `Source path: ${i.source_path ?? "n/a"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function DecisionControl({
  item,
  compact = false,
  verdict = false,
  hidePrompt = false,
}: {
  item: ReportItem;
  compact?: boolean;
  verdict?: boolean;
  hidePrompt?: boolean;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const { review, decide, setNote, setCheck } = useReport();
  const allowed = allowedDecisions(item);
  const entry = review.decisions[item.id];
  if (!isReviewable(item)) {
    return (
      <p className="text-sm text-muted-foreground">
        {item.kind === "group"
          ? "Layout groups are not reviewed."
          : "Exact translations are imported without review."}
      </p>
    );
  }
  const isRule = item.kind === "monitor";
  const ready = !isRule || checklistComplete(review, item.id);
  const btn = (d: Decision, label: string, Icon: typeof Check) => (
    <Button
      key={d}
      type="button"
      variant={verdict ? "verdict" : entry?.decision === d ? "default" : "outline"}
      size={compact ? "sm" : "default"}
      disabled={d === "approved" && !ready}
      onClick={() => decide(item.id, entry?.decision === d ? null : d)}
      className={cn(
        compact ? "" : "flex-1",
        verdict && d === "approved" && "verdict-approve",
        d === "approved" && (ready ? "approve-ready" : "approve-blocked"),
      )}
    >
      <Icon /> {label}
    </Button>
  );
  return (
    <div className={compact ? "flex flex-wrap items-center justify-end gap-2" : "space-y-3"}>
      <div className="flex items-center justify-between gap-2">
        {(!verdict || entry) && <ReviewBadge item={item} decision={entry?.decision} />}
        {entry && (
          <Button
            variant={verdict ? "verdict" : "ghost"}
            size="sm"
            onClick={() => decide(item.id, null)}
            className="h-7 text-xs"
          >
            <Undo2 /> Undo
          </Button>
        )}
      </div>
      {!compact && (
        <p className="text-sm text-muted-foreground">
          {entry?.decision === "approved" && item.status === "approximate" && item.kind === "widget"
            ? COPY.approved
            : entry
              ? decisionMeaning(item, entry.decision)
              : hidePrompt
                ? null
                : COPY.reviewRequired}
        </p>
      )}
      {isRule && (
        <fieldset className="space-y-2 border-0 p-0">
          <legend className="px-1 text-xs font-semibold  text-muted-foreground uppercase">
            Check before approving
          </legend>
          {CHECK_RULE_CHECKLIST.map((c) => {
            const id = `chk-${item.id}-${c.key}`;
            return (
              <label
                key={c.key}
                htmlFor={id}
                className="flex cursor-pointer items-start gap-2.5 text-sm"
              >
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={!!review.checklist[item.id]?.[c.key]}
                  onCheckedChange={(v) => setCheck(item.id, c.key, v === true)}
                />
                <span>{c.label}</span>
              </label>
            );
          })}
        </fieldset>
      )}
      {isRule && !ready && allowed.includes("approved") && (
        <p className="whitespace-nowrap text-[11px] leading-4 text-muted-foreground" role="status">
          Tick all {CHECK_RULE_CHECKLIST.length} checks to approve
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {allowed.includes("approved") && btn("approved", "Approve", Check)}
        {allowed.includes("flagged") && btn("flagged", "Flag", Flag)}
        {allowed.includes("acknowledged") && btn("acknowledged", "Acknowledge", Eye)}
      </div>
      {compact && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!entry}
          onClick={() => setNoteOpen((v) => !v)}
          aria-label={`Note for ${item.id}`}
        >
          Note{entry?.note ? " ·" : ""}
        </Button>
      )}
      {((!compact && (!verdict || entry)) || noteOpen) && (
        <Textarea
          placeholder={entry ? "Note for the import (optional)" : "Decide first, then add a note"}
          disabled={!entry}
          value={entry?.note ?? ""}
          onChange={(e) => setNote(item.id, e.target.value)}
          aria-label={`Review note for ${item.id}`}
          className={compact ? "min-h-16 basis-full text-sm" : "min-h-16 text-sm"}
        />
      )}
    </div>
  );
}

export function DetailPanel({ item, className }: { item: ReportItem; className?: string }) {
  const { review } = useReport();
  const meta = metaFor(item.status);
  const untested =
    !item.verification ||
    Object.values(item.verification).every((v) => v == null || v === "not_tested");
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-y-auto",
        item.kind === "monitor" && "detail-rule",
        className,
      )}
    >
      <header className="shrink-0 border-b px-5 py-3">
        <div className="section-label mb-1">
          {item.id} · Datadog {sourceNoun(item)}
        </div>
        <h3 className="text-xl font-semibold">{displayTitle(item)}</h3>
      </header>
      <div className="detail-sections">
        <section className="detail-section">
          <SectionTitle>Source · Datadog</SectionTitle>
          <CodeBlock lines={item.source_queries} copy />
          {item.source_formula.length > 0 && (
            <div className="mt-2">
              <Field label="Formula">
                <CodeBlock lines={item.source_formula} copy />
              </Field>
            </div>
          )}
          <Field label="Group">{item.group ?? "n/a"}</Field>
          <Field label="Type">{item.widget_type ?? sourceNoun(item)}</Field>
          {item.thresholds && (
            <Field label="Thresholds">
              Warning {item.thresholds.degraded ?? "n/a"}%, critical{" "}
              {item.thresholds.failed ?? "n/a"}%
            </Field>
          )}
        </section>
        <section className="detail-section">
          <SectionTitle>Rules applied</SectionTitle>
          <ReasonList codes={item.reason_codes} />
        </section>
        <section className="verdict p-4">
          <h4 className="section-label mb-2">Verdict</h4>
          <div className="mb-2 flex items-center gap-2 text-xl font-semibold">
            <span
              className={cn(
                "size-2.5 shrink-0",
                item.status === "exact" && item.claim === "exact-under"
                  ? "bg-status-conditional-edge"
                  : item.status === "approximate"
                    ? "bg-status-approx-edge"
                    : item.status === "no_data"
                      ? "bg-status-nodata-edge"
                      : item.status === "unsupported"
                        ? "bg-status-unsupported-edge"
                        : item.status === "failed"
                          ? "bg-status-failed-edge"
                          : "bg-status-exact-edge",
              )}
            />
            {fidelityLabel(item) ?? meta.label}
          </div>
          <p className="mb-3 text-sm">{meta.copy}</p>
          <Field label="TARGET">{item.target_panel ?? targetNoun(item)}</Field>
          <Field label="REVIEW">
            {review.decisions[item.id]?.decision ??
              (isReviewable(item) ? "pending" : "not required")}
          </Field>
          <div className="mt-3">
            <DecisionControl item={item} verdict hidePrompt />
          </div>
        </section>
        <section className="detail-evidence border-t pt-3">
          {item.promql.length > 0 && (
            <details className="mb-2 text-xs text-body">
              <summary className="cursor-pointer font-mono">Target · PromQL</summary>
              <CodeBlock lines={item.promql} copy />
            </details>
          )}
          {untested ? (
            <p className="text-xs text-body">Evidence: not tested yet</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(item.verification ?? {})
                .filter(([, value]) => value === true)
                .map(([key]) => (
                  <span className="console-chip" key={key}>
                    <Check className="size-3" />
                    {key.replace(/_/g, " ")} verified
                  </span>
                ))}
            </div>
          )}
          {noSamplesYet(item) && <p className="mt-2 text-xs text-body">{COPY.noSamples}</p>}
          {item.dash0?.url && (
            <a href={item.dash0.url} target="_blank" rel="noreferrer" className="text-xs underline">
              Open in Dash0
            </a>
          )}
        </section>
      </div>
    </div>
  );
}
