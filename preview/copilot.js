// Voice copilot ("Migration Copilot", an ElevenLabs agent). It explains the finished report and
// navigates this page; it never converts, changes outcomes or touches compiler artifacts.
// The API key stays in the backend: POST /api/copilot/session returns a short-lived signed URL.
// Only an explicit click starts a session; that sends the migration summary to ElevenLabs.
(() => {
  "use strict";

  if (window.MigrateBackend.mode !== "api") return;    // needs the local backend for the signed URL

  const SDK = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.30.0/+esm";
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const LABEL = { converted: "Translated", review: "With remarks", unsupported: "Blocked" };
  const app = window.MigrateApp;

  /* ======================================================================
     Report data. Everything below reads the compiler's own output: the
     report, the manifest and the returned artifacts (source + target files).
     ====================================================================== */
  const result = () => window.MigrateBackend.result;
  const items = () => app.items();
  const real = () => Boolean(result()?.report);
  const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const artifact = (path) => json(result()?.artifacts?.[path]);

  // "widgets[2].definition.widgets[1]" → walk the parsed source JSON.
  function at(obj, path) {
    for (const [, key, idx] of (path || "").matchAll(/([A-Za-z_]\w*)|\[(\d+)\]/g)) {
      if (obj == null) return null;
      obj = obj[key ?? Number(idx)];
    }
    return obj;
  }
  function collect(node, keys, out = []) {
    if (Array.isArray(node)) node.forEach((n) => collect(n, keys, out));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (keys.includes(k) && typeof v === "string") out.push(v);
        else if (k !== "widgets") collect(v, keys, out);   // nested group widgets are their own items
      }
    }
    return out;
  }

  function dashboards() {
    const list = items();
    if (!real()) {
      const panels = list.filter((it) => !/alert/i.test(it.name));
      return panels.length ? [{ id: "d1", title: "Demo dashboard", outcome: null, sourceId: null, items: panels }] : [];
    }
    return result().report.items.filter((i) => i.kind === "dashboard").map((d, n) => ({
      id: `d${n + 1}`, title: d.title || d.sourceId, outcome: d.outcome, sourceId: d.sourceId,
      items: list.filter((it) => it.source?.id === d.sourceId),
    }));
  }
  const alerts = () => items().filter((it) => (real() ? it.source?.kind === "monitor" : /alert/i.test(it.name)));
  const counts = (list) => ({
    total: list.length,
    translated: list.filter((it) => it.status === "converted").length,
    withRemarks: list.filter((it) => it.status === "review").length,
    blocked: list.filter((it) => it.status === "unsupported").length,
  });
  const dashOf = (it) => (real() ? (it.parent === "Monitor" ? "Monitors" : it.parent) : "Demo dashboard");
  const reasonCode = (it) => it.diagnostics?.find((d) => d.severity === "error")?.code || null;

  function summary() {
    const list = items();
    if (!list.length || !app.ready()) return { status: "no_migration_yet", hint: "No conversion has finished yet. Choose files and click Convert." };
    const cap = (arr, n = 40) => (arr.length > n ? [...arr.slice(0, n), { more: arr.length - n }] : arr);
    return {
      status: "converted",
      source: "Datadog", target: "Dash0 (Perses dashboards, check rules)",
      published: false,
      note: real() ? "Converted offline. Nothing has been sent to Dash0." : "Simulated demo data.",
      totals: counts(list),
      dashboards: dashboards().map((d) => ({ id: d.id, title: d.title, outcome: d.outcome, widgets: counts(d.items) })),
      alerts: { ...counts(alerts()), items: cap(alerts().map((it) => ({ issueId: it.id, name: it.name, status: LABEL[it.status] }))) },
      unsupported: cap(list.filter((it) => it.status === "unsupported").map((it) => ({
        issueId: it.id, name: it.name, dashboard: dashOf(it), code: reasonCode(it), reason: it.why,
      }))),
      manualTodos: cap(list.filter((it) => it.status !== "converted").map((it) => ({
        issueId: it.id, name: it.name, dashboard: dashOf(it), status: LABEL[it.status], todo: it.action || it.why,
      }))),
    };
  }

  // Source query text (Datadog) and target query text (PromQL) for one item.
  function queries(it) {
    if (!real()) return { original: it.from || null, translation: it.status === "unsupported" ? null : it.to || null };
    const src = artifact(`source/${it.source.id}`);
    const node = it.source.kind === "monitor" ? src : at(src, it.source.path);
    const original = node ? collect(it.source.kind === "monitor" ? { query: node.query } : node.definition || node, ["query", "q", "formula"]) : [];
    const entries = result().manifest?.entries || [];
    let translation = [];
    if (it.status !== "unsupported") {
      if (it.source.kind === "monitor") {
        const e = entries.find((x) => x.sourceId === it.source.id && x.kind === "check-rule");
        const rule = e && artifact(e.path);
        if (rule?.expression) translation = [rule.expression];
      } else {
        const e = entries.find((x) => x.sourceId === it.source.id && x.kind === "dashboard");
        const key = "widget-" + [...it.source.path.matchAll(/widgets\[(\d+)\]/g)].map((m) => m[1]).join("-");
        const panel = e && artifact(e.path)?.spec?.panels?.[key];
        translation = (panel?.spec?.queries || []).map((q) => q?.spec?.plugin?.spec?.query).filter(Boolean);
      }
    }
    return {
      original: original.length ? original.join("\n") : it.from || null,
      translation: translation.length ? translation.join("\n") : null,
    };
  }

  // Ids from the summary, or a spoken name: the agent may pass either.
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  function findIssue(id) {
    const q = norm(id);
    return items().find((it) => norm(it.id) === q) || items().find((it) => norm(it.name) === q)
      || items().find((it) => q && norm(it.name).includes(q));
  }
  function findDashboard(id) {
    const q = norm(id), all = dashboards();
    return all.find((d) => norm(d.id) === q || norm(d.sourceId) === q) || all.find((d) => norm(d.title) === q)
      || all.find((d) => q && norm(d.title).includes(q));
  }

  /* ======================================================================
     Client tools. Names and parameters match the ElevenLabs agent's tools.
     ====================================================================== */
  const tools = {
    get_migration_summary: async () => JSON.stringify(summary()),

    get_issue_details: async ({ issue_id } = {}) => {
      const it = findIssue(issue_id);
      if (!it) return JSON.stringify({ error: `No issue "${issue_id}". Use an issueId from get_migration_summary.` });
      const q = queries(it);
      return JSON.stringify({
        issueId: it.id, name: it.name, dashboard: dashOf(it), kind: it.source?.kind || null,
        status: LABEL[it.status], outcome: it.outcome || null,
        originalQuery: q.original,
        translation: q.translation ?? (it.status === "unsupported" ? "None: blocked, no automatic translation." : null),
        reason: it.why,
        suggestion: it.action || it.suggestion?.code || null,   // the compiler's suggested action; never model-made
      });
    },

    open_dashboard: async ({ dashboard_id } = {}) => {
      const d = findDashboard(dashboard_id);
      if (!d) return JSON.stringify({ error: `No dashboard "${dashboard_id}". Use a dashboard id from get_migration_summary.` });
      await app.showResults();
      openSheet(d);
      return JSON.stringify({ opened: d.title, view: "before/after", panels: d.items.length });
    },

    highlight_issue: async ({ issue_id } = {}) => {
      const it = findIssue(issue_id);
      if (!it) return JSON.stringify({ error: `No issue "${issue_id}".` });
      closeSheet();
      await app.showResults();
      const li = app.reveal(it);
      if (!li) return JSON.stringify({ error: "The results are not on screen yet." });
      li.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      li.classList.remove("cp-hl");
      void li.offsetWidth;
      li.classList.add("cp-hl");
      setTimeout(() => li.classList.remove("cp-hl"), 3200);
      return JSON.stringify({ highlighted: it.name, status: LABEL[it.status] });
    },
  };

  /* ======================================================================
     Before/after sheet for one dashboard: Datadog query → Dash0 query per panel.
     ====================================================================== */
  const sheet = document.createElement("aside");
  sheet.className = "cp-sheet";
  sheet.setAttribute("aria-label", "Dashboard before and after");
  sheet.hidden = true;
  document.body.appendChild(sheet);

  function openSheet(d) {
    sheet.innerHTML = `
      <div class="cp-sheet-head">
        <div><p class="mono faint">Before / after${d.outcome ? ` · ${esc(d.outcome)}` : ""}</p><h3>${esc(d.title)}</h3></div>
        <button class="cp-x" type="button" aria-label="Close">×</button>
      </div>
      <div class="cp-cols mono faint" aria-hidden="true"><span>Datadog</span><span>Dash0</span></div>
      <ol class="cp-rows">${d.items.map((it) => {
        const q = queries(it);
        return `<li class="s-${it.status}">
          <p class="cp-name"><i aria-hidden="true"></i>${esc(it.name)}<span class="mono">${LABEL[it.status]}</span></p>
          <div class="cp-pair"><code>${esc(q.original || "Not available")}</code><code>${esc(q.translation || (it.status === "unsupported" ? "Blocked: not translated" : "Not available"))}</code></div>
        </li>`;
      }).join("")}</ol>`;
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add("is-open"));
    $(".cp-x", sheet).focus({ preventScroll: true });
  }
  function closeSheet() {
    sheet.classList.remove("is-open");
    sheet.hidden = true;
  }
  sheet.addEventListener("click", (e) => { if (e.target.closest(".cp-x")) closeSheet(); });

  /* ======================================================================
     Jarvis: a living dot, bottom right. Click it to talk (real ElevenLabs
     session); the guided demo (demo.js) drives the same dot.
     States: passive · idle · working · connecting · listening · speaking.
     ====================================================================== */
  const root = document.createElement("div");
  root.className = "jv";
  root.dataset.state = "passive";
  root.innerHTML = `
    <p class="visually-hidden jv-live" aria-live="polite"></p>
    <p class="jv-hint mono" aria-hidden="true">Talk to Jarvis</p>
    <button class="jv-dot" type="button" aria-label="Talk to Jarvis" title="Talk to Jarvis. Starting a conversation sends the migration summary to ElevenLabs.">
      <span class="jv-halo"></span><span class="jv-ring"></span><span class="jv-ring r2"></span>
      <svg class="jv-arc" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="25" pathLength="100"/></svg>
      <span class="jv-core"></span>
    </button>`;
  document.body.appendChild(root);
  const dot = $(".jv-dot", root), liveEl = $(".jv-live", root);
  const TITLE = dot.title;

  let conv = null, attempt = 0, flashTimer = 0;
  function setState(s) {
    root.dataset.state = s;
    dot.setAttribute("aria-pressed", String(Boolean(conv) || s === "connecting"));
    dot.setAttribute("aria-label", conv || s === "connecting" ? "End the conversation with Jarvis" : "Talk to Jarvis");
  }

  // No visible bubble: the dot is the whole interface. Spoken lines go to screen readers only.
  function say(text) { liveEl.textContent = text || ""; }
  // Errors: the dot flashes red, and the message sits in its tooltip and the live region.
  function fail(text) {
    say(text);
    dot.title = text;
    root.classList.add("is-error");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { root.classList.remove("is-error"); dot.title = TITLE; }, 6000);
  }

  // Real audio level drives the dot while a conversation runs; the demo uses a CSS animation.
  let raf = 0;
  function meter() {
    cancelAnimationFrame(raf);
    const loop = async () => {
      if (!conv) { root.style.removeProperty("--lvl"); return; }
      const speaking = root.dataset.state === "speaking";
      const v = await (speaking ? conv.getOutputVolume() : conv.getInputVolume()).catch(() => 0);
      root.style.setProperty("--lvl", Math.min(1, v * 1.6).toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  // firstMessage: what the agent opens with (the agent's first message is "{{first_message}}").
  // context: a note for the agent about where the user is (it informs, never prompts a reply).
  // setNext() presets both for the next start without arguments, e.g. a click on the dot.
  const FIRST = "Any questions about your migration? Just ask.";
  let next = null;
  async function start(opts) {
    const { firstMessage = FIRST, context = "" } = opts || next || {};
    next = null;
    const mine = ++attempt;
    say("");
    setState("connecting");
    try {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());      // permission only; the SDK opens its own input
      } catch {
        throw new Error("I need microphone access to hear you.");
      }
      const [sdk, session] = await Promise.all([
        import(SDK).catch(() => { throw new Error("Could not load the ElevenLabs SDK. Check the network."); }),
        fetch("/api/copilot/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
          .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Jarvis is unavailable (HTTP ${r.status}).`); return d; }),
      ]);
      if (mine !== attempt) return;                       // ended while connecting
      const c = await sdk.Conversation.startSession({
        signedUrl: session.signedUrl,
        connectionType: "websocket",
        dynamicVariables: { migration_summary: JSON.stringify(summary()), first_message: firstMessage },
        clientTools: tools,
        onModeChange: (m) => { if (conv) setState(pick(m, "mode") === "speaking" ? "speaking" : "listening"); },
        onStatusChange: (s) => { if (pick(s, "status") === "disconnected") stopped(); },
        onDisconnect: () => stopped(),
        onError: (m) => fail(typeof m === "string" ? m : "The connection had an error."),
      });
      if (mine !== attempt) { c.endSession(); return; }
      conv = c;
      setState("listening");
      meter();
      if (context) { try { c.sendContextualUpdate(context); } catch { /* older SDK: the summary still applies */ } }
    } catch (err) {
      if (mine !== attempt) return;
      setState("passive");
      fail(String(err.message || err));
    }
  }
  const pick = (v, key) => (v && typeof v === "object" ? v[key] : v);
  function stopped() {
    conv = null;
    setState("passive");
  }
  async function end() {
    attempt++;
    const c = conv;
    stopped();
    if (c) await c.endSession().catch(() => {});
  }
  const live = () => Boolean(conv) || root.dataset.state === "connecting";

  // Run fn once the agent has been quiet for a moment (it may still be finishing a sentence
  // when it calls a tool); at most maxMs later.
  function afterSpeaking(fn, maxMs = 8000) {
    const t0 = performance.now();
    let quietSince = 0;
    const tick = () => {
      const now = performance.now();
      if (root.dataset.state === "speaking") quietSince = 0;
      else quietSince = quietSince || now;
      if ((quietSince && now - quietSince > 1000) || now - t0 > maxMs) fn();
      else setTimeout(tick, 100);
    };
    setTimeout(tick, 300);
  }

  let locked = false;                                        // during the tour the dot does nothing
  dot.addEventListener("click", () => { if (!locked) live() ? end() : start(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || locked) return;
    if (!sheet.hidden) closeSheet();
    else if (live()) end();
  });
  window.addEventListener("pagehide", () => conv?.endSession());

  // Hooks for the guided demo (demo.js) and the console.
  window.Jarvis = {
    tools, summary, say, closeSheet, live, end, fail, start, afterSpeaking,
    setNext: (opts) => { next = opts; },
    lock: (on) => { locked = on; },
    state: (s) => { if (!conv) setState(s); },
    level: (v) => (v == null ? root.style.removeProperty("--lvl") : root.style.setProperty("--lvl", v.toFixed(3))),
    touch(el, ms = 900) {                                  // a soft focus ring where Jarvis "clicks"
      if (!el) return;
      el.classList.remove("jv-touch");
      void el.offsetWidth;
      el.classList.add("jv-touch");
      setTimeout(() => el.classList.remove("jv-touch"), ms);
    },
  };
  window.MigrateCopilot = { tools, summary };
})();
