// T17: the formal shape of a translation rule. Spec: plans/05-rule-catalog.md (dash0-team workspace).
//
// A rule r = ⟨id, stage, priority, guard, output, claim, A, ε, requires, evidence, owner, state⟩:
//   stage      the pipeline step that tries it (STAGES gives the order every item goes through)
//   priority   order inside the stage: lower is tried first, the first rule whose guard matches wins
//   guard      `match`: which source construct it applies to
//   output     `emit`: what it produces
//   claim      `status` from the plan 03 lattice (exact > exact-under > bounded > manual)
//   A          `assumptions`: for exact-under, each one checkable on live data (ASSUMPTIONS)
//   ε          `epsilon`: for bounded, the error bound as a formula
//   requires   target capabilities a probe must confirm before the rule may ship (PROBES)
//   evidence   how the claim is backed: unit test, paper proof, exhaustive check, property test, corpus, live
//   owner      the hub task that implements it
//   state      implemented (code exists in a merged branch or an open PR) or planned
import type { Status } from "../ir/index.js";
import type { AssumptionId } from "./assumptions.js";
import type { ProbeId } from "./probes.js";

export type StageId =
  | "ingest"
  | "classify"
  | "parse"
  | "select"
  | "scope"
  | "kind"
  | "time"
  | "space"
  | "function"
  | "arith"
  | "monitor"
  | "alert"
  | "message"
  | "widget"
  | "panel"
  | "layout"
  | "variable"
  | "logs"
  | "validate"
  | "canonical"
  | "emit";

export type TaskId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" | "T12" | "T13" | "T16" | "T17";

export type RuleState = "implemented" | "planned";

/**
 * Evidence for a claim, weakest to strongest in kind (they complement each other, see maths.md §9.4):
 *   unit             a test asserts the exact output for this rule
 *   corpus:<n>       run over n corpus items without a crash or a silent drop
 *   proof:<ref>      paper proof in docs/research/maths.md (e.g. proof:T8)
 *   exhaustive:<ref> every case in a bounded domain checked (e.g. exhaustive:E2)
 *   property:<ref>   reference-evaluator property test (e.g. property:T16)
 *   live:<ref>       confirmed against the real engines (parity run or probe)
 */
export type Evidence =
  | "unit"
  | `corpus:${string}`
  | `proof:${string}`
  | `exhaustive:${string}`
  | `property:${string}`
  | `live:${string}`;

export interface RuleDef {
  id: string;
  stage: StageId;
  priority: number;
  /** The source construct the rule applies to (Datadog side). */
  match: string;
  /** What it produces (Dash0 / PromQL / Perses side), or what happens. */
  emit: string;
  status: Status;
  assumptions: AssumptionId[];
  epsilon?: string;
  requires: ProbeId[];
  evidence: Evidence[];
  owner: TaskId;
  state: RuleState;
  /** The catch-all of a total stage: tried last, matches anything the other rules did not. */
  fallback?: boolean;
  /** A key of FINDING_CODES (src/ir/finding.ts) when the finding should be grouped under it; default: the rule id. */
  findingCode?: string;
  /** Where the rule is decided or derived. */
  source: string;
  note?: string;
}

export interface StageDef {
  id: StageId;
  title: string;
  /** Total: every input reaching the stage matches exactly one rule, so the stage has exactly one fallback. */
  total: boolean;
  /** What one match is about. Within a stage, rules are tried per unit in priority order and the first match wins. */
  unit: string;
  summary: string;
}
