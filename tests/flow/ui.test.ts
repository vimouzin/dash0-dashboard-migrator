// The terminal look (style kit, choices, result card), the one-time key page, and report.html.
import { describe, expect, it } from "vitest";
import { webKeys } from "../../src/flow/keys-web.js";
import { reportHtml } from "../../src/flow/report-html.js";
import { resultCard } from "../../src/flow/run.js";
import type { Row, RunFacts, Score } from "../../src/flow/score.js";
import { chooseKeys } from "../../src/flow/tty.js";
import { box, paint, truncate, Ui, width } from "../../src/ui/style.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const collect = (isTTY = false) => {
  const out: string[] = [];
  return { out, ui: new Ui({ write: (s) => void out.push(s), isTTY, columns: 80 }, { NO_COLOR: "1" }, () => 0) };
};

describe("style kit", () => {
  it("measures and truncates without breaking escape sequences or links", () => {
    const s = "\x1b[1mbold\x1b[22m \x1b]8;;file:///x\x1b\\report.html\x1b]8;;\x1b\\";
    expect(width(s)).toBe("bold report.html".length);
    const t = truncate(s, 8);
    expect(t).toBe("bold re…");
    expect(t).not.toContain("\x1b");
  });
  it("frames lines and prints steps as a tree; plain text without a TTY", () => {
    expect(box(paint(false), ["a", "bcd"])).toEqual(["╭─────╮", "│ a   │", "│ bcd │", "╰─────╯"]);
    const { out, ui } = collect();
    ui.step("Translate").done("37 items", ["21 exact-under"]);
    expect(out.join("")).toBe("● Translate  37 items  0.0s\n  ⎿ 21 exact-under\n");
  });
});

describe("chooseKeys", () => {
  it("moves with arrows and j/k, wraps, picks with Enter or a number", () => {
    const s = { i: 0 };
    expect(chooseKeys(s, "\x1b[B\x1b[B", 3)).toBeNull();
    expect(s.i).toBe(2);
    expect(chooseKeys(s, "j", 3)).toBeNull();
    expect(s.i).toBe(0); // wrapped
    expect(chooseKeys(s, "k\r", 3)).toBe("enter");
    expect(s.i).toBe(2);
    const t = { i: 0 };
    expect(chooseKeys(t, "2", 3)).toBe("enter");
    expect(t.i).toBe(1);
    expect(chooseKeys({ i: 0 }, "\x03", 3)).toBe("interrupt");
  });
});

const score: Score = {
  total: 37,
  panels: 36,
  monitors: 1,
  translated: { count: 31, total: 37, pct: 83 },
  landed: { count: 37, total: 37, pct: 100 },
  live: { count: 22, total: 22, pct: 100 },
  success: { count: 31, total: 37, pct: 83 },
  liveCounts: { live: 22, missing: 0, "no-data": 0, error: 0, "n/a": 15 },
  topGaps: [["metric.no_equivalent", 5]],
};

describe("result card", () => {
  it("one bar per number, rules on/off, report paths", () => {
    const { ui } = collect();
    const lines = resultCard(ui, score, { live: true, rulesImported: 1, rulesOn: 0, manualMonitors: 0, html: "/w/run/report.html", md: "/w/run/report.md", rel: (f) => f.replace("/w/", "") });
    const text = lines.join("\n");
    expect(lines[0]).toMatch(/^╭─ Result /);
    expect(text).toMatch(/success\s+█{15}░{3}\s+31\/37\s+83%/); // 31/37 of 18 cells = 15.08, rounded down
    expect(text).toContain("1 imported (0 on, 1 off)");
    expect(text).toContain("report run/report.html · run/report.md");
  });
});

describe("report.html", () => {
  it("is one offline page with the four numbers, escapes text, and loads nothing external", () => {
    const row: Row = { id: "x", kind: "panel", title: "<script>alert(1)</script>", dashboard: "Redis", widget: "timeseries", status: "bounded", decision: "approved", translated: true, landed: true, landedDetail: "", live: "live", success: true, reasons: [], manualActions: [], sourceQueries: [], promql: [] };
    const facts: RunFacts = { version: "0.3.0", source: "Datadog datadoghq.eu", target: "Dash0 x / default", mode: "live", inputHash: "a".repeat(64), outputHash: "b".repeat(64), planHash: "c".repeat(64), windowSeconds: 3600, startedAt: "2026-11-08T10:00:00.000Z" };
    const html = reportHtml(score, [row], facts);
    expect(html).toContain("31/37 <b>83%</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script|src=|href="http/);
  });
});

describe("key page (one-time, 127.0.0.1)", () => {
  it("refuses other origins and hosts, shows field errors, accepts good keys once, and never echoes a secret", async () => {
    const dd = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (u.pathname === "/api/v1/validate") return h["DD-API-KEY"] === "good-dd-api-key-123" ? json({ valid: true }) : json({}, 403);
      if (u.pathname === "/api/v1/dashboard") return json({ dashboards: [] });
      if (u.pathname === "/api/dashboards") return h.Authorization === "Bearer good-token-xyz" ? json([]) : json({}, 401);
      return json({}, 404);
    }) as typeof fetch;
    let url = "";
    const done = webKeys({ need: { datadog: true, dash0: true }, known: { DASH0_DATASET: "default" }, cwd: "/w", fetch: dd, onReady: (u) => (url = u), timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    const origin = new URL(url).origin;
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(await page.text()).toContain("dd2dash0 · connect");
    expect((await fetch(origin + "/wrong")).status).toBe(404);

    const post = (body: unknown, headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" }) => fetch(url + "/check", { method: "POST", headers, body: JSON.stringify(body) });
    expect((await post({ keys: {} }, { Origin: "http://evil.example", "Content-Type": "application/json" })).status).toBe(403);
    expect((await post({ keys: {} }, { Origin: origin, "Content-Type": "text/plain" })).status).toBe(403);

    const bad = (await (await post({ keys: { DD_API_KEY: "wrong-dd-key-0000", DD_APP_KEY: "app", DASH0_API_URL: "https://ingress.eu-west-1.aws.dash0.com:4317" } })).json()) as { ok: boolean; fields: Record<string, { ok: boolean; message?: string }> };
    expect(bad.ok).toBe(false);
    expect(bad.fields.DD_API_KEY!.message).toMatch(/rejected the API key/);
    expect(bad.fields.DASH0_API_URL!.message).toMatch(/ingress/);
    expect(bad.fields.DASH0_AUTH_TOKEN!.message).toBe("required");
    expect(JSON.stringify(bad)).not.toContain("wrong-dd-key-0000");

    const good = await post({ keys: { DD_API_KEY: "good-dd-api-key-123", DD_APP_KEY: "app", DASH0_API_URL: "api.eu-west-1.aws.dash0.com/", DASH0_AUTH_TOKEN: "good-token-xyz" }, save: true });
    const gj = (await good.json()) as { ok: boolean };
    expect(gj.ok).toBe(true);
    expect(JSON.stringify(gj)).not.toMatch(/good-dd-api-key|good-token/);
    const r = await done;
    expect(r.save).toBe(true);
    expect(r.keys).toMatchObject({ DD_SITE: "datadoghq.eu", DD_API_KEY: "good-dd-api-key-123", DASH0_API_URL: "https://api.eu-west-1.aws.dash0.com", DASH0_DATASET: "default" });
    // Works once: the server closes (or answers 410) afterwards.
    const again = await post({ keys: {} }).then((x) => x.status).catch(() => "closed");
    expect([410, "closed"]).toContain(again);
  });
});
