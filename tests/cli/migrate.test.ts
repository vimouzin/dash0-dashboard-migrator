import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { stringify } from "yaml";
import { main, parseFlags } from "../../src/cli.js";
import { migrate, type MigrateOptions } from "../../src/pipeline/migrate.js";
import { writeReport } from "../../src/report/index.js";
import { validatePromQL } from "../../src/validate/promql.js";
import { checkRuleUuid, CHANNEL_ANNOTATION } from "../../src/translate/alerts/index.js";

const HIGH_MEM_ID = checkRuleUuid("redisdb__high_mem"); // T6: UUIDv5 of the Datadog monitor id

const ROOT = join(import.meta.dirname, "..", "..");
const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  ingest: { input: join(ROOT, "fixtures", "datadog") },
  mappingsDir: join(ROOT, "mappings"),
  outDir: mkdtempSync(join(tmpdir(), "t8-")),
  mode: "dry-run",
  version: "test",
  ...over,
});

describe("CLI flags", () => {
  it("help still works", () => expect(main(["--help"])).toBe(0));
  it.each([
    [["--from", "datadog"], /exactly one of --input/],
    [["--input", "x"], /--from datadog is required/],
    [["--from", "datadog", "--input", "x", "--api"], /exactly one/],
    [["--from", "datadog", "--input", "x", "--dry-run", "--no-import"], /mutually exclusive/],
    [["--from", "datadog", "--input", "x", "--only", "everything"], /--only must be/],
    [["--from", "datadog", "--input"], /needs a value/],
  ])("rejects %j", (args, re) => {
    expect(parseFlags(args)).toMatch(re);
  });
  it("accepts the documented form", () => {
    expect(parseFlags(["--from", "datadog", "--input", "fx", "--dry-run", "--out", "o", "--only", "monitors", "--enable-rules"])).toMatchObject({ input: "fx", dryRun: true, out: "o", only: "monitors", enableRules: true });
  });
  it("live mode without Dash0 env fails fast with a hint", async () => {
    const saved = { u: process.env.DASH0_API_URL, t: process.env.DASH0_AUTH_TOKEN };
    delete process.env.DASH0_API_URL;
    delete process.env.DASH0_AUTH_TOKEN;
    try {
      expect(await main(["migrate", "--from", "datadog", "--input", join(ROOT, "fixtures", "datadog")])).toBe(2);
    } finally {
      if (saved.u !== undefined) process.env.DASH0_API_URL = saved.u;
      if (saved.t !== undefined) process.env.DASH0_AUTH_TOKEN = saved.t;
    }
  });
});

describe("migrate over the fixtures (dry run)", async () => {
  const o = opts();
  const r = await migrate(o);
  const rep = r.report;

  it("accounts for every widget and every monitor", () => {
    const widgets = r.dashboards.reduce((n, d) => n + d.panels.length, 0);
    expect(rep.items.filter((i) => i.kind === "panel")).toHaveLength(widgets);
    expect(rep.items.filter((i) => i.kind === "alert")).toHaveLength(6);
    expect(rep.summary).toMatchObject({ dashboards: 4, alerts: 6 });
  });

  it("the Redis high-memory monitor becomes the evaluator-proven check rule", () => {
    const a = rep.items.find((i) => i.id === "dd-monitor-redisdb__high_mem")!;
    expect(a.promql).toEqual([
      'avg_over_time((100 * avg (avg_over_time({otel_metric_name="redis.memory.used"}[1m])) / avg (avg_over_time({otel_metric_name="redis.maxmemory"}[1m])))[5m:1m]) > $__threshold',
    ]);
    expect(a.thresholds).toEqual({ failed: 90, degraded: 70 });
    // T6 (catalog alert.opt.*): require_full_window / new_host_delay become stated assumptions, not dropped
    expect(a.status).toBe("exact-under");
    expect(a.certificate.rules).toEqual(expect.arrayContaining(["alert.opt.require_full_window.true", "alert.opt.new_group_delay"]));
    expect(a.manual_actions).toEqual(expect.arrayContaining([expect.stringMatching(/enable the check rule/)]));
  });

  it("anomalies() monitors are manual, with no rule emitted", () => {
    const anomalies = rep.items.filter((i) => i.kind === "alert" && i.reason_codes.includes("fn.anomalies"));
    expect(anomalies).toHaveLength(4);
    expect(anomalies.every((a) => a.status === "manual" && a.promql.length === 0 && a.target === null)).toBe(true);
  });

  it("every emitted PromQL parses; every non-exact item has a reason; every placeholder has a manual action", () => {
    for (const i of rep.items) {
      for (const q of i.promql) expect(validatePromQL(q).ok, q).toBe(true);
      if (i.status !== "exact") expect(i.reason_codes.length, i.id).toBeGreaterThan(0);
      if (i.status === "unsupported") expect(i.manual_actions?.length, i.id).toBe(1);
    }
  });

  it("panels carry 24-column layouts and a certificate", () => {
    const p = rep.items.find((i) => i.title === "Percent Used Memory by Host")!;
    expect(p).toMatchObject({ dashboard: "Redis - Overview", group: "Memory Metrics", status: "exact-under" });
    expect(p.layout!.x + p.layout!.w).toBeLessThanOrEqual(24);
    expect(p.certificate.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.certificate.checks).toEqual({ parses: true, importedReadBack: null });
  });

  it("coverage is floored, never rounded up", () => {
    const panels = rep.items.filter((i) => i.kind === "panel" && i.widget_type !== "note");
    const exact = panels.filter((i) => i.status === "exact" || i.status === "exact-under").length;
    expect(rep.summary.coverageExact).toBe(Math.floor((exact / panels.length) * 1000) / 1000);
  });

  it("writes the Dash0 payloads, and the report is deterministic byte for byte", async () => {
    expect(existsSync(join(o.outDir, "dash0", "dashboards", "dd-redisdb-overview.json"))).toBe(true);
    expect(existsSync(join(o.outDir, "dash0", "check-rules", `${HIGH_MEM_ID}.json`))).toBe(true);
    const again = await migrate(opts());
    const a = writeReport(rep, mkdtempSync(join(tmpdir(), "t8a-")));
    const b = writeReport(again.report, mkdtempSync(join(tmpdir(), "t8b-")));
    expect(readFileSync(a.json, "utf8")).toBe(readFileSync(b.json, "utf8"));
    expect(readFileSync(a.md, "utf8")).toMatch(/^# dd2dash0 migration report/);
  });
});

describe("modes", () => {
  it("--no-import writes no payloads", async () => {
    const o = opts({ mode: "none" });
    const r = await migrate(o);
    expect(r.manifest).toBeNull();
    expect(existsSync(join(o.outDir, "dash0"))).toBe(false);
    expect(r.report.summary.import).toBeNull();
  });

  it("live: imports through T7 against a fake Dash0 and records read-back per item", async () => {
    const store = new Map<string, unknown>();
    const f = (async (u: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(u));
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const json = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s });
      const m = /^\/api\/(dashboards|alerting\/check-rules)\/(.+)$/.exec(url.pathname);
      // As probed live: dashboards upsert with PUT by origin; check rules via Import Check Rule by UUID id.
      if (init.method === "PUT" && m?.[1] === "dashboards") return store.set(`d/${m[2]}`, body), json(body);
      if (url.pathname === "/api/import/check-rule") return store.set(`r/${body.id}`, body), json(body);
      const v = m && store.get(`${m[1] === "dashboards" ? "d" : "r"}/${m[2]}`);
      return v ? json(v) : json({ error: { code: 404, message: "nf" } }, 404);
    }) as typeof fetch;
    const r = await migrate(opts({ mode: "live", dash0: { apiUrl: "https://api.example.test", token: "t", fetch: f, sleep: async () => {} } }));
    expect(r.report.summary.import).toMatchObject({ mode: "live", imported: 5, readBackMatch: 5, failed: 0, rejected: 0 });
    const hm = r.report.items.find((i) => i.id === "dd-monitor-redisdb__high_mem")!;
    expect(hm.target).toEqual({ dash0Id: HIGH_MEM_ID, kind: "check-rule", action: "imported", readBack: "match" });
    expect(hm.certificate.checks.importedReadBack).toBe(true);
  });
});

/** Every file under `dir`, keyed by its relative path. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("YAML input (Plan 07 item 5)", async () => {
  // The fixtures again, every file re-serialised as YAML: same documents, different syntax.
  const yamlDir = mkdtempSync(join(tmpdir(), "t8-yaml-in-"));
  for (const [rel, text] of Object.entries(tree(join(ROOT, "fixtures", "datadog")))) {
    if (!rel.endsWith(".json")) continue;
    const dest = join(yamlDir, rel.replace(/\.json$/, ".yaml"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, stringify(JSON.parse(text)));
  }
  const j = opts();
  const y = opts({ ingest: { input: yamlDir } });
  const [rj, ry] = await Promise.all([migrate(j), migrate(y)]);
  const items = (r: typeof rj) => JSON.stringify(r.report.items.map(({ source: _source, ...rest }) => rest));

  it("a YAML export and its JSON twin give the same input hash", () => {
    expect(ry.report.run.inputHash).toBe(rj.report.run.inputHash);
  });
  it("the same Dash0 payloads, byte for byte", () => {
    const a = tree(join(j.outDir, "dash0"));
    expect(Object.keys(a).length).toBeGreaterThan(0);
    expect(tree(join(y.outDir, "dash0"))).toEqual(a);
  });
  it("the same report items (translations, certificates, findings); only the source path names the .yaml file", () => {
    expect(ry.report.items.length).toBe(rj.report.items.length);
    expect(items(ry)).toBe(items(rj));
    expect(ry.report.summary).toEqual(rj.report.summary);
    expect(ry.report.items.every((i) => !String(i.source).endsWith(".json"))).toBe(true);
  });
});

describe("notification channels (Plan 07 item 6)", async () => {
  // The Redis high-memory monitor, with two handles appended: one the channel map knows, one it doesn't.
  const input = mkdtempSync(join(tmpdir(), "t8-ch-in-"));
  mkdirSync(join(input, "monitors"));
  const mon = JSON.parse(readFileSync(join(ROOT, "fixtures", "datadog", "monitors", "redisdb__high_mem.json"), "utf8"));
  const def = mon.definition ?? mon;
  def.message = `${def.message}\nNotify @slack-ops-alerts @pagerduty-db`;
  writeFileSync(join(input, "monitors", "redisdb__high_mem.json"), JSON.stringify(mon));
  const SLACK = "6f1c2a8e-0b0d-4c1e-9a52-3d1f0e7b9c44";
  const chFile = join(mkdtempSync(join(tmpdir(), "t8-ch-map-")), "channels.yaml");
  writeFileSync(chFile, `channels:\n  "@Slack-Ops-Alerts": ${SLACK}\n`);

  const run = (over: Partial<MigrateOptions>) => migrate(opts({ ingest: { input }, mode: "none", ...over }));
  const mapped = await run({ channelsFile: chFile });
  const shipped = await run({});
  const item = (r: typeof mapped) => r.report.items.find((i) => i.id === "dd-monitor-redisdb__high_mem")!;
  const rule = (r: typeof mapped) => r.alerts[0]!.conversion.rule!;

  it("a mapped handle is bound on the check rule; nothing else is", () => {
    expect(rule(mapped).annotations?.[CHANNEL_ANNOTATION]).toBe(SLACK);
  });
  it("only the unmapped handle stays a manual action", () => {
    const a = item(mapped).manual_actions.filter((x) => x.includes("notification channels"));
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("@pagerduty-db");
    expect(a[0]).not.toContain("@slack-ops-alerts");
  });
  it("the report names the channel map it used", () => {
    expect(mapped.report.run.mappingFiles).toContain(chFile.replace(/\\/g, "/").split("/").slice(-2).join("/"));
    expect(shipped.report.run.mappingFiles).toContain("mappings/notification-channels.yaml");
  });
  it("the shipped map is empty: no binding, both handles reported as manual", () => {
    expect(rule(shipped).annotations?.[CHANNEL_ANNOTATION]).toBeUndefined();
    const a = item(shipped).manual_actions.find((x) => x.includes("notification channels"))!;
    expect(a).toContain("@slack-ops-alerts");
    expect(a).toContain("@pagerduty-db");
  });
  it("an explicit --channels file that doesn't exist fails instead of being ignored", async () => {
    await expect(run({ channelsFile: join(input, "nope.yaml") })).rejects.toThrow(/channel map not found/);
  });
  it("--channels is a CLI flag", () => {
    const f = parseFlags(["--from", "datadog", "--input", "x", "--channels", "ch.yaml"]);
    expect(typeof f === "string" ? f : f.channels).toBe("ch.yaml");
  });
});
