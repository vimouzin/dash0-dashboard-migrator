// Every rule id a certificate cites, and every finding code the report emits, must resolve in the T17 catalog
// (src/rules). This keeps the code and the rulebook from drifting apart (catalog axioms D6/D7/D10). A typo or an
// unregistered rule fails here instead of reaching a report as if it were known.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG } from "../../src/rules/index.js";
import { FINDING_CODES } from "../../src/ir/index.js";
import { migrate } from "../../src/pipeline/migrate.js";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Ids T5/T8 emit that are requested from T17 but not yet in the catalog (hub, Amir -> Michael). Each entry must be
 * removed once its row lands; the second test fails as a reminder when that happens.
 */
const PENDING_ROWS = new Set<string>([]);

describe("catalog conformance (fixtures, both modes)", async () => {
  const known = new Set<string>([
    ...CATALOG.map((r) => r.id),
    ...CATALOG.map((r) => (r as { findingCode?: string }).findingCode).filter((x): x is string => !!x),
    ...Object.keys(FINDING_CODES),
  ]);
  const runs = await Promise.all(
    (["dry-run", "none"] as const).map((mode) =>
      migrate({ ingest: { input: join(ROOT, "fixtures", "datadog") }, mappingsDir: join(ROOT, "mappings"), outDir: mkdtempSync(join(tmpdir(), "t8c-")), mode, version: "test" }),
    ),
  );
  const cited = new Map<string, string>();
  for (const r of runs) {
    for (const i of r.report.items) {
      for (const x of i.certificate.rules) cited.set(x, `${i.id} (rule)`);
      for (const f of i.findings) cited.set(f.code, `${i.id} (finding)`);
    }
    for (const f of r.report.findings) cited.set(f.code, `${f.itemId} (finding)`);
  }

  it("every cited rule id and finding code is in the catalog (or explicitly pending)", () => {
    const unknown = [...cited].filter(([id]) => !known.has(id) && !PENDING_ROWS.has(id)).map(([id, where]) => `${id} <- ${where}`);
    expect(unknown).toEqual([]);
  });

  it("pending rows are still missing (remove them from PENDING_ROWS once T17 adds them)", () => {
    expect([...PENDING_ROWS].filter((id) => known.has(id))).toEqual([]);
  });
});
