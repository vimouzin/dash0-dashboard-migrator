// Jarvis on entry and the guided tour.
//
//   Entry       the live agent asks whether you want a tour (as soon as the browser allows sound,
//               otherwise on your first click or key press). "Yes": it calls start_tour and the
//               tour runs. "No": it calls stay_passive and waits until you click the dot.
//   Tour        the recorded voice-over (voice/line-N.m4a) on a fixed plan that stretches if a
//               line runs long. It cannot be interrupted: clicks and keys are blocked until it
//               ends. Then the live agent takes over and answers questions.
//   Start tour  (header) starts the tour directly.
//   ?demo=1     the tour for recording a video: silent and exactly 60 s (&voice=1 adds the voice
//               where the browser allows autoplay). DEMO_SCRIPT.md has the lines and times.
//
// The run is real: the "Online shop checkout" sample through the local converter.
(() => {
  "use strict";

  const J = window.Jarvis;
  if (!J) return;                                           // copilot.js needs the local backend
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);

  // The voice-over. Times are seconds from the start of the tour, fitted to the recorded take
  // (voice/line-N.m4a, 15 % faster than the ElevenLabs export). DEMO_SCRIPT.md mirrors this table.
  const LINES = [
    { at: 0.6, end: 5.49, text: "Hi, I'm Jarvis. Let's move your Datadog setup to Dash0." },
    { at: 6.0, end: 10.44, text: "We'll start with this online shop: a checkout dashboard and its alert." },
    { at: 11.6, end: 17.84, text: "Now every query is translated by fixed rules. No guessing: the same input always gives the same result." },
    { at: 20.0, end: 26.31, text: "Done. Four widgets moved one to one, two need a quick review, and three are blocked." },
    { at: 26.8, end: 32.13, text: "This one is blocked: its error metric has no mapping yet. Here's exactly what to add." },
    { at: 32.9, end: 40.36, text: "Stuck? Ask AI drafts a suggestion for any blocked item. You review it, nothing is applied automatically." },
    { at: 42.2, end: 44.88, text: "And that's it. Your dashboards are ready." },
    { at: 46.0, end: 52.08, text: "Forty-four percent moved one to one. Everything else is clearly marked. Nothing is hidden." },
    { at: 53.0, end: 58.85, text: "Download your files, fix the three flagged items, then publish. I'm right here if you need me." },
  ];
  const ASK = "Hi, I'm Jarvis, an ElevenLabs voice agent. Want a quick tour of the tool?";
  const ENTRY = "The user has just opened the Migrate tool. You asked whether they want a guided tour. "
    + "If yes, say something short like 'Great, here we go.' and call start_tour. If no, say something "
    + "short like 'No problem, tap me whenever you need me.' and call stay_passive.";
  const HANDOFF = "The user has just watched your guided tour of the Migrate tool (the 'Online shop checkout' "
    + "sample) and is now on the 'All set.' screen. Answer their questions about this migration.";
  const SAMPLE = '[data-sample="checkout_dashboard.json checkout_error_rate_monitor.json"]';
  const TOTAL = 60;

  // What Jarvis does on screen, on the same clock.
  const ACTIONS = [
    { at: 0.0, run: () => J.state("idle") },
    { at: 5.7, run: () => J.touch($(SAMPLE)) },
    { at: 6.4, run: () => $(SAMPLE).click() },
    { at: 10.8, run: () => J.touch($("#start-btn")) },
    { at: 11.2, run: () => { $("#start-btn").click(); J.state("working"); } },
    // The real run takes about 8.3 s after Convert.
    { at: 19.8, run: () => { J.state("idle"); J.touch($("#category-summary"), 1600); }, results: true },
    { at: 26.5, run: () => J.tools.highlight_issue({ issue_id: "Checkout error rate (%)" }) },
    // Ask AI is only introduced: Jarvis points at it but never clicks (a click would call Agent0).
    { at: 32.25, run: () => askAi()?.scrollIntoView({ behavior: "smooth", block: "center" }) },
    { at: 32.7, run: () => J.touch(askAi(), 3000) },
    { at: 36.4, run: () => J.touch(askAi(), 3000) },
    { at: 40.6, run: () => $("#finish-btn").scrollIntoView({ behavior: "smooth", block: "center" }) },
    { at: 41.1, run: () => J.touch($("#finish-btn")) },
    { at: 41.5, run: () => $("#finish-btn").click() },
    { at: 45.1, run: () => J.touch($("#done .orb")) },
    { at: 45.5, run: () => $("#done .orb").click() },
    { at: 52.2, run: () => J.touch($('#done [data-dview="end"]')) },
    { at: 52.6, run: () => $('#done [data-dview="end"]').click() },
    { at: 59.2, run: () => J.state("passive") },
  ];

  const askAi = () => [...document.querySelectorAll("#board [data-ai-help]")].find((b) => b.offsetParent);
  const tourBtn = $("#tour-btn");
  let tour = null;
  const wait = (run, ms) => new Promise((done) => run.timers.push(setTimeout(done, Math.max(0, ms))));

  /* ---------- Voice: the agent's voice for each line, played through Web Audio ---------- */
  let ctx = null;
  function unlockAudio() {                                  // must run inside the click
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = ctx || new AC();
    ctx.resume();
    return ctx;
  }
  // The recorded take first (voice/line-N.m4a); without it, the backend voices each line.
  async function loadVoice(run) {
    try {
      const recorded = await Promise.all(LINES.map(async (_, i) => {
        const res = await fetch(`voice/line-${i + 1}.m4a`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ctx.decodeAudioData(await res.arrayBuffer());
      }));
      return run.live ? recorded : null;
    } catch { /* fall back to the agent's voice from the backend */ }
    const buffers = await Promise.all(LINES.map(async (l) => {
      const res = await fetch("/api/copilot/speech", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: l.text }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Voice unavailable (HTTP ${res.status}).`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    }));
    return run.live ? buffers : null;
  }
  function playLine(buffer, run) {
    const src = ctx.createBufferSource(), analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.buffer = buffer;
    src.connect(analyser).connect(ctx.destination);
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const meter = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      J.level(Math.min(1, Math.sqrt(sum / data.length) * 4.5));
      raf = requestAnimationFrame(meter);
    };
    src.onended = () => { cancelAnimationFrame(raf); J.level(null); };
    run.sources.push(src);
    src.start();
    meter();
  }

  /* ---------- The tour ---------- */
  async function play({ voice = false } = {}) {
    stop();
    const run = { live: true, timers: [], sources: [], shift: 0, speakingUntil: 0, lineEnd: Infinity };
    tour = run;
    shield(true);
    syncButton();
    J.closeSheet();
    let buffers = null;
    if (voice && ctx) {
      J.state("connecting");
      try {
        buffers = await loadVoice(run);
      } catch (err) {
        J.fail(`${err.message || err} The tour runs without sound.`);
      }
      if (!run.live) return;
    }
    await window.MigrateApp.restart();
    if (!run.live) return;
    const t0 = performance.now();
    const steps = [
      ...ACTIONS.map((a) => ({ at: a.at, go: a.run, results: a.results })),
      ...LINES.map((l, i) => ({ at: l.at, go: () => speak(l, buffers?.[i], run) })),
    ].sort((a, b) => a.at - b.at);
    for (const step of steps) {
      await wait(run, t0 + step.at * 1000 + run.shift - performance.now());
      if (!run.live) return;
      // A step planned after the current line's end waits until Jarvis has finished it:
      // the rest of the plan stretches instead. Steps planned during a line run on time.
      const over = run.speakingUntil - performance.now();
      if (over > 0 && step.at >= run.lineEnd) {
        run.shift += over + 250;
        await wait(run, over + 250);
        if (!run.live) return;
      }
      if (step.results && !window.MigrateApp.ready()) {
        const late = performance.now();
        while (run.live && !window.MigrateApp.ready()) await wait(run, 50);
        run.shift += performance.now() - late;
        if (!buffers) console.warn(`[demo] results arrived ${Math.round(performance.now() - late)} ms late; voice-over will drift`);
      }
      try { await step.go(); } catch (err) { console.warn("[demo] step failed", step.at, err); }
    }
    // After the spoken tour (Start tour), Jarvis stays on the line: the live agent takes over and
    // answers questions. The silent and the recording tours just end.
    const handoff = Boolean(buffers) && !recording;
    if (!handoff) await wait(run, t0 + TOTAL * 1000 + run.shift - performance.now());
    if (!run.live) return;
    console.info(`[demo] finished at ${((performance.now() - t0) / 1000).toFixed(2)} s`);
    tour = null;
    shield(false);
    syncButton();
    if (handoff) J.start({ context: HANDOFF });
  }

  // While the tour runs nothing can interrupt it: a transparent layer takes every click
  // (the tour's own clicks are programmatic), the dot is locked and keys are ignored.
  const layer = document.createElement("div");
  layer.className = "tour-shield";
  layer.hidden = true;
  document.body.appendChild(layer);
  function shield(on) {
    layer.hidden = !on;
    J.lock(on);
  }

  function speak(l, buffer, run) {
    const ms = buffer ? buffer.duration * 1000 : (l.end - l.at) * 1000;
    const prev = $(".jv").dataset.state === "working" ? "working" : "idle";
    J.state("speaking");
    J.say(l.text);
    if (buffer) {
      playLine(buffer, run);
      run.speakingUntil = performance.now() + ms;
      run.lineEnd = l.end;
    }
    run.timers.push(setTimeout(() => { if (run.live) J.state(prev); }, ms));
  }

  function stop() {
    if (!tour) return;
    tour.live = false;
    tour.timers.forEach(clearTimeout);
    tour.sources.forEach((s) => { try { s.stop(); } catch { /* already ended */ } });
    tour = null;
    shield(false);
    J.level(null);
    J.say("");
    J.state("passive");
    syncButton();
  }

  function syncButton() {
    $(".tour-txt", tourBtn).textContent = tour ? "Tour running" : "Start tour";
    tourBtn.classList.toggle("is-on", Boolean(tour));
    tourBtn.disabled = Boolean(tour);
  }

  async function startTour() {
    if (tour) return;
    if (J.live()) await J.end();
    unlockAudio();
    play({ voice: true });
  }

  /* ---------- The agent decides: tour or not ---------- */
  // Tool results go back to the agent; the session ends once it has finished its sentence.
  J.tools.start_tour = async () => {
    J.afterSpeaking(startTour);
    return "The tour starts now. Say nothing more.";
  };
  J.tools.stay_passive = async () => {
    J.afterSpeaking(() => J.end());
    return "Okay. The user can tap the dot later. Say nothing more.";
  };

  // Ask on entry. Sound needs a user gesture first, unless the browser already allows it.
  function soundAllowed() {
    if (navigator.userActivation?.hasBeenActive) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext, probe = new AC();
      const ok = probe.state === "running";
      probe.close();
      return ok;
    } catch { return false; }
  }
  function welcome() {
    const ask = { firstMessage: ASK, context: ENTRY };
    if (soundAllowed()) { J.start(ask); return; }
    J.setNext(ask);                                          // a click on the dot asks too
    const first = (e) => {
      removeEventListener("pointerdown", first, true);
      removeEventListener("keydown", first, true);
      if (tour || J.live() || e.target.closest?.(".jv-dot, #tour-btn")) return;
      J.start(ask);
    };
    addEventListener("pointerdown", first, true);
    addEventListener("keydown", first, true);
  }

  /* ---------- Controls ---------- */
  const recording = params.get("demo") === "1";
  tourBtn.hidden = recording;                               // keep the header clean on camera
  tourBtn.addEventListener("click", () => { J.setNext(null); startTour(); });
  addEventListener("keydown", (e) => {
    if (tour) { e.preventDefault(); e.stopPropagation(); return; }   // the tour can't be interrupted
    if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea/i.test(e.target.tagName)) return;
    if (e.key.toLowerCase() === "d" && !J.live()) location.search = "?demo=1";
  }, true);

  setTimeout(() => {
    // ?demo=1&voice=1 also plays the recorded lines (needs a browser that allows autoplay).
    if (recording) { if (params.get("voice") === "1") unlockAudio(); play({ voice: params.get("voice") === "1" }); }
    else welcome();
  }, 900);

  window.JarvisDemo = { play, stop, LINES, ACTIONS, TOTAL };
})();
