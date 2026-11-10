import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/pipeline/migrate.js";
import { writeReport } from "../../src/report/index.js";
import { reportToEvents } from "../../src/report/events.js";
import { narrate } from "../../src/report/narrate.js";
import { startServer } from "../serve/server.js";

const ROOT = join(import.meta.dirname, "..", "..");
const out = mkdtempSync(join(tmpdir(), "t8s-"));
const run = await migrate({ ingest: { input: join(ROOT, "fixtures", "datadog") }, mappingsDir: join(ROOT, "mappings"), outDir: out, mode: "dry-run", version: "test" });
writeReport(run.report, out);

describe("events and narration", () => {
  const ev = reportToEvents(run.report);
  it("one event per panel and alert (group items are structure only), framed by run.start / run.done, in sequence", () => {
    expect(ev[0]!.type).toBe("run.start");
    expect(ev.at(-1)!.type).toBe("run.done");
    expect(ev.filter((e) => e.type === "item.done")).toHaveLength(run.report.items.filter((i) => i.kind !== "group").length);
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i));
  });
  it("is deterministic", () => expect(JSON.stringify(reportToEvents(run.report))).toBe(JSON.stringify(ev)));
  it("top gaps count only bounded/manual/unsupported items, so exact-under assumptions aren't called gaps", () => {
    const done = ev.at(-1)!;
    if (done.type !== "run.done") throw new Error();
    expect(done.topGaps.map((g) => g.code)).not.toContain("scope.var.free-form");
    // Every top gap is a reason on some bounded/manual/unsupported item.
    const gapCodes = new Set(run.report.items.filter((i) => !["exact", "exact-under"].includes(i.status)).flatMap((i) => i.reason_codes));
    for (const g of done.topGaps) expect(gapCodes.has(g.code), g.code).toBe(true);
  });
  it("narrates milestones and problems, stays quiet on routine exact panels", () => {
    const said = ev.map(narrate);
    expect(said[0]).toMatch(/^Starting migration: 4 Datadog dashboards and 6 monitors, as a dry run\.$/);
    expect(said.at(-1)).toMatch(/^Finished\. \d+(\.\d)? percent of query panels translated/);
    const routine = ev.findIndex((e) => e.type === "item.done" && e.kind === "panel" && (e.status === "exact" || e.status === "exact-under"));
    expect(routine).toBeGreaterThan(-1);
    expect(said[routine]).toBeNull();
    expect(said.some((s) => s?.includes("can't be migrated automatically"))).toBe(true);
  });
});

describe("serve", async () => {
  const tokenCalls: { url: string; key: string | null }[] = [];
  const fakeEl = (async (u: URL | string, init: RequestInit = {}) => {
    tokenCalls.push({ url: String(u), key: (init.headers as Record<string, string>)["xi-api-key"] ?? null });
    return new Response(JSON.stringify({ token: "conv-token-123" }), { status: 200 });
  }) as typeof fetch;
  const { server, url } = await startServer({ outDir: out, port: 0, pace: 0, agentId: "agent_abc", elevenLabsKey: "sk_SECRET", fetch: fakeEl });
  afterAll(() => server.close());
  const get = async (p: string) => fetch(new URL(p, url));

  it("serves the viewer and config without the API key", async () => {
    expect(await (await get("/")).text()).toContain("<title>dd2dash0 live</title>");
    const cfg = await (await get("/config.json")).text();
    expect(JSON.parse(cfg)).toEqual({ voice: true, pace: 0 });
    expect(cfg).not.toContain("sk_SECRET");
  });
  it("mints an ElevenLabs conversation token server-side; the key never reaches the page", async () => {
    const body = await (await get("/api/el-token")).text();
    expect(JSON.parse(body)).toEqual({ token: "conv-token-123" });
    expect(body).not.toContain("sk_SECRET");
    expect(tokenCalls[0]).toEqual({ url: "https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent_abc", key: "sk_SECRET" });
  });
  it("agent tools: summary and item lookup come from the report", async () => {
    const s = await (await get("/api/summary")).json();
    expect(s).toMatchObject({ dashboards: 4, monitors: 6 });
    expect(s.not_migrated.length).toBeGreaterThan(0);
    const items = await (await get("/api/item?q=high%20memory")).json();
    expect(items[0]).toMatchObject({ id: "dd-monitor-redisdb__high_mem", status: "exact-under" });
    expect(items[0].promql[0]).toContain("$__threshold");
  });
  it("streams every event over SSE with narration, then ends", async () => {
    const text = await (await get("/events?pace=0")).text();
    const data = text.split("\n").filter((l) => l.startsWith("data: {\"seq\"")).map((l) => JSON.parse(l.slice(6)));
    expect(data).toHaveLength(reportToEvents(run.report).length);
    expect(data.at(-1)).toMatchObject({ type: "run.done", say: expect.stringMatching(/^Finished\./) });
    expect(text).toContain("event: end");
  });
  // @elevenlabs/client is an optional dependency (voice narrator only): skipped when it isn't installed.
  const hasVoice = (() => {
    try {
      createRequire(import.meta.url).resolve("@elevenlabs/client");
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasVoice)("serves the pinned ElevenLabs browser SDK locally", async () => {
    const js = await (await get("/vendor/elevenlabs.js")).text();
    expect(js.startsWith("var ElevenLabsClient")).toBe(true);
  });
  it.skipIf(hasVoice)("without the optional voice SDK, /vendor/elevenlabs.js is a 404, not a crash", async () => {
    expect((await get("/vendor/elevenlabs.js")).status).toBe(404);
  });
});
