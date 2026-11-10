// dd2dash0 review: the shared queue and the terminal review. (The console review server test moved to experimental/.)
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/pipeline/config.js";
import { runPlan } from "../../src/pipeline/plan.js";
import { readLock } from "../../src/pipeline/plan-lock.js";
import { reviewQueue } from "../../src/pipeline/review-session.js";
import { terminalReview } from "../../src/pipeline/review-terminal.js";
import type { Report } from "../../src/report/types.js";

const ROOT = join(import.meta.dirname, "..", "..");
async function makePlan() {
  const work = mkdtempSync(join(tmpdir(), "dd2dash0-rv-"));
  cpSync(join(ROOT, "fixtures", "datadog"), join(work, "src"), { recursive: true });
  const planDir = join(work, "plan");
  await runPlan({ config: resolveConfig({ source: { kind: "folder", path: "src" } }, {}, {}), outDir: planDir, defaultMappingsDir: join(ROOT, "mappings"), resolvedInput: join(work, "src"), version: "test" });
  return { work, planDir, report: JSON.parse(readFileSync(join(planDir, "report.json"), "utf8")) as Report };
}

describe("review queue", () => {
  it("only items that need a decision, manual -> unsupported -> bounded, alerts first", async () => {
    const { report } = await makePlan();
    const q = reviewQueue(report);
    expect(q.every((i) => i.status === "manual" || i.status === "unsupported" || i.status === "bounded" || i.kind === "alert")).toBe(true);
    expect(q.some((i) => i.status === "exact-under" && i.kind === "panel")).toBe(false);
    const rank = { manual: 0, unsupported: 1, bounded: 2, "exact-under": 3 } as Record<string, number>;
    for (let n = 1; n < q.length; n++) expect(rank[q[n - 1]!.status]! <= rank[q[n]!.status]!).toBe(true);
    expect(q[0]!.kind).toBe("alert");
    expect(reviewQueue(report).map((i) => i.id)).toEqual(q.map((i) => i.id)); // deterministic
  });
});

describe("terminal review", () => {
  it("records decisions as you go, re-asks on a wrong key, takes a note when flagging, resumes after quitting", async () => {
    const { planDir, report } = await makePlan();
    const q = reviewQueue(report);
    const firstBounded = q.findIndex((i) => i.status === "bounded");
    const lines: string[] = [];
    const keys = [...q.slice(0, firstBounded).map(() => "k"), "x", "f", "values look off", "q"];
    const io = { ask: async () => keys.shift() ?? null, print: (l: string) => lines.push(l) };
    const r1 = await terminalReview(planDir, "tester", io);
    expect(r1.quit).toBe(true);
    expect(lines.some((l) => l.includes("choose one of: [a]pprove, [f]lag"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(planDir, "review.json"), "utf8"));
    expect(saved.plan_sha256).toBe(readLock(planDir).planHash);
    expect(saved.decisions).toHaveLength(firstBounded + 1);
    expect(saved.decisions.at(-1)).toEqual({ id: q[firstBounded]!.id, decision: "flagged", note: "values look off" });

    const lines2: string[] = [];
    await terminalReview(planDir, "tester", { ask: async () => "q", print: (l) => lines2.push(l) });
    expect(lines2[0]).toContain(`${firstBounded + 1} already decided (resumed from review.json)`);
  });

  it("refuses a plan whose files changed", async () => {
    const { planDir } = await makePlan();
    writeFileSync(join(planDir, "report.md"), "edited");
    await expect(terminalReview(planDir, "t", { ask: async () => "q", print: () => {} })).rejects.toThrow(/plan changed/);
  });
});

