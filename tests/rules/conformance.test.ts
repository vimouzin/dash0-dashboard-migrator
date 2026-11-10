// The scattered rule tables point at the catalog: T4's RULES / ASSUMPTIONS must equal the catalog's T4 slice.
// Runs against src/translate/query/rules.ts when it exists (PR #3); skipped before that.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSUMPTIONS, ASSUMPTIONS_T4, RULES_T12, RULES_T4, T12_ASSUMPTION_IDS, T12_TABLE_IDS, T4_ASSUMPTION_IDS, T4_TABLE_IDS, rule } from "../../src/rules/index.js";
import { renderMarkdown } from "../../src/rules/render.js";

const t4Path = fileURLToPath(new URL("../../src/translate/query/rules.ts", import.meta.url));
const t12Path = fileURLToPath(new URL("../../src/translate/logs/index.ts", import.meta.url));
const docPath = fileURLToPath(new URL("../../docs/rules.md", import.meta.url));

describe("T4 rule table ↔ catalog", () => {
  it("the catalog's T4 slice has every T4 id, owned by T4 and implemented", () => {
    for (const id of T4_TABLE_IDS) {
      const r = rule(id);
      expect(r.owner, id).toBe("T4");
      expect(r.state, id).toBe("implemented");
    }
  });

  it.skipIf(!existsSync(t4Path))("src/translate/query/rules.ts matches the catalog id for id", async () => {
    const t4 = (await import(t4Path)) as { RULES: Record<string, { status: string; assumptions: string[] }>; ASSUMPTIONS: Record<string, string> };
    expect(Object.keys(t4.RULES)).toEqual([...T4_TABLE_IDS]);
    for (const [id, r] of Object.entries(t4.RULES)) {
      const c = RULES_T4[id as keyof typeof RULES_T4];
      expect(r.status, id).toBe(c.status);
      expect([...r.assumptions].sort(), id).toEqual([...c.assumptions].sort());
    }
    expect(t4.ASSUMPTIONS).toEqual(ASSUMPTIONS_T4);
  });
});

describe("T12 log rule table ↔ catalog", () => {
  it("the catalog's T12 slice has every T12 id, owned by T12 and implemented", () => {
    for (const id of T12_TABLE_IDS) {
      const r = rule(id);
      expect(r.owner, id).toBe("T12");
      expect(r.state, id).toBe("implemented");
    }
  });

  it.skipIf(!existsSync(t12Path))("src/translate/logs LOG_RULES matches the catalog id for id", async () => {
    const t12 = (await import(t12Path)) as { LOG_RULES: Record<string, { status: string; assumptions: string[] }>; LOG_ASSUMPTIONS: Record<string, string> };
    expect(Object.keys(t12.LOG_RULES)).toEqual([...T12_TABLE_IDS]);
    for (const [id, r] of Object.entries(t12.LOG_RULES)) {
      const c = RULES_T12[id as keyof typeof RULES_T12];
      expect(r.status, id).toBe(c.status);
      expect([...r.assumptions].sort(), id).toEqual([...c.assumptions].sort());
    }
    expect(Object.keys(t12.LOG_ASSUMPTIONS)).toEqual([...T12_ASSUMPTION_IDS]);
    // Ids shared with T4 keep T4's text in the catalog; the log-only ones must match T12 word for word.
    const shared = new Set<string>(T4_ASSUMPTION_IDS);
    for (const [id, text] of Object.entries(t12.LOG_ASSUMPTIONS)) if (!shared.has(id)) expect(text, id).toBe(ASSUMPTIONS[id as keyof typeof ASSUMPTIONS]);
  });
});

describe("docs/rules.md", () => {
  it("is generated from the catalog and up to date", () => {
    expect(renderMarkdown()).toBe(renderMarkdown());
    expect(existsSync(docPath)).toBe(true);
    expect(readFileSync(docPath, "utf8"), "run: npx tsx src/rules/write-doc.ts").toBe(renderMarkdown());
  });
});
