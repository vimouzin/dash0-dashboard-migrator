# Jarvis demo: 60-second voice-over script

The guided demo in the local UI (`preview/demo.js`) walks through the whole tool in exactly
60 seconds. The timings below are fitted to the recorded ElevenLabs take (Eleven v3, played
15 % faster without changing pitch): `preview/voice/line-1.m4a` … `line-9.m4a`. They are the
same as `LINES` in `preview/demo.js`; change both together.

## Recording the video

- **With sound:** click **Start tour** and record the screen with system audio. The tour plays
  the recorded lines on its own clock.
- **Silent, then lay the track over:** open `http://localhost:3002/?demo=1` (1440×900 window).
  Timecode 0:00 = 0.9 s after the page loads. Lay `demo/voiceover/jarvis-tour-voiceover-60s.wav`
  (or `.m4a`) at 0:00: it holds all nine lines at exactly these times.
- Don't touch the mouse or keyboard: any click or key stops the tour. `D` restarts the silent one.

The run is real: the "Online shop checkout" sample through the local converter. The spoken
numbers (4 / 2 / 3, 44%) are that sample's actual result.

## Voice

- **Character:** calm, articulate copilot. Warm, quietly confident, a little dry. Never salesy.
  Mid-low register, clear consonants, a slight smile in the voice.
- **Model:** Eleven v3, so the audio tags below work. With Multilingual v2, drop the tags
  and follow the "Direction" column.
- **Settings (start here):** Stability 45 %, Similarity 75 %, Style 25 %, Speaker boost on,
  Speed 1.0. Raise stability if lines vary too much between takes.
- **New take:** export it as one file, play it 15 % faster without changing pitch, and cut it at the pauses between lines (the long pauses; the `[short pause]` tags stay inside a line).

## Script

| # | Start | Ends | Length | On screen | Line (with v3 audio tags) | Direction |
|---|---|---|---|---|---|---|
| 1 | 0:00.6 | 0:05.5 | 4.9 s | Start screen; the dot wakes up | `[warmly] Hi, I'm Jarvis. [short pause] Let's move your Datadog setup to Dash0.` | Friendly opener, relaxed. Small lift on "Dash0". |
| 2 | 0:06.0 | 0:10.4 | 4.4 s | Jarvis picks the "Online shop checkout" sample | `We'll start with this online shop: [short pause] a checkout dashboard and its alert.` | Matter-of-fact, guiding. Light stress on "checkout dashboard". |
| 3 | 0:11.6 | 0:17.8 | 6.2 s | Convert; the dial turns (read → translate → check) | `[confident] Now every query is translated by fixed rules. [short pause] No guessing: the same input always gives the same result.` | The key message. Slower, deliberate. Firm stop after "No guessing". |
| 4 | 0:20.0 | 0:26.3 | 6.3 s | Results board; the outcome summary is marked | `Done. [short pause] Four widgets moved one to one, two need a quick review, and three are blocked.` | Satisfied "Done.", then a clear, even list. No drama on "blocked". |
| 5 | 0:26.8 | 0:32.1 | 5.3 s | The blocked "Checkout error rate" row opens and is highlighted | `This one is blocked: its error metric has no mapping yet. [reassuring] Here's exactly what to add.` | Calm and helpful, like pointing at a screen. Lift on "exactly". |
| 6 | 0:32.9 | 0:40.4 | 7.5 s | In the open blocked item, the "Ask AI" button is marked twice (never clicked) | `[curious] Stuck? [short pause] Ask AI drafts a suggestion for any blocked item. [reassuring] You review it, nothing is applied automatically.` | "Stuck?" light, almost a smile. Middle sentence even and clear. Last part calm and trustworthy, slightly slower. |
| 7 | 0:42.2 | 0:44.9 | 2.7 s | "Your dashboards are ready." headline appears | `[proudly] And that's it. [pause] Your dashboards are ready.` | The payoff. Slow, a little proud, let it breathe. |
| 8 | 0:46.0 | 0:52.1 | 6.1 s | "What moved": donut at 44 % | `Forty-four percent moved one to one. [short pause] Everything else is clearly marked. [short pause] Nothing is hidden.` | Honest, steady. Slight emphasis on "Nothing is hidden". |
| 9 | 0:53.0 | 0:58.9 | 5.9 s | "All set." end view; the dot goes quiet | `Download your files, fix the three flagged items, then publish. [warmly] I'm right here if you need me.` | First half practical, second half warm and softer, trailing off. |

The dot settles into its passive state at 0:59.2; the video ends at 1:00.0.

### Plain text (copy into ElevenLabs line by line)

```
1  Hi, I'm Jarvis. Let's move your Datadog setup to Dash0.
2  We'll start with this online shop: a checkout dashboard and its alert.
3  Now every query is translated by fixed rules. No guessing: the same input always gives the same result.
4  Done. Four widgets moved one to one, two need a quick review, and three are blocked.
5  This one is blocked: its error metric has no mapping yet. Here's exactly what to add.
6  Stuck? Ask AI drafts a suggestion for any blocked item. You review it, nothing is applied automatically.
7  And that's it. Your dashboards are ready.
8  Forty-four percent moved one to one. Everything else is clearly marked. Nothing is hidden.
9  Download your files, fix the three flagged items, then publish. I'm right here if you need me.
```

## Outside the recording

- **On entry** the live agent asks whether you want a tour (on the first click or key press,
  because browsers block sound before that). "Yes" starts the tour, "no" leaves Jarvis passive
  until you click the dot. Setup: `preview/AGENT_SETUP.md`.
- **The tour** plays the recorded take (`preview/voice/`) and can't be interrupted. After the
  last line the live agent takes over and answers questions.
- **Start tour** (header) starts the tour directly.
