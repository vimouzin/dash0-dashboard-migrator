# Datadog fixtures

These are copied from [DataDog/integrations-core](https://github.com/DataDog/integrations-core) at commit `a9b9e42b7e48` (BSD-3-Clause license, © Datadog, Inc.). The file name is `<integration>__<original name>`.

| File | Why it's here |
|---|---|
| `dashboards/postgres__postgresql_dashboard.json` | 9 timeseries, formulas only. **First vertical slice.** |
| `dashboards/postgres__postgresql_screenboard_dashboard.json` | toplist, query_table, groups |
| `dashboards/redisdb__overview.json` | query_value, groups, `$scope`/`$host` vars, `diff()`, `top()` |
| `dashboards/nginx__NGINX-Overview_dashboard.json` | old `q` requests, `.as_count()`, unsupported widgets (hostmap, check_status, event_stream, log_stream) |
| `monitors/redisdb__high_mem.json` | `100 * a / b > 90`: arithmetic. **First alert.** |
| `monitors/postgres__percent_usage_connections.json` | plain threshold over `last_15m` |
| `monitors/*replication_delay*`, `nginx__5xx`, `upstream_latency`, `conn_dropped` | `anomalies(...)`: the migrator must flag these, or map them to Dash0 `thresholds.baseline` |

Monitors use the asset wrapper `{version, definition:{...}}`; unwrap `.definition` to get the API shape. To add more, drop API exports (`GET /api/v1/dashboard/{id}`) here as well.
