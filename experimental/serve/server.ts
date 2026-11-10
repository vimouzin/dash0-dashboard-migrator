// `dd2dash0 serve`: a local page that replays a run live (Server-Sent Events), with an optional ElevenLabs voice
// narrator that you can talk to. No framework; binds to 127.0.0.1 only. Reads <out>/report.json (written by
// `migrate`) and derives the events, so any recorded run replays exactly (safe for a live demo).
// The ElevenLabs API key stays on this server: the page only ever gets a short-lived conversation token.
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { reportToEvents } from "../../src/report/events.js";
import { narrate } from "../../src/report/narrate.js";
import type { Report } from "../../src/report/types.js";
import { VIEWER_HTML } from "./viewer.js";

export interface ServeOptions {
  outDir: string;
  port: number;
  /** Delay between events in ms, so a person (and the voice) can follow. Overridable per request: /events?pace=. */
  pace: number;
  /** ElevenLabs agent id. With elevenLabsKey, the page gets a voice narrator. */
  agentId?: string;
  /** ElevenLabs API key: used server-side only to mint conversation tokens. Never sent to the browser. */
  elevenLabsKey?: string;
  fetch?: typeof fetch;
}

export function loadReport(outDir: string): Report {
  const p = join(outDir, "report.json");
  if (!existsSync(p)) throw new Error(`${p} not found: run 'dd2dash0 migrate ... --out ${outDir}' first`);
  return JSON.parse(readFileSync(p, "utf8")) as Report;
}

/** Compact run summary for the voice agent's get_summary tool: small enough to read aloud from. */
export function summaryForAgent(r: Report) {
  const events = reportToEvents(r);
  const done = events.find((e) => e.type === "run.done");
  return {
    dashboards: r.summary.dashboards,
    monitors: r.summary.alerts,
    coverage_translated_pct: Math.floor(r.summary.coverageTranslated * 1000) / 10,
    coverage_exact_pct: Math.floor(r.summary.coverageExact * 1000) / 10,
    by_kind: r.summary.byKind,
    import: r.summary.import,
    top_gaps: done && done.type === "run.done" ? done.topGaps : [],
    not_migrated: r.items
      .filter((i) => i.status === "manual" || i.status === "unsupported")
      .map((i) => ({ id: i.id, title: i.title, type: i.widget_type, why: i.reason_codes })),
    status_meanings: {
      exact: "same numbers as Datadog for any data",
      "exact-under": "same numbers while the listed assumptions hold",
      bounded: "within a stated error bound",
      manual: "not translated; the original is kept and reported",
      unsupported: "Dash0 has no equivalent widget; a placeholder panel keeps the original",
    },
  };
}

export function startServer(o: ServeOptions): Promise<{ server: Server; url: string }> {
  const f = o.fetch ?? fetch;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    const json = (x: unknown, code = 200) => send(code, "application/json", JSON.stringify(x));
    try {
      switch (url.pathname) {
        case "/":
          return send(200, "text/html; charset=utf-8", VIEWER_HTML);
        case "/config.json":
          return json({ voice: !!(o.agentId && o.elevenLabsKey), pace: o.pace });
        case "/report.json":
          return json(loadReport(o.outDir));
        case "/report.md":
          return send(200, "text/markdown; charset=utf-8", readFileSync(join(o.outDir, "report.md"), "utf8"));
        case "/vendor/elevenlabs.js": {
          // The SDK's own browser build from node_modules (pinned in package.json), so nothing loads from a CDN.
          // Optional dependency, only for the voice narrator in serve: migrate never loads it.
          let p: string;
          try {
            p = createRequire(import.meta.url).resolve("@elevenlabs/client").replace(/index\.js$/, "lib.iife.js");
          } catch {
            return send(404, "text/plain; charset=utf-8", "voice narrator not installed (optional dependency @elevenlabs/client)");
          }
          return send(200, "text/javascript; charset=utf-8", readFileSync(p, "utf8"));
        }
        case "/api/el-token": {
          if (!o.agentId || !o.elevenLabsKey) return json({ error: "voice not configured (ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY)" }, 404);
          const r = await f(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(o.agentId)}`, { headers: { "xi-api-key": o.elevenLabsKey } });
          if (!r.ok) return json({ error: `ElevenLabs token request failed: ${r.status}` }, 502); // never echo the key
          const { token } = (await r.json()) as { token?: string };
          return json({ token });
        }
        case "/api/summary":
          return json(summaryForAgent(loadReport(o.outDir)));
        case "/api/item": {
          const q = (url.searchParams.get("id") ?? url.searchParams.get("q") ?? "").toLowerCase();
          const items = loadReport(o.outDir).items.filter((i) => i.id.toLowerCase() === q || i.title.toLowerCase().includes(q));
          return json(
            items.slice(0, 5).map((i) => ({
              id: i.id, title: i.title, dashboard: i.dashboard, type: i.widget_type, status: i.status,
              datadog: i.source_queries, promql: i.promql, why: i.findings.map((x) => `${x.code}: ${x.message}`),
              assumptions: i.certificate.assumptions, manual_actions: i.manual_actions ?? [],
            })),
          );
        }
        case "/events": {
          const pace = Math.max(0, Math.min(5000, Number(url.searchParams.get("pace") ?? o.pace) || 0));
          const events = reportToEvents(loadReport(o.outDir));
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          let i = 0;
          const tick = () => {
            if (res.destroyed) return;
            if (i >= events.length) {
              res.write("event: end\ndata: {}\n\n");
              return res.end();
            }
            const e = events[i++]!;
            res.write(`data: ${JSON.stringify({ ...e, say: narrate(e) })}\n\n`);
            // Linger on what people should hear about.
            const slow = e.type === "run.done" || e.type === "dashboard.done" || (e.type === "item.done" && (e.status === "manual" || e.status === "unsupported"));
            setTimeout(tick, slow ? pace * 3 : pace);
          };
          tick();
          req.on("close", () => res.destroy());
          return;
        }
        default:
          return send(404, "text/plain", "not found");
      }
    } catch (e) {
      send(500, "text/plain", (e as Error).message);
    }
  });
  return new Promise((resolve) => server.listen(o.port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })));
}
