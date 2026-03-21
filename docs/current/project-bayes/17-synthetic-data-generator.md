# Doc 17: Synthetic Data Generator — Detailed Design

**Status**: Phase 1 implemented (21-Mar-26)
**Date**: 21-Mar-26
**Purpose**: General-purpose Monte Carlo data generator that produces
synthetic snapshot trajectory data matching the real snapshot DB format,
for parameter recovery testing of the Bayes compiler.

---

## 1. Why This Exists

We cannot distinguish between three failure modes without synthetic data:

1. **Model geometry problem** — parameterisation creates difficult NUTS
   geometry
2. **Data quality problem** — real snapshot data has holes, pathological
   shapes, or violated assumptions
3. **Wiring problem** — evidence binding misroutes data, trajectory
   construction drops observations, CDF coupling uses wrong latency

A synthetic data generator with known ground-truth parameters is the
only way to calibrate the model independently of data quality. But the
generator itself must be rigorously validated — using an uncalibrated
instrument to calibrate another instrument is worthless.

---

## 2. What the Real Snapshot System Does

Understanding this precisely is a prerequisite. The generator must
simulate this system, not an idealised version of it.

### 2.1 Daily fetch cycle

The daily fetch runs (typically nightly) for graphs with
`dailyFetch: true`. Each run:

1. Queries the data source (Amplitude) for the graph's configured date
   range
2. For each edge × slice_key combination, receives daily data:
   one row per anchor_day with counts (X, Y, A) and lag statistics
3. Calls `append_snapshots()` with:
   - `retrieved_at` = current timestamp (when this fetch ran)
   - `rows` = list of `{anchor_day, X, Y, A, ...}` — one per cohort
     day returned by the query

**Key**: the fetch is **incremental and staleness-driven**. It does
NOT re-fetch all historical anchor_days every night. The fetch set is
dynamically computed as `F = Missing ∪ Stale`:

- **Missing (M)**: gaps in cache header coverage between the DSL's
  start and end dates.
- **Stale (S)**: anchor_days within the **maturity horizon**
  (`effective_t95`) of the reference date. These are immature cohort
  days whose conversion counts are still growing — they need
  re-fetching to capture newly arrived conversions.

Mature cohort days (older than `effective_t95`) are NOT re-fetched —
their data is stable. This means each anchor_day accumulates
retrieval-age observations only while it's within the maturity window.

Source: `fetchPlanBuilderService.ts` lines 517–678 (`computeStaleDates`,
`calculateIncrementalFetch`, and the final `F = M ∪ S` merge).

**Implication for generator**: the generator's fetch model should
re-observe anchor_days only while they're within `t95` of the current
simulation night. However, **over-fetching is harmless** — the
evidence binder deduplicates by `retrieved_at`, so producing more
observations than the real system would is safe. The binder keeps
each unique `(anchor_day, retrieved_at)` pair and builds the
trajectory from the sequence.

### 2.2 DB storage model

Each row in `snapshot_entries` has:

```
param_id, core_hash, slice_key, anchor_day, retrieved_at,
A, X, Y,
median_lag_days, mean_lag_days,
anchor_median_lag_days, anchor_mean_lag_days,
onset_delta_days
```

UNIQUE constraint: `(param_id, core_hash, slice_key, anchor_day,
retrieved_at)`.

**Critical**: `retrieved_at` is part of the unique key. Multiple
fetches on different days for the same anchor_day produce multiple
rows — one per fetch run. This is how trajectories are built: the Y
count for a given anchor_day grows across successive `retrieved_at`
timestamps as more conversions arrive.

### 2.3 Core hash and branch isolation

Synthetic data uses the **real core hashes** for each edge's window
and cohort queries — the same hashes listed in the test harness edge
configs. No `SYNTH-` prefix. Branch isolation in the data repo
(dedicated test branch) provides separation from production data.

This means the FE can inspect synthetic data natively — cohort
maturity views, conversion analysis, snapshot manager all work
normally because the hashes match. Hash mappings handle equivalence
where needed.

The generator receives the core hashes as input (from the test harness
edge config or from the truth config sidecar).

### 2.3 Query path

`query_snapshots_for_sweep()` returns all rows matching:
- `core_hash` (with equivalence expansion)
- `anchor_day` in [anchor_from, anchor_to]
- `retrieved_at` date in [sweep_from, sweep_to]

Ordered by `anchor_day, slice_key, retrieved_at`.

**Sweep semantics**: `sweep_from = anchor_from`, `sweep_to = today`
(or asat date). This returns ALL historical fetch runs within the
date range.

### 2.4 Evidence binding consumption

`_bind_from_snapshot_rows` in evidence.py:
1. Groups rows by (obs_type, anchor_day) — slice_key determines
   window vs cohort (via regex: `cohort(` → cohort, else → window)
2. Deduplicates by `retrieved_at` within each anchor_day
3. Denominator: `max(x)` for window, `max(a)` for cohort
4. Retrieval age: `(retrieved_at - anchor_day).days`
5. Monotonises Y values (y = max(y, prev_y))
6. If ≥2 retrieval ages: builds `CohortDailyTrajectory`
7. If 1 retrieval age: builds `CohortDailyObs` (single observation)

### 2.5 What the generator must simulate

The generator must produce rows in the exact format above. But it's
not enough to get the format right — the **statistical properties**
of the data must match reality, or the model will fit trivially on
unrealistically clean data.

---

## 3. Noise Model

### 3.1 Daily overdispersion (κ-generating process)

Real conversion rates vary day-to-day. Sources: marketing mix,
seasonality, operational changes, cohort composition. The model's
per-edge κ parameter captures this.

**Generator model**: for each cohort day d, draw an effective
probability for each edge:

```
p_effective(d, edge) ~ Beta(p_true × κ_sim, (1 - p_true) × κ_sim)
```

where `κ_sim` is the simulation's overdispersion parameter per edge.
Large κ_sim → near-constant p (Binomial-like). Small κ_sim → heavy
daily variation (Beta-Binomial-like).

The model should recover κ_sim ≈ κ_posterior. If the generator doesn't
inject overdispersion, κ will be estimated as very large (trivially
Binomial), which doesn't test the overdispersion machinery.

**Truth config specification**: per-edge `kappa_sim` value. Sensible
defaults: κ_sim = 5-20 (moderate overdispersion matching the range
we observed on real data: 1.5 to 23.7).

### 3.2 Denominator variation

Real daily traffic isn't constant. The number of people entering the
funnel varies.

**Generator model**:

```
n_people(d) ~ Poisson(mean_daily_traffic)
```

Or for more realistic variation:

```
n_people(d) ~ NegBinomial(mean_daily_traffic, r)
```

where r controls overdispersion in arrivals (weekday/weekend effects,
campaigns, etc.).

### 3.3 Fetch failure rate

Some nights the cron fails. The generator must simulate this.

**Generator model**: for each simulated fetch night, independently
drop the fetch with probability `failure_rate` (e.g. 0.05).

A failed fetch means NO rows are stored for that `retrieved_at` —
all anchor_days that would have been observed that night are missing
that retrieval age.

### 3.4 Latency noise

**Open question**: should each day's latency parameters (mu, sigma)
also vary? In reality, the latency distribution is probably more
stable than p (it's driven by operational processes, not traffic mix).
For now, keep latency parameters fixed across days. If needed, add
per-day latency jitter later.

### 3.5 Random-walk drift on p

Models slow trends in conversion probability over the simulation
period. Real funnels drift due to product changes, marketing mix
shifts, seasonality, and operational changes.

**Generator model**: per-edge random walk on the logit scale:

```
logit_offset(d) = Σ_{i=1..d} ε_i,   ε_i ~ Normal(0, drift_sigma)
p_drifted(d) = logistic(logit(p_true) + logit_offset(d))
```

The logit-scale walk keeps p in (0, 1) without clamping. With
`drift_sigma = 0.02–0.03`, a 100-day simulation sees ±5–15% relative
change in p — enough to exercise the model's recency weighting without
making the data unrealistically non-stationary.

**Interaction with overdispersion**: drift and overdispersion compose
naturally. Drift sets the day's baseline `p_drifted`; overdispersion
then draws `p_effective ~ Beta(p_drifted × κ, (1 - p_drifted) × κ)`.
The model's per-edge κ captures both sources of day-to-day variation.

**Truth config**: `simulation.drift_sigma` (default: 0.0 = off).
CLI: `--drift 0.03`.

**When to use**: parameter recovery tests should run with drift=0
first (clean recovery), then with moderate drift to verify the model's
recency weighting correctly down-weights old observations.

---

## 4. Fetch Simulation Model

### 4.1 What gets fetched each night

The real system computes `F = Missing ∪ Stale` dynamically. For
the generator, two simplifications are possible:

**Realistic mode**: simulate the staleness logic. Each night, only
re-fetch anchor_days within `effective_t95` of the current night.
Mature cohort days stop accumulating observations. This produces the
realistic retrieval-age pattern: immature cohorts get ~1 observation
per night until they mature; mature cohorts have a fixed number of
retrieval ages.

**Simple mode**: fetch ALL active anchor_days every night (triangular
pattern). Over-fetches compared to reality, but the evidence binder's
deduplication-by-retrieved_at makes this harmless. Simpler to
implement, produces the same model inputs after binding.

The generator should default to **simple mode** (over-fetch is safe)
but support realistic mode for testing edge cases around sparse
retrieval-age coverage.

### 4.2 Retrieval age structure

For a given anchor_day d and fetch night t, the retrieval age is
`t - d` days (approximately — exact value depends on timestamps).

Under **Model A** (full lookback), anchor_day d gets observations at
ages: 1, 2, 3, ..., (N_days - d). Old cohorts have many retrieval
ages; recent cohorts have few.

Under **Model B** (rolling window with lookback L), anchor_day d gets
observations at ages: 1, 2, ..., min(L, N_days - d). After L days,
the cohort falls out of the window and stops accumulating.

### 4.3 Simulated fetch output

For each successful fetch night t:
- `retrieved_at` = base_date + t days (midnight UTC)
- For each anchor_day d in the fetch window:
  - For each edge × obs_type:
    - Retrieval age = t - d
    - Count arrivals from cohort d that occurred by this age
    - Produce one row: `{anchor_day=d, retrieved_at=t, X=..., Y=...,
      A=...}`

### 4.4 Row counts

Under Model A with N=100 days and 10 edges × 2 obs_types:
- Total rows = 100×101/2 × 10 × 2 = ~101,000
- This is the "many hundreds of DB snapshots" the generator produces

---

## 5. Simulation Algorithm

### 5.1 Person-level simulation (one-time)

For each cohort day d = 1..N_days:

1. Draw `n_people(d)` from Poisson(mean_daily_traffic)
2. For each edge, draw `p_effective(d, edge)` from
   Beta(p_true × κ_sim, (1 - p_true) × κ_sim)
3. For each person i = 1..n_people(d):
   - Traverse the DAG from anchor node
   - At each branch group: Multinomial draw using the day's effective
     p values for evented siblings, with dropout = 1 - sum(evented p)
   - At each solo edge: Bernoulli draw using the day's effective p
   - For each edge taken: draw latency from
     ShiftedLognormal(onset, mu, sigma)
   - Record `{node_id: t_arrival}` for every node reached

Result: `arrivals[d][i] = {node_id: t_arrival, ...}`

### 5.2 Observation generation (per fetch night)

For each simulated fetch night t = 1..N_days:

1. If `random() < failure_rate`: skip (fetch failed)
2. For each anchor_day d in fetch window:
   - `retrieval_age = t - d`
   - If retrieval_age < 1: skip (cohort hasn't started yet)
   - For each edge (from_node → to_node):

     **Window row** (slice_key = "window()"):
     - `x` = count of people from day d who arrived at from_node by
       age `retrieval_age`
     - `y` = count who arrived at to_node by age `retrieval_age`
     - Only emit if x > 0

     **Cohort row** (slice_key = "cohort()"):
     - `a` = n_people(d) (everyone entered anchor at time 0)
     - `y` = count who arrived at to_node by age `retrieval_age`

3. Store all rows with `retrieved_at = base_date + t`

### 5.3 File params generation (cold start)

For testing the cold-start scenario (model fitting with param-file
evidence only, before any snapshots exist), the generator should also
produce param-file-format `values[]` entries:

- Aggregate n, k across all cohort days at the maximum retrieval age
- `median_lag_days`, `mean_lag_days` computed from the actual arrival
  time distributions
- This tests the `bind_evidence` (non-snapshot) path

---

## 6. Ground Truth Config

Sidecar YAML file: `{graph-name}.truth.yaml`

```yaml
simulation:
  mean_daily_traffic: 5000
  n_days: 100
  failure_rate: 0.0          # Level 0: no failures
  fetch_mode: simple         # simple (all anchor_days) | realistic (t95 staleness)
  seed: 42
  base_date: "2025-11-01"   # first cohort day
  kappa_sim_default: 50      # Level 0: mild overdispersion

# Per-edge ground-truth parameters
# core_hashes from test harness edge configs (FE-visible, no SYNTH prefix)
edges:
  household-delegation-rate:
    edge_id: "3d0a0757-8224-4cf0-a841-4ad17cd48d91"
    window_hash: "r0AMpAJ_uExLojzFQhI3BQ"
    cohort_hash: "QqoOJonqx8zzialfD5jKlQ"
    p: 0.5385
    onset: 0.0
    mu: 1.0
    sigma: 0.5
    kappa_sim: 50

  delegated-to-coffee:
    edge_id: "64f4529c-62b8-4e7e-8479-c5289d925e58"
    window_hash: "cFSR9ljHVYv9oAxijnyEWg"
    cohort_hash: "kpDI95Ogtg6Rstx-jFpGCQ"
    p: 0.3330
    onset: 0.0
    mu: 0.7
    sigma: 0.5

  delegation-straight-to-energy-rec:
    edge_id: "8c23ea34-9c7e-40b3-ade3-291590774bfc"
    window_hash: "EtC-FhDURPFuAvbZmc_DcA"
    cohort_hash: "4Rfk9gYwK_27k2po2zOxzA"
    p: 0.3946
    onset: 0.0
    mu: 1.5
    sigma: 0.7

  # ... etc — edges not listed use graph metadata + kappa_sim_default
```

Each edge entry includes the real `window_hash` and `cohort_hash`
from the test harness config. These are the core hashes the FE
computes from the edge's DSL query signature, so synthetic data is
FE-visible without any special plumbing.

---

## 7. Validation Strategy

The generator itself must be rigorously tested before it can be used
to test the model.

### 7.1 Statistical validation (Monte Carlo vs analytic)

For a simple A→B edge with known p=0.4, onset=0, mu=1.0, sigma=0.5:

- **p recovery**: across N_days × n_people draws, the fraction taking
  the edge should be within expected CI of p_true (accounting for
  overdispersion from κ_sim)
- **CDF shape**: at each retrieval age t, the fraction
  `y(t) / (n × p_true)` should match `CDF_LN(t, mu, sigma)` within
  statistical bounds
- **Overdispersion**: the day-to-day variance of `y/n` should be
  consistent with Beta-Binomial(n, p×κ, (1-p)×κ)
- **Fetch failure**: the number of missing retrieval ages should match
  `failure_rate × N_days` within binomial CI

### 7.2 Structural validation

- **Branch group mutual exclusivity**: no person takes multiple
  siblings of the same branch group
- **DAG consistency**: no person arrives at a node before arriving at
  all upstream nodes on their path
- **Monotonicity**: for a given anchor_day, Y is non-decreasing across
  retrieval ages
- **Denominator consistency**: window `x` ≤ anchor `a` for same edge
  and retrieval age
- **Join node counts**: people arriving at a join node = sum of people
  arriving via each inbound edge (no double-counting, no leakage)

### 7.3 Round-trip validation

1. Generate synthetic data
2. Write to DB
3. Query back via `query_snapshots_for_sweep`
4. Bind via `bind_snapshot_evidence`
5. Verify: trajectories have expected number of retrieval ages,
   correct denominators, monotonic Y values, correct obs_type
   classification

### 7.4 Cold-start validation

1. Generate param-file-format values[] entries
2. Bind via `bind_evidence` (non-snapshot path)
3. Verify: EdgeEvidence has correct n, k, window/cohort flags

---

## 8. Resolved Questions

1. **Fetch date range model** — RESOLVED. The fetch set is dynamically
   computed as `F = Missing ∪ Stale`. Stale dates = anchor_days within
   `effective_t95` of the reference date (immature cohorts whose counts
   are still growing). Mature cohort days are not re-fetched. However,
   over-fetching is harmless (binder deduplicates by retrieved_at), so
   the generator can simplify to "one observation per night per active
   anchor_day" without breaking anything.

2. **Lag statistics** — RESOLVED. `median_lag_days` and `mean_lag_days`
   in snapshot rows are **never read** by the evidence binder
   (`_bind_from_snapshot_rows` and `_build_trajectories_for_obs_type`
   only extract anchor_day, retrieved_at, x, a, y). Latency priors
   come from the topology analyser reading the graph edge's p-block
   (median_lag_days, mean_lag_days there, not from snapshot rows).
   The generator can set lag columns to None.

## 9. Remaining Open Questions

1. **Graph integrity checks**: what validation exists in the data repo
   for graph artefacts? The generator must use these if creating new
   test graphs. Need to understand the tooling before creating any new
   topologies.

---

## 10. Context Slices (Phase 2)

### 10.1 How contexts work in snapshot data

**Core hash is per-edge, NOT per-context-value.** All context values
for the same edge share the same `core_hash`. The `slice_key` field
differentiates them:

```
slice_key = "window()"                                    # aggregate
slice_key = "context(channel:google).window(...)"         # sliced
slice_key = "context(channel:direct).cohort(...)"         # sliced
slice_key = "context(channel:google).context(device:mobile).window(...)"  # compound
```

Source: `querySignature.ts` lines 237-242 — context VALUES are stripped
from the signature hash; only context DEFINITIONS affect the hash.

### 10.2 How the FE constructs context-sliced subjects

The FE's `useBayesTrigger` calls `explodeDSL()` which expands bare
context dimensions into per-value slices:

```
Input:  "context(channel).window(-90d:)"
Output: ["context(channel:google).window(-90d:)",
         "context(channel:direct).window(-90d:)",
         "context(channel:email).window(-90d:)"]
```

Each exploded slice becomes a separate `slice_key` in the snapshot
subject. All share the same `core_hash` and `param_id`.

### 10.3 How the evidence binder handles slices

`_bind_from_snapshot_rows` groups rows by `(anchor_day)` across all
slice_keys. For the Phase S path, all slice_keys are merged.

Phase C's `_route_slices()` then partitions observations:
1. Extracts `context_key` from each slice_dsl (strips temporal
   qualifiers)
2. Groups by dimension: `"channel"`, `"channel×device"`
3. Builds `SliceGroup` per dimension with:
   - `is_mece`: True for `context()`, False for `visited()`
   - `slices`: dict of `context_key → SliceObservations`
   - `residual`: un-sliced remainder for partial MECE

### 10.4 What the generator must produce for context slices

For each edge × context combination:
- **Same core_hash** as the uncontexted version
- **Different slice_key** per context value:
  `context(channel:google).window()`,
  `context(channel:google).cohort()`
- **Different X, Y, A counts** reflecting the context's traffic share
  and potentially different conversion rates

**Context-specific simulation**:
1. Each simulated person is assigned a context vector
   (e.g., `{channel: "google", device: "mobile"}`) drawn from the
   context weight distribution in the truth config
2. Edge parameters (p, mu, sigma) are overridden per context where
   specified in the truth config
3. Observations are generated per context slice AND aggregate:
   - Aggregate rows: slice_key = `"window()"` / `"cohort()"`
   - Sliced rows: slice_key = `"context(channel:google).window()"` etc.
4. MECE invariant: `Σ n_slice ≈ n_aggregate` across all values of a
   dimension

### 10.5 Context definition artefacts

For FE visibility, each context dimension needs a YAML file in the
data repo:

```yaml
# contexts/channel.yaml
id: channel
name: Channel
type: categorical
values:
  - id: google
    label: Google
  - id: direct
    label: Direct
  - id: email
    label: Email
metadata:
  status: active
```

The context's values determine what `explodeDSL()` expands to. The
generator's truth config must list the same values.

### 10.6 Truth config for contexts

```yaml
contexts:
  channel:
    values:
      google:  { weight: 0.60 }
      direct:  { weight: 0.30 }
      email:   { weight: 0.10 }
    edge_overrides:
      delegated-to-coffee:
        google: { p: 0.40 }   # higher p for google traffic
        email:  { p: 0.15 }   # lower p for email
      # edges not listed use the base p from edges section
```

---

## 11. FE Visibility Requirements

### 11.1 Artefact set per test graph

For the FE to display synthetic data natively, each test graph needs
a complete artefact set in the data repo:

| Artefact | Path | Required for |
|----------|------|-------------|
| Graph JSON | `graphs/{name}.json` | Topology, edge structure, DSL |
| Node YAMLs | `nodes/{name}.yaml` | Event references, context refs |
| Event YAMLs | `events/{name}.yaml` | Event definitions (hashed into core_hash!) |
| Param YAMLs | `parameters/{name}.yaml` | Priors, values[], latency block |
| Context YAMLs | `contexts/{name}.yaml` | Context dimensions (Phase C) |
| Nodes index | `nodes-index.yaml` | Node registry |
| Params index | `parameters-index.yaml` | Param file lookup |

All must pass the data repo's integrity checks.

### 11.2 Core hash computation

The FE computes `core_hash` from a canonical signature that includes:
- Connection name
- Event IDs (not node IDs — normalised)
- Event definition hashes (SHA-256 of normalised YAML)
- Normalised query (DSL with node IDs replaced by event IDs,
  context/window/cohort arguments stripped)
- Cohort mode, latency parameter flag

**Algorithm**: JSON.stringify(canonical) → SHA-256 → take first 16
bytes → base64url encode → ~22 char string.

**For existing graphs**: hashes are already known (in test harness
edge configs). Generator uses these directly.

**For new graphs**: either let the FE compute them once (open graph,
trigger one analysis, record hashes), or replicate the computation
in Python (non-trivial but one-time per graph).

### 11.3 Simulation guard

Graphs with synthetic data need a `simulation: true` flag to prevent
the FE's fetch plan builder from querying Amplitude and overwriting
synthetic snapshots. This is a single guard clause in the fetch
planner — returns empty fetch plans for simulation graphs.

### 11.4 Param file consistency

The topology analyser reads latency priors from `edges.p.latency`
in the graph JSON (not from param files). But param files contain
`values[]` entries and `posterior` blocks that affect:
- Cold-start evidence (the `bind_evidence` non-snapshot path)
- Warm-start priors (from `posterior.alpha`, `posterior.beta`)
- FE display of baseline rates

These must be consistent with the ground truth. Options:
- **Manual**: set param file values to match truth config
- **Generated**: generator writes param file YAML from truth config
  (ensures consistency, but requires file write permissions in data
  repo)

---

## 12. Phased Delivery

**Phase 1** (now): Core generator for existing graphs.
- Person-level DAG simulation with branching + latency
- Daily overdispersion (Beta-drawn p per day per edge)
- Denominator variation (Poisson)
- Fetch failure simulation
- Nightly-fetch retrieval model (one row per anchor_day per night)
- Window + cohort observation generation
- DB write using real core hashes (branch isolation, FE-visible)
- Comprehensive generator tests (§7.1–7.3)
- Parameter recovery test on existing branch graph
- `simulation: true` guard in FE fetch planner
- Playbook documentation

**Phase 2** (when Phase C begins): Context-slice support.
- Context assignment per simulated person
- Per-context parameter overrides from truth config
- Per-slice observation generation with correct slice_keys
- Aggregate + sliced rows (MECE invariant)
- Context YAML artefacts in data repo
- Cross-context parameter recovery validation

**Phase 3** (as needed): New test graph topologies.
- Built as proper data repo artefacts with integrity checks
- Core hashes computed via FE (or Python replica)
- Diamond graph for join isolation
- Fan-out graph for branch group isolation
- Deep cascade for multi-hop FW validation
