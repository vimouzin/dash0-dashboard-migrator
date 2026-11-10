// The guided flow (src/flow): keys, URL check, batched review, live-data classification, score math, and a full
// live run against a fake Dash0 + Datadog (no network).
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/pipeline/config.js";
import { runPlan } from "../../src/pipeline/plan.js";
import type { ReportItem } from "../../src/report/types.js";
import { KeyError, lookupKeys, mergeDotEnv, normalizeDash0Url, parseDotEnv, resolveKeys, saveDotEnv, type KeyIO } from "../../src/flow/keys.js";
import { batchedReview } from "../../src/flow/review.js";
import { guided } from "../../src/flow/run.js";
import { scoreOf, type Row } from "../../src/flow/score.js";
import { datadogMetricQuery, prepareDash0, verifyLive } from "../../src/flow/verify.js";

const ROOT = join(import.meta.dirname, "..", "..");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `dd2dash0-flow-${p}-`));

/** Scripted terminal: answers in order; records everything printed and every prompt. */
function scripted(answers: string[]): KeyIO & { out: string[]; prompts: string[] } {
  const out: string[] = [];
  const prompts: string[] = [];
  const next = async (p: string) => {
    prompts.push(p);
    return answers.length ? answers.shift()! : null;
  };
  return { out, prompts, ask: next, askSecret: next, print: (l) => out.push(l) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("keys", () => {
  it("parses .env, env wins, merges without losing other lines, saves 0600", () => {
    const d = parseDotEnv('# c\nDD_API_KEY="abc"\nexport DASH0_DATASET=prod # note\nOTHER=1\n');
    expect(d).toEqual({ DD_API_KEY: "abc", DASH0_DATASET: "prod", OTHER: "1" });
    expect(lookupKeys({ DD_API_KEY: "env" }, d)).toEqual({ DD_API_KEY: "env", DASH0_DATASET: "prod" });
    expect(mergeDotEnv("# keep\nOTHER=1\nDD_API_KEY=old\n", { DD_API_KEY: "new", DD_SITE: "datadoghq.eu" })).toBe("# keep\nOTHER=1\nDD_API_KEY=new\nDD_SITE=datadoghq.eu\n");
    const dir = tmp("env");
    writeFileSync(join(dir, ".env"), "OTHER=1\n", { mode: 0o644 });
    saveDotEnv(join(dir, ".env"), { DASH0_AUTH_TOKEN: "t" });
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("OTHER=1\nDASH0_AUTH_TOKEN=t\n");
  });

  it("normalizes the Dash0 API URL and refuses the ingress endpoint", () => {
    expect(normalizeDash0Url(" https://api.eu-west-1.aws.dash0.com/ ")).toEqual({ url: "https://api.eu-west-1.aws.dash0.com" });
    expect(normalizeDash0Url("api.eu-west-1.aws.dash0.com")).toEqual({ url: "https://api.eu-west-1.aws.dash0.com" });
    for (const bad of ["https://ingress.eu-west-1.aws.dash0.com", "https://ingress.eu-west-1.aws.dash0.com:4317", "https://x.dash0.com:4318/v1/traces"]) {
      const r = normalizeDash0Url(bad);
      expect("error" in r && r.error).toMatch(/ingress/);
    }
    expect("error" in normalizeDash0Url("http://api.dash0.com")).toBe(true);
  });

  it("--yes never prompts and names the missing keys", async () => {
    const io = scripted([]);
    await expect(resolveKeys({ need: { datadog: true, dash0: true }, env: {}, cwd: tmp("yes"), io, yes: true, home: tmp("home") })).rejects.toThrow(KeyError);
    await expect(resolveKeys({ need: { datadog: true, dash0: true }, env: {}, cwd: tmp("yes"), io, yes: true, home: tmp("home") })).rejects.toThrow(/DD_API_KEY, DD_APP_KEY, DASH0_API_URL, DASH0_AUTH_TOKEN/);
    expect(io.prompts).toEqual([]);
  });

  it("asks for missing keys, re-asks a rejected one, refuses the ingress URL, saves to .env; secrets never printed", async () => {
    const cwd = tmp("ask");
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (u.pathname === "/api/v1/validate") return h["DD-API-KEY"] === "dd-good-api-key" ? json({ valid: true }) : json({ errors: ["Forbidden"] }, 403);
      if (u.pathname === "/api/v1/dashboard") return json({ dashboards: [] });
      if (u.pathname === "/api/dashboards") return h.Authorization === "Bearer d0-good-token-xyz" ? json([]) : json({}, 401);
      return json({}, 404);
    }) as typeof fetch;
    const io = scripted([
      "", // DD_SITE -> default datadoghq.eu
      "dd-bad-api-key-000",
      "dd-good-app-key",
      "dd-good-api-key", // re-asked after the 403
      "https://ingress.eu-west-1.aws.dash0.com:4317", // refused
      "https://api.eu-west-1.aws.dash0.com/",
      "d0-good-token-xyz",
      "", // dataset -> default
      "", // save? -> yes
    ]);
    const home = tmp("home");
    const keys = await resolveKeys({ need: { datadog: true, dash0: true }, env: {}, cwd, io, yes: false, fetch: fetchFn, home });
    expect(keys).toMatchObject({ DD_SITE: "datadoghq.eu", DD_API_KEY: "dd-good-api-key", DASH0_API_URL: "https://api.eu-west-1.aws.dash0.com", DASH0_DATASET: "default" });
    const printed = io.out.join("\n");
    expect(printed).toMatch(/rejected the API key/);
    expect(printed).toMatch(/ingress/);
    for (const secret of ["dd-good-api-key", "dd-good-app-key", "d0-good-token-xyz", "dd-bad-api-key-000"]) expect(printed).not.toContain(secret);
    // Saved to the per-user key file (works from any folder), not into the current folder.
    const savedFile = join(home, ".config", "dd2dash0", ".env");
    expect(existsSync(join(cwd, ".env"))).toBe(false);
    const saved = parseDotEnv(readFileSync(savedFile, "utf8"));
    expect(saved).toMatchObject({ DD_API_KEY: "dd-good-api-key", DASH0_AUTH_TOKEN: "d0-good-token-xyz" });
    expect(statSync(savedFile).mode & 0o777).toBe(0o600);

    // Second run: everything comes from ./.env, nothing is asked.
    const io2 = scripted([]);
    await resolveKeys({ need: { datadog: true, dash0: true }, env: {}, cwd: tmp("elsewhere"), io: io2, yes: false, fetch: fetchFn, home }); // a different folder
    expect(io2.prompts).toEqual([]);
  });
});

async function planOfFixtures() {
  const work = tmp("plan");
  cpSync(join(ROOT, "fixtures", "datadog"), join(work, "src"), { recursive: true });
  const planDir = join(work, "plan");
  const config = resolveConfig({ source: { kind: "folder", path: join(work, "src") } }, {}, {});
  const p = await runPlan({ config, outDir: planDir, defaultMappingsDir: join(ROOT, "mappings"), resolvedInput: join(work, "src"), version: "test" });
  return { work, planDir, report: p.result.report };
}

describe("batched review", () => {
  it("one prompt for all bounded panels plus one per translatable monitor; writes a review apply accepts", async () => {
    const { planDir, report } = await planOfFixtures();
    const rules = report.items.filter((i) => i.kind === "alert" && i.status !== "manual" && i.status !== "unsupported");
    const io = scripted(["list", "n", ...rules.map(() => "y")]);
    const r = await batchedReview(planDir, io, { yes: false });
    expect(io.prompts.filter((p) => /bounded/.test(p))).toHaveLength(2); // asked again after 'list'
    expect(io.prompts.filter((p) => /check rule/.test(p))).toHaveLength(rules.length);
    expect(r.boundedFlagged).toBeGreaterThan(0);
    expect(r.rulesApproved).toHaveLength(rules.length);
    const saved = JSON.parse(readFileSync(r.file, "utf8")) as { decisions: { decision: string }[] };
    expect(saved.decisions.every((d) => ["approved", "flagged", "acknowledged"].includes(d.decision))).toBe(true);
  });

  it("--yes asks nothing", async () => {
    const { planDir } = await planOfFixtures();
    const io = scripted([]);
    const r = await batchedReview(planDir, io, { yes: true });
    expect(io.prompts).toEqual([]);
    expect(r.boundedApproved).toBeGreaterThan(0);
  });
});

describe("live data check", () => {
  const item = (id: string, promql: string[], source: string[], reasons: string[] = []): ReportItem => ({ id, kind: "panel", title: id, promql, source_queries: source, reason_codes: reasons } as unknown as ReportItem);

  it("prepares queries and finds the Datadog metric query", () => {
    expect(prepareDash0('avg(x{otel_metric_name="m"}) > $__threshold', "alert")).toBe('avg(x{otel_metric_name="m"})');
    expect(prepareDash0("rate(m[$__rate_interval]) by $host", "panel")).toBe("rate(m[5m]) by .*");
    expect(datadogMetricQuery("avg(last_5m):avg:redis.mem.used{env:prod} > 0.9")).toBe("avg:redis.mem.used{env:prod}");
    expect(datadogMetricQuery("sum:nginx.requests{*} by {host}")).toBe("sum:nginx.requests{*} by {host}");
    expect(datadogMetricQuery("logs(\"status:error\").index(\"*\").rollup(\"count\").last(\"5m\") > 5")).toBeNull();
  });

  it("classifies live / missing / no-data / error / n/a", async () => {
    const fetchFn = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/query_range")) {
        const q = u.searchParams.get("query")!;
        if (q.includes("bad")) return json({ status: "error", error: "parse error" }, 400);
        return json({ status: "success", data: { resultType: "matrix", result: q.includes("up") ? [{ metric: {}, values: [[1, "1"]] }] : [] } });
      }
      if (u.pathname === "/api/v1/query") return json({ series: u.searchParams.get("query")!.includes("dd.has") ? [{ pointlist: [[1, 2]] }] : [] });
      return json({}, 404);
    }) as typeof fetch;
    const items = [
      item("a", ["up_metric"], ["avg:dd.has{*}"]),
      item("b", ["down_metric"], ["avg:dd.has{*}"], ["metric.unmapped"]),
      item("c", ["down_metric"], ["avg:dd.none{*}"]),
      item("d", ["bad_metric"], []),
      item("e", [], []),
    ];
    const r = await verifyLive(items, { dash0: { apiUrl: "https://api.example.com", token: "t", dataset: "default" }, datadog: { site: "datadoghq.eu", apiKey: "k", appKey: "a" }, fetch: fetchFn, sleep: async () => {} });
    expect(Object.fromEntries([...r].map(([k, v]) => [k, v.live]))).toEqual({ a: "live", b: "missing", c: "no-data", d: "error", e: "n/a" });
    expect(r.get("b")!.cause).toMatch(/mapping table/);
  });
});

describe("score", () => {
  const row = (o: Partial<Row>): Row => ({ id: "x", kind: "panel", title: "", dashboard: "d", widget: "timeseries", status: "exact", decision: "", translated: true, landed: true, landedDetail: "", live: "live", success: true, reasons: [], manualActions: [], sourceQueries: [], promql: [], ...o });
  it("counts every item, rounds down, live over items with data on either side", () => {
    const s = scoreOf([row({}), row({ live: "missing", success: false }), row({ live: "no-data" }), row({ translated: false, success: false, live: "n/a", reasons: ["widget.unsupported"] }), row({ kind: "alert", live: "error", success: false })]);
    expect(s.translated).toEqual({ count: 4, total: 5, pct: 80 });
    expect(s.landed).toEqual({ count: 5, total: 5, pct: 100 });
    expect(s.live).toEqual({ count: 1, total: 3, pct: 33 }); // 33.3 -> 33, never up
    expect(s.success).toEqual({ count: 2, total: 5, pct: 40 });
    expect(s.topGaps[0]).toEqual(["widget.unsupported", 1]);
  });
});

describe("guided flow, live against a fake Dash0 + Datadog", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["DD_SITE", "DD_API_KEY", "DD_APP_KEY", "DASH0_API_URL", "DASH0_AUTH_TOKEN", "DASH0_DATASET"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("imports, reads back, checks data, writes report.md, and enables rules only on yes", async () => {
    const work = tmp("guided");
    cpSync(join(ROOT, "fixtures", "datadog"), join(work, "src"), { recursive: true });
    const store = new Map<string, unknown>();
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const m = init?.method ?? "GET";
      calls.push(`${m} ${u.pathname}`);
      if (u.pathname === "/api/dashboards" && m === "GET") return json([]);
      if (u.pathname.startsWith("/api/dashboards/")) {
        const key = u.pathname;
        if (m === "PUT") store.set(key, JSON.parse(String(init!.body)));
        return store.has(key) ? json(store.get(key)) : json({}, 404);
      }
      if (u.pathname === "/api/import/check-rule") {
        const r = JSON.parse(String(init!.body)) as { id: string };
        store.set(`/api/alerting/check-rules/${r.id}`, r);
        return json(r);
      }
      if (u.pathname.startsWith("/api/alerting/check-rules/")) return store.has(u.pathname) ? json(store.get(u.pathname)) : json({}, 404);
      if (u.pathname.endsWith("/query_range")) return json({ status: "success", data: { resultType: "matrix", result: u.searchParams.get("query")!.includes("redis") ? [{ metric: {}, values: [[1, "1"]] }] : [] } });
      throw new Error(`unexpected request ${m} ${u.href}`);
    }) as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL) => {
      throw new Error(`test reached the real network: ${String(u)}`);
    }) as typeof fetch;
    const env = { DASH0_API_URL: "https://api.eu-west-1.aws.dash0.com", DASH0_AUTH_TOKEN: "fake-token-1234", DASH0_DATASET: "default" };
    const io = scripted(["y", "y", "y"]); // approve bounded, approve the rule, enable rules
    const code = await guided({ yes: false, input: "src", out: "run", version: "test", mappingsDir: join(ROOT, "mappings"), io, env, cwd: work, home: tmp("home"), fetch: fetchFn, now: () => new Date("2026-11-08T10:00:00Z") });
    globalThis.fetch = realFetch;
    const printed = io.out.join("\n");
    expect(printed).not.toContain("fake-token-1234");
    expect(printed).not.toMatch(/✗/);
    expect([0, 1]).toContain(code); // 1 is fine: fixture metrics outside "redis" have no data in the fake
    const rep = JSON.parse(readFileSync(join(work, "run", "report.json"), "utf8")) as { score: { total: number; landed: { count: number }; translated: { count: number }; success: { count: number } }; items: Row[] };
    expect(rep.score.total).toBe(102);
    // Every dashboard panel landed (placeholders too); only the 5 untranslatable monitors have nothing in Dash0.
    expect(rep.score.landed.count).toBe(102 - 5);
    expect(rep.items.filter((r) => r.kind === "alert" && r.enabled)).toHaveLength(1);
    expect(calls.filter((c) => c === "POST /api/import/check-rule")).toHaveLength(2); // import (disabled) + enable
    const md = readFileSync(join(work, "run", "report.md"), "utf8");
    expect(md).toMatch(/\| \*\*Success\*\*/);
    expect(md).toMatch(/## Monitors/);
    expect(md).not.toContain("fake-token-1234");
    expect(existsSync(join(work, "run", "plan", "plan.lock"))).toBe(true);

    // Re-run: the rule is already on in Dash0, so it stays on and the flow doesn't offer to enable it again.
    globalThis.fetch = (async (u: string | URL) => {
      throw new Error(`test reached the real network: ${String(u)}`);
    }) as typeof fetch;
    const io2 = scripted(["y", "y"]);
    await guided({ yes: false, input: "src", out: "run2", version: "test", mappingsDir: join(ROOT, "mappings"), io: io2, env, cwd: work, home: tmp("home"), fetch: fetchFn, now: () => new Date("2026-11-08T10:05:00Z") });
    globalThis.fetch = realFetch;
    expect(io2.prompts.some((p) => /Enable/.test(p))).toBe(false);
    const rep2 = JSON.parse(readFileSync(join(work, "run2", "report.json"), "utf8")) as { items: Row[] };
    expect(rep2.items.filter((r) => r.kind === "alert" && r.enabled)).toHaveLength(1);
    expect(io2.out.join("\n")).toMatch(/1 imported \(1 on, 0 off\)/);
  });
});
