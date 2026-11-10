// `dd2dash0` in the browser: the same guided flow, drawn on a one-time page on this computer.
//
// The flow keeps running here, in this process; the page is only a second front end. It receives exactly the bytes
// the terminal would get (ANSI colors, spinners, OSC 8 links) over Server-Sent Events and renders them, and it sends
// back the answers to the flow's questions (ask, askSecret, choose, askBlock). So the terminal and the browser can't
// drift apart: one flow, one set of rules, two renderers.
//
// Same safety as the key page (keys-web.ts): 127.0.0.1 only, a random secret path, Host and Origin checks, a nonce
// CSP, no external assets. Answers to secret prompts travel only over this local connection and are never echoed back.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname } from "node:path";
import type { Out } from "../ui/style.js";
import type { KeyIO } from "./keys.js";
import type { AskBlock, Choose } from "./tty.js";

export type WebIO = KeyIO & { choose: Choose; askBlock: AskBlock };

export interface WebSession {
  /** Where the flow writes; colors on, spinners on, as on a real terminal. */
  out: Out;
  io: WebIO;
  /** Show a file (report.html) or URL as a link in the page. */
  open: (target: string) => void;
  /** Env for the Ui: colors forced on, links as OSC 8. */
  env: NodeJS.ProcessEnv;
}

export interface WebTerminalOptions {
  version: string;
  cwd: string;
  onReady: (url: string) => void;
  /** Runs once, when the page first connects. Its result is webTerminal's result. */
  run: (s: WebSession) => Promise<number>;
  /** Give up if the page never connects. Default 15 minutes. */
  connectTimeoutMs?: number;
  /** A question with no page connected for this long is answered "no answer". Default 2 minutes. */
  goneMs?: number;
  /** The flow is done; the page stays served until its tab closes (report link), at most lingerMs (10 minutes). */
  onFinished?: (code: number) => void;
  lingerMs?: number;
}

type Ask =
  | { t: "ask"; id: number; kind: "text" | "secret"; prompt: string }
  | { t: "ask"; id: number; kind: "choose"; prompt: string; options: string[]; def: number }
  | { t: "ask"; id: number; kind: "block"; prompt: string };
type NoId<T> = T extends unknown ? Omit<T, "id"> : never;
type Ev = { t: "out"; s: string } | Ask | { t: "link"; label: string; url: string } | { t: "exit"; code: number };

const COLUMNS = 96;
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
const ACCENT = (s: string) => `\x1b[38;5;111m${s}\x1b[39m`;

export function webTerminal(o: WebTerminalOptions): Promise<number> {
  const token = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    let origin = "";
    let history = ""; // everything written so far, replayed when the page reloads
    const links: Ev[] = [];
    let client: ServerResponse | null = null;
    let pending: { ev: Ask; answer: (v: unknown) => void } | null = null;
    let nextId = 1;
    let started = false;
    let exited: number | null = null;
    let goneTimer: ReturnType<typeof setTimeout> | null = null;
    const files: string[] = [];

    const send = (ev: Ev) => client?.write(`data: ${JSON.stringify(ev)}\n\n`);
    const write = (s: string) => {
      history += s;
      send({ t: "out", s });
    };

    const ask = <T>(ev: NoId<Ask>, echo: (v: T | null) => string): Promise<T | null> =>
      new Promise((res) => {
        const full = { ...ev, id: nextId++ } as Ask;
        pending = {
          ev: full,
          answer: (v) => {
            pending = null;
            write(echo(v as T | null));
            res(v as T | null);
          },
        };
        send(full);
        if (!client) armGone();
      });

    const io: WebIO = {
      print: (l) => write(l + "\n"),
      ask: (prompt) => ask<string>({ t: "ask", kind: "text", prompt }, (v) => `${prompt}${v ?? ""}\n`),
      askSecret: (prompt) => ask<string>({ t: "ask", kind: "secret", prompt }, (v) => `${prompt}${"•".repeat([...(v ?? "")].length)}\n`),
      choose: (question, options, def = 0) =>
        ask<number>({ t: "ask", kind: "choose", prompt: question, options, def: Math.min(Math.max(0, def), options.length - 1) }, (v) => `  ${question}  ${DIM("›")} ${v === null ? DIM("(no answer)") : options[v]}\n`),
      askBlock: (prompt) =>
        ask<string>({ t: "ask", kind: "block", prompt }, (v) => {
          const n = (v ?? "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
          return `${prompt}\n  ${DIM("⎿")} ${DIM(`${n} line(s) received, not shown`)}\n`;
        }),
    };

    const open = (target: string) => {
      let url = target;
      if (!/^https?:\/\//.test(target)) {
        if (!existsSync(target)) return;
        files.push(target);
        url = `/${token}/f/${files.length - 1}/${encodeURIComponent(basename(target))}`;
      }
      const ev: Ev = { t: "link", label: /^https?:/.test(target) ? target : basename(target), url };
      links.push(ev);
      send(ev);
    };

    // A question nobody can answer (the tab was closed) ends as "no answer", so the flow can finish and exit.
    const armGone = () => {
      if (goneTimer || !pending) return;
      goneTimer = setTimeout(() => {
        goneTimer = null;
        if (!client && pending) pending.answer(null);
      }, o.goneMs ?? 120_000);
      goneTimer.unref();
    };

    const connectTimer = setTimeout(() => {
      if (!started) {
        server.close();
        reject(new Error("the browser page was not opened within 15 minutes"));
      }
    }, o.connectTimeoutMs ?? 15 * 60_000);
    connectTimer.unref();

    const start = () => {
      if (started) return;
      started = true;
      clearTimeout(connectTimer);
      const session: WebSession = {
        out: { isTTY: true, columns: COLUMNS, write },
        io,
        open,
        env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: "", TERM: "xterm-256color", TERM_PROGRAM: "dd2dash0-web" },
      };
      o.run(session).then(
        (code) => finish(code),
        (e: Error) => {
          write(`\n\x1b[38;5;203m●\x1b[39m dd2dash0: ${e.message}\n`);
          finish(1);
        },
      );
    };

    // After the flow ends, keep serving while the tab is open (so the report link works), at most o.lingerMs.
    let stop: (() => void) | null = null;
    const finish = (code: number) => {
      exited = code;
      send({ t: "exit", code });
      let done = false;
      stop = () => {
        if (done) return;
        done = true;
        client?.end();
        server.close();
        server.closeAllConnections?.();
        resolve(code);
      };
      o.onFinished?.(code);
      setTimeout(stop, client ? (o.lingerMs ?? 10 * 60_000) : 1500).unref();
    };

    const server = createServer((req, res) => {
      void handle(req, res).catch(() => reply(res, 500, "text/plain", "error"));
    });

    async function handle(req: IncomingMessage, res: ServerResponse) {
      if (req.headers.host !== origin.replace("http://", "")) return reply(res, 421, "text/plain", "wrong host");
      const path = (req.url ?? "").split("?")[0]!;
      if (req.method === "GET" && path === `/${token}`)
        return reply(res, 200, "text/html; charset=utf-8", page(o, nonce, token), {
          "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
        });
      if (req.method === "GET" && path === `/${token}/events`) {
        if (client) client.end(); // the newest tab wins
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
        client = res;
        if (goneTimer) clearTimeout(goneTimer), (goneTimer = null);
        if (history) send({ t: "out", s: history });
        for (const l of links) send(l);
        if (pending) send(pending.ev);
        if (exited !== null) send({ t: "exit", code: exited });
        req.on("close", () => {
          if (client === res) {
            client = null;
            if (exited !== null) setTimeout(() => !client && stop?.(), 3000).unref(); // the tab was closed (not reloaded)
            else armGone();
          }
        });
        start();
        return;
      }
      if (req.method === "POST" && path === `/${token}/answer`) {
        if (req.headers.origin !== origin || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(res, 403, "application/json", '{"error":"forbidden"}');
        let body: { id?: unknown; value?: unknown };
        try {
          body = JSON.parse(await readBody(req, 65_536));
        } catch {
          return reply(res, 400, "application/json", '{"error":"bad request"}');
        }
        const p = pending;
        if (!p || body.id !== p.ev.id) return reply(res, 409, "application/json", '{"error":"no such question"}');
        const v = body.value;
        if (v !== null) {
          if (p.ev.kind === "choose" ? !(Number.isInteger(v) && (v as number) >= 0 && (v as number) < p.ev.options.length) : typeof v !== "string")
            return reply(res, 400, "application/json", '{"error":"bad answer"}');
        }
        reply(res, 200, "application/json", '{"ok":true}');
        p.answer(v);
        return;
      }
      const f = new RegExp(`^/${token}/f/(\\d+)/`).exec(path);
      if (req.method === "GET" && f) {
        const file = files[Number(f[1])];
        if (!file || !existsSync(file)) return reply(res, 404, "text/plain", "not found");
        const type = { ".html": "text/html; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "application/json" }[extname(file)] ?? "text/plain; charset=utf-8";
        // The report is ours, but render it sandboxed anyway: no scripts, no requests, inline styles only.
        return reply(res, 200, type, readFileSync(file, "utf8"), { "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
      }
      reply(res, 404, "text/plain", "not found");
    }

    server.on("error", (e) => {
      clearTimeout(connectTimer);
      reject(e);
    });
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      o.onReady(`${origin}/${token}`);
    });
  });
}

/** What the terminal shows while the run is in the browser. */
export function webBanner(url: string): string[] {
  return [`${ACCENT("●")} \x1b[1mBrowser\x1b[22m  the run continues on a one-time page on this computer`, `  ${DIM("⎿")} ${url}`, `  ${DIM("⎿")} ${DIM("Ctrl+C here stops it")}`];
}

function reply(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", ...extra });
  res.end(body);
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The page: a terminal, not a web app. Monospace, the CLI's palette (xterm 111 / 78 / 179 / 203), the same glyphs,
 * keyboard first. Nothing animates except the caret and the flow's own spinner: output appears the moment it's written.
 */
export function page(o: Pick<WebTerminalOptions, "version" | "cwd">, nonce: string, token: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dd2dash0</title><meta name="robots" content="noindex">
<style nonce="${nonce}">
:root{--bg:#0c0d10;--fg:#d7d9de;--dim:#6c717b;--line:#23262c;--sel:#171a20;--accent:#87afff;--ok:#5fd787;--warn:#d7af5f;--bad:#ff5f5f;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fbfbfa;--fg:#1d1f23;--dim:#7a7f88;--line:#e4e4e1;--sel:#f0f0ee;--accent:#3a63d8;--ok:#1f8a4c;--warn:#a06a00;--bad:#c93a3a;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);height:100%}
body{font:14px/1.55 ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column}
.bar{display:flex;justify-content:space-between;gap:16px;padding:10px 20px;border-bottom:1px solid var(--line);color:var(--dim);font-size:12px;flex:none}
.bar b{color:var(--fg);font-weight:600}.bar .mark{color:var(--accent)}
.state::before{content:"●";margin-right:6px;color:var(--ok)}.state.off::before{color:var(--dim)}.state.lost::before{color:var(--bad)}
#scroll{flex:1;overflow-y:auto;overscroll-behavior:contain}
#term{max-width:calc(${COLUMNS + 2}ch + 40px);margin:0 auto;padding:28px 20px 40vh;white-space:pre-wrap;word-break:break-word;tab-size:8;overflow-x:auto}
.l.pre{white-space:pre}
.l{min-height:1.55em}
.a{color:var(--accent)}.ok{color:var(--ok)}.wn{color:var(--warn)}.bad{color:var(--bad)}.d{color:var(--dim)}.b{font-weight:600}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--dim);text-underline-offset:3px}
a:focus-visible,button:focus-visible{outline:1px solid var(--accent);outline-offset:2px;border-radius:2px}
.ask{display:flex;align-items:baseline}
.ask input{flex:1;min-width:4ch;font:inherit;color:var(--fg);background:transparent;border:0;outline:none;padding:0;margin:0;caret-color:var(--accent)}
.opt{display:block;width:100%;text-align:left;font:inherit;color:var(--dim);background:none;border:0;padding:0 0 0 2ch;cursor:pointer;white-space:pre-wrap}
.opt .m{display:inline-block;width:2ch;color:var(--accent)}
.opt.on{color:var(--fg)}
@media (hover:hover) and (pointer:fine){.opt:hover{color:var(--fg)}}
.zone{margin:2px 0 0 2ch;border:1px dashed var(--line);border-radius:6px;padding:6px 10px;color:var(--dim)}
.zone.over{border-color:var(--accent);color:var(--fg)}
.zone textarea{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.k{color:var(--fg)}
.pick{font:inherit;color:var(--accent);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
@media (hover:hover) and (pointer:fine){.pick:hover{text-decoration-color:var(--accent)}}
.link{margin-left:2ch}
.end{color:var(--dim);margin-top:1.55em}
.caret{display:inline-block;width:.6em;height:1.15em;vertical-align:-.2em;background:var(--accent);animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.caret{animation:none}}
</style></head><body>
<div class="bar"><span><span class="mark">◆</span> <b>dd2dash0</b> ${esc(o.version)} · ${esc(o.cwd)}</span><span class="state off" id="state">connecting</span></div>
<div id="scroll"><div id="term" role="log" aria-live="polite"></div></div>
<script nonce="${nonce}">
"use strict";
const base = "/${token}", term = document.getElementById("term"), scroller = document.getElementById("scroll"), stateEl = document.getElementById("state");
const COLORS = { 111: "a", 78: "ok", 179: "wn", 203: "bad" };
let active = null; // the open question: { el, focus }
let ended = false;

// ANSI renderer: SGR colors, \\x1b[2K / \\r (spinner redraws), OSC 8 links. Text goes in with textContent only.
function renderer(root) {
  let st = { fg: null, dim: false, bold: false, href: null }, line = null, pend = "";
  const newLine = () => { line = document.createElement("div"); line.className = "l"; root.appendChild(line); };
  const text = (s) => {
    if (!line) newLine();
    if (!line.firstChild) {
      // Hanging indent: a long line wraps under its own text ("⎿ …"), not back at the left edge, like a wide terminal would show it.
      const h = /^ */.exec(s)[0].length + (/^ *[⎿●·❯] /.test(s) ? 2 : 0);
      line.style.paddingLeft = h + "ch"; line.style.textIndent = -h + "ch";
      if (/^ *[│╭╰]/.test(s)) line.classList.add("pre"); // frames never wrap: a broken border reads as a bug
    }
    let el;
    if (st.href && /^https?:\\/\\//.test(st.href)) { el = document.createElement("a"); el.href = st.href; el.target = "_blank"; el.rel = "noreferrer"; }
    else el = document.createElement("span");
    const c = [st.fg, st.dim && "d", st.bold && "b"].filter(Boolean).join(" ");
    if (c) el.className = c;
    el.textContent = s;
    line.appendChild(el);
  };
  const csi = (args, f) => {
    if (f === "K") { if (line) { line.textContent = ""; line.style.paddingLeft = line.style.textIndent = ""; line.classList.remove("pre"); } return; }
    if (f !== "m") return;
    const p = args === "" ? [0] : args.split(";").map(Number);
    for (let k = 0; k < p.length; k++) {
      const n = p[k];
      if (n === 0) st = { ...st, fg: null, dim: false, bold: false };
      else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 22) { st.bold = false; st.dim = false; }
      else if (n === 39) st.fg = null;
      else if (n === 38 && p[k + 1] === 5) { st.fg = COLORS[p[k + 2]] || null; k += 2; }
    }
  };
  return (input) => {
    const s = pend + input; pend = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\x1b") {
        const rest = s.slice(i);
        let m = /^\\x1b\\[([0-9;?]*)([A-Za-z])/.exec(rest);
        if (m) { csi(m[1], m[2]); i += m[0].length; continue; }
        m = /^\\x1b\\]8;;([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)/.exec(rest);
        if (m) { st.href = m[1] || null; i += m[0].length; continue; }
        if (rest.length < 512) { pend = rest; break; } // a sequence split across two writes
        i++; continue;
      }
      if (c === "\\n") { if (!line) newLine(); newLine(); i++; continue; }
      if (c === "\\r" || c === "\\b") { i++; continue; }
      let j = i;
      while (j < s.length && s[j] !== "\\x1b" && s[j] !== "\\n" && s[j] !== "\\r" && s[j] !== "\\b") j++;
      text(s.slice(i, j)); i = j;
    }
  };
}
let out = renderer(term);
// A line of ANSI text rendered on its own (prompts and options).
function ansi(s) { const el = document.createElement("span"); renderer(el)(s); return el; }
function inline(s) { const w = ansi(s); const frag = document.createDocumentFragment(); w.querySelectorAll(".l").forEach((l) => frag.append(...l.childNodes)); return frag; }

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
const follow = (fn) => { const stick = nearBottom(); fn(); if (stick) scroller.scrollTop = scroller.scrollHeight; };

async function answer(id, value) {
  const el = active && active.el; active = null;
  if (el) el.remove();
  const r = await fetch(base + "/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, value }) });
  if (!r.ok && r.status !== 409) out("\\x1b[38;5;203m● could not send the answer (" + r.status + ")\\x1b[39m\\n");
}

function lastLine() { const ls = term.querySelectorAll(":scope > .l"); return ls[ls.length - 1]; }

function askText(ev) {
  const el = document.createElement("div"); el.className = "l ask";
  el.append(inline(ev.prompt));
  const inp = document.createElement("input");
  inp.type = ev.kind === "secret" ? "password" : "text";
  inp.autocomplete = "off"; inp.spellcheck = false; inp.setAttribute("autocapitalize", "off");
  inp.setAttribute("aria-label", ev.prompt.replace(/\\x1b\\[[0-9;]*m/g, "").trim());
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); answer(ev.id, inp.value); } });
  el.append(inp);
  return { el, focus: () => inp.focus() };
}

function askChoose(ev) {
  const el = document.createElement("div");
  const q = document.createElement("div"); q.className = "l"; q.append(document.createTextNode("  "), inline(ev.prompt)); el.append(q);
  let i = ev.def;
  const btns = ev.options.map((o, n) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "opt";
    const m = document.createElement("span"); m.className = "m";
    b.append(m, inline(o));
    b.addEventListener("click", () => answer(ev.id, n));
    b.addEventListener("mousemove", () => { if (i !== n) { i = n; paint(); } });
    el.append(b);
    return b;
  });
  const paint = () => btns.forEach((b, n) => { b.classList.toggle("on", n === i); b.firstChild.textContent = n === i ? "❯" : ""; b.setAttribute("aria-pressed", String(n === i)); });
  paint();
  const key = (e) => {
    if (e.key === "ArrowDown" || e.key === "j" || e.key === "Tab" && !e.shiftKey) { i = (i + 1) % btns.length; paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp" || e.key === "k" || e.key === "Tab" && e.shiftKey) { i = (i - 1 + btns.length) % btns.length; paint(); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); answer(ev.id, i); }
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= btns.length) { e.preventDefault(); answer(ev.id, Number(e.key) - 1); }
    else if (e.key === "y" && btns.length >= 2) answer(ev.id, 0);
    else if (e.key === "n" && btns.length >= 2) answer(ev.id, 1);
  };
  el.tabIndex = -1; el.style.outline = "none";
  el.addEventListener("keydown", key);
  return { el, focus: () => el.focus() };
}

function askBlock(ev) {
  const el = document.createElement("div");
  const p = document.createElement("div"); p.className = "l"; p.append(inline(ev.prompt)); el.append(p);
  const zone = document.createElement("div"); zone.className = "zone";
  const msg = document.createElement("span");
  const ta = document.createElement("textarea"); ta.setAttribute("aria-label", "Paste your .env here");
  // A real file picker for people who don't drag files (on macOS, ⌘⇧. shows hidden .env files in the dialog).
  const pick = document.createElement("input"); pick.type = "file"; pick.hidden = true;
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "pick"; btn.textContent = "choose a file…";
  btn.addEventListener("click", (e) => { e.stopPropagation(); pick.click(); });
  zone.append(msg, ta, pick); el.append(zone);
  let text = "";
  const useFile = async (f) => {
    if (!f || !active || active.el !== el) return;
    if (f.size > 60000) { msg.textContent = "that file is too large for a .env"; return; }
    // The file is read here, in the page; only its text goes to dd2dash0 (the name rides along as a comment line).
    text = "# dd2dash0-file: " + f.name.replace(/[\\r\\n]/g, " ") + "\\n" + text + (await f.text()) + "\\n";
    answer(ev.id, text);
  };
  pick.addEventListener("change", () => useFile(pick.files && pick.files[0]));
  const lines = () => text.split("\\n").filter((l) => l.trim()).length;
  const show = () => {
    msg.textContent = "";
    if (lines()) msg.append(lines() + " line(s) received, not shown · ", Object.assign(document.createElement("span"), { className: "k", textContent: "⏎" }), " to continue");
    else msg.append("Drop your .env here, ", btn, ", or paste it (", Object.assign(document.createElement("span"), { className: "k", textContent: "⌘V" }), ") · ", Object.assign(document.createElement("span"), { className: "k", textContent: "⏎" }), " to skip");
  };
  show();
  ta.addEventListener("paste", (e) => { e.preventDefault(); text += (e.clipboardData.getData("text") || "") + "\\n"; show(); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); answer(ev.id, text); } else if (!(e.metaKey || e.ctrlKey)) e.preventDefault(); });
  const over = (on) => (e) => { e.preventDefault(); zone.classList.toggle("over", on); };
  document.addEventListener("dragover", over(true)); document.addEventListener("dragleave", over(false));
  document.addEventListener("drop", async (e) => {
    e.preventDefault(); zone.classList.remove("over");
    useFile(e.dataTransfer && e.dataTransfer.files[0]);
  });
  zone.addEventListener("click", () => ta.focus());
  return { el, focus: () => ta.focus() };
}

function ask(ev) {
  if (active) active.el.remove();
  active = ev.kind === "choose" ? askChoose(ev) : ev.kind === "block" ? askBlock(ev) : askText(ev);
  const last = lastLine();
  follow(() => { if (last && !last.textContent) term.insertBefore(active.el, last); else term.appendChild(active.el); });
  active.focus();
}

document.addEventListener("mousedown", (e) => { if (active && !e.target.closest("button,a,input")) setTimeout(() => active && active.focus(), 0); });
document.addEventListener("keydown", (e) => { if (active && document.activeElement === document.body) active.focus(); });

const es = new EventSource(base + "/events");
// Every (re)connection replays the whole session, so start from a clean screen.
es.onopen = () => { term.textContent = ""; out = renderer(term); if (active) { active.el.remove(); active = null; } stateEl.className = "state"; stateEl.textContent = "connected"; };
es.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.t === "out") follow(() => out(ev.s));
  else if (ev.t === "ask") ask(ev);
  else if (ev.t === "link") follow(() => {
    const l = document.createElement("div"); l.className = "l link";
    const a = document.createElement("a"); a.href = ev.url; a.target = "_blank"; a.rel = "noreferrer"; a.textContent = ev.label + " ↗";
    l.append(Object.assign(document.createElement("span"), { className: "d", textContent: "⎿ " }), a);
    term.insertBefore(l, lastLine() && !lastLine().textContent ? lastLine() : null);
  });
  else if (ev.t === "exit") {
    ended = true; // keep the stream open: it tells dd2dash0 this tab still needs the report link
    if (active) { active.el.remove(); active = null; }
    stateEl.className = "state off"; stateEl.textContent = "finished";
    follow(() => { const e = document.createElement("div"); e.className = "end"; e.textContent = "Session ended (exit " + ev.code + "). The report link works until you close this tab."; term.appendChild(e); });
  }
};
es.onerror = () => { if (ended) return; stateEl.className = "state lost"; stateEl.textContent = "disconnected"; };
</script></body></html>`;
}
