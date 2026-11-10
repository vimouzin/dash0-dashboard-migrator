// Item ids from a folder export decide the Dash0 target (dashboard origin, check-rule UUID), so two items must never
// share one. DataDog/integrations-core has 71 files named overview.json and none carries an id.
import { describe, expect, it } from "vitest";
import { folderIds } from "../../src/sources/datadog/ingest.js";

describe("folderIds", () => {
  it("keeps flat ids, names nested files by their folder, and never lets two items of a kind share an id", () => {
    const r = folderIds([
      { rel: "dashboards/redisdb__overview.json", kind: "dashboard" },
      { rel: "redisdb/assets/dashboards/overview.json", kind: "dashboard" },
      { rel: "nginx/assets/dashboards/overview.json", kind: "dashboard" },
      { rel: "nginx/assets/monitors/overview.json", kind: "monitor" },
      { rel: "a/b.json", kind: "dashboard", exportId: "abc-123" },
    ]);
    expect(r[0]).toEqual({ id: "redisdb__overview" }); // unchanged for the flat fixtures layout
    expect(r[1]).toEqual({ id: "redisdb__assets__dashboards__overview", clash: "redisdb__overview" });
    expect(r[2]).toEqual({ id: "nginx__overview" });
    expect(r[3]).toEqual({ id: "nginx__overview" }); // a monitor is a different namespace
    expect(r[4]).toEqual({ id: "abc-123" }); // the export's own id wins
  });
});
