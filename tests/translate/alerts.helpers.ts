// Test helpers: a minimal Datadog monitor -> IR Alert (the part of T2's alertFromDatadog T6 depends on), and fixtures.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Alert } from "../../src/ir/index.js";

const DIR = fileURLToPath(new URL("../../fixtures/datadog/monitors/", import.meta.url));

export function alertFrom(json: unknown, id: string): Alert {
  const outer = json as Record<string, unknown>;
  const m = (outer.definition ?? outer) as Record<string, unknown>;
  const opts = { ...((m.options as Record<string, unknown>) ?? {}) };
  const t = (opts.thresholds as Record<string, unknown>) ?? {};
  delete opts.thresholds;
  const num = (x: unknown) => (x === null || x === undefined || x === "" ? undefined : Number(x));
  const thresholds: Alert["thresholds"] = {};
  for (const [k, src] of [["critical", "critical"], ["warning", "warning"], ["criticalRecovery", "critical_recovery"], ["warningRecovery", "warning_recovery"]] as const) {
    const n = num(t[src]);
    if (n !== undefined && Number.isFinite(n)) thresholds[k] = n;
  }
  return {
    source: { vendor: "datadog", id },
    name: String(m.name ?? id),
    message: String(m.message ?? ""),
    type: String(m.type),
    query: String(m.query),
    thresholds,
    tags: ((m.tags ?? outer.tags ?? []) as string[]).filter((x) => typeof x === "string"),
    options: opts,
    original: json,
  };
}

export function fixtureMonitors(): Array<{ name: string; alert: Alert }> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, alert: alertFrom(JSON.parse(readFileSync(DIR + f, "utf8")), f.replace(/\.json$/, "")) }));
}

export function monitor(over: Partial<Alert> & { query: string }): Alert {
  return {
    source: { vendor: "datadog", id: "12345" },
    name: "Test monitor",
    message: "",
    type: "query alert",
    thresholds: {},
    tags: [],
    options: {},
    original: {},
    ...over,
  };
}
