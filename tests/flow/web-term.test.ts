// The browser terminal: one flow, the page is only a renderer. These tests drive the server the way the page does
// (Server-Sent Events in, JSON answers out) and check its safety rails.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { page, webTerminal, type WebSession } from "../../src/flow/web-term.js";

type Ev = { t: string; s?: string; id?: number; kind?: string; prompt?: string; options?: string[]; def?: number; label?: string; url?: string; code?: number };

/** Open the event stream and collect events; next(pred) waits for the first matching one. */
async function stream(url: string) {
  const res = await fetch(`${url}/events`);
  const reader = res.body!.getReader();
  const seen: Ev[] = [];
  let buf = "";
  let wake: (() => void) | null = null;
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) seen.push(JSON.parse(chunk.slice(6)) as Ev);
        wake?.();
      }
    }
  })();
  let from = 0;
  const next = async (pred: (e: Ev) => boolean): Promise<Ev> => {
    for (;;) {
      const k = seen.slice(from).findIndex(pred);
      if (k >= 0) {
        from += k + 1;
        return seen[from - 1]!;
      }
      await new Promise<void>((r) => ((wake = r), setTimeout(r, 50)));
    }
  };
  return { seen, next, close: () => reader.cancel() };
}

function start(run: (s: WebSession) => Promise<number>) {
  let onUrl: (u: string) => void = () => {};
  const ready = new Promise<string>((r) => (onUrl = r));
  const finished = webTerminal({ version: "test", cwd: "~/x", onReady: (u) => onUrl(u), run, lingerMs: 200 });
  return { ready, done: () => finished };
}

const answer = (url: string, id: number | undefined, value: unknown, origin = new URL(url).origin) =>
  fetch(`${url}/answer`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ id, value }) });

describe("web terminal: the guided flow in the browser", () => {
  it("the page's script compiles (it lives in a template string, where one wrong escape breaks it)", () => {
    const html = page({ version: "t", cwd: "~" }, "n0nce", "tok");
    const scripts = [...html.matchAll(/<script nonce="n0nce">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]!)).not.toThrow();
  });

  it("relays output and every kind of question; secrets are never echoed back", async () => {
    const got: unknown[] = [];
    const s = start(async ({ io, out }) => {
      out.write("\x1b[38;5;111m●\x1b[39m \x1b[1mKeys\x1b[22m\n");
      got.push(await io.ask("  ⎿ site › "));
      got.push(await io.askSecret("  ⎿ token › "));
      got.push(await io.choose("Import?", ["Yes", "No"], 0));
      got.push(await io.askBlock("  Paste your .env"));
      return 0;
    });
    const url = await s.ready;
    const ev = await stream(url);
    expect((await ev.next((e) => e.t === "out")).s).toContain("Keys");

    const q1 = await ev.next((e) => e.t === "ask");
    expect(q1).toMatchObject({ kind: "text", prompt: "  ⎿ site › " });
    expect((await answer(url, q1.id, "datadoghq.eu")).status).toBe(200);
    const q2 = await ev.next((e) => e.t === "ask");
    expect(q2.kind).toBe("secret");
    expect((await answer(url, q2.id, "s3cr3t-value")).status).toBe(200);
    const q3 = await ev.next((e) => e.t === "ask");
    expect(q3).toMatchObject({ kind: "choose", options: ["Yes", "No"], def: 0 });
    expect((await answer(url, q3.id, 5)).status).toBe(400); // out of range
    expect((await answer(url, 999, 0)).status).toBe(409); // not the open question
    expect((await answer(url, q3.id, 1)).status).toBe(200);
    const q4 = await ev.next((e) => e.t === "ask");
    expect(q4.kind).toBe("block");
    expect((await answer(url, q4.id, "DD_API_KEY=abc\nDD_APP_KEY=def\n")).status).toBe(200);

    expect((await ev.next((e) => e.t === "exit")).code).toBe(0);
    expect(got).toEqual(["datadoghq.eu", "s3cr3t-value", 1, "DD_API_KEY=abc\nDD_APP_KEY=def\n"]);
    const text = ev.seen.filter((e) => e.t === "out").map((e) => e.s).join("");
    expect(text).toContain("site › datadoghq.eu");
    expect(text).toContain("token › ••••••••••••"); // a dot per character, as in the terminal
    expect(text).not.toContain("s3cr3t-value");
    expect(text).not.toContain("DD_API_KEY=abc");
    expect(text).toContain("2 line(s) received, not shown");
    expect(text).toMatch(/Import\?.*›.*No/);
    ev.close();
    expect(await s.done()).toBe(0);
  });

  it("replays the session to a reloaded tab, including the open question", async () => {
    const s = start(async ({ io, out }) => {
      out.write("first line\n");
      await io.ask("name › ");
      return 0;
    });
    const url = await s.ready;
    const a = await stream(url);
    const q = await a.next((e) => e.t === "ask");
    a.close();
    const b = await stream(url);
    expect((await b.next((e) => e.t === "out")).s).toContain("first line");
    expect((await b.next((e) => e.t === "ask")).id).toBe(q.id);
    await answer(url, q.id, "x");
    await b.next((e) => e.t === "exit");
    b.close();
    expect(await s.done()).toBe(0);
  });

  it("refuses other hosts, cross-origin answers and unknown paths; the page carries a nonce CSP", async () => {
    const s = start(async ({ io }) => ((await io.ask("? ")), 0));
    const url = await s.ready;
    const { origin, pathname } = new URL(url);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'/);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).not.toMatch(/<script(?![^>]*nonce=)/); // every script is nonced
    const ev = await stream(url);
    const q = await ev.next((e) => e.t === "ask");
    expect((await answer(url, q.id, "x", "http://evil.example")).status).toBe(403);
    expect((await fetch(`${origin}/wrong${pathname}`)).status).toBe(404);
    const wrongHost = await new Promise<number>((r) => {
      void import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: Number(new URL(url).port), path: pathname, headers: { Host: "attacker.example" } }, (res) => r(res.statusCode ?? 0));
        req.end();
      });
    });
    expect(wrongHost).toBe(421);
    await answer(url, q.id, "ok");
    await ev.next((e) => e.t === "exit");
    ev.close();
    await s.done();
  });

  it("shows the report as a link and serves it sandboxed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webterm-"));
    const file = join(dir, "report.html");
    writeFileSync(file, "<!doctype html><title>r</title><p>report</p>");
    const s = start(async ({ open }) => (open(file), 0));
    const url = await s.ready;
    const ev = await stream(url);
    const link = await ev.next((e) => e.t === "link");
    expect(link.label).toBe("report.html");
    const res = await fetch(new URL(link.url!, url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toContain("<p>report</p>");
    await ev.next((e) => e.t === "exit");
    ev.close();
    await s.done();
  });

  it("a question nobody can answer (tab closed) ends as no answer, so the flow can finish", async () => {
    let got: unknown = "unset";
    let url = "";
    const done = webTerminal({ version: "t", cwd: "~", goneMs: 100, lingerMs: 50, onReady: (u) => (url = u), run: async ({ io }) => ((got = await io.choose("Go?", ["Yes", "No"])), 0) });
    while (!url) await new Promise((r) => setTimeout(r, 10));
    const ev = await stream(url);
    await ev.next((e) => e.t === "ask");
    await ev.close();
    expect(await done).toBe(0);
    expect(got).toBeNull();
  });
});
