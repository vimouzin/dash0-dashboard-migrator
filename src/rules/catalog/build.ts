// Small constructors so the catalog files read like tables.
import type { Status } from "../../ir/index.js";
import type { AssumptionId } from "../assumptions.js";
import type { ProbeId } from "../probes.js";
import type { Evidence, RuleDef, RuleState, StageId, TaskId } from "../types.js";

export interface RuleOpts {
  assumptions?: AssumptionId[];
  epsilon?: string;
  requires?: ProbeId[];
  evidence?: Evidence[];
  fallback?: boolean;
  findingCode?: string;
  source?: string;
  note?: string;
}

/** Bind the stage, owner, state and default source once per table section. */
export function section(stage: StageId, owner: TaskId, state: RuleState, source: string) {
  return (id: string, priority: number, status: Status, match: string, emit: string, opts: RuleOpts = {}): RuleDef => ({
    id,
    stage,
    priority,
    match,
    emit,
    status,
    assumptions: opts.assumptions ?? [],
    ...(opts.epsilon !== undefined && { epsilon: opts.epsilon }),
    requires: opts.requires ?? [],
    evidence: opts.evidence ?? (state === "implemented" ? ["unit"] : []),
    owner,
    state,
    ...(opts.fallback && { fallback: true }),
    ...(opts.findingCode !== undefined && { findingCode: opts.findingCode }),
    source: opts.source ?? source,
    ...(opts.note !== undefined && { note: opts.note }),
  });
}

/** maths.md T3b: the error of an extrapolated rate/increase over one window. */
export const EPS_RATE = "|r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b)";
