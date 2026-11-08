const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function backend(search = "", fetch = async () => { throw new Error("unexpected fetch"); }) {
  const context = { window: {}, location: { search, href: "http://localhost:3001/", origin: "http://localhost:3001" }, URLSearchParams, URL, setTimeout, fetch };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/backend.js`, "utf8"), context);
  return context.window.MigrateBackend;
}

function report() {
  return {
    items: [
      { kind: "dashboard", sourceId: "d.json", title: "Dashboard", sourcePath: "", outcome: "blocked" },
      ...["translated", "approximated", "assumed", "best_effort", "partial", "blocked"].map((outcome, i) => ({
        kind: i === 5 ? "monitor" : "widget", sourceId: "d.json", sourcePath: `widgets[${i}]`, title: outcome, outcome, remarks: i === 1 ? ["TIMEPIN"] : [],
      })),
    ],
    diagnostics: [
      { sourceId: "d.json", sourcePath: "widgets[0]", severity: "warning", code: "UNREVIEWED_MAPPING", message: "Never show this warning on translated rows" },
      { sourceId: "d.json", sourcePath: "widgets[1].definition", severity: "warning", code: "APPROXIMATED", message: "Real explanation", suggestedAction: "Inspect it", sourceText: "original query" },
      { sourceId: "d.json", sourcePath: "widgets[10]", severity: "error", code: "OTHER", message: "Other widget" },
    ],
  };
}

test("preserves all outcome categories, remarks and exact diagnostic ownership; hides dashboards", () => {
  const items = backend().fromReport(report());
  assert.equal(items.length, 6);
  assert.deepEqual(Array.from(items, (it) => it.status), ["converted", "review", "review", "review", "review", "unsupported"]);
  assert.deepEqual(Array.from(items, (it) => it.outcome), ["translated", "approximated", "assumed", "best_effort", "partial", "blocked"]);
  assert.equal(items[1].why, "Real explanation");
  assert.equal(items[1].diagnostics.length, 1);
  assert.equal(items[1].remarks[0], "TIMEPIN");
  assert.equal(items[1].from, "original query");
  assert.equal(items[0].diagnostics.length, 1);
  assert.equal(items[0].warningNames.length, 0);
  assert.deepEqual(Array.from(items[1].warningNames), ["TIMEPIN", "APPROXIMATED"]);
  assert.ok(items.every((it) => !it.suggestion && !it.compare));
});

test("unknown outcomes are rejected including object prototype names", () => {
  for (const outcome of ["future", "__proto__", "constructor"]) {
    const value = report(); value.items[1].outcome = outcome;
    assert.throws(() => backend().fromReport(value), /unknown outcome/);
  }
});

test("default load posts file content to backend and retains returned artifacts", async () => {
  const result = { report: report(), artifacts: { "dashboards/d.json": "{}" } };
  const api = backend("", async (url, options) => {
    assert.equal(url, "/api/convert");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { files: [{ name: "input.json", text: "original" }] });
    return { ok: true, json: async () => result };
  });
  assert.equal(api.mode, "api");
  assert.equal((await api.load([{ name: "input.json", text: async () => "original" }])).length, 6);
  assert.equal(api.result, result);
});

test("invalid uploads expose the backend error and never fall back to mock data", async () => {
  const api = backend("", async () => ({ ok: false, json: async () => ({ error: "INVALID_JSON: input.json" }) }));
  await assert.rejects(api.load(), /INVALID_JSON/);
  assert.equal(api.result, null);
});

test("saved reports stay supported; cross-origin reports are rejected", async () => {
  const api = backend("?report=reports/report.json", async (url) => {
    assert.equal(url, "http://localhost:3001/reports/report.json");
    return { ok: true, json: async () => report() };
  });
  assert.equal((await api.load()).length, 6);
  await assert.rejects(backend("?report=https://elsewhere/report.json").load(), /same-origin/);
});

test("AI calls are explicit and only for blocked items; server quota is retained", async () => {
  const calls = [];
  const api = backend("", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return url === "/api/convert"
      ? { ok: true, json: async () => ({ report: report(), runId: 4, ai: { remaining: 3, available: true } }) }
      : { ok: true, json: async () => ({ recommendation: "Draft", ai: { remaining: 2, available: true }, applied: false }) };
  });
  const items = await api.load();
  assert.equal(calls.length, 1);
  await assert.rejects(api.suggest(items[0]), /failed translations/);
  assert.equal(calls.length, 1);
  assert.equal(await api.suggest(items[5]), "Draft");
  assert.deepEqual(calls[1], { url: "/api/suggest", body: { runId: 4, sourceId: "d.json", sourcePath: "widgets[5]" } });
  assert.equal(api.ai.remaining, 2);
});

test("exhausted quota returns sales contact without hiding the last recommendation", async () => {
  const api = backend("", async (url) => url === "/api/convert"
    ? { ok: true, json: async () => ({ report: report(), runId: 4 }) }
    : { ok: false, json: async () => ({ error: "Contact our sales team at sandy@dash0.com.", ai: { remaining: 0, available: true } }) });
  const items = await api.load();
  await assert.rejects(api.suggest(items[5]), /sandy@dash0.com/);
  assert.equal(api.ai.remaining, 0);
});
