# parse

Task **T3** · scope `src/parse/**` · Datadog query string -> AST. Hand-written recursive descent: deterministic, no I/O, no LLM.

## API (`src/parse/index.ts`)

| Function | Input | Returns |
|---|---|---|
| `parseQuery(s)` | one metric query / expression: `avg:redis.mem.used{$scope} by {host}.rollup(avg,60)` | `ParseResult<Expr>` |
| `parseQueryList(s)` | legacy widget `q`, possibly comma-separated: `sum:a{*},sum:b{*}` | `ParseResult<Expr[]>` |
| `parseFormula(s)` | widget formula: `100 * query1 / (query1 + query2)` (bare identifiers are `ref`s) | `ParseResult<Expr>` |
| `parseMonitorQuery(s)` | metric/query alert: `avg(last_5m):avg:system.cpu.user{*} by {host} > 90` | `ParseResult<MonitorQuery>` |
| `formatParseError(e)` | a `ParseError` | message with a caret under the failing position |

`ParseResult<T>` is `{ ok: true, value } | { ok: false, error: { message, pos, source } }`. Never throws on bad input.
Every AST node has a `span` (`{start, end}` offsets into the source) so findings can quote the exact substring.

## What the AST covers (types in `ast.ts`)
- **Metric:** space aggregator (`avg|sum|min|max|count|pNN`, or none for the legacy form), distribution value filter `count(v: v>=0):`, metric name, scope, `by {...}`.
- **Scope:** `*`, `key:value`, bare tags, wildcards, `!`/`-` negation, `$var` / `$var.value` (names may contain `-` and `.`), `,` / `AND` / `OR` / `NOT` (any case), parentheses, `key IN (...)`, `key NOT IN (...)`.
- **Expressions:** `+ - * /` with precedence, unary `-`/`+`, parentheses, numbers, function calls with expression / `'string'` / bare-word / `name=value` / `{tag,list}` arguments, and postfix chains (`.as_count().fill(null)`).
- **Monitors:** `time_agg(window)`, `change(...)` / `pct_change(...)` with a compare window, `last_` / `current_` / `next_` windows (seconds precomputed), comparators `> >= < <= == !=`, signed threshold.

The parser is purely syntactic: function and postfix names are **not** validated here. T4 decides what each one means and emits a `manual` finding for anything it can't translate.

## Tests
- `tests/parse/ddquery.test.ts`: unit tests per construct, plus regressions from the PR #1 review.
- `tests/parse/corpus.test.ts`: parses every distinct metric query from DataDog/integrations-core (7371 today, 100%). Generate the input in the dash0-team workspace with
  `python scripts/survey_corpus.py corpus/integrations-core-master --dump-queries corpus/queries.jsonl`.
  The test finds it at `../../corpus/queries.jsonl` from a task worktree, or via `DD_QUERY_CORPUS`. It's skipped if the file is missing, so CI without the corpus still passes.
