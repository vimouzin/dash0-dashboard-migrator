# Migration Review Console

A browser-only tool for reviewing a Datadog-to-Dash0 migration. It reads the `report.json` written by the migration CLI. It shows an overview, a dashboard map, an items list and a review queue, and exports your decisions as `review.json`.

There is no backend, no login, no AI and no network calls. Translation is done by the CLI (it must be deterministic); this app only displays and reviews the result.

## Run it

Needs Node 22+. Bun runs through npx, no global install needed.

```sh
cd console
npx bun install
npx bun run dev      # prints the address, usually http://localhost:8080 (Vite uses the next free port if 8080 is taken)
npx bun run test
npx bun run build
```

The lockfile is `bun.lock`. Plain `npm install` is not tested here; use Bun through npx.

## What you see when you open it

A fresh clone opens on the bundled **sample data** (`src/data/report.sample.json`), with a banner. The sample is a prediction written by hand, not tool output. Do not treat its numbers as results.

To see a real report:

- **Button:** **Load report.json** (bottom of the left sidebar) loads a file from your disk.
- **Public folder:** if `public/report.json` exists, the app loads it automatically on start and hides the sample banner. This is how a run's report loads without clicking. Do not commit this file.
- **Real report example:** a real CLI report (a dry run on the Redis dashboard and the `high_mem` monitor) is kept as a test fixture at `src/test/fixtures/cli-report.redis.json`. You can load it with the button.

## How to get a real report.json

From the fork's root (not from `console/`):

```sh
npm install
npx tsx src/cli.ts migrate --from datadog --input fixtures/datadog --dry-run --out out
```

What the CLI's own `--help` says about it: `--input <dir>` is a folder of exported Datadog JSON; `--dry-run` translates and writes the Dash0 payloads and imports nothing; `--out <dir>` (default `./out`) receives `report.json`, `report.md`, `events.jsonl` and `dash0/`. The CLI prints the report's path when it finishes. `fixtures/datadog` is the bundled set of Datadog exports (a Redis, two Postgres and an NGINX dashboard, plus six monitors). I ran this without a `.env` file and it needs none; `npx tsx src/cli.ts --help` lists every option.

Then either copy `out/report.json` to `console/public/report.json`, or use the **Load report.json** button.

## What the files contain

**report.json** (input, from the CLI, schema `dd2dash0.report/v1`): `run`, `summary`, `findings` and a list of `items` (dashboard panels and monitors). Each item has its source queries, the translated PromQL, a status (`exact-under`, `bounded`, `manual` or `unsupported`), reason codes, layout and check results. All parsing and field names live in `src/lib/report.ts`. The exact field names the console reads are listed in `INTEGRATION.md` section 3.1.

**review.json** (output, exported from the Review page): `schema_version`, `report_sha256` (SHA-256 of the exact report text you loaded), `reviewer`, and `decisions`, a list of `{ id, decision, note }` where decision is `approved`, `flagged` or `acknowledged`. Decisions are also kept in your browser's localStorage, keyed by the same hash, so they never carry across reports.

## More

- `INTEGRATION.md`: the data contract, what the console cannot show yet, and the task list.
- `AGENTS.md`: the project's rules for anyone, human or agent, changing the code.
- Planned CLI changes (a richer report, a review gate): CONTRACT-003 in PR #28 of the fork (draft, not built).

## Lovable

A Lovable project exists as Henry's personal sandbox only. It is not part of the team's workflow and nothing here syncs with it. All work happens in the fork, on a branch, through a PR.
