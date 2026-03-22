# Snapshot Field Semantics: Window vs Cohort

**Created**: 22-Mar-26
**Context**: Hard-won during synthetic data generator development. Documents the exact
meaning of each snapshot DB field depending on `slice_key` type, and how these fields
flow through the analytics pipeline.

---

## 1. The Two Populations

For a query `from(X).to(Y)` with anchor node A, a single snapshot row describes
one `(anchor_day, retrieved_at)` observation. The **slice_key** determines which
population the row describes.

### Window rows (`slice_key` contains `window(`)

The "cohort" is **people who reached the from-node (X) on anchor_day**.

| Field | Meaning |
|-------|---------|
| `anchor_day` | The calendar day people arrived at **X** (the from-node). Mixes people from different anchor-entry days — anyone who reached X on this date, regardless of when they entered at A. |
| `X` | Count of people who arrived at X on this anchor_day |
| `Y` | Count of those X-arrivals who also reached Y by `retrieved_at` |
| `A` | NULL (not used in window mode) |
| `median_lag_days` | Median of (Y_arrival - X_arrival) for converters — **edge-level** lag |
| `mean_lag_days` | Mean of the same — **edge-level** lag |
| `anchor_median_lag_days` | NULL (not applicable in window mode) |
| `anchor_mean_lag_days` | NULL |
| `onset_delta_days` | Alpha-quantile of the X→Y lag histogram. Represents earliest plausible conversion time for this edge. |

**Rate**: `Y/X` → approaches `p_edge` at maturity.

**CDF model**: Edge-level lognormal with `(onset, mu, sigma)` derived from the lag stats.

### Cohort rows (`slice_key` contains `cohort(`)

The "cohort" is **people who entered at the anchor node (A) on anchor_day**.

| Field | Meaning |
|-------|---------|
| `anchor_day` | The calendar day people entered at **A** (the anchor/start node). |
| `X` | Count of people from this anchor-day cohort who reached X (the from-node) by `retrieved_at`. Grows over time as upstream latency delivers people. |
| `Y` | Count of people from this anchor-day cohort who reached Y by `retrieved_at` (via X→Y specifically). |
| `A` | Total anchor entrants on this day — fixed cohort size. |
| `median_lag_days` | Median of (Y_arrival - X_arrival) for converters — **edge-level** lag (same as window). |
| `mean_lag_days` | Mean of the same — **edge-level** lag. |
| `anchor_median_lag_days` | Median of (X_arrival - A_arrival) — **upstream path** lag from anchor to from-node. **NOT** anchor to to-node. |
| `anchor_mean_lag_days` | Mean of the same — **upstream path** lag. |
| `onset_delta_days` | Same as window — edge-level onset from the X→Y lag histogram. |

**Rate**: `Y/X` → approaches `p_edge` at maturity (same as window).

**But**: `Y/A` → approaches `p_path = product(p_edge for all edges A→...→X→Y)`.

**CDF model**: Path-level lognormal composed via Fenton-Wilkinson from all edge latencies along the path.

---

## 2. Critical: `anchor_median_lag_days` is A→X, NOT A→Y

This is the single most important semantic distinction. Amplitude's 3-step funnel
(A→X→Y) returns:

- **`median_lag_days`**: X→Y transition time (the edge being measured)
- **`anchor_median_lag_days`**: A→X transition time (upstream path only)

The stats pass (`enhanceGraphLatencies`) uses `anchor_median_lag_days` to derive
the path-level lognormal CDF for cohort mode:

1. Subtracts accumulated upstream onset from `anchor_median_lag_days`
2. Fits lognormal to the onset-free upstream stochastic lag
3. Combines with this edge's lognormal via Fenton-Wilkinson
4. Uses the composed (path_mu, path_sigma, path_onset) for the cohort model curve

If `anchor_median_lag_days` measured A→Y instead of A→X, the edge's latency would
be double-counted — once in the anchor lag, once added by FW composition.

---

## 3. What Writes What

### Amplitude nightly fetch writes to DB:
- `A`, `X`, `Y` — raw counts
- `median_lag_days`, `mean_lag_days` — from Amplitude histogram (edge-level)
- `anchor_median_lag_days`, `anchor_mean_lag_days` — from Amplitude (A→X, cohort only)
- `onset_delta_days` — FE-derived from lag histogram alpha-quantile

### Amplitude nightly fetch writes to parameter file `values[]`:
Same as above, but as **per-day arrays** (one value per date in the window):
- `n_daily` (alias for X per day), `k_daily` (alias for Y per day)
- `median_lag_days: [...]`, `mean_lag_days: [...]` — per-day lists
- `anchor_median_lag_days: [...]`, `anchor_mean_lag_days: [...]` — per-day lists (cohort only)
- `anchor_n_daily: [...]` — per-day anchor entrant count (cohort only)
- `latency: { onset_delta_days: <scalar> }` — nested, from histogram

### FE stats pass (`enhanceGraphLatencies`) writes to graph edge:
- `p.latency.mu`, `p.latency.sigma` — fitted lognormal from evidence
- `p.latency.onset_delta_days` — aggregated from window slices
- `p.latency.t95`, `p.latency.path_t95` — computed from mu/sigma
- `p.latency.path_mu`, `p.latency.path_sigma`, `p.latency.path_onset_delta_days` — FW-composed
- `p.latency.median_lag_days`, `p.latency.mean_lag_days` — aggregated
- `p.latency.completeness` — data quality metric
- `p.mean` (blended), `p.evidence`, `p.forecast.mean` — probability estimates

### The synth_gen should write:
- DB rows + param files: same as Amplitude (items 1 & 2 above)
- Graph edge: **structural only** — `p.id`, `p.latency.latency_parameter`, `p.latency.anchor_node_id`, `p.cohort_anchor_event_id`, `edge.query`
- Everything in item 3 is derived by the FE after "fetch from cache"

---

## 4. Burn-in Requirement

Synthetic data simulation must start `max(path_t95)` days before the observable
window so that from-node arrival counts on day 1 of the window are realistic.
Without burn-in, window rows for deep edges show near-zero `X` counts because
the upstream pipeline hasn't delivered anyone yet.

The burn-in period simulates person journeys but does NOT emit observation rows.
People who enter during burn-in CAN appear in the observable window's window
rows if their from-node arrival falls within the window dates.

---

## 5. Window Observation Generation

Window rows group by **from-node arrival day**, which mixes people from different
simulation (anchor entry) days. This requires a two-phase approach:

1. **Simulation phase**: Run all days (burn-in + observable). Record each person's
   arrival time at every node.

2. **Window index construction**: For each edge, iterate ALL simulated people
   across ALL days. Compute the absolute calendar day they arrived at the
   from-node. Group by that day. Record the time offset from from-node arrival
   to to-node arrival (if they converted).

3. **Observation emission**: For each nightly fetch, for each from-node arrival
   day in the observable window, count how many people's conversion offsets
   fall within the retrieval age.

This is fundamentally different from cohort observation generation, which simply
iterates by simulation day (= anchor entry day).
