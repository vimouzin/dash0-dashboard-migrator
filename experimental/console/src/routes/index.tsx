import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ExternalLink } from "lucide-react";
import { classesFor, NA } from "@/components/status-ui";
import { useReport } from "@/lib/report-store";
import { widgetBreakdown } from "@/lib/report";
import { metricWidgetsLine, textAndLogsLine } from "@/lib/presentation";
import { STATUS_META, metaFor } from "@/lib/status";
import { explainCode } from "@/lib/reason-codes";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "Overview · Migration Review Console" },
      {
        name: "description",
        content:
          "Summary of a Datadog to Dash0 migration: translation fidelity per widget, the check rule, and verification.",
      },
      { property: "og:title", content: "Overview · Migration Review Console" },
      {
        property: "og:description",
        content: "Summary of a deterministic Datadog to Dash0 migration report.",
      },
    ],
  }),
  component: Overview,
});

function Overview() {
  const { report, sha, sourceName, select } = useReport();
  const counts = widgetBreakdown(report.items);
  const work = report.items.filter((i) => i.kind !== "group");
  const widgets = report.items.filter((i) => i.kind === "widget").length;
  const example =
    report.items.find((i) => i.id === "widget-4.1") ??
    report.items.find((i) => i.status === "approximate" && i.source_queries.length >= 2);
  const validation = work.filter((i) => typeof i.verification?.promql_valid === "boolean");
  const imports = work.filter((i) => typeof i.verification?.imported === "boolean");
  const stages = [
    { label: "Read", value: work.length ? `${work.length} widgets & monitors` : null },
    {
      label: "Parse",
      value: work.some((i) => i.source_queries.length)
        ? `${work.reduce((n, i) => n + i.source_queries.length, 0)} source queries`
        : null,
    },
    {
      label: "Map metrics",
      value:
        report.summary.metrics?.mapped !== undefined
          ? `${report.summary.metrics.mapped} / ${report.summary.metrics.total ?? "n/a"} mapped`
          : null,
    },
    {
      label: "Translate",
      value: work.some((i) => i.promql.length)
        ? `${work.filter((i) => i.promql.length).length} items with PromQL`
        : null,
    },
    {
      label: "Validate",
      value: validation.length
        ? `${validation.filter((i) => i.verification?.promql_valid).length} valid`
        : null,
    },
    {
      label: "Import",
      value: imports.length
        ? `${imports.filter((i) => i.verification?.imported).length} imported`
        : null,
    },
  ];
  const current = stages.reduce((last, s, index) => (s.value !== null ? index : last), -1);
  const notRecorded = (v: string | undefined) => v ?? "not recorded";
  const footer = [
    ["Source file", notRecorded(report.run.source)],
    ["Commit", notRecorded(report.run.source_commit)],
    ["Mapping version", notRecorded(report.run.mapping_version)],
    ["Tool version", notRecorded(report.run.tool_version)],
    ["Schema version", notRecorded(report.schema_version)],
    ["Loaded file", sourceName],
    ["Report SHA256", sha],
    ...Object.entries(report.summary.verification).map(([k, v]) => [
      k.replace(/_/g, " "),
      v === null ? "not run" : String(v),
    ]),
  ];
  return (
    <div className="overview-page">
      <section className="px-8 pt-7 pb-6">
        <div className="section-label mb-3">
          Migration report · {report.run.source ?? "source not recorded"}
        </div>
        <h2 className="text-4xl font-semibold leading-tight">
          {widgets} widgets assessed. Every translation accounted for.
        </h2>
        <p className="mt-2 text-sm text-body">{metricWidgetsLine(counts)}.</p>
        <p className="mt-1 text-sm text-body">
          {textAndLogsLine(counts)}.{" "}
          {report.items.filter((i) => i.kind === "group").length > 0 &&
            `${report.items.filter((i) => i.kind === "group").length} layout groups, reported separately. `}
          {counts.checkRules} monitor, translated as a Dash0 check rule.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {[
            "Deterministic rules",
            "No AI in translation",
            "Every item accounted for",
            "Report fingerprinted",
          ].map((label) => (
            <span className="console-chip" key={label}>
              ✓ {label}
            </span>
          ))}
        </div>
      </section>
      <section className="mx-8 border-t border-rule py-6">
        <div className="grid grid-cols-6">
          {stages.map((stage, index) => (
            <div key={stage.label} className="min-w-0 border-t border-border pr-3">
              <span
                className={cn(
                  "-mt-3 mb-3 flex size-6 items-center justify-center border font-mono text-[10px]",
                  index === current
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground",
                )}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="text-lg font-medium uppercase">{stage.label}</h3>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {stage.value ?? "not run"}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[10px] text-body">
          <code>dd2dash0 migrate --from datadog --input ./exports --dry-run</code>
          <code>export review.json</code>
          <code>dd2dash0 migrate --from datadog --input ./exports</code>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Commands provisional.</p>
      </section>
      <section className="mx-8 grid grid-cols-4 divide-x divide-border border-t border-rule py-5">
        {[
          { value: counts.metrics, label: "metric widgets" },
          { value: counts.differences, label: "translated with known differences" },
          { value: counts.manual, label: "can't migrate automatically" },
          { value: counts.checkRules, label: "check rule" },
        ].map((n) => (
          <div key={n.label} className="min-w-0 px-5 first:pl-0">
            <div className="console-number">{n.value}</div>
            <p className="mt-2 font-mono text-[11px] uppercase">{n.label}</p>
          </div>
        ))}
      </section>
      {example && (
        <section className="bg-band px-8 py-6 text-band-foreground">
          <div className="section-label text-band-foreground">One widget, end to end</div>
          <h3 className="mt-2 mb-4 text-2xl font-semibold">{example.title}</h3>
          <div className="grid grid-cols-3 divide-x divide-border bg-band-panel p-5">
            <div className="min-w-0 pr-5">
              <h4 className="mb-3 font-mono text-[11px] uppercase">Source · Datadog</h4>
              {example.source_queries.map((q, i) => (
                <div key={i} className="mb-2 query-line">
                  <span className="text-band-highlight">query{i + 1} </span>
                  {q}
                </div>
              ))}
              <p className="query-line">formula {example.source_formula.join(", ") || "n/a"}</p>
            </div>
            <div className="min-w-0 px-5">
              <h4 className="mb-3 font-mono text-[11px] uppercase">Rules applied</h4>
              {example.reason_codes.map((code, i) => (
                <div key={code} className="mb-2 text-sm">
                  <span className="mr-2 text-band-highlight">{i + 1}.</span>
                  {explainCode(code)}
                  <code className="mt-1 block font-mono text-[10px] text-band-highlight">
                    {code}
                  </code>
                </div>
              ))}
            </div>
            <div className="min-w-0 pl-5">
              <div className="border-t-2 border-band-highlight pt-3">
                <h4 className="font-mono text-[11px] uppercase">Verdict</h4>
                <h3 className="mt-2 text-xl font-semibold text-band-highlight">
                  {metaFor(example.status).label}
                </h3>
                <p className="mt-2 text-sm">{metaFor(example.status).copy}</p>
                <Link
                  to="/map"
                  onClick={() => select(example.id)}
                  className="mt-4 inline-flex items-center gap-2 text-sm underline"
                >
                  Open in map <ArrowRight className="size-4" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}
      <section className="mx-8 grid grid-cols-[1fr_80px_1fr] gap-5 border-t border-rule py-6">
        <div>
          <h3 className="section-label mb-3">The tool</h3>
          {[
            "Parses every query",
            "Applies written rules",
            "Labels every difference",
            "Refuses what it can't translate",
          ].map((t) => (
            <p key={t} className="border-b py-1 text-sm">
              {t}
            </p>
          ))}
        </div>
        <div className="flex flex-col items-center">
          <span className="section-label text-primary">The line</span>
          <span className="mt-3 w-px flex-1 bg-primary" />
        </div>
        <div>
          <h3 className="section-label mb-3">You</h3>
          {[
            "Approve approximate panels",
            "Acknowledge placeholders",
            "Sign off the check rule",
            "Export review.json",
          ].map((t) => (
            <p key={t} className="border-b py-1 text-sm">
              {t}
            </p>
          ))}
        </div>
      </section>
      <footer className="mx-8 grid grid-cols-5 gap-x-5 gap-y-4 border-t border-rule py-5">
        {footer.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <div className="section-label mb-1">{label}</div>
            <p className="truncate font-mono text-[11px] text-body" title={value ?? undefined}>
              {value ?? "not run"}
            </p>
          </div>
        ))}
      </footer>
    </div>
  );
}
