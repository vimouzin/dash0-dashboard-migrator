// Raw-mode key handling for the guided flow's terminal prompts.
import { describe, expect, it } from "vitest";
import { applyKeys } from "../../src/flow/tty.js";

describe("applyKeys", () => {
  it("echoes typing, handles backspace, Ctrl+U and Enter, keeps typed-ahead text", () => {
    const s = { buf: "" };
    expect(applyKeys(s, "abx", false)).toEqual({ echo: "abx", done: null, rest: "" });
    expect(applyKeys(s, "\u007fc\rnext", false)).toEqual({ echo: "\b \bc", done: "enter", rest: "next" });
    expect(s.buf).toBe("abc");
    const t = { buf: "zz" };
    expect(applyKeys(t, "\u0015q\r\n", false)).toEqual({ echo: "\b \b\b \bq", done: "enter", rest: "" });
    expect(t.buf).toBe("q");
  });

  it("secrets echo a dot per character, never the text; arrow keys are ignored; Ctrl+D is EOF only on an empty line; Ctrl+C interrupts", () => {
    const s = { buf: "" };
    expect(applyKeys(s, "se\u001b[Dcr\u0004et\u007f\u007f", true)).toEqual({ echo: "••••••\b \b\b \b", done: null, rest: "" });
    expect(s.buf).toBe("secr");
    expect(applyKeys({ buf: "" }, "\u0004", true).done).toBe("eof");
    expect(applyKeys({ buf: "x" }, "\u0003", false).done).toBe("interrupt");
  });
});
