# translate/alerts

Task **T6** · scope `src/translate/alerts/**` · Datadog monitors (IR `Alert`) → Dash0 check rules (`PrometheusAlertRule`).

```ts
import { translateMonitor } from "../query/index.js";   // T4, PR #3
import { translateAlert } from "./index.js";
const out = translateAlert(alert, { translateMonitor: (mq, t) => translateMonitor(mq, t, ctx), tag: tagLookup(mappings) });
// out.rule: CheckRule | null   out.status, out.rules, out.assumptions, out.epsilon, out.findings, out.channels
```

Every rule applied is a row in the rule catalog (`src/rules/catalog/alert.ts`, `docs/rules.md`): classify → parse →
options → thresholds → monitor query (T4) → labels → message → defaults. Each monitor option is a rule or a finding,
never dropped. Output: id `dd-monitor-<id>`, `expression … > $__threshold`, `{failed, degraded}`, `interval 1m`,
`for 0s`, `enabled: false` (D-30), labels sorted, annotations `{description, summary}`.
