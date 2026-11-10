// Logic gates for the mapping tables (plan 09 §3): every row must be true to its pinned sources.
// Receiver facts come from the GENERATED mappings/datadog/_receivers.json (dash0-team scripts/build-receiver-facts.mjs,
// from the receiver metadata.yaml files pinned in docs/research/sources/). Datadog kinds come from _kinds.json.
// These are the checks a reviewer does by hand (Ali's review of #34), made mechanical: they run on every mapping PR,
// hand-written or from tools/improve.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { kindTransform, loadMappings } from "../../src/ir/index.js";

const root = join(import.meta.dirname, "..", "..");
const ddDir = join(root, "mappings", "datadog");
const facts = JSON.parse(readFileSync(join(ddDir, "_receivers.json"), "utf8")) as {
  receivers: Record<string, { source: string; metrics: Record<string, { kind: string; unit: string | null; enabledByDefault: boolean; attributes: Record<string, string[] | null> }> }>;
};
const ddKinds = (JSON.parse(readFileSync(join(ddDir, "_kinds.json"), "utf8")) as { kinds: Record<string, string> }).kinds;
const m = loadMappings(join(root, "mappings"));

type Row = { otel: string | null; labels?: Record<string, string>; ddKind: string; otelKind: string | null; unit?: string; status: string; derived?: string; note?: string };
const tables = readdirSync(ddDir)
  .filter((f) => f.endsWith(".yaml"))
  .sort()
  .map((f) => {
    const doc = parse(readFileSync(join(ddDir, f), "utf8")) as { integration: string; metrics: Record<string, Row> };
    return { file: f, integration: doc.integration, rows: Object.entries(doc.metrics ?? {}) };
  });

/** Every violation as "file metric: gate: why". Known ones are listed in KNOWN and must only shrink. */
function violations(): string[] {
  const out: string[] = [];
  for (const t of tables) {
    const rec = facts.receivers[t.integration];
    if (!rec) continue; // no pinned receiver facts for this integration yet (reported by its own test below)
    for (const [dd, row] of t.rows) {
      const v = (gate: string, why: string) => out.push(`${t.file} ${dd}: ${gate}: ${why}`);
      const names = row.otel ? [row.otel] : (row.derived?.match(/[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+/g) ?? []);
      for (const n of names) if (!rec.metrics[n]) v("L1 name-exists", `${n} is not a metric of the receiver`);
      if (!row.otel) continue;
      const f = rec.metrics[row.otel];
      if (!f) continue;
      if (row.otelKind !== f.kind) v("L2 kind-agrees", `otelKind ${row.otelKind} but the receiver emits a ${f.kind}`);
      if (row.unit !== undefined && row.unit !== f.unit) v("L3 unit-agrees", `unit ${row.unit} but the receiver says ${f.unit}`);
      for (const [k, val] of Object.entries(row.labels ?? {})) {
        if (!(k in f.attributes)) v("L4 labels-valid", `label ${k} is not an attribute of ${row.otel} (has: ${Object.keys(f.attributes).join(", ") || "none"})`);
        else if (f.attributes[k] && !f.attributes[k]!.includes(val)) v("L4 labels-valid", `${k}=${val} is not in the enum ${f.attributes[k]!.join("|")}`);
      }
      const declared = ddKinds[dd];
      if (declared && declared !== row.ddKind && !/AgentCheck|check (submits|source)|\bcheck:|RATE_KEYS|constants\.py/i.test(row.note ?? ""))
        v("L5 ddkind-agrees", `ddKind ${row.ddKind} but metadata.csv says ${declared}, and the note doesn't cite the check source`);
      if (!f.enabledByDefault && !/disabled by default|default-off|enabled: ?false|not enabled by default/i.test(row.note ?? ""))
        v("L6 default-off-declared", `${row.otel} is disabled by default in the receiver, and the note doesn't say so`);
      if (row.status === "exact") {
        const k = kindTransform(m.metrics.get(dd)!);
        if (k.transform !== "none" || k.status !== "exact") v("L7 status-follows-logic", `status exact, but the kind change needs ${k.transform} (${k.status})`);
      }
    }
  }
  return out.sort();
}

// Violations that existed when the gates were introduced, each with an owner to fix it. This list may only shrink:
// a NEW violation fails the test, and a fixed one must be removed from here.
const KNOWN = new Set<string>([]);

describe("mapping logic gates (plan 09 §3)", () => {
  const found = violations();
  if (process.env.SHOW_VIOLATIONS) console.log(["VIOLATIONS", ...found, "END"].join("\n"));

  it("every mapped row is true to the pinned receiver metadata and check source (L1-L7)", () => {
    expect(found.filter((x) => !KNOWN.has(x)), "new violations").toEqual([]);
  });

  it("the known-violations list has no stale entries", () => {
    expect([...KNOWN].filter((x) => !found.includes(x))).toEqual([]);
  });

  it("every integration with a mapping table has pinned receiver facts", () => {
    expect(tables.map((t) => t.integration).filter((i) => !facts.receivers[i])).toEqual([]);
  });

  it("catches what it should: a wrong name, kind, unit, label and an undeclared default-off metric", () => {
    const rec = facts.receivers.postgresql!;
    expect(rec.metrics["postgresql.tup_inserted"]).toMatchObject({ kind: "counter", enabledByDefault: false });
    expect(rec.metrics["postgresql.rows"]!.attributes.state).toEqual(["dead", "live"]);
    expect(rec.metrics["postgresql.bgwriter.checkpoint.count"]!.attributes.type).toEqual(["requested", "scheduled"]);
    expect(rec.metrics["postgresql.made_up"]).toBeUndefined();
  });
});
