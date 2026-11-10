// Dash0 smoke test (knowledge base D-33; the 18:00 gate): import ONE dashboard with a real PromQL panel and ONE
// check rule, read both back, and print the manifest. The payloads are hand-written here, not translated: the point
// is to prove the Dash0 side (auth, payload shape, ids, read-back) before the translators are wired in.
//
//   npx tsx --env-file=.env scripts/dash0-smoke.ts             dry run: writes out/smoke/, no network
//   npx tsx --env-file=.env scripts/dash0-smoke.ts --live      imports into Dash0 (rule DISABLED)
//   npx tsx --env-file=.env scripts/dash0-smoke.ts --live --enable-rules
//
// Needs DASH0_API_URL, DASH0_AUTH_TOKEN and optionally DASH0_DATASET in .env (see .env.example). The token is never printed.
import { configFromEnv, importAll, type DashboardDefinition, type PrometheusAlertRule } from "../src/targets/dash0/index.js";

const live = process.argv.includes("--live");
const enableRules = process.argv.includes("--enable-rules");

const used = '{otel_metric_name="redis.memory.used"}';
const max = '{otel_metric_name="redis.maxmemory"}';

const dashboard: DashboardDefinition = {
  kind: "Dashboard",
  metadata: { name: "[smoke] Redis memory", dash0Extensions: { id: "dd-smoke-redis-memory", tags: ["dd2dash0-smoke"] } },
  spec: {
    display: { name: "[smoke] Redis memory", description: "dd2dash0 smoke test: delete freely" },
    duration: "1h",
    refreshInterval: "30s",
    variables: [],
    panels: {
      used: {
        kind: "Panel",
        spec: {
          display: { name: "Percent used memory" },
          plugin: { kind: "TimeSeriesChart", spec: {} },
          queries: [
            {
              kind: "TimeSeriesQuery",
              spec: { plugin: { kind: "PrometheusTimeSeriesQuery", spec: { query: `100 * avg(avg_over_time(${used}[$__interval])) / avg(avg_over_time(${max}[$__interval]))` } } },
            },
          ],
        },
      },
      note: {
        kind: "Panel",
        spec: { display: { name: "About" }, plugin: { kind: "Markdown", spec: { text: "Imported by the dd2dash0 smoke test." } } },
      },
    },
    layouts: [
      {
        kind: "Grid",
        spec: {
          items: [
            { x: 0, y: 0, width: 16, height: 8, content: { $ref: "#/spec/panels/used" } },
            { x: 16, y: 0, width: 8, height: 8, content: { $ref: "#/spec/panels/note" } },
          ],
        },
      },
    ],
  },
};

// The exact form of fixtures/datadog/monitors/redisdb__high_mem.json, proven by the reference evaluator (PR #2, maths.md §5):
// avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90, warning 70.
const rule: PrometheusAlertRule = {
  id: "7c0b5f2e-6a7d-5c1e-9b1a-0d2d5e0a51f0", // fixed UUID for the smoke rule (Import Check Rule upserts by UUID id)
  name: "[smoke] [Redis] High memory consumption",
  expression: `avg_over_time((100 * avg(avg_over_time(${used}[1m])) / avg(avg_over_time(${max}[1m])))[5m:1m]) > $__threshold`,
  thresholds: { failed: 90, degraded: 70 },
  interval: "1m",
  for: "0s",
  annotations: { summary: "Redis memory usage is high", description: "dd2dash0 smoke test: delete freely" },
  labels: { source: "dd2dash0-smoke" },
};

const config = live ? configFromEnv() : undefined;
const manifest = await importAll({ dashboards: [dashboard], rules: [rule] }, { dryRun: !live, outDir: "out/smoke", enableRules, ...(config ? { config } : {}) });
for (const r of manifest.results) {
  console.log(`${r.kind.padEnd(10)} ${r.id.padEnd(24)} ${r.action.padEnd(18)} read-back: ${r.readBack.state}${"fields" in r.readBack ? ` (${r.readBack.fields.join(", ")})` : ""}${r.traceId ? `  traceId ${r.traceId}` : ""}`);
  for (const e of r.errors) console.log(`  ! ${e}`);
}
console.log(`\nmanifest: out/smoke/import-manifest.json  ${live ? `(dataset ${manifest.dataset})` : "(dry run: add --live to import)"}`);
process.exit(manifest.results.every((r) => r.action === (live ? "imported" : "dry-run") && (!live || r.readBack.state === "match")) ? 0 : 1);
