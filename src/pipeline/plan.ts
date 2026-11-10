// `dd2dash0 plan` (CONTRACT-003 §3-4): translate everything, import nothing, and write a plan directory whose
// plan.lock hash a review binds to. It reuses migrate() in dry-run mode, so plan and migrate translate identically.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportToEvents } from "../report/events.js";
import { writeReport } from "../report/index.js";
import type { ResolvedConfig } from "./config.js";
import { migrate, type MigrateResult } from "./migrate.js";
import { writeLock } from "./plan-lock.js";

export interface PlanOptions {
  config: ResolvedConfig;
  /** Where the plan directory is written. */
  outDir: string;
  /** mappings/ directory; config.mappings wins when set. */
  defaultMappingsDir: string;
  /** Source path as resolved for this machine (config.source.path stays as given, so the lock is portable). */
  resolvedInput?: string;
  only?: "dashboards" | "monitors";
  version: string;
}

export interface PlanResult {
  result: MigrateResult;
  planHash: string;
  files: { json: string; md: string };
}

export { catalogHash } from "../report/build.js";
import { catalogHash } from "../report/build.js";

export async function runPlan(o: PlanOptions): Promise<PlanResult> {
  const src = o.config.source;
  const result = await migrate({
    ingest: { ...(src.kind === "folder" ? { input: o.resolvedInput ?? src.path } : { api: true }), ...(o.only ? { only: o.only } : {}) },
    mappingsDir: o.config.mappings ?? o.defaultMappingsDir,
    ...(o.config.channels ? { channelsFile: o.config.channels } : {}),
    outDir: o.outDir,
    mode: "dry-run",
    enableRules: o.config.enableRules,
    version: o.version,
    source: src.kind === "folder" ? { kind: "folder", site: null, path: src.path } : { kind: "api", site: src.site, path: null },
    config: { ...o.config, ...(o.only ? { only: o.only } : {}) } as unknown as Record<string, unknown>,
  });
  const files = writeReport(result.report, o.outDir);
  writeFileSync(join(o.outDir, "events.jsonl"), reportToEvents(result.report).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const { planHash } = writeLock(o.outDir, {
    inputHash: result.report.run.inputHash,
    catalogHash: catalogHash(),
    config: { ...o.config, ...(o.only ? { only: o.only } : {}) } as unknown as Record<string, unknown>,
  });
  return { result, planHash, files };
}
