// T9: golden translations of the pinned integrations-core fixtures (postgres, redis, nginx).
//
// One golden file per source file in tests/golden/data/, holding for every panel/alert the translation's MEANING:
// status, PromQL, applied rule ids, assumptions and finding codes. Layout and Dash0 payload bytes are deliberately
// not part of it (other tests own those), so unrelated layout work does not churn the goldens.
//
// A failing golden is a decision, not noise: either the translator regressed, or the change is intended. To accept an
// intended change run
//     UPDATE_GOLDEN=1 npx vitest run tests/golden
// then review `git diff tests/golden/data` line by line and say in the PR that the goldens changed and why.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/pipeline/migrate.js";

const ROOT = join(import.meta.dirname, "..", "..");
const DATA = join(import.meta.dirname, "data");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

interface RawItem {
  id: string;
  kind: "panel" | "alert" | "group";
  title: string;
  dashboard: string;
  widget_type: string;
  status: string;
  promql: string[];
  findings: { status: string; code: string }[];
  certificate: { rules: string[]; assumptions: string[] };
}

export interface GoldenItem {
  id: string;
  kind: string;
  title: string;
  widget_type: string;
  status: string;
  promql: string[];
  rules: string[];
  assumptions: string[];
  /** "<status> <code>", unique, sorted. */
  findings: string[];
}

export function project(i: RawItem): GoldenItem {
  return {
    id: i.id,
    kind: i.kind,
    title: i.title,
    widget_type: i.widget_type,
    status: i.status,
    promql: i.promql,
    rules: i.certificate.rules,
    assumptions: i.certificate.assumptions,
    findings: [...new Set(i.findings.map((f) => `${f.status} ${f.code}`))].sort(),
  };
}

/**
 * Golden file name: the SOURCE dashboard id (panels) or the monitor id (alerts). Not the title: two dashboards can share a
 * title, and their goldens must not merge into one file.
 */
export function slug(i: Pick<RawItem, "kind" | "id">): string {
  if (i.kind === "alert") return i.id.replace(/^dd-monitor-/, "monitor-");
  return i.id.split("/")[0]!.replace(/^dd-dash-/, "dashboard-").replace(/[^A-Za-z0-9_.-]+/g, "-");
}

describe("golden translations of the pinned fixtures", async () => {
  const run = await migrate({
    ingest: { input: join(ROOT, "fixtures", "datadog") },
    mappingsDir: join(ROOT, "mappings"),
    outDir: mkdtempSync(join(tmpdir(), "golden-")),
    mode: "dry-run",
    version: "golden",
  });
  const actual = new Map<string, GoldenItem[]>();
  for (const raw of run.report.items as unknown as RawItem[]) {
    if (raw.kind === "group") continue; // structure only
    const s = slug(raw);
    actual.set(s, [...(actual.get(s) ?? []), project(raw)]);
  }

  if (UPDATE) {
    mkdirSync(DATA, { recursive: true });
    for (const [s, items] of actual) writeFileSync(join(DATA, `${s}.json`), JSON.stringify(items, null, 2) + "\n");
  }

  it("goldens are keyed by source id: two dashboards with the same title do not share a file", () => {
    const a = { kind: "panel" as const, id: "dd-dash-abc-123/w-1" };
    const b = { kind: "panel" as const, id: "dd-dash-def-456/w-1" };
    expect(slug(a)).toBe("dashboard-abc-123");
    expect(slug(b)).not.toBe(slug(a));
    expect(slug({ kind: "alert", id: "dd-monitor-redisdb__high_mem" })).toBe("monitor-redisdb__high_mem");
  });

  it("every fixture produced items", () => {
    expect([...actual.keys()].length).toBeGreaterThanOrEqual(10);
  });

  for (const [s, items] of [...actual].sort((a, b) => a[0].localeCompare(b[0]))) {
    it(`${s}: ${items.length} items match the golden file`, () => {
      const file = join(DATA, `${s}.json`);
      expect(existsSync(file), `no golden file for ${s}: run UPDATE_GOLDEN=1 npx vitest run tests/golden and review the new file`).toBe(true);
      expect(items).toEqual(JSON.parse(readFileSync(file, "utf8")));
    });
  }

  it("no stale golden files (delete the golden when its fixture goes)", () => {
    const files = existsSync(DATA) ? readdirSync(DATA).filter((f) => f.endsWith(".json")) : [];
    expect(files.filter((f) => !actual.has(f.replace(/\.json$/, ""))).sort()).toEqual([]);
  });

  it("an item is never silently dropped: every non-exact item has a finding or a rule that says why", () => {
    for (const items of actual.values())
      for (const i of items) if (i.status !== "exact") expect(i.findings.length + i.rules.length, i.id).toBeGreaterThan(0);
  });

  it("manual and unsupported items emit no PromQL", () => {
    for (const items of actual.values()) for (const i of items) if (i.status === "manual" || i.status === "unsupported") expect(i.promql, i.id).toEqual([]);
  });
});
