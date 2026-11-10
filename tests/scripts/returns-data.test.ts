import { describe, expect, it } from "vitest";
import { classify, likelyCause, parseDuration, prepare, runQuery, summarize, type Env, type ItemResult, type Outcome } from "../../scripts/returns-data.js";

const env: Env = { base: "https://api.example/", token: "t0ken", dataset: "default", rangeSeconds: 3600, step: 60, now: () => 1_000_000 };
const matrix = (...series: unknown[][][]) => ({ status: "success", data: { resultType: "matrix", result: series.map((values) => ({ metric: {}, values })) } });
const noSleep = async () => {};
const json = (status: number, body: unknown) => ({ status, json: async () => body }) as Response;

describe("prepare: placeholders -> concrete values", () => {
  it("replaces interval, rate interval and range", () => {
    expect(prepare('sum(increase({otel_metric_name="x"}[$__interval]))', "panel")).toBe('sum(increase({otel_metric_name="x"}[1m]))');
    expect(prepare("rate(x[$__rate_interval])", "panel")).toBe("rate(x[5m])");
    expect(prepare("increase(x[$__range] @ end())", "panel", { range: "15m", interval: "1m", rateInterval: "5m" })).toBe("increase(x[15m] @ end())");
  });
  it("turns template variables into match-all, including inside anchored regexes", () => {
    expect(prepare('x{host_name=~"^($host)$", env!~"^($env)$"}', "panel")).toBe('x{host_name=~"^(.*)$", env!~"^(.*)$"}');
  });
  it("does not mistake $__ placeholders or a closing $ for variables", () => {
    expect(prepare('x{a=~"^(v)$"}[$__interval]', "panel")).toBe('x{a=~"^(v)$"}[1m]');
  });
  it("strips the trailing threshold comparison from alerts only", () => {
    expect(prepare("avg_over_time((100 * a / b)[5m:1m]) > $__threshold", "alert")).toBe("avg_over_time((100 * a / b)[5m:1m])");
    expect(prepare("-(x) >= $__threshold", "alert")).toBe("-(x)");
    expect(prepare("x > $__threshold", "panel")).toBe("x > 0");
  });
});

describe("runQuery (range query over the window)", () => {
  it("asks query_range for [now - range, now] at the step, with the token and dataset", async () => {
    let url = "";
    let auth = "";
    const f = (async (u: string, init?: RequestInit) => {
      url = u;
      auth = String((init?.headers as Record<string, string>).Authorization);
      return json(200, matrix([[1, "1"], [2, "1"]], [[1, "2"]]));
    }) as unknown as typeof fetch;
    expect(await runQuery("up", env, f, noSleep)).toEqual({ returns: true, series: 2 });
    expect(url).toContain("https://api.example/api/prometheus/api/v1/query_range?dataset=default&query=up");
    expect(url).toContain("&start=996400&end=1000000&step=60");
    expect(auth).toBe("Bearer t0ken");
  });
  it("no series, or only series without points, is 'no data'", async () => {
    const none = (async () => json(200, matrix())) as unknown as typeof fetch;
    expect(await runQuery("up", env, none, noSleep)).toEqual({ returns: false, series: 0 });
    const hollow = (async () => json(200, matrix([], []))) as unknown as typeof fetch;
    expect(await runQuery("up", env, hollow, noSleep)).toEqual({ returns: false, series: 0 });
  });
  it("a metric that stopped long ago but is inside the window still counts (the point of a range query)", async () => {
    const f = (async () => json(200, matrix([[996_500, "1"]]))) as unknown as typeof fetch;
    expect(await runQuery("old_metric", env, f, noSleep)).toEqual({ returns: true, series: 1 });
  });
  it("retries 429 then succeeds", async () => {
    let calls = 0;
    const f = (async () => (++calls < 3 ? json(429, {}) : json(200, matrix([[1, "1"]])))) as unknown as typeof fetch;
    expect(await runQuery("x", env, f, noSleep)).toEqual({ returns: true, series: 1 });
    expect(calls).toBe(3);
  });
  it("a query error is reported, not thrown, and not mistaken for 'no data'", async () => {
    const f = (async () => json(400, { error: "parse error: unexpected character" })) as unknown as typeof fetch;
    const r = await runQuery("x{", env, f, noSleep);
    expect(r.returns).toBeNull();
    expect(r.error).toContain("parse error");
  });
  it("gives up after repeated failures without throwing", async () => {
    const f = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await runQuery("x", env, f, noSleep);
    expect(r).toMatchObject({ returns: null });
    expect(r.error).toContain("ECONNRESET");
  });
});

describe("parseDuration", () => {
  it("parses s, m, h, d and rejects anything else", () => {
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("1h")).toBe(3600);
    expect(parseDuration("2d")).toBe(172800);
    expect(() => parseDuration("1w")).toThrow(/bad duration/);
    expect(() => parseDuration("")).toThrow(/bad duration/);
  });
});

describe("classify and summarize", () => {
  const yes: Outcome = { returns: true, series: 1 };
  const no: Outcome = { returns: false, series: 0 };
  const err: Outcome = { returns: null, series: 0, error: "x" };
  it("classifies an item from its queries", () => {
    expect(classify([])).toBe("n/a");
    expect(classify([yes, yes])).toBe("all");
    expect(classify([yes, no])).toBe("partial");
    expect(classify([no, no])).toBe("none");
    expect(classify([yes, err])).toBe("error");
  });
  it("gives a cause hint only for empty results, and points at unmapped names first", () => {
    expect(likelyCause(["metric.unmapped"], "none")).toContain("mapping table");
    expect(likelyCause([], "partial")).toContain("no series matched");
    expect(likelyCause(["metric.unmapped"], "all")).toBeUndefined();
    expect(likelyCause(["metric.approximate"], "none")).toContain("approximate");
    expect(likelyCause(["tag.unmapped"], "none")).toContain("label");
    expect(likelyCause(["label.default"], "partial")).toContain("dots become underscores");
    const both = likelyCause(["metric.unmapped", "tag.unmapped"], "none")!;
    expect(both).toContain("mapping table");
    expect(both).toContain("label");
  });
  it("counts results by category", () => {
    const item = (returnsData: ItemResult["returnsData"]): ItemResult => ({ id: "i", kind: "panel", title: "", dashboard: "", status: "bounded", returnsData, queries: [] });
    expect(summarize([item("all"), item("all"), item("none"), item("n/a")])).toEqual({ all: 2, partial: 0, none: 1, error: 0, "n/a": 1, items: 4 });
  });
});
