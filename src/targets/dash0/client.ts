// Minimal Dash0 API client: import, then read back. The only module besides ingest (T2) that does network I/O.
// `fetch` is injectable so tests never touch the network. The token is never included in errors or logs.
import type { Dash0ErrorBody, DashboardDefinition, PrometheusAlertRule } from "./schema.js";

export interface Dash0Config {
  /** e.g. https://api.eu-west-1.aws.dash0.com (Dash0 Settings -> Endpoints). */
  apiUrl: string;
  token: string;
  /** Dataset slug; Dash0 uses "default" when omitted. */
  dataset?: string;
  fetch?: typeof fetch;
  /** Retries on 429 / 502 / 503 / 504. Default 3. */
  maxRetries?: number;
  /** Injected for tests; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class Dash0ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
    readonly traceId?: string,
  ) {
    super(message);
  }
}

/** Reads DASH0_API_URL, DASH0_AUTH_TOKEN, DASH0_DATASET (see .env.example). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Dash0Config {
  const apiUrl = env.DASH0_API_URL?.trim();
  const token = env.DASH0_AUTH_TOKEN?.trim();
  if (!apiUrl) throw new Error("DASH0_API_URL is not set (copy .env.example to .env)");
  if (!token) throw new Error("DASH0_AUTH_TOKEN is not set (create one in Dash0: Settings -> Auth Tokens)");
  return { apiUrl, token, ...(env.DASH0_DATASET?.trim() ? { dataset: env.DASH0_DATASET.trim() } : {}) };
}

export class Dash0Client {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly cfg: Dash0Config) {
    if (!/^https:\/\//.test(cfg.apiUrl)) throw new Error("DASH0_API_URL must be an https URL");
    this.f = cfg.fetch ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // Idempotent re-runs, as probed live on Dash0 (2026-11-07, dash0-team docs/research/dash0.md):
  // - Check rules: the Import Check Rule API (named by the brief) upserts by `id` when the id is a UUID. T6 sets a
  //   deterministic UUIDv5 of the Datadog monitor id. A non-UUID id ("dd-…") is rejected with 400.
  // - Dashboards: the Import Dashboard API ignores an origin (two imports = two dashboards), so dashboards are
  //   upserted with PUT /api/dashboards/{origin}, which keeps exactly one per origin.
  // Read-back is by the same key (rule id / dashboard origin).
  importCheckRule(r: PrometheusAlertRule): Promise<PrometheusAlertRule> {
    return this.call("POST", "/api/import/check-rule", r);
  }
  putDashboard(origin: string, d: DashboardDefinition): Promise<DashboardDefinition> {
    return this.call("PUT", `/api/dashboards/${encodeURIComponent(origin)}`, d);
  }
  getDashboard(origin: string): Promise<DashboardDefinition | null> {
    return this.call<DashboardDefinition>("GET", `/api/dashboards/${encodeURIComponent(origin)}`).catch(notFoundAsNull);
  }
  getCheckRule(id: string): Promise<PrometheusAlertRule | null> {
    return this.call<PrometheusAlertRule>("GET", `/api/alerting/check-rules/${encodeURIComponent(id)}`).catch(notFoundAsNull);
  }

  private async call<T>(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.cfg.apiUrl);
    if (this.cfg.dataset) url.searchParams.set("dataset", this.cfg.dataset);
    const max = this.cfg.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < max) {
        await this.sleep(retryDelayMs(res.headers.get("retry-after"), attempt));
        continue;
      }
      throw await toApiError(res, method, path);
    }
  }
}

/** Retry-After in seconds (or an HTTP date); otherwise exponential backoff 1 s, 2 s, 4 s, capped at 30 s. */
export function retryDelayMs(retryAfter: string | null, attempt: number, now = Date.now()): number {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 30_000);
    const t = Date.parse(retryAfter);
    if (Number.isFinite(t)) return Math.min(Math.max(t - now, 0), 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

async function toApiError(res: Response, method: string, path: string): Promise<Dash0ApiError> {
  let body: Partial<Dash0ErrorBody> | null = null;
  const text = await res.text().catch(() => "");
  try {
    body = JSON.parse(text) as Dash0ErrorBody;
  } catch {
    /* not JSON */
  }
  const e = body?.error;
  const msg = e?.message ?? (text.slice(0, 300) || res.statusText);
  return new Dash0ApiError(`${method} ${path} -> ${res.status}: ${msg}`, res.status, e?.type, e?.traceId);
}

function notFoundAsNull(e: unknown): null {
  if (e instanceof Dash0ApiError && e.status === 404) return null;
  throw e;
}
