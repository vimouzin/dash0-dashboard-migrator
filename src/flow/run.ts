// `dd2dash0` with no arguments: the one guided flow.
//   keys -> plan (dry run) -> batched review -> apply (rules disabled) -> verify (read-back + live data) -> report
// Every step reuses the existing gated pipeline (plan.lock, review.json, apply's refusals); this file only chains
// them and draws the terminal UI (src/ui/style.ts).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Report } from "../report/types.js";
import { runApply } from "../pipeline/apply.js";
import { resolveConfig } from "../pipeline/config.js";
import { runPlan } from "../pipeline/plan.js";
import { importAll, type PrometheusAlertRule } from "../targets/dash0/index.js";
import { bar, box, link, tildify, Ui, type Out } from "../ui/style.js";
import { coverageHeadline, pct1, type QueryCoverage } from "../report/query-coverage.js";
import { configEnvPath, displayPath, findEnvFiles, KeyError, KEYS, keysFromText, knownKeys, LABELS, resolveKeys, saveDotEnv, type KeyIO, type KeyName, type Keys } from "./keys.js";
import { openBrowser, webKeys } from "./keys-web.js";
import { batchedReview } from "./review.js";
import { decisionsOf, rowsOf, scoreOf, writeRunReport, type RunFacts, type Score } from "./score.js";
import type { AskBlock, Choose } from "./tty.js";
import { verifyLive } from "./verify.js";

export const EXIT = { ok: 0, failed: 1, refused: 2, usage: 3 } as const;

export interface GuidedOptions {
  yes: boolean;
  /** Folder of exported Datadog JSON/YAML instead of the API (hidden flag; fixtures, tests, backup demo). */
  input?: string;
  only?: "dashboards" | "monitors";
  /** Run directory; default ./dd2dash0-run/<timestamp>. */
  out?: string;
  /** Translate and write payloads, import nothing, skip the live checks (hidden flag). */
  dryRun?: boolean;
  version: string;
  mappingsDir: string;
  io: KeyIO & { choose?: Choose; askBlock?: AskBlock };
  /** Home folder for the per-user key file (tests). */
  home?: string;
  /** Terminal UI; default: plain lines through io.print (pipes, tests). */
  ui?: Ui;
  /** false: the caller already drew the header (the "terminal or browser?" question comes first). */
  header?: boolean;
  /** Running inside the browser terminal (web-term.ts): keys are typed on that page, so no separate key page. */
  inBrowser?: boolean;
  /** --env <file>: read the keys from this file (any name; other common key names understood). */
  envFile?: string;
  /** --browser: enter missing keys on the local web page without asking. */
  browser?: boolean;
  /** Open a file or URL for the user (report.html, the key page). Default: the system opener. */
  open?: (target: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const WINDOW_S = 3600;

/** Lines written through io.print (no TTY: no spinners, no colors). */
export function outFromIO(io: Pick<KeyIO, "print">): Out {
  let buf = "";
  return {
    isTTY: false,
    columns: 80,
    write: (s) => {
      buf += s;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        io.print(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
  };
}

export async function guided(o: GuidedOptions): Promise<number> {
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const io = o.io;
  const ui = o.ui ?? new Ui(outFromIO(io), env);
  const p = ui.p;
  // DD2DASH0_NO_OPEN=1: never open a browser (SSH sessions, tests); the URL is printed either way.
  const open = o.open ?? (env.DD2DASH0_NO_OPEN ? () => {} : openBrowser);
  const started = (o.now ?? (() => new Date()))();
  const stamp = started.toISOString().replace(/[:]/g, "").replace(/\..*$/, "");
  const runDir = resolve(cwd, o.out ?? join("dd2dash0-run", stamp));
  const live = !o.dryRun;
  const useApi = !o.input;
  const need = { datadog: useApi, dash0: live };
  const interactive = !o.yes && !!io.choose;

  if (o.header !== false) ui.header(o.version, cwd);

  // 1. Keys
  ui.heading("Keys");
  if (!need.datadog && !need.dash0) ui.detail(p.dim("dry run from a folder: no keys needed"));
  const pasted: KeyName[] = [];
  // ./name for a file in this folder, ~/… elsewhere.
  const short = (f: string) => (dirname(f) === cwd ? `./${relative(cwd, f)}` : displayPath(f, o.home));
  // Keys from a file: the text of a paste, a dropped or picked file, --env, or a file found nearby.
  const useKeys = (text: string, label?: string): boolean => {
    let got: Keys = {};
    let file: string | null = null;
    try {
      ({ keys: got, file } = keysFromText(text, cwd, o.home));
    } catch (e) {
      ui.detail(p.bad(`could not read that file: ${(e as Error).message}`));
      return false;
    }
    const n = KEYS.filter((k) => got[k]);
    for (const k of n) {
      env[k] = got[k];
      if (!pasted.includes(k)) pasted.push(k);
    }
    const picked = /^# dd2dash0-file: (.{1,120})\n/.exec(text)?.[1]; // a file dropped or picked in the browser page
    const from = label ?? (file ? short(file) : picked ?? "the paste");
    if (n.length) ui.detail(`found ${n.length} key${n.length === 1 ? "" : "s"} in ${from} ${p.dim("(checking them now)")}`);
    return n.length > 0;
  };
  if (o.envFile) {
    const path = resolve(cwd, o.envFile);
    if (!existsSync(path)) {
      ui.line(`${p.bad("✗")} dd2dash0: --env ${o.envFile}: no such file`);
      return EXIT.usage;
    }
    if (!useKeys(readFileSync(path, "utf8"), short(path))) ui.detail(p.warn(`no dd2dash0 keys in ${short(path)}`));
  }
  const { keys: known } = knownKeys(env, cwd, o.home);
  const wanted = KEYS.filter((k) => (k.startsWith("DD_") ? need.datadog : need.dash0) && k !== "DD_SITE" && k !== "DASH0_DATASET");
  const missing = wanted.filter((k) => !known[k]);
  const nearby = missing.length && !o.envFile ? findEnvFiles(cwd, o.home).filter((c) => missing.some((k) => c.names.includes(k))) : [];
  if (missing.length && nearby.length && !interactive && !o.browser)
    ui.detail(p.dim(`keys found in ${nearby.map((c) => short(c.path)).join(", ")}: add --env "${short(nearby[0]!.path)}" to use them`));
  if (missing.length && (o.browser || (interactive && !o.yes))) {
    const files = nearby.map((c) => `Use ${short(c.path)} ${p.dim(`(${c.names.filter((k) => missing.includes(k)).length} of the ${missing.length} missing)`)}`);
    const options = [...files, o.inBrowser ? "Drop, pick or paste a .env" : "Paste your .env, or drag the file into this window", "Type them one by one"];
    if (!o.inBrowser) options.push("In the browser (a one-time page on this computer)");
    const pick = o.browser ? files.length + 2 : await io.choose!(`${missing.length} key(s) missing. How do you want to add them?`, options, 0);
    const where = pick === null ? null : pick - files.length;
    if (pick !== null && pick < files.length) {
      useKeys(readFileSync(nearby[pick]!.path, "utf8"), short(nearby[pick]!.path));
    } else if (where === 0 && io.askBlock) {
      const text = (await io.askBlock(`  Paste the contents of your .env, or drop the file here ${p.dim("(nothing you paste is shown)")}`)) ?? "";
      if (!useKeys(text)) ui.detail(p.warn("no dd2dash0 keys found in that; asking one by one"));
    } else if (where === 2) {
      try {
        const r = await webKeys({
          need,
          known,
          cwd,
          savePath: displayPath(configEnvPath(env, o.home), o.home),
          ...(o.fetch ? { fetch: o.fetch } : {}),
          onReady: (url) => {
            ui.detail(`Enter your keys on ${link(p, "the key page", url)} ${p.dim("(this computer only, works once)")}`);
            ui.detail(p.dim(url));
            open(url);
          },
        });
        for (const [k, v] of Object.entries(r.keys)) if (v) env[k] = v;
        if (r.save) {
          const toSave: Keys = {};
          for (const k of KEYS) if (r.keys[k] && r.keys[k] !== known[k]) toSave[k] = r.keys[k];
          if (Object.keys(toSave).length) {
            const path = configEnvPath(env, o.home);
            saveDotEnv(path, toSave);
            ui.detail(p.dim(`saved to ${displayPath(path, o.home)}; dd2dash0 finds them from any folder`));
          }
        }
      } catch (e) {
        ui.detail(p.bad(`browser: ${(e as Error).message}`));
        return EXIT.usage;
      }
    }
  }
  const still = wanted.filter((k) => !env[k] && !known[k]);
  if (pasted.length && still.length) ui.detail(p.dim(`still missing ${still.map((k) => LABELS[k]).join(", ")}: asked next`));
  let keys;
  try {
    keys = await resolveKeys({ need, env, cwd, io, yes: o.yes, pasted, ...(o.home ? { home: o.home } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  } catch (e) {
    if (e instanceof KeyError) {
      ui.line(`${p.bad("✗")} dd2dash0: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
  // The pipeline's ingest reads the Datadog keys from the environment; set them for this process only.
  for (const [k, v] of Object.entries(keys)) {
    if (v === undefined) continue;
    env[k] = v;
    process.env[k] = v;
  }
  ui.line();

  // 2. Translate
  mkdirSync(runDir, { recursive: true });
  const planDir = join(runDir, "plan");
  const config = resolveConfig(useApi ? { source: { kind: "api", site: keys.DD_SITE! } } : { source: { kind: "folder", path: resolve(cwd, o.input!) } }, {}, env);
  let plan;
  const tStep = ui.step("Translate", useApi ? `Reading Datadog (${keys.DD_SITE}) and translating…` : `Translating ${o.input}…`);
  try {
    plan = await runPlan({ config, outDir: planDir, defaultMappingsDir: o.mappingsDir, ...(o.input ? { resolvedInput: resolve(cwd, o.input) } : {}), ...(o.only ? { only: o.only } : {}), version: o.version });
  } catch (e) {
    tStep.fail(p.bad("could not read or translate the source"), [(e as Error).message]);
    return EXIT.usage;
  }
  const report: Report = plan.result.report;
  const items = report.items.filter((i) => i.kind === "panel" || i.kind === "alert");
  const by = (s: string) => items.filter((i) => i.status === s).length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const claims = [["exact", by("exact")], ["exact-under", by("exact-under")], ["bounded", by("bounded")], ["manual", by("manual")], ["unsupported", by("unsupported")]].filter(([, n]) => n).map(([w, n]) => `${n} ${w}`);
  tStep.done(`${plural(report.summary.dashboards, "dashboard")} · ${plural(report.summary.alerts, "monitor")} ${p.dim("→")} ${items.length} items${o.only ? p.dim(` (${o.only} only)`) : ""}`, [p.dim(claims.join(" · "))]);
  ui.line();
  const coverage = plan.result.queryCoverage;
  for (const l of coverageLines(ui, coverage)) ui.line(l);
  if (items.length === 0) {
    ui.line(p.dim("Nothing to migrate: no dashboards or monitors found."));
    return EXIT.ok;
  }

  // 3. Review
  ui.heading("Review");
  const review = await batchedReview(planDir, io, { yes: o.yes });
  ui.line();

  // 4. Import
  const iStep = ui.step("Import", live ? `Importing into Dash0 (${new URL(keys.DASH0_API_URL!).host})…` : "Writing Dash0 payloads…");
  const dash0 = live ? { apiUrl: keys.DASH0_API_URL!, token: keys.DASH0_AUTH_TOKEN!, dataset: keys.DASH0_DATASET!, ...(o.fetch ? { fetch: o.fetch } : {}) } : undefined;
  const applied = await runApply({ planDir, reviewFile: review.file, dryRun: !live, enableRules: false, cwd, ...(dash0 ? { dash0 } : {}) });
  if (applied.kind === "refused") {
    iStep.fail(p.bad("refused"), applied.reasons);
    return EXIT.refused;
  }
  const failedImports = applied.manifest.results.filter((r) => r.errors.length);
  const imported = `${plural(applied.imported.dashboards, "dashboard")} · ${plural(applied.imported.rules, "check rule")}${live ? "" : p.dim(" (dry run, nothing imported)")}`;
  const iDetails = [
    ...applied.warnings.map((w) => p.warn(w)),
    ...failedImports.map((r) => `${p.bad("✗")} ${r.kind} ${r.name}: ${r.errors.join("; ")}${r.traceId ? p.dim(` (traceId ${r.traceId})`) : ""}`),
    ...(live && applied.imported.rules ? [p.dim("new check rules start off; existing ones keep their on/off state")] : []),
  ];
  (failedImports.length ? iStep.fail : iStep.done)(imported, iDetails);
  const appliedReport = JSON.parse(readFileSync(applied.reportFile, "utf8")) as Report;
  ui.line();

  // 5. Verify
  let liveResults = null;
  if (live) {
    const vStep = ui.step("Verify", `Reading back and checking the last ${WINDOW_S / 60} min of data${useApi ? " in Dash0 and Datadog" : " in Dash0"}…`);
    liveResults = await verifyLive(appliedReport.items, {
      dash0: dash0!,
      ...(keys.DD_API_KEY && keys.DD_APP_KEY && keys.DD_SITE ? { datadog: { site: keys.DD_SITE, apiKey: keys.DD_API_KEY, appKey: keys.DD_APP_KEY } } : {}),
      windowSeconds: WINDOW_S,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    const landed = applied.manifest.results.filter((r) => r.readBack.state === "match").length;
    const lv = [...liveResults.values()];
    const liveN = lv.filter((x) => x.live === "live").length;
    const denom = lv.filter((x) => x.live === "live" || x.live === "missing" || x.live === "error").length;
    vStep.done(`read back ${landed}/${applied.manifest.results.length} · ${liveN}/${denom} queries return data`);
  } else ui.heading("Verify", p.dim("skipped (dry run)"));
  ui.line();

  // Report
  const decisions = decisionsOf(review, appliedReport.items);
  const facts: RunFacts = {
    version: o.version,
    source: useApi ? `Datadog ${keys.DD_SITE}` : `folder ${o.input}`,
    target: live ? `Dash0 ${new URL(keys.DASH0_API_URL!).host} / ${keys.DASH0_DATASET}` : "Dash0 (dry run)",
    mode: live ? "live" : "dry-run",
    inputHash: report.run.inputHash,
    outputHash: report.run.outputHash,
    planHash: plan.planHash,
    windowSeconds: WINDOW_S,
    startedAt: started.toISOString(),
  };
  // Rules that are on in Dash0 after the import (existing rules keep their state).
  const enabled = new Set(applied.manifest.results.filter((r) => r.kind === "check-rule" && r.action === "imported" && r.enabled).map((r) => r.id));
  const write = () => {
    const rows = rowsOf(appliedReport, decisions, liveResults, live, enabled);
    const score = scoreOf(rows);
    return { rows, score, files: writeRunReport(runDir, score, rows, facts, coverage) };
  };
  let out = write();
  // Inside the current folder: a short relative path. Elsewhere: the full path with ~, never a chain of ../.
  const rel = (f: string) => {
    const r = relative(cwd, f);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : tildify(f);
  };
  for (const l of resultCard(ui, out.score, { live, rulesImported: applied.imported.rules, rulesOn: enabled.size, manualMonitors: review.manualMonitors.length, html: out.files.html, md: out.files.md, rel })) ui.line(l);

  // Offer to switch on only the imported rules that are off (default: leave them off).
  const offRules = applied.manifest.results.filter((r) => r.kind === "check-rule" && r.action === "imported" && !r.enabled).map((r) => r.id);
  if (live && offRules.length && !o.yes) {
    ui.line();
    const q = `Turn on ${offRules.length === 1 ? "the approved check rule" : `the ${offRules.length} approved check rules`}? ${p.dim("It starts evaluating and can notify.")}`;
    const yes = io.choose ? (await io.choose(q, ["No, leave it off", "Yes, turn it on"], 0)) === 1 : /^y(es)?$/i.test(((await io.ask(`${q} [y/N] `)) ?? "").trim());
    if (yes) {
      const dir = join(planDir, "dash0", "check-rules"); // the plan always writes every payload
      const payloads = offRules
        .map((id) => join(dir, `${id}.json`))
        .filter(existsSync)
        .map((f) => ({ ...(JSON.parse(readFileSync(f, "utf8")) as PrometheusAlertRule), enabled: true }));
      const m = await importAll({ dashboards: [], rules: payloads }, { dryRun: false, outDir: join(runDir, "enable"), enableRules: true, config: dash0! });
      for (const r of m.results) if (r.action === "imported") enabled.add(r.id);
      const bad = m.results.filter((r) => r.errors.length);
      ui.detail(`${enabled.size} rule(s) on${bad.length ? p.bad(`, ${bad.length} failed: ${bad.map((r) => `${r.name}: ${r.errors.join("; ")}`).join(" | ")}`) : ""}`);
      out = write();
    } else ui.detail(p.dim("left off; turn it on in Dash0 when you're ready"));
  }

  // Offer to open the report page.
  if (interactive && io.choose && ui.out.isTTY) {
    ui.line();
    if ((await io.choose("Open the report?", ["Open report.html", "Done"], 0)) === 0) open(out.files.html);
  }

  const liveFail = out.rows.some((r) => r.live === "missing" || r.live === "error");
  return applied.ok && !liveFail ? EXIT.ok : EXIT.failed;
}

/** The closing card: one bar per number, top gaps, rules, and links to the report. */
/** "● By query type": the report's coverage section in the terminal, one bar per kind, best first. */
export function coverageLines(ui: Ui, c: QueryCoverage): string[] {
  if (!c.total) return [];
  const p = ui.p;
  const w = Math.max(...c.rows.map((r) => r.label.length));
  const L = [`${p.accent("●")} ${p.bold("By query type")}  ${p.dim(`${c.total.toLocaleString("en")} distinct queries and monitors`)}`];
  for (const r of c.rows) {
    const cells = 18;
    const ex = Math.floor((r.exact / r.total) * cells);
    const tr = Math.floor((r.translated / r.total) * cells);
    const barStr = p.accent("█".repeat(ex)) + p.accent(p.dim("▓".repeat(tr - ex))) + p.dim("░".repeat(cells - tr));
    const why = r.reasons.length ? p.dim(`  ${r.reasons.slice(0, 2).map(([k, n]) => `${k} ${n}`).join(" · ")}`) : "";
    L.push(`  ${p.dim("⎿")} ${r.label.padEnd(w)}  ${barStr}  ${pct1(r.translated, r.total).padStart(6)}  ${p.dim(`${r.translated}/${r.total}`)}${why}`);
  }
  L.push(`  ${p.dim("⎿")} ${p.dim(coverageHeadline(c))}`, "");
  return L;
}

export function resultCard(ui: Ui, s: Score, x: { live: boolean; rulesImported: number; rulesOn: number; manualMonitors: number; html: string; md: string; rel: (f: string) => string }): string[] {
  const p = ui.p;
  const meter = (name: string, n: Score["success"], bold = false) => {
    const label = (bold ? p.bold : (t: string) => t)(name.padEnd(11));
    if (!n) return `${label} ${p.dim("░".repeat(18))}  ${p.dim("not measured")}`;
    const frac = n.total ? n.count / n.total : 0;
    return `${label} ${bar(p, frac)}  ${`${n.count}/${n.total}`.padStart(7)}  ${(bold ? p.bold : (t: string) => t)(`${n.pct}%`.padStart(4))}`;
  };
  const lines = [meter("success", s.success, true), meter("translated", s.translated), meter("landed", s.landed), meter("live", s.live), ""];
  if (s.topGaps.length) lines.push(`${p.dim("gaps  ")} ${s.topGaps.slice(0, 3).map(([c, n]) => `${c} ${p.dim(`×${n}`)}`).join(p.dim(" · "))}`);
  lines.push(`${p.dim("rules ")} ${x.rulesImported} ${x.live ? `imported (${x.rulesOn} on, ${x.rulesImported - x.rulesOn} off)` : "written (dry run)"}${x.manualMonitors ? p.dim(` · ${x.manualMonitors} monitor(s) not translatable`) : ""}`);
  const dir = x.rel(dirname(x.html));
  lines.push(p.on ? `${p.dim("report")} ${link(p, "report.html", pathToFileURL(x.html).href)}${p.dim(" · ")}${link(p, "report.md", pathToFileURL(x.md).href)}${p.dim(`  in ${dir}`)}` : `report ${x.rel(x.html)} · ${x.rel(x.md)}`);
  return box(p, lines, { title: "Result", max: Math.min(ui.out.columns, 96) });
}

export { terminalIO } from "./tty.js";
