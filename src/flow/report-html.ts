// <run>/report.html: the run report in the same terminal look as the CLI and the key page. One offline file, no
// external assets, no script. Light and dark follow the system.
import type { Num, Row, RunFacts, Score } from "./score.js";
import { reasonsText } from "./score.js";
import { coverageHeadline, pct1, type QueryCoverage } from "../report/query-coverage.js";

/**
 * Coverage by query type: one row per kind, best first. The bar has two shades: exact under a stated condition
 * (solid) and within a proven bound (lighter); the gap is what stays with a person, named underneath.
 */
function coverageSection(c: QueryCoverage | undefined): string {
  if (!c?.total) return "";
  const w = (a: number, b: number) => (b ? Math.floor((a * 1000) / b) / 10 : 0);
  const rows = c.rows
    .map((r) => {
      const why = reasonsText(r);
      return `<div class="qt"><span class="ql">${esc(r.label)}</span><span class="qb" role="img" aria-label="${pct1(r.translated, r.total)} translated, ${pct1(r.exact, r.total)} exact"><i style="width:${w(r.exact, r.total)}%"></i><i class="b" style="width:${w(r.translated - r.exact, r.total)}%"></i></span><span class="qv">${pct1(r.translated, r.total)}</span><span class="qn dim">${r.translated.toLocaleString("en")} of ${r.total.toLocaleString("en")}</span>${why ? `<span class="qw dim">⎿ ${esc(why)}</span>` : ""}</div>`;
    })
    .join("\n");
  return `<section class="cov"><h2><span class="dot">●</span> Coverage by query type</h2>
<p class="head">${esc(coverageHeadline(c))}</p>
<div class="legend dim"><span><i></i> exact under a stated condition</span><span><i class="b"></i> within a proven bound</span><span><i class="g"></i> stays with a person</span></div>
${rows}
<p class="dim note">⎿ distinct queries: the same query in two widgets counts once, at its worst result; percentages round down${c.anomalyMonitors ? `<br>⎿ anomaly monitors (${c.anomalyMonitors}) count as metric monitors. They stay with a person, because dd2dash0 doesn't guess.` : ""}</p></section>`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function meter(name: string, n: Num | null, what: string): string {
  if (!n) return `<div class="m"><span class="k">${name}</span><span class="bar"><i style="width:0"></i></span><span class="v dim">not measured</span><span class="w dim">${esc(what)}</span></div>`;
  return `<div class="m"><span class="k">${name}</span><span class="bar" role="img" aria-label="${n.pct}%"><i style="width:${n.total ? Math.floor((n.count * 100) / n.total) : 0}%"></i></span><span class="v">${n.count}/${n.total} <b>${n.pct}%</b></span><span class="w dim">${esc(what)}</span></div>`;
}

const mark = (b: boolean | null) => (b === null ? `<span class="dim">–</span>` : b ? `<span class="ok">✓</span>` : `<span class="bad">✗</span>`);
const liveCell = (l: Row["live"]) => (l === null ? `<span class="dim">–</span>` : l === "live" ? `<span class="ok">live</span>` : l === "missing" || l === "error" ? `<span class="bad">${l}</span>` : `<span class="dim">${l}</span>`);

export function reportHtml(score: Score, rows: Row[], facts: RunFacts, coverage?: QueryCoverage): string {
  const panels = rows.filter((r) => r.kind === "panel");
  const dashboards = [...new Set(panels.map((r) => r.dashboard ?? "(no dashboard)"))];
  const monitors = rows.filter((r) => r.kind === "alert");
  const attention = rows.filter((r) => !r.translated || r.landed === false || r.live === "missing" || r.live === "error");
  const lc = score.liveCounts;

  const dashSection = (d: string) => {
    const ps = panels.filter((r) => (r.dashboard ?? "(no dashboard)") === d);
    const ok = ps.filter((r) => r.success).length;
    return `<section><h2><span class="dot">●</span> ${esc(d)} <span class="dim">· ${ps.length} panels${score.success ? ` · ${ok} succeeded` : ""}</span></h2>
<table><thead><tr><th>panel</th><th>widget</th><th>claim</th><th>decision</th><th>tr</th><th>landed</th><th>live</th><th>reasons</th></tr></thead><tbody>
${ps.map((r) => `<tr><td>${esc(r.title || "(untitled)")}</td><td class="dim">${esc(r.widget)}</td><td><span class="claim c-${esc(r.status)}">${esc(r.status)}</span></td><td class="dim">${esc(r.decision)}</td><td>${mark(r.translated)}</td><td>${mark(r.landed)}</td><td>${liveCell(r.live)}</td><td class="dim">${esc(r.reasons.join(", "))}</td></tr>`).join("\n")}
</tbody></table></section>`;
  };

  const monSection = monitors.length
    ? `<section><h2><span class="dot">●</span> Monitors <span class="dim">· ${monitors.length}</span></h2>${monitors
        .map(
          (r) => `<div class="mon"><div><b>${esc(r.title || r.id)}</b> <span class="claim c-${esc(r.status)}">${esc(r.status)}</span> <span class="dim">· ${esc(r.decision)} · landed</span> ${mark(r.landed)}${r.enabled !== undefined ? ` <span class="dim">· ${r.enabled ? "on" : "off"}</span>` : ""}</div>
${r.sourceQueries.map((q) => `<div class="q"><span class="dim">⎿ Datadog</span> <code>${esc(q)}</code></div>`).join("")}${r.promql.map((q) => `<div class="q"><span class="dim">⎿ PromQL </span> <code>${esc(q)}</code></div>`).join("")}${r.thresholds ? `<div class="q dim">⎿ failed &gt; ${r.thresholds.failed}${r.thresholds.degraded !== undefined ? ` · degraded &gt; ${r.thresholds.degraded}` : ""}</div>` : ""}${r.reasons.length ? `<div class="q dim">⎿ ${esc(r.reasons.join(", "))}</div>` : ""}</div>`,
        )
        .join("")}</section>`
    : "";

  const attentionSection = `<section><h2><span class="dot">●</span> Needs attention <span class="dim">· ${attention.length}</span></h2>${
    attention.length
      ? `<ul class="att">${attention
          .map((r) => {
            const why: string[] = [];
            if (!r.translated) why.push(`not translated exactly (${r.status}${r.decision.startsWith("placeholder") ? ", landed as a placeholder with the original query" : ""})`);
            if (r.landed === false) why.push(`did not land: ${r.landedDetail}`);
            if (r.live === "missing") why.push(`Datadog has data, Dash0 has none: ${r.liveDetail ?? ""}`);
            if (r.live === "error") why.push(`Dash0 rejected the query: ${r.liveDetail ?? ""}`);
            return `<li><b>${esc(r.title || r.id)}</b>${r.dashboard ? ` <span class="dim">· ${esc(r.dashboard)}</span>` : ""}<div class="dim">⎿ ${esc(why.join("; "))}${r.reasons.length ? ` · ${esc(r.reasons.join(", "))}` : ""}</div>${r.manualActions.map((a) => `<div class="dim">⎿ to do: ${esc(a)}</div>`).join("")}</li>`;
          })
          .join("")}</ul>`
      : `<p class="dim">⎿ Nothing.</p>`
  }</section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dd2dash0 report · ${esc(facts.startedAt.slice(0, 16).replace("T", " "))}</title>
<style>
:root{--bg:#0c0d10;--fg:#d7d9de;--dim:#6c717b;--line:#23262c;--accent:#87afff;--ok:#5fd787;--bad:#ff5f5f;--warn:#d7af5f;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fbfbfa;--fg:#1d1f23;--dim:#7a7f88;--line:#e4e4e1;--accent:#3a63d8;--ok:#1f8a4c;--bad:#c93a3a;--warn:#9a6b12;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:13.5px/1.6 ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased;padding:7vh 24px 64px}
main{max-width:1040px;margin:0 auto}.dim{color:var(--dim)}.ok{color:var(--ok)}.bad{color:var(--bad)}.dot{color:var(--accent)}b{font-weight:600}
.frame{border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin-bottom:26px;display:inline-block}
.mark{color:var(--accent)}
.meters{margin:0 0 30px}.m{display:grid;grid-template-columns:11ch minmax(120px,260px) minmax(13ch,max-content) 1fr;gap:14px;align-items:center;padding:3px 0}.m .v{white-space:nowrap;font-variant-numeric:tabular-nums}
.k{color:var(--dim)}.m:first-child .k,.m:first-child .v{color:var(--fg);font-weight:600}
.bar{height:8px;border-radius:2px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
.facts{margin:-14px 0 30px}.facts div{padding:1px 0}
section{margin:0 0 34px}h2{font-size:13.5px;font-weight:600;margin:0 0 10px}
table{width:100%;border-collapse:collapse}th{font-weight:400;color:var(--dim);text-align:left;border-bottom:1px solid var(--line);padding:4px 10px 6px 0}
td{border-bottom:1px solid var(--line);padding:5px 10px 5px 0;vertical-align:top}tr:last-child td{border-bottom:0}
.claim{font-size:12px}.c-exact,.c-exact-under{color:var(--ok)}.c-bounded{color:var(--accent)}.c-manual{color:var(--warn)}.c-unsupported{color:var(--bad)}
.mon{padding:6px 0 10px}.q{padding-left:2ch}code{font:inherit;white-space:pre-wrap;word-break:break-word}
.att{list-style:none;margin:0;padding:0}.att li{padding:5px 0}
.cov .head{margin:0 0 12px;max-width:72ch}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin:0 0 10px}.legend i{display:inline-block;width:10px;height:8px;border-radius:2px;background:var(--accent);vertical-align:0}.legend i.b{opacity:.45}.legend i.g{background:var(--line)}
.qt{display:grid;grid-template-columns:16ch minmax(140px,1fr) 7ch 15ch;gap:4px 14px;align-items:center;padding:4px 0}
.ql{font-weight:600}.qv{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}.qn{font-variant-numeric:tabular-nums}
.qb{display:flex;height:8px;border-radius:2px;background:var(--line);overflow:hidden}.qb i{display:block;height:100%;background:var(--accent)}.qb i.b{opacity:.45}
.qw{grid-column:2/-1;font-size:12px;margin-top:-2px}
.cov .note{margin-top:10px}
@media (max-width:760px){.qt{grid-template-columns:1fr 7ch}.qb{grid-column:1/-1;grid-row:2}.qn{display:none}.qw{grid-column:1/-1}.m{grid-template-columns:11ch 1fr 12ch}.m .w{display:none}table{display:block;overflow-x:auto}}
</style></head><body><main>
<div class="frame"><div><span class="mark">◆</span> <b>dd2dash0</b> <span class="dim">${esc(facts.version)} · migration report</span></div>
<div class="dim">${esc(facts.source)} → ${esc(facts.target)}</div>
<div class="dim">${score.panels} panel${score.panels === 1 ? "" : "s"} · ${score.monitors} monitor${score.monitors === 1 ? "" : "s"} · ${facts.mode === "live" ? "live import" : "dry run, nothing imported"} · ${esc(facts.startedAt.replace("T", " ").slice(0, 19))} UTC</div></div>
<div class="meters">
${meter("success", score.success, "translated, landed and not missing data")}
${meter("translated", score.translated, "exact, exact-under or approved bounded")}
${meter("landed", score.landed, "imported and read back from Dash0")}
${meter("live", score.live, "Dash0 returns data when Datadog does (last 1 h)")}
</div>
<div class="facts dim">
${lc ? `<div>⎿ live check: ${lc.live} live · ${lc.missing} missing in Dash0 · ${lc.error} query errors · ${lc["no-data"]} no data either side · ${lc["n/a"]} no query</div>` : ""}
${score.topGaps.length ? `<div>⎿ top gaps: ${score.topGaps.map(([c, n]) => `${esc(c)} ×${n}`).join(" · ")}</div>` : ""}
<div>⎿ percentages round down; every panel (notes too) and every monitor counts</div>
</div>
${coverageSection(coverage)}
${attentionSection}
${dashboards.map(dashSection).join("\n")}
${monSection}
<p class="dim">◆ dd2dash0 ${esc(facts.version)} · plan ${esc(facts.planHash.slice(0, 16))} · input ${esc(facts.inputHash.slice(0, 16))} · output ${esc(facts.outputHash.slice(0, 16))} · deterministic: parsers, rules and mapping tables, no AI</p>
</main></body></html>
`;
}
