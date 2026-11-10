// Validate emitted PromQL with the official grammar (@prometheus-io/lezer-promql).
// Dashboard/Dash0 placeholders are not PromQL, so they are substituted with neutral values first:
// durations like [$__interval] or offset $__interval -> 1m, and a bare $__threshold -> 0. Variables inside strings are left alone.
import { parser } from "@prometheus-io/lezer-promql";

export interface PromQLError {
  from: number;
  to: number;
  message: string;
}

export function substitutePlaceholders(q: string): string {
  return q
    .replace(/\[\$\w+\]/g, "[1m]")
    .replace(/\[\$\w+:/g, "[1m:")
    .replace(/:\$\w+\]/g, ":1m]")
    .replace(/\boffset \$\w+/g, "offset 1m")
    .replace(/(?<!")\$__threshold\b/g, "0");
}

export function validatePromQL(q: string): { ok: boolean; errors: PromQLError[] } {
  const text = substitutePlaceholders(q);
  const errors: PromQLError[] = [];
  if (!text.trim()) return { ok: false, errors: [{ from: 0, to: 0, message: "empty query" }] };
  parser.parse(text).iterate({
    enter: (n) => {
      if (n.type.isError) errors.push({ from: n.from, to: n.to, message: `syntax error near '${text.slice(n.from, n.to + 1) || "end"}'` });
    },
  });
  return { ok: errors.length === 0, errors };
}
