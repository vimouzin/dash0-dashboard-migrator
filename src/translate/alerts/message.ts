// Datadog monitor message (Mustache-like) -> Dash0 annotation (Go template). A tokenizer, not regex soup:
// every {{…}} token is either rewritten by a catalog rule or escaped as literal text, so the output always parses
// as a Go template. @handles are removed and returned as channels to recreate by hand.

export interface MessageContext {
  /** Datadog tag key -> PromQL label. */
  label: (ddTag: string) => string;
  /** Datadog's threshold values, substituted for {{threshold}} / {{warn_threshold}}. */
  critical?: number;
  warning?: number;
}

export interface MessageResult {
  text: string;
  /** Catalog rule ids applied, in order of first use. */
  rules: string[];
  channels: string[];
  /** Tokens escaped as literal text (alert.msg.unknown-token). */
  unknown: string[];
  /** Sections removed because they only apply to recovery / no-data notifications. */
  dropped: string[];
  /**
   * Where each handle appeared: "always" (outside any section), "alert" ({{#is_alert}}), "warning"
   * ({{#is_warning}}), or "recovery" (a dropped recovery / no-data section). Decides the Dash0 channel binding.
   */
  handleScopes: Record<string, HandleScope[]>;
}

export type HandleScope = "always" | "alert" | "warning" | "recovery";

/** Firing sections that narrow who Datadog notifies. */
const SCOPE_OF: Record<string, HandleScope> = { is_alert: "alert", is_warning: "warning", is_alert_to_warning: "warning", is_warning_to_alert: "alert" };

/** Sections whose text applies while the alert fires: keep the text, drop the markers. */
const FIRING = new Set(["is_alert", "is_warning", "is_alert_to_warning", "is_warning_to_alert"]);
/** Sections that never apply to a firing notification: drop text and markers. */
const NOT_FIRING = new Set(["is_recovery", "is_alert_recovery", "is_warning_recovery", "is_no_data", "is_renotify", "is_priority"]);

/** Go double-quoted string literal (JSON escaping is a subset Go accepts). */
const goString = (s: string) => JSON.stringify(s);
const literal = (s: string) => `{{ ${goString(s)} }}`;

/** Remove @handles. A handle starts a word: "@slack-ops", "@pagerduty-db", "@jane@example.com". */
function stripHandles(text: string, channels: string[], scopes: Record<string, HandleScope[]>, scope: HandleScope): string {
  return text.replace(/(^|[\s(])@([A-Za-z0-9][A-Za-z0-9_.+-]*(?:@[A-Za-z0-9.-]+)?)/g, (_m, pre: string, h: string) => {
    const handle = `@${h.replace(/[.]+$/, "")}`;
    if (!channels.includes(handle)) channels.push(handle);
    const list = (scopes[handle] ??= []);
    if (!list.includes(scope)) list.push(scope);
    return pre;
  });
}

export function rewriteMessage(src: string, ctx: MessageContext): MessageResult {
  const rules: string[] = [];
  const channels: string[] = [];
  const unknown: string[] = [];
  const dropped: string[] = [];
  const handleScopes: Record<string, HandleScope[]> = {};
  const use = (id: string) => {
    if (!rules.includes(id)) rules.push(id);
  };

  // Split into text and {{…}} / {{{…}}} tokens.
  const parts: Array<{ text: string } | { token: string; raw: string }> = [];
  const re = /\{\{\{\s*([^}]*?)\s*\}\}\}|\{\{\s*([^}]*?)\s*\}\}/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) parts.push({ text: src.slice(last, m.index) });
    parts.push({ token: (m[1] ?? m[2] ?? "").trim(), raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push({ text: src.slice(last) });

  let out = "";
  const skip: string[] = []; // stack of NOT_FIRING sections currently open
  const firing: string[] = []; // stack of open FIRING sections (their markers are removed, their text kept)
  for (const p of parts) {
    if ("text" in p) {
      if (skip.length > 0) stripHandles(p.text, channels, handleScopes, "recovery"); // text dropped, handles still recorded
      else {
        const inner = firing.length > 0 ? (SCOPE_OF[firing[firing.length - 1]!] ?? "always") : "always";
        out += stripHandles(p.text, channels, handleScopes, inner).replace(/\{\{|\}\}/g, (b) => literal(b));
      }
      continue;
    }
    const t = p.token;
    const section = /^([#^/])\s*([a-z_]+)$/.exec(t);
    if (section) {
      const [, kind, name] = section as unknown as [string, string, string];
      if (NOT_FIRING.has(name) || (kind === "^" && FIRING.has(name))) {
        if (kind === "/") {
          if (skip[skip.length - 1] === name) skip.pop();
        } else {
          skip.push(name);
          if (!dropped.includes(`${kind}${name}`)) dropped.push(`${kind}${name}`);
          use("alert.msg.conditional.drop");
        }
        continue;
      }
      if (FIRING.has(name)) {
        use("alert.msg.conditional");
        if (kind === "#") firing.push(name);
        else if (kind === "/" && firing[firing.length - 1] === name) firing.pop();
        continue; // marker removed, its text stays
      }
    }
    if (skip.length > 0) continue;
    if (t === "value") {
      use("alert.msg.value");
      out += "{{ $value }}";
    } else if ((t === "threshold" && ctx.critical !== undefined) || (t === "warn_threshold" && ctx.warning !== undefined)) {
      use("alert.msg.threshold");
      out += String(t === "threshold" ? ctx.critical : ctx.warning);
    } else if (/^[A-Za-z_][A-Za-z0-9_.-]*\.name$/.test(t)) {
      use("alert.msg.label");
      out += `{{ $labels.${ctx.label(t.slice(0, -".name".length))} }}`;
    } else {
      use("alert.msg.unknown-token");
      if (!unknown.includes(p.raw)) unknown.push(p.raw);
      out += literal(p.raw);
    }
  }
  if (channels.length > 0) use("alert.msg.handle");
  // Handles leave blank lines and doubled spaces behind; normalise whitespace deterministically.
  const text = out
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, rules, channels, unknown, dropped, handleScopes };
}

/**
 * Cut text to Dash0's limit (description 2048, summary 255 characters) without splitting a {{ … }} action, so the
 * Go template still parses. Returns the text unchanged when it fits.
 */
export function fitTemplate(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const mark = "…";
  let cut = text.slice(0, max - mark.length);
  const open = cut.lastIndexOf("{{");
  if (open >= 0 && cut.indexOf("}}", open) < 0) cut = cut.slice(0, open);
  return { text: cut.replace(/\s+$/, "") + mark, cut: true };
}
