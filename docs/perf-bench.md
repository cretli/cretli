# Performance benchmark (`scripts/perf-bench.mjs`)

Boots `server.js` against an **isolated** data directory with a generated synthetic dataset, then measures boot time, an idle window and a synthetic request load, and prints PASS/FAIL per budget. It never reads the real `data/`: `CRETLI_DATA_DIR` and `HOME` point at a temp directory, the server binds `127.0.0.1` on a free port, and the dataset is generated (deterministic, generic content), not copied.

```
node scripts/perf-bench.mjs                       # ~10k chats, ~7k delegations, 2k todos, 60 s idle
node scripts/perf-bench.mjs --chats 500 --delegations 300 --todos 100 --idle-seconds 10 --load-seconds 5
node scripts/perf-bench.mjs --generate-only /tmp/bench-data   # write the dataset only
node scripts/perf-bench.mjs --budget boot_ms=30000,idle_elu=0.1 --keep
```

Options: `--chats --delegations --todos --idle-seconds --load-seconds --concurrency --boot-timeout-seconds --keep --budget k=v,...`. Exit code 0 = all budgets pass, 1 = a budget failed, 2 = the run itself failed.

| Budget (upper bound) | Default | Measured from |
| --- | --- | --- |
| `boot_ms` | 60000 | spawn until `/api/health` answers |
| `idle_loop_p99_ms` | 200 | 1 min server-metrics window after the idle period |
| `idle_elu` | 0.25 | same window |
| `load_latency_p99_ms` | 1000 | client-side latency of `GET /api/health` under load |
| `load_loop_p99_ms` | 500 | 1 min window after the load phase (metrics sample every 10 s, so loads shorter than 10 s may reuse the idle sample) |
| `load_error_rate` | 0.01 | failed / total requests |

A missing measurement counts as FAIL. The dataset uses the legacy JSON layout (`chats.json`, `delegations.json`, `todos/<workspace-key>.json`). Metrics come from [server-health.md](server-health.md).
