// Datadog ingest: an exported folder or the official API -> IR. The only network I/O on the source side.
// Files are read in sorted order and API results are sorted by id, so the output order is deterministic.
// A file that can't be parsed or recognised becomes a finding and the run continues.
// Exports may be JSON or YAML (.yaml/.yml, the brief's example); both parse to the same document.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parseAllDocuments } from "yaml";
import type { IngestResult, SourceRef } from "../../ir/index.js";
import { alertFromDatadog, dashboardFromDatadog, isDashboardJson, isMonitorJson } from "./normalize.js";

export interface IngestOptions {
  /** Folder of exported JSON or YAML (.json, .yaml, .yml; any depth). */
  input?: string;
  /** Read from the Datadog API instead (needs DD_API_KEY and DD_APP_KEY). */
  api?: boolean;
  only?: "dashboards" | "monitors";
  /** API only. Defaults from env: DD_SITE (datadoghq.eu), DD_API_KEY, DD_APP_KEY. */
  site?: string;
  apiKey?: string;
  appKey?: string;
  fetch?: typeof fetch;
}

export async function ingestDatadog(opts: IngestOptions): Promise<IngestResult> {
  if (!!opts.input === !!opts.api) throw new Error("pass exactly one of --input <dir> or --api");
  return opts.input ? ingestFolder(opts.input, opts.only) : ingestApi(opts);
}

// ---------- folder ----------

export function ingestFolder(dir: string, only?: IngestOptions["only"]): IngestResult {
  const result: IngestResult = { dashboards: [], alerts: [], findings: [] };
  const docs: { rel: string; json: unknown; kind: "dashboard" | "monitor" }[] = [];
  for (const file of exportFiles(dir)) {
    const rel = relative(dir, file).replace(/\\/g, "/");
    const fail = (message: string): void => {
      result.findings.push({ status: "manual", code: "source.unreadable", itemKind: "dashboard", itemId: rel, message });
    };
    let json: unknown;
    try {
      json = parseExport(file, readFileSync(file, "utf8"));
    } catch (e) {
      fail(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (isDashboardJson(json)) {
      if (only !== "monitors") docs.push({ rel, json, kind: "dashboard" });
    } else if (isMonitorJson(json)) {
      if (only !== "dashboards") docs.push({ rel, json, kind: "monitor" });
    } else {
      fail(`${rel}: neither a Datadog dashboard (widgets) nor a monitor (query + type); skipped`);
    }
  }
  // Ids decide the Dash0 target (dashboard origin, check-rule UUID), so two items must never share one: that would
  // import one over the other. Ids from the export win; otherwise the path names the item (folderIds).
  const ids = folderIds(docs.map((d) => ({ rel: d.rel, kind: d.kind, exportId: exportedId(d.json) })));
  for (const [i, d] of docs.entries()) {
    const { id } = ids[i]!; // a renamed duplicate carries its full path in the id, and the report shows the source file
    const ref: SourceRef = { vendor: "datadog", id, origin: d.rel };
    if (d.kind === "dashboard") {
      const { dashboard, findings } = dashboardFromDatadog(d.json as Parameters<typeof dashboardFromDatadog>[0], ref);
      result.dashboards.push(dashboard);
      result.findings.push(...findings);
    } else {
      const { alert, findings } = alertFromDatadog(d.json as Parameters<typeof alertFromDatadog>[0], ref);
      result.alerts.push(alert);
      result.findings.push(...findings);
    }
  }
  return result;
}

/** API exports carry an id; integrations-core assets don't. */
function exportedId(json: unknown): string | undefined {
  const j = json as { id?: unknown; definition?: { id?: unknown } };
  const id = j.id ?? j.definition?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/** Folder names that say what a file is, not which one it is. */
const GENERIC_DIRS = new Set(["assets", "dashboards", "dashboard", "monitors", "monitor", "export", "exports", "datadog"]);

/**
 * One id per item, unique per kind, the same for the same folder:
 *   - the export's own id when it has one (API exports);
 *   - else the path without generic folders, joined by "__": dashboards/redisdb__overview.json -> redisdb__overview,
 *     redisdb/assets/dashboards/overview.json -> redisdb__overview (integrations-core: 71 files are overview.json);
 *   - if two items still share an id, the later ones (in path order) take their full path, and say so (clash).
 */
export function folderIds(items: { rel: string; kind: string; exportId?: string }[]): { id: string; clash?: string }[] {
  const base = items.map((it) => {
    if (it.exportId) return it.exportId;
    const parts = it.rel.replace(/\.(json|ya?ml)$/i, "").split("/");
    const name = parts.pop()!;
    return [...parts.filter((p) => !GENERIC_DIRS.has(p.toLowerCase())), name].join("__");
  });
  const seen = new Map<string, number>();
  return items.map((it, i) => {
    const key = `${it.kind}\u0000${base[i]}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) return { id: base[i]! };
    return { id: it.rel.replace(/\.(json|ya?ml)$/i, "").replace(/[^A-Za-z0-9_-]+/g, "__"), clash: base[i]! };
  });
}

const YAML_EXT = /\.ya?ml$/i;

/**
 * One export file -> one document. JSON goes through JSON.parse. YAML uses the yaml package's default YAML 1.2 core
 * schema, so the result is plain JSON data: no yes/no booleans, no dates, no custom tags. Duplicate keys and
 * several documents in one file are errors rather than a silent choice, because JSON.parse would keep the last key
 * and we would drop the other documents.
 */
export function parseExport(file: string, raw: string): unknown {
  // A leading UTF-8 byte order mark (editors on Windows add one) is not content: JSON.parse rejects it.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!YAML_EXT.test(file)) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const docs = parseAllDocuments(text, { uniqueKeys: true, prettyErrors: false });
  if (docs.length === 0) return null; // empty file: neither a dashboard nor a monitor, reported as unrecognised
  const bad = docs.flatMap((d) => d.errors);
  if (bad.length) throw new Error(`not valid YAML (${bad[0]!.message.split("\n")[0]})`);
  if (docs.length > 1) throw new Error(`${docs.length} YAML documents in one file; export one dashboard or monitor per file`);
  return docs[0]!.toJS({ maxAliasCount: 100 });
}

function exportFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(json|ya?ml)$/i.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// ---------- API ----------

export async function ingestApi(opts: IngestOptions, env: NodeJS.ProcessEnv = process.env): Promise<IngestResult> {
  const site = opts.site ?? env.DD_SITE ?? "datadoghq.eu";
  const apiKey = opts.apiKey ?? env.DD_API_KEY;
  const appKey = opts.appKey ?? env.DD_APP_KEY;
  if (!apiKey || !appKey) throw new Error("DD_API_KEY and DD_APP_KEY are required for --api (Datadog: Organization Settings -> API / Application Keys)");
  if (!/^[a-z0-9.-]+$/.test(site)) throw new Error(`invalid DD_SITE '${site}'`);
  const base = `https://api.${site}`;
  const f = opts.fetch ?? fetch;
  const get = async <T>(path: string): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const res = await f(new URL(path, base), { headers: { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey, Accept: "application/json" } });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 429 && attempt < 3) {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(reset) ? reset * 1000 : 1000 * 2 ** attempt, 30_000)));
        continue;
      }
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Datadog GET ${path} -> ${res.status}: ${body}`); // keys are headers only, never in the message
    }
  };

  const result: IngestResult = { dashboards: [], alerts: [], findings: [] };
  const fail = (itemId: string, e: unknown): void => {
    result.findings.push({ status: "manual", code: "source.unreadable", itemKind: "dashboard", itemId, message: e instanceof Error ? e.message : String(e) });
  };
  if (opts.only !== "monitors") {
    const list = await get<{ dashboards?: { id: string }[] }>("/api/v1/dashboard");
    for (const { id } of [...(list.dashboards ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      try {
        const json = await get<unknown>(`/api/v1/dashboard/${encodeURIComponent(id)}`);
        const { dashboard, findings } = dashboardFromDatadog(json, { vendor: "datadog", id, origin: "api", url: `https://app.${site}/dashboard/${id}` });
        result.dashboards.push(dashboard);
        result.findings.push(...findings);
      } catch (e) {
        fail(`dashboard ${id}`, e);
      }
    }
  }
  if (opts.only !== "dashboards") {
    const monitors: unknown[] = [];
    for (let page = 0; ; page++) {
      const batch = await get<unknown[]>(`/api/v1/monitor?page=${page}&page_size=100`);
      monitors.push(...batch);
      if (batch.length < 100) break;
    }
    const idOf = (m: unknown) => String((m as { id?: unknown }).id ?? "");
    for (const m of monitors.sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1))) {
      const id = idOf(m);
      try {
        const { alert, findings } = alertFromDatadog(m, { vendor: "datadog", id, origin: "api", url: `https://app.${site}/monitors/${id}` });
        result.alerts.push(alert);
        result.findings.push(...findings);
      } catch (e) {
        fail(`monitor ${id}`, e);
      }
    }
  }
  return result;
}

