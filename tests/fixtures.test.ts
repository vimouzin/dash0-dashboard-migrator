// Smoke tests: the CLI loads and every fixture is parseable in the shape the ingest expects.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";

const dir = (k: string) => join(import.meta.dirname, "..", "fixtures", "datadog", k);
const load = (k: string, f: string) => JSON.parse(readFileSync(join(dir(k), f), "utf8"));

describe("cli", () => {
  it("prints help", () => expect(main(["--help"])).toBe(0));
});

describe("fixtures", () => {
  it.each(readdirSync(dir("dashboards")))("dashboard %s has widgets", (f) => {
    const d = load("dashboards", f);
    expect(Array.isArray(d.widgets)).toBe(true);
    expect(d.widgets.length).toBeGreaterThan(0);
  });
  it.each(readdirSync(dir("monitors")))("monitor %s has a query", (f) => {
    const m = load("monitors", f);
    const def = m.definition ?? m; // integrations-core wraps monitors in {version, definition}
    expect(typeof def.query).toBe("string");
  });
});
