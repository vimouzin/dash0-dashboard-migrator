// One version everywhere: what `dd2dash0 --version` prints must match package.json (the release workflow also
// refuses a tag that differs from both).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/cli.js";

describe("version", () => {
  it("src/cli.ts VERSION equals package.json version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
