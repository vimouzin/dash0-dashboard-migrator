// logs.stream: Datadog log_stream / list_stream -> Dash0 LogTable filters. One test per construct, plus the
// fixture streams end to end through migrate (T2 -> T5 -> T7 preflight -> T8 report).
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Panel } from "../../src/ir/index.js";
import { translateLogStream } from "../../src/translate/dashboard/index.js";
import { BODY_KEY, RESERVED_FILTER_KEYS, SEVERITY_KEY } from "../../src/translate/dashboard/logtable.js";
import { loadLogAttributes } from "../../src/translate/logs/index.js";
import { migrate } from "../../src/pipeline/migrate.js";
import { preflightDashboard } from "../../src/targets/dash0/index.js";

const ROOT = join(import.meta.dirname, "..", "..");
const attributes = loadLogAttributes(join(ROOT, "mappings", "log-attributes.yaml"));

/** A list_stream panel in T2's IR shape. */
const stream = (query_string: string, extra: Record<string, unknown> = {}, columns?: unknown[]): Panel => ({
  id: "w-1",
  kind: "logs",
  sourceType: "list_stream",
  layout: null,
  requests: [{ queries: [{ vendor: "datadog", refId: "q0", dataSource: "logs_stream", expr: query_string, raw: { query: { data_source: "logs_stream", query_string, ...extra }, ...(columns && { columns }) } }], formulas: [] }],
  options: {},
  original: {},
});
const t = (q: string, extra?: Record<string, unknown>, columns?: unknown[]) => translateLogStream(stream(q, extra, columns), attributes, { scope: { tag: null } }, "dd-dash-x/w-1");
const filters = (q: string) => t(q).spec?.filters ?? [];

describe("log search -> LogTable filters", () => {
  it("an empty search or * shows every log, with no filters", () => {
    expect(t("").spec).toEqual({});
    expect(t("*").spec).toEqual({});
    expect(t("*").rules).toEqual(["logs.stream"]);
  });

  it("reserved keys map to OTel resource attributes", () => {
    expect(filters("service:api host:web-1 env:prod version:1.2")).toEqual([
      { key: "service.name", operator: "is", value: "api" },
      { key: "host.name", operator: "is", value: "web-1" },
      { key: "deployment.environment.name", operator: "is", value: "prod" },
      { key: "service.version", operator: "is", value: "1.2" },
    ]);
  });

  it("source is kept as a source attribute, under A.log-source", () => {
    const r = t("source:redis");
    expect(r.spec?.filters).toEqual([{ key: "source", operator: "is", value: "redis" }]);
    expect(r.rules).toContain("log.match.reserved.approx");
    expect(r.assumptions).toContain("A.log-source");
  });

  it("facets drop the @ and apply the semconv renames", () => {
    expect(filters("@http.method:GET @db.system:postgresql")).toEqual([
      { key: "http.method", operator: "is", value: "GET" },
      { key: "db.system.name", operator: "is", value: "postgresql" },
    ]);
  });

  it("status maps to the OTel severity range", () => {
    expect(filters("status:error")).toEqual([{ key: SEVERITY_KEY, operator: "is", value: "ERROR" }]);
    expect(filters("status:(warn OR warning)")).toEqual([{ key: SEVERITY_KEY, operator: "is", value: "WARN" }]);
    expect(filters("status:(error OR critical)")).toEqual([{ key: SEVERITY_KEY, operator: "is_one_of", values: ["ERROR", "FATAL"] }]);
    expect(t("status:critical").assumptions).toContain("A.severity-map");
  });

  it("several values on one key become is_one_of (also key:a OR key:b)", () => {
    expect(filters("@http.status_code:(404 OR 500)")).toEqual([{ key: "http.status_code", operator: "is_one_of", values: ["404", "500"] }]);
    expect(filters("service:a OR service:b")).toEqual([{ key: "service.name", operator: "is_one_of", values: ["a", "b"] }]);
  });

  it("wildcards use the string operators, or an anchored regex", () => {
    expect(filters("host:web-*")).toEqual([{ key: "host.name", operator: "starts_with", value: "web-" }]);
    expect(filters("host:*-prod")).toEqual([{ key: "host.name", operator: "ends_with", value: "-prod" }]);
    expect(filters("host:*web*")).toEqual([{ key: "host.name", operator: "contains", value: "web" }]);
    expect(filters("host:web-*-prod")).toEqual([{ key: "host.name", operator: "matches", value: "^(web-.*-prod)$" }]);
    expect(filters("host:(a* OR b)")).toEqual([{ key: "host.name", operator: "matches", value: "^(a.*|b)$" }]);
    expect(filters("@path:/api.v1*")).toEqual([{ key: "path", operator: "starts_with", value: "/api.v1" }]);
    expect(filters("@path:*.v1*x")).toEqual([{ key: "path", operator: "matches", value: "^(.*\\.v1.*x)$" }]);
  });

  it("quoted values are literal", () => {
    // An escaped a\*b reaches T5 as a wildcard: parseLogSearch drops the backslash (reported to T12).
    expect(filters('@msg:"a*b"')).toEqual([{ key: "msg", operator: "is", value: "a*b" }]);
  });

  it("key:* is is_set; negations use the negative operators under A.logtable-negation", () => {
    expect(filters("@user.id:*")).toEqual([{ key: "user.id", operator: "is_set" }]);
    expect(filters("-@user.id:*")).toEqual([{ key: "user.id", operator: "is_not_set" }]);
    const r = t("-host:web-* -status:info -service:(a OR b) -@x:*y*");
    expect(r.spec?.filters).toEqual([
      { key: "host.name", operator: "does_not_start_with", value: "web-" },
      { key: SEVERITY_KEY, operator: "is_not", value: "INFO" },
      { key: "service.name", operator: "is_not_one_of", values: ["a", "b"] },
      { key: "x", operator: "does_not_contain", value: "y" },
    ]);
    expect(r.rules).toContain("logs.stream.negation");
    expect(r.assumptions).toContain("A.logtable-negation");
    expect(r.status).toBe("exact-under");
  });

  it("free text becomes a body contains filter, under A.log-fulltext", () => {
    const r = t('"timed out" -retry');
    expect(r.spec?.filters).toEqual([
      { key: BODY_KEY, operator: "contains", value: "timed out" },
      { key: BODY_KEY, operator: "does_not_contain", value: "retry" },
    ]);
    expect(r.assumptions).toContain("A.log-fulltext");
  });

  it("numeric ranges become gt/gte/lt/lte filters", () => {
    expect(filters("@duration:>100")).toEqual([{ key: "duration", operator: "gt", value: "100" }]);
    expect(filters("@duration:<=2.5")).toEqual([{ key: "duration", operator: "lte", value: "2.5" }]);
    expect(filters("@http.status_code:[400 TO 499]")).toEqual([
      { key: "http.status_code", operator: "gte", value: "400" },
      { key: "http.status_code", operator: "lte", value: "499" },
    ]);
    expect(t("@duration:>100").assumptions).toContain("A.numeric-attr");
  });

  it("free-form template variables are dropped while pinned to '*'", () => {
    const r = t("source:redis $scope status:error");
    expect(r.spec?.filters).toHaveLength(2);
    expect(r.rules).toContain("log.match.var.dropped");
    expect(r.findings.some((f) => f.code === "log.match.var.dropped")).toBe(true);
  });

  it("indexes, columns and sort", () => {
    const r = t("service:api", { indexes: ["main"], sort: { column: "timestamp", order: "asc" } }, [{ field: "host", width: "auto" }]);
    expect(r.spec?.sort).toEqual({ sortDirection: "asc" });
    expect(r.rules).toEqual(expect.arrayContaining(["log.indexes", "panel.style"]));
    expect(t("service:api", { sort: { column: "@duration", order: "desc" } }).spec?.sort).toBeUndefined();
  });

  it("searches with no AND-of-filters form fail closed with a catalog finding code", () => {
    for (const q of ["service:a OR host:b", "NOT (service:a host:b)", "time*out", "-$scope", "status:bogus", "service:(a"]) {
      const r = t(q);
      expect(r, q).toMatchObject({ status: "manual", spec: null });
      expect(r.findings.filter((f) => f.status === "manual").map((f) => f.code), q).toEqual([q === "service:(a" ? "query.parse_error" : "query.datasource"]);
    }
  });

  it("every reserved filter key is the dotted form of its dash0.logs label in mappings/log-attributes.yaml", () => {
    for (const [k, key] of Object.entries(RESERVED_FILTER_KEYS)) expect(key.replace(/\./g, "_"), k).toBe(attributes.reserved[k]!.label);
    expect(SEVERITY_KEY.replace(/\./g, "_")).toBe("otel_log_severity_range");
    expect(BODY_KEY.replace(/\./g, "_")).toBe("otel_log_body");
  });
});

describe("fixture log streams through migrate", async () => {
  const run = await migrate({ ingest: { input: join(ROOT, "fixtures", "datadog") }, mappingsDir: join(ROOT, "mappings"), outDir: mkdtempSync(join(tmpdir(), "lt-")), mode: "dry-run", version: "test" });
  const item = (id: string) => run.report.items.find((i) => i.id === id)!;

  it("NGINX's log stream becomes a LogTable with source and status-code filters", () => {
    const i = item("dd-dash-nginx__NGINX-Overview_dashboard/w-5323257507468104/w-2423812479006580");
    expect(i.status).toBe("exact-under");
    expect(i.certificate.rules).toContain("logs.stream");
  });

  it("Redis's error stream keeps source and status, and drops $scope/$host", () => {
    const i = item("dd-dash-redisdb__overview/w-5/w-30");
    expect(i.certificate.rules).toEqual(expect.arrayContaining(["logs.stream", "log.match.status", "log.match.var.dropped"]));
  });

  it("Postgres's stream (OR across host keys) stays a placeholder", () => {
    const i = item("dd-dash-postgres__postgresql_screenboard_dashboard/w-1127561260333130/w-8685226852632656");
    expect(i.status).toBe("manual");
    expect(i.certificate.rules).toContain("widget.logs");
  });

  it("the emitted dashboards carry LogTable panels and still pass T7 preflight", () => {
    const tables = run.dashboards.flatMap((d) => Object.values(d.dashboard.spec.panels)).filter((p) => p.spec.plugin.kind === "LogTable");
    expect(tables).toHaveLength(3);
    expect(tables.map((p) => p.spec.plugin.spec)).toContainEqual({
      sort: { sortDirection: "asc" },
      filters: [
        { key: "source", operator: "is", value: "nginx" },
        { key: "http.status_code", operator: "is_one_of", values: ["404", "500"] },
      ],
    });
    for (const d of run.dashboards) expect(preflightDashboard(d.dashboard)).toEqual([]);
  });
});
