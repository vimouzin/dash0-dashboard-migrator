// Linking keys from files: other key names in ./.env and the environment, env files found nearby, --env <file>.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findEnvFiles, knownKeys, type KeyIO } from "../../src/flow/keys.js";
import { guided } from "../../src/flow/run.js";

const ROOT = join(import.meta.dirname, "..", "..");
const dir = (p: string) => mkdtempSync(join(tmpdir(), `dd2dash0-files-${p}-`));
const ENV = "DATADOG_API_KEY=dd-file-api-key\nDATADOG_APP_KEY=dd-file-app-key\nDATADOG_SITE=datadoghq.eu\n";

function io(answers: (string | number)[]): KeyIO & { choose: (q: string, o: string[]) => Promise<number | null>; out: string[]; questions: { q: string; options: string[] }[] } {
  const out: string[] = [];
  const questions: { q: string; options: string[] }[] = [];
  const next = async () => (answers.length ? String(answers.shift()) : null);
  return {
    out,
    questions,
    ask: next,
    askSecret: next,
    print: (l) => out.push(l),
    choose: async (q, options) => {
      questions.push({ q, options });
      return answers.length ? Number(answers.shift()) : null;
    },
  };
}

// Datadog accepts only the keys from the file; nothing else is ever called (the run stops at the keys step).
const fetchFn = (async (url: string | URL, init?: RequestInit) => {
  const h = (init?.headers ?? {}) as Record<string, string>;
  const path = new URL(String(url)).pathname;
  const good = h["DD-API-KEY"] === "dd-file-api-key" && (path === "/api/v1/validate" || h["DD-APPLICATION-KEY"] === "dd-file-app-key");
  if (path === "/api/v1/validate" || path.startsWith("/api/v1/dashboard")) return new Response(JSON.stringify(good ? { valid: true, dashboards: [] } : { errors: ["Forbidden"] }), { status: good ? 200 : 403 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

describe("keys in files", () => {
  it("./.env and the environment understand the other common names too", () => {
    const cwd = dir("cwd");
    writeFileSync(join(cwd, ".env"), "DATADOG_API_KEY=from-file\nDASH0_TOKEN=tok\n");
    const { keys } = knownKeys({ DD_APPLICATION_KEY: "from-env" }, cwd, dir("home"));
    expect(keys).toMatchObject({ DD_API_KEY: "from-file", DD_APP_KEY: "from-env", DASH0_AUTH_TOKEN: "tok" });
    // Our own name wins when both are set.
    expect(knownKeys({ DD_API_KEY: "ours", DATADOG_API_KEY: "theirs" }, cwd, dir("home")).keys.DD_API_KEY).toBe("ours");
  });

  it("finds env-looking files with keys in the current folder and ~/Downloads, best first", () => {
    const cwd = dir("cwd");
    const home = dir("home");
    mkdirSync(join(home, "Downloads"));
    writeFileSync(join(cwd, ".env"), ENV); // read anyway, never offered
    writeFileSync(join(cwd, "prod.env"), "DD_API_KEY=a\n");
    writeFileSync(join(cwd, "notes.txt"), ENV); // not an env-looking name
    writeFileSync(join(cwd, ".env.example"), "DD_API_KEY=\nDD_APP_KEY=\n"); // names only, no values
    writeFileSync(join(cwd, "site.env"), "DD_SITE=datadoghq.eu\n"); // no secret in it
    writeFileSync(join(home, "Downloads", "env.example copy.txt"), ENV);
    const found = findEnvFiles(cwd, home);
    expect(found.map((f) => f.path)).toEqual([join(home, "Downloads", "env.example copy.txt"), join(cwd, "prod.env")]);
    expect(found[0]!.names).toEqual(["DD_SITE", "DD_API_KEY", "DD_APP_KEY"]);
  });

  it("offers a file found nearby first; picking it links the keys and checks them", async () => {
    const cwd = dir("cwd");
    const home = dir("home");
    mkdirSync(join(home, "Downloads"));
    writeFileSync(join(home, "Downloads", "env.example copy.txt"), ENV);
    const t = io([0]); // Use ~/Downloads/env.example copy.txt; then the run stops (no keys for Dash0 are needed in a dry run)
    const code = await guided({ yes: false, dryRun: true, out: join(cwd, "run"), version: "t", mappingsDir: join(ROOT, "mappings"), io: t, env: {}, cwd, home, fetch: fetchFn, open: () => {} });
    expect(t.questions[0]!.options[0]).toContain("env.example copy.txt");
    expect(t.out.join("\n")).toMatch(/found 3 keys in .*env\.example copy\.txt/);
    expect(t.out.join("\n")).toMatch(/Datadog .*✓/);
    expect(t.out.join("\n")).not.toContain("dd-file-api-key");
    expect(typeof code).toBe("number");
  });

  it("--env <file> reads any file; a missing file is a usage error", async () => {
    const cwd = dir("cwd");
    const home = dir("home");
    writeFileSync(join(cwd, "my keys.txt"), ENV);
    const t = io([]);
    await guided({ yes: true, dryRun: true, envFile: "my keys.txt", out: join(cwd, "run"), version: "t", mappingsDir: join(ROOT, "mappings"), io: t, env: {}, cwd, home, fetch: fetchFn, open: () => {} });
    expect(t.out.join("\n")).toMatch(/found 3 keys in .*my keys\.txt/);
    expect(t.out.join("\n")).toMatch(/Datadog .*✓/);

    const t2 = io([]);
    expect(await guided({ yes: true, dryRun: true, envFile: "nope.env", version: "t", mappingsDir: join(ROOT, "mappings"), io: t2, env: {}, cwd, home, fetch: fetchFn })).toBe(3);
    expect(t2.out.join("\n")).toContain("--env nope.env: no such file");
  });

  it("under --yes it doesn't use a nearby file on its own, but says how", async () => {
    const cwd = dir("cwd");
    writeFileSync(join(cwd, "datadog.env"), ENV);
    const t = io([]);
    expect(await guided({ yes: true, dryRun: true, version: "t", mappingsDir: join(ROOT, "mappings"), io: t, env: {}, cwd, home: dir("home"), fetch: fetchFn })).toBe(3);
    expect(t.out.join("\n")).toMatch(/add --env ".*datadog\.env" to use them/);
  });
});
