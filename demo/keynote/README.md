# Migration keynote demo

Self-contained, black-and-white demo of a finished Datadog → Dash0 migration. Open `index.html` in Chrome; no build step, no backend. All numbers are example data.

Two modes, switched at the top:

- **Demo**: a keynote that plays scene by scene (migration complete, key facts, migration board with "Book with an expert", a short tour of the dashboard, a PayPal alert fixed by the agent).
- **Dashboard**: the same window, clickable. The overview has two entry tiles, *Open migrations* (kanban of 262 migrated, 26 with changes, 12 not migrated) and *Alerts* (check rules, tricky ones in red, "Simulate incident", "Fix by agent").

| Key | Action |
| --- | --- |
| `Space` | Play or pause the demo |
| `←` / `→` | Previous or next scene |
| `H` | Hide the controls (for screen recording) |
| `C` | Toggle captions |
| `Esc` | Close a panel or show the controls again |

Files:

- `index.html`: the demo.
- `migration-demo.mp4`: an earlier recording (1920×1080, 61 s) with the ElevenLabs voiceover. It shows the previous dashboard layout with sidebar and live tiles.
- `voice.m4a`: the voiceover from that recording, pauses shortened to 58.9 s.
