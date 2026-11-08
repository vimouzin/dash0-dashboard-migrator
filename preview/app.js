// Local conversion UI. Simulated steps, values and publishing are confined to explicit ?mock=1.
// Real runs animate the request and then reveal the finished report; nothing is invented.
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const still = () => reduceMotion.matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, still() ? 0 : ms));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

  const screens = { start: $("#start"), run: $("#run"), unsupported: $("#unsupported"), done: $("#done") };
  const board = $("#board");
  const progress = $("#progress");
  const title = $("#results-title");
  let items = [];
  let runId = 0;
  const real = window.MigrateBackend.mode !== "mock";
  const OUTCOME = { translated: "Translated", approximated: "Approximated", assumed: "Assumed", best_effort: "Best effort", partial: "Partial", blocked: "Blocked" };
  let downloadUrl;
  let aiBusy = false;
  const salesMessage = "You have used your 3 AI calls. Contact our sales team at sandy@dash0.com.";
  $("#data-mode").textContent = window.MigrateBackend.mode === "api" ? "Local converter · Real results" : real ? "Saved report" : "Mock demo · Simulated";
  $("#upload").hidden = window.MigrateBackend.mode !== "api";
  if (real) {
    $("#consult-btn").disabled = true;
    $("#consult-btn .txt").textContent = "Booking unavailable";
    $("#opt-ai").hidden = true;
  }

  /* ---------- Theme ---------- */
  const themeBtn = $("#theme-btn");
  function syncThemeBtn() {
    const dark = document.documentElement.dataset.theme !== "light";
    $(".theme-txt", themeBtn).textContent = dark ? "Light" : "Dark";
    themeBtn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  }
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("migrate-theme", next); } catch (e) { /* storage unavailable: still switches */ }
    syncThemeBtn();
  });
  syncThemeBtn();

  /* ---------- Screens ---------- */
  async function show(name) {
    const current = Object.values(screens).find((s) => s.classList.contains("is-active"));
    if (current && current !== screens[name]) {
      current.classList.add("is-leaving");
      await wait(320);
      current.classList.remove("is-active", "is-leaving");
    }
    screens[name].classList.add("is-active");
    document.body.classList.toggle("is-running", name === "run");
  }

  $("#start-btn").addEventListener("pointerdown", (e) => {
    const btn = e.currentTarget, r = btn.getBoundingClientRect();
    const dot = document.createElement("span");
    dot.className = "ripple";
    dot.style.left = `${e.clientX - r.left}px`;
    dot.style.top = `${e.clientY - r.top}px`;
    btn.appendChild(dot);
    dot.addEventListener("animationend", () => dot.remove());
  });

  /* ---------- Files: drop zone and samples ---------- */
  const fileInput = $("#source-files"), drop = $("#drop");
  function setFiles(list) {
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));
    fileInput.files = dt.files;
    syncFiles();
  }
  function syncFiles(sample) {
    const files = Array.from(fileInput.files);
    $(".drop-empty", drop).hidden = files.length > 0;
    $("#drop-picked").hidden = files.length === 0;
    drop.classList.toggle("has-files", files.length > 0);
    $("#drop-count").textContent = `${files.length} file${files.length === 1 ? "" : "s"} ready to convert`;
    $("#drop-files").innerHTML = files.map((f) => `<li>${esc(f.name)}</li>`).join("");
    $$(".sample").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sample === sample)));
    $("#start-error").textContent = "";
  }
  fileInput.addEventListener("change", () => syncFiles());
  $("#clear-files").addEventListener("click", () => { setFiles([]); fileInput.focus(); });
  // Drag and drop puts the dropped .json files into the same input the picker uses.
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { if (t === "dragleave" && drop.contains(e.relatedTarget)) return; drop.classList.remove("is-over"); }));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith(".json"));
    if (files.length) setFiles(files);
    else $("#start-error").textContent = "Drop Datadog .json files.";
  });
  // Samples are ordinary files served from preview/samples; they go through the same upload.
  $$(".sample").forEach((b) => b.addEventListener("click", async () => {
    const names = b.dataset.sample.split(" ").filter(Boolean);
    try {
      const files = await Promise.all(names.map(async (name) => {
        const res = await fetch(`samples/${name}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Could not load sample ${name} (HTTP ${res.status}).`);
        return new File([await res.text()], name, { type: "application/json" });
      }));
      setFiles(files);
      syncFiles(b.dataset.sample);
      drop.classList.remove("is-loaded"); void drop.offsetWidth; drop.classList.add("is-loaded");
    } catch (err) {
      $("#start-error").textContent = String(err.message || err);
    }
  }));

  /* ---------- Board markup ---------- */
  const ICON = {
    converted: '<path d="M7 11.4l2.7 2.7L15.2 8.4"/>',
    review: '<path d="M8.6 8.6a2.45 2.45 0 1 1 3.5 2.2c-.7.35-1.1.85-1.1 1.6v.25"/><circle cx="11" cy="15.4" r="0.95"/>',
    unsupported: '<path d="M8 8l6 6"/><path d="M14 8l-6 6"/>'
  };
  const LABEL = { converted: "Converted", review: "Needs review", unsupported: "Not supported" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const find = (id) => items.find((it) => it.id === id);
  const listFor = (status) => $(`.col[data-status="${status}"] .items`);

  function itemEl(it) {
    const li = document.createElement("li");
    li.className = "item";
    li.id = `item-${it.id}`;
    li.innerHTML = `
      <button class="item-btn" type="button" data-open="${it.id}" aria-expanded="false" aria-controls="drawer-${it.id}">
        <span class="badge s-${it.status}" role="img" aria-label="${it.outcome ? OUTCOME[it.outcome] : LABEL[it.status]}">
          <svg viewBox="0 0 22 22" aria-hidden="true">${ICON[it.status]}</svg>
        </span>
        <span class="name">${esc(it.name)}</span>
        <span class="plus" aria-hidden="true"></span>
      </button>
      <div class="drawer" id="drawer-${it.id}"><div><div class="drawer-body" data-body="${it.id}"></div></div></div>`;
    return li;
  }

  /* ======================================================================
     Dial. One tick per item (items share ticks past 120). A tick turns
     orange while its item is being worked on and settles into its status
     colour when done. The orange arc keeps turning however long it takes.
     ====================================================================== */
  const badge = (it) => `<span class="badge s-${it.status}"><svg viewBox="0 0 22 22" aria-hidden="true">${ICON[it.status]}</svg></span>`;
  const ticksEl = $("#ticks"), nowEl = $("#now"), dialEl = $(".dial");
  const MAX_TICKS = 120, LANES = 3;
  let tickCount = 0, doneN = 0;
  const tickFor = (i) => ticksEl.children[Math.floor((i * tickCount) / items.length)];
  const count = { converted: 0, review: 0, unsupported: 0 };

  function buildTicks() {
    tickCount = Math.min(items.length, MAX_TICKS);
    let out = "";
    for (let t = 0; t < tickCount; t++) {
      out += `<line class="tick" x1="200" y1="14" x2="200" y2="40" transform="rotate(${((t * 360) / tickCount).toFixed(2)} 200 200)" style="--i:${t}"/>`;
    }
    ticksEl.innerHTML = out;
  }
  function showNow(name) {
    nowEl.textContent = name;
    nowEl.classList.remove("is-in"); void nowEl.offsetWidth; nowEl.classList.add("is-in");
  }
  function stopStage() { dialEl.classList.remove("is-working"); }

  /* ---------- Step boxes (right of the dial) ---------- */
  const STEPS = [
    { title: "Generate dashboard mappings" },
    { title: "Apply mapping structures" },
    { title: "Test and refine", subs: ["Approximate where needed", "Record assumptions", "Choose the best-effort mapping"] },
    { title: "Check what worked", subs: ["Deterministically evaluate which mapping succeeded best"] },
  ];
  // Real runs: what the local backend actually does inside its one request, then the reveal.
  const REAL_STEPS = [
    { title: "Read the Datadog files" },
    { title: "Translate with the deterministic converter", subs: ["Checked-in mappings, no AI"] },
    { title: "Check the results" },
  ];
  const stepsEl = $("#steps"), publishEl = $("#publish"), publishBtn = $("#publish-btn");
  let stepEl = null, stepN = -1, subN = -1, publishResolve = null;

  function stepOut() {
    const el = stepEl;
    stepEl = null;
    if (!el) return;
    if (still()) { el.remove(); return; }
    $$(".step-subs li", el).forEach((li) => li.classList.add("is-in", "is-done"));
    el.classList.add("is-out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }
  function stepIn(n, subs) {
    stepOut();
    stepN = n; subN = -1;
    const list = real ? REAL_STEPS : STEPS;
    const s = { ...list[n], ...(subs ? { subs } : {}) };
    const el = document.createElement("div");
    el.className = "step-box";
    el.innerHTML = `<p class="step-num mono">${String(n + 1).padStart(2, "0")} / ${String(list.length).padStart(2, "0")}</p>
      <h3 class="step-title">${esc(s.title)}</h3>
      ${s.subs ? `<ul class="step-subs">${s.subs.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      <span class="step-bar" aria-hidden="true"></span>`;
    stepsEl.appendChild(el);
    stepEl = el;
    $("#live").textContent = s.title;
  }
  function stepSub(k) {
    if (!stepEl || k <= subN) return;
    const lis = $$(".step-subs li", stepEl);
    lis.forEach((li, j) => { if (j <= k) li.classList.add("is-in"); if (j < k) li.classList.add("is-done"); });
    subN = k;
  }
  // While items translate: Apply mapping structures, then Test and refine with its three parts.
  function onProgress(p) {
    if (stepN === 1 && p >= 0.35) { stepIn(2); stepSub(0); }
    if (stepN === 2) { if (p >= 0.6) stepSub(1); if (p >= 0.82) stepSub(2); }
  }

  async function work(i, id) {
    const it = items[i], tick = tickFor(i);
    tick.classList.add("is-active");
    showNow(it.name);
    await window.MigrateBackend.process(it);   // backend.js: mock delay, or a real result
    if (id !== runId) return;
    light(i);
    onProgress(doneN / items.length);
  }
  function light(i) {
    const it = items[i], tick = tickFor(i);
    tick.classList.remove("is-active");
    tick.classList.remove("t-converted", "t-review", "t-unsupported");
    tick.classList.add(`t-${it.status}`);
    doneN++;
    count[it.status]++;
    $("#pct").textContent = Math.round((doneN / items.length) * 100);
    const n = $(`#n-${it.status}`);
    n.textContent = count[it.status];
    n.classList.remove("is-bump"); void n.offsetWidth; n.classList.add("is-bump");
  }

  /* ---------- Run ---------- */
  function setStep(i) {
    $$("li", progress).forEach((li, n) => {
      li.classList.toggle("is-done", n < i);
      li.classList.toggle("is-active", n === i);
    });
  }

  function reset(list) {
    items = list.map((it) => ({ ...it, open: false, state: "idle" }));
    $$(".items", board).forEach((ul) => (ul.innerHTML = ""));
    $$(".more-btn, .rgroups", board).forEach((b) => b.remove());
    board.classList.remove("is-sorted", "is-done", "is-entering", "show-all");
    board.classList.add("is-hidden");
    $("#stage-wrap").classList.remove("is-closed", "is-hidden");
    dialEl.classList.remove("is-working", "is-read", "is-done");
    $$(":scope > .step-box", stepsEl).forEach((b) => b.remove());
    $(".run-wrap").classList.add("is-running");
    stepEl = null; stepN = -1; subN = -1; publishResolve = null;
    publishEl.hidden = true;
    publishEl.classList.remove("is-out", "is-done");
    publishBtn.classList.remove("is-publishing", "is-published");
    $(".pub-txt", publishBtn).textContent = "Publish final migration";
    buildTicks();
    doneN = 0;
    for (const s of Object.keys(count)) { count[s] = 0; $(`#n-${s}`).textContent = "0"; }
    $("#pct").textContent = "0";
    nowEl.textContent = "";
    progress.classList.remove("is-gone");
    setStep(-1);
    title.classList.remove("is-in");
    $(".foot").classList.remove("is-in");
    $("#live").textContent = "";
    resetOptions();
  }

  async function runMigration() {
    if (real) return runReal();
    const startBtn = $("#start-btn");
    if (startBtn.disabled) return;
    const id = ++runId;
    startBtn.disabled = true;
    startBtn.setAttribute("aria-busy", "true");
    $(".go-label", startBtn).textContent = real ? "Converting…" : "Loading…";
    let list;
    try {
      list = await window.MigrateBackend.load($("#source-files").files);
    } catch (err) {
      $("#start-error").textContent = String(err.message || err);
      return;
    } finally {
      startBtn.disabled = false;
      startBtn.removeAttribute("aria-busy");
      $(".go-label", startBtn).textContent = "Convert";
    }
    if (id !== runId) return;
    $("#start-error").textContent = "";
    reset(list);
    await show("run");
    window.scrollTo(0, 0);

    // 01 Read: the ticks sweep in around the dial.
    setStep(0);
    showNow(`${items.length} items`);
    dialEl.classList.add("is-read");
    stepIn(0);
    await wait(1500);
    if (id !== runId) return;

    // 02 Translate: a few at a time, for as long as the backend takes.
    setStep(1);
    dialEl.classList.add("is-working");
    stepIn(1);
    let next = 0;
    const lane = async (d) => {
      await wait(d);
      while (next < items.length && id === runId) await work(next++, id);
    };
    await Promise.all(Array.from({ length: LANES }, (_, k) => lane(k * 200)));
    if (id !== runId) return;
    stopStage();

    // 03 Check: the dial glows once while the last step runs.
    setStep(2);
    stepIn(3);
    $("#pct").textContent = "100";
    showNow("Done");
    dialEl.classList.add("is-done");
    await wait(500);
    stepSub(0);
    await wait(1300);
    if (id !== runId) return;
    stepOut();

    // Publish: the button appears where the steps were; the results follow its click.
    await wait(260);
    if (id !== runId) return;
    publishEl.hidden = false;
    $("#live").textContent = "Migration ready. Publish final migration.";
    publishBtn.focus({ preventScroll: true });
    await new Promise((r) => (publishResolve = r));
    if (id !== runId) return;
    await publishAnim();
    if (id !== runId) return;

    // The stage folds away and the results sort into the table.
    progress.classList.add("is-gone");
    $("#stage-wrap").classList.add("is-closed");
    await wait(440);
    $(".run-wrap").classList.remove("is-running");
    $("#stage-wrap").classList.add("is-hidden");
    if (id !== runId) return;
    await sortIntoBoard(id);
    finish(id);
  }

  // Each stage stays on screen for at least its minimum, however fast the backend answers.
  const MIN_READ = 1100, MIN_TRANSLATE = 1500, REVEAL = 1500;

  async function runReal() {
    const startBtn = $("#start-btn");
    if (startBtn.disabled) return;
    const id = ++runId;
    const files = Array.from($("#source-files").files);
    startBtn.disabled = true;
    startBtn.setAttribute("aria-busy", "true");
    $(".go-label", startBtn).textContent = "Converting…";
    $("#start-error").textContent = "";
    // The one POST (or saved report fetch) starts now; the screens below only animate around it.
    const pending = window.MigrateBackend.load(files).then((list) => ({ list }), (err) => ({ err }));

    reset([]);
    await show("run");
    window.scrollTo(0, 0);

    // 01 Read: the arc turns while the backend reads the files.
    setStep(0);
    dialEl.classList.add("is-working");
    showNow("Reading");
    const source = window.MigrateBackend.mode === "report" ? "Saved report"
      : files.length ? `${files.length} uploaded file${files.length === 1 ? "" : "s"}` : "Pinned Postgres demo";
    stepIn(0, [source]);
    stepSub(0);
    await wait(MIN_READ);
    if (id !== runId) return;

    // 02 Translate: stays until the converter has answered.
    setStep(1);
    showNow("Converting");
    stepIn(1);
    stepSub(0);
    const [res] = await Promise.all([pending, wait(MIN_TRANSLATE)]);
    startBtn.disabled = false;
    startBtn.removeAttribute("aria-busy");
    $(".go-label", startBtn).textContent = "Convert";
    if (id !== runId) return;
    if (res.err) {
      stopStage();
      stepOut();
      $(".run-wrap").classList.remove("is-running");
      await show("start");
      $("#start-error").textContent = String(res.err.message || res.err);
      return;
    }

    // 03 Check: the finished report is revealed on the dial, one tick per result.
    items = res.list.map((it) => ({ ...it, open: false, state: "idle" }));
    buildTicks();
    stopStage();
    void dialEl.offsetWidth;
    dialEl.classList.add("is-read");
    showNow(`${items.length} items`);
    setStep(2);
    const v = window.MigrateBackend.result.report.validation || {};
    stepIn(2, [`Syntax ${v.syntax || "not_run"}`, `Schema ${v.schema || "not_run"}`]);
    await wait(500);
    if (id !== runId) return;
    const per = still() ? 0 : Math.max(8, Math.min(90, REVEAL / Math.max(items.length, 1)));
    for (let i = 0; i < items.length; i++) {
      light(i);
      if (i === Math.floor(items.length / 3)) stepSub(0);
      if (i === Math.floor((2 * items.length) / 3)) stepSub(1);
      if (per) await new Promise((r) => setTimeout(r, per));
      if (id !== runId) return;
    }
    stepSub(1);
    $("#pct").textContent = "100";
    showNow("Done");
    dialEl.classList.add("is-done");
    $("#live").textContent = "Conversion finished.";
    await wait(1200);
    if (id !== runId) return;
    stepOut();

    // The stage folds away and the results sort into the table, as in the mock.
    const result = window.MigrateBackend.result;
    $("#run-note").textContent = `Offline conversion. Syntax: ${v.syntax || "not_run"}; schema: ${v.schema || "not_run"}; API: ${v.api || "not_run"}; semantics: ${v.semantics || "not_run"}. Skipped files: ${result.report.summary?.skippedFiles || 0}.`;
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const download = $("#download-results");
    download.href = downloadUrl;
    download.download = "conversion-results.json";
    download.hidden = false;
    progress.classList.add("is-gone");
    $("#stage-wrap").classList.add("is-closed");
    await wait(440);
    $(".run-wrap").classList.remove("is-running");
    $("#stage-wrap").classList.add("is-hidden");
    if (id !== runId) return;
    await sortIntoBoard(id);
    finish(id);
  }

  async function publishAnim() {
    publishBtn.classList.add("is-publishing");
    $(".pub-txt", publishBtn).textContent = "Publishing";
    await wait(760);                                   // orange sweeps across the button
    publishBtn.classList.remove("is-publishing");
    publishBtn.classList.add("is-published");
    $(".pub-txt", publishBtn).textContent = "Published";
    publishEl.style.setProperty("--pub-w", `${publishBtn.offsetWidth}px`);
    publishEl.style.setProperty("--pub-h", `${publishBtn.offsetHeight}px`);
    publishEl.classList.add("is-done");                // ring pulses out, tick draws
    burst(publishEl, publishBtn, 14, ["var(--ok)", "var(--signal)", "var(--warn)"], "confetti", 46);
    $("#live").textContent = "Published.";
    await wait(900);
    publishEl.classList.add("is-out");
    await wait(320);
  }

  const SHOW_FIRST = 6;
  async function sortIntoBoard(id) {
    const source = listFor("converted");
    let shownConverted = 0;
    const els = items.map((it) => {
      const e = itemEl(it);
      if (it.status === "converted" && ++shownConverted > SHOW_FIRST) e.classList.add("is-extra", "is-final");
      source.appendChild(e);
      return e;
    });
    const vis = els.filter((e) => !e.classList.contains("is-extra"));
    board.classList.remove("is-hidden");
    if (still() || vis.length > 60) { els.forEach((e) => e.classList.add("is-final")); placeAll(els); return; }

    board.classList.add("is-entering");
    vis.forEach((e, i) => e.animate(
      [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
      { duration: 420, delay: i * 40, easing: EASE, fill: "backwards" }));
    await wait(vis.length * 40 + 380);
    if (id !== runId) return;

    const before = new Map(vis.map((e) => [e, e.getBoundingClientRect()]));
    placeAll(els);
    let delay = 0;
    vis.forEach((e) => {
      const a = before.get(e), b = e.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      const moving = Math.abs(dx) > 1;
      const d = moving ? 640 : 420;
      const start = delay;
      delay += moving ? 110 : 45;
      e.classList.add("is-flying");
      e.animate(
        moving
          ? [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: `translate(${dx * 0.12}px, ${dy * 0.12}px)`, offset: 0.7 }, { transform: "none" }]
          : [{ transform: `translate(0, ${dy}px)` }, { transform: "none" }],
        { duration: d, delay: start, easing: EASE, fill: "backwards" }
      ).finished.then(() => e.classList.remove("is-flying"), () => {});
      setTimeout(() => id === runId && e.classList.add("is-final"), start + d * 0.62);
    });
    await wait(delay + 650);
  }

  // The review column's groups: one per remark outcome. Partial appears only when it has rows.
  const REVIEW_GROUPS = ["approximated", "assumed", "best_effort", "partial"];
  function reviewGroups() {
    const review = items.filter((it) => it.status === "review");
    if (!review.length || !review.every((it) => it.outcome)) return null;
    const col = $('.col[data-status="review"]');
    const wrap = document.createElement("div");
    wrap.className = "rgroups";
    wrap.innerHTML = REVIEW_GROUPS.map((o) => {
      const n = review.filter((it) => it.outcome === o).length;
      if (o === "partial" && !n) return "";
      return `<section class="rgroup${n ? "" : " is-empty"}" data-outcome="${o}">
          <button class="rgroup-head" type="button" data-group="${o}" aria-expanded="${n ? "true" : "false"}" aria-controls="rg-${o}" ${n ? "" : "disabled"}>
            <span class="rgroup-name">${OUTCOME[o]}</span><b>${n}</b><span class="plus" aria-hidden="true"></span>
          </button>
          <div class="rgroup-body" id="rg-${o}"><div><ul class="items"></ul></div></div>
        </section>`;
    }).join("");
    col.appendChild(wrap);
    return wrap;
  }

  function placeAll(els) {
    board.classList.add("is-sorted");
    for (const status of ["converted", "review", "unsupported"]) {
      const ul = listFor(status);
      els.filter((e) => find(e.id.slice(5)).status === status).forEach((e) => ul.appendChild(e));
    }
    const groups = reviewGroups();
    if (groups) $$(":scope > .item", listFor("review")).forEach((e) =>
      $(`.rgroup[data-outcome="${find(e.id.slice(5)).outcome}"] .items`, groups).appendChild(e));
  }

  function finish(id) {
    if (id !== runId) return;
    setStep(3);
    progress.classList.add("is-gone");
    const nu = items.filter((it) => it.status === "unsupported").length;
    $("#callout").classList.toggle("is-hidden", nu === 0);
    $("#callout-txt").textContent = `${nu} item${nu === 1 ? " is" : "s are"} blocked. See diagnostics for the reason.`;
    $("#category-summary").innerHTML = Object.entries(OUTCOME).map(([outcome, label]) => {
      const k = items.filter((it) => it.outcome === outcome).length;
      return `<span class="outcome o-${outcome}${k ? "" : " is-zero"}"><i aria-hidden="true"></i><b>${k}</b> ${label}</span>`;
    }).join("");
    $("#category-summary").hidden = !items.some((it) => it.outcome);
    const extra = $$(".item.is-extra", board).length;
    if (extra) listFor("converted").insertAdjacentHTML("afterend",
      `<button class="link-btn more-btn" type="button" data-more="${extra}" aria-expanded="false">Show all ${extra + SHOW_FIRST} <span class="arrow" aria-hidden="true">↓</span></button>`);
    title.classList.add("is-in");
    board.classList.add("is-done");
    $(".foot").classList.add("is-in");
    title.focus({ preventScroll: true });
    const n = (s) => items.filter((it) => it.status === s).length;
    $("#live").textContent = `Conversion complete. ${n("converted")} translated, ${n("review")} converted with remarks, ${n("unsupported")} blocked.`;
    updateAiQuota();
  }

  function updateAiQuota() {
    if (window.MigrateBackend.mode !== "api") return;
    const ai = window.MigrateBackend.ai;
    $("#ai-quota").hidden = false;
    $("#ai-quota").textContent = ai.remaining === 0 ? salesMessage : ai.available
      ? `${ai.remaining} of 3 AI calls remaining. AI help runs only when you request it for a blocked item.`
      : "AI help is unavailable until Agent0 is configured on the backend.";
    $$("[data-ai-help]").forEach((button) => { button.disabled = aiBusy || !ai.available || ai.remaining === 0; });
  }

  async function requestAi(it) {
    if (aiBusy) return;
    aiBusy = true;
    it.aiError = "";
    updateAiQuota();
    const output = $(`#ai-result-${it.id}`);
    output.textContent = "Asking Agent0…";
    try {
      it.aiRecommendation = await window.MigrateBackend.suggest(it);
    } catch (err) {
      it.aiError = String(err.message || err);
    } finally {
      aiBusy = false;
      render(it);
      updateAiQuota();
    }
  }

  /* ---------- Item drawer ---------- */
  const STAR = '<svg class="star" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c.5 4.2 1.8 6.6 8 8-6.2 1.4-7.5 3.8-8 8-.5-4.2-1.8-6.6-8-8 6.2-1.4 7.5-3.8 8-8z"/></svg>';

  function bodyHTML(it) {
    if (real) {
      if (it.outcome === "translated") return '<p class="why">Translated.</p>';
      const diagnostics = it.diagnostics.filter((d) => d.severity === "error").map((d) => `<li><strong>${esc(d.code)}</strong><p>${esc(d.message)}</p><p>${esc(d.suggestedAction || "")}</p></li>`).join("");
      return `<p class="why">${esc(it.parent)} · ${esc(it.source.kind)}</p>
        <code>${esc(it.source.id)} ${esc(it.source.path)}</code>
        ${it.warningNames.length ? `<div class="warn-tags" aria-label="Warnings">${it.warningNames.map((name) => `<span class="outcome">${esc(name)}</span>`).join("")}</div>` : ""}
        ${diagnostics ? `<ul class="diagnostics">${diagnostics}</ul>` : ""}
        ${it.outcome === "blocked" && window.MigrateBackend.mode === "api" ? `
          <p class="why">Ask Agent0 to recommend a conversion for this item. Sends this source item and the checked-in mappings to Agent0.</p>
          <button class="ai-btn" type="button" data-ai-help="${it.id}" ${aiBusy || !window.MigrateBackend.ai.available || window.MigrateBackend.ai.remaining === 0 ? "disabled" : ""}>${STAR}Ask AI</button>
          <div id="ai-result-${it.id}" aria-live="polite">${it.aiError ? `<p class="why">${esc(it.aiError)}</p>` : ""}${it.aiRecommendation ? `<p class="why">AI recommendation · Not validated or applied</p><pre class="ai-recommendation">${esc(it.aiRecommendation)}</pre>` : ""}</div>` : ""}
        ${it.status === "review" ? '<p class="manual-note">Numeric comparison unavailable: this offline run has no Datadog or Dash0 measurements.</p>' : ""}`;
    }
    const out = [`<p class="why">${esc(it.why)}</p>`];
    if (it.action) out.push(`<p class="why">${esc(it.action)}</p>`);
    if (it.status === "converted") return out.join("");
    if (it.status === "review") {
      const c = it.compare || {};
      out.push(`<p class="manual-note">Fix this manually in Dash0.</p>
        <dl class="compare">
          <div><dt class="mono">Datadog</dt><dd>${fmtVal(c.datadog, c.unit)}</dd></div>
          <div><dt class="mono">Dash0</dt><dd>${fmtVal(c.dash0, c.unit)}</dd></div>
        </dl>
        <button class="link-btn" type="button" data-diff="${it.id}">Show % difference <span class="arrow" aria-hidden="true">→</span></button>
        <p class="diff" id="diff-${it.id}" aria-live="polite"></p>`);
      return out.join("");
    }
    if (it.status === "unsupported" && it.state !== "accepted") {
      out.push(`<button class="link-btn" type="button" data-options="1">See options <span class="arrow" aria-hidden="true">→</span></button>`);
      return out.join("");
    }
    if (it.state === "accepted") {
      out.push(`<code>${esc(it.suggestion.code)}</code>
        <p class="accepted-note" role="status">Accepted. Still needs validation in Dash0.</p>`);
    }
    return out.join("");
  }

  /* ---------- Needs review: Datadog vs Dash0 difference, from the displayed values ---------- */
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const fmtNum = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  function fmtVal(v, unit) { return isNum(v) ? `${fmtNum(v)}${esc(unit || "")}` : "Not available"; }
  // (Dash0 − Datadog) / |Datadog| × 100. Null when a value is missing or Datadog is 0: no made-up result.
  function pctDiff(c) {
    if (!c || !isNum(c.datadog) || !isNum(c.dash0) || c.datadog === 0) return null;
    return ((c.dash0 - c.datadog) / Math.abs(c.datadog)) * 100;
  }
  async function showDiff(it, btn) {
    const out = $(`#diff-${it.id}`);
    const d = pctDiff(it.compare);
    btn.remove();
    if (d === null) { out.textContent = "Difference unavailable."; out.classList.add("is-in", "is-na"); return; }
    const word = d > 0 ? "higher" : d < 0 ? "lower" : "";
    const tail = word ? ` Dash0 is ${word} than Datadog.` : " Same value in both.";
    out.innerHTML = `<span class="diff-num">${d > 0 ? "+" : d < 0 ? "−" : ""}<b>0.0</b>%</span><span class="diff-txt">${tail}</span>`;
    out.classList.add("is-in");
    const b = $("b", out), target = Math.abs(d);
    if (still()) { b.textContent = target.toFixed(1); return; }
    const t0 = performance.now(), dur = 700;
    await new Promise((done) => {
      const tickNum = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        b.textContent = (target * e).toFixed(1);
        k < 1 ? requestAnimationFrame(tickNum) : done();
      };
      requestAnimationFrame(tickNum);
    });
  }

  function render(it) { $(`[data-body="${it.id}"]`).innerHTML = bodyHTML(it); }

  function toggle(it) {
    it.open = !it.open;
    $(`[data-open="${it.id}"]`).setAttribute("aria-expanded", String(it.open));
    if (it.open) render(it);
    $(`#drawer-${it.id}`).classList.toggle("is-open", it.open);
  }

  /* ---------- AI flow (simulated) ---------- */
  function burst(host, from, n, colors, cls, spread) {
    if (still()) return;
    const box = host.getBoundingClientRect(), f = from.getBoundingClientRect();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
      const r = spread * (0.6 + Math.random() * 0.6);
      const s = document.createElement("span");
      s.className = cls;
      s.style.left = `${f.left - box.left + f.width / 2 - 2}px`;
      s.style.top = `${f.top - box.top + f.height / 2 - 2}px`;
      s.style.background = colors[i % colors.length];
      s.style.setProperty("--dx", `${Math.cos(a) * r}px`);
      s.style.setProperty("--dy", `${Math.sin(a) * r - spread * 0.25}px`);
      s.style.setProperty("--r", `${Math.round(Math.random() * 360)}deg`);
      host.appendChild(s);
      s.addEventListener("animationend", () => s.remove());
    }
  }

  function markAccepted(it) {
    const li = $(`#item-${it.id}`);
    if (!li) return;
    const badge = $(".badge", li);
    if (!$(".seal", badge)) {
      badge.insertAdjacentHTML("beforeend", '<span class="seal" aria-hidden="true"><svg viewBox="0 0 8 8"><path d="M1.6 4.2l1.6 1.6L6.6 2.4"/></svg></span>');
      badge.setAttribute("aria-label", `${LABEL[it.status]}, suggestion accepted`);
    }
    if (!$(".tag", li)) $(".name", li).insertAdjacentHTML("afterend", '<span class="tag">Accepted</span>');
    if (it.open) render(it);
  }

  /* ---------- Not supported: consult us, or try with AI (simulated) ---------- */
  const unsupported = () => items.filter((it) => it.status === "unsupported");
  const aiAct = $("#ai-act");

  function renderAiButton() {
    aiAct.innerHTML = `<button class="ai-btn" type="button" id="opt-ai-btn">${STAR}<span class="txt">Try with AI</span><span class="bar" aria-hidden="true"></span></button>`;
  }
  function resetOptions() {
    const c = $("#consult-btn");
    c.classList.remove("is-accepted");
    $(".txt", c).textContent = "Book a call";
    $("#opt-consult .opt-note")?.remove();
    renderAiButton();
  }

  async function openOptions() {
    // The AI option exists only while there are (mock) suggestions; a real report has none.
    const ai = unsupported().some((it) => it.suggestion);
    $("#opt-ai").hidden = !ai;
    $(".options").classList.toggle("is-single", !ai);
    $("#unsup-list").innerHTML = unsupported().map((it) => `<li>
        <span class="badge s-unsupported"><svg viewBox="0 0 22 22" aria-hidden="true">${ICON.unsupported}</svg></span>
        <span class="nm">${esc(it.name)}</span><span class="to mono">${esc(it.to)}</span>
      </li>`).join("");
    await show("unsupported");
    window.scrollTo(0, 0);
    $("#unsup-title").focus({ preventScroll: true });
  }

  async function consult(btn) {
    btn.classList.add("is-accepted");
    $(".txt", btn).textContent = "Call requested";
    await wait(380);
    if (!$("#opt-consult .opt-note")) btn.insertAdjacentHTML("afterend", '<p class="opt-note" role="status">Demo only. Nothing was sent.</p>');
  }

  async function optionsAi(btn) {
    burst($("#opt-ai"), $(".star", btn), 8, ["var(--signal)"], "spark", 22);
    btn.classList.add("is-thinking");
    btn.setAttribute("aria-busy", "true");
    $(".txt", btn).textContent = "Analyzing";
    await wait(1350);
    aiAct.innerHTML = unsupported().map((it) => it.state === "accepted"
      ? `<div class="suggestion" data-sugg="${it.id}"><p class="label mono">Workaround<b>${esc(it.name)}</b></p><code>${esc(it.suggestion.code)}</code><p class="accepted-note">Accepted. Still needs validation in Dash0.</p></div>`
      : `<div class="suggestion is-in" data-sugg="${it.id}" role="region" aria-label="Workaround for ${esc(it.name)}">
          <p class="label mono">Workaround<b>${esc(it.name)}</b></p>
          <code>${esc(it.suggestion.code)}</code>
          <p class="note">${esc(it.suggestion.note)}</p>
          <div class="row">
            <button class="btn btn-small accept-btn" type="button" data-opt-accept="${it.id}">
              <svg class="tick" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.3l2.4 2.4L9.8 3.4"/></svg><span class="txt">Accept</span>
            </button>
            <button class="btn btn-ghost btn-small" type="button" data-opt-dismiss="1">Not now</button>
          </div>
        </div>`).join("");
    $("[data-opt-accept]", aiAct)?.focus({ preventScroll: true });
  }

  async function optionsAccept(it, btn) {
    btn.classList.add("is-accepted");
    $(".txt", btn).textContent = "Accepted";
    burst($("#opt-ai"), btn, 12, ["var(--ok)", "var(--signal)", "var(--warn)"], "confetti", 34);
    await wait(650);
    it.state = "accepted";
    markAccepted(it);
    const row = $(`[data-sugg="${it.id}"] .row`, aiAct);
    if (row) row.outerHTML = '<p class="accepted-note" role="status">Accepted. Still needs validation in Dash0.</p>';
    $(`[data-sugg="${it.id}"] .note`, aiAct)?.remove();
  }

  /* ======================================================================
     Done. Three views after the results: "Your dashboards are ready", what
     moved (a donut of the items by status, then panels per dashboard), and
     an end view. Counts come from the same items as the board.
     ====================================================================== */
  const DONE_STATUS = [["converted", "Translated"], ["review", "With remarks"], ["unsupported", "Blocked"]];
  const DONUT_R = 58, DONUT_C = (2 * Math.PI * DONUT_R).toFixed(2);

  function renderDone() {
    const total = items.length;
    const c = { converted: 0, review: 0, unsupported: 0 };
    items.forEach((it) => c[it.status]++);
    const pct = total ? Math.round((c.converted / total) * 100) : 0;

    // Donut: one arc per status, a small gap between arcs when more than one is present.
    const gap = DONE_STATUS.filter(([s]) => c[s]).length > 1 ? 2.5 : 0;
    let off = 0, arcs = "";
    for (const [s] of DONE_STATUS) {
      const len = total ? (c[s] / total) * DONUT_C : 0;
      if (len) arcs += `<circle class="arc ${s}" cx="70" cy="70" r="${DONUT_R}" fill="none" stroke-width="11" data-len="${Math.max(0.1, len - gap).toFixed(2)}" stroke-dasharray="0 ${DONUT_C}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"/>`;
      off += len;
    }
    const donut = $("#donut");
    donut.setAttribute("aria-label", `${c.converted} of ${total} translated, ${c.review} with remarks, ${c.unsupported} blocked`);
    donut.innerHTML = `<circle class="track" cx="70" cy="70" r="${DONUT_R}" fill="none" stroke-width="11"/>${arcs}
      <text class="pct" x="70" y="74" text-anchor="middle">${pct}%</text>
      <text class="pl" x="70" y="91" text-anchor="middle">translated 1:1</text>`;

    $("#mrows").innerHTML = DONE_STATUS.map(([s, label]) => `<div class="mrow s-${s}">
        <i aria-hidden="true"></i><span>${label}</span><b>${c[s]}</b>
        <span class="bar" aria-hidden="true"><em style="width:${total ? ((c[s] / total) * 100).toFixed(1) : 0}%"></em></span>
      </div>`).join("");

    // Panels per dashboard: monitors are grouped together; mock items have no dashboard.
    const groups = new Map();
    for (const it of items) {
      const name = it.parent === "Monitor" ? "Monitors" : it.parent || "Demo dashboard";
      if (!groups.has(name)) groups.set(name, { converted: 0, review: 0, unsupported: 0, n: 0 });
      const g = groups.get(name);
      g[it.status]++; g.n++;
    }
    $("#dash-list").innerHTML = [...groups].sort((a, b) => b[1].n - a[1].n).map(([name, g]) => `<li>
        <span class="nm">${esc(name)}</span><span class="ct mono">${g.converted}/${g.n} translated</span>
        <span class="stack" aria-hidden="true">${DONE_STATUS.filter(([s]) => g[s]).map(([s]) => `<em class="${s}" style="flex:${g[s]}"></em>`).join("")}</span>
      </li>`).join("");

    const panels = real ? "widgets and monitors" : "panels and alerts";
    $("#moved-lead").textContent = `${c.converted} of ${total} ${panels} translated one to one. ${c.review} carry remarks to review, ${c.unsupported} ${c.unsupported === 1 ? "is" : "are"} blocked.`;

    const note = real ? "Converted offline · Nothing has been sent to Dash0" : "Simulated demo";
    $("#ready-note").textContent = note;
    $("#fine-note").textContent = note;
    // Open issues: blocked items whose suggestion has not been accepted. Only with none left
    // does the end view lead on to the closing page.
    const open = items.filter((it) => it.status === "unsupported" && it.state !== "accepted").length;
    $("#end-next").hidden = open > 0;
    const follow = open ? ` ${open} blocked item${open === 1 ? " needs" : "s need"} manual follow-up.` : "";
    $("#end-lead").textContent = real
      ? `Your Perses and Dash0 files are ready to download. Nothing has been sent to Dash0 yet.${follow}`
      : open ? `The dashboards are in Dash0.${follow}` : "Every item is translated or has an accepted fix.";
    const dl = $("#end-download");
    dl.hidden = !(real && downloadUrl);
    if (!dl.hidden) { dl.href = downloadUrl; dl.download = "conversion-results.json"; }
    // One primary action: Continue when the closing page is next, else download or results.
    if (!open) dl.hidden = true;
    $("#end-results").hidden = !open || !dl.hidden;
  }

  function drawDonut() {
    const arcs = $$("#donut .arc");
    arcs.forEach((a) => a.setAttribute("stroke-dasharray", `0 ${DONUT_C}`));
    requestAnimationFrame(() => requestAnimationFrame(() => arcs.forEach((a, k) =>
      setTimeout(() => a.setAttribute("stroke-dasharray", `${a.dataset.len} ${DONUT_C}`), still() ? 0 : k * 150))));
  }

  const DONE_FOCUS = { ready: "#ready-title", overview: "#moved-title", end: "#end-title", fine: "#fine-title" };
  function doneView(name) {
    $$("#done .dview").forEach((v) => (v.hidden = v.dataset.view !== name));
    window.scrollTo(0, 0);
    if (name === "overview") drawDonut();
    $(DONE_FOCUS[name]).focus({ preventScroll: true });
  }

  async function openDone() {
    renderDone();
    $$("#done .dview").forEach((v) => (v.hidden = true));
    await show("done");
    doneView("ready");
  }

  $("#finish-btn").addEventListener("click", openDone);
  $("#done").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-dview], [data-results]");
    if (!t) return;
    if (t.dataset.dview) return doneView(t.dataset.dview);
    await show("run");
    window.scrollTo(0, 0);
    $("#finish-btn").focus({ preventScroll: true });
  });
  $("#end-again").addEventListener("click", () => $("#again-btn").click());

  /* ---------- Events ---------- */
  board.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.open) toggle(find(t.dataset.open));
    else if (t.dataset.aiHelp) requestAi(find(t.dataset.aiHelp));
    else if (t.dataset.group) {
      const open = t.getAttribute("aria-expanded") !== "true";
      t.setAttribute("aria-expanded", String(open));
      t.closest(".rgroup").classList.toggle("is-collapsed", !open);
    }
    else if (t.dataset.diff) showDiff(find(t.dataset.diff), t);
    else if (t.dataset.options) openOptions();
    else if (t.dataset.more) {
      const open = board.classList.toggle("show-all");
      t.setAttribute("aria-expanded", String(open));
      t.innerHTML = open ? 'Show fewer <span class="arrow" aria-hidden="true">↑</span>' : `Show all ${+t.dataset.more + SHOW_FIRST} <span class="arrow" aria-hidden="true">↓</span>`;
    }
  });

  publishBtn.addEventListener("click", () => {
    if (!publishResolve || publishBtn.classList.contains("is-publishing")) return;
    const r = publishResolve;
    publishResolve = null;
    r();
  });

  $("#options-btn").addEventListener("click", openOptions);
  $("#back-btn").addEventListener("click", async () => {
    await show("run");
    window.scrollTo(0, 0);
    $("#options-btn").focus({ preventScroll: true });
  });
  $("#consult-btn").addEventListener("click", (e) => consult(e.currentTarget));
  $("#opt-ai").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.id === "opt-ai-btn") optionsAi(t);
    else if (t.dataset.optAccept) optionsAccept(find(t.dataset.optAccept), t);
    else if (t.dataset.optDismiss) { renderAiButton(); $("#opt-ai-btn").focus(); }
  });
  renderAiButton();

  $("#start-btn").addEventListener("click", () => setTimeout(runMigration, still() ? 0 : 120));
  $("#again-btn").addEventListener("click", async () => {
    runId++;
    stopStage();
    await show("start");
    $$(".start-title, .start-row > *").forEach((n) => { n.style.animation = "none"; void n.offsetWidth; n.style.animation = ""; });
    $("#start-btn").focus();
  });

  /* ---------- Hooks for the voice copilot (copilot.js) ----------
     Read items and navigate only. Nothing here changes an item or a compiler result. */
  window.MigrateApp = {
    items: () => items,
    ready: () => board.classList.contains("is-done"),
    async showResults() {
      if (!screens.run.classList.contains("is-active")) await show("run");
    },
    // Back to an empty start screen without reloading (the guided tour starts here).
    async restart() {
      runId++;
      stopStage();
      setFiles([]);
      if (!screens.start.classList.contains("is-active")) await show("start");
      window.scrollTo(0, 0);
    },
    // Make an item's row visible: show all rows, unfold its review group, open its drawer.
    reveal(it) {
      const li = $(`#item-${it.id}`);
      if (!li) return null;
      if (li.classList.contains("is-extra") && !board.classList.contains("show-all")) $("[data-more]", board)?.click();
      const group = li.closest(".rgroup.is-collapsed");
      if (group) $("[data-group]", group)?.click();
      if (!it.open) toggle(it);
      return li;
    },
  };
})();
