// The UI displays the existing deterministic compiler's results. No translation happens here.
// Default: local backend. ?report=<url>: saved report. ?mock=1: explicit UI demo only.
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const reportUrl = params.get("report");
  const mode = reportUrl ? "report" : params.get("mock") === "1" ? "mock" : "api";

  // Review is a UI grouping, not a change to the compiler's publish eligibility.
  const STATUS = {
    translated: "converted",
    approximated: "review",
    assumed: "review",
    best_effort: "review",
    partial: "review",
    blocked: "unsupported",
  };
  const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

  // Is diagnostic path `p` at or below item path `base`? (Same rule as migrator.report.)
  const within = (p, base) => base === "" || p === base || p.startsWith(base + ".") || p.startsWith(base + "[");

  function fromReport(report) {
    if (!report || !Array.isArray(report.items)) throw new Error("report.json has no items array");
    const diags = Array.isArray(report.diagnostics) ? report.diagnostics : [];
    const dashTitle = new Map(
      report.items.filter((i) => i.kind === "dashboard").map((i) => [i.sourceId, i.title]));

    // One UI item per widget and per monitor: the units a person checks. Dashboards are their sum.
    return report.items
      .filter((i) => i.kind === "widget" || i.kind === "monitor")
      .map((i, n) => {
        if (!Object.hasOwn(STATUS, i.outcome)) throw new Error(`unknown outcome "${i.outcome}" in report.json`);
        const status = STATUS[i.outcome];
        const mine = diags
          .filter((d) => d.sourceId === i.sourceId && within(d.sourcePath || "", i.sourcePath || ""))
          .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
        const top = mine.find((d) => d.severity !== "info");
        const remarks = (i.remarks || []).join(", ");
        const why = top ? top.message
          : status === "converted"
            ? (remarks ? `Converted with remarks: ${remarks}.` : "Converted.")
            : "No diagnostic recorded.";
        return {
          id: `r${n}`,
          name: i.title || i.sourcePath || i.sourceId,
          status,
          outcome: i.outcome,
          remarks: i.remarks || [],
          diagnostics: mine,
          warningNames: i.outcome === "translated" ? [] : [...new Set([
            ...(i.remarks || []),
            ...mine.filter((d) => d.severity === "warning").map((d) => d.remark || d.code),
          ])],
          parent: dashTitle.get(i.sourceId) || "Monitor",
          why,
          action: top && top.suggestedAction ? top.suggestedAction : "",
          from: top && top.sourceText ? top.sourceText : `${i.sourceId} ${i.sourcePath}`.trim(),
          to: status === "unsupported" ? (top ? top.code : "blocked") : (dashTitle.get(i.sourceId) || i.kind),
          source: { id: i.sourceId, path: i.sourcePath, kind: i.kind },
          // No `suggestion`: the backend never proposes fixes (AGENTS.md: no model in the conversion path).
        };
      });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.MigrateBackend = {
    mode,
    result: null,
    ai: { remaining: 0, available: false },

    async load(files = []) {
      if (mode === "mock") return window.MIGRATION_ITEMS;
      let res;
      try {
        if (mode === "report") {
          const url = new URL(reportUrl, location.href);
          if (url.origin !== location.origin) throw new Error("Use a same-origin report URL.");
          res = await fetch(url.href, { cache: "no-store" });
        } else {
          const uploaded = await Promise.all(Array.from(files, async (file) => ({ name: file.name, text: await file.text() })));
          res = await fetch("/api/convert", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ files: uploaded }),
          });
        }
      } catch (err) {
        throw new Error(`Could not load conversion results: ${err.message}. Start the local backend with uv run python -m backend.server.`);
      }
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || `Could not load results (HTTP ${res.status}). Start uv run python -m backend.server.`);
      }
      const result = await res.json();
      const report = mode === "report" ? result : result.report;
      const items = fromReport(report);
      this.result = mode === "report" ? { report } : result;
      this.ai = result.ai || { remaining: 0, available: false };
      return items;
    },

    async suggest(item) {
      if (mode !== "api" || item.outcome !== "blocked") throw new Error("AI help is only available for failed translations from this backend.");
      const res = await fetch("/api/suggest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: this.result.runId, sourceId: item.source.id, sourcePath: item.source.path }),
      });
      const data = await res.json();
      if (data.ai) this.ai = data.ai;
      if (!res.ok) throw new Error(data.error || "Agent0 could not complete this request.");
      return data.recommendation;
    },

    // Real results are already complete: never simulate per-item compiler progress.
    async process(it) {
      if (mode === "mock") await sleep(700 + Math.random() * 1000);
      return it;
    },

    fromReport, // exposed for tests and the console
  };
})();
