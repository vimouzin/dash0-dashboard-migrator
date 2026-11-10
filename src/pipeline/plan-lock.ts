// The plan directory's lock (CONTRACT-003 §4): every report and payload file with its sha256, plus what produced
// them. sha256(plan.lock bytes) is the PLAN HASH that a review binds to, so a hand edit to any file voids the review.
// Pure file I/O, no network. Not wired into the CLI yet (waits for merge train 2 and the agreed contract).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { canonicalJson } from "../targets/dash0/index.js";

export const LOCK_FILE = "plan.lock";
export const PLAN_SCHEMA = "dd2dash0.plan/v1";

/** Written next to the plan by later steps; never part of the lock. */
const EXCLUDED_FILES = new Set([LOCK_FILE, "review.json"]);
const EXCLUDED_DIRS = new Set(["apply"]);

export interface PlanLock {
  schema: typeof PLAN_SCHEMA;
  inputHash: string;
  catalogHash: string;
  config: Record<string, unknown>;
  /** Relative POSIX path -> sha256 of the file's bytes. */
  files: Record<string, string>;
}

export type PlanMeta = Pick<PlanLock, "inputHash" | "catalogHash" | "config">;

const hashBytes = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Files the lock covers, as sorted relative POSIX paths (stable across machines). */
export function listPlanFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = relative(dir, full).split(sep).join("/");
      if (statSync(full).isDirectory()) {
        if (d === dir && EXCLUDED_DIRS.has(name)) continue;
        walk(full);
      } else if (!(d === dir && EXCLUDED_FILES.has(name))) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

export function buildLock(dir: string, meta: PlanMeta): PlanLock {
  const files: Record<string, string> = {};
  for (const rel of listPlanFiles(dir)) files[rel] = hashBytes(readFileSync(join(dir, rel)));
  return { schema: PLAN_SCHEMA, inputHash: meta.inputHash, catalogHash: meta.catalogHash, config: meta.config, files };
}

/** Write plan.lock (canonical JSON + newline) and return the plan hash. */
export function writeLock(dir: string, meta: PlanMeta): { lock: PlanLock; planHash: string } {
  const lock = buildLock(dir, meta);
  const text = canonicalJson(lock) + "\n";
  writeFileSync(join(dir, LOCK_FILE), text);
  return { lock, planHash: hashBytes(text) };
}

export function readLock(dir: string): { lock: PlanLock; planHash: string } {
  const path = join(dir, LOCK_FILE);
  if (!existsSync(path)) throw new Error(`${path} not found: not a plan directory (run 'dd2dash0 plan' first)`);
  const text = readFileSync(path, "utf8");
  const lock = JSON.parse(text) as PlanLock;
  if (lock.schema !== PLAN_SCHEMA) throw new Error(`${path}: unknown plan schema '${String(lock.schema)}'`);
  return { lock, planHash: hashBytes(text) };
}

export type PlanCheck = { ok: true; planHash: string; lock: PlanLock } | { ok: false; planHash: string; problems: string[] };

/** Recompute every file's hash against the lock: changed, missing and unexpected files are problems. */
export function verifyPlan(dir: string): PlanCheck {
  const { lock, planHash } = readLock(dir);
  const problems: string[] = [];
  const now = new Set(listPlanFiles(dir));
  for (const [rel, h] of Object.entries(lock.files)) {
    if (!now.has(rel)) problems.push(`missing: ${rel}`);
    else if (hashBytes(readFileSync(join(dir, rel))) !== h) problems.push(`changed since plan: ${rel}`);
  }
  for (const rel of now) if (!(rel in lock.files)) problems.push(`not in plan.lock: ${rel}`);
  return problems.length ? { ok: false, planHash, problems } : { ok: true, planHash, lock };
}
