// `dd2dash0 review <plan>`: serves the review console with the plan's data on 127.0.0.1 (CONTRACT-003 §7).
//   GET  /report.json   the plan's report.json, byte for byte (the console's report_sha256 is over these bytes)
//   GET  /api/plan      { planHash, reportSha256, reviewOrder, decided }
//   GET  /review.json   the saved review of this plan, if any
//   POST /api/review    a review.json from the console: checked against the plan, then saved as plan/review.json
//   GET  /*             the built console (static files, SPA fallback to index.html); a notice page if it isn't built
// No external network, no AI. The console decides nothing: every check happens here, with the same code `apply` uses.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { checkReview, parseReview, ReviewError } from "../../src/pipeline/review.js";
import { itemsOf, openReview, saveReview, type ReviewSession } from "../../src/pipeline/review-session.js";

export interface ReviewServerOptions {
  planDir: string;
  port: number;
  /** Folder with the built console (index.html + assets). Missing: a notice page explains how to build it. */
  consoleDir?: string;
  reviewer?: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Candidate console builds: the packaged copy next to the CLI, then the repo's console build (SPA: console/.output/public). */
export function findConsoleDir(fromDir: string): string | undefined {
  for (const c of [
    join(fromDir, "..", "console"),
    join(fromDir, "..", "console", ".output", "public"),
    join(fromDir, "..", "..", "console", ".output", "public"),
    join(fromDir, "..", "..", "console", "dist"),
    join(fromDir, "..", "..", "console", "dist", "client"),
  ])
    if (existsSync(join(c, "index.html"))) return c;
  return undefined;
}

function noticePage(s: ReviewSession): string {
  const q = s.queue.length;
  return `<!doctype html><meta charset="utf-8"><title>dd2dash0 review</title>
<body style="font:15px system-ui;max-width:46rem;margin:3rem auto;line-height:1.5">
<h1>dd2dash0 review</h1>
<p>Plan <code>${s.planHash.slice(0, 12)}</code>: ${q} item(s) need a decision, ${s.decisions.size} decided.</p>
<p>The review console isn't built in this checkout. Build it once with <code>cd console &amp;&amp; npx bun install &amp;&amp; npx bun run build</code>, then run <code>dd2dash0 review</code> again.
Or review in the terminal: <code>dd2dash0 review ${s.planDir} --terminal</code>.</p>
<p>The plan's report is at <a href="/report.json">/report.json</a>.</p></body>`;
}

export function startReviewServer(o: ReviewServerOptions): Promise<{ server: Server; url: string }> {
  const planDir = resolve(o.planDir);
  // Fail before listening if the plan is broken; the session is re-opened per request so saved decisions stay current.
  openReview(planDir, o.reviewer ?? "");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, type: string, body: string | Buffer) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    const json = (x: unknown, code = 200) => send(code, "application/json", JSON.stringify(x));
    try {
      const s = openReview(planDir, o.reviewer ?? "");
      if (req.method === "GET" && url.pathname === "/report.json") return send(200, "application/json", readFileSync(join(planDir, "report.json")));
      if (req.method === "GET" && url.pathname === "/api/plan")
        return json({ planHash: s.planHash, reportSha256: s.reportSha256, reviewOrder: s.queue.map((i) => i.id), decided: s.decisions.size });
      if (req.method === "GET" && url.pathname === "/review.json") {
        const f = join(planDir, "review.json");
        return existsSync(f) ? send(200, "application/json", readFileSync(f)) : json({ error: "no review saved for this plan yet" }, 404);
      }
      if (url.pathname === "/api/review") {
        if (req.method !== "POST") return json({ error: "POST a review.json" }, 405);
        const body = await readBody(req, 5_000_000);
        let review;
        try {
          review = parseReview(body, "request body");
        } catch (e) {
          if (e instanceof ReviewError) return json({ error: e.message }, 400);
          throw e;
        }
        const check = checkReview(review, { planHash: s.planHash, reportSha256: s.reportSha256, items: itemsOf(s.report) });
        if (!check.ok) return json({ error: "review does not fit this plan", problems: check.errors }, 409);
        s.decisions = check.decisions;
        if (review.reviewer) s.reviewer = review.reviewer;
        const file = saveReview(s);
        return json({ ok: true, file, pending: check.pending, skippedAlerts: check.skippedAlerts, warnings: check.warnings });
      }
      if (req.method !== "GET") return json({ error: "not found" }, 404);
      // Static console, confined to its folder; unknown paths fall back to index.html (client-side routes).
      if (!o.consoleDir) return send(200, "text/html; charset=utf-8", noticePage(s));
      const root = resolve(o.consoleDir);
      const p = normalize(join(root, decodeURIComponent(url.pathname)));
      if (p !== root && !p.startsWith(root + sep)) return json({ error: "not found" }, 404);
      const file = existsSync(p) && statSync(p).isFile() ? p : join(root, "index.html");
      return send(200, TYPES[extname(file)] ?? "application/octet-stream", readFileSync(file));
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : o.port;
      ok({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function readBody(req: import("node:http").IncomingMessage, max: number): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        fail(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}
