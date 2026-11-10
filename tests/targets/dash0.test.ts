import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importAll, preflightCheckRule, preflightDashboard, dash0Id, configFromEnv, retryDelayMs, seconds,
  type DashboardDefinition, type PrometheusAlertRule, type Dash0Config,
} from "../../src/targets/dash0/index.js";

const TOKEN = "tok_SECRET_should_never_leak";
const rule = (over: Partial<PrometheusAlertRule> = {}): PrometheusAlertRule => ({
  id: "3e643081-f9f9-5867-88b2-d6c8a6b05f30", // T6: UUIDv5 of the Datadog monitor id
  name: "[Redis] High memory consumption",
  expression: "avg_over_time((100 * avg(x) / avg(y))[5m:1m]) > $__threshold",
  thresholds: { failed: 90, degraded: 70 },
  interval: "1m",
  for: "0s",
  ...over,
});
const dash = (over: Partial<DashboardDefinition["spec"]> = {}): DashboardDefinition => ({
  kind: "Dashboard",
  metadata: { name: "Redis - Overview", dash0Extensions: { id: "dd-redis-overview" } },
  spec: {
    display: { name: "Redis - Overview" },
    panels: {
      mem: {
        kind: "Panel",
        spec: {
          display: { name: "Memory" },
          plugin: { kind: "TimeSeriesChart", spec: {} },
          queries: [{ kind: "TimeSeriesQuery", spec: { plugin: { kind: "PrometheusTimeSeriesQuery", spec: { query: 'avg({otel_metric_name="redis.memory.used"})' } } } }],
        },
      },
    },
    layouts: [{ kind: "Grid", spec: { items: [{ x: 0, y: 0, width: 12, height: 8, content: { $ref: "#/spec/panels/mem" } }] } }],
    ...over,
  },
});
const tmp = () => mkdtempSync(join(tmpdir(), "dash0-t7-"));

/** In-memory fake of the four endpoints we use. `transform` lets a test change what the server stores. */
function fakeDash0(opts: { transform?: (kind: string, body: any) => any; failWith?: { status: number; body: unknown; headers?: Record<string, string> }[] } = {}) {
  const stored = new Map<string, any>();
  const calls: { method: string; url: URL; headers: Record<string, string>; body?: any }[] = [];
  const failures = [...(opts.failWith ?? [])];
  const f = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: init.headers as Record<string, string>, body });
    const fail = failures.shift();
    if (fail) return new Response(JSON.stringify(fail.body), { status: fail.status, headers: fail.headers });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
    const m = /^\/api\/(dashboards|alerting\/check-rules)\/(.+)$/.exec(url.pathname);
    // Like live Dash0 (probes 2026-11-07): PUT /api/dashboards/{origin} upserts by origin; Import Check Rule upserts
    // by a UUID id and rejects any other id with 400.
    if (method === "PUT" && m && m[1] === "dashboards") {
      stored.set(`d:${decodeURIComponent(m[2]!)}`, opts.transform?.("dashboard", body) ?? body);
      return json(body);
    }
    if (method === "POST" && url.pathname === "/api/import/check-rule") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.id ?? "")) return json({ error: { code: 400, message: "id must be a UUID" } }, 400);
      // Dash0 normalises durations on the way back (dash0-cli fixture: "5m0s").
      const stored0 = { ...body, interval: body.interval === "1m" ? "1m0s" : body.interval };
      stored.set(`r:${body.id}`, opts.transform?.("rule", stored0) ?? stored0);
      return json(stored0);
    }
    if (method === "GET" && m) {
      const v = stored.get(`${m[1] === "dashboards" ? "d" : "r"}:${decodeURIComponent(m[2]!)}`);
      return v ? json(v) : json({ error: { code: 404, message: "not found" } }, 404);
    }
    return json({ error: { code: 400, message: `unexpected ${method} ${url.pathname}` } }, 400);
  }) as typeof fetch;
  return { f, calls, stored };
}
const cfg = (f: typeof fetch, over: Partial<Dash0Config> = {}): Dash0Config => ({ apiUrl: "https://api.eu-west-1.aws.dash0.com", token: TOKEN, dataset: "thinc", fetch: f, sleep: async () => {}, ...over });

describe("ids", () => {
  it("dd-<slug>, lower-case, safe characters only", () => {
    expect(dash0Id("abc-DEF-123")).toBe("dd-abc-def-123");
    expect(dash0Id("redisdb/overview.json")).toBe("dd-redisdb-overview-json");
    expect(() => dash0Id("///")).toThrow();
  });
});

describe("preflight", () => {
  it("accepts a valid rule and dashboard", () => {
    expect(preflightCheckRule(rule())).toEqual([]);
    expect(preflightDashboard(dash())).toEqual([]);
  });
  it("rejects $__threshold without thresholds, bad durations and bad ids", () => {
    expect(preflightCheckRule(rule({ thresholds: {} })).join()).toMatch(/thresholds.degraded or thresholds.failed/);
    expect(preflightCheckRule(rule({ for: "5 minutes" })).join()).toMatch(/not a Dash0 duration/);
    expect(preflightCheckRule(rule({ id: "DD High Mem" })).join()).toMatch(/must be a UUID/);
  });
  it("rejects dangling $refs, grid overflow, unplaced panels and the CR form", () => {
    const d = dash({ layouts: [{ kind: "Grid", spec: { items: [{ x: 20, y: 0, width: 8, height: 8, content: { $ref: "#/spec/panels/nope" } }] } }] });
    const errs = preflightDashboard(d).join("\n");
    expect(errs).toMatch(/missing panel 'nope'/);
    expect(errs).toMatch(/24-column grid/);
    expect(errs).toMatch(/panel 'mem' is not placed/);
    expect(preflightDashboard({ ...dash(), kind: "PersesDashboard" as "Dashboard" }).join()).toMatch(/kind must be "Dashboard"/);
  });
});

describe("dry run", () => {
  it("writes canonical payloads and a manifest, and never calls the network", async () => {
    const { f, calls } = fakeDash0();
    const out = tmp();
    const m = await importAll({ dashboards: [dash()], rules: [rule()] }, { dryRun: true, outDir: out, config: cfg(f) });
    expect(calls).toHaveLength(0);
    expect(m.summary["dry-run"]).toBe(2);
    expect(readdirSync(join(out, "dashboards"))).toEqual(["dd-redis-overview.json"]);
    expect(JSON.parse(readFileSync(join(out, "check-rules", "3e643081-f9f9-5867-88b2-d6c8a6b05f30.json"), "utf8")).enabled).toBe(false); // D-30
  });
  it("is deterministic: the same input gives a byte-identical manifest", async () => {
    const a = tmp(), b = tmp();
    await importAll({ dashboards: [dash()], rules: [rule()] }, { dryRun: true, outDir: a });
    await importAll({ dashboards: [dash()], rules: [rule()] }, { dryRun: true, outDir: b });
    expect(readFileSync(join(a, "import-manifest.json"), "utf8")).toBe(readFileSync(join(b, "import-manifest.json"), "utf8"));
  });
  it("still writes rejected payloads so they can be inspected", async () => {
    const out = tmp();
    const m = await importAll({ dashboards: [], rules: [rule({ thresholds: {} })] }, { dryRun: true, outDir: out });
    expect(m.results[0]).toMatchObject({ action: "rejected-preflight" });
    expect(readdirSync(join(out, "check-rules"))).toEqual(["3e643081-f9f9-5867-88b2-d6c8a6b05f30.json"]);
  });
});

describe("live import (fake Dash0)", () => {
  it("dashboards upsert by origin (PUT), rules via the Import API by UUID id; auth + dataset; each read back", async () => {
    const { f, calls } = fakeDash0();
    const m = await importAll({ dashboards: [dash()], rules: [rule()] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "PUT /api/dashboards/dd-redis-overview",
      "GET /api/dashboards/dd-redis-overview",
      "GET /api/alerting/check-rules/3e643081-f9f9-5867-88b2-d6c8a6b05f30", // current on/off state (keep it on re-runs)
      "POST /api/import/check-rule",
      "GET /api/alerting/check-rules/3e643081-f9f9-5867-88b2-d6c8a6b05f30",
    ]);
    expect(calls[3]!.body.id).toBe("3e643081-f9f9-5867-88b2-d6c8a6b05f30"); // the Import API upserts by this UUID
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}` && c.url.searchParams.get("dataset") === "thinc")).toBe(true);
    expect(m.summary).toMatchObject({ imported: 2, readBackMatch: 2, failed: 0 });
  });
  it("treats Dash0's normalised durations (1m -> 1m0s) as a match", async () => {
    const { f } = fakeDash0();
    const m = await importAll({ dashboards: [], rules: [rule()] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(m.results[0]!.readBack).toEqual({ state: "match" });
  });
  it("reports a read-back mismatch field by field", async () => {
    const { f } = fakeDash0({ transform: (k, b) => (k === "rule" ? { ...b, thresholds: { failed: 90 }, expression: "up" } : b) });
    const m = await importAll({ dashboards: [], rules: [rule()] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(m.results[0]!.readBack).toEqual({ state: "mismatch", fields: ["expression", "thresholds.degraded"] });
  });
  it("re-running upserts instead of duplicating: still exactly one rule per origin", async () => {
    const { f, stored } = fakeDash0();
    for (let i = 0; i < 2; i++) await importAll({ dashboards: [dash()], rules: [rule()] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect([...stored.keys()].sort()).toEqual(["d:dd-redis-overview", "r:3e643081-f9f9-5867-88b2-d6c8a6b05f30"]);
  });
  it("a non-UUID rule id is rejected before sending (Dash0 would answer 400)", async () => {
    const { f, calls } = fakeDash0();
    const m = await importAll({ dashboards: [], rules: [rule({ id: "dd-monitor-redisdb__high_mem" })] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(m.results[0]).toMatchObject({ action: "rejected-preflight" });
    expect(calls).toHaveLength(0);
  });
  it("dashboard origins may contain underscores and dots", async () => {
    const { f, calls } = fakeDash0();
    const d = dash();
    d.metadata.dash0Extensions = { id: "dd-redisdb__overview.v2" };
    const m = await importAll({ dashboards: [d], rules: [] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(m.summary).toMatchObject({ imported: 1, readBackMatch: 1 });
    expect(calls[0]!.url.pathname).toBe("/api/dashboards/dd-redisdb__overview.v2");
  });
  it("reports 'missing' when the read-back by origin finds nothing", async () => {
    const { f } = fakeDash0();
    // The PUT succeeds, but the GET by origin finds nothing.
    const lost = (async (u: URL | string, i?: RequestInit) => ((i?.method ?? "GET") === "GET" && String(u).includes("/api/alerting/check-rules/") ? new Response(JSON.stringify({ error: { code: 404, message: "nf" } }), { status: 404 }) : f(u, i))) as typeof fetch;
    const m = await importAll({ dashboards: [], rules: [rule()] }, { dryRun: false, outDir: tmp(), config: cfg(lost) });
    expect(m.results[0]).toMatchObject({ action: "imported", readBack: { state: "missing" } });
  });
  it("retries 429 using Retry-After, then succeeds", async () => {
    const slept: number[] = [];
    const { f } = fakeDash0({ failWith: [{ status: 429, body: { error: { code: 429, message: "slow down" } }, headers: { "retry-after": "2" } }] });
    const m = await importAll({ dashboards: [], rules: [rule()] }, { dryRun: false, outDir: tmp(), config: cfg(f, { sleep: async (ms) => void slept.push(ms) }) });
    expect(slept).toEqual([2000]);
    expect(m.summary.imported).toBe(1);
  });
  it("records the error and traceId of a failed import, and never leaks the token", async () => {
    const bad = { status: 400, body: { error: { code: 400, type: "invalid_expression", message: "bad PromQL", traceId: "trace-123" } } };
    const { f } = fakeDash0({ failWith: [bad, bad] }); // the state lookup (GET) and the import both fail
    const m = await importAll({ dashboards: [], rules: [rule()] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(m.results[0]).toMatchObject({ action: "failed", traceId: "trace-123" });
    expect(m.results[0]!.errors[0]).toMatch(/400: bad PromQL/);
    expect(JSON.stringify(m)).not.toContain(TOKEN);
  });
  it("a re-run keeps an existing rule's on/off state; a new rule starts disabled; enableRules beats the payload's false", async () => {
    const { f, calls, stored } = fakeDash0();
    const sentEnabled = () => calls.filter((c) => c.method === "POST").at(-1)!.body.enabled;
    await importAll({ dashboards: [], rules: [rule({ enabled: false })] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(sentEnabled()).toBe(false); // new
    const key = "r:3e643081-f9f9-5867-88b2-d6c8a6b05f30";
    stored.set(key, { ...(stored.get(key) as object), enabled: true }); // someone turned it on in Dash0
    const m = await importAll({ dashboards: [], rules: [rule({ enabled: false })] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(sentEnabled()).toBe(true); // kept on
    expect(m.results[0]).toMatchObject({ enabled: true, readBack: { state: "match" } });
    stored.set(key, { ...(stored.get(key) as object), enabled: false });
    await importAll({ dashboards: [], rules: [rule({ enabled: false })] }, { dryRun: false, outDir: tmp(), config: cfg(f) });
    expect(sentEnabled()).toBe(false); // kept off
    await importAll({ dashboards: [], rules: [rule({ enabled: false })] }, { dryRun: false, outDir: tmp(), config: cfg(f), enableRules: true });
    expect(sentEnabled()).toBe(true); // asked for
  });
  it("imports rules enabled only with enableRules", async () => {
    const { f, calls } = fakeDash0();
    await importAll({ dashboards: [], rules: [rule()] }, { dryRun: false, outDir: tmp(), config: cfg(f), enableRules: true });
    expect(calls[0]!.body.enabled).toBe(true);
  });
});

describe("helpers", () => {
  it("retry delay: Retry-After seconds, then exponential backoff, capped at 30 s", () => {
    expect(retryDelayMs("3", 0)).toBe(3000);
    expect(retryDelayMs(null, 0)).toBe(1000);
    expect(retryDelayMs(null, 2)).toBe(4000);
    expect(retryDelayMs("999", 0)).toBe(30000);
  });
  it("duration seconds", () => {
    expect(seconds("1m0s")).toBe(60);
    expect(seconds("1h30m")).toBe(5400);
    expect(seconds("5 minutes")).toBeNaN();
  });
  it("config from env requires URL and token, and https", () => {
    expect(() => configFromEnv({})).toThrow(/DASH0_API_URL/);
    expect(() => configFromEnv({ DASH0_API_URL: "https://x" })).toThrow(/DASH0_AUTH_TOKEN/);
    expect(configFromEnv({ DASH0_API_URL: "https://x", DASH0_AUTH_TOKEN: "t", DASH0_DATASET: "d" })).toEqual({ apiUrl: "https://x", token: "t", dataset: "d" });
  });
});
