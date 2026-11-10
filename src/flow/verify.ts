// Step 5b of the guided flow: do the migrated queries return data in Dash0 when Datadog has data for the original?
// PRESENCE only, last 1 h on both sides; values are not compared (rollups/units differ on a fresh collector).
// Dash0 side: GET /api/prometheus/api/v1/query_range (placeholders replaced as in scripts/returns-data.ts).
// Datadog side: GET /api/v1/query on the original metric query (as in Ali's scripts/parity.ts, #57).
// Per item:
//   live          Dash0 returns series
//   missing       Datadog has data, Dash0 has none   -> FAILURE (cause hint from the item's findings)
//   no-data       neither side has data in the window (or Datadog can't be asked) -> not a failure
//   error         Dash0 rejected the query         -> FAILURE
//   n/a           no query (placeholder, note, image)
// Read-only. Time dependent, so never part of the deterministic report hash.
import type { ReportItem } from "../report/types.js";

export type Live = "live" | "missing" | "no-data" | "error" | "n/a";
export interface LiveResult {
  live: Live;
  cause?: string;
  error?: string;
}

export interface VerifyEnv {
  dash0: { apiUrl: string; token: string; dataset: string };
  /** Absent: Datadog isn't asked (folder input without keys); empty Dash0 results become no-data. */
  datadog?: { site: string; apiKey: string; appKey: string };
  windowSeconds?: number;
  concurrency?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Dashboard/alert placeholders -> concrete values; alerts lose their trailing threshold comparison. */
export function prepareDash0(promql: string, kind: "panel" | "alert"): string {
  let q = promql;
  if (kind === "alert") q = q.replace(/\s*(?:>=|>|<=|<)\s*\$__threshold\s*$/, "");
  return q
    .replace(/\$__rate_interval/g, "5m")
    .replace(/\$__interval/g, "1m")
    .replace(/\$__range/g, "1h")
    .replace(/\$__threshold/g, "0")
    .replace(/\$(?!__)[A-Za-z_]\w*/g, ".*");
}

/**
 * A Datadog source query -> a metric query /api/v1/query accepts, or null when it isn't a metric query
 * (log/event/APM searches). Monitor form `avg(last_5m):<q> > 0.9` loses its window and comparison.
 */
export function datadogMetricQuery(q: string): string | null {
  let s = q.trim();
  const mon = /^[a-z_]+\(last_\w+\):(.*)$/i.exec(s);
  if (mon) s = mon[1]!.replace(/\s*(?:>=|<=|>|<|==|!=)\s*-?[\d.]+\s*$/, "").trim();
  if (/^(logs|events|rum|trace|apm|process|network)\(/i.test(s)) return null;
  // A metric query has an aggregator and a metric: avg:redis.mem.used{...}
  return /(?:^|\()(?:avg|sum|min|max|count):[\w.]+/.test(s) ? s : null;
}

/** Why an empty Dash0 result is likely (a hint from the item's findings, not a proof). */
export function causeOf(reasonCodes: string[]): string {
  if (reasonCodes.includes("metric.unmapped")) return "metric not in the mapping table (kept its Datadog name), so Dash0 has no series by that name";
  if (reasonCodes.includes("metric.approximate")) return "approximate metric mapping: check the stand-in OTel metric exists";
  if (reasonCodes.some((c) => c.startsWith("tag.") || c === "label.default")) return "a label kept its Datadog name and may not exist on the Dash0 series";
  return "the metric isn't arriving in Dash0 (collector/receiver not sending it), or its labels differ";
}

type Presence = { has: boolean | null; error?: string };

async function withRetry(f: typeof fetch, url: string | URL, init: RequestInit, sleep: (ms: number) => Promise<void>): Promise<Response | Error> {
  let last: Error = new Error("no response");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await f(url, init);
      if (r.status === 429 || r.status >= 500) {
        last = new Error(`HTTP ${r.status}`);
        const ra = Number(r.headers.get("retry-after") ?? r.headers.get("x-ratelimit-reset"));
        await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt, 15_000));
        continue;
      }
      return r;
    } catch (e) {
      last = e as Error;
      await sleep(500 * 2 ** attempt);
    }
  }
  return last;
}

export async function verifyLive(items: ReportItem[], env: VerifyEnv): Promise<Map<string, LiveResult>> {
  const f = env.fetch ?? fetch;
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = Math.floor((env.now ?? (() => Date.now() / 1000))());
  const start = end - (env.windowSeconds ?? 3600);
  const d0Cache = new Map<string, Promise<Presence>>();
  const ddCache = new Map<string, Promise<Presence>>();

  const dash0 = (q: string) => {
    if (!d0Cache.has(q))
      d0Cache.set(
        q,
        (async (): Promise<Presence> => {
          const url = new URL("/api/prometheus/api/v1/query_range", env.dash0.apiUrl);
          for (const [k, v] of Object.entries({ dataset: env.dash0.dataset, query: q, start: String(start), end: String(end), step: "60" })) url.searchParams.set(k, v);
          const r = await withRetry(f, url, { headers: { Authorization: `Bearer ${env.dash0.token}`, Accept: "application/json" } }, sleep);
          if (r instanceof Error) return { has: null, error: r.message };
          const j = (await r.json().catch(() => ({}))) as { status?: string; data?: { result?: { values?: unknown[] }[] }; error?: string; message?: string };
          if (r.status !== 200 || j.status !== "success") return { has: null, error: String(j.error ?? j.message ?? `HTTP ${r.status}`).slice(0, 200) };
          return { has: (j.data?.result ?? []).some((s) => !Array.isArray(s.values) || s.values.length > 0) };
        })(),
      );
    return d0Cache.get(q)!;
  };
  const datadog = (q: string) => {
    if (!env.datadog) return Promise.resolve<Presence>({ has: null });
    const dd = env.datadog;
    if (!ddCache.has(q))
      ddCache.set(
        q,
        (async (): Promise<Presence> => {
          const url = new URL(`https://api.${dd.site}/api/v1/query`);
          for (const [k, v] of Object.entries({ from: String(start), to: String(end), query: q })) url.searchParams.set(k, v);
          const r = await withRetry(f, url, { headers: { "DD-API-KEY": dd.apiKey, "DD-APPLICATION-KEY": dd.appKey, Accept: "application/json" } }, sleep);
          if (r instanceof Error || !r.ok) return { has: null };
          const j = (await r.json().catch(() => ({}))) as { series?: { pointlist?: [number, number | null][] }[] };
          return { has: (j.series ?? []).some((s) => (s.pointlist ?? []).some((p) => p[1] !== null)) };
        })(),
      );
    return ddCache.get(q)!;
  };

  const one = async (i: ReportItem): Promise<LiveResult> => {
    if ((i.kind !== "panel" && i.kind !== "alert") || i.promql.length === 0) return { live: "n/a" };
    const d0 = await Promise.all(i.promql.map((q) => dash0(prepareDash0(q, i.kind as "panel" | "alert"))));
    const err = d0.find((p) => p.has === null);
    if (err) return { live: "error", error: err.error ?? "query failed" };
    if (d0.some((p) => p.has)) return { live: "live" };
    const ddQueries = i.source_queries.map(datadogMetricQuery).filter((q): q is string => q !== null);
    const dd = await Promise.all(ddQueries.map(datadog));
    if (dd.some((p) => p.has)) return { live: "missing", cause: causeOf(i.reason_codes) };
    return { live: "no-data" };
  };

  // Bounded concurrency over items (queries are also de-duplicated by the caches).
  const out = new Map<string, LiveResult>();
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, env.concurrency ?? 4) }, async () => {
    for (let i = queue.shift(); i; i = queue.shift()) out.set(i.id, await one(i));
  });
  await Promise.all(workers);
  return out;
}
