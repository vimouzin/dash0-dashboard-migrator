// T7 entry point: preflight -> (dry-run | import) -> read back -> compare -> manifest.
// Items are processed one at a time with single-item endpoints, so one bad item never sinks the batch
// (the bulk check-rules call is all-or-nothing, knowledge base D-31).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Dash0ApiError, Dash0Client, type Dash0Config } from "./client.js";
import { preflightCheckRule, preflightDashboard } from "./preflight.js";
import type { DashboardDefinition, PrometheusAlertRule } from "./schema.js";

export interface TargetOptions {
  dryRun: boolean;
  /** Where payloads (dry-run) and the manifest are written. */
  outDir: string;
  /** Import check rules enabled. Default false (knowledge base D-30: no surprise paging). */
  enableRules?: boolean;
  /** Required unless dryRun. */
  config?: Dash0Config;
}

export type ReadBack = { state: "match" } | { state: "mismatch"; fields: string[] } | { state: "missing" } | { state: "skipped" };

export interface ImportResult {
  kind: "dashboard" | "check-rule";
  id: string;
  name: string;
  action: "dry-run" | "imported" | "rejected-preflight" | "failed";
  /** sha256 of the canonical payload that was (or would be) sent. */
  payloadHash: string;
  readBack: ReadBack;
  errors: string[];
  traceId?: string;
  /** Check rules: the enabled state that was (or would be) sent. */
  enabled?: boolean;
}

export interface Manifest {
  target: "dash0";
  dataset: string;
  dryRun: boolean;
  results: ImportResult[];
  summary: Record<ImportResult["action"], number> & { readBackMatch: number };
}

export async function importAll(items: { dashboards: DashboardDefinition[]; rules: PrometheusAlertRule[] }, opts: TargetOptions): Promise<Manifest> {
  if (!opts.dryRun && !opts.config) throw new Error("a Dash0 config is required unless --dry-run");
  const client = opts.dryRun ? null : new Dash0Client(opts.config!);
  const results: ImportResult[] = [];

  // Stable keys: a dashboard's origin is metadata.dash0Extensions.id (T5: dd-<datadog id>), upserted with PUT by
  // origin. A check rule's key is its UUID `id` (T6: UUIDv5 of the Datadog monitor id), upserted by the Import API.
  for (const d of items.dashboards) {
    const origin = d.metadata.dash0Extensions?.id;
    if (!origin) throw new Error(`dashboard '${d.metadata.name}' has no metadata.dash0Extensions.id (its origin); re-runs would duplicate it`);
    results.push(
      await one("dashboard", origin, d.metadata.name, d, preflightDashboard(d), opts, client, async (c) => {
        await c.putDashboard(origin, d);
        const back = await c.getDashboard(origin);
        return back ? compareDashboard(d, back) : { state: "missing" };
      }),
    );
  }
  for (const raw of items.rules) {
    const id = raw.id;
    if (!id) throw new Error(`check rule '${raw.name}' has no id; re-runs would duplicate it`);
    const preflight = preflightCheckRule(raw);
    // Only look up the current state for a rule that will actually be sent.
    const enabled = await ruleEnabled(raw, opts, preflight.length ? null : client);
    const r: PrometheusAlertRule = { ...raw, enabled };
    const res = await one("check-rule", id, r.name, r, preflight, opts, client, async (c) => {
      await c.importCheckRule(r);
      const back = await c.getCheckRule(id);
      return back ? compareCheckRule(r, back) : { state: "missing" };
    });
    results.push({ ...res, enabled });
  }

  results.sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1));
  const count = (a: ImportResult["action"]) => results.filter((r) => r.action === a).length;
  const manifest: Manifest = {
    target: "dash0",
    dataset: opts.config?.dataset ?? "default",
    dryRun: opts.dryRun,
    results,
    summary: {
      "dry-run": count("dry-run"),
      imported: count("imported"),
      "rejected-preflight": count("rejected-preflight"),
      failed: count("failed"),
      readBackMatch: results.filter((r) => r.readBack.state === "match").length,
    },
  };
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "import-manifest.json"), canonicalJson(manifest) + "\n");
  return manifest;
}

/**
 * The enabled state to send for a check rule (D-30: no surprise paging, and no surprise silencing either):
 *   - on when asked (opts.enableRules, or the payload itself says enabled: true);
 *   - otherwise, a rule that already exists in Dash0 keeps its current on/off state, so a re-run never switches off
 *     a rule someone turned on (or on one they turned off);
 *   - a new rule starts disabled.
 * T6 payloads carry enabled: false, so the payload's false does not override an explicit enableRules.
 */
async function ruleEnabled(raw: PrometheusAlertRule, opts: TargetOptions, client: Dash0Client | null): Promise<boolean> {
  if (opts.enableRules === true || raw.enabled === true) return true;
  if (!client || !raw.id) return false;
  try {
    const existing = await client.getCheckRule(raw.id);
    return existing?.enabled === true;
  } catch {
    return false; // can't read it: be safe; the import itself will report the problem
  }
}

async function one(
  kind: ImportResult["kind"],
  id: string,
  name: string,
  payload: unknown,
  preflight: string[],
  opts: TargetOptions,
  client: Dash0Client | null,
  send: (c: Dash0Client) => Promise<ReadBack>,
): Promise<ImportResult> {
  const text = canonicalJson(payload);
  const base = { kind, id, name, payloadHash: sha256(text) };
  if (opts.dryRun) {
    const dir = join(opts.outDir, kind === "dashboard" ? "dashboards" : "check-rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), text + "\n");
  }
  if (preflight.length) return { ...base, action: "rejected-preflight", readBack: { state: "skipped" }, errors: preflight };
  if (opts.dryRun || !client) return { ...base, action: "dry-run", readBack: { state: "skipped" }, errors: [] };
  try {
    const readBack = await send(client);
    return { ...base, action: "imported", readBack, errors: [] };
  } catch (e) {
    const err = e instanceof Dash0ApiError ? e : null;
    return {
      ...base,
      action: "failed",
      readBack: { state: "skipped" },
      errors: [e instanceof Error ? e.message : String(e)],
      ...(err?.traceId ? { traceId: err.traceId } : {}),
    };
  }
}

// ---------- read-back comparison ----------

export function compareCheckRule(sent: PrometheusAlertRule, got: PrometheusAlertRule): ReadBack {
  const fields: string[] = [];
  if (got.id !== undefined && got.id !== sent.id) fields.push("id");
  if (got.name !== sent.name) fields.push("name");
  if (squash(got.expression) !== squash(sent.expression)) fields.push("expression");
  for (const k of ["degraded", "failed"] as const) if ((got.thresholds?.[k] ?? null) !== (sent.thresholds?.[k] ?? null)) fields.push(`thresholds.${k}`);
  for (const k of ["interval", "for", "keep_firing_for"] as const) {
    const g = k === "keep_firing_for" ? (got.keep_firing_for ?? (got as { keepFiringFor?: string }).keepFiringFor) : got[k];
    if (sent[k] !== undefined && seconds(g) !== seconds(sent[k])) fields.push(k);
  }
  if (sent.enabled !== undefined && got.enabled !== undefined && got.enabled !== sent.enabled) fields.push("enabled");
  return fields.length ? { state: "mismatch", fields } : { state: "match" };
}

export function compareDashboard(sent: DashboardDefinition, got: DashboardDefinition): ReadBack {
  const fields: string[] = [];
  if (got.metadata?.dash0Extensions?.id !== sent.metadata.dash0Extensions?.id) fields.push("metadata.dash0Extensions.id");
  if (got.metadata?.name !== sent.metadata.name) fields.push("metadata.name");
  const sp = sent.spec.panels, gp = got.spec?.panels ?? {};
  for (const id of Object.keys(sp)) {
    const g = gp[id];
    if (!g) {
      fields.push(`panels.${id}`);
      continue;
    }
    if (g.spec?.plugin?.kind !== sp[id]!.spec.plugin.kind) fields.push(`panels.${id}.plugin.kind`);
    const q = (p: typeof g) => (p.spec?.queries ?? []).map((x) => squash(x.spec?.plugin?.spec?.query ?? "")).join("\n");
    if (q(g) !== q(sp[id]!)) fields.push(`panels.${id}.queries`);
  }
  if (Object.keys(gp).length !== Object.keys(sp).length) fields.push("panels.count");
  return fields.length ? { state: "mismatch", fields } : { state: "match" };
}

/** Dash0 normalises durations ("1m" comes back as "1m0s"), so compare in seconds. */
export function seconds(d: string | undefined): number | null {
  if (d === undefined) return null;
  const unit: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  let matched = "";
  for (const m of d.matchAll(/(\d+)(ms|s|m|h|d|w)/g)) {
    total += Number(m[1]) * unit[m[2]!]!;
    matched += m[0];
  }
  return matched === d ? total : NaN;
}

const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

// ---------- canonical output ----------

/** JSON with object keys sorted recursively, so identical payloads give identical bytes and hashes. */
export function canonicalJson(x: unknown): string {
  return JSON.stringify(sortKeys(x), null, 2);
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]));
  return x;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
