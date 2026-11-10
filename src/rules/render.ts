// Renders the catalog as Markdown (docs/rules.md). Deterministic: same catalog, same bytes.
import { ASSUMPTIONS, CATALOG, PROBES, STAGES, type RuleDef } from "./index.js";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function proven(r: RuleDef): boolean {
  return r.evidence.some((e) => /^(proof|exhaustive|property|live):/.test(e));
}

function claim(r: RuleDef): string {
  if (r.status === "exact-under") return `exact-under(${r.assumptions.join(", ")})`;
  if (r.status === "bounded") return "bounded(ε)";
  return r.status;
}

export function renderMarkdown(): string {
  const out: string[] = [];
  const count = (f: (r: RuleDef) => boolean) => CATALOG.filter(f).length;
  out.push(
    "# Rule catalog",
    "",
    "Generated from `src/rules/` by `npx tsx src/rules/write-doc.ts`. Do not edit by hand; `tests/rules` fails when this file is stale.",
    "The formal definition (what a rule is, the axioms, how rules are admitted) is plan 05 in the dash0-team workspace.",
    "",
    "## Summary",
    "",
    "| | exact | exact-under | bounded | manual | total |",
    "|---|---|---|---|---|---|",
  );
  for (const state of ["implemented", "planned"] as const) {
    const n = (s: string) => count((r) => r.state === state && r.status === s);
    out.push(`| ${state} | ${n("exact")} | ${n("exact-under")} | ${n("bounded")} | ${n("manual")} | ${count((r) => r.state === state)} |`);
  }
  out.push("", "## Pipeline order", "", "| # | Stage | Unit of matching | Total | Rules | Summary |", "|---|---|---|---|---|---|");
  STAGES.forEach((s, i) => out.push(`| ${i + 1} | \`${s.id}\` ${s.title} | ${s.unit} | ${s.total ? "yes" : "no"} | ${count((r) => r.stage === s.id)} | ${esc(s.summary)} |`));

  for (const s of STAGES) {
    const rules = CATALOG.filter((r) => r.stage === s.id);
    if (rules.length === 0) continue;
    out.push("", `## ${s.title} (\`${s.id}\`)`, "", "| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |", "|---|---|---|---|---|---|---|---|---|");
    for (const r of rules) {
      const needs = r.requires.join(", ");
      const evidence = r.evidence.join(", ") || "—";
      out.push(
        `| ${r.fallback ? `${r.priority} (fallback)` : r.priority} | \`${r.id}\` | ${esc(r.match)} | ${esc(r.emit)} | ${claim(r)} | ${evidence} | ${needs || "—"} | ${r.owner} | ${r.state} |`,
      );
    }
    const notes = rules.filter((r) => r.note !== undefined || r.epsilon !== undefined);
    if (notes.length > 0) {
      out.push("");
      for (const r of notes) {
        const parts = [r.epsilon !== undefined ? `ε: ${r.epsilon}.` : "", r.note ?? ""].filter(Boolean);
        out.push(`- \`${r.id}\`: ${parts.join(" ")}`);
      }
    }
  }

  out.push("", "## Assumptions", "", "| Id | Statement | Used by |", "|---|---|---|");
  for (const [id, text] of Object.entries(ASSUMPTIONS)) {
    const users = CATALOG.filter((r) => (r.assumptions as string[]).includes(id)).length;
    out.push(`| \`${id}\` | ${esc(text)} | ${users} |`);
  }
  out.push("", "## Open probes", "", "| Probe | Question | How | Rules waiting |", "|---|---|---|---|");
  for (const [id, p] of Object.entries(PROBES)) {
    const waiting = CATALOG.filter((r) => (r.requires as string[]).includes(id)).map((r) => `\`${r.id}\``);
    out.push(`| \`${id}\` (${p.answer}) | ${esc(p.question)} | ${esc(p.how)} | ${waiting.join(", ") || "—"} |`);
  }

  const unproven = CATALOG.filter((r) => r.status !== "manual" && r.status !== "exact" && !proven(r));
  out.push(
    "",
    "## Claims not yet backed by a proof, exhaustive check, property test or live run",
    "",
    "Exact-under and bounded claims whose only evidence is a unit test or nothing. These are the next rules to take through the reference evaluator (T16).",
    "",
  );
  for (const r of unproven) out.push(`- \`${r.id}\` (${claim(r)}, ${r.state}, ${r.owner})`);
  const ahead = CATALOG.filter((r) => r.state === "implemented" && r.requires.some((p) => (PROBES[p] as { answer: string }).answer !== "yes"));
  if (ahead.length > 0) {
    out.push("", "## Implemented ahead of an open probe", "");
    for (const r of ahead) out.push(`- \`${r.id}\` needs ${r.requires.join(", ")}`);
  }
  out.push("");
  return out.join("\n");
}
