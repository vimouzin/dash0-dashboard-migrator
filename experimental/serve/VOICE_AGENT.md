# Voice narrator (ElevenLabs) for `dd2dash0 serve`

The narrator **explains a finished, deterministic run**. It never translates anything: every number it says comes from `report.json` through its tools. That keeps the migrator inside the brief's "no LLM in translation" rule.

## 1. Create the agent (ElevenLabs dashboard → Agents → New agent)
- **First message:** `I'm your migration narrator. I'll talk you through the Datadog to Dash0 run; interrupt me any time.`
- **LLM:** a low-latency model, e.g. a Flash or Haiku-class model.
- **Security:** keep authentication **enabled**. `dd2dash0 serve` mints a short-lived conversation token server-side, so the API key never reaches the browser.
- **System prompt:**

```
You narrate a live migration of Datadog dashboards and monitors into Dash0, done by a deterministic compiler
(parsers, rule tables and mapping tables, no AI in the translation). You are the explainer, not the translator.

Messages that start with [EVENT] come from the system, not the user: say one short sentence (max 20 words)
about it, in plain English, then stop. Contextual updates are background; do not read them out.

When the user asks a question, call get_summary or get_item_details first and answer only from what they
return. Never invent numbers or claim more accuracy than the report shows. Statuses: exact = same numbers as
Datadog for any data; exact-under = same numbers while the listed assumptions hold; bounded = within a stated
error bound; manual = not translated, original kept; unsupported = Dash0 has no equivalent widget.
When asked how to close a gap, say what the finding code means and the realistic options (add a mapping-table
row, write and test a new translation rule, or rebuild by hand), and say which ones need a person.
Keep answers under 4 sentences unless asked for detail.
```

- **Client tools** (Tools → Add tool → Client, with "Wait for response" turned **on**; names are case-sensitive):
  - `get_summary`: no parameters. Returns coverage, counts by status, the biggest gaps and the items not migrated.
  - `get_item_details`: one string parameter `query` (an item id or part of a title). Returns the Datadog query, the PromQL, the status, why, and the manual follow-ups.

## 2. Run
```bash
npx tsx src/cli.ts migrate --from datadog --input fixtures/datadog --dry-run --out out
ELEVENLABS_AGENT_ID=<agent id> ELEVENLABS_API_KEY=<key> npx tsx src/cli.ts serve --out out
```
Open http://127.0.0.1:4317 and click **Start voice**. Use `localhost` or `127.0.0.1`: browsers allow the microphone only there or over HTTPS. **Replay** restarts the run. `--pace <ms>` sets the speed.

How it behaves:
- Every event goes to the agent as silent context (`sendContextualUpdate`).
- Milestones (a dashboard finished, a widget that can't be migrated, the final verdict) become `[EVENT] …` messages (`sendUserMessage`). These are throttled to one every 6 s, and none is sent while the agent is speaking.
- You can interrupt at any time and ask, e.g. "why is the high-memory alert only bounded?" or "what's the biggest gap and how do we close it?"
