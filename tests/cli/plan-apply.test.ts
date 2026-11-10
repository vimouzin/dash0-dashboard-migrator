// plan -> review -> apply end to end on the fixtures (CONTRACT-003 §3-7), all in dry-run: nothing reaches Dash0.
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runApply } from "../../src/pipeline/apply.js";
import { resolveConfig } from "../../src/pipeline/config.js";
import { runPlan } from "../../src/pipeline/plan.js";
import { readLock } from "../../src/pipeline/plan-lock.js";

const ROOT = join(import.meta.dirname, "..", "..");

/** A private copy of the fixtures (so the drift test can edit one) and a plan of it. */
async function makePlan() {
  const work = mkdtempSync(join(tmpdir(), "dd2dash0-pa-"));
  cpSync(join(ROOT, "fixtures", "datadog"), join(work, "src"), { recursive: true });
  const planDir = join(work, "plan");
  const config = resolveConfig({ source: { kind: "folder", path: "src" } }, {}, {});
  const p = await runPlan({ config, outDir: planDir, defaultMappingsDir: join(ROOT, "mappings"), resolvedInput: join(work, "src"), version: "test" });
  return { work, planDir, ...p };
}

type Item = { id: string; kind: string; status: string; target: { dash0Id: string } | null };

/** Approve bounded panels (flag the first), acknowledge manual/unsupported panels, approve one check rule. */
function writeReview(planDir: string, file: string, o: { skipOneBounded?: boolean; planSha?: string } = {}) {
  const items = (JSON.parse(readFileSync(join(planDir, "report.json"), "utf8")) as { items: Item[] }).items;
  const decisions: { id: string; decision: string; note: string }[] = [];
  let flagged: string | undefined;
  let skipped: string | undefined;
  for (const i of items) {
    if (i.kind === "panel" && i.status === "bounded") {
      if (!flagged) decisions.push({ id: (flagged = i.id), decision: "flagged", note: "check by hand" });
      else if (o.skipOneBounded && !skipped) skipped = i.id;
      else decisions.push({ id: i.id, decision: "approved", note: "" });
    } else if (i.kind === "panel" && (i.status === "manual" || i.status === "unsupported")) decisions.push({ id: i.id, decision: "acknowledged", note: "" });
    else if (i.kind === "alert" && i.id.includes("high_mem")) decisions.push({ id: i.id, decision: "approved", note: "" });
  }
  writeFileSync(file, JSON.stringify({ schema_version: "1", plan_sha256: o.planSha ?? readLock(planDir).planHash, reviewer: "t", decisions }));
  return { flagged: flagged!, skipped, items };
}

describe("plan", () => {
  it("writes report, payloads, events and a lock; the same input gives the same plan hash", async () => {
    const a = await makePlan();
    for (const f of ["plan.lock", "report.json", "report.md", "events.jsonl", "dash0/import-manifest.json"]) expect(existsSync(join(a.planDir, f)), f).toBe(true);
    const lock = readLock(a.planDir).lock;
    expect(Object.keys(lock.files)).toContain("dash0/dashboards/dd-redisdb-overview.json");
    expect(lock.config).toMatchObject({ source: { kind: "folder", path: "src" } });
    const b = await makePlan();
    expect(b.planHash).toBe(a.planHash);
  });
});

describe("apply (dry-run)", () => {
  it("imports what was approved: flagged panel -> placeholder with the note, only the approved check rule", async () => {
    const { work, planDir } = await makePlan();
    const { flagged } = writeReview(planDir, join(work, "review.json"));
    const o = await runApply({ planDir, reviewFile: join(work, "review.json"), dryRun: true, cwd: work });
    expect(o.kind).toBe("done");
    if (o.kind !== "done") return;
    expect(o.imported).toEqual({ dashboards: 4, rules: 1 });
    expect(o.placeholders).toEqual([flagged]);
    expect(o.skippedAlerts).toEqual([]); // feature #34: the postgres monitor no longer yields a check rule
    const dash = readFileSync(join(planDir, "apply", "dash0", "dashboards", "dd-nginx-nginx-overview-dashboard.json"), "utf8");
    expect(dash).toContain("flagged in review");
    expect(dash).toContain("check by hand");
    const applied = JSON.parse(readFileSync(o.reportFile, "utf8")) as { summary: { import: { mode: string; written: number } } };
    expect(applied.summary.import).toMatchObject({ mode: "dry-run", written: 5 });
  });

  it("refuses: review of another plan, pending bounded panel, edited payload, changed source", async () => {
    const { work, planDir } = await makePlan();
    writeReview(planDir, join(work, "other.json"), { planSha: "0".repeat(64) });
    const a = await runApply({ planDir, reviewFile: join(work, "other.json"), dryRun: true, cwd: work });
    expect(a.kind === "refused" && a.reasons[0]).toMatch(/made for plan 000000000000/);

    const { skipped } = writeReview(planDir, join(work, "pending.json"), { skipOneBounded: true });
    const b = await runApply({ planDir, reviewFile: join(work, "pending.json"), dryRun: true, cwd: work });
    expect(b.kind === "refused" && b.reasons.join(" ")).toContain(skipped!);
    const b2 = await runApply({ planDir, reviewFile: join(work, "pending.json"), dryRun: true, cwd: work, allowPending: true });
    expect(b2.kind).toBe("done");

    writeReview(planDir, join(work, "review.json"));
    const monitor = join(work, "src", "monitors", "redisdb__high_mem.json");
    writeFileSync(monitor, readFileSync(monitor, "utf8").replace('"critical": 90', '"critical": 95'));
    const c = await runApply({ planDir, reviewFile: join(work, "review.json"), dryRun: true, cwd: work });
    expect(c.kind === "refused" && c.reasons[0]).toMatch(/Datadog source changed/);

    const d = join(planDir, "dash0", "dashboards", "dd-redisdb-overview.json");
    writeFileSync(d, readFileSync(d, "utf8") + " ");
    const e = await runApply({ planDir, reviewFile: join(work, "review.json"), dryRun: true, cwd: work, skipSourceCheck: true });
    expect(e.kind === "refused" && e.reasons.join(" ")).toContain("changed since plan: dash0/dashboards/dd-redisdb-overview.json");
  });

  it("a review bound only to report_sha256 still works, with a warning", async () => {
    const { work, planDir } = await makePlan();
    writeReview(planDir, join(work, "r.json"));
    const r = JSON.parse(readFileSync(join(work, "r.json"), "utf8"));
    delete r.plan_sha256;
    r.report_sha256 = (await import("node:crypto")).createHash("sha256").update(readFileSync(join(planDir, "report.json"))).digest("hex");
    writeFileSync(join(work, "r.json"), JSON.stringify(r));
    const o = await runApply({ planDir, reviewFile: join(work, "r.json"), dryRun: true, cwd: work });
    expect(o.kind).toBe("done");
    expect(o.warnings.join(" ")).toMatch(/payloads are not covered/);
  });
});

describe("duplicate widget ids (review of #33, Henry's stress item c)", () => {
  it("get unique item ids, and flagging the second widget replaces the second panel, not the first", async () => {
    const work = mkdtempSync(join(tmpdir(), "dd2dash0-dup-"));
    const src = join(work, "src", "dashboards");
    cpSync(join(ROOT, "fixtures", "datadog", "README.md"), join(work, "README.md"));
    const w = (title: string, q: string) => ({ id: 1, layout: { x: 0, y: 0, width: 4, height: 2 }, definition: { type: "timeseries", title, requests: [{ queries: [{ data_source: "metrics", name: "a", query: q }], formulas: [{ formula: "a" }], response_format: "timeseries" }] } });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "dup.json"), JSON.stringify({ id: "dup-test", title: "Dup", layout_type: "ordered", widgets: [w("First (cpu)", "avg:redis.cpu.sys{*}"), w("Second (rate)", "avg:redis.net.commands{*}")] }));
    const planDir = join(work, "plan");
    const config = resolveConfig({ source: { kind: "folder", path: "src" } }, {}, {});
    await runPlan({ config, outDir: planDir, defaultMappingsDir: join(ROOT, "mappings"), resolvedInput: join(work, "src"), version: "test" });
    const items = (JSON.parse(readFileSync(join(planDir, "report.json"), "utf8")) as { items: (Item & { title: string })[] }).items.filter((i) => i.kind === "panel");
    expect(items.map((i) => i.id)).toEqual(["dd-dash-dup-test/w-1", "dd-dash-dup-test/w-1_2"]);
    const second = items.find((i) => i.title === "Second (rate)")!;
    const first = items.find((i) => i.title === "First (cpu)")!;
    const review = join(work, "review.json");
    writeFileSync(review, JSON.stringify({ schema_version: "1", plan_sha256: readLock(planDir).planHash, reviewer: "t", decisions: [{ id: second.id, decision: "flagged", note: "rejected" }, { id: first.id, decision: "approved", note: "" }] }));
    const o = await runApply({ planDir, reviewFile: review, dryRun: true, skipSourceCheck: true, allowPending: true });
    expect(o.kind).toBe("done");
    const dir = join(planDir, "apply", "dash0", "dashboards");
    const { readdirSync } = await import("node:fs");
    const dash = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")) as { spec: { panels: Record<string, { spec: { display?: { name?: string }; plugin: { kind: string } } }> } };
    expect(dash.spec.panels["w-1"]!.spec.plugin.kind).not.toBe("Markdown"); // First (cpu) imported as a chart
    expect(dash.spec.panels["w-1_2"]!.spec.plugin.kind).toBe("Markdown"); // Second (rate) is the flagged placeholder
  });
});
