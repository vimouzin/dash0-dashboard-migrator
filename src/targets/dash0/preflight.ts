// Pure validation BEFORE anything is sent, so a bad item is reported locally instead of failing in Dash0.
// Each check comes from the OpenAPI schema or the API docs (see schema.ts).
import { LIMITS, type DashboardDefinition, type PrometheusAlertRule } from "./schema.js";

const DURATION = /^(\d+(ms|s|m|h|d|w|M|Q|y))+$/;
// A dashboard origin is a URL path segment (encoded), e.g. dd-redisdb__overview.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function preflightCheckRule(r: PrometheusAlertRule): string[] {
  const errs: string[] = [];
  if (!r.name?.trim()) errs.push("name is required");
  if (!r.expression?.trim()) errs.push("expression is required");
  if (r.id !== undefined && !UUID.test(r.id)) errs.push(`id '${r.id}' must be a UUID (Dash0 rejects other ids on Import Check Rule; T6 uses UUIDv5)`);
  if (/\$__threshold\b/.test(r.expression ?? "")) {
    const t = r.thresholds;
    if (!t || (t.degraded === undefined && t.failed === undefined)) errs.push("expression uses $__threshold, so thresholds.degraded or thresholds.failed is required");
  }
  for (const k of ["degraded", "failed"] as const) {
    const v = r.thresholds?.[k];
    if (v !== undefined && !Number.isFinite(v)) errs.push(`thresholds.${k} must be a finite number`);
  }
  for (const k of ["interval", "for", "keep_firing_for"] as const) {
    const v = r[k];
    if (v !== undefined && !DURATION.test(v)) errs.push(`${k} '${v}' is not a Dash0 duration`);
  }
  errs.push(...sizeCheck(r));
  return errs;
}

export function preflightDashboard(d: DashboardDefinition): string[] {
  const errs: string[] = [];
  if (d.kind !== "Dashboard") errs.push(`kind must be "Dashboard" (never the PersesDashboard CR form, knowledge base D-25)`);
  if (!d.metadata?.name?.trim()) errs.push("metadata.name is required");
  const id = d.metadata?.dash0Extensions?.id;
  if (id !== undefined && !ID.test(id)) errs.push(`metadata.dash0Extensions.id '${id}' must match ${ID}`);
  const panels = d.spec?.panels ?? {};
  if (Object.keys(panels).length === 0) errs.push("spec.panels is empty");
  const referenced = new Set<string>();
  for (const [li, layout] of (d.spec?.layouts ?? []).entries()) {
    for (const [ii, item] of layout.spec.items.entries()) {
      const where = `layouts[${li}].items[${ii}]`;
      const m = /^#\/spec\/panels\/(.+)$/.exec(item.content?.$ref ?? "");
      if (!m) errs.push(`${where}: content.$ref must be #/spec/panels/<id>`);
      else if (!(m[1]! in panels)) errs.push(`${where}: $ref points to missing panel '${m[1]}'`);
      else referenced.add(m[1]!);
      if (item.x < 0 || item.width <= 0 || item.x + item.width > 24) errs.push(`${where}: x + width must fit the 24-column grid`);
      if (item.y < 0 || item.height <= 0) errs.push(`${where}: y/height must be positive`);
    }
  }
  for (const id of Object.keys(panels)) if (!referenced.has(id)) errs.push(`panel '${id}' is not placed in any layout`);
  for (const [id, p] of Object.entries(panels)) {
    for (const [qi, q] of (p.spec.queries ?? []).entries()) {
      if (!q.spec?.plugin?.spec?.query?.trim()) errs.push(`panels.${id}.queries[${qi}]: empty PromQL`);
    }
  }
  errs.push(...sizeCheck(d));
  return errs;
}

function sizeCheck(x: unknown): string[] {
  const bytes = Buffer.byteLength(JSON.stringify(x), "utf8");
  return bytes > LIMITS.bodyBytes ? [`body is ${bytes} bytes, over Dash0's ${LIMITS.bodyBytes}-byte limit`] : [];
}

/** dd-<source id>, lower-cased with anything outside [a-z0-9-] replaced, so re-runs hit the same Dash0 asset. */
export function dash0Id(sourceId: string, prefix = "dd"): string {
  const slug = sourceId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!slug) throw new Error(`cannot derive a Dash0 id from '${sourceId}'`);
  return `${prefix}-${slug}`;
}
