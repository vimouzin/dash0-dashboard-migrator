// Terminal I/O for the guided flow.
// - On a TTY: a small raw-mode line reader. We print the question ourselves and echo keystrokes ourselves, so nothing
//   (like readline's default "> " prompt redraw) can paint over the question. Secrets echo nothing at all.
// - Piped stdin: plain line reading; answers are echoed (never secrets) so a transcript reads right.
import { createInterface } from "node:readline";
import { colorEnabled, paint } from "../ui/style.js";
import type { KeyIO } from "./keys.js";

/**
 * choose(): pick one option. TTY: an arrow-key list (↑/↓ or j/k, a number key, Enter); piped: a numbered prompt.
 * Resolves the chosen index, or null at end of input.
 */
export type Choose = (question: string, options: string[], defaultIndex?: number) => Promise<number | null>;
/** askBlock(): read a multi-line paste (a .env) without showing it; ends on an empty line or Ctrl+D. */
export type AskBlock = (prompt: string) => Promise<string | null>;
export type TerminalIO = KeyIO & { close: () => void; choose: Choose; askBlock: AskBlock };

/** Apply raw keystrokes to a hidden multi-line paste. "done" when Enter arrives on an empty line. Exported for tests. */
export function blockKeys(state: { text: string; line: string }, chunk: string): "done" | "interrupt" | null {
  for (let i = 0; i < chunk.length; i++) {
    // Bracketed paste (the terminal marks where a paste ends): finish right after it, no extra Enter needed.
    if (chunk.startsWith("\u001b[201~", i)) {
      if (state.line.trim()) state.text += state.line + "\n";
      state.line = "";
      if (state.text.trim()) return "done";
      i += 5;
      continue;
    }
    const ch = chunk[i]!;
    if (ch === "\u0003") return "interrupt";
    if (ch === "\u0004") {
      if (state.line) state.text += state.line + "\n";
      state.line = "";
      return "done";
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && chunk[i + 1] === "\n") i++;
      if (!state.line.trim()) {
        if (state.text) return "done"; // an empty line after content ends the paste
        state.line = ""; // leading blank lines are skipped; keep reading the rest of this chunk
        continue;
      }
      const first = !state.text;
      state.text += state.line + "\n";
      // A dragged-in file arrives as one typed path: Enter after it is enough.
      if (first && /^\s*(['"]?)(\/|~|[A-Za-z]:\\|file:\/\/)/.test(state.line) && !state.line.includes("=")) {
        state.line = "";
        return "done";
      }
      state.line = "";
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      state.line = state.line.slice(0, -1);
      continue;
    }
    if (ch === "\u001b") {
      const m = /^\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(chunk.slice(i));
      i += (m?.[0].length ?? 1) - 1;
      continue;
    }
    if (ch >= " " || ch === "\t") state.line += ch;
  }
  return null;
}

/** Apply one chunk of raw keystrokes to a list selection. Exported for tests. */
export function chooseKeys(state: { i: number }, chunk: string, n: number): "enter" | "interrupt" | "eof" | null {
  for (let k = 0; k < chunk.length; k++) {
    const rest = chunk.slice(k);
    if (rest.startsWith("\u001b[A") || rest.startsWith("\u001bOA")) {
      state.i = (state.i - 1 + n) % n;
      k += 2;
    } else if (rest.startsWith("\u001b[B") || rest.startsWith("\u001bOB")) {
      state.i = (state.i + 1) % n;
      k += 2;
    } else {
      const ch = chunk[k]!;
      if (ch === "\r" || ch === "\n") return "enter";
      if (ch === "\u0003") return "interrupt";
      if (ch === "\u0004") return "eof";
      if (ch === "k") state.i = (state.i - 1 + n) % n;
      else if (ch === "j") state.i = (state.i + 1) % n;
      else if (/[1-9]/.test(ch) && Number(ch) <= n) {
        state.i = Number(ch) - 1;
        return "enter";
      } else if (ch === "\u001b") {
        const m = /^\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(rest);
        k += (m?.[0].length ?? 1) - 1;
      }
    }
  }
  return null;
}

export function terminalIO(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): TerminalIO {
  return input.isTTY === true && typeof input.setRawMode === "function" ? ttyIO(input, output) : pipedIO(input, output);
}

/** Apply one chunk of raw keystrokes to the current answer. Exported for tests. */
export function applyKeys(
  state: { buf: string },
  chunk: string,
  secret: boolean,
): { echo: string; done: "enter" | "eof" | "interrupt" | null; rest: string } {
  let echo = "";
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    if (ch === "\r" || ch === "\n") {
      // A pasted "\r\n" counts as one Enter.
      const next = chunk[i + 1] === "\n" && ch === "\r" ? i + 2 : i + 1;
      return { echo, done: "enter", rest: chunk.slice(next) };
    }
    if (ch === "\u0003") return { echo, done: "interrupt", rest: "" };
    if (ch === "\u0004") {
      if (!state.buf) return { echo, done: "eof", rest: "" };
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      if (state.buf) {
        state.buf = [...state.buf].slice(0, -1).join("");
        echo += "\b \b";
      }
      continue;
    }
    if (ch === "\u0015") {
      // Ctrl+U: clear the line.
      echo += "\b \b".repeat([...state.buf].length);
      state.buf = "";
      continue;
    }
    if (ch === "\u001b") {
      // Escape sequence (arrows, bracketed-paste markers): skip it.
      const m = /^\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(chunk.slice(i));
      i += (m?.[0].length ?? 1) - 1;
      continue;
    }
    if (ch < " ") continue; // other control characters
    state.buf += ch;
    echo += secret ? "•" : ch; // a dot per character: you see the paste arrived, never the secret
  }
  return { echo, done: null, rest: "" };
}

function ttyIO(input: NodeJS.ReadStream, output: NodeJS.WriteStream): TerminalIO {
  let pending = ""; // typed ahead of the next question
  const ask = (prompt: string, secret: boolean) =>
    new Promise<string | null>((resolve) => {
      output.write(prompt);
      const state = { buf: "" };
      const finish = (v: string | null) => {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        output.write("\n");
        resolve(v);
      };
      const onData = (data: Buffer | string) => {
        const r = applyKeys(state, typeof data === "string" ? data : data.toString("utf8"), secret);
        if (r.echo) output.write(r.echo);
        if (r.done === "enter") {
          pending = r.rest;
          finish(state.buf);
        } else if (r.done === "eof") finish(null);
        else if (r.done === "interrupt") {
          input.setRawMode(false);
          output.write("\n");
          process.exit(130);
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
      if (pending) {
        const p = pending;
        pending = "";
        onData(p);
      }
    });
  const p = paint(colorEnabled({ isTTY: true }));
  const choose: Choose = (question, options, defaultIndex = 0) =>
    new Promise((resolve) => {
      const state = { i: Math.min(Math.max(0, defaultIndex), options.length - 1) };
      const render = (first: boolean) => {
        if (!first) output.write(`\x1b[${options.length}A`);
        options.forEach((o, n) => output.write(`\r\x1b[2K${n === state.i ? `  ${p.accent("❯")} ${o}` : `    ${p.dim(o)}`}\n`));
      };
      output.write(`  ${question}\n\x1b[?25l`);
      render(true);
      const finish = (v: number | null) => {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        // Collapse the list to one line: "  question  › choice".
        output.write(`\x1b[${options.length + 1}A\r\x1b[0J`);
        output.write(`  ${question}  ${p.dim("›")} ${v === null ? p.dim("(no answer)") : options[v]}\n\x1b[?25h`);
        resolve(v);
      };
      const onData = (data: Buffer | string) => {
        const r = chooseKeys(state, typeof data === "string" ? data : data.toString("utf8"), options.length);
        if (r === "enter") finish(state.i);
        else if (r === "eof") finish(null);
        else if (r === "interrupt") {
          input.setRawMode(false);
          output.write("\x1b[?25h\n");
          process.exit(130);
        } else render(false);
      };
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
    });
  const askBlock: AskBlock = (prompt) =>
    new Promise((resolve) => {
      const state = { text: "", line: "" };
      output.write(`${prompt}\n\x1b[?2004h`); // bracketed paste on: we see where the paste ends
      const count = () => state.text.split("\n").filter((l) => l.trim()).length + (state.line.trim() ? 1 : 0);
      const status = () => output.write(`\r\x1b[2K  ${p.dim("⎿")} ${count() ? p.dim(`${count()} line(s) received, not shown`) : p.dim("waiting for a paste or a dropped file · Enter on an empty line to finish")}`);
      status();
      const onData = (data: Buffer | string) => {
        const r = blockKeys(state, typeof data === "string" ? data : data.toString("utf8"));
        if (r === "interrupt") {
          input.setRawMode(false);
          output.write("\x1b[?2004l\n");
          process.exit(130);
        }
        status();
        if (r === "done") {
          input.off("data", onData);
          input.setRawMode(false);
          input.pause();
          output.write("\x1b[?2004l\n");
          resolve(state.text);
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
    });
  return {
    ask: (p) => ask(p, false),
    askSecret: (p) => ask(p, true),
    print: (l) => output.write(l + "\n"),
    choose,
    askBlock,
    close: () => {
      if (input.isRaw) input.setRawMode(false);
      input.pause();
    },
  };
}

function pipedIO(input: NodeJS.ReadStream, output: NodeJS.WriteStream): TerminalIO {
  const rl = createInterface({ input, terminal: false });
  const lines: string[] = [];
  let waiting: ((l: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
  rl.on("close", () => {
    closed = true;
    if (waiting) waiting(null);
  });
  const ask = (prompt: string, secret: boolean) =>
    new Promise<string | null>((res) => {
      output.write(prompt);
      const done = (l: string | null) => {
        output.write(l === null || secret ? "\n" : `${l}\n`);
        res(l);
      };
      if (lines.length) done(lines.shift()!);
      else if (closed) done(null);
      else waiting = done;
    });
  const choose: Choose = async (question, options, defaultIndex = 0) => {
    output.write(`  ${question}\n`);
    options.forEach((o, n) => output.write(`    ${n + 1}. ${o}\n`));
    for (;;) {
      const a = await ask(`  choose 1-${options.length} [${defaultIndex + 1}]: `, false);
      if (a === null) return null;
      const t = a.trim().toLowerCase();
      if (t === "") return defaultIndex;
      const n = Number(t);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      // y / n shortcuts for yes/no style lists (first option = yes).
      if (t === "y" || t === "yes") return 0;
      if ((t === "n" || t === "no") && options.length >= 2) return 1;
      const byWord = options.findIndex((o) => o.toLowerCase().startsWith(t));
      if (byWord >= 0) return byWord;
    }
  };
  const askBlock: AskBlock = async (prompt) => {
    output.write(`${prompt}\n`);
    const got: string[] = [];
    for (;;) {
      const l = await new Promise<string | null>((res) => (lines.length ? res(lines.shift()!) : closed ? res(null) : (waiting = res)));
      if (l === null || (!l.trim() && got.length)) break;
      if (l.trim()) got.push(l);
    }
    output.write(`  ⎿ ${got.length} line(s) received\n`);
    return got.length ? got.join("\n") + "\n" : null;
  };
  return { ask: (p) => ask(p, false), askSecret: (p) => ask(p, true), print: (l) => output.write(l + "\n"), choose, askBlock, close: () => rl.close() };
}
