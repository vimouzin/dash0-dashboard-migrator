// Postgres and NGINX mapping tables (Plan 07 item 4): every row cites its evidence, and the kind rules hold.
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
const rows = (prefix: string) => [...m.metrics].filter(([k]) => k.startsWith(prefix));

describe("postgresql mapping table", () => {
  it("lives in postgresql.yaml and every row cites metadata.csv and the receiver metadata.yaml", () => {
    expect(rows("postgresql.").length).toBe(21);
    for (const [k, row] of rows("postgresql.")) {
      expect(m.origin.get(k), k).toMatch(/postgresql\.yaml$/);
      expect(row.note, k).toMatch(/metadata\.csv.*(metadata\.yaml|Receiver)/s);
    }
  });

  it("exact rows: same quantity and unit, value used as is", () => {
    for (const k of ["postgresql.max_connections", "postgresql.total_size"]) {
      expect(get(k).status).toBe("exact");
      expect(kindTransform(get(k))).toEqual({ transform: "none", status: "exact" });
      expect(metricAvailability(m, k)).toBe("mapped");
    }
  });

  it("per-second rates (the check's AgentCheck.rate) map to the cumulative counter: ddKind rate, approximate", () => {
    const rates = ["rows_inserted", "rows_updated", "rows_deleted", "rows_fetched", "rows_returned", "rows_hot_updated", "index_scans", "seq_scans", "temp_bytes", "function.calls"];
    for (const n of rates) {
      const row = get(`postgresql.${n}`);
      expect(row, n).toMatchObject({ ddKind: "rate", otelKind: "counter", status: "approximate" });
      expect(kindTransform(row).status, n).not.toBe("manual");
    }
    // metadata.csv calls function.calls a gauge; the check submits it with AgentCheck.rate, and the check wins.
    expect(get("postgresql.function.calls").note).toMatch(/AgentCheck\.rate/);
  });

  it("row states and operations select a series of a shared receiver metric", () => {
    expect(get("postgresql.live_rows")).toMatchObject({ otel: "postgresql.rows", labels: { state: "live" } });
    expect(get("postgresql.dead_rows")).toMatchObject({ otel: "postgresql.rows", labels: { state: "dead" } });
    expect(get("postgresql.rows_hot_updated")).toMatchObject({ otel: "postgresql.operations", labels: { operation: "hot_upd" } });
  });

  it("no equivalent and derived rows fail closed; count rows take increase() (T4c)", () => {
    for (const k of ["postgresql.replication_delay", "postgresql.replication_delay_bytes"]) expect(metricAvailability(m, k)).toBe("no_equivalent");
    expect(get("postgresql.percent_usage_connections")).toMatchObject({ otel: null, derived: "postgresql.backends / postgresql.connection.max" });
    expect(kindTransform(get("postgresql.percent_usage_connections")).status).toBe("manual");
    // count -> counter: increase() over the bucket, bounded (maths.md T4c); no longer fails closed.
    expect(kindTransform(get("postgresql.bgwriter.checkpoints_timed"))).toMatchObject({ transform: "increase", status: "bounded" });
    expect(m.metrics.has("postgresql.deadlocks.count")).toBe(false);
  });
});

describe("nginx mapping table", () => {
  it("lives in nginx.yaml and every row cites metadata.csv and the receiver metadata.yaml", () => {
    expect(rows("nginx.").length).toBe(6);
    for (const [k, row] of rows("nginx.")) {
      expect(m.origin.get(k), k).toMatch(/nginx\.yaml$/);
      expect(row.note, k).toMatch(/metadata\.csv.*metadata\.yaml/s);
    }
  });

  it("stub_status connection gauges are exact: one state of nginx.connections_current each", () => {
    for (const [dd, state] of [["connections", "active"], ["reading", "reading"], ["writing", "writing"], ["waiting", "waiting"]] as const) {
      const row = get(`nginx.net.${dd}`);
      expect(row).toMatchObject({ otel: "nginx.connections_current", labels: { state }, ddKind: "gauge", status: "exact" });
      expect(kindTransform(row)).toEqual({ transform: "none", status: "exact" });
    }
  });

  it("request rate -> rate() on nginx.requests; dropped connections are derived (accepted - handled)", () => {
    expect(get("nginx.net.request_per_s")).toMatchObject({ otel: "nginx.requests", ddKind: "rate", otelKind: "counter", status: "approximate" });
    expect(get("nginx.net.conn_dropped_per_s")).toMatchObject({ otel: null, derived: "nginx.connections_accepted - nginx.connections_handled" });
  });
});
