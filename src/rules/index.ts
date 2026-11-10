// T17: the rule catalog, the single list of every deterministic rule the migrator may apply.
// Translators look rules up here; the report, the docs (docs/rules.md) and the tests read the same data.
import { worst, type Finding, type ItemKind, type Status } from "../ir/index.js";
import { ASSUMPTIONS, T12_ASSUMPTION_IDS, T4_ASSUMPTION_IDS, type AssumptionId } from "./assumptions.js";
import { ALERT_RULES } from "./catalog/alert.js";
import { DASHBOARD_RULES } from "./catalog/dashboard.js";
import { PIPELINE_RULES, T12_TABLE_IDS } from "./catalog/pipeline.js";
import { QUERY_RULES, T4_TABLE_IDS } from "./catalog/query.js";
import { STAGES } from "./stages.js";
import type { RuleDef, StageId } from "./types.js";

export * from "./types.js";
export { ASSUMPTIONS, T12_ASSUMPTION_IDS, T4_ASSUMPTION_IDS, type AssumptionId } from "./assumptions.js";
export { PROBES, type ProbeId, type Probe } from "./probes.js";
export { STAGES } from "./stages.js";
export { T4_TABLE_IDS } from "./catalog/query.js";
export { T12_TABLE_IDS } from "./catalog/pipeline.js";

const STAGE_INDEX = new Map(STAGES.map((s, i) => [s.id, i]));

/** Every rule, in pipeline order: by stage, then by priority. */
export const CATALOG: readonly RuleDef[] = Object.freeze(
  [...PIPELINE_RULES, ...QUERY_RULES, ...ALERT_RULES, ...DASHBOARD_RULES].sort(
    (a, b) => STAGE_INDEX.get(a.stage)! - STAGE_INDEX.get(b.stage)! || a.priority - b.priority || (a.id < b.id ? -1 : 1),
  ),
);

const BY_ID = new Map(CATALOG.map((r) => [r.id, r]));

export function hasRule(id: string): boolean {
  return BY_ID.has(id);
}

/** The rule with this id. Throws on an unknown id, so a typo can't become a silent "exact". */
export function rule(id: string): RuleDef {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`unknown rule id '${id}' (add it to src/rules/catalog)`);
  return r;
}

/**
 * The catalog rule behind a finding or reason code: the rule with that id, else the implemented rule whose findingCode
 * it is, else, for T4's generic `fn.<name>` codes, the function stage's fallback rule (fn.unknown). undefined means the
 * code has no catalog entry (a bug: tests/rules/codes.test.ts keeps every emitted code resolvable).
 */
export function resolveCode(code: string): RuleDef | undefined {
  const byId = BY_ID.get(code);
  if (byId) return byId;
  const byFinding = CATALOG.find((r) => r.findingCode === code && r.state === "implemented") ?? CATALOG.find((r) => r.findingCode === code);
  if (byFinding) return byFinding;
  if (/^fn\.[a-z0-9_]+$/.test(code)) return BY_ID.get("fn.unknown");
  return undefined;
}

/** Rules of one stage in the order they are tried. */
export function stageRules(stage: StageId): RuleDef[] {
  return CATALOG.filter((r) => r.stage === stage);
}

export interface Composition {
  status: Status;
  rules: string[];
  assumptions: AssumptionId[];
  /** One bound per bounded rule, as applied. The item's error is at most their combination. */
  epsilon: string[];
}

/**
 * Plan 03 §2: the status of a composite is the worst of its parts, its assumptions are the union,
 * and every bounded part contributes its ε. Rule ids keep their order of application, deduplicated.
 */
export function compose(ruleIds: Iterable<string>, extraAssumptions: Iterable<AssumptionId> = []): Composition {
  const rules: string[] = [];
  const assumptions = new Set<AssumptionId>();
  const epsilon: string[] = [];
  let status: Status = "exact";
  for (const id of ruleIds) {
    if (rules.includes(id)) continue;
    const r = rule(id);
    rules.push(id);
    status = worst(status, r.status);
    for (const a of r.assumptions) assumptions.add(a);
    if (r.epsilon !== undefined && !epsilon.includes(r.epsilon)) epsilon.push(r.epsilon);
  }
  for (const a of extraAssumptions) {
    if (!(a in ASSUMPTIONS)) throw new Error(`unknown assumption '${a}'`);
    assumptions.add(a);
    status = worst(status, "exact-under");
  }
  return { status, rules, assumptions: [...assumptions].sort(), epsilon };
}

/**
 * The CONTRACT-001 Finding for applying a rule, or null for an exact rule (exact rules need no finding).
 * The code is the rule's findingCode when it has one, else the rule id.
 */
export function findingFor(
  id: string,
  at: { itemKind: ItemKind; itemId: string; message?: string; original?: string },
): Finding | null {
  const r = rule(id);
  if (r.status === "exact") return null;
  return {
    status: r.status,
    code: r.findingCode ?? r.id,
    message: at.message ?? `${r.match} → ${r.emit}`,
    itemKind: at.itemKind,
    itemId: at.itemId,
    ruleId: r.id,
    ...(r.assumptions.length > 0 && { assumptions: r.assumptions.map((a) => ASSUMPTIONS[a]) }),
    ...(r.epsilon !== undefined && { epsilon: r.epsilon }),
    ...(at.original !== undefined && { original: at.original }),
  };
}

export type T4RuleId = (typeof T4_TABLE_IDS)[number];
export type T4AssumptionId = (typeof T4_ASSUMPTION_IDS)[number];

/** T4's rule shape (src/translate/query/rules.ts). */
export interface T4Rule {
  status: Status;
  assumptions: T4AssumptionId[];
  description: string;
}

/**
 * T4's rule table, built from the catalog. src/translate/query/rules.ts can re-export this as RULES
 * (same ids, statuses and assumptions; tests/rules/conformance.test.ts checks it against T4's own table).
 */
export const RULES_T4: Readonly<Record<T4RuleId, T4Rule>> = Object.freeze(
  Object.fromEntries(
    T4_TABLE_IDS.map((id) => {
      const r = rule(id);
      return [id, { status: r.status, assumptions: r.assumptions as T4AssumptionId[], description: `${r.match} -> ${r.emit}` }];
    }),
  ) as Record<T4RuleId, T4Rule>,
);

/** T4's ASSUMPTIONS slice, same ids and text. */
export const ASSUMPTIONS_T4: Readonly<Record<T4AssumptionId, string>> = Object.freeze(
  Object.fromEntries(T4_ASSUMPTION_IDS.map((a) => [a, ASSUMPTIONS[a]])) as Record<T4AssumptionId, string>,
);

export type T12RuleId = (typeof T12_TABLE_IDS)[number];
export type T12AssumptionId = (typeof T12_ASSUMPTION_IDS)[number];

/** T12's rule table (LOG_RULES in src/translate/logs), built from the catalog; checked by tests/rules/conformance.test.ts. */
export const RULES_T12: Readonly<Record<T12RuleId, { status: Status; assumptions: T12AssumptionId[] }>> = Object.freeze(
  Object.fromEntries(
    T12_TABLE_IDS.map((id) => {
      const r = rule(id);
      return [id, { status: r.status, assumptions: r.assumptions as T12AssumptionId[] }];
    }),
  ) as Record<T12RuleId, { status: Status; assumptions: T12AssumptionId[] }>,
);
export { explain, explainPlain, explainTechnical, PLAIN_ASSUMPTIONS, type ExplainInput, type ExplainStatus } from "./plain.js";
