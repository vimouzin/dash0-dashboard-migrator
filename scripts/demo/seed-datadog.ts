// T10: put the demo's source assets into the Datadog EU trial: the Redis overview dashboard and the high_mem monitor,
// straight from the fixtures. Idempotent: finds existing ones by title/name plus our marker and updates them.
//
//   npx tsx --env-file=.env scripts/demo/seed-datadog.ts [--dry-run]
//
// Needs DD_API_KEY and DD_APP_KEY (DD_SITE defaults to datadoghq.eu). Keys are only sent as headers, never printed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MARKER = "[dd2dash0-demo]";
const TAG = "dd2dash0-demo";
const root = fileURLToPath(new URL("../../", import.meta.url));
const DASHBOARD = `${root}fixtures/datadog/dashboards/redisdb__overview.json`;
const MONITOR = `${root}fixtures/datadog/monitors/redisdb__high_mem.json`;
const OUT = `${root}out/demo/datadog-ids.json`;

type Json = Record<string, unknown>;

export function dashboardBody(fixture: Json): Json {
  const { id: _id, author_handle: _a, author_name: _n, created_at: _c, modified_at: _m, url: _u, ...rest } = fixture;
  const description = String(rest.description ?? "");
  return { ...rest, description: description.includes(MARKER) ? description : `${description}\n\n${MARKER}`.trim() };
}

/** A notification handle anywhere in the message: the demo must never page anyone. */
export const HANDLE = /(^|[\s(])@[A-Za-z0-9][A-Za-z0-9_.+-]*/;

export function monitorBody(fixture: Json): Json {
  const d = ((fixture.definition as Json | undefined) ?? fixture) as Json;
  const message = String(d.message ?? "");
  if (HANDLE.test(message)) throw new Error("the monitor message contains an @handle; refusing to seed a monitor that can notify someone");
  const tags = [...new Set([...((d.tags as string[] | undefined) ?? []), TAG])].sort();
  const body: Json = { name: d.name, type: d.type, query: d.query, message, options: d.options ?? {}, tags };
  if (d.priority !== null && d.priority !== undefined) body.priority = d.priority;
  return body;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const site = process.env.DD_SITE || "datadoghq.eu";
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APP_KEY;
  if (!apiKey || !appKey) throw new Error("DD_API_KEY and DD_APP_KEY must be set (use --env-file=.env)");
  const base = `https://api.${site}`;

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey, "Content-Type": "application/json", Accept: "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };

  const dash = dashboardBody(JSON.parse(readFileSync(DASHBOARD, "utf8")) as Json);
  const mon = monitorBody(JSON.parse(readFileSync(MONITOR, "utf8")) as Json);

  // Dashboard: match on title and our marker in the description.
  const list = await call<{ dashboards?: { id: string; title: string; description?: string | null }[] }>("GET", "/api/v1/dashboard");
  const existingDash = (list.dashboards ?? []).find((d) => d.title === dash.title && (d.description ?? "").includes(MARKER));
  let dashId: string;
  if (dryRun) {
    dashId = existingDash?.id ?? "(new)";
    console.log(`dry run: would ${existingDash ? `update dashboard ${existingDash.id}` : "create the dashboard"} "${dash.title}"`);
  } else if (existingDash) {
    dashId = (await call<{ id: string }>("PUT", `/api/v1/dashboard/${existingDash.id}`, dash)).id;
    console.log(`updated dashboard ${dashId} "${dash.title}"`);
  } else {
    dashId = (await call<{ id: string }>("POST", "/api/v1/dashboard", dash)).id;
    console.log(`created dashboard ${dashId} "${dash.title}"`);
  }

  // Monitor: match on name and our tag.
  const mons = await call<{ id: number; name: string; tags?: string[] }[]>("GET", `/api/v1/monitor?monitor_tags=${encodeURIComponent(TAG)}`);
  const existingMon = mons.find((m) => m.name === mon.name && (m.tags ?? []).includes(TAG));
  let monId: number | string;
  if (dryRun) {
    monId = existingMon?.id ?? "(new)";
    console.log(`dry run: would ${existingMon ? `update monitor ${existingMon.id}` : "create the monitor"} "${mon.name}"`);
  } else if (existingMon) {
    monId = (await call<{ id: number }>("PUT", `/api/v1/monitor/${existingMon.id}`, mon)).id;
    console.log(`updated monitor ${monId} "${mon.name}"`);
  } else {
    monId = (await call<{ id: number }>("POST", "/api/v1/monitor", mon)).id;
    console.log(`created monitor ${monId} "${mon.name}"`);
  }

  const app = `https://app.${site}`;
  const ids = {
    site,
    dashboard: { id: dashId, title: dash.title, url: `${app}/dashboard/${dashId}` },
    monitor: { id: monId, name: mon.name, url: `${app}/monitors/${monId}` },
  };
  if (!dryRun) {
    mkdirSync(`${root}out/demo`, { recursive: true });
    writeFileSync(OUT, JSON.stringify(ids, null, 2) + "\n");
  }
  console.log(`\nDatadog dashboard: ${ids.dashboard.url}\nDatadog monitor:   ${ids.monitor.url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`seed-datadog: ${e.message}`);
    process.exit(1);
  });
}
