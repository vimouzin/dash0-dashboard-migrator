#!/usr/bin/env node
// dd2dash0 CLI (T8; HOT: post a CONTRACT before changing flags).
// `dd2dash0` with no arguments runs the one guided flow (src/flow/run.ts). plan / review / apply / migrate stay as
// advanced commands for scripting.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configFromEnv } from "./targets/dash0/index.js";
import { migrate, overallOk } from "./pipeline/migrate.js";
import { summaryLines, writeReport } from "./report/index.js";
import { reportToEvents } from "./report/events.js";
import { ConfigError, loadConfig, resolveConfig, type Dd2dash0Config } from "./pipeline/config.js";
import { runPlan } from "./pipeline/plan.js";
import { runApply } from "./pipeline/apply.js";
import { terminalReview } from "./pipeline/review-terminal.js";
import { explain } from "./flow/explain.js";
import { guided, terminalIO } from "./flow/run.js";
import { outOf, tildify, Ui } from "./ui/style.js";
import { openBrowser } from "./flow/keys-web.js";
import { webBanner, webTerminal } from "./flow/web-term.js";
import { createInterface } from "node:readline/promises";

export const VERSION = "0.5.6";

/**
 * The mapping tables, first found wins:
 *   1. $DD2DASH0_MAPPINGS
 *   2. a mappings/ folder next to the executable (your own edited tables)
 *   3. the tables built into the release executable (scripts/release/build.sh embeds them; they are read in place
 *      from the executable's virtual file system, nothing is unpacked)
 *   4. the package's own mappings/ (running from source)
 */
export function defaultMappingsDir(): string {
  if (process.env.DD2DASH0_MAPPINGS) return resolve(process.env.DD2DASH0_MAPPINGS);
  const isTables = (dir: string) => existsSync(join(dir, "tags.yaml"));
  const besideExe = join(dirname(process.execPath), "mappings");
  if (isTables(besideExe)) return besideExe;
  const builtIn = join(import.meta.dirname, "mappings");
  if (isTables(builtIn)) return builtIn;
  return join(import.meta.dirname, "..", "mappings");
}

const USAGE = `dd2dash0 ${VERSION}: migrate Datadog dashboards and monitors to Dash0

Usage:
  dd2dash0              asks for your Datadog and Dash0 keys, migrates everything, prints a report

Options:
  --yes                 no prompts: keys from env, .env or the saved file; approve bounded panels and
                        translatable monitors
  --env <file>          read the keys from this file (any name; DATADOG_API_KEY, DASH0_TOKEN, … understood)
  --web                 run the whole migration in the browser, on a one-time page on this computer
  --browser             enter missing keys on a one-time local web page instead of the terminal
  --only <what>         dashboards | monitors
  --out <dir>           run directory (default ./dd2dash0-run/<timestamp>)
  --dry-run             translate and write the payloads and report, import nothing
  --input <dir>         read Datadog JSON exports from a folder instead of the API
  --version, --help

  dd2dash0 explain "<query>"   show one Datadog query going through the engine: the parse tree, the mapping
                               tables, the rules that fire, the PromQL and the exact claim

What it does:
  1. keys       finds DD_API_KEY, DD_APP_KEY, DD_SITE, DASH0_API_URL, DASH0_AUTH_TOKEN, DASH0_DATASET in the
                environment, ./.env or ~/.config/dd2dash0/.env (or --env <file>); offers env files it finds
                nearby; asks for missing ones (drag in a .env, paste, type, or --browser), checks them, offers to save them to ~/.config/dd2dash0/.env (0600)
  2. translate  every dashboard -> Perses, every query -> PromQL, every monitor -> a Dash0 check rule
  3. review     one question for all approximate panels, one per monitor; what can't be translated
                becomes a placeholder panel with the original query (nothing is dropped)
  4. import     into Dash0; new check rules start off, existing ones keep their on/off state
  5. verify     reads every item back from Dash0, checks the last hour of data against Datadog
  6. report     translated · landed · live · success %, plus <run>/report.html and report.md

Exit codes: 0 all good, 1 something failed (see report.md), 2 refused, 3 usage or key error.
Translation is deterministic: parsers, rules and mapping tables. No LLM is involved.

Advanced: dd2dash0 plan | review <plan> --terminal | apply <plan> --approved <review.json> | migrate  (see --help-advanced)`;

const USAGE_ADVANCED = `dd2dash0 ${VERSION} advanced commands

  dd2dash0 plan  (--input <dir> | --api) [--config dd2dash0.yaml] [--out plan] [--only ...]   translate, import nothing
  dd2dash0 review <plan dir> --terminal [--reviewer <name>] [--all]                         decide item by item
  dd2dash0 apply <plan dir> --approved <review.json> [--enable-rules] [--allow-pending] [--dry-run] [--skip-source-check]
  dd2dash0 migrate --from datadog (--input <dir> | --api) [--dry-run | --no-import] [--out <dir>] [--only ...]
                   [--enable-rules] [--mappings <dir>] [--channels <file>]                   one shot, no review

Guided flow, hidden options: --input <dir> (exported Datadog JSON/YAML instead of the API), --dry-run (write
payloads, import nothing, skip the live checks).`;

const GUIDED_FLAGS = new Set(["--yes", "-y", "--only", "--out", "--input", "--dry-run", "--browser", "--web", "--env"]);

export function main(argv: string[] = process.argv.slice(2)): number | Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "--help-advanced") {
    console.log(USAGE_ADVANCED);
    return 0;
  }
  if (cmd === "--version") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === undefined || GUIDED_FLAGS.has(cmd)) return runGuided(argv);
  if (cmd === "explain") {
    const q = rest.join(" ").trim();
    if (!q) {
      console.error('usage: dd2dash0 explain "<Datadog query>"   e.g. dd2dash0 explain "avg:redis.mem.used{env:prod} by {host}"');
      return EXIT.usage;
    }
    return explain({ query: q, mappingsDir: defaultMappingsDir(), ui: new Ui(outOf(process.stdout)), version: VERSION });
  }
  if (cmd === "plan") return runPlanCmd(rest);
  if (cmd === "review") return runReviewCmd(rest);
  if (cmd === "apply") return runApplyCmd(rest);
  if (cmd === "migrate") return runMigrate(rest);
  console.error(`unknown command: ${cmd} (try --help)`);
  return 3;
}

async function runGuided(args: string[]): Promise<number> {
  const r = readArgs(args.map((a) => (a === "-y" ? "--yes" : a)), ["--only", "--out", "--input", "--env"], ["--yes", "--dry-run", "--browser", "--web"]);
  if (typeof r === "string" || r._.length) {
    console.error(`${typeof r === "string" ? r : `unexpected argument ${r._[0]}`}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const only = r.v["--only"];
  if (only && only !== "dashboards" && only !== "monitors") {
    console.error("--only must be dashboards or monitors");
    return EXIT.usage;
  }
  const io = terminalIO();
  const ui = new Ui(outOf(process.stdout));
  const common = {
    yes: r.b.has("--yes"),
    ...(r.v["--input"] ? { input: r.v["--input"] } : {}),
    ...(only ? { only: only as "dashboards" | "monitors" } : {}),
    ...(r.v["--out"] ? { out: r.v["--out"] } : {}),
    ...(r.v["--env"] ? { envFile: r.v["--env"] } : {}),
    dryRun: r.b.has("--dry-run"),
    version: VERSION,
    mappingsDir: defaultMappingsDir(),
  };
  try {
    // First screen: where to work. Only when someone is at a real terminal and didn't already say (--yes, --web, --browser).
    const atTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
    let web = r.b.has("--web");
    let header = true;
    if (!web && atTerminal && !common.yes && !r.b.has("--browser")) {
      ui.header(VERSION, process.cwd());
      header = false;
      const where = await io.choose("Where do you want to work?", ["Here, in this terminal", "In the browser (the same tool, on a one-time page on this computer)"], 0);
      if (where === null) return EXIT.refused;
      web = where === 1;
      if (web) ui.line();
    }
    if (web) {
      io.close();
      const open = process.env.DD2DASH0_NO_OPEN ? () => {} : openBrowser;
      return await webTerminal({
        version: VERSION,
        cwd: tildify(process.cwd()),
        onReady: (url) => {
          for (const l of webBanner(url)) ui.line(l);
          open(url);
        },
        run: (s) => guided({ ...common, io: s.io, ui: new Ui(s.out, s.env), open: s.open, inBrowser: true }),
        onFinished: (code) => ui.line(`  ${ui.p.dim("⎿")} ${ui.p.dim(`finished (exit ${code}) · the page stays up until you close its tab`)}`),
      });
    }
    return await guided({ ...common, header, browser: r.b.has("--browser"), ui, io });
  } catch (e) {
    console.error(`dd2dash0: ${(e as Error).message}`);
    return EXIT.failed;
  } finally {
    io.close();
  }
}

interface Flags {
  from?: string;
  input?: string;
  api: boolean;
  dryRun: boolean;
  noImport: boolean;
  out: string;
  only?: "dashboards" | "monitors";
  enableRules: boolean;
  mappings: string;
  channels?: string;
}

export function parseFlags(args: string[]): Flags | string {
  const f: Flags = { api: false, dryRun: false, noImport: false, out: "out", enableRules: false, mappings: defaultMappingsDir() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      switch (a) {
        case "--from": f.from = val(); break;
        case "--input": f.input = val(); break;
        case "--api": f.api = true; break;
        case "--dry-run": f.dryRun = true; break;
        case "--no-import": f.noImport = true; break;
        case "--out": f.out = val(); break;
        case "--enable-rules": f.enableRules = true; break;
        case "--mappings": f.mappings = val(); break;
        case "--channels": f.channels = val(); break;
        case "--only": {
          const v = val();
          if (v !== "dashboards" && v !== "monitors") return "--only must be dashboards or monitors";
          f.only = v;
          break;
        }
        default: return `unknown option ${a}`;
      }
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (f.from !== "datadog") return "--from datadog is required (the only source so far)";
  if (!!f.input === f.api) return "pass exactly one of --input <dir> or --api";
  if (f.dryRun && f.noImport) return "--dry-run and --no-import are mutually exclusive";
  return f;
}

async function runMigrate(args: string[]): Promise<number> {
  const f = parseFlags(args);
  if (typeof f === "string") {
    console.error(`${f}\n\n${USAGE_ADVANCED}`);
    return 2;
  }
  const mode = f.noImport ? "none" : f.dryRun ? "dry-run" : "live";
  let dash0;
  if (mode === "live") {
    try {
      dash0 = configFromEnv();
    } catch (e) {
      console.error(`${(e as Error).message}\nUse --dry-run to translate without importing.`);
      return 2;
    }
  }
  try {
    const r = await migrate({
      ingest: { ...(f.input ? { input: resolve(f.input) } : { api: true }), ...(f.only ? { only: f.only } : {}) },
      source: f.input ? { kind: "folder", site: null, path: f.input } : { kind: "api", site: process.env.DD_SITE || "datadoghq.eu", path: null },
      mappingsDir: resolve(f.mappings),
      ...(f.channels ? { channelsFile: resolve(f.channels) } : {}),
      outDir: resolve(f.out),
      mode,
      enableRules: f.enableRules,
      ...(dash0 ? { dash0 } : {}),
      version: VERSION,
    });
    const files = writeReport(r.report, resolve(f.out));
    writeFileSync(join(resolve(f.out), "events.jsonl"), reportToEvents(r.report).map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const l of summaryLines(r.report, files)) console.log(l);
    if (r.manifest) {
      for (const x of r.manifest.results.filter((x) => x.errors.length)) console.error(`  ! ${x.kind} ${x.id}: ${x.errors.join("; ")}${x.traceId ? ` (traceId ${x.traceId})` : ""}`);
    }
    return overallOk(r) ? 0 : 1;
  } catch (e) {
    console.error(`dd2dash0: ${(e as Error).message}`);
    return 1;
  }
}

const EXIT = { ok: 0, failed: 1, refused: 2, usage: 3 } as const;

/** Reads `--name value` / `--flag` pairs; positional arguments are returned in `_`. */
function readArgs(args: string[], valued: string[], bools: string[]): { _: string[]; v: Record<string, string>; b: Set<string> } | string {
  const out = { _: [] as string[], v: {} as Record<string, string>, b: new Set<string>() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) return `${a} needs a value`;
      out.v[a] = v;
    } else if (bools.includes(a)) out.b.add(a);
    else if (a.startsWith("--")) return `unknown option ${a}`;
    else out._.push(a);
  }
  return out;
}

async function runPlanCmd(args: string[]): Promise<number> {
  const r = readArgs(args, ["--input", "--out", "--config", "--mappings", "--channels", "--only", "--from"], ["--api", "--enable-rules"]);
  if (typeof r === "string" || r._.length) {
    console.error(`${typeof r === "string" ? r : `unexpected argument ${r._[0]}`}\n\n${USAGE_ADVANCED}`);
    return EXIT.usage;
  }
  if (r.v["--from"] && r.v["--from"] !== "datadog") {
    console.error("--from datadog is the only source so far");
    return EXIT.usage;
  }
  const only = r.v["--only"];
  if (only && only !== "dashboards" && only !== "monitors") {
    console.error("--only must be dashboards or monitors");
    return EXIT.usage;
  }
  if (r.v["--input"] && r.b.has("--api")) {
    console.error("pass at most one of --input <dir> or --api");
    return EXIT.usage;
  }
  const flags: Dd2dash0Config = {
    ...(r.v["--input"] ? { source: { kind: "folder" as const, path: r.v["--input"] } } : r.b.has("--api") ? { source: { kind: "api" as const } } : {}),
    ...(r.v["--mappings"] ? { mappings: resolve(r.v["--mappings"]) } : {}),
    ...(r.v["--channels"] ? { channels: resolve(r.v["--channels"]) } : {}),
    ...(r.b.has("--enable-rules") ? { enableRules: true } : {}),
  };
  let config;
  try {
    const file = loadConfig(r.v["--config"]);
    config = resolveConfig(file.config, flags);
    if (!file.file && !flags.source) {
      console.error(`pass --input <dir> or --api (or a source in dd2dash0.yaml)\n\n${USAGE_ADVANCED}`);
      return EXIT.usage;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return EXIT.usage;
    }
    throw e;
  }
  const out = resolve(r.v["--out"] ?? "plan");
  try {
    const p = await runPlan({
      config,
      outDir: out,
      defaultMappingsDir: defaultMappingsDir(),
      ...(config.source.kind === "folder" ? { resolvedInput: resolve(config.source.path) } : {}),
      ...(only ? { only: only as "dashboards" | "monitors" } : {}),
      version: VERSION,
    });
    for (const l of summaryLines(p.result.report, p.files)) console.log(l);
    console.log(`  plan ${p.planHash.slice(0, 16)}  ->  next: review it (dd2dash0 review ${r.v["--out"] ?? "plan"}), then dd2dash0 apply ${r.v["--out"] ?? "plan"} --approved <review.json>`);
    return EXIT.ok;
  } catch (e) {
    console.error(`dd2dash0 plan: ${(e as Error).message}`);
    return EXIT.failed;
  }
}

async function runReviewCmd(args: string[]): Promise<number> {
  const r = readArgs(args, ["--reviewer"], ["--terminal", "--all"]);
  if (typeof r === "string" || r._.length !== 1) {
    console.error(`${typeof r === "string" ? r : "usage: dd2dash0 review <plan dir> --terminal"}\n\n${USAGE_ADVANCED}`);
    return EXIT.usage;
  }
  const planDir = resolve(r._[0]!);
  const reviewer = r.v["--reviewer"] ?? process.env.USER ?? "";
  // Read lines through the async iterator: it buffers input, so piped keystrokes aren't lost between prompts
  // (readline's question() drops lines that arrive while no question is pending).
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  try {
    await terminalReview(planDir, reviewer, {
      ask: async (prompt) => {
        process.stdout.write(prompt);
        const n = await lines.next();
        if (!process.stdin.isTTY && !n.done) process.stdout.write(`${n.value}\n`); // echo piped input
        return n.done ? null : n.value;
      },
      print: (line) => console.log(line),
    }, { all: r.b.has("--all") });
    return EXIT.ok;
  } catch (e) {
    console.error(`dd2dash0 review: ${(e as Error).message}`);
    return EXIT.refused;
  } finally {
    rl.close();
  }
}

async function runApplyCmd(args: string[]): Promise<number> {
  const r = readArgs(args, ["--approved"], ["--enable-rules", "--allow-pending", "--dry-run", "--skip-source-check"]);
  if (typeof r === "string" || r._.length !== 1 || !r.v["--approved"]) {
    console.error(`${typeof r === "string" ? r : "usage: dd2dash0 apply <plan dir> --approved <review.json>"}\n\n${USAGE_ADVANCED}`);
    return EXIT.usage;
  }
  const dryRun = r.b.has("--dry-run");
  let dash0;
  if (!dryRun) {
    try {
      dash0 = configFromEnv();
    } catch (e) {
      console.error(`${(e as Error).message}\nUse --dry-run to write the approved payloads without importing.`);
      return EXIT.usage;
    }
  }
  try {
    const o = await runApply({
      planDir: resolve(r._[0]!),
      reviewFile: resolve(r.v["--approved"]),
      enableRules: r.b.has("--enable-rules"),
      allowPending: r.b.has("--allow-pending"),
      dryRun,
      skipSourceCheck: r.b.has("--skip-source-check"),
      ...(dash0 ? { dash0 } : {}),
    });
    for (const w of o.warnings) console.error(`  warning: ${w}`);
    if (o.kind === "refused") {
      console.error("dd2dash0 apply: refused");
      for (const x of o.reasons) console.error(`  ${x}`);
      return EXIT.refused;
    }
    const m = o.manifest.summary;
    console.log(`dd2dash0 apply: ${dryRun ? "dry run, nothing imported" : "imported"}: ${o.imported.dashboards} dashboard(s), ${o.imported.rules} check rule(s)`);
    console.log(`  ${dryRun ? `written ${m["dry-run"]}` : `imported ${m.imported}, read back identical ${m.readBackMatch}`}, failed ${m.failed}, rejected by preflight ${m["rejected-preflight"]}`);
    if (o.placeholders.length) console.log(`  flagged in review -> placeholder: ${o.placeholders.length} panel(s)`);
    if (o.skippedAlerts.length) console.log(`  check rules not imported (flagged or not approved): ${o.skippedAlerts.join(", ")}`);
    for (const x of o.manifest.results.filter((x) => x.errors.length)) console.error(`  ! ${x.kind} ${x.id}: ${x.errors.join("; ")}${x.traceId ? ` (traceId ${x.traceId})` : ""}`);
    console.log(`  report: ${o.reportFile}${o.ok ? "" : "  (re-run apply to retry what failed; imports are idempotent)"}`);
    return o.ok ? EXIT.ok : EXIT.failed;
  } catch (e) {
    console.error(`dd2dash0 apply: ${(e as Error).message}`);
    return EXIT.failed;
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("cli.ts") || entry.endsWith("cli.js")) {
  void Promise.resolve(main()).then((code) => {
    process.exitCode = code;
  });
}
