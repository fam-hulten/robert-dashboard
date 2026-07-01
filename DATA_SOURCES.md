# Dashboard Data Sources

Robert Loop Health Dashboard — live at `http://192.168.1.193:3090/`

## Panel → Data Source

| Panel | Source |
|-------|--------|
| **Cron Jobs** | `openclaw cron list --json` — live from OpenClaw gateway API |
| **Failure Patterns (30d)** | `workspace/code-standards/failure-mode-log.md` |
| **Progression Signals** | `workspace/metrics/loop-metrics.md` |
| **Session Metrics** | `workspace/metrics/loop-metrics.md` |
| **Convergence Rate** | `workspace/metrics/loop-metrics.md` + `code-standards/failure-mode-log.md` |
| **Johanna's Plan Gate** | `workspace/metrics/planning-gate-metrics.md` |
| **Recent Failure Entries** | `workspace/code-standards/failure-mode-log.md` |

## Refresh

- **Cron Jobs:** Live via `openclaw cron list --json` every 30s
- **All other panels:** Static files on disk, refreshed on client poll (30s)

The data in files only changes when something writes to them — not in real time.

## Cron Jobs That Update Source Files

| Cron Job | Updates |
|----------|---------|
| `planning-gate-log` | `metrics/planning-gate-metrics.md` |
| `failure-pattern-analysis` | `code-standards/failure-mode-log.md` |

## Workspace Path

Dashboard reads from `/workspace` (mounted from `~/.openclaw/workspace/` on the host).

## Adding a New Panel

1. Add a data-fetching function in `server.js` (see `getConvergenceRate()` as template)
2. Add to the `Promise.all()` in `async function fetchData()`
3. Add a `<div id="panel-id">` in the HTML grid
4. Add a render function and call it from `render(d)`
