# CLI: Param Pack

Produce a param pack for a graph from the command line — the same
edge probabilities, evidence, forecast, and latency values that the
browser computes when a user selects a window or cohort in the
WindowSelector.

## Prerequisites

- Node 22+ (via nvm, resolved from `graph-editor/.nvmrc`)
- Data repo cloned (path in `.private-repos.conf`)
- **Python BE running** (`python dev-server.py` on localhost:9000, or
  set `PYTHON_API_URL` for a remote instance). The BE runs the forecast
  engine (doc 29) for engine-computed completeness, blended rates, and
  uncertainty. Without it, param-pack falls back to FE-only values.
- Parameter files populated by prior browser fetches or retrieveAll
  (the CLI reads cached data from disk by default)
- For live Amplitude fetching: `.env.amplitude.local` at the repo
  root with `AMPLITUDE_API_KEY` and `AMPLITUDE_SECRET_KEY` (credentials
  are auto-loaded by the CLI — no manual env setup needed)

## Quick start

```bash
# From the dagnet root:

# Full param pack as YAML
bash graph-ops/scripts/param-pack.sh my-graph "window(1-Dec-25:20-Dec-25)"

# JSON format
bash graph-ops/scripts/param-pack.sh my-graph "window(-30d:)" --format json

# Cohort mode
bash graph-ops/scripts/param-pack.sh my-graph "cohort(8-Jan-26:7-Apr-26)"

# Single value
bash graph-ops/scripts/param-pack.sh my-graph "window(-30d:)" \
  --get "e.edge-a-to-edge-b.p.mean"
```

Replace `my-graph` with the graph filename (without `.json`) from the
`graphs/` directory in the data repo.

## Output

**stdout** receives the param pack data (YAML, JSON, or CSV).
**stderr** receives `[cli]` prefixed diagnostics (loading progress,
warnings, edge counts).

To suppress diagnostics:

```bash
bash graph-ops/scripts/param-pack.sh my-graph "window(-30d:)" --format json 2>/dev/null
```

To capture into a variable:

```bash
val=$(bash graph-ops/scripts/param-pack.sh my-graph "window(-30d:)" \
  --get "e.my-edge.p.latency.completeness" 2>/dev/null)
echo "Completeness: $val"
```

## Options

| Flag | Purpose |
|------|---------|
| `--format yaml\|json\|csv` | Output format (default: yaml) |
| `--get <key>` | Extract a single scalar value. Outputs bare number/string to stdout. On bad key, lists available keys for the referenced edge and exits 1. |
| `--show-signatures` | Diagnostic: show computed hash signatures per edge |
| `--verbose` / `-v` | Show all internal debug logging (LAG pass, aggregation, etc.) |
| `--session-log` | Show session log output |
| `--allow-external-fetch` | Allow fetching from Amplitude if cached data is stale or missing. Without this flag, the CLI uses cached parameter files only. Credentials are auto-loaded from `.env.amplitude.local`. |
| `--no-be` | Suppress every BE-bound call in the run (offline equivalence on demand). For `param-pack` the only BE call today is conditioned forecast (CF), so `--no-be` is functionally `--no-cf` for this command — `p.mean` and `p.stdev` reflect FE-topo Step 2 provisional values rather than BE-authoritative ones. The pack output carries `be_skipped: true` in metadata so downstream consumers can tell the two apart (doc 73e §8.3 Stage 6). |

## Query DSL

The `--query` argument accepts the same DSL the browser uses:

- `window(1-Dec-25:20-Dec-25)` — absolute window
- `window(-30d:)` — relative window (last 30 days)
- `cohort(8-Jan-26:7-Apr-26)` — cohort mode with date range
- `context(channel:google).window(-30d:)` — context-filtered window
  (context filtering not yet fully wired — uses all values currently)
- `window(-30d:).asat(15-Jan-26)` — historical view: evidence filtered
  to snapshots retrieved on or before the asat date (doc 42). Data comes
  from the snapshot DB, not from Amplitude. Read-only — no file writes.
- `at(15-Jan-26)` — sugar for `asat(15-Jan-26)`

Trailing dots are tolerated (e.g. `"cohort(8-Jan-26:7-Apr-26)."` works).

## Param pack keys

Keys follow HRN (Human-Readable Notation) with dot-separated paths:

```
e.<edge-id>.p.mean                      # Blended probability
e.<edge-id>.p.stdev                     # Standard deviation
e.<edge-id>.p.evidence.mean             # Observed conversion rate (k/n)
e.<edge-id>.p.evidence.stdev            # Binomial std dev
e.<edge-id>.p.evidence.n                # Sample size
e.<edge-id>.p.evidence.k                # Conversions
e.<edge-id>.p.forecast.mean             # Mature-day baseline forecast
e.<edge-id>.p.latency.completeness      # Maturity fraction (0–1)
e.<edge-id>.p.latency.completeness_stdev # Completeness uncertainty (from engine)
e.<edge-id>.p.latency.t95              # 95th percentile lag (edge-local)
e.<edge-id>.p.latency.path_t95         # Cumulative lag from anchor
e.<edge-id>.p.latency.median_lag_days  # Median conversion lag
```

## What the CLI computes

The CLI runs the same computation the browser runs:

1. Loads parameter files from disk (daily arrays: `n_daily`, `k_daily`,
   `dates`)
2. Filters to the requested date range
3. Computes evidence scalars (n, k, mean = k/n, stdev)
4. Runs the FE topo pass (evidence aggregation, lag fitting, promoted
   latency fields)
5. Calls the **BE conditioned-forecast pass** (forecast engine — doc 29):
   - Engine-computed completeness with uncertainty (completeness_stdev)
   - Conditioned blended rate (p.mean) incorporating latency maturity
   - Composed rate uncertainty (p.stdev) from probability + completeness

CF overwrites the FE blended `p.mean` / completeness with its conditioned
values when it lands. If the Python BE is unreachable, a warning is
logged and FE topo values are used (degraded — no completeness
uncertainty, no conditioned blending).

**Requires the Python BE running** (`python dev-server.py` on
localhost:9000, or set `PYTHON_API_URL`).

## Troubleshooting

**"no window() or cohort() clause found"** — the query DSL must
contain a `window()` or `cohort()` clause for aggregation to run.
Without one, the CLI returns graph-as-saved values.

**Edges with no data** — edges without a parameter file (complement
edges, manual-probability edges) will show only their static `p.mean`
value with no evidence or latency.

**Stale parameter files** — the CLI reads whatever data is on disk.
If parameter files haven't been updated recently (via browser fetch
or retrieveAll), the evidence will reflect old data. Run a fetch in
the browser first to populate fresh data.
