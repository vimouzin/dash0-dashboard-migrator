# Claude project entry point

Read and follow [AGENTS.md](AGENTS.md) before planning, editing, running commands, or handing off work. **All rules in AGENTS.md apply to Claude.** It is the general, authoritative project rule file shared by Codex, Claude, and human contributors.

Follow its highest-priority rule first: deterministic conversion takes precedence over all other objectives. No LLM, including Claude or Codex, may participate in source-to-Perses translation or any query/alert conversion step, including optional fallbacks. Coding assistance is permitted; model-driven migration is prohibited.

Then read:

1. [Open work and decisions](docs/handoff/README.md), then [the shared spec](docs/handoff/00-context.md).
2. [Current status and ownership](docs/STATUS.md).

Keep shared instructions in `AGENTS.md`. Use tool-neutral code, task, and subsystem names. Respect existing work and file ownership, finish the MVP before expanding scope, track and discuss work in GitHub issues, work on your own branch (XNotAGuestX reviews every PR; Felix or his agent merges), and comment the handoff on the issue.

This file adds no separate architecture or workflow. Explicit user instructions take precedence over project defaults.
