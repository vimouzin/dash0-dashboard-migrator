// Parse coverage over every distinct metric query in DataDog/integrations-core.
// Input: the JSONL from `python scripts/survey_corpus.py <corpus> --dump-queries corpus/queries.jsonl`
// in the dash0-team workspace. Set DD_QUERY_CORPUS to point elsewhere; skipped if the file is absent.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatParseError, parseMonitorQuery, parseQueryList } from "../../src/parse/index.js";

const candidates = [
  process.env.DD_QUERY_CORPUS,
  resolve(process.cwd(), "../../corpus/queries.jsonl"), // workspace/tasks/<slug>
  resolve(process.cwd(), "../corpus/queries.jsonl"), // workspace/migrator
].filter((p): p is string => !!p);
const file = candidates.find((p) => existsSync(p));

interface Row {
  query: string;
  kind: "formula" | "legacy_q" | "monitor";
}

/** Floor for the share of corpus queries that must parse. Raise it as coverage improves. */
const MIN_COVERAGE = 1;

describe.skipIf(!file)("integrations-core corpus", () => {
  it(`parses at least ${MIN_COVERAGE * 100}% of distinct queries`, () => {
    const rows: Row[] = readFileSync(file!, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row);
    const failures: string[] = [];
    for (const r of rows) {
      const res = r.kind === "monitor" ? parseMonitorQuery(r.query) : parseQueryList(r.query);
      if (!res.ok) failures.push(`[${r.kind}] ${formatParseError(res.error)}`);
    }
    const coverage = 1 - failures.length / rows.length;
    console.log(`corpus: ${rows.length - failures.length}/${rows.length} parsed (${(coverage * 100).toFixed(2)}%)`);
    if (failures.length) console.log(failures.slice(0, 40).join("\n"));
    expect(coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
  });
});
