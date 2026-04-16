# Doc 42 — `asat()` Consolidated Contract

**Date**: 16-Apr-26
**Status**: Design — consolidates and supersedes asat material from docs 3, 7, 27, and 29
**Purpose**: Single authoritative reference for what `asat()` means, how it
behaves, and what invariants blind tests must protect.

---

## 1. What `asat()` means

`asat(date)` shifts the **epistemic basis** of the entire query to a
specific point in time. It answers: "what would the user have seen if
they ran this query on date X?"

This is not a display filter or a cosmetic annotation. It changes which
evidence is visible, which model is used, and at what age completeness
is evaluated. Every downstream computation inherits the shifted basis.

---

## 2. The three-date model

An `asat(X)` query decomposes into three logically independent dates:

| Date | What it controls | asat < now | asat = now (default) | asat > now |
|------|-----------------|------------|---------------------|------------|
| **evidence_cutoff_date** | Which data is visible (snapshots + file data) | X | now | now (no future data exists) |
| **evaluation_date** | Age at which completeness is evaluated | X | now | X (future age, CDF projects forward) |
| **posterior_cutoff_date** | Which model fit is used | most recent fit with `fitted_at <= X` | current fit | current fit (no future fits exist) |

**evidence_cutoff_date** filters ALL evidence sources — snapshot DB
queries AND file-cached parameter data. Any data point with a retrieval
timestamp after the cutoff must be excluded. This is epistemic
consistency: if the user couldn't have known it on date X, it must not
appear.

**evaluation_date** determines the age used for completeness:
`age = evaluation_date - anchor_day`. Historical asat produces a younger
age (less mature). Future asat produces an older age (more mature, CDF
projects forward, blend shifts toward model rate).

**posterior_cutoff_date** selects the model. The gap between
evidence_cutoff and evaluation_date (when asat > now) is the forecast
horizon — the model's projection into unknown territory.

---

## 3. Evidence filtering

### 3.1 Snapshot DB path

The virtual snapshot query filters by `retrieved_at <= evidence_cutoff_date`
and selects the latest row per `(anchor_day, slice_key)` within the
requested anchor range. This is "most recent on or before" semantics.

The query uses the `core_hash` signature for validation. `asat` is
excluded from the signature — it is a retrieval filter, not a query
identity (see §6).

### 3.2 File data path

File-cached parameter data must also be filtered by the evidence cutoff.
Data points retrieved after the cutoff date must be excluded from the
visible evidence set. The `_asat_retrieved_at` annotation on parameter
objects gates what is visible from file cache.

### 3.3 Unified rule

Regardless of data source (snapshot DB or file cache), the invariant is:

> **No evidence with `retrieved_at > evidence_cutoff_date` may
> contribute to the query result.**

---

## 4. Posterior resolution

### 4.1 Algorithm

Given a parameter's `posterior` (with `fit_history`) and an asat date:

1. **Check current posterior**: if `posterior.fitted_at <= asat_date`,
   the current posterior IS the answer. Use `posterior.slices` directly.

2. **Search fit_history**: filter to entries where
   `fitted_at <= asat_date`. Select the most recent.

3. **If found**: construct a synthetic `Posterior` from the entry's
   full-fidelity slices (`fitted_at`, `fingerprint`, `hdi_level`,
   `prior_tier`, `slices`).

4. **If not found**: return `undefined`. No posterior available.

### 4.2 Strict no-fallback (cardinal invariant)

**If no fit exists on or before the asat date, the system must NOT
silently fall back to the current posterior.** The absence is the true
answer. Substituting the latest fit is a lie dressed as data.

A user comparing `asat(1-Jan-26)` with `asat(1-Feb-26)` must be
confident that both views reflect their respective dates, not a mixture
of historical and current data.

### 4.3 Full-fidelity storage

Every `fit_history` entry stores its slices as full
`SlicePosteriorEntry` objects — the same type used in the current
`posterior.slices`. No compression, no slim types, no rehydration.

Each entry is self-describing:

| Field | Type | Purpose |
|-------|------|---------|
| `fitted_at` | string | UK date of this fit |
| `fingerprint` | string | Model hash |
| `slices` | dict | Per-slice `SlicePosteriorEntry` |
| `hdi_level` | float | HDI level used |
| `prior_tier` | string | Prior tier that produced this fit |

### 4.4 Retention policy

- **Date-bounded**: `bayes_fit_history_max_days` (default 100). Entries
  older than `newest_fitted_at - max_days` are evicted.
- **Interval filtering**: `bayes_fit_history_interval_days` (default 0).
  Controls whether a completed fit is archived — not whether the fit
  runs. 0 = archive every fit.
- Eviction cutoff is relative to the newest entry's `fitted_at`, not
  wall-clock time.

---

## 5. Forward-looking asat (asat > now)

- Evidence frozen at today's frontier (no future snapshots or file data)
- Completeness evaluated at the future age: `age = asat_date - anchor_day`
- CDF projects forward; blend shifts toward model rate
- Uncertainty bands across the evidence-to-evaluation gap are the model's
  honest statement given parameter uncertainty
- Model uses current best-available fit (no future fits exist)

---

## 6. Signature exclusion

`asat` is excluded from the `core_hash` query signature. It changes the
retrieval source, not the query semantics.

```
from(A).to(B).window(1-Oct:31-Oct)              -> core_hash = abc123
from(A).to(B).window(1-Oct:31-Oct).asat(15-Oct) -> core_hash = abc123 (SAME)
```

This ensures:
- Historical data stored by live queries is retrievable by asat queries
- Signature mismatch indicates actual query change, not asat toggle

---

## 7. Read-only invariant

asat queries produce:
- No file writes
- No IDB writes
- No snapshot DB writes

The system observes historical state. It does not modify it.

---

## 8. Interaction with analysis and charting

When `asat` is active:
- Chart titles/subtitles must indicate the as-at date
- Tooltips must show snapshot provenance
- Scenario layers must show a visual indicator (clock/@ badge)
- `ChartRecipe` must carry the `asat` field through serialisation
- Future-date asat (before Phase B forecast support) should warn:
  "asat date is in the future — results reflect latest available data"

When `asat` is absent, `asat_date` on `AnalysisResult` is `null`. The
absence IS the signal for "live query". No need to inject today's date.

---

## 9. Interaction with completeness and the forecast engine

`asat` varies the epistemic basis for the forecast engine's computation:

- **Completeness**: evaluated at `age = evaluation_date - anchor_day`,
  not `now - anchor_day`
- **Rate blend**: completeness drives the evidence/forecast blend weight.
  Historical asat (lower completeness) shifts toward model. Future asat
  (higher completeness) shifts toward evidence.
- **Dispersions**: `completeness_sd` is evaluated at the asat-derived
  age. Uncertainty bands reflect what was knowable at that point.

The engine receives pre-resolved, asat-filtered inputs. It does not know
about the asat mechanism — it just computes on the evidence and model
it is given. The filtering happens upstream.

---

## 10. DSL semantics

- **Canonical function**: `asat(d-MMM-yy)` (UK date token)
- **Alias**: `at(...)` accepted as sugar; normalisation emits `asat(...)` only
- **Order-indifferent**: `asat(...)` may appear anywhere in the chain
- **Date boundary**: date-only literal treated as end-of-day
  (`YYYY-MM-DDT23:59:59Z`) at the API boundary
- **Scenario composition**: `asat` in a higher layer overrides `asat`
  from a lower layer. Empty `asat()` explicitly clears an inherited asat.

---

## 11. Error handling

| Scenario | Behaviour |
|----------|-----------|
| No snapshots exist at all | "No snapshot history for this parameter" |
| Snapshots exist but different `core_hash` | "Historical data exists but query configuration has changed" |
| asat before first snapshot | Empty evidence (not an error) |
| No fit on or before asat date | No posterior (not an error — absence is the true answer) |
| Evidence exists but no posterior | Evidence renders; posterior overlay absent |
| Posterior exists but no evidence | Posterior renders; evidence time-series empty |
| asat in future (pre-Phase B) | Warning toast; returns latest available data |

---

## 12. Testable invariants

These invariants define the blind testing contract. Tests are written
from these rules, not from implementation code.

### A. Evidence filtering

| # | Invariant |
|---|-----------|
| A1 | Snapshot DB query returns only rows with `retrieved_at <= evidence_cutoff_date` |
| A2 | Virtual snapshot returns at most one row per `(anchor_day, slice_key)` — the latest as-of the cutoff |
| A3 | File-cached data with `retrieved_at > evidence_cutoff_date` is excluded from visible evidence |
| A4 | When asat > now, `evidence_cutoff_date` = now (not the future asat date) |
| A5 | When asat < now, `evidence_cutoff_date` = asat date |

### B. Posterior resolution (on-or-before)

| # | Invariant |
|---|-----------|
| B1 | Given fit_history entries at 1-Jan, 15-Jan, 1-Feb and asat=20-Jan: returns 15-Jan entry |
| B2 | Given `posterior.fitted_at` = 1-Mar and asat=15-Mar: returns current posterior (`fitted_at <= asat`) |
| B3 | Given fit_history at 15-Jan, 1-Feb and asat=10-Jan: returns `undefined` |
| B4 | Given empty fit_history and `posterior.fitted_at` = 1-Mar and asat=15-Feb: returns `undefined` |
| B5 | Given fit_history entry at 15-Jan and asat=15-Jan: returns 15-Jan entry (exact match) |
| B6 | Given `posterior.fitted_at` = 15-Jan, fit_history=[1-Jan] and asat=15-Jan: returns current posterior (current takes priority when `fitted_at <= asat`) |

### C. Strict no-fallback

| # | Invariant |
|---|-----------|
| C1 | No combination of inputs causes `resolveAsatPosterior` to return the current posterior when `fitted_at > asat_date` |
| C2 | When no fit exists on or before asat, result is `undefined` — not the current posterior, not an error |

### D. Synthetic posterior construction

| # | Invariant |
|---|-----------|
| D1 | Returned object has the same shape as `Posterior` (`fitted_at`, `fingerprint`, `hdi_level`, `prior_tier`, `slices`) |
| D2 | `slices` are the fit_history entry's slices, not the current posterior's |
| D3 | `fitted_at` and `fingerprint` come from the fit_history entry |
| D4 | `hdi_level` and `prior_tier` come from the fit_history entry |

### E. Projection round-trip

| # | Invariant |
|---|-----------|
| E1 | A fit_history entry resolved via asat, then projected by `projectProbabilityPosterior()`, produces a `ProbabilityPosterior` with all fields matching the historical entry |
| E2 | Same entry projected by `projectLatencyPosterior()` produces a `LatencyPosterior` with all fields matching |
| E3 | `fitted_at` and `fingerprint` on the projected edge match the historical entry, not the current posterior |

### F. Signature exclusion

| # | Invariant |
|---|-----------|
| F1 | `core_hash` is identical with and without `asat(...)` on the same query |
| F2 | `core_hash` is identical regardless of which asat date is specified |

### G. Read-only

| # | Invariant |
|---|-----------|
| G1 | asat query produces no file writes |
| G2 | asat query produces no IDB writes |
| G3 | asat query produces no snapshot DB writes |

### H. Retention policy

| # | Invariant |
|---|-----------|
| H1 | Date-based eviction removes entries older than `max_days` from newest `fitted_at` |
| H2 | Eviction cutoff is relative to newest entry's `fitted_at`, not wall-clock time |
| H3 | `interval_days=0` stores every fit |
| H4 | `interval_days=7` with last entry 3 days ago: new entry NOT appended (but `posterior.slices` IS updated) |
| H5 | `interval_days=7` with last entry 8 days ago: new entry IS appended |

### I. Full-fidelity storage

| # | Invariant |
|---|-----------|
| I1 | After patch, fit_history entry's slices contain all `SlicePosteriorEntry` fields |
| I2 | After patch, fit_history entry has `hdi_level` and `prior_tier` from outgoing posterior |

### J. Three-date consistency

| # | Invariant |
|---|-----------|
| J1 | Completeness is evaluated at `age = evaluation_date - anchor_day`, where `evaluation_date` = asat date |
| J2 | Historical asat produces younger age (lower completeness) than default |
| J3 | Future asat produces older age (higher completeness) than default |
| J4 | Evidence, posterior, and evaluation date are all governed by the same asat input |

### K. Warnings

| # | Invariant |
|---|-----------|
| K1 | Warn if no snapshot within 24h of requested asat timestamp |
| K2 | Warn if requested `anchor_to` not covered by virtual snapshot |
| K3 | Internal gaps in daily series do NOT produce warnings |
| K4 | Future-date asat produces a defensive warning (pre-Phase B) |

---

## 13. Superseded material

This document consolidates and supersedes the asat-specific content in:

- **Doc 3** (`project-db/completed/3-asat.md`) §§1-7, 12-13 — DSL
  parsing, snapshot query, read-only invariants, error handling.
  Doc 3 remains the reference for implementation details (file traces,
  endpoint specs, UI mockups) but this document is authoritative for
  the semantic contract.

- **Doc 27** (`project-bayes/27-fit-history-fidelity-and-asat-posterior.md`)
  §§1-7 — fit history storage, posterior resolution, retention policy,
  test invariants. Doc 27 remains the reference for implementation
  details (type changes, patch service changes, migration) but this
  document is authoritative for the contract and invariants.

- **Doc 7** (`project-bayes/7-asat-analysis-completion.md`) §A —
  analysis surface (chart titles, tooltips, badges). Doc 7 remains the
  reference for Phase A/B implementation plans but this document is
  authoritative for the semantic rules.

- **Doc 29** (`project-bayes/29-generalised-forecast-engine-design.md`)
  §asat semantics (lines 253-306) — three-date model summary. This
  document expands and replaces that summary.
