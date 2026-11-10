# experimental/ (parked, not part of dd2dash0)

These parts are **not wired into the CLI** and are excluded from `tsc` (`rootDir: src`) and from the test suite
(`vitest.config.ts`). They were moved here, not deleted, to keep the product to one simple flow
(`dd2dash0` with no arguments; spec: dash0-team `.plans/simple-cli-flow-spec.md`). Bring any of them back with a PR.

| Here | Was | What it is | Owner |
|---|---|---|---|
| `console/` | `console/` | the web review console (Bun app with its own package.json and tests) | Henry |
| `serve/server.ts`, `serve/viewer.ts`, `serve/VOICE_AGENT.md` | `src/serve/` | `dd2dash0 serve`: live run viewer + ElevenLabs voice narrator | Amir / Henry |
| `serve/review.ts` | `src/serve/review.ts` | `dd2dash0 review` without `--terminal`: serves a plan to the console and saves its review.json | Michael |
| `tests/serve.test.ts`, `tests/review-server.test.ts` | `tests/cli/` | their tests | |

Imports in `serve/` point at `../../src/...`, so to re-wire a piece: move it back under `src/`, restore the
`../` imports, add its command to `src/cli.ts`, and move its test back under `tests/`.
