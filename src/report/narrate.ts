// Events -> short spoken-style sentences. Deterministic templates, no LLM: the voice agent reads (and can be asked
// about) these. The agent only explains a finished, deterministic run; it never takes part in translation.
import type { RunEvent } from "./events.js";

const pct = (x: number) => `${Math.floor(x * 1000) / 10} percent`;

export function narrate(e: RunEvent): string | null {
  switch (e.type) {
    case "run.start":
      return `Starting migration: ${e.dashboards} Datadog dashboards and ${e.alerts} monitors, ${e.mode === "live" ? "importing live into Dash0" : e.mode === "dry-run" ? "as a dry run" : "translation only"}.`;
    case "dashboard.start":
      return `Translating "${e.dashboard}", ${e.panels} widgets.`;
    case "item.done":
      if (e.kind === "alert") {
        if (e.status === "manual") return `Monitor "${e.title}" needs a person: ${e.reason_codes.join(", ") || "no rule"}.`;
        return `Monitor "${e.title}" became a Dash0 check rule, ${e.status}.`;
      }
      // Only speak about the interesting panels; exact ones are counted at the end of the dashboard.
      if (e.status === "manual" || e.status === "unsupported") return `"${e.title}" (${e.widget_type}) can't be migrated automatically: ${e.reason_codes[0] ?? "unsupported"}. A placeholder keeps the original.`;
      return null;
    case "dashboard.done": {
      const b = e.byStatus;
      const ok = (b.exact ?? 0) + (b["exact-under"] ?? 0);
      return `"${e.dashboard}" done: ${ok} exact, ${b.bounded ?? 0} within a stated error bound, ${(b.manual ?? 0) + (b.unsupported ?? 0)} left for a person.`;
    }
    case "import.done":
      return e.mode === "dry-run"
        ? `Dry run: ${e.written} Dash0 payloads written, ${e.rejected} rejected by the preflight checks.`
        : `Imported ${e.imported} items into Dash0; ${e.readBackMatch} read back identical${e.failed ? `, ${e.failed} failed` : ""}.`;
    case "run.done": {
      const gaps = e.topGaps.slice(0, 3).map((g) => `${g.meaning} (${g.count})`).join("; ");
      return `Finished. ${pct(e.coverageTranslated)} of query panels translated, ${pct(e.coverageExact)} exactly or under stated assumptions. Biggest remaining gaps: ${gaps || "none"}.`;
    }
  }
}
