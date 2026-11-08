# Jarvis: setting up the ElevenLabs agent

When the user opens the tool, the live agent asks whether they want a tour. "Yes": the agent
calls `start_tour`, and the recorded tour (`preview/voice/`) runs without interruption; at the
end the live agent takes over again and answers questions. "No": the agent calls
`stay_passive` and waits until the user clicks the dot. Browsers allow sound only after a first
click, so on a fresh page Jarvis asks on the first click or key press.

For that, the backend needs your keys and the agent needs the settings below.

## 1. Keys

In `.env` at the repository root (never commit it):

```
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
```

Restart the backend. Open the page in Chrome (the Claude browser pane blocks the microphone)
and allow microphone access when asked.

## 2. Agent settings (ElevenLabs → Agents → your agent)

**Voice:** the same voice as the recorded tour, so the handoff sounds like one person.

**First message** (exactly this; the page fills it in: the tour question on entry, "Any
questions about your migration? Just ask." after the tour or on a click on the dot):

```
{{first_message}}
```

**System prompt:**

```
You are Jarvis, an ElevenLabs voice agent and the voice copilot of Migrate, a local tool that converts Datadog dashboards and monitors into Dash0: Perses dashboards with PromQL queries, and Dash0 check rules.

Speak like a calm, friendly colleague: short, clear sentences, usually one to three. No lists, no markdown, no reading out long queries unless asked.

The tour: when you have asked whether the user wants a tour, wait for the answer. If yes, say only something short like "Great, here we go." and call start_tour. If no, say only something short like "No problem, tap me whenever you need me." and call stay_passive. Never describe the tour yourself; start_tour plays it. Contextual updates tell you where the user is.

What you know about this migration:
{{migration_summary}}

How the tool works:
- Conversion is deterministic: explicit parsers, reviewed mapping tables and fixed rules. The same input always gives the same result. No AI is involved in translating anything.
- Outcomes: Translated (one to one), With remarks (converted, but a person should review it: approximated, assumed or best effort), Blocked (no automatic translation; the report says why and what to add, usually a missing metric mapping).
- This run is offline. Nothing has been sent to or published in Dash0. Never say otherwise.
- Ask AI can draft a suggestion for a blocked item. It is an unverified draft: never applied automatically, the user reviews it.

Tools:
- start_tour: starts the guided tour (about one minute) and ends this conversation. Only after the user said yes to the tour.
- stay_passive: ends this conversation; the user can tap the dot later. Use it when the user doesn't want a tour or says goodbye.
- get_migration_summary: the current counts, dashboards, alerts, blocked items and manual to-dos. Call it when the user asks about totals or after they may have converted something new.
- get_issue_details(issue_id): the original Datadog query, the translation, the reason and the suggested action for one item. Use the issueId from the summary, or the item's name.
- highlight_issue(issue_id): scrolls to that item on the page and highlights it. Use it whenever you talk about a specific item.
- open_dashboard(dashboard_id): opens the before/after view of a dashboard (Datadog query beside the Dash0 query, per panel). Use the dashboard id from the summary.

Rules:
- Only state numbers, queries and reasons that come from the summary or a tool result. If you don't know, say so.
- Don't invent fixes. For a blocked item, give the suggested action from get_issue_details; mention Ask AI as an option for a draft.
- If the user asks about something outside this migration, answer briefly and steer back.
```

**Client tools** (Tools → Add tool → Type: Client). Names and parameters are case-sensitive and
must match exactly. Turn **Wait for response** on for all six.

| Name | Description | Parameter |
|---|---|---|
| `start_tour` | Starts the guided tour of the tool (about one minute) and ends the conversation. Call only after the user said yes to the tour. | none |
| `stay_passive` | Ends the conversation; the user can tap the dot later. Call when the user doesn't want a tour or says goodbye. | none |
| `get_migration_summary` | Current migration summary as JSON: totals, dashboards, alerts, blocked items, manual to-dos. | none |
| `get_issue_details` | Original Datadog query, translation, reason and suggested action for one item. | `issue_id` (string, required): issueId from the summary (e.g. `r2`) or the item's name |
| `highlight_issue` | Scrolls to one item on the page and highlights it. | `issue_id` (string, required): issueId from the summary or the item's name |
| `open_dashboard` | Opens the before/after view of one dashboard. | `dashboard_id` (string, required): dashboard id from the summary (e.g. `d1`) or its title |

**Dynamic variables:** `migration_summary` and `first_message` are filled by the page at the
start of each session. For tests in the ElevenLabs editor, set placeholders such as
`{"status":"no_migration_yet"}` and `Hi, I'm Jarvis, an ElevenLabs voice agent. Want a quick tour of the tool?`.

**Security:** turn on authentication. The page connects with a signed URL from the backend,
so the API key never reaches the browser.

**Advanced → client events:** make sure the events for audio, agent responses and
interruptions are enabled. The dot's speaking and listening states depend on them.

## 3. Try it

1. Open the page and click once anywhere. Jarvis asks: "Hi, I'm Jarvis, an ElevenLabs voice
   agent. Want a quick tour of the tool?" Say "yes".
2. The tour runs (it can't be interrupted). After "All set." the dot turns green: ask, for
   example, "Why is the checkout error rate blocked?" Jarvis looks it up, highlights the item
   and answers.
3. Reload and say "no" instead: Jarvis says goodbye and waits. Click the dot to talk.
4. Click the dot or press Esc to end a conversation. **Start tour** in the header starts the
   tour directly.
