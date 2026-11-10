// Step 3 of the guided flow: a batched terminal review that writes the same plan/review.json the gated `apply` reads.
//   exact / exact-under            no prompt (imported as translated)
//   bounded panels                 ONE prompt: approve all? [Y/n/list]   (n = all become flagged placeholders)
//   manual / unsupported           no prompt: acknowledged -> Markdown placeholder with the original query (never dropped)
//   translatable monitors          one prompt each: Datadog query -> PromQL + thresholds, approve? [Y/n/skip-all]
// --yes approves every bounded panel and every translatable monitor.
import type { ReportItem } from "../report/types.js";
import { decide, openReview, saveReview } from "../pipeline/review-session.js";
import type { KeyIO } from "./keys.js";
import type { Choose } from "./tty.js";

export interface BatchResult {
  file: string;
  boundedApproved: number;
  boundedFlagged: number;
  acknowledged: number;
  rulesApproved: string[];
  rulesRejected: string[];
  manualMonitors: ReportItem[];
}

const yesNo = (a: string | null, def: boolean) => {
  const s = (a ?? "").trim().toLowerCase();
  return s === "" ? def : s === "y" || s === "yes";
};

function showRule(io: Pick<KeyIO, "print">, i: ReportItem, n: number, total: number) {
  io.print("");
  io.print(`  ⎿ monitor ${n}/${total}  ${i.title || "(untitled monitor)"}  (${i.status})`);
  for (const q of i.source_queries) io.print(`      Datadog  ${q}`);
  for (const q of i.promql) io.print(`      PromQL   ${q}`);
  if (i.thresholds) io.print(`      failed > ${i.thresholds.failed}${i.thresholds.degraded !== undefined ? `   degraded > ${i.thresholds.degraded}` : ""}`);
  if (i.certificate.epsilon) io.print(`      bound    ${i.certificate.epsilon}`);
}

const listBounded = (io: Pick<KeyIO, "print">, bounded: ReportItem[]) => {
  for (const i of bounded) io.print(`      · ${i.dashboard ?? ""} / ${i.title || "(untitled)"}: ${i.promql[0] ?? ""}${i.certificate.epsilon ? `   (bound: ${i.certificate.epsilon})` : ""}`);
};

export async function batchedReview(planDir: string, io: Pick<KeyIO, "ask" | "print"> & { choose?: Choose }, o: { yes: boolean; reviewer?: string }): Promise<BatchResult> {
  const s = openReview(planDir, o.reviewer ?? "dd2dash0");
  s.decisions.clear(); // a fresh run always reviews fresh
  const bounded = s.queue.filter((i) => i.kind === "panel" && i.status === "bounded");
  const manualPanels = s.queue.filter((i) => i.kind === "panel" && (i.status === "manual" || i.status === "unsupported"));
  const rules = s.queue.filter((i) => i.kind === "alert" && i.status !== "manual" && i.status !== "unsupported");
  const manualMonitors = s.queue.filter((i) => i.kind === "alert" && (i.status === "manual" || i.status === "unsupported"));
  const r: BatchResult = { file: "", boundedApproved: 0, boundedFlagged: 0, acknowledged: 0, rulesApproved: [], rulesRejected: [], manualMonitors };

  // Bounded panels: one batch decision.
  if (bounded.length) {
    let approve = true;
    if (!o.yes && io.choose) {
      for (;;) {
        const c = await io.choose(`Import ${bounded.length} approximate panels? They are translated within a proven error bound.`, ["Yes, import them", "No, use placeholders", "Show them first"], 0);
        if (c === 2) {
          listBounded(io, bounded);
          continue;
        }
        approve = c !== 1;
        break;
      }
    } else if (!o.yes) {
      for (;;) {
        const a = await io.ask(`  Approve all ${bounded.length} approximate (bounded) panels? They are translated within a proven error bound. [Y/n/list] `);
        if ((a ?? "").trim().toLowerCase() === "list") {
          listBounded(io, bounded);
          continue;
        }
        approve = yesNo(a, true);
        break;
      }
    }
    for (const i of bounded) decide(s, i.id, approve ? "approved" : "flagged", approve ? "" : "not approved in the batch review");
    if (approve) r.boundedApproved = bounded.length;
    else r.boundedFlagged = bounded.length;
  }

  // Manual / unsupported panels: acknowledged automatically; they land as placeholders holding the original query.
  for (const i of manualPanels) decide(s, i.id, "acknowledged");
  r.acknowledged = manualPanels.length;
  if (manualPanels.length) io.print(`  ⎿ ${manualPanels.length} panel(s) can't be translated exactly; they become placeholder panels with the original Datadog query.`);

  // Monitors that can't become a rule: acknowledged, listed, never imported as rules (still counted in the report).
  for (const i of manualMonitors) decide(s, i.id, "acknowledged");
  if (manualMonitors.length) {
    io.print(`  ⎿ ${manualMonitors.length} monitor(s) can't be translated into a check rule (listed in the report):`);
    for (const i of manualMonitors) io.print(`      · ${i.title || i.id}: ${i.reason_codes.slice(0, 3).join(", ") || "manual"}`);
  }

  // Translatable monitors: one prompt each.
  let skipAll = false;
  for (const [n, i] of rules.entries()) {
    let approve = true;
    if (!o.yes && !skipAll) {
      showRule(io, i, n + 1, rules.length);
      if (io.choose) {
        const c = await io.choose("Import this check rule?", ["Yes, import it (it starts off)", "No, skip it", "Skip all remaining monitors"], 0);
        approve = c === 0 || c === null;
        if (c === 2) skipAll = true;
      } else {
        const a = ((await io.ask("    Approve this check rule? [Y/n/skip-all] ")) ?? "").trim().toLowerCase();
        if (a === "skip-all" || a === "s") {
          skipAll = true;
          approve = false;
        } else approve = yesNo(a, true);
      }
    } else if (skipAll) approve = false;
    decide(s, i.id, approve ? "approved" : "flagged", approve ? "" : "not approved in review");
    (approve ? r.rulesApproved : r.rulesRejected).push(i.id);
  }

  r.file = saveReview(s);
  return r;
}
