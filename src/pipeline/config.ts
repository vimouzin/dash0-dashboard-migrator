// dd2dash0.yaml (CONTRACT-003 §3): an optional config file so a run is repeatable. Flags override it; secrets never
// live in it (they come from env / .env). The resolved config is recorded in plan.lock and report.json.
// Not wired into the CLI yet.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface Dd2dash0Config {
  source?: { kind: "api"; site?: string } | { kind: "folder"; path: string };
  select?: string[];
  mappings?: string;
  channels?: string;
  dash0?: { dataset?: string; orgId?: string };
  enableRules?: boolean;
  allowPending?: boolean;
  verifyData?: boolean;
}

export interface ResolvedConfig {
  source: { kind: "api"; site: string } | { kind: "folder"; path: string };
  select: string[];
  mappings: string | null;
  channels: string | null;
  dash0: { dataset: string; orgId: string | null };
  enableRules: boolean;
  allowPending: boolean;
  verifyData: boolean;
}

export class ConfigError extends Error {}

export const DEFAULT_CONFIG_FILE = "dd2dash0.yaml";
const TOP_KEYS = new Set(["source", "select", "mappings", "channels", "dash0", "enableRules", "allowPending", "verifyData"]);
const SECRET_KEY = /(token|secret|password|api[_-]?key|app[_-]?key|auth)/i;

/** Keys that look like credentials anywhere in the file are refused: secrets go in env / .env. */
function refuseSecrets(x: unknown, path: string, file: string) {
  if (!x || typeof x !== "object") return;
  for (const [k, v] of Object.entries(x)) {
    if (SECRET_KEY.test(k)) throw new ConfigError(`${file}: '${path}${k}' looks like a secret; put credentials in the environment (.env), never in the config`);
    refuseSecrets(v, `${path}${k}.`, file);
  }
}

function check(c: Record<string, unknown>, file: string): Dd2dash0Config {
  for (const k of Object.keys(c)) if (!TOP_KEYS.has(k)) throw new ConfigError(`${file}: unknown key '${k}' (allowed: ${[...TOP_KEYS].join(", ")})`);
  const bool = (k: string) => {
    if (c[k] !== undefined && typeof c[k] !== "boolean") throw new ConfigError(`${file}: '${k}' must be true or false`);
  };
  const str = (v: unknown, name: string) => {
    if (v !== undefined && (typeof v !== "string" || !v)) throw new ConfigError(`${file}: '${name}' must be a non-empty string`);
  };
  ["enableRules", "allowPending", "verifyData"].forEach(bool);
  str(c.mappings, "mappings");
  str(c.channels, "channels");
  if (c.select !== undefined && !(Array.isArray(c.select) && c.select.every((s) => typeof s === "string" && s)))
    throw new ConfigError(`${file}: 'select' must be a list of glob strings`);
  const s = c.source as Record<string, unknown> | undefined;
  if (s !== undefined) {
    if (s?.kind === "api") str(s.site, "source.site");
    else if (s?.kind === "folder") {
      if (typeof s.path !== "string" || !s.path) throw new ConfigError(`${file}: 'source.path' is required for kind: folder`);
    } else throw new ConfigError(`${file}: 'source.kind' must be api or folder`);
  }
  const d = c.dash0 as Record<string, unknown> | undefined;
  if (d !== undefined) {
    if (typeof d !== "object" || d === null) throw new ConfigError(`${file}: 'dash0' must be a map`);
    for (const k of Object.keys(d)) if (k !== "dataset" && k !== "orgId") throw new ConfigError(`${file}: unknown key 'dash0.${k}'`);
    str(d.dataset, "dash0.dataset");
    if (d.orgId !== undefined && (typeof d.orgId !== "string" || !/^[0-9a-f-]{36}$/i.test(d.orgId))) throw new ConfigError(`${file}: 'dash0.orgId' must be the org UUID from a Dash0 URL`);
  }
  return c as Dd2dash0Config;
}

/** Load the config file: the given path (must exist), else ./dd2dash0.yaml if present, else none. */
export function loadConfig(path: string | undefined, cwd = process.cwd()): { config: Dd2dash0Config; file: string | null } {
  const file = path ?? (existsSync(join(cwd, DEFAULT_CONFIG_FILE)) ? join(cwd, DEFAULT_CONFIG_FILE) : null);
  if (!file) return { config: {}, file: null };
  if (!existsSync(file)) throw new ConfigError(`${file}: config file not found`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`${file}: not valid YAML (${(e as Error).message})`);
  }
  if (raw === null || raw === undefined) return { config: {}, file };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${file}: expected a map at the top level`);
  refuseSecrets(raw, "", file);
  return { config: check(raw as Record<string, unknown>, file), file };
}

/** Flags win over the file, the file over defaults. Env supplies only DASH0_DATASET / DASH0_ORG_ID / DD_SITE defaults. */
export function resolveConfig(file: Dd2dash0Config, flags: Dd2dash0Config, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const pick = <K extends keyof Dd2dash0Config>(k: K) => (flags[k] !== undefined ? flags[k] : file[k]);
  const src = pick("source") ?? { kind: "api" as const };
  const source = src.kind === "folder" ? { kind: "folder" as const, path: src.path } : { kind: "api" as const, site: src.site ?? env.DD_SITE ?? "datadoghq.eu" };
  const d = { ...(file.dash0 ?? {}), ...(flags.dash0 ?? {}) };
  return {
    source,
    select: [...(pick("select") ?? [])],
    mappings: pick("mappings") ?? null,
    channels: pick("channels") ?? null,
    dash0: { dataset: d.dataset ?? env.DASH0_DATASET ?? "default", orgId: d.orgId ?? env.DASH0_ORG_ID ?? null },
    enableRules: pick("enableRules") ?? false,
    allowPending: pick("allowPending") ?? false,
    verifyData: pick("verifyData") ?? false,
  };
}
