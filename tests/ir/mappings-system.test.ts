// system.* host metrics table (plan 10 lever R1): datadog-agent core checks -> hostmetricsreceiver.
// Every row cites the check source and the receiver; units and kinds follow the pinned sources.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { kindTransform, loadMappings, metricAvailability } from "../../src/ir/index.js";

const root = join(import.meta.dirname, "..", "..");
const m = loadMappings(join(root, "mappings"));
const get = (k: string) => {
  const x = m.metrics.get(k);
  if (!x) throw new Error(`missing ${k}`);
  return x;
};
const rows = [...m.metrics].filter(([k]) => k.startsWith("system."));
const MIB = 1 / (1024 * 1024);

// The 14 distinct system.* names used by the fixture dashboards.
const FIXTURE = ["system.io.util", "system.load.1", "system.load.5", "system.load.15", "system.cpu.idle", "system.cpu.system", "system.cpu.iowait", "system.cpu.user", "system.cpu.stolen", "system.cpu.guest", "system.mem.usable", "system.mem.total", "system.net.bytes_rcvd", "system.net.bytes_sent"];

describe("system mapping table", () => {
  it("lives in system.yaml, covers every fixture name, and every row cites the check source and the receiver", () => {
    for (const k of FIXTURE) expect(m.origin.get(k), k).toMatch(/system\.yaml$/);
    for (const [k, row] of rows) {
      expect(m.origin.get(k), k).toMatch(/system\.yaml$/);
      expect(row.note, k).toMatch(/check source \w+\.go.*Receiver metadata\.yaml/s);
    }
  });

  it("load averages are exact 1:1 gauges", () => {
    for (const [dd, otel] of [["1", "1m"], ["5", "5m"], ["15", "15m"]] as const) {
      const row = get(`system.load.${dd}`);
      expect(row).toMatchObject({ otel: `system.cpu.load_average.${otel}`, ddKind: "gauge", otelKind: "gauge", status: "exact" });
      expect(row.scale).toBeUndefined();
      expect(kindTransform(row)).toEqual({ transform: "none", status: "exact" });
      expect(metricAvailability(m, `system.load.${dd}`)).toBe("mapped");
    }
  });

  it("single-state CPU percents: utilization fraction * 100, applied by select.metric.transform (#56)", () => {
    for (const [dd, state] of [["idle", "idle"], ["iowait", "wait"], ["stolen", "steal"]] as const) {
      const row = get(`system.cpu.${dd}`);
      expect(row).toMatchObject({ otel: "system.cpu.utilization", labels: { state }, scale: 100, ddKind: "gauge", status: "approximate" });
      expect(row.note).toMatch(/Disabled by default in the receiver/);
      expect(metricAvailability(m, `system.cpu.${dd}`)).toBe("mapped");
    }
  });

  it("multi-state CPU percents are derived; guest has no equivalent", () => {
    expect(get("system.cpu.user").derived).toBe("100 * (system.cpu.utilization{state=user} + system.cpu.utilization{state=nice})");
    expect(get("system.cpu.system").derived).toMatch(/state=system.*state=interrupt.*state=softirq/);
    for (const k of ["system.cpu.user", "system.cpu.system", "system.io.util"]) expect(metricAvailability(m, k)).toBe("derived");
    expect(get("system.cpu.guest")).toMatchObject({ otel: null, status: "none" });
    expect(metricAvailability(m, "system.cpu.guest")).toBe("no_equivalent");
  });

  it("memory: MiB from bytes (scale 1/1048576), usable = Linux MemAvailable", () => {
    expect(get("system.mem.total")).toMatchObject({ otel: "system.memory.limit", scale: MIB, status: "exact" });
    expect(get("system.mem.usable")).toMatchObject({ otel: "system.linux.memory.available", scale: MIB });
    expect(get("system.mem.free")).toMatchObject({ otel: "system.memory.usage", labels: { state: "free" }, scale: MIB });
    for (const k of ["system.mem.total", "system.mem.usable"]) expect(get(k).note).toMatch(/Disabled by default in the receiver/);
    // Datadog used = Total - Free; the receiver's state=used subtracts buffers and cache too, so it is derived.
    expect(get("system.mem.used")).toMatchObject({ otel: null, derived: "(system.memory.limit - system.memory.usage{state=free}) / 1048576" });
  });

  it("network and disk counters: the check's sender.Rate -> rate() on the receiver counter (D-18)", () => {
    for (const [dd, dir] of [["bytes_rcvd", "receive"], ["bytes_sent", "transmit"]] as const) {
      const row = get(`system.net.${dd}`);
      expect(row).toMatchObject({ otel: "system.network.io", labels: { direction: dir }, ddKind: "rate", otelKind: "counter", status: "approximate" });
      expect(kindTransform(row)).toMatchObject({ transform: "rate", status: "bounded" });
      expect(metricAvailability(m, `system.net.${dd}`)).toBe("mapped");
    }
    expect(get("system.io.r_s")).toMatchObject({ otel: "system.disk.operations", labels: { direction: "read" }, ddKind: "rate" });
  });
});
