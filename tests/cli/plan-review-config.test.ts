// CONTRACT-003 building blocks (not wired into the CLI yet): plan lock, review check, config file.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveConfig } from "../../src/pipeline/config.js";
import { listPlanFiles, readLock, verifyPlan, writeLock } from "../../src/pipeline/plan-lock.js";
import { allowedDecisions, checkReview, parseReview, ReviewError, type ReviewItem } from "../../src/pipeline/review.js";

function planDir(): string {
  const d = mkdtempSync(join(tmpdir(), "dd2dash0-plan-"));
  mkdirSync(join(d, "dash0", "dashboards"), { recursive: true });
  mkdirSync(join(d, "apply"), { recursive: true });
  writeFileSync(join(d, "report.json"), '{"items":[]}\n');
  writeFileSync(join(d, "dash0", "dashboards", "dd-a.json"), '{"kind":"Dashboard"}\n');
  writeFileSync(join(d, "review.json"), "{}");
  writeFileSync(join(d, "apply", "report.json"), "{}");
  return d;
}
const meta = { inputHash: "in", catalogHash: "cat", config: { select: ["redis*"] } };

describe("plan.lock", () => {
  it("covers report and payloads, not review.json or apply/", () => {
    expect(listPlanFiles(planDir())).toEqual(["dash0/dashboards/dd-a.json", "report.json"]);
  });

  it("is deterministic and verifies clean", () => {
    const d = planDir();
    const a = writeLock(d, meta);
    const b = writeLock(d, meta);
    expect(a.planHash).toBe(b.planHash);
    expect(readLock(d).planHash).toBe(a.planHash);
    expect(verifyPlan(d)).toMatchObject({ ok: true, planHash: a.planHash });
  });

  it("a hand-edited payload, a missing file or an extra file voids the plan", () => {
    const d = planDir();
    writeLock(d, meta);
    writeFileSync(join(d, "dash0", "dashboards", "dd-a.json"), '{"kind":"Dashboard","edited":true}\n');
    writeFileSync(join(d, "dash0", "dashboards", "dd-b.json"), "{}");
    const r = verifyPlan(d);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems).toEqual(["changed since plan: dash0/dashboards/dd-a.json", "not in plan.lock: dash0/dashboards/dd-b.json"]);
  });

  it("a folder without plan.lock is not a plan", () => {
    expect(() => readLock(mkdtempSync(join(tmpdir(), "x-")))).toThrow(/not a plan directory/);
  });
});

describe("review.json", () => {
  const items: ReviewItem[] = [
    { id: "g", kind: "group", status: "exact" },
    { id: "p-exact", kind: "panel", status: "exact-under" },
    { id: "p-bounded", kind: "panel", status: "bounded" },
    { id: "p-bounded-2", kind: "panel", status: "bounded" },
    { id: "p-manual", kind: "panel", status: "manual" },
    { id: "a-rule", kind: "alert", status: "exact-under" },
    { id: "a-manual", kind: "alert", status: "manual" },
  ];
  const ctx = { planHash: "P", reportSha256: "R", items };
  const review = (decisions: { id: string; decision: string }[], bind: Record<string, string> = { plan_sha256: "P" }) =>
    parseReview(JSON.stringify({ schema_version: "1", reviewer: "m", ...bind, decisions }));

  it("allowed decisions follow the console's rules", () => {
    expect(items.map((i) => allowedDecisions(i).join("|"))).toEqual(["", "", "approved|flagged", "approved|flagged", "acknowledged", "approved|flagged", "acknowledged"]);
  });

  it("a valid review: decisions kept, undecided bounded panels pending, unapproved alerts skipped", () => {
    const c = checkReview(review([{ id: "p-bounded", decision: "approved" }, { id: "p-manual", decision: "acknowledged" }, { id: "a-rule", decision: "flagged" }]), ctx);
    expect(c.ok).toBe(true);
    expect([...c.decisions.keys()]).toEqual(["p-bounded", "p-manual", "a-rule"]);
    expect(c.pending).toEqual(["p-bounded-2"]);
    expect(c.skippedAlerts).toEqual(["a-rule", "a-manual"]);
  });

  it("refuses a review of another plan, and a report-only binding that doesn't match", () => {
    expect(checkReview(review([], { plan_sha256: "OTHER" }), ctx).errors[0]!.code).toBe("plan.mismatch");
    expect(checkReview(review([], { report_sha256: "OTHER" }), ctx).errors[0]!.code).toBe("report.mismatch");
    const ok = checkReview(review([], { report_sha256: "R" }), ctx);
    expect(ok.ok).toBe(true);
    expect(ok.warnings[0]).toMatch(/payloads are not covered/);
    expect(checkReview(review([], {}), ctx).errors[0]!.code).toBe("review.unbound");
  });

  it("names unknown ids, duplicates and decisions not allowed for their item", () => {
    const c = checkReview(
      review([
        { id: "nope", decision: "approved" },
        { id: "p-exact", decision: "approved" },
        { id: "p-manual", decision: "approved" },
        { id: "p-bounded", decision: "approved" },
        { id: "p-bounded", decision: "flagged" },
      ]),
      ctx,
    );
    expect(c.ok).toBe(false);
    expect(c.errors.map((e) => [e.code, e.ids.length])).toEqual([
      ["review.unknown-id", 1],
      ["review.duplicate", 1],
      ["review.not-allowed", 2],
    ]);
  });

  it("rejects malformed files", () => {
    expect(() => parseReview("{")).toThrow(ReviewError);
    expect(() => parseReview('{"schema_version":"2","decisions":[]}')).toThrow(/schema_version/);
    expect(() => parseReview('{"schema_version":"1","decisions":[{"id":"x","decision":"yes"}]}')).toThrow(/approved, flagged or acknowledged/);
  });
});

describe("dd2dash0.yaml", () => {
  const write = (text: string) => {
    const d = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(d, "dd2dash0.yaml"), text);
    return d;
  };

  it("loads ./dd2dash0.yaml by default; flags win over the file, the file over defaults", () => {
    const d = write("source: { kind: folder, path: ./exports }\nselect: [redis*]\ndash0: { dataset: prod, orgId: f22d83d8-63a4-4ee7-99fd-eabe97bda244 }\nenableRules: true\n");
    const { config, file } = loadConfig(undefined, d);
    expect(file).toBe(join(d, "dd2dash0.yaml"));
    const r = resolveConfig(config, { enableRules: false, select: ["nginx*"] }, {});
    expect(r).toEqual({
      source: { kind: "folder", path: "./exports" },
      select: ["nginx*"],
      mappings: null,
      channels: null,
      dash0: { dataset: "prod", orgId: "f22d83d8-63a4-4ee7-99fd-eabe97bda244" },
      enableRules: false,
      allowPending: false,
      verifyData: false,
    });
  });

  it("without a file: API on datadoghq.eu, env defaults for dataset and org", () => {
    const r = resolveConfig(loadConfig(undefined, mkdtempSync(join(tmpdir(), "e-"))).config, {}, { DASH0_DATASET: "d", DASH0_ORG_ID: "o" });
    expect(r.source).toEqual({ kind: "api", site: "datadoghq.eu" });
    expect(r.dash0).toEqual({ dataset: "d", orgId: "o" });
  });

  it("refuses secrets, unknown keys and bad types with the key named", () => {
    expect(() => loadConfig(undefined, write("dash0: { authToken: abc }\n"))).toThrow(/looks like a secret/);
    expect(() => loadConfig(undefined, write("ddApiKey: abc\n"))).toThrow(/looks like a secret/);
    expect(() => loadConfig(undefined, write("colour: red\n"))).toThrow(/unknown key 'colour'/);
    expect(() => loadConfig(undefined, write("enableRules: yes please\n"))).toThrow(ConfigError);
    expect(() => loadConfig(undefined, write("source: { kind: folder }\n"))).toThrow(/source.path/);
    expect(() => loadConfig("/no/such/dd2dash0.yaml")).toThrow(/not found/);
  });
});
