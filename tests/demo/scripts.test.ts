// T10 demo scripts: the pure parts (request bodies, safety filters). Network calls are not exercised here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deletable, deletePath } from "../../scripts/demo/reset-dash0.js";
import { dashboardBody, monitorBody } from "../../scripts/demo/seed-datadog.js";

const fixture = (p: string) => JSON.parse(readFileSync(new URL(`../../fixtures/datadog/${p}`, import.meta.url), "utf8"));

describe("seed-datadog", () => {
  it("dashboard body: the fixture minus read-only fields, marked once", () => {
    const b = dashboardBody({ ...fixture("dashboards/redisdb__overview.json"), id: "abc", url: "/x", created_at: "t" });
    expect(b).not.toHaveProperty("id");
    expect(b).not.toHaveProperty("url");
    expect(b.title).toBe("Redis - Overview");
    expect(String(b.description).match(/\[dd2dash0-demo\]/g)).toHaveLength(1);
    expect(String(dashboardBody(b).description).match(/\[dd2dash0-demo\]/g)).toHaveLength(1);
  });

  it("monitor body: unwrapped, tagged, no null priority", () => {
    const b = monitorBody(fixture("monitors/redisdb__high_mem.json"));
    expect(b).toMatchObject({ name: "[Redis] High memory consumption", type: "query alert" });
    expect(b.query).toBe("avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90");
    expect(b.tags).toEqual(["dd2dash0-demo", "integration:redisdb"]);
    expect(b).not.toHaveProperty("priority");
  });

  it("refuses a monitor that could notify someone", () => {
    expect(() => monitorBody({ name: "x", type: "query alert", query: "q", message: "disk full @pagerduty-db" })).toThrow(/@handle/);
    expect(() => monitorBody({ name: "x", type: "query alert", query: "q", message: "mail ops@example.com" })).not.toThrow();
  });
});

describe("reset-dash0", () => {
  const m = {
    dryRun: false,
    results: [
      { kind: "dashboard" as const, id: "dd-abc-def", name: "Redis", action: "imported" },
      { kind: "check-rule" as const, id: "dd-monitor-123", name: "high mem", action: "imported" },
      { kind: "check-rule" as const, id: "3e643081-f9f9-5867-88b2-d6c8a6b05f30", name: "uuidv5 rule", action: "imported" },
      { kind: "check-rule" as const, id: "3e643081-f9f9-4867-88b2-d6c8a6b05f30", name: "v4, not ours", action: "imported" },
      { kind: "dashboard" as const, id: "dd-x", name: "rejected", action: "rejected-preflight" },
      { kind: "dashboard" as const, id: "someone-elses", name: "other", action: "imported" },
    ],
  };

  it("deletes only imported dd-* dashboards and dd-* / UUIDv5 check rules from the manifest", () => {
    expect(deletable(m).map((r) => r.id)).toEqual(["dd-abc-def", "dd-monitor-123", "3e643081-f9f9-5867-88b2-d6c8a6b05f30"]);
    expect(deletable({ ...m, dryRun: true })).toEqual([]);
  });

  it("uses Dash0's CRUD paths", () => {
    expect(deletePath(m.results[0]!)).toBe("/api/dashboards/dd-abc-def");
    expect(deletePath(m.results[1]!)).toBe("/api/alerting/check-rules/dd-monitor-123");
  });
});
