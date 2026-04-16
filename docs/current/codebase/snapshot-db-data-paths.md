# Snapshot DB Data Paths

How snapshot data flows through the system — from Amplitude fetch to Bayes compiler. Written to prevent repeated code-tracing of the same territory.

## DB Schema

Table `snapshots` — one row per observation:
- `param_id`: workspace-prefixed (e.g. `nous-conversion-feature/bayes-test-graph-landing-to-created`)
- `core_hash`: SHA-256-based signature identifying the query (connection, events, filters, cohort_mode, latency)
- `slice_key`: e.g. `window()`, `cohort()`, `context(channel:paid-search).window(-100d:)`
- `anchor_day`: the cohort date (date type)
- `retrieved_at`: when the fetch happened (timestamp)
- `a`: anchor entrants (cohort denominator), `x`: from-node entrants (window denominator), `y`: to-node conversions
- `median_lag_days`, `mean_lag_days`, `anchor_median_lag_days`, `anchor_mean_lag_days`, `onset_delta_days`

Table `signature_registry` — maps structured signatures to core hashes.

## Hash Mappings (`hash-mappings.json` in data repo)

When graph structure changes (event definition, filter, latency_parameter toggle), the core_hash changes. The hash-mappings file links old hashes to new ones via `equivalent_to` entries. The query functions accept `equivalent_hashes` to expand the hash family, so historical data under old hashes is still found.

## Two Read Paths

### 1. Virtual Snapshot (`query_virtual_snapshot`)

**Used by**: FE analysis derivations (cohort maturity, daily conversions, etc.)

Returns ONE row per `(anchor_day, slice_key)` — the **latest** row as-of a given `as_at` timestamp. "Latest wins" — older retrievals are superseded by newer ones. This gives a single cross-sectional picture: "what does the data look like right now?"

**asat() evidence reconstruction** (doc 42): when `asat(date)` is in
the DSL, `getParameterFromFile` in `fileToGraphSync.ts` calls
`querySnapshotsVirtual` with `as_at = asat_date` to reconstruct the
daily arrays (n_daily, k_daily, dates) as they would have appeared at
the asat date. The reconstructed arrays replace the file-cached arrays
in memory, then flow through the normal aggregation pipeline (evidence
scalars, topo pass, blended rate). If no snapshot rows exist for the
asat date, falls back to truncating file-cached arrays by anchor date
(approximation — cohorts appear too mature). The `getFromSourceDirect`
path delegates to `getParameterFromFile` for asat queries.

### 2. Sweep Query (`query_snapshots_for_sweep`)

**Used by**: Bayes compiler (via `worker._query_snapshot_subjects`)

Returns ALL raw rows where `anchor_day` is in range AND `retrieved_at` is in the sweep window. No deduplication — every historical retrieval is returned. This gives the full maturation history: for each anchor_day, you see how y grew over successive retrieval dates.

### Key Implication

The Bayes compiler sees a **much denser** dataset than the FE analysis path for the same edge. An anchor_day with 27 nightly fetches gives 27 rows to the compiler but only 1 row to the FE. The compiler uses all 27 to build a maturation trajectory (CDF fitting). The FE uses only the latest.

## Write Path (Nightly Fetch)

Each nightly fetch:
1. Queries Amplitude for each edge's from→to conversion within the current window
2. Amplitude returns one result per anchor_day in the window
3. Each result is written as one DB row with `retrieved_at = now`

The **window width** depends on the edge:
- No latency: narrow window (last 1-2 days)
- With latency: wider window (covers t95 + margin, typically 15-30 days)

So each fetch writes:
- Non-latency edges: ~2 rows (2 anchor days in narrow window)
- Latency edges: ~17-20 rows (anchor days in the active maturation window)

Over time, each anchor_day accumulates one row per nightly fetch during the period it's in the active window. After it matures past the window, no more observations.

## Synth Data Generator (`synth_gen.py`)

Writes the **full triangular matrix**: every anchor_day × every fetch night. With 100 days and 95% fetch success rate, each anchor_day has ~94 rows. This is much denser than production data (5-27 rows per anchor_day) because:
- Production windows are selective (only active maturation window)
- Synth gen writes all anchor_days on every fetch night

The Bayes evidence binder builds trajectories from these rows. More rows per trajectory = more CDF evaluation points per trajectory = more computation per gradient step (but same statistical information, just finer-grained intervals).

## Evidence Binder (`compiler/evidence.py`)

`_bind_from_snapshot_rows` groups rows by `(obs_type, anchor_day)`:
- `_is_cohort(slice_key)` classifies by slice_key
- Deduplicates by `retrieved_at` within each anchor_day
- `len(deduped) >= 2` → CohortDailyTrajectory (multi-point maturation curve)
- `len(deduped) == 1` → CohortDailyObs (single observation, fallback)

Window obs: denominator = max(x) (fixed for anchor_day), y = cumulative conversions
Cohort obs: denominator = max(a) (fixed for anchor_day), y = cumulative conversions,
  cumulative_x = per-age from-node arrivals (growing — upstream latency)

### Window vs Cohort semantics in trajectories

**Window** trajectory for edge from→to, anchor_day d:
- Cohort = people who arrived at **from_node** on day d
- x is FIXED (count who arrived that day — doesn't change with retrieval age)
- y(t) grows as those people convert over time
- CDF is edge-level: P(convert by age t | reached from_node)

**Cohort** trajectory for edge from→to, anchor_day d:
- Cohort = people who entered **anchor** on day d
- a is FIXED (anchor entrants)
- x(t) GROWS as upstream arrivals accumulate (people reaching from_node)
- y(t) GROWS as conversions accumulate
- CDF is path-level: P(reach to_node by age t | entered anchor)
- x(t) directly observes the upstream CDF: x(t)/a ≈ p_upstream × CDF_upstream(t)

For join nodes, x(t) is the TOTAL arrivals from ALL incoming edges
to the from-node (sum across all paths into that node).

### Redundant-frame filtering

Trajectory ages where NEITHER x nor y changed are dropped — they
contribute zero information to the likelihood. This is critical for
synth data (94 ages → 2-21 after filtering) and harmless for production
data (5-27 ages, most have changes).

## Model Builder (`compiler/model.py`)

Trajectories → `pm.Potential` with Dirichlet-Multinomial interval logp:
- Each trajectory's retrieval ages are decomposed into consecutive intervals
- Each interval: count = y[t] - y[t-1], CDF coefficient = CDF(t) - CDF(t-1)
- DM ensures overdispersion is captured via κ parameter
- Total information is the same regardless of interval granularity (thin vs fat intervals produce identical posteriors, just different computational cost)

Daily fallback → `pm.BetaBinomial` per-day observations (when trajectory has only 1 point).
