# Shared agent rules

## Highest priority: deterministic conversion

**User-authorized exception (Felix, 2026-11-08):** the local UI may send a failed
(`blocked`) widget or monitor to Agent0 only after the user explicitly clicks Ask AI
for that item. Limit this to three recommendation calls per local backend session;
then prompt the user to contact sales at sandy@dash0.com. Recommendations are separate,
unverified drafts: never run automatically, change compiler outcomes/artifacts,
approve mappings, or publish them. This narrow exception supersedes the blanket AI
prohibition below only for this user-requested recommendation endpoint. All automatic
conversion and CLI paths retain every deterministic, LLM-free rule below.

**Deterministic conversion is of utmost importance and comes before every other project objective, including MVP speed, feature coverage, and demo polish. No LLM shall be involved in translation from any source to Perses.** This also applies to query translation into PromQL and alert translation into Dash0 check rules.

The entire conversion path must use explicit parsers, reviewed mapping tables, deterministic rules, and schema validation. No local or hosted model, model-based mapping inference, agent call, optional AI mode, repair step, or LLM fallback may participate. Unsupported or ambiguous input must produce a diagnostic and be blocked from automatic conversion; never ask a model to fill the gap. With the same input, mapping, configuration, and compiler version, conversion must produce the same target artifacts and diagnostics.

Codex and Claude may help develop code and tests. They must not translate migration inputs or generate target assets as a step in the migration workflow. Reduce scope before compromising this requirement.

These rules apply to all contributors and coding agents, including **Codex and Claude**. This is the canonical project instruction file. Keep shared rules here; tool-specific entry files must refer here instead of maintaining competing copies. Explicit user instructions take precedence over project defaults.

## Read first

1. This file.
2. `docs/handoff/README.md`, the open work list and decisions. Then `docs/handoff/00-context.md` (the shared spec) and the plan you're taking, if any.
3. The GitHub issue you're working on, including its comments, then `docs/STATUS.md` for the overall state.

Read existing code before changing it. The handoff describes planned behavior; source code, executable checks, and recorded live evidence establish what works today.

## Objective and scope

- Ship the smallest working Datadog → Dash0 migration: one dashboard, one metric monitor, deterministic translation, report, and actual destination import.
- Time is limited. Finish the vertical slice before adding more query functions, widget types, or vendors.
- Business work is handled separately. Do not spend implementation time on market research, pricing, ROI models, pitch decks, branding exercises, or a marketing website.
- Do not build a frontend, database, job queue, plugin framework, Kubernetes deployment, or cloud infrastructure for the MVP.
- Codex and Claude are development tools. No LLM involvement is permitted anywhere in the conversion workflow, even as an optional dependency or fallback.

## Implementation rules

- Use neutral names such as `source`, `parser`, `compiler`, `mapping`, `destination`, and `report`. Avoid agent-specific modules or permanently assigning a subsystem to a tool.
- Prefer one package, pure translation functions, explicit data types, and a small number of modules.
- Manage the Python runtime and all requirements with uv only: `uv sync` (interpreter from `.python-version`, uv-managed only; dependencies from `uv.lock`), `uv run <cmd>`, `uv add [--group dev] <pkg>`. Don't use pip, `python -m venv`, requirements files, or a system Python. Commit `uv.lock` and `.python-version` together with `pyproject.toml` changes.
- Select the source vendor through the single `SourceProvider` interface and static provider table (`--source datadog`); see `src/migrator/source/provider.py` and decision D1 in `docs/handoff/00-context.md`. Each provider owns its source-specific parsing, mapping, and translation; a vendor-neutral intermediate model is not required. Keep shared CLI, report, manifest, validation, and destination code free of source-specific logic. The static table is not a plugin framework: no dynamic loading, discovery, or config-driven registration.
- Keep network I/O out of the parser/compiler. Offline compilation must work without credentials.
- Parse the documented query subset completely. Never translate a recognized prefix and ignore trailing syntax. Regex may tokenize a bounded grammar; chained string replacements are not a semantic parser.
- Unknown metric types, units, label mappings, options, or functions require a diagnostic. Do not infer telemetry equivalence from similar names or replace dots with underscores as a migration strategy.
- Anything that converts without being an exact translation goes through an approved remark tag (`approximated` or `assumed`, [docs/REMARKS.md](docs/REMARKS.md)). Each new reason is a new tag in `src/migrator/source/datadog/remarks.py` and needs manual approval; only a human sets `approved`. Unmappable metrics are recorded under `gaps` in their mapping file with a tag and reason.
- Preserve original source assets and source locations. Report each omitted widget, query, and behavior. An alert with unsupported semantics is blocked from import.
- Separate syntax/schema validation, API acceptance, and observed semantic validation in the report. None proves the others.
- Keep output deterministic, with stable asset ordering and repeatable names. Isolate timestamps and API responses from compilation snapshots.
- Validate actual Dash0 request bodies against official documentation and a known-good export. Do not invent a schema, endpoint, plugin identifier, or response ID path.
- Keep patches focused. Do not refactor unrelated work or add stretch features while a P0 milestone is unfinished.

## Working together

- Both Codex and Claude may work in this repository. Before editing, inspect the worktree, the issue's assignee and comments, and open PRs.
- Use task-based ownership through issues (below). Avoid simultaneous edits to shared contracts, package manifests, lockfiles, and the same source files.
- Do not overwrite, discard, stash, reset, or clean another contributor's changes. Coordinate in the issue when ownership overlaps.
- Agree on interface changes in the issue before making dependent edits. Update the handoff and consumers together when a contract changes.
- Parallel agent work is used only when explicitly requested. `docs/handoff/README.md` says how to run it (waves, file ownership, merge order); reading it does not itself authorize spawning agents.
- At handoff, comment on the issue with completed work, exact checks and results, remaining blockers, and the next concrete task (template in `docs/STATUS.md`). Update `docs/STATUS.md` itself only when the overall state changes, such as a plan finishing or a blocker resolving. Record facts, not assumed completion.

## Tracking work in GitHub issues

From now on, every task is tracked as a GitHub issue in `XNotAGuestX/thinchackdash`, and agents and people communicate through those issues.

- **Open work is already filed.** Each task in `docs/handoff/README.md` has one issue, labelled `task` and `wave:N` (plus `hotspot:converter` when it must merge one at a time), and attached as a sub-issue of its `epic`. Decisions and blockers have issues labelled `decision` or `blocker`; `horizon` marks tracked but unscheduled work. Dependencies are set as native "blocked by" links and listed in each issue body.
- **Project board:** [thinchack-Dash0](https://github.com/users/XNotAGuestX/projects/3) holds every issue, with the fields Status, Priority, Size, Track, Plan and Phase. Keep Status current: `Backlog` (dependencies open) → `Ready` → `In progress` (when claimed) → `In review` (PR open) → `Done` (merged). Add new issues to the board and set their fields.
- **New work gets an issue first.** Open it with the **Task** form (`.github/ISSUE_TEMPLATE/task.yml`) before writing code. Agents using `gh issue create` must use the same section headings: Summary, Context, Plan reference, Parallel group, Tasks, Acceptance criteria, Verify, Out of scope, Stop and ask, Dependencies, Files, Definition of Done.
- **Write tickets well.** One issue fits one branch and one PR; split anything bigger. The summary states the outcome and why it matters. Acceptance criteria are specific to the issue and pass or fail on observable evidence: a named test, an exact output, an exit code. The Definition of Done below is shared by all task issues and isn't repeated as acceptance criteria. Write for an agent with no chat context: the issue names the files it may change, the commands that verify it, and when to stop and ask.
- **Claim before starting.** Assign the issue (an agent assigns the person it works for) and comment the branch name. One driver per issue. Don't start an issue whose dependencies are open unless its body says how to work around them, for example with mocks.
- **Talk in the issue.** Questions, decisions, blockers, interface changes, review requests and handoffs are comments on the issue they concern; refer to other issues by number. A decision that lives only in chat or local notes doesn't count. Use the labels `blocked`, `needs:review` (the reviewer sets `reviewed` in mapping files), `needs:approval` (live writes and upstream pushes need Felix's go-ahead, linked in the issue), and `needs:B1`/`B2`/`B3`.
- **Close through the PR.** The PR says `Closes #<n>` and shows the evidence for each acceptance criterion. An issue closes only when its acceptance criteria and the Definition of Done are met. File follow-ups as new issues instead of reopening scope.

### Definition of Done (every task issue)

- Every acceptance criterion is met, with evidence (test names, commands and their real output) in the PR or a closing comment.
- `uv run migrator check` passes (ruff, mypy --strict, pytest); new behaviour has focused tests.
- Conversion stays deterministic and LLM-free; no timestamps, absolute paths or environment data in artifacts.
- Changed goldens and expected trees are regenerated in the same commit, and the PR explains the diff.
- No secrets, raw live responses or run artifacts committed.
- Docs touched by the change are updated (README, the open work list in `docs/handoff/README.md`, `docs/STATUS.md` when the overall state changes).
- Work is on its own branch; the PR says `Closes #<this issue>`; follow-ups are filed as new issues.
- Reviewed by XNotAGuestX (a PR approval, or Felix's explicit go-ahead when the PR comes from his own account).
- Merged into `main` by Felix or an agent acting for him.

## Branches and merging

- By default every agent works on its own branch, one per issue, created from current `main` and named `<issue-number>-<short-slug>` (for example `17-query-parser`). Push it and open a PR to `main`.
- **XNotAGuestX (Felix) is the required reviewer on every PR and every task issue.** `.github/CODEOWNERS` requests the review automatically on PRs from other accounts. GitHub doesn't let an account approve its own PR, so for a PR opened from Felix's account, his explicit go-ahead (a PR comment, or his instruction in the agent session) counts as the review.
- **Merging into `main`:** Felix, or an agent acting for Felix, merges a PR once it is reviewed as above and its checks pass. Other contributors and their agents never merge. Without the review, an agent merges only when Felix explicitly forces that specific merge.
- Do not commit directly to `main`. Never force-push or rewrite `main`'s history, and stop to report conflicts or failing checks instead of resolving them by discarding changes.
- Submission to the challenge follows the fork → feature branch → upstream PR workflow (`docs/handoff/README.md`, "Submission"), only on Felix's explicit request. Do not push or open a PR upstream merely because this document describes submission.

## Credentials and live operations

- Read credentials from environment variables; keep `.env`, private exports, raw live responses, and run artifacts out of Git.
- Never print keys, tokens, authorization headers, or full environment dumps. Redact sensitive response content in reports.
- `compile` is offline and read-only with respect to vendors. `fetch` reads selected source assets. Only an explicit `import` command writes to the selected Dash0 dataset.
- Use a demo dataset and demo-prefixed names. Default imported checks to disabled; enable the specific demo check only as part of an explicitly requested live verification.
- Do not modify or delete source assets. Do not overwrite destination assets by name. Use recorded destination IDs only for an explicit, documented update flow after the MVP.
- Do not blindly retry a creation request after an ambiguous timeout; reconcile the result before creating again.
- Do not repeatedly request permission for ordinary local implementation and tests already requested by the user. Creating this handoff does not authorize live account changes or sending messages to others.

## Verification and completion

- Add focused behavioral tests for translation semantics, unsupported constructs, schemas, and import failure handling. Use synthetic or sanitized fixtures.
- Run the relevant tests and type checks for the change. Once they pass, move on unless a new issue warrants more checking.
- Never claim a live migration from mocks or a screenshot of generated JSON. Record returned IDs and read-back/UI evidence.
- Never describe an API-accepted empty dashboard as a successful functional migration. Demonstrate data and a check condition, or clearly record missing runtime evidence.
- If access is blocked, keep completing offline work and record the blocker. Do not mark the end-to-end milestone complete.
- Report what changed, what was checked, limitations, and the next step briefly. Do not invent test results.
