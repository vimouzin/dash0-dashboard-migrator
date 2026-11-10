import { describe, expect, it } from "vitest";
import { ddKindLookup, loadDdKinds, loadMappings, metricLookup } from "../../src/ir/index.js";
import { parseQuery } from "../../src/parse/index.js";
import { translateQuery } from "../../src/translate/query/index.js";

describe("metadata.csv kinds (mappings/datadog/_kinds.json)", () => {
  const kinds = loadDdKinds("mappings");
  const maps = loadMappings("mappings");

  it("loads the generated table", () => {
    expect(Object.keys(kinds).length).toBeGreaterThan(30000);
    expect(kinds["activemq.artemis.queue.messages_added"]).toBe("rate");
    expect(kinds["postgresql.archiver.archived_count"]).toBe("count");
    // metadata.csv declares some Datadog RATE submissions as gauges (D-18); curated tables correct those.
    expect(kinds["postgresql.rows_inserted"]).toBe("gauge");
    expect(kinds["nginx.net.request_per_s"]).toBe("rate");
  });

  it("curated entries win: no metadata kind for metrics in the curated tables", () => {
    const lookup = ddKindLookup(kinds, maps);
    expect(lookup("redis.net.commands")).toBeUndefined(); // curated in redisdb.yaml (with the D-18 rate fix)
    expect(lookup("activemq.artemis.queue.messages_added")).toBe("rate");
  });

  it("ambiguous metrics (different kinds in two integrations) are omitted", () => {
    expect(kinds["kubernetes_state.job.failed"]).toBeUndefined();
  });

  it("returns an empty table when the file is absent", () => {
    expect(loadDdKinds("does/not/exist")).toEqual({});
  });

  it("feeds T4: an unmapped Datadog RATE metric becomes rate() on `anchored` (dashboards)", () => {
    const p = parseQuery("sum:activemq.artemis.queue.messages_added{*}");
    if (!p.ok) throw new Error();
    const r = translateQuery(p.value, { metric: metricLookup(maps), ddKind: ddKindLookup(kinds, maps) });
    expect(r.promql).toBe('sum (rate({otel_metric_name="activemq.artemis.queue.messages_added"}[$__interval] anchored))');
    expect(r.rules).toContain("time.unmapped.counter.anchored");
  });
});
