// The whole run: ingest -> translate (T4) -> dashboards (T5) / alerts (T6, interim) -> import (T7) -> report (T8).
// Pure up to the import step; the only network I/O is ingest --api and the Dash0 import.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ingestDatadog, type IngestOptions } from "../sources/datadog/index.js";
import { ddKindLookup, loadDdKinds, loadMappings, metricAvailability, metricLookup, tagLookup } from "../ir/index.js";
import { translateQuery, type TranslateContext } from "../translate/query/index.js";
import { toPerses, type DashboardTranslation, type TranslateExpr, type TranslateLog } from "../translate/dashboard/index.js";
import { loadLogAttributes, translateLogMonitor, translateLogQuery, type LogAttributes } from "../translate/logs/index.js";
import { canonicalJson, importAll, sha256, type Dash0Config, type DashboardDefinition, type Manifest, type PrometheusAlertRule } from "../targets/dash0/index.js";
import { makeAlertConverter, parseChannelMap, type AlertConversion, type ChannelLookup, type ConverterContext } from "../translate/alerts/index.js";
import { translateMonitor } from "../translate/query/index.js";
import type { Alert } from "../ir/index.js";
import { metricNames, summarizeMetrics } from "./metrics.js";

/** Monitor -> check rule. Default: T6 (src/translate/alerts) over T4's translateMonitor, and T12's
 *  translateLogMonitor for "log alert" monitors when the log-attribute table is loaded. */
export type AlertConverter = (a: Alert, ctx: TranslateContext) => AlertConversion;
type T6Context = TranslateContext & ConverterContext;
function defaultAlertConverter(attributes: LogAttributes | null): AlertConverter {
  const t6 = makeAlertConverter((mq, t, ctx: T6Context) => translateMonitor(mq, t, ctx), {
    ...(attributes && { translateLogMonitor: (q: string, t: { critical?: number; warning?: number; variables?: unknown[] }) => translateLogMonitor(q, t, { attributes }) }),
  });
  return (a, ctx) => t6(a, ctx as T6Context);
}
import { buildReport } from "../report/build.js";
import type { Report } from "../report/types.js";
import { coverageCollector, summarizeCoverage, type QueryCoverage } from "../report/query-coverage.js";

export interface MigrateOptions {
  ingest: IngestOptions;
  /** mappings/ directory (contains tags.yaml and datadog/*.yaml). */
  mappingsDir: string;
  outDir: string;
  /** "dry-run" writes payloads only; "live" imports into Dash0; "none" skips the target step. */
  mode: "dry-run" | "live" | "none";
  enableRules?: boolean;
  dash0?: Dash0Config;
  alertConverter?: AlertConverter;
  /**
   * Datadog handle -> existing Dash0 notification channel id (T6 parseChannelMap format). Default:
   * <mappingsDir>/notification-channels.yaml when it exists. Mapped handles are bound on the check rule; the rest
   * stay manual actions in the report. No channel is ever created.
   */
  channelsFile?: string;
  version: string;
  /** How the source is recorded in report.json (as given, so reports don't carry machine paths). */
  source?: { kind: "api" | "folder"; site: string | null; path: string | null };
  /** The resolved config of a `plan` run, recorded in report.json. */
  config?: Record<string, unknown>;
}

export const CHANNELS_FILE = "notification-channels.yaml";

/** The channel map to use: the explicit file (must exist), else the mappings folder's file if present, else none. */
export function loadChannels(mappingsDir: string, file?: string): { file: string; lookup: ChannelLookup } | null {
  const path = file ?? join(mappingsDir, CHANNELS_FILE);
  if (!existsSync(path)) {
    if (file !== undefined) throw new Error(`notification channel map not found: ${file}`);
    return null;
  }
  return { file: path, lookup: parseChannelMap(readFileSync(path, "utf8"), path) };
}

export interface MigrateResult {
  report: Report;
  manifest: Manifest | null;
  dashboards: DashboardTranslation[];
  alerts: { alert: import("../ir/index.js").Alert; conversion: AlertConversion }[];
  /** Coverage by query type over the source's distinct queries and monitors (the report's "by query type" section). */
  queryCoverage: QueryCoverage;
}

export async function migrate(o: MigrateOptions): Promise<MigrateResult> {
  const ingested = await ingestDatadog(o.ingest);
  const mappings = loadMappings(o.mappingsDir);
  const base: TranslateContext = {
    metric: metricLookup(mappings),
    availability: (dd) => metricAvailability(mappings, dd),
    tag: tagLookup(mappings),
    // Datadog's own metric kinds (generated from integrations-core metadata.csv); curated entries win. Without it every
    // unmapped metric is time.kind-unknown and stays manual.
    ddKind: ddKindLookup(loadDdKinds(o.mappingsDir), mappings),
  };
  const channels = loadChannels(o.mappingsDir, o.channelsFile);
  const alertCtx: T6Context = { ...base, ...(channels && { channels: channels.lookup }) };
  const translate: TranslateExpr = (e, t) => translateQuery(e, { ...base, variables: t.variables, where: t.where }, t.env);

  // T12: log queries -> dash0.logs PromQL, when the log-attribute table is present.
  const logAttributesFile = join(o.mappingsDir, "log-attributes.yaml");
  const attributes = existsSync(logAttributesFile) ? loadLogAttributes(logAttributesFile) : null;
  const translateLog: TranslateLog | undefined = attributes ? (q, t) => translateLogQuery(q, { attributes, variables: t.variables, where: t.where, ...(t.scalar && { interval: "$__range" as const }) }) : undefined;

  const dashboards = ingested.dashboards.map((d) => ({ source: d, out: toPerses(d, translate, translateLog, attributes ?? undefined) }));
  const convert = o.alertConverter ?? defaultAlertConverter(attributes);
  const alerts = ingested.alerts.map((alert) => ({ alert, conversion: convert(alert, alertCtx) }));

  let manifest: Manifest | null = null;
  if (o.mode !== "none") {
    const payloads: { dashboards: DashboardDefinition[]; rules: PrometheusAlertRule[] } = {
      dashboards: dashboards.map((d) => d.out.dashboard),
      rules: alerts.flatMap((a) => (a.conversion.rule ? [a.conversion.rule] : [])),
    };
    manifest = await importAll(payloads, {
      dryRun: o.mode === "dry-run",
      outDir: join(o.outDir, "dash0"),
      ...(o.enableRules !== undefined && { enableRules: o.enableRules }),
      ...(o.mode === "live" && o.dash0 ? { config: o.dash0 } : {}),
    });
  }

  const kindsFile = join(o.mappingsDir, "datadog", "_kinds.json");
  const mappingFiles = [join(o.mappingsDir, "tags.yaml"), ...(attributes ? [logAttributesFile] : []), ...readdirSync(join(o.mappingsDir, "datadog")).filter((f) => f.endsWith(".yaml")).sort().map((f) => join(o.mappingsDir, "datadog", f)), ...(existsSync(kindsFile) ? [kindsFile] : []), ...(channels ? [channels.file] : [])];
  const inputHash = inputHashOf(ingested);
  const report = buildReport({
    version: o.version,
    inputHash,
    options: { input: o.ingest.input ? "folder" : "api", only: o.ingest.only ?? "all", mode: o.mode, enableRules: !!o.enableRules },
    mappingFiles: mappingFiles.map((f) => f.replace(/\\/g, "/").split("/").slice(-2).join("/")),
    ingestFindings: ingested.findings,
    dashboards: dashboards.map((d) => ({ source: d.source, translation: d.out })),
    alerts,
    manifest,
    mode: o.mode,
    source: o.source ?? (o.ingest.input ? { kind: "folder", site: null, path: null } : { kind: "api", site: process.env.DD_SITE || "datadoghq.eu", path: null }),
    ...(o.config ? { config: o.config } : {}),
    metrics: summarizeMetrics(metricNames(ingested.dashboards, ingested.alerts), mappings),
  });
  // Coverage by query type: the same translators, over every distinct query and monitor in the raw source.
  const cov = coverageCollector(o.mappingsDir, mappings);
  for (const d of ingested.dashboards) cov.dashboard(d.original, d.title);
  for (const a of ingested.alerts) cov.monitor(a.original, a.name);
  return { report, manifest, dashboards: dashboards.map((d) => d.out), alerts, queryCoverage: summarizeCoverage(cov.items, cov.skipped) };
}

/** Hash of the Datadog sources as ingested: the plan records it, and `apply` re-ingests and compares (source drift). */
export function inputHashOf(ingested: { dashboards: { original: unknown }[]; alerts: { original: unknown }[] }): string {
  return sha256(canonicalJson({ dashboards: ingested.dashboards.map((d) => d.original), alerts: ingested.alerts.map((a) => a.original) }));
}

/** Exit status for the CLI: fail only when something we tried to import failed or was rejected. */
export function overallOk(r: MigrateResult): boolean {
  return !r.manifest || (r.manifest.summary.failed === 0 && r.manifest.summary["rejected-preflight"] === 0);
}

