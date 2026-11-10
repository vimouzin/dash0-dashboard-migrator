// Step 1 of the guided flow: find the Datadog + Dash0 credentials (env, then ./.env), ask for what's missing,
// check each against its API with a read-only call, and offer to save them to ./.env (0600).
// Secrets are never printed, logged or written anywhere but .env; at most a 4-character fingerprint is shown.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const KEYS = ["DD_SITE", "DD_API_KEY", "DD_APP_KEY", "DASH0_API_URL", "DASH0_AUTH_TOKEN", "DASH0_DATASET"] as const;
export type KeyName = (typeof KEYS)[number];
export type Keys = Partial<Record<KeyName, string>>;
export const SECRET_KEYS: ReadonlySet<KeyName> = new Set(["DD_API_KEY", "DD_APP_KEY", "DASH0_AUTH_TOKEN"]);
export const DEFAULTS: Partial<Record<KeyName, string>> = { DD_SITE: "datadoghq.eu", DASH0_DATASET: "default" };

export const LABELS: Record<KeyName, string> = {
  DD_SITE: "Datadog site",
  DD_API_KEY: "Datadog API key",
  DD_APP_KEY: "Datadog application key",
  DASH0_API_URL: "Dash0 API URL",
  DASH0_AUTH_TOKEN: "Dash0 auth token",
  DASH0_DATASET: "Dash0 dataset",
};

/** Where to find each value, shown next to its question. */
export const HINTS: Partial<Record<KeyName, string>> = {
  DD_API_KEY: "Organization Settings → API Keys",
  DD_APP_KEY: "Organization Settings → Application Keys",
  DASH0_API_URL: "Settings → Endpoints → API, not the ingress",
  DASH0_AUTH_TOKEN: "Settings → Auth Tokens",
};

/** Other names people use for the same values (Datadog's own docs, Terraform, other tools). */
export const ALIASES: Record<string, KeyName> = {
  DATADOG_API_KEY: "DD_API_KEY",
  DD_APPLICATION_KEY: "DD_APP_KEY",
  DATADOG_APP_KEY: "DD_APP_KEY",
  DATADOG_APPLICATION_KEY: "DD_APP_KEY",
  DATADOG_SITE: "DD_SITE",
  DATADOG_HOST: "DD_SITE",
  DASH0_TOKEN: "DASH0_AUTH_TOKEN",
  DASH0_API_TOKEN: "DASH0_AUTH_TOKEN",
  DASH0_URL: "DASH0_API_URL",
  DASH0_API_ENDPOINT: "DASH0_API_URL",
};

/**
 * A path someone dragged into the terminal, as the terminal typed it: macOS Terminal escapes spaces
 * (/Users/me/env\ copy.txt), iTerm and others may quote it, and a trailing space is common. Returns the path, or null.
 */
export function droppedPath(text: string, cwd: string, home = homedir()): string | null {
  let t = text.trim();
  if (!t || t.includes("\n") || t.includes("=")) return null;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) t = t.slice(1, -1);
  else t = t.replace(/\\(.)/g, "$1");
  if (t.startsWith("file://")) t = decodeURIComponent(t.slice(7));
  if (t === "~" || t.startsWith("~/")) t = join(home, t.slice(1));
  const p = isAbsolute(t) ? t : join(cwd, t);
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/** Keys from pasted text or a dropped file: KEY=value lines, other names mapped, everything else ignored. */
export function keysFromText(text: string, cwd: string, home = homedir()): { keys: Keys; file: string | null } {
  const file = droppedPath(text, cwd, home);
  return { keys: canonicalKeys(parseDotEnv(file ? readFileSync(file, "utf8") : text)), file };
}

/** Minimal .env parser: KEY=value, optional quotes, # comments. Only what we need, no expansion. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/** Our names for whatever a source calls them: DD_API_KEY wins over DATADOG_API_KEY when both are set. */
export function canonicalKeys(raw: Record<string, string | undefined>): Keys {
  const k: Keys = {};
  for (const name of KEYS) if (raw[name]?.trim()) k[name] = raw[name]!.trim();
  for (const [alias, name] of Object.entries(ALIASES)) if (!k[name] && raw[alias]?.trim()) k[name] = raw[alias]!.trim();
  if (k.DD_SITE) k.DD_SITE = k.DD_SITE.replace(/^https?:\/\/(api\.|app\.)?/, "").replace(/\/.*$/, "");
  return k;
}

/** Env wins over ./.env; empty values count as missing; other common names (ALIASES) count too. */
export function lookupKeys(env: NodeJS.ProcessEnv, dotenv: Record<string, string>): Keys {
  return { ...canonicalKeys(dotenv), ...canonicalKeys(env) };
}

/** A file name that looks like an env file: .env.local, prod.env, env.example copy.txt, datadog-env.txt. */
const ENV_NAME = /^\.env(\..+)?$|\.env$|(^|[._ -])env([._ -]|$)/i;

export interface EnvCandidate {
  path: string;
  /** dd2dash0 keys with a value in it (any of their names). */
  names: KeyName[];
}

/**
 * Env-looking files next to you that hold dd2dash0 keys: the current folder (other than ./.env, which is read anyway)
 * and ~/Downloads (where a .env someone sent you lands). Only names are matched and keys counted; nothing is used
 * until you pick one. Small files only, best first.
 */
export function findEnvFiles(cwd: string, home = homedir(), max = 3): EnvCandidate[] {
  const out: (EnvCandidate & { mtime: number })[] = [];
  for (const dir of [...new Set([cwd, join(home, "Downloads")])]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!ENV_NAME.test(n) || (dir === cwd && n === ".env")) continue;
      const p = join(dir, n);
      try {
        const st = statSync(p);
        if (!st.isFile() || st.size > 64_000) continue;
        const keys = canonicalKeys(parseDotEnv(readFileSync(p, "utf8")));
        const found = KEYS.filter((k) => keys[k]);
        if (found.some((k) => SECRET_KEYS.has(k))) out.push({ path: p, names: found, mtime: st.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  out.sort((a, b) => b.names.length - a.names.length || b.mtime - a.mtime);
  return out.slice(0, max).map(({ path, names }) => ({ path, names }));
}

/** Replace our keys in an existing .env (keeping every other line and comment), append the ones not there yet. */
export function mergeDotEnv(existing: string, keys: Keys): string {
  const lines = existing ? existing.replace(/\n$/, "").split("\n") : [];
  const done = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const name = m?.[1] as KeyName | undefined;
    if (name && name in keys && keys[name] !== undefined) {
      done.add(name);
      return `${name}=${keys[name]}`;
    }
    return line;
  });
  for (const name of KEYS) if (keys[name] !== undefined && !done.has(name)) out.push(`${name}=${keys[name]}`);
  return out.join("\n") + "\n";
}

/** The per-user key file: $XDG_CONFIG_HOME/dd2dash0/.env, %APPDATA%\\dd2dash0\\.env, or ~/.config/dd2dash0/.env. */
export function configEnvPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "dd2dash0", ".env");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "dd2dash0", ".env");
  return join(home, ".config", "dd2dash0", ".env");
}

/** "~/.config/dd2dash0/.env" for display. */
export const displayPath = (p: string, home = homedir()) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);

/** Keys from the environment, then ./.env, then the per-user key file (first one wins). */
export function knownKeys(env: NodeJS.ProcessEnv, cwd: string, home = homedir()): { keys: Keys; files: Record<string, string> } {
  const read = (p: string) => (existsSync(p) ? parseDotEnv(readFileSync(p, "utf8")) : {});
  const files = { ...read(configEnvPath(env, home)), ...read(join(cwd, ".env")) };
  return { keys: lookupKeys(env, files), files };
}

/** Write a .env with mode 0600 (also tightens an existing file); creates its folder (0700). */
export function saveDotEnv(path: string, keys: Keys): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, mergeDotEnv(prev, keys), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** 'ignored' | 'not-ignored' | 'no-repo' for a path, via git check-ignore. */
export function gitIgnoreState(path: string): "ignored" | "not-ignored" | "no-repo" {
  const cwd = dirname(path);
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" });
  } catch {
    return "no-repo";
  }
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd, stdio: "ignore" });
    return "ignored";
  } catch {
    return "not-ignored";
  }
}

/** Last 4 characters, for "using key …a1b2". Never more. */
export const fingerprint = (s: string) => (s.length > 8 ? `…${s.slice(-4)}` : "…");

/**
 * Normalize a pasted Dash0 API URL. Returns { url } or { error } explaining what's wrong. The common mistake is the
 * OTLP ingress endpoint (ingress.*, :4317/:4318, /v1/traces), which accepts telemetry but has no API.
 */
export function normalizeDash0Url(input: string): { url: string } | { error: string } {
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return { error: "empty URL" };
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: `not a URL: ${input.trim()}` };
  }
  const ingress = /(^|\.)ingress\./i.test(u.hostname) || u.port === "4317" || u.port === "4318" || /^\/v1\/(traces|metrics|logs)/.test(u.pathname);
  if (ingress)
    return { error: "that is the Dash0 ingress (OTLP) endpoint, which receives telemetry but has no API. Use the API URL from Dash0 -> Settings -> Endpoints -> API (it looks like https://api.eu-west-1.aws.dash0.com)" };
  if (u.protocol !== "https:") return { error: "the Dash0 API URL must start with https://" };
  return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}` };
}

export function validSite(site: string): boolean {
  return /^(?:[a-z0-9-]+\.)*datadoghq\.(?:com|eu)$|^ddog-gov\.com$/.test(site.trim());
}

export type Check = { ok: true } | { ok: false; message: string };

/** Datadog: the API key via /api/v1/validate, then the application key with a 1-item dashboard list. Read-only. */
export async function checkDatadog(k: { site: string; apiKey: string; appKey: string }, f: typeof fetch = fetch): Promise<Check> {
  const base = `https://api.${k.site}`;
  try {
    const v = await f(`${base}/api/v1/validate`, { headers: { "DD-API-KEY": k.apiKey, Accept: "application/json" } });
    if (v.status === 403 || v.status === 401) return { ok: false, message: `Datadog rejected the API key on ${k.site} (is the site right? EU accounts use datadoghq.eu)` };
    if (!v.ok) return { ok: false, message: `Datadog /api/v1/validate answered ${v.status}` };
    const d = await f(`${base}/api/v1/dashboard?count=1`, { headers: { "DD-API-KEY": k.apiKey, "DD-APPLICATION-KEY": k.appKey, Accept: "application/json" } });
    if (d.status === 403 || d.status === 401) return { ok: false, message: "Datadog rejected the application key (or it lacks dashboards_read / monitors_read scope)" };
    if (!d.ok) return { ok: false, message: `Datadog dashboard list answered ${d.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `could not reach Datadog at ${base}: ${(e as Error).message}` };
  }
}

/** Dash0: a read-only dashboards list on the dataset. */
export async function checkDash0(k: { apiUrl: string; token: string; dataset: string }, f: typeof fetch = fetch): Promise<Check> {
  const url = new URL("/api/dashboards", k.apiUrl);
  url.searchParams.set("dataset", k.dataset);
  try {
    const r = await f(url, { headers: { Authorization: `Bearer ${k.token}`, Accept: "application/json" } });
    if (r.status === 401 || r.status === 403) return { ok: false, message: "Dash0 rejected the auth token (or it has no access to this dataset)" };
    if (r.status === 404) return { ok: false, message: `Dash0 answered 404 for ${url.origin}/api/dashboards: is this the API URL, and does dataset '${k.dataset}' exist?` };
    if (!r.ok) return { ok: false, message: `Dash0 answered ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `could not reach Dash0 at ${url.origin}: ${(e as Error).message}` };
  }
}

export interface KeyIO {
  ask: (prompt: string) => Promise<string | null>;
  askSecret: (prompt: string) => Promise<string | null>;
  print: (line: string) => void;
}

export class KeyError extends Error {}

export interface ResolveKeysOptions {
  need: { datadog: boolean; dash0: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** choose(): an arrow-key list on a TTY (src/flow/tty.ts); without it, yes/no questions are typed. */
  io: KeyIO & { choose?: (question: string, options: string[], defaultIndex?: number) => Promise<number | null> };
  /** --yes: never prompt; missing keys are an error. */
  yes: boolean;
  fetch?: typeof fetch;
  maxTries?: number;
  /** Home folder for the per-user key file (tests). */
  home?: string;
  /** Keys the user pasted in this run (offered for saving like typed ones). */
  pasted?: KeyName[];
}

/**
 * Find, ask for, check and (optionally) save the keys this run needs. Returns the keys; throws KeyError (exit 3) when
 * a key is missing under --yes or keeps failing its check.
 */
export async function resolveKeys(o: ResolveKeysOptions): Promise<Keys> {
  const savePath = configEnvPath(o.env, o.home ?? homedir());
  const { keys, files: dotenv } = knownKeys(o.env, o.cwd, o.home ?? homedir());
  const fromFile = new Set(KEYS.filter((n) => keys[n] !== undefined));
  const asked = new Set<KeyName>(o.pasted ?? []);
  const tries = o.maxTries ?? 3;
  const f = o.fetch ?? fetch;

  const wanted: KeyName[] = [...(o.need.datadog ? (["DD_SITE", "DD_API_KEY", "DD_APP_KEY"] as const) : []), ...(o.need.dash0 ? (["DASH0_API_URL", "DASH0_AUTH_TOKEN", "DASH0_DATASET"] as const) : [])];
  for (const n of wanted) if (keys[n] === undefined && DEFAULTS[n] && o.yes) keys[n] = DEFAULTS[n];
  const missing = wanted.filter((n) => keys[n] === undefined);
  if (o.yes && missing.length) throw new KeyError(`missing ${missing.join(", ")} (set them in the environment, ./.env or ${displayPath(savePath, o.home ?? homedir())}; --yes never prompts)`);

  const ask = async (n: KeyName): Promise<string> => {
    asked.add(n);
    const def = DEFAULTS[n];
    const prompt = `  ⎿ ${LABELS[n]}${def ? ` [${def}]` : ""}${HINTS[n] ? ` · ${HINTS[n]}` : ""} › `;
    const v = ((SECRET_KEYS.has(n) ? await o.io.askSecret(prompt) : await o.io.ask(prompt)) ?? "").trim();
    if (!v && def) return def;
    if (!v) throw new KeyError(`no ${n} given`);
    return v;
  };

  if (o.need.datadog) {
    for (let t = 1; ; t++) {
      if (keys.DD_SITE === undefined) keys.DD_SITE = await ask("DD_SITE");
      if (!validSite(keys.DD_SITE)) {
        o.io.print(`  ⎿ ✗ '${keys.DD_SITE}' is not a Datadog site (e.g. datadoghq.eu, datadoghq.com, us5.datadoghq.com)`);
        if (o.yes || t >= tries) throw new KeyError(`invalid DD_SITE '${keys.DD_SITE}'`);
        delete keys.DD_SITE;
        continue;
      }
      if (keys.DD_API_KEY === undefined) keys.DD_API_KEY = await ask("DD_API_KEY");
      if (keys.DD_APP_KEY === undefined) keys.DD_APP_KEY = await ask("DD_APP_KEY");
      const c = await checkDatadog({ site: keys.DD_SITE, apiKey: keys.DD_API_KEY, appKey: keys.DD_APP_KEY }, f);
      if (c.ok) {
        o.io.print(`  ⎿ Datadog  ${keys.DD_SITE} · API key ${fingerprint(keys.DD_API_KEY)} · app key ${fingerprint(keys.DD_APP_KEY)}  ✓`);
        break;
      }
      o.io.print(`  ⎿ ✗ ${c.message}`);
      if (o.yes || t >= tries) throw new KeyError(c.message);
      // Ask again for what most likely caused it.
      if (/application key/.test(c.message)) delete keys.DD_APP_KEY;
      else if (/could not reach/.test(c.message)) delete keys.DD_SITE;
      else delete keys.DD_API_KEY;
    }
  }

  if (o.need.dash0) {
    for (let t = 1; ; t++) {
      if (keys.DASH0_API_URL === undefined) keys.DASH0_API_URL = await ask("DASH0_API_URL");
      const u = normalizeDash0Url(keys.DASH0_API_URL);
      if ("error" in u) {
        o.io.print(`  ⎿ ✗ ${u.error}`);
        if (o.yes || t >= tries) throw new KeyError(`DASH0_API_URL: ${u.error}`);
        delete keys.DASH0_API_URL;
        continue;
      }
      keys.DASH0_API_URL = u.url;
      if (keys.DASH0_AUTH_TOKEN === undefined) keys.DASH0_AUTH_TOKEN = await ask("DASH0_AUTH_TOKEN");
      if (keys.DASH0_DATASET === undefined) keys.DASH0_DATASET = await ask("DASH0_DATASET");
      const c = await checkDash0({ apiUrl: keys.DASH0_API_URL, token: keys.DASH0_AUTH_TOKEN, dataset: keys.DASH0_DATASET }, f);
      if (c.ok) {
        o.io.print(`  ⎿ Dash0    ${new URL(keys.DASH0_API_URL).host} · ${keys.DASH0_DATASET} · token ${fingerprint(keys.DASH0_AUTH_TOKEN)}  ✓`);
        break;
      }
      o.io.print(`  ⎿ ✗ ${c.message}`);
      if (o.yes || t >= tries) throw new KeyError(c.message);
      if (/404/.test(c.message)) {
        delete keys.DASH0_API_URL;
        delete keys.DASH0_DATASET;
      } else if (/could not reach/.test(c.message)) delete keys.DASH0_API_URL;
      else delete keys.DASH0_AUTH_TOKEN;
    }
  }

  // Offer to save only what was typed in this run (env-only keys stay env-only).
  const typed = [...asked].filter((n) => keys[n] !== undefined && !(fromFile.has(n) && dotenv[n] === keys[n]));
  if (typed.length && !o.yes) {
    const where = displayPath(savePath, o.home ?? homedir());
    const save = o.io.choose
      ? (await o.io.choose(`Save ${typed.length === 1 ? "it" : "them"} for next time?`, [`Yes, in ${where} (only you can read it; works from any folder)`, "No, ask again next time"], 0)) === 0
      : /^(|y|yes)$/i.test(((await o.io.ask(`  Save ${typed.length === 1 ? "it" : "them"} for next time in ${where}? Only you can read it. [Y/n] `)) ?? "").trim());
    if (save) {
      const toSave: Keys = {};
      for (const n of typed) toSave[n] = keys[n];
      saveDotEnv(savePath, toSave);
      o.io.print(`  ⎿ saved to ${where}; dd2dash0 finds them from any folder`);
    }
  }
  return keys;
}
