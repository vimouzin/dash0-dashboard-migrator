import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { stringify } from "yaml";
import { ingestDatadog, ingestFolder, ingestApi, dashboardFromDatadog } from "../../src/sources/datadog/index.js";
import { isGroup, type Dashboard, type Panel } from "../../src/ir/index.js";

const FIX = join(import.meta.dirname, "..", "..", "fixtures", "datadog");
const leaves = (d: Dashboard): Panel[] => d.items.flatMap((x) => (isGroup(x) ? x.panels : [x]));
const all = ingestFolder(FIX);
const dash = (stem: string) => all.dashboards.find((d) => d.source.id === stem)!;
const alert = (stem: string) => all.alerts.find((a) => a.source.id === stem)!;

describe("folder ingest over the fixtures", () => {
  it("finds all 4 dashboards and 6 monitors, with no unreadable files", () => {
    expect(all.dashboards.map((d) => d.source.id)).toEqual([
      "nginx__NGINX-Overview_dashboard",
      "postgres__postgresql_dashboard",
      "postgres__postgresql_screenboard_dashboard",
      "redisdb__overview",
    ]);
    expect(all.alerts).toHaveLength(6);
    expect(all.findings.filter((f) => f.code === "source.unreadable")).toEqual([]);
  });

  it("Redis overview: 7 groups, 36 widgets, every widget accounted for", () => {
    const d = dash("redisdb__overview");
    expect(d.items.filter(isGroup)).toHaveLength(7);
    const kinds: Record<string, number> = {};
    for (const p of leaves(d)) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    expect(leaves(d)).toHaveLength(36);
    expect(kinds).toEqual({ markdown: 7, stat: 10, timeseries: 15, toplist: 1, unsupported: 1, logs: 2 });
    expect(d.gridColumns).toBe(12);
  });

  it("template variables: prefix becomes tagKey; $scope stays free-form (null)", () => {
    const vars = dash("redisdb__overview").variables;
    expect(vars.find((v) => v.name === "scope")).toEqual({ name: "scope", tagKey: null, default: "*" });
    expect(vars.find((v) => v.name === "host")).toEqual({ name: "host", tagKey: "host", default: "*" });
  });

  it("new-format requests keep query names, data sources, aggregators and formulas", () => {
    const toplist = leaves(dash("postgres__postgresql_screenboard_dashboard")).find((p) => p.kind === "toplist")!;
    expect(toplist.requests[0]).toMatchObject({
      queries: [{ refId: "query1", dataSource: "metrics", aggregator: "avg", expr: expect.stringMatching(/^avg:postgresql\.index_scans\{/) }],
      formulas: [{ expr: "query1", limit: { count: 5, order: "desc" } }],
    });
  });

  it("legacy q requests become one query q0 with no formulas", () => {
    const qv = leaves(dash("nginx__NGINX-Overview_dashboard")).find((p) => p.title === "Dropped connections, last 15m")!;
    expect(qv.kind).toBe("stat");
    expect(qv.requests).toEqual([{ queries: [expect.objectContaining({ refId: "q0", dataSource: "metrics", expr: "sum:nginx.net.conn_dropped_per_s{*}.as_count()", aggregator: "max" })], formulas: [] }]);
  });

  it("log widgets: legacy log_stream and list_stream (logs) become 'logs' panels with their query", () => {
    const ng = leaves(dash("nginx__NGINX-Overview_dashboard")).find((p) => p.sourceType === "log_stream")!;
    expect(ng).toMatchObject({ kind: "logs", requests: [{ queries: [{ dataSource: "logs_stream", expr: "source:nginx @http.status_code:(404 OR 500)" }] }] });
    const rd = leaves(dash("redisdb__overview")).find((p) => p.title === "Error Logs")!;
    expect(rd).toMatchObject({ kind: "logs", requests: [{ queries: [{ dataSource: "logs_stream", expr: "source:redis $scope $host status:error" }] }] });
  });

  it("unsupported widgets are kept with a finding (never dropped)", () => {
    const d = dash("nginx__NGINX-Overview_dashboard");
    const unsupported = leaves(d).filter((p) => p.kind === "unsupported").map((p) => p.sourceType).sort();
    expect(unsupported).toEqual(["change", "check_status", "event_stream", "hostmap", "manage_status"]);
    const codes = all.findings.filter((f) => f.code === "widget.unsupported" && f.itemId.startsWith("dd-dash-nginx"));
    expect(codes).toHaveLength(5);
    const hostmap = leaves(d).find((p) => p.sourceType === "hostmap")!;
    expect(hostmap.requests[0]!.queries[0]!.expr).toBe("avg:nginx.net.request_per_s{*} by {host}"); // object-shaped requests
  });

  it("notes keep their markdown text; layout is in Datadog's 12-column units", () => {
    const note = leaves(dash("nginx__NGINX-Overview_dashboard")).find((p) => p.kind === "markdown")!;
    expect(String(note.options.text)).toMatch(/^This dashboard provides a high-level view/);
    expect(note.layout).toEqual({ x: 0, y: 0, w: 3, h: 2 });
  });

  it("monitors: unwraps {version, definition}, maps thresholds, coerces string numbers", () => {
    const m = alert("redisdb__high_mem");
    expect(m).toMatchObject({
      name: "[Redis] High memory consumption",
      type: "query alert",
      query: "avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90",
      thresholds: { critical: 90, warning: 70 },
    });
    expect(m.options.thresholds).toBeUndefined();
    expect(alert("postgres__percent_usage_connections").options.renotify_interval).toBe(0); // was "0"
    expect(alert("nginx__conn_dropped").thresholds).toEqual({ critical: 1, criticalRecovery: 0 });
  });

  it("is deterministic: two runs give identical output", () => {
    expect(JSON.stringify(ingestFolder(FIX))).toBe(JSON.stringify(all));
  });

  it("--only filters", () => {
    expect(ingestFolder(FIX, "monitors").dashboards).toHaveLength(0);
    expect(ingestFolder(FIX, "dashboards").alerts).toHaveLength(0);
  });
});

describe("folder robustness", () => {
  it("bad JSON and unknown shapes become findings; the rest still ingests", () => {
    const dir = mkdtempSync(join(tmpdir(), "t2-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "broken.json"), "{ nope");
    writeFileSync(join(dir, "other.json"), JSON.stringify({ hello: 1 }));
    writeFileSync(join(dir, "nested", "mon.json"), readFileSync(join(FIX, "monitors", "redisdb__high_mem.json")));
    const r = ingestFolder(dir);
    expect(r.alerts).toHaveLength(1);
    expect(r.findings.map((f) => [f.code, f.itemId])).toEqual([
      ["source.unreadable", "broken.json"],
      ["source.unreadable", "other.json"],
    ]);
  });
  it("a leading UTF-8 byte order mark is stripped: the file ingests like its twin without one (Henry's stress run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "t2-"));
    const body = readFileSync(join(FIX, "dashboards", "redisdb__overview.json"), "utf8");
    writeFileSync(join(dir, "bom.json"), "﻿" + body);
    writeFileSync(join(dir, "bom.yaml"), "﻿" + stringify({ id: "y-1", title: "Y", widgets: [] }));
    const r = ingestFolder(dir);
    expect(r.findings.filter((f) => f.code === "source.unreadable")).toEqual([]);
    expect(r.dashboards.map((d) => d.title).sort()).toEqual([JSON.parse(body).title, "Y"].sort());
  });
  it("an API export's id wins over the file name", () => {
    const dir = mkdtempSync(join(tmpdir(), "t2-"));
    writeFileSync(join(dir, "x.json"), JSON.stringify({ id: "abc-def-ghi", title: "T", widgets: [] }));
    expect(ingestFolder(dir).dashboards[0]!.source).toMatchObject({ id: "abc-def-ghi", origin: "x.json" });
  });
  it("requires exactly one of input / api", async () => {
    await expect(ingestDatadog({})).rejects.toThrow(/exactly one/);
  });
});

describe("API ingest (fake Datadog EU)", () => {
  const redis = JSON.parse(readFileSync(join(FIX, "dashboards", "redisdb__overview.json"), "utf8"));
  const highMem = JSON.parse(readFileSync(join(FIX, "monitors", "redisdb__high_mem.json"), "utf8")).definition;
  const fake = () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const f = (async (u: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(u));
      calls.push({ url: url.toString(), headers: init.headers as Record<string, string> });
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
      if (url.pathname === "/api/v1/dashboard") return json({ dashboards: [{ id: "zzz-redis" }, { id: "aaa-broken" }] });
      if (url.pathname === "/api/v1/dashboard/zzz-redis") return json({ ...redis, id: "zzz-redis" });
      if (url.pathname === "/api/v1/dashboard/aaa-broken") return new Response("gone", { status: 404 });
      if (url.pathname === "/api/v1/monitor") return json(url.searchParams.get("page") === "0" ? [{ ...highMem, id: 42 }] : []);
      return new Response("?", { status: 400 });
    }) as typeof fetch;
    return { f, calls };
  };
  it("lists and fetches from api.datadoghq.eu with both keys, sorted by id; a failed dashboard becomes a finding", async () => {
    const { f, calls } = fake();
    const r = await ingestApi({ api: true, apiKey: "k", appKey: "a", fetch: f }, {});
    expect(calls.every((c) => c.url.startsWith("https://api.datadoghq.eu/") && c.headers["DD-API-KEY"] === "k" && c.headers["DD-APPLICATION-KEY"] === "a")).toBe(true);
    expect(r.dashboards.map((d) => d.source)).toEqual([{ vendor: "datadog", id: "zzz-redis", origin: "api", url: "https://app.datadoghq.eu/dashboard/zzz-redis" }]);
    expect(r.alerts.map((a) => [a.source.id, a.thresholds.critical])).toEqual([["42", 90]]);
    expect(r.findings.find((x) => x.code === "source.unreadable")?.message).toMatch(/aaa-broken -> 404/);
    expect(JSON.stringify(r.findings)).not.toMatch(/"k"|"a"/);
  });
  it("needs both keys", async () => {
    await expect(ingestApi({ api: true }, {})).rejects.toThrow(/DD_API_KEY and DD_APP_KEY/);
  });
});

describe("normalizer edge cases", () => {
  it("a free layout gets a finding; missing layout is null", () => {
    const r = dashboardFromDatadog({ title: "F", layout_type: "free", widgets: [{ id: 1, definition: { type: "note", content: "x" } }] }, { vendor: "datadog", id: "f" });
    expect(r.findings.map((f) => f.code)).toEqual(["layout.free"]);
    expect(r.dashboard.items[0]).toMatchObject({ kind: "markdown", layout: null });
  });
});

/** Copy every .json under `src` to a fresh folder as YAML (same document), renaming x.json -> x<ext>. */
function yamlTwin(src: string, ext = ".yaml"): string {
  const out = mkdtempSync(join(tmpdir(), "t2-yaml-"));
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".json")) {
        const dest = join(out, relative(src, p)).replace(/\.json$/, ext);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, stringify(JSON.parse(readFileSync(p, "utf8"))));
      }
    }
  };
  walk(src);
  return out;
}
/** The ingest result with each origin's file extension dropped, so a JSON run and its YAML twin compare directly. */
const noExt = (r: unknown) => JSON.stringify(r).replace(/"origin":"([^"]*)\.(json|ya?ml)"/g, '"origin":"$1"');

describe("YAML exports (brief: 'Datadog dashboards exported as YAML files')", () => {
  it("every fixture as YAML ingests exactly like its JSON twin (ids, panels, alerts, findings)", () => {
    const y = ingestFolder(yamlTwin(FIX));
    expect(y.dashboards).toHaveLength(4);
    expect(y.alerts).toHaveLength(6);
    expect(noExt(y)).toBe(noExt(all));
    expect(y.dashboards[0]!.source.origin).toMatch(/\.yaml$/);
  });
  it(".yml and upper-case extensions are read too", () => {
    expect(ingestFolder(yamlTwin(join(FIX, "monitors"), ".yml")).alerts).toHaveLength(6);
    expect(ingestFolder(yamlTwin(join(FIX, "monitors"), ".YAML")).alerts).toHaveLength(6);
  });
  it("YAML 1.2 core schema: yes/on/dates stay strings, as in the JSON they came from", () => {
    const dir = mkdtempSync(join(tmpdir(), "t2-"));
    writeFileSync(join(dir, "d.yaml"), "title: yes\ndescription: 2026-11-07\nwidgets: []\ntemplate_variables:\n  - name: on\n    prefix: on\n");
    const d = ingestFolder(dir).dashboards[0]!;
    expect(d.title).toBe("yes");
    expect(d.description).toBe("2026-11-07");
  });
  it("broken YAML, duplicate keys, several documents and an empty file become findings; the rest still ingests", () => {
    const dir = mkdtempSync(join(tmpdir(), "t2-"));
    writeFileSync(join(dir, "a-broken.yaml"), "title: [unclosed\n");
    writeFileSync(join(dir, "b-dup.yaml"), "title: A\ntitle: B\nwidgets: []\n");
    writeFileSync(join(dir, "c-multi.yml"), "title: A\nwidgets: []\n---\ntitle: B\nwidgets: []\n");
    writeFileSync(join(dir, "d-empty.yaml"), "");
    writeFileSync(join(dir, "e-mon.yaml"), stringify(JSON.parse(readFileSync(join(FIX, "monitors", "redisdb__high_mem.json"), "utf8"))));
    const r = ingestFolder(dir);
    expect(r.alerts).toHaveLength(1);
    expect(r.dashboards).toHaveLength(0);
    const f = r.findings.map((x) => [x.code, x.itemId, x.message]);
    expect(f.map((x) => x.slice(0, 2))).toEqual([
      ["source.unreadable", "a-broken.yaml"],
      ["source.unreadable", "b-dup.yaml"],
      ["source.unreadable", "c-multi.yml"],
      ["source.unreadable", "d-empty.yaml"],
    ]);
    expect(f[0]![2]).toMatch(/not valid YAML/);
    expect(f[1]![2]).toMatch(/not valid YAML.*unique/);
    expect(f[2]![2]).toMatch(/2 YAML documents in one file/);
    expect(f[3]![2]).toMatch(/neither a Datadog dashboard/);
  });
});
