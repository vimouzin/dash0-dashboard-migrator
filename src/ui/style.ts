// The terminal look of dd2dash0: one accent color, dim gray for secondary text, a framed header, a step tree
// (● step, ⎿ result), live spinners and clickable links. Plain text when the output is not a TTY or NO_COLOR is set,
// so pipes, logs and tests stay readable. No emoji, no gradients.
import { homedir } from "node:os";

export interface Out {
  write: (s: string) => void;
  isTTY: boolean;
  columns: number;
}

export function outOf(stream: NodeJS.WriteStream = process.stdout): Out {
  return { write: (s) => void stream.write(s), isTTY: stream.isTTY === true, columns: stream.columns || 80 };
}

export function colorEnabled(out: Pick<Out, "isTTY">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return out.isTTY && env.TERM !== "dumb";
}

const sgr = (on: string, off: string) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;
const raw = {
  accent: sgr("38;5;111", "39"), // soft sky blue: dd2dash0's one accent
  ok: sgr("38;5;78", "39"),
  warn: sgr("38;5;179", "39"),
  bad: sgr("38;5;203", "39"),
  dim: sgr("2", "22"),
  bold: sgr("1", "22"),
};
const id = (s: string) => s;

export type Paint = Record<keyof typeof raw, (s: string) => string> & { on: boolean };
export function paint(on: boolean): Paint {
  return on ? { ...raw, on } : { accent: id, ok: id, warn: id, bad: id, dim: id, bold: id, on };
}

/** Visible width: ANSI codes and OSC 8 links removed; wide characters count 1 (our glyphs are all narrow). */
export function width(s: string): number {
  return [...s.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")].length;
}
export const padEnd = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));
export function truncate(s: string, n: number): string {
  if (width(s) <= n) return s;
  // Drop colors and link wrappers (keeping the link text) so a cut never lands inside an escape sequence.
  const plain = s.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return [...plain].slice(0, Math.max(0, n - 1)).join("") + "…";
}

/** A clickable link (OSC 8) on a TTY that likely supports it; otherwise "text (url)" or just the url. */
export function link(p: Paint, text: string, url: string, env: NodeJS.ProcessEnv = process.env): string {
  const supports = p.on && env.TERM_PROGRAM !== "Apple_Terminal" ? true : false;
  if (supports) return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
  return text === url ? url : `${text} ${p.dim(url)}`;
}

export const tildify = (path: string) => (path.startsWith(homedir()) ? "~" + path.slice(homedir().length) : path);

/** A rounded frame around lines; width fits the longest line, capped by the terminal. */
export function box(p: Paint, lines: string[], o: { title?: string; max?: number } = {}): string[] {
  const max = Math.max(20, (o.max ?? 80) - 4);
  const body = lines.map((l) => truncate(l, max));
  const inner = Math.min(max, Math.max(...body.map(width), o.title ? width(o.title) + 2 : 0));
  const top = o.title ? `╭─ ${o.title} ${"─".repeat(Math.max(0, inner - width(o.title) - 1))}╮` : `╭${"─".repeat(inner + 2)}╮`;
  return [p.dim(top), ...body.map((l) => `${p.dim("│")} ${padEnd(l, inner)} ${p.dim("│")}`), p.dim(`╰${"─".repeat(inner + 2)}╯`)];
}

/** A horizontal bar of `cells` cells for a 0..1 fraction (rounded down, never up). */
export function bar(p: Paint, fraction: number, cells = 18): string {
  const f = Math.max(0, Math.min(1, fraction));
  const full = Math.floor(f * cells);
  return p.accent("█".repeat(full)) + p.dim("░".repeat(cells - full));
}

export function seconds(ms: number): string {
  return ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Step {
  /** Replace the spinner with "● title  summary  time" and print detail lines under it with ⎿. */
  done: (summary?: string, details?: string[]) => void;
  /** Same, with a red ● for a failed step. */
  fail: (summary?: string, details?: string[]) => void;
  /** Change the text next to the spinner (e.g. a count). */
  update: (text: string) => void;
}

/** Terminal UI: header, steps with spinners, detail lines. */
export class Ui {
  readonly p: Paint;
  private active: { stop: () => void } | null = null;
  constructor(
    readonly out: Out,
    env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {
    this.p = paint(colorEnabled(out, env));
  }

  line(s = ""): void {
    this.out.write(s + "\n");
  }

  header(version: string, cwd: string): void {
    const p = this.p;
    for (const l of box(p, [`${p.accent("◆")} ${p.bold("dd2dash0")} ${p.dim(version)}`, `  Datadog → Dash0 ${p.dim("· deterministic, no AI")}`, `  ${p.dim(tildify(cwd))}`], { max: Math.min(this.out.columns, 64) }))
      this.line(l);
    this.line();
  }

  /** "● title" now; with a spinner and elapsed time on a TTY until done()/fail(). */
  step(title: string, running?: string): Step {
    const p = this.p;
    const start = this.now();
    const live = this.out.isTTY && p.on;
    let text = running ?? `${title}…`;
    let timer: ReturnType<typeof setInterval> | null = null;
    const clear = () => this.out.write("\r\x1b[2K");
    if (live) {
      let i = 0;
      const draw = () => {
        clear();
        this.out.write(`${p.accent(FRAMES[i++ % FRAMES.length]!)} ${text}  ${p.dim(seconds(this.now() - start))}`);
      };
      this.out.write("\x1b[?25l");
      draw();
      timer = setInterval(draw, 80);
      timer.unref?.();
    }
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (live) {
        clear();
        this.out.write("\x1b[?25h");
      }
      this.active = null;
    };
    this.active = { stop };
    const finish = (dot: string, summary?: string, details: string[] = []) => {
      stop();
      const t = p.dim(seconds(this.now() - start));
      this.line(`${dot} ${p.bold(title)}${summary ? `  ${summary}` : ""}  ${t}`);
      for (const d of details) this.detail(d);
    };
    return {
      done: (s, d) => finish(p.accent("●"), s, d),
      fail: (s, d) => finish(p.bad("●"), s, d),
      update: (t) => void (text = t),
    };
  }

  /** "● title" with no spinner (for steps that ask questions). */
  heading(title: string, summary?: string): void {
    this.stopActive();
    this.line(`${this.p.accent("●")} ${this.p.bold(title)}${summary ? `  ${summary}` : ""}`);
  }

  detail(s: string): void {
    this.line(`  ${this.p.dim("⎿")} ${s}`);
  }

  stopActive(): void {
    this.active?.stop();
  }
}
