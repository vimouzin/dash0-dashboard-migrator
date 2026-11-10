// Which Datadog tags or facets a query groups by. Used by ingest (a sunburst is a single-level breakdown) and by T5
// (the columns of a table can be joined on one row per group only when every column groups by the same labels).
import type { SourceQuery } from "./types.js";

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The grouping of one query, sorted, in the vendor's own names. Logs: the group_by facets. Metrics: the tags in `by {...}`.
 * `null` = not a metric or log query, so there is nothing to compare.
 */
export function groupTags(q: SourceQuery): string[] | null {
  if (q.dataSource === "logs") {
    const gb = isObj(q.raw) ? q.raw.group_by : undefined;
    const facets = Array.isArray(gb) ? gb.map((g) => (isObj(g) ? g.facet : undefined)) : isObj(gb) && Array.isArray(gb.fields) ? gb.fields : [];
    return facets.filter((f): f is string => typeof f === "string" && f !== "").sort();
  }
  if (q.dataSource === "metrics") {
    const m = /\bby\s*\{([^}]*)\}/i.exec(q.expr);
    return m ? m[1]!.split(",").map((t) => t.trim()).filter(Boolean).sort() : [];
  }
  return null;
}

/** True when every query is a metric or log query and all of them group by exactly the same tags. */
export function sameGrouping(queries: SourceQuery[]): boolean {
  const groups = queries.map(groupTags);
  if (groups.length === 0 || groups.some((g) => g === null)) return false;
  const first = JSON.stringify(groups[0]);
  return groups.every((g) => JSON.stringify(g) === first);
}
