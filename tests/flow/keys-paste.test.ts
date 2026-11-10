// Adding keys by pasting a .env or dragging the file into the terminal.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { droppedPath, keysFromText } from "../../src/flow/keys.js";
import { blockKeys } from "../../src/flow/tty.js";

const dir = () => mkdtempSync(join(tmpdir(), "dd2dash0-paste-"));
const ENV = "# demo\nexport DATADOG_API_KEY=aaaa1111bbbb2222\nDD_APPLICATION_KEY='app-key-9999'\nDATADOG_SITE=https://app.datadoghq.eu/\nDASH0_TOKEN=auth_xyz # comment\nDASH0_API_URL=https://api.europe-west4.gcp.dash0.com\nNEW_RELIC_API_KEY=ignored\n";

describe("keys from a paste or a dropped file", () => {
  it("reads KEY=value lines, maps other common names, ignores the rest", () => {
    const { keys, file } = keysFromText(ENV, dir());
    expect(file).toBeNull();
    expect(keys).toEqual({ DD_API_KEY: "aaaa1111bbbb2222", DD_APP_KEY: "app-key-9999", DD_SITE: "datadoghq.eu", DASH0_AUTH_TOKEN: "auth_xyz", DASH0_API_URL: "https://api.europe-west4.gcp.dash0.com" });
  });

  it("recognizes a dragged-in path the way terminals type it: escaped spaces, quotes, file://, ~", () => {
    const d = dir();
    const home = dir();
    mkdirSync(join(d, "Downloads"));
    const f = join(d, "Downloads", "env.example copy.txt");
    writeFileSync(f, ENV);
    expect(droppedPath(f.replace(/ /g, "\\ ") + " ", d)).toBe(f); // macOS Terminal
    expect(droppedPath(`'${f}'`, d)).toBe(f); // quoted
    expect(droppedPath(`file://${encodeURI(f)}`, d)).toBe(f);
    writeFileSync(join(home, "keys.env"), ENV);
    expect(droppedPath("~/keys.env", d, home)).toBe(join(home, "keys.env"));
    expect(droppedPath("Downloads/env.example\\ copy.txt", d)).toBe(f); // relative to the current folder
    expect(droppedPath("/no/such/file", d)).toBeNull();
    expect(droppedPath("DD_API_KEY=x", d)).toBeNull();
    expect(keysFromText(f.replace(/ /g, "\\ "), d)).toMatchObject({ file: f, keys: { DD_API_KEY: "aaaa1111bbbb2222" } });
  });
});

describe("blockKeys (hidden multi-line paste)", () => {
  it("finishes right after a bracketed paste ends; no extra Enter", () => {
    const s = { text: "", line: "" };
    expect(blockKeys(s, "\u001b[200~DD_API_KEY=a\nDASH0_TOKEN=b\u001b[201~")).toBe("done");
    expect(s.text).toBe("DD_API_KEY=a\nDASH0_TOKEN=b\n");
  });
  it("a dropped path needs just Enter; typed lines finish on an empty line; leading blanks are ignored", () => {
    const p = { text: "", line: "" };
    expect(blockKeys(p, "/Users/me/env\\ copy.txt \r")).toBe("done");
    const t = { text: "", line: "" };
    expect(blockKeys(t, "\rDD_API_KEY=a\r")).toBeNull();
    expect(blockKeys(t, "DD_APP_KEY=b\r\r")).toBe("done");
    expect(t.text).toBe("DD_API_KEY=a\nDD_APP_KEY=b\n");
    expect(blockKeys({ text: "", line: "x" }, "\u0003")).toBe("interrupt");
  });
});
