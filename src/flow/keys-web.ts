// Enter the keys in a browser instead of the terminal: a one-time page on 127.0.0.1 at a secret URL. The page sends
// the keys only to this local server, which checks them against Datadog and Dash0 (read-only) and hands them to the
// CLI. The server accepts only its own origin, closes itself after the keys are accepted, and times out. Keys are
// never logged; responses never echo a secret.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkDash0, checkDatadog, DEFAULTS, fingerprint, normalizeDash0Url, SECRET_KEYS, validSite, type KeyName, type Keys } from "./keys.js";

export interface WebKeysOptions {
  need: { datadog: boolean; dash0: boolean };
  /** Keys already found in env / .env (secrets are shown only as a fingerprint). */
  known: Keys;
  /** Folder the CLI runs in, shown in the header. */
  cwd: string;
  /** Where "save" writes the keys, shown next to the checkbox (e.g. ~/.config/dd2dash0/.env). */
  savePath?: string;
  fetch?: typeof fetch;
  /** Give up after this many ms. Default 15 minutes. */
  timeoutMs?: number;
  /** Called with the URL once the server listens (print it, open the browser). */
  onReady: (url: string) => void;
}

export interface WebKeysResult {
  keys: Keys;
  save: boolean;
}

type FieldState = { ok: boolean; message?: string };

const FIELDS: Record<"datadog" | "dash0", KeyName[]> = {
  datadog: ["DD_SITE", "DD_API_KEY", "DD_APP_KEY"],
  dash0: ["DASH0_API_URL", "DASH0_AUTH_TOKEN", "DASH0_DATASET"],
};

/** Check a full set of keys; per-field results (used by the page for inline ✓ / ✗). */
export async function checkAll(k: Keys, need: WebKeysOptions["need"], f: typeof fetch = fetch): Promise<{ ok: boolean; fields: Partial<Record<KeyName, FieldState>>; keys: Keys }> {
  const fields: Partial<Record<KeyName, FieldState>> = {};
  const keys: Keys = { ...k };
  // Flag every empty required field in one pass, so the page shows all of them at once.
  for (const n of [...(need.datadog ? (["DD_API_KEY", "DD_APP_KEY"] as const) : []), ...(need.dash0 ? (["DASH0_API_URL", "DASH0_AUTH_TOKEN"] as const) : [])])
    if (!keys[n]) fields[n] = { ok: false, message: "required" };
  const missing = (n: KeyName) => {
    if (keys[n]) return false;
    fields[n] = { ok: false, message: "required" };
    return true;
  };
  if (need.datadog) {
    keys.DD_SITE = keys.DD_SITE || DEFAULTS.DD_SITE;
    const site = keys.DD_SITE!;
    if (!validSite(site)) fields.DD_SITE = { ok: false, message: "not a Datadog site (e.g. datadoghq.eu, us5.datadoghq.com)" };
    else {
      fields.DD_SITE = { ok: true };
      const m1 = missing("DD_API_KEY");
      const m2 = missing("DD_APP_KEY");
      if (!m1 && !m2) {
        const c = await checkDatadog({ site, apiKey: keys.DD_API_KEY!, appKey: keys.DD_APP_KEY! }, f);
        if (c.ok) fields.DD_API_KEY = fields.DD_APP_KEY = { ok: true };
        else if (/application key/.test(c.message)) {
          fields.DD_API_KEY = { ok: true };
          fields.DD_APP_KEY = { ok: false, message: c.message };
        } else if (/could not reach/.test(c.message)) fields.DD_SITE = { ok: false, message: c.message };
        else fields.DD_API_KEY = { ok: false, message: c.message };
      }
    }
  }
  if (need.dash0) {
    keys.DASH0_DATASET = keys.DASH0_DATASET || DEFAULTS.DASH0_DATASET;
    if (!missing("DASH0_API_URL")) {
      const u = normalizeDash0Url(keys.DASH0_API_URL!);
      if ("error" in u) fields.DASH0_API_URL = { ok: false, message: u.error };
      else {
        keys.DASH0_API_URL = u.url;
        if (!missing("DASH0_AUTH_TOKEN")) {
          const c = await checkDash0({ apiUrl: u.url, token: keys.DASH0_AUTH_TOKEN!, dataset: keys.DASH0_DATASET! }, f);
          if (c.ok) fields.DASH0_API_URL = fields.DASH0_AUTH_TOKEN = fields.DASH0_DATASET = { ok: true };
          else if (/404/.test(c.message)) {
            fields.DASH0_API_URL = { ok: false, message: c.message };
            fields.DASH0_DATASET = { ok: false, message: "check the dataset name" };
          } else if (/could not reach/.test(c.message)) fields.DASH0_API_URL = { ok: false, message: c.message };
          else {
            fields.DASH0_API_URL = { ok: true };
            fields.DASH0_AUTH_TOKEN = { ok: false, message: c.message };
          }
        }
      }
    }
  }
  return { ok: Object.values(fields).every((x) => x!.ok), fields, keys };
}

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* the URL is printed too */
  }
}

/** Run the one-time page until valid keys are submitted. Rejects on timeout. */
export function webKeys(o: WebKeysOptions): Promise<WebKeysResult> {
  const token = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    let origin = "";
    let finished = false;
    const server = createServer((req, res) => {
      void handle(req, res).catch(() => send(res, 500, "text/plain", "error"));
    });
    const timer = setTimeout(() => {
      finish();
      reject(new Error("no keys were entered in the browser within 15 minutes"));
    }, o.timeoutMs ?? 15 * 60_000);
    timer.unref();
    const finish = () => {
      finished = true;
      clearTimeout(timer);
      setTimeout(() => server.close(), 300).unref(); // let the last response flush
      server.closeIdleConnections?.();
    };

    async function handle(req: IncomingMessage, res: ServerResponse) {
      // Only our own address (DNS rebinding) and only the secret path.
      if (req.headers.host !== origin.replace("http://", "")) return send(res, 421, "text/plain", "wrong host");
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === `/${token}`) return send(res, 200, "text/html; charset=utf-8", page(o, nonce), { "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'` });
      if (req.method === "POST" && path === `/${token}/check`) {
        if (finished) return send(res, 410, "application/json", JSON.stringify({ error: "already done" }));
        if (req.headers.origin !== origin || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 403, "application/json", JSON.stringify({ error: "forbidden" }));
        const body = await readBody(req, 16_384);
        let parsed: { keys?: Record<string, unknown>; save?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(res, 400, "application/json", JSON.stringify({ error: "bad json" }));
        }
        const typed: Keys = {};
        for (const group of Object.values(FIELDS))
          for (const n of group) {
            const v = parsed.keys?.[n];
            if (typeof v === "string" && v.trim()) typed[n] = v.trim();
          }
        const merged: Keys = { ...o.known, ...typed };
        const r = await checkAll(merged, o.need, o.fetch ?? fetch);
        send(res, 200, "application/json", JSON.stringify({ ok: r.ok, fields: r.fields }));
        if (r.ok) {
          finish();
          resolve({ keys: r.keys, save: parsed.save === true });
        }
        return;
      }
      send(res, 404, "text/plain", "not found");
    }

    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      o.onReady(`${origin}/${token}`);
    });
  });
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", ...extra });
  res.end(body);
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LABEL: Record<KeyName, [string, string, string]> = {
  // label, hint, placeholder
  DD_SITE: ["site", "", "datadoghq.eu"],
  DD_API_KEY: ["API key", "Organization Settings → API Keys", "32 hex characters"],
  DD_APP_KEY: ["app key", "Organization Settings → Application Keys", "needs dashboards_read, monitors_read"],
  DASH0_API_URL: ["API URL", "Settings → Endpoints → API (not the ingress)", "https://api.eu-west-1.aws.dash0.com"],
  DASH0_AUTH_TOKEN: ["token", "Settings → Auth Tokens", "auth_…"],
  DASH0_DATASET: ["dataset", "", "default"],
};

/** The page: terminal look (monospace, one accent, step tree), keyboard-first, no external assets. */
function page(o: WebKeysOptions, nonce: string): string {
  const row = (n: KeyName) => {
    const [label, hint, ph] = LABEL[n];
    const known = o.known[n];
    const secret = SECRET_KEYS.has(n);
    const value = known && !secret ? known : "";
    const placeholder = known && secret ? `set in .env (${fingerprint(known)}), leave empty to keep` : ph;
    return `<div class="row" data-field="${n}">
      <label for="${n}">${label}</label>
      <div class="field"><input id="${n}" name="${n}" type="${secret ? "password" : "text"}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false"${!known && !DEFAULTS[n] ? " required" : ""}>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ""}<div class="msg" aria-live="polite"></div></div>
      <span class="state" aria-hidden="true"></span>
    </div>`;
  };
  const section = (name: string, keys: KeyName[]) => `<section><h2><span class="dot">●</span> ${name}</h2>${keys.map(row).join("")}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dd2dash0 · connect</title><meta name="robots" content="noindex">
<style nonce="${nonce}">
:root{--bg:#0c0d10;--fg:#d7d9de;--dim:#6c717b;--line:#23262c;--accent:#87afff;--ok:#5fd787;--bad:#ff5f5f;--ease:cubic-bezier(.23,1,.32,1);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fbfbfa;--fg:#1d1f23;--dim:#7a7f88;--line:#e4e4e1;--accent:#3a63d8;--ok:#1f8a4c;--bad:#c93a3a;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:14px/1.6 ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased;padding:9vh 24px 48px}
main{max-width:620px;margin:0 auto}
.frame{border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin-bottom:28px;display:inline-block;min-width:min(100%,420px)}
.frame b{font-weight:600}.mark{color:var(--accent)}.dim{color:var(--dim)}
section{margin:0 0 22px}h2{font-size:14px;font-weight:600;margin:0 0 6px}.dot{color:var(--accent)}
.row{display:grid;grid-template-columns:9ch 1fr 2ch;gap:0 12px;align-items:start;padding:5px 0 5px 2ch;position:relative}
.row::before{content:"⎿";position:absolute;left:0;top:5px;color:var(--dim)}
label{color:var(--dim);padding-top:3px;cursor:pointer}
input{width:100%;font:inherit;color:var(--fg);background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:3px 0 4px;outline:none;transition:border-color 150ms ease}
input::placeholder{color:var(--dim);opacity:.7}
input:focus{border-bottom-color:var(--accent)}
.row.bad input{border-bottom-color:var(--bad)}
.hint{color:var(--dim);font-size:12px;margin-top:2px}
.msg{color:var(--bad);font-size:12px;min-height:0}
.state{padding-top:3px;text-align:right}.row.ok .state::after{content:"✓";color:var(--ok)}.row.bad .state::after{content:"✗";color:var(--bad)}
.save{display:flex;gap:10px;align-items:center;color:var(--dim);margin:6px 0 22px 2ch;cursor:pointer;user-select:none}
.save input{width:auto;accent-color:var(--accent)}
button{font:inherit;color:var(--bg);background:var(--fg);border:0;border-radius:7px;padding:8px 14px;cursor:pointer;transition:transform 140ms var(--ease),opacity 150ms ease}
button:active{transform:scale(.97)}button[disabled]{opacity:.55;cursor:default}
.kbd{color:var(--dim);margin-left:12px}
.foot{color:var(--dim);font-size:12px;margin-top:28px;max-width:52ch}
.drop{outline:none}.dz{border:1px dashed var(--line);border-radius:8px;padding:10px 12px;color:var(--dim);font-size:12.5px;cursor:pointer;transition:border-color 150ms ease,color 150ms ease}
.drop:focus .dz,.drop.over .dz{border-color:var(--accent);color:var(--fg)}.k{color:var(--fg)}.ok-msg{color:var(--ok)}
.done{display:none}.is-done form{display:none}.is-done .done{display:block}
.done p{margin:4px 0}.done .big{font-size:15px}
@media (prefers-reduced-motion:reduce){button{transition:opacity 150ms ease}button:active{transform:none}}
@media (max-width:520px){.row{grid-template-columns:1fr 2ch}label{grid-column:1/-1}}
</style></head><body><main>
<div class="frame"><div><span class="mark">◆</span> <b>dd2dash0</b> <span class="dim">· connect</span></div><div class="dim">${esc(o.cwd)}</div></div>
<form id="f" novalidate>
<section class="drop" id="drop" tabindex="0" aria-label="Drop or paste a .env file"><h2><span class="dot">●</span> Have a .env?</h2>
<div class="row" style="grid-template-columns:1fr"><div class="field"><div class="dz">Drop it here, or click and paste its contents (<span class="k">⌘V</span>). The fields below fill in; nothing leaves this page until you press the button.</div><div class="msg ok-msg" id="dropmsg" aria-live="polite"></div></div></div></section>
${o.need.datadog ? section("Datadog", FIELDS.datadog) : ""}
${o.need.dash0 ? section("Dash0", FIELDS.dash0) : ""}
<label class="save"><input type="checkbox" id="save" checked> save them in ${esc(o.savePath ?? "~/.config/dd2dash0/.env")} (only you can read it; works from any folder)</label>
<div><button id="go" type="submit">Check and continue</button><span class="kbd">⏎</span></div>
<p class="foot">Keys go only to this computer (127.0.0.1). It checks them with one read-only call to Datadog and one to Dash0, then hands them to the terminal. This page works once.</p>
</form>
<div class="done" role="status"><p class="big"><span class="dot">●</span> <b>Connected</b></p><p class="dim">  ⎿ Keys checked. The terminal is continuing; you can close this tab.</p></div>
</main>
<script nonce="${nonce}">
const f=document.getElementById("f"),go=document.getElementById("go"),frames="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";let spin;
f.addEventListener("submit",async(e)=>{e.preventDefault();if(go.disabled)return;
 const keys={};for(const i of f.querySelectorAll(".row input"))keys[i.name]=i.value;
 go.disabled=true;let n=0;spin=setInterval(()=>{go.textContent=frames[n++%10]+" checking";},80);
 try{const r=await fetch(location.pathname+"/check",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({keys,save:document.getElementById("save").checked})});
  const j=await r.json();for(const row of f.querySelectorAll(".row")){const s=j.fields&&j.fields[row.dataset.field];row.classList.toggle("ok",!!(s&&s.ok));row.classList.toggle("bad",!!(s&&!s.ok));row.querySelector(".msg").textContent=s&&!s.ok&&s.message?s.message:"";}
  if(j.ok){document.body.classList.add("is-done");return;}
  if(!r.ok&&!j.fields){f.querySelector(".foot").textContent=j.error==="already done"?"Already connected. Return to the terminal.":"Something went wrong; check the terminal.";}
  const bad=f.querySelector(".row.bad input");if(bad)bad.focus();
 }catch{f.querySelector(".foot").textContent="The terminal stopped listening. Run dd2dash0 again.";}
 finally{clearInterval(spin);go.textContent="Check and continue";go.disabled=false;}});
const drop=document.getElementById("drop"),dmsg=document.getElementById("dropmsg");
function fill(text){const got={};for(const raw of text.split(/\r?\n/)){const m=/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(raw);if(!m)continue;let v=m[2].trim();if(/^(['"]).*\\1$/.test(v))v=v.slice(1,-1);else v=v.replace(/\s+#.*$/,"");got[m[1]]=v;}
 const used=[];for(const i of f.querySelectorAll(".row input")){if(got[i.name]){i.value=got[i.name];used.push(i.name);i.closest(".row").classList.remove("bad","ok");}}
 dmsg.className="msg "+(used.length?"ok-msg":"");dmsg.textContent=used.length?"⎿ filled "+used.join(", "):"⎿ no dd2dash0 keys found in that text";if(used.length)go.focus();}
drop.addEventListener("click",()=>drop.focus());
drop.addEventListener("paste",(e)=>{const t=e.clipboardData&&e.clipboardData.getData("text");if(t){e.preventDefault();fill(t);}});
for(const ev of["dragenter","dragover"])document.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.add("over");});
document.addEventListener("dragleave",(e)=>{if(!e.relatedTarget)drop.classList.remove("over");});
document.addEventListener("drop",async(e)=>{e.preventDefault();drop.classList.remove("over");const file=e.dataTransfer&&e.dataTransfer.files[0];if(file&&file.size<65536)fill(await file.text());});
const first=[...f.querySelectorAll(".row input")].find(i=>!i.value&&i.required);(first||f.querySelector(".row input")).focus();
</script></body></html>`;
}
