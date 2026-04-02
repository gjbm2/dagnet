# Date Model: Cohort Maturity Pipeline

This document defines the canonical date concepts used across the cohort
maturity pipeline (FE → BE → computation → rendering). It exists because
these concepts interact subtly and past bugs have arisen from conflating
them.

---

## 1. Date Concepts

### 1.1 Anchor dates (`anchor_from`, `anchor_to`)

**What they mean:** The cohort creation date range — which cohorts to
analyse. A cohort whose creation event falls within
`[anchor_from, anchor_to]` is included.

**Set by:** The `window(start:end)` or `cohort(start:end)` clause in the
query DSL.

**Semantic role:** Membership filter. They say *which cohorts exist*, not
how far they've been observed.

**Open-ended default:** If the end date is omitted (`window(1-Jan-26:)`),
it defaults to today.

### 1.2 Sweep dates (`sweep_from`, `sweep_to`)

**What they mean:** The retrieval date range — which snapshot rows (by
their `retrieved_at` timestamp) to include when reconstructing the virtual
snapshot.

**Set by:**
- `sweep_from` = `anchor_from` (we need evidence from the earliest cohort
  onwards).
- `sweep_to` = the `.asat()` date if provided, **otherwise today**
  (`new Date()`). This is the primary source of non-determinism in live
  queries.

**Semantic role:** Evidence visibility ceiling. They gate which rows from
the snapshot DB are visible to frame construction.

**FE epoch splitting:** The FE splits the sweep range into contiguous
epochs based on per-day slice-family availability (see
`SNAPSHOT_DB_CONTEXT_EPOCHS.md`). Each epoch has its own
`sweep_from`/`sweep_to` and `slice_keys`. Gap epochs use the sentinel
`__epoch_gap__` and produce zero frames.

### 1.3 Snapshot date (`snapshot_date`, currently `as_at_date` in code)

> **Rename pending:** The field is currently called `as_at_date` throughout
> the codebase. This name is confusing because it looks like the `.asat()`
> query constraint but means something different. The canonical name going
> forward is **`snapshot_date`**. Rename the field across frames, FE
> normalisation, and BE derivation when convenient.

**What it means:** The date of a single virtual-snapshot frame — "what we
knew about these cohorts as of this date". One value per frame; all data
points within a frame share it.

**Set by:** `derive_cohort_maturity()` builds a daily grid from
`sweep_from` to `sweep_to`. For each grid day, it finds the latest
`retrieved_at` row ≤ end-of-day for each (anchor_day, slice_key) series.
The grid day becomes the frame's `snapshot_date`.

**Semantic role:** Time axis for the frame sequence. The last
`snapshot_date` in the frame list represents the most recent observation.

### 1.4 Evidence retrieved date (`evidence_retrieved_at`)

**What it means:** The date when evidence was last fetched from the
external data source (e.g. Amplitude) for a given edge.

**Set by:** Edge metadata — stored in the graph as
`edge.p.evidence.retrieved_at` (ISO datetime string). Updated by data
retrieval operations.

**Semantic role:** Evidence recency cutoff. Determines `tau_observed` per
cohort — the maximum age at which we have real observations.

**Relationship to sweep_to:** `evidence_retrieved_at` and `sweep_to` are
independent. `sweep_to` gates which rows are *visible* in the DB query;
`evidence_retrieved_at` records when those rows were *created*. In normal
operation they're close in value, but they diverge when:
- Evidence is stale (user hasn't refreshed data)
- A historical `.asat()` query is used
- A test fixture provides evidence from a different date range

### 1.5 Asat constraint (`.asat(date)` in DSL)

**What it means:** A historical snapshot constraint — "show me the
maturity curve as it existed at this date, not current".

**Set by:** User-provided `.asat(date)` clause in the query DSL.

**Semantic role:** Caps `sweep_to`. When present, `sweep_to = asat_date`
instead of today. Makes the query deterministic (same result regardless of
when it's run).

**Does NOT affect:** Anchor dates (which cohorts to analyse).

### 1.6 Today's date

**Implicit dependency.** Used as the default for:
- `sweep_to` when no `.asat()` is provided
- `anchor_to` when `window(start:)` has an open end

This makes live queries non-deterministic by design. For reproducible
results, use `.asat()`.

---

## 2. Interactions and Invariants

### 2.1 Independence of anchor dates and evidence extent

**Critical invariant:** Anchor dates determine *which cohorts exist*.
Evidence dates determine *how far those cohorts have been observed*. These
are independent axes.

A cohort born on 1-Jan with evidence retrieved on 13-Jan has
`tau_observed = 12` — regardless of whether the query anchor is
`window(1-Jan:7-Jan)` or `window(17-Feb:23-Feb)`.

### 2.2 Evidence extent determines rendering epochs, not anchor dates

The maturity chart has three rendering zones:

| Zone | Condition | Rendering |
|------|-----------|-----------|
| **A (fully observed)** | tau ≤ min(`tau_observed`) across cohorts | Solid evidence line, fan collapsed |
| **B (partially observed)** | min(`tau_observed`) < tau ≤ max(`tau_observed`) | Midpoint + opening fan |
| **C (pure projection)** | tau > max(`tau_observed`) | Full fan width |

**The zone boundaries MUST be derived from actual `tau_observed` values**,
not from `(sweep_to − anchor_to)` or `(sweep_to − anchor_from)`. Using
anchor-derived proxies works only when anchor dates and evidence dates
are aligned, and breaks when they diverge.

Correct computation:
```
tau_evidence_all  = min(c.tau_observed for c in cohorts)  # A/B boundary
tau_evidence_any  = max(c.tau_observed for c in cohorts)  # B/C boundary
max_tau           = max(axis_tau_max, sweep_to − anchor_from)  # chart extent
```

The old computation (`tau_solid_max = sweep_to − anchor_to`) is a proxy
that happens to be correct when anchor dates ≈ evidence dates, but fails
in at least three scenarios:

1. **Out-of-range fixture/evidence:** Cohorts from January, query anchored
   in February. Anchor-derived boundary is too high; creates a dead zone
   where nothing renders.
2. **Stale evidence:** Fresh anchor dates but old `evidence_retrieved_at`.
   Fan falsely collapsed beyond actual evidence depth.
3. **Historical `.asat()` query:** `sweep_to` capped by `.asat()` but
   evidence may be older still. Fan falsely confident between evidence
   date and asat date.

### 2.3 `tau_observed` per cohort

Computed in `cohort_forecast.py` (lines 657–681):

```
tau_observed = min(
    (evidence_retrieved_at − cohort_anchor_day).days,
    tau_max
)
```

Fallback (no `evidence_retrieved_at`): heuristic based on the last τ
where Y increased in the frame data.

### 2.4 Chart extent vs rendering zones

These are separate concepts:
- **Chart extent** (`max_tau`): how many tau values to emit rows for.
  Driven by `axis_tau_max` (from t95) or `sweep_to − anchor_from`.
- **Rendering zones** (A/B/C): which rows get evidence vs midpoint vs
  projection vs fan. Driven by `tau_observed`.

Do not conflate them. A chart can extend to tau=60 while evidence only
covers tau=12 — the zone B/C rendering handles the gap correctly.

---

## 3. Data Flow Summary

```
User DSL: window(17-Feb-26:23-Feb-26).asat(12-Mar-26)
                    │
                    ▼
    anchor_from = 17-Feb     anchor_to = 23-Feb
    sweep_to = 12-Mar        (from .asat; else today)
    sweep_from = 17-Feb      (= anchor_from)
                    │
                    ▼
    FE epoch logic: split sweep by per-day data availability
      epoch:0  17-Feb → 12-Mar  (window() data)
      epoch:1  13-Mar → today   (__epoch_gap__)
                    │
                    ▼
    BE per epoch:
      snapshot_service queries rows where
        anchor_day ∈ [anchor_from, anchor_to]
        retrieved_at ∈ [sweep_from, sweep_to]
        slice_key matches epoch's regime
                    │
                    ▼
    derive_cohort_maturity() builds daily frames
      each frame has snapshot_date (currently as_at_date)
                    │
                    ▼
    compute_cohort_maturity_rows() receives:
      frames, anchor_from, anchor_to, sweep_to, evidence_retrieved_at
                    │
                    ▼
    Per-cohort tau_observed computed from evidence_retrieved_at
    Rendering zones derived from tau_observed
    MC fan computed with proper zone boundaries
```

---

## 4. Change Log

- [x] **Renamed `as_at_date` → `snapshot_date`** across frames, FE
  normalisation (`graphComputeClient.ts`), BE derivation
  (`cohort_maturity_derivation.py`), api_handlers.py, export service,
  test fixtures, and all test files. Backward-compatible fallbacks added
  in FE read paths for cached/old-format data.
- [x] **Derived rendering zone boundaries from `tau_observed`** in
  `cohort_forecast.py`. `tau_solid_max = min(tau_observed)`,
  `tau_future_max = max(tau_observed)`. Chart extent uses separate
  `tau_chart_extent = sweep_to − anchor_from`. Fallback when no
  `evidence_retrieved_at`: `tau_observed = tau_max` (sweep_to − anchor).
