// `dd2dash0 review <plan> --terminal`: walk the review queue in the terminal and write plan/review.json after every
// decision, so quitting and coming back resumes where you stopped. I/O is injected so tests can drive it.
import type { ReportItem } from "../report/types.js";
import { allowedDecisions, type Decision } from "./review.js";
import { conditionOf, decide, openReview, saveReview, toReviewItem, type ReviewSession } from "./review-session.js";

export interface TerminalIO {
  /** Ask for one line of input (the prompt is printed first). Resolves null at end of input. */
  ask: (prompt: string) => Promise<string | null>;
  print: (line: string) => void;
}

const KEYS: Record<string, Decision> = { a: "approved", f: "flagged", k: "acknowledged" };
const LABEL: Record<Decision, string> = { approved: "[a]pprove", flagged: "[f]lag", acknowledged: "ac[k]nowledge" };

function show(io: TerminalIO, i: ReportItem, n: number, total: number) {
  io.print("");
  io.print(`[${n}/${total}] ${i.status.toUpperCase()} ${i.kind} · ${i.title || "(untitled)"}${i.dashboard ? ` · ${i.dashboard}` : ""}`);
  io.print(`  id: ${i.id}`);
  for (const q of i.source_queries) io.print(`  datadog: ${q}`);
  for (const q of i.promql) io.print(`  promql:  ${q}`);
  if (i.thresholds) io.print(`  thresholds: failed ${i.thresholds.failed}${i.thresholds.degraded !== undefined ? `, degraded ${i.thresholds.degraded}` : ""}`);
  const cond = conditionOf(i);
  if (cond.length) io.print(`  holds if: ${cond.join("; ")}`);
  if (i.certificate.epsilon) io.print(`  error bound: ${i.certificate.epsilon}`);
  const reasons = [...new Map(i.findings.map((f) => [f.code, f.message])).entries()].slice(0, 4);
  for (const [code, msg] of reasons) io.print(`  why: ${code}: ${msg}`);
  for (const a of i.manual_actions ?? []) io.print(`  to do: ${a}`);
}

export interface TerminalResult {
  file: string | null;
  decided: number;
  remaining: number;
  quit: boolean;
}

export async function terminalReview(planDir: string, reviewer: string, io: TerminalIO, opts: { all?: boolean } = {}): Promise<TerminalResult> {
  const s: ReviewSession = openReview(planDir, reviewer);
  const todo = opts.all ? s.queue : s.queue.filter((i) => !s.decisions.has(i.id));
  io.print(`Reviewing plan ${s.planHash.slice(0, 12)}: ${s.queue.length} item(s) need a decision, ${s.queue.length - todo.length} already decided${s.decisions.size ? " (resumed from review.json)" : ""}.`);
  io.print("Exact and exact-under items need no decision; they import as translated.");
  let file: string | null = null;
  let n = s.queue.length - todo.length;
  for (const item of todo) {
    n++;
    show(io, item, n, s.queue.length);
    const allowed = allowedDecisions(toReviewItem(item)!);
    const prompt = `  ${allowed.map((d) => LABEL[d]).join(" ")} [s]kip [q]uit > `;
    for (;;) {
      const line = await io.ask(prompt);
      if (line === null) return { file, decided: s.decisions.size, remaining: s.queue.length - s.decisions.size, quit: true };
      const key = line.trim().toLowerCase();
      if (key === "q") return { file, decided: s.decisions.size, remaining: s.queue.length - s.decisions.size, quit: true };
      if (key === "s") break;
      const decision = KEYS[key];
      if (!decision || !allowed.includes(decision)) {
        io.print(`  choose one of: ${allowed.map((d) => LABEL[d]).join(", ")}, [s]kip, [q]uit`);
        continue;
      }
      let note = "";
      if (decision === "flagged") note = ((await io.ask("  note (why it's flagged; shown in the placeholder) > ")) ?? "").trim();
      decide(s, item.id, decision, note);
      file = saveReview(s);
      break;
    }
  }
  const remaining = s.queue.filter((i) => !s.decisions.has(i.id)).length;
  io.print("");
  io.print(`Done: ${s.decisions.size} decided, ${remaining} without a decision.${file ? ` Saved ${file}.` : ""}`);
  if (s.decisions.size) io.print(`Next: dd2dash0 apply ${planDir} --approved ${file ?? `${planDir}/review.json`}`);
  return { file, decided: s.decisions.size, remaining, quit: false };
}
