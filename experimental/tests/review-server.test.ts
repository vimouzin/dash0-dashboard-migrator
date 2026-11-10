// dd2dash0 review: the shared queue, the terminal review, the review server, and server -> apply end to end.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runApply } from "../../src/pipeline/apply.js";
import { resolveConfig } from "../../src/pipeline/config.js";
import { runPlan } from "../../src/pipeline/plan.js";
import { readLock } from "../../src/pipeline/plan-lock.js";
import { reviewQueue } from "../../src/pipeline/review-session.js";
import { terminalReview } from "../../src/pipeline/review-terminal.js";
import type { Report } from "../../src/report/types.js";
import { startReviewServer } from "../serve/review.js";

const ROOT = join(import.meta.dirname, "..", "..");
async function makePlan() {
  const work = mkdtempSync(join(tmpdir(), "dd2dash0-rv-"));
  cpSync(join(ROOT, "fixtures", "datadog"), join(work, "src"), { recursive: true });
  const planDir = join(work, "plan");
  await runPlan({ config: resolveConfig({ source: { kind: "folder", path: "src" } }, {}, {}), outDir: planDir, defaultMappingsDir: join(ROOT, "mappings"), resolvedInput: join(work, "src"), version: "test" });
  return { work, planDir, report: JSON.parse(readFileSync(join(planDir, "report.json"), "utf8")) as Report };
}

describe("review server", () => {
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("serves the plan, checks and saves a console review, refuses bad ones, then apply uses it", async () => {
    const { work, planDir, report } = await makePlan();
    const consoleDir = join(work, "console");
    mkdirSync(join(consoleDir, "assets"), { recursive: true });
    writeFileSync(join(consoleDir, "index.html"), "<!doctype html><title>console</title>");
    writeFileSync(join(consoleDir, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(work, "secret.txt"), "nope");
    const { server, url } = await startReviewServer({ planDir, port: 0, consoleDir, reviewer: "srv" });
    servers.push(server);

    const bytes = await (await fetch(url + "report.json")).arrayBuffer();
    expect(Buffer.from(bytes).equals(readFileSync(join(planDir, "report.json")))).toBe(true);
    const plan = (await (await fetch(url + "api/plan")).json()) as { planHash: string; reportSha256: string; reviewOrder: string[] };
    expect(plan.planHash).toBe(readLock(planDir).planHash);
    expect(plan.reviewOrder).toEqual(reviewQueue(report).map((i) => i.id));
    expect(await (await fetch(url + "assets/app.js")).text()).toBe("console.log(1)");
    expect(await (await fetch(url + "items/whatever")).text()).toContain("<title>console</title>"); // SPA fallback
    expect((await fetch(url + "..%2Fsecret.txt")).status).toBe(404);
    expect((await fetch(url + "review.json")).status).toBe(404);

    // A console-style review: bound by report_sha256 only (what today's console exports).
    const decisions = reviewQueue(report).map((i) =>
      i.status === "bounded" ? { id: i.id, decision: "approved", note: "" } : i.kind === "alert" && i.status !== "manual" ? { id: i.id, decision: "approved", note: "" } : { id: i.id, decision: "acknowledged", note: "" },
    );
    const reportSha = createHash("sha256").update(readFileSync(join(planDir, "report.json"))).digest("hex");
    const post = (body: unknown) => fetch(url + "api/review", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
    expect((await post("{not json")).status).toBe(400);
    const bad = await post({ schema_version: "1", report_sha256: reportSha, decisions: [{ id: decisions[0]!.id, decision: "approved" }] });
    expect(bad.status).toBe(409); // approving a manual item isn't allowed
    const ok = await post({ schema_version: "1", report_sha256: reportSha, reviewer: "web", decisions });
    expect(ok.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(planDir, "review.json"), "utf8"));
    expect(saved).toMatchObject({ plan_sha256: plan.planHash, reviewer: "web" }); // the server binds it to the plan
    expect((await fetch(url + "review.json")).status).toBe(200);

    const applied = await runApply({ planDir, reviewFile: join(planDir, "review.json"), dryRun: true, cwd: work });
    expect(applied.kind).toBe("done");
    if (applied.kind === "done") expect(applied.imported.rules).toBe(1); // feature #34: one translatable check rule in the fixtures
    expect(existsSync(join(planDir, "apply", "report.json"))).toBe(true);
  });

  it("without a built console, / explains how to build it", async () => {
    const { planDir } = await makePlan();
    const { server, url } = await startReviewServer({ planDir, port: 0 });
    servers.push(server);
    expect(await (await fetch(url)).text()).toContain("npx bun run build");
  });
});
