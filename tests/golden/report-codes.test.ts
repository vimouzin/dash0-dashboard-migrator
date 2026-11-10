// Every reason/finding code in a report must resolve to a catalog row (a rule id, a rule's findingCode) or to FINDING_CODES.
// CONTRACT-003 §3.3 builds the report's `reasonCodes` explanations from exactly these, with no fallback, so a code with
// no row would show up in the UI with no explanation. This test is what catches it.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FINDING_CODES } from "../../src/ir/index.js";
import { migrate } from "../../src/pipeline/migrate.js";
import { CATALOG } from "../../src/rules/index.js";

const ROOT = join(import.meta.dirname, "..", "..");
const known = new Set<string>([...CATALOG.flatMap((r) => [r.id, r.findingCode ?? r.id]), ...Object.keys(FINDING_CODES)]);

interface Item {
  findings?: { code: string }[];
  reason_codes?: string[];
}
function codesOf(report: { findings?: { code: string }[]; items: unknown[] }): Map<string, number> {
  const seen = new Map<string, number>();
  const add = (c: string) => seen.set(c, (seen.get(c) ?? 0) + 1);
  for (const f of report.findings ?? []) add(f.code);
  for (const it of report.items as Item[]) {
    for (const f of it.findings ?? []) add(f.code);
    for (const c of it.reason_codes ?? []) add(c);
  }
  return seen;
}
const run = (input: string) => migrate({ ingest: { input }, mappingsDir: join(ROOT, "mappings"), outDir: mkdtempSync(join(tmpdir(), "codes-")), mode: "dry-run", version: "codes" });

describe("report codes resolve to the catalog", () => {
  it("fixtures: every code resolves (strict)", async () => {
    const r = await run(join(ROOT, "fixtures", "datadog"));
    const missing = [...codesOf(r.report as never)].filter(([c]) => !known.has(c)).map(([c, n]) => `${c} (${n})`);
    expect(missing).toEqual([]);
  });

  // The full corpus emits codes the fixtures do not. Codes with no catalog row yet are listed here on purpose:
  // when a row lands the second test fails until the code is removed from this list, so it only ever shrinks.
  const PENDING = new Set<string>([
    // empty since #16 and #30: every code in the full-corpus report resolves to a catalog row
  ]);
  const corpus = [process.env.DD_CORPUS_DIR, resolve(process.cwd(), "../../corpus/integrations-core-master"), resolve(process.cwd(), "../corpus/integrations-core-master")].filter((p): p is string => !!p).find((p) => existsSync(p));

  describe.skipIf(!corpus)("full integrations-core corpus (skipped when the corpus is not checked out)", () => {
    it("every code resolves, except the explicit pending list", async () => {
      const r = await run(corpus!);
      const unresolved = [...codesOf(r.report as never).keys()].filter((c) => !known.has(c));
      expect(unresolved.filter((c) => !PENDING.has(c)).sort(), "a NEW code with no catalog row").toEqual([]);
    }, 120_000);
    it("the pending list has no stale entries (remove a code once its catalog row exists)", () => {
      expect([...PENDING].filter((c) => known.has(c)).sort()).toEqual([]);
    });
  });
});
