// Builds report.json from the pipeline's outputs. Pure: same inputs give byte-identical output (no timestamps).
import { isGroup, type Alert, type Dashboard, type Finding, type Panel } from "../ir/index.js";
import type { DashboardTranslation } from "../translate/dashboard/index.js";
import { canonicalJson, dash0Id, sha256, type GridItem, type Manifest } from "../targets/dash0/index.js";
import { validatePromQL } from "../validate/promql.js";
import type { AlertConversion } from "../translate/alerts/index.js";
import { CATALOG, explain, explainPlain, resolveCode } from "../rules/index.js";
import type { ReasonCode, Report, ReportItem, ReportStatus } from "./types.js";

/** sha256 of the canonical rule catalog: the rule version behind a report or plan. */
export function catalogHash(): string {
  return sha256(canonicalJson(CATALOG));
}

type V1Item = Omit<ReportItem, "group_id" | "source_layout" | "condition" | "explain" | "decision_required"> & {
  group_id?: string | null;
  source_layout?: ReportItem["source_layout"];
};

export interface BuildInput {
  version: string;
  inputHash: string;
  options: Record<string, unknown>;
  mappingFiles: string[];
  ingestFindings: Finding[];
  dashboards: { source: Dashboard; translation: DashboardTranslation }[];
  alerts: { alert: Alert; conversion: AlertConversion }[];
  manifest: Manifest | null;
  mode: "dry-run" | "live" | "none";
  // ---- v2 ----
  source?: Report["run"]["source"];
  config?: Record<string, unknown>;
  metrics?: Report["summary"]["metrics"];
}

const NOTE_TYPES = new Set(["note", "free_text"]);

export function buildReport(b: BuildInput): Report {
  const target = (kind: "dashboard" | "check-rule", id: string): ReportItem["target"] => {
    const r = b.manifest?.results.find((x) => x.kind === kind && x.id === id);
    return r ? { dash0Id: id, kind, action: r.action, readBack: r.readBack.state } : null;
  };
  const items: V1Item[] = [];
  // Ingest findings about a specific widget (e.g. widget.unsupported) belong on that panel's item.
  const byItem = new Map<string, Finding[]>();
  const findings: Finding[] = [];
  for (const f of b.ingestFindings) {
    if (f.itemKind === "panel" || f.itemKind === "group") (byItem.get(f.itemId) ?? byItem.set(f.itemId, []).get(f.itemId)!).push(f);
    else findings.push(f);
  }
  const readBackCheck = (t: ReportItem["target"]) => (!t || t.readBack === "skipped" ? null : t.readBack === "match");
  // Catalog (T17) rules for the target and report steps, cited in every certificate they applied to.
  const emitRules = (t: ReportItem["target"], alert: boolean): string[] => {
    const out = ["emit.certificate"];
    if (!t) return out;
    out.push("validate.preflight");
    if (t.action === "rejected-preflight") return out;
    out.push("emit.id", "emit.single-item");
    if (alert && !b.options.enableRules) out.push("emit.rules-disabled");
    if (t.readBack === "match") out.push("emit.readback");
    return out;
  };

  for (const { source: d, translation: t } of b.dashboards) {
    findings.push(...t.findings);
    const dashItem = `dd-dash-${d.source.id}`;
    const tgt = target("dashboard", dash0Id(d.source.id));
    // The IR panel and group title behind each itemId, built the same way T5 builds itemIds.
    const ir = new Map<string, { panel: Panel; group: string | null; groupId: string | null }>();
    const groupItems = new Map<string, V1Item>();
    for (const it of d.items) {
      if (isGroup(it)) {
        const gid = `${dashItem}/${it.id}`;
        for (const p of it.panels) ir.set(`${gid}/${p.id}`, { panel: p, group: it.title ?? null, groupId: gid });
        groupItems.set(gid, {
          id: gid,
          kind: "group",
          title: it.title ?? "(untitled group)",
          widget_type: "group",
          dashboard: d.title,
          group: null,
          group_id: null,
          layout: null, // a Dash0 Grid section spans the full width; it has no tile position of its own
          source_layout: it.layout,
          source: d.source.origin ?? d.source.id,
          source_queries: [],
          source_formula: null,
          promql: [],
          status: "exact",
          reason_codes: [],
          certificate: { sourceHash: sha256(canonicalJson(it.original ?? null)), outputHash: null, rules: ["layout.group"], status: "exact", assumptions: [], checks: { parses: true, importedReadBack: readBackCheck(tgt) } },
          findings: [],
          target: tgt,
        });
      } else ir.set(`${dashItem}/${it.id}`, { panel: it, group: null, groupId: null });
    }
    const emittedGroups = new Set<string>();
    // Panel keys are inserted in the same order as t.panels, so index i matches.
    const keys = Object.keys(t.dashboard.spec.panels);
    const grid = new Map<string, GridItem>();
    for (const l of t.dashboard.spec.layouts) for (const g of l.spec.items) grid.set(g.content.$ref.replace("#/spec/panels/", ""), g);

    t.panels.forEach((r0, i) => {
      const extra = byItem.get(r0.itemId) ?? [];
      byItem.delete(r0.itemId);
      const r = extra.length ? { ...r0, findings: [...extra, ...r0.findings] } : r0;
      const src = ir.get(r.itemId);
      const g = grid.get(keys[i]!);
      const status: ReportStatus = r.placeholder && src?.panel.kind === "unsupported" ? "unsupported" : r.status;
      if (src?.groupId && !emittedGroups.has(src.groupId)) {
        emittedGroups.add(src.groupId);
        items.push(groupItems.get(src.groupId)!);
      }
      const manual_actions: string[] = [];
      if (r.placeholder) manual_actions.push(`Rebuild "${r.title}" (Datadog ${r.sourceType}) by hand in Dash0; the placeholder panel holds the original query.`);
      items.push({
        id: r.itemId,
        kind: "panel",
        title: r.title,
        widget_type: r.sourceType,
        dashboard: d.title,
        group: src?.group ?? null,
        group_id: src?.groupId ?? null,
        layout: g ? { x: g.x, y: g.y, w: g.width, h: g.height } : null,
        source_layout: src?.panel.layout ?? null,
        source: d.source.origin ?? d.source.id,
        source_queries: src ? src.panel.requests.flatMap((q) => q.queries.map((x) => x.expr)).filter(Boolean) : [],
        source_formula: src && src.panel.requests.some((q) => q.formulas.length) ? src.panel.requests.flatMap((q) => q.formulas.map((f) => f.expr)) : null,
        // fail closed: a manual or unsupported panel is a placeholder, so it lists no PromQL even when some of its queries translated
        promql: status === "manual" || status === "unsupported" ? [] : r.promql,
        status,
        reason_codes: [...new Set(r.findings.map((f) => f.code))],
        certificate: {
          sourceHash: sha256(canonicalJson(src?.panel.original ?? null)),
          outputHash: sha256(canonicalJson(r.panel)),
          rules: [...r.rules, ...emitRules(tgt, false)],
          status,
          assumptions: r.assumptions,
          ...epsilonOf(r.findings),
          checks: { parses: r.promql.every((q) => validatePromQL(q).ok), importedReadBack: readBackCheck(tgt) },
        },
        findings: r.findings,
        ...(manual_actions.length ? { manual_actions } : {}),
        target: tgt,
      });
    });
  }

  for (const { alert: a, conversion: c } of [...b.alerts].sort((x, y) => (x.alert.source.id < y.alert.source.id ? -1 : 1))) {
    const tgt = c.rule?.id ? target("check-rule", c.rule.id) : null;
    const manual_actions: string[] = [];
    if (!c.rule) manual_actions.push(`Recreate the monitor "${a.name}" by hand in Dash0 (see findings).`);
    else {
      if (!b.options.enableRules) manual_actions.push("Review and enable the check rule in Dash0 (imported disabled, D-30).");
      // T6 lists the handles the channel map could not bind; mapped ones are already on the rule.
      const handles = [...new Set(c.channels)];
      if (handles.length) manual_actions.push(`Attach Dash0 notification channels for ${handles.join(", ")} (no entry in notification-channels.yaml).`);
    }
    items.push({
      id: `dd-monitor-${a.source.id}`,
      kind: "alert",
      title: a.name,
      widget_type: a.type,
      dashboard: null,
      group: null,
      group_id: null,
      layout: null,
      source_layout: null,
      source: a.source.origin ?? a.source.id,
      source_queries: [a.query],
      source_formula: null,
      promql: c.promql ? [c.promql] : [],
      status: c.status,
      reason_codes: [...new Set(c.findings.map((f) => f.code))],
      certificate: {
        sourceHash: sha256(canonicalJson(a.original)),
        outputHash: c.rule ? sha256(canonicalJson(c.rule)) : null,
        rules: [...c.rules, ...emitRules(tgt, true)],
        status: c.status,
        assumptions: c.assumptions,
        ...epsilonOf(c.findings),
        checks: { parses: c.promql ? validatePromQL(c.promql).ok : false, importedReadBack: readBackCheck(tgt) },
      },
      findings: c.findings,
      ...(c.rule?.thresholds ? { thresholds: { failed: c.rule.thresholds.failed!, ...(c.rule.thresholds.degraded !== undefined && { degraded: c.rule.thresholds.degraded }) } } : {}),
      ...(manual_actions.length ? { manual_actions } : {}),
      target: tgt,
    });
  }

  // Findings about widgets that produced no item (none expected) stay visible at run level.
  for (const fs of byItem.values()) findings.push(...fs);

  // Summary
  const byKind: Report["summary"]["byKind"] = {};
  for (const it of items) {
    const k = (byKind[it.kind] ??= {});
    k[it.status] = (k[it.status] ?? 0) + 1;
  }
  const scored = items.filter((i) => i.kind === "panel" && !NOTE_TYPES.has(i.widget_type));
  const count = (ss: ReportStatus[]) => scored.filter((i) => ss.includes(i.status)).length;
  const ratio = (n: number) => (scored.length ? Math.floor((n / scored.length) * 1000) / 1000 : 0); // floor: never round up
  const findingsByCode: Record<string, number> = {};
  for (const f of [...findings, ...items.flatMap((i) => i.findings)]) findingsByCode[f.code] = (findingsByCode[f.code] ?? 0) + 1;
  const m = b.manifest?.summary;

  const finished = finishV2(items);
  return {
    schema: "dd2dash0.report/v2",
    run: {
      tool: "dd2dash0",
      version: b.version,
      inputHash: b.inputHash,
      outputHash: sha256(canonicalJson(items)),
      options: b.options,
      mappingFiles: b.mappingFiles,
      source: b.source ?? { kind: b.options.input === "folder" ? "folder" : "api", site: null, path: null },
      toolCommit: process.env.DD2DASH0_COMMIT?.trim() || null,
      catalogHash: catalogHash(),
      ...(b.config ? { config: b.config } : {}),
    },
    summary: {
      dashboards: b.dashboards.length,
      alerts: b.alerts.length,
      byKind,
      coverageExact: ratio(count(["exact", "exact-under"])),
      coverageTranslated: ratio(count(["exact", "exact-under", "bounded"])),
      findingsByCode: Object.fromEntries(Object.entries(findingsByCode).sort(([a], [z]) => (a < z ? -1 : 1))),
      import: m ? { mode: b.mode, written: m["dry-run"], imported: m.imported, failed: m.failed, rejected: m["rejected-preflight"], readBackMatch: m.readBackMatch } : null,
      metrics: b.metrics ?? { total: 0, mapped: 0, approximate: 0, derived: 0, needsTransform: 0, noEquivalent: 0, unmapped: 0 },
      groups: finished.items.filter((i) => i.kind === "group").length,
      reviewOrder: finished.reviewOrder,
      gaps: gapsOf(finished.items),
      flow: flowOf(finished.items),
    },
    reasonCodes: reasonCodesOf(findings, finished.items),
    findings,
    items: finished.items,
  };
}

// ---------- v2 derived fields (CONTRACT-003 §5). Pure functions of the items. ----------

const STATUS_RANK: Record<string, number> = { manual: 0, unsupported: 1, bounded: 2, "exact-under": 3, exact: 4 };

/** Items that need a decision (same rule as review.ts allowedDecisions): bounded/manual/unsupported panels, all alerts. */
function needsDecision(i: V1Item): boolean {
  if (i.kind === "alert") return true;
  return i.kind === "panel" && (i.status === "bounded" || i.status === "manual" || i.status === "unsupported");
}

export function finishV2(raw: V1Item[]): { items: ReportItem[]; reviewOrder: string[] } {
  const reviewOrder = raw
    .filter(needsDecision)
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (a.kind === b.kind ? 0 : a.kind === "alert" ? -1 : 1) || b.findings.length - a.findings.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((i) => i.id);
  const pending = new Set(reviewOrder);
  const items: ReportItem[] = raw.map((i) => {
    const sentences = [...new Set(i.findings.flatMap((f) => f.assumptions ?? []))];
    return {
      ...i,
      group_id: i.group_id ?? null,
      source_layout: i.source_layout ?? null,
      condition: i.status === "exact-under" && sentences.length ? sentences.join("; ") : null,
      explain:
        i.kind === "group"
          ? { technical: "layout.group: exact", plain: "Kept as a titled section of the dashboard." }
          : explain({ status: i.status, rules: i.certificate.rules.filter((id) => !FLOW_STAGES_SKIPPED.has(resolveCode(id)?.stage ?? "")), assumptions: i.certificate.assumptions, ...(i.certificate.epsilon ? { epsilon: [i.certificate.epsilon] } : {}), reasons: i.reason_codes }),
      decision_required: pending.has(i.id),
    };
  });
  return { items, reviewOrder };
}

const MAPPING_CODES = new Set(["metric.unmapped", "metric.derived", "metric.needs_transform", "metric.approximate", "tag.unmapped", "label.default", "time.kind-unknown"]);
const SOURCE_CODES = new Set(["metric.no_equivalent", "source.unreadable"]);
const DASH0_LIMIT_CODES = new Set(["widget.unsupported", "log.measure", "query.datasource"]);

function fixKindOf(code: string): Report["summary"]["gaps"][number]["fixKind"] {
  if (MAPPING_CODES.has(code)) return "mapping";
  if (SOURCE_CODES.has(code)) return "source";
  if (DASH0_LIMIT_CODES.has(code)) return "dash0-limit";
  return "rule";
}

/** Codes that make an item manual or unsupported, ranked by how many items they block. */
export function gapsOf(items: ReportItem[]): Report["summary"]["gaps"] {
  const by = new Map<string, { items: number; example: string }>();
  for (const i of items) {
    if (i.kind === "group" || (i.status !== "manual" && i.status !== "unsupported")) continue;
    for (const code of i.reason_codes) {
      const r = resolveCode(code);
      if (code !== "widget.unsupported" && r?.status !== "manual") continue; // only blocking codes
      const e = by.get(code) ?? { items: 0, example: `${i.title || i.id} (${i.id})` };
      e.items++;
      by.set(code, e);
    }
  }
  return [...by.entries()]
    .map(([code, e]) => ({ code, items: e.items, fixKind: fixKindOf(code), example: e.example }))
    .sort((a, b) => b.items - a.items || (a.code < b.code ? -1 : 1));
}

const FLOW_STAGES_SKIPPED = new Set(["emit", "validate", "canonical", "ingest"]);

/** construct (catalog stage) -> rule -> the rule's own claim, counted over items. */
export function flowOf(items: ReportItem[]): Report["summary"]["flow"] {
  const by = new Map<string, { construct: string; ruleId: string; claim: string; count: number }>();
  for (const i of items) {
    if (i.kind === "group") continue;
    for (const id of new Set(i.certificate.rules)) {
      const r = resolveCode(id);
      if (!r || FLOW_STAGES_SKIPPED.has(r.stage)) continue;
      const k = `${r.stage}|${r.id}`;
      const e = by.get(k) ?? { construct: r.stage, ruleId: r.id, claim: r.status, count: 0 };
      e.count++;
      by.set(k, e);
    }
  }
  return [...by.values()].sort((a, b) => (a.construct < b.construct ? -1 : a.construct > b.construct ? 1 : b.count - a.count || (a.ruleId < b.ruleId ? -1 : 1)));
}

function labelOf(code: string): string {
  const parts = code.split(".");
  return parts.slice(-2).join(" ").replace(/[_-]+/g, " ");
}

/** Exactly the codes used in this report, each explained from the catalog. */
export function reasonCodesOf(runFindings: Finding[], items: ReportItem[]): Record<string, ReasonCode> {
  const codes = new Set<string>([...runFindings.map((f) => f.code), ...items.flatMap((i) => [...i.reason_codes, ...i.findings.map((f) => f.code)])]);
  const out: Record<string, ReasonCode> = {};
  for (const code of [...codes].sort()) {
    const r = resolveCode(code);
    out[code] = r
      ? {
          label: labelOf(code),
          explanation: `${r.match} → ${r.emit}${r.note ? ` (${r.note})` : ""}`,
          plain: explainPlain({ status: r.status, rules: [r.id], assumptions: r.assumptions, reasons: [code] }),
          catalogRule: r.id,
        }
      : { label: labelOf(code), explanation: "no catalog entry for this code", plain: "No explanation recorded for this reason yet.", catalogRule: null };
  }
  return out;
}

function epsilonOf(fs: Finding[]): { epsilon?: string } {
  const e = [...new Set(fs.map((f) => f.epsilon).filter((x): x is string => !!x))];
  return e.length ? { epsilon: e.join("; ") } : {};
}
