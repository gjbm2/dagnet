# Doc 27 — Fit History Fidelity and As-At Posterior Reconstruction

**Status**: Design
**Date**: 31-Mar-26
**Purpose**: (1) Store full-fidelity posterior snapshots in fit_history
so that any historical fit can be reconstructed without rehydration.
(2) Extend the `asat()` query path so that it selects the correct
historical posterior — not just historical evidence data. (3) Redesign
the retention policy to be date-bounded rather than count-bounded.

**Related**: Doc 21 (unified posterior schema), doc 4 (async roundtrip),
doc 3 (asat snapshot DB), programme.md (nightly fit scheduling)

---

## 1. Motivation

With the nightly Bayes run approaching, each day will produce a new fit
for every edge with sufficient evidence. The existing `fit_history` was
designed for warm-start trajectory calibration — it stores a "slim"
subset of each fit (alpha, beta, mu_mean, sigma_mean) via a separate
`SlimSlice` type and discards dispersions, quality metrics, onset
parameters, and HDI bounds.

This is insufficient for the archival use case: reconstructing what the
model believed on a given historical date. The user should be able to
write `from(A).to(B).asat(15-Feb-26)` and see the model's probability
estimate, latency distribution, and uncertainty bands *as they were on
that date* — not just the raw evidence counts.

Currently `asat()` only affects the evidence path (snapshot DB retrieval).
The posterior shown is always the current fit. This is misleading: the
evidence says "15-Feb" but the model says "today".

---

## 2. Design principles

### 2.1 asat is strict — no fallback

When a query includes `asat(d-MMM-yy)`, the posterior shown MUST come
from the fit_history (or the current posterior if the current
`fitted_at` is on or before the asat date). **If no fit exists on or
before the requested date, the system must surface a clear absence
indicator** — not silently fall back to the current posterior.

`asat()` means "what would the user have seen if they performed this
query at that point in time." It is an "on or before" selection: the
most recent fit whose `fitted_at <= asat_date`. This is the same
semantics as the snapshot DB evidence retrieval: most recent data known
as of that date.

**Rationale**: `asat()` is an explicit archival question. Falling back to
the current posterior disguises the answer's provenance and produces
misleading output. A user comparing `asat(1-Jan-26)` with
`asat(1-Feb-26)` must be confident that both views reflect their
respective dates, not a mixture of historical and current data.

The absence case is informative: "we have no model fit before this date"
is a true and useful answer. Silently substituting the latest fit is a
lie dressed as data.

### 2.2 Full-fidelity storage — no slim types

Each fit_history entry stores its slices as full `SlicePosteriorEntry`
objects — the same type used in the current `posterior.slices`. No
compression, no separate "slim" type, no rehydration step.

**Rationale**: The `SlimSlice` type saved a handful of bytes per entry
by discarding dispersions and derived fields, but added a compression
step, a rehydration step, a separate type definition (Python + TS), and
a testing surface for round-trip fidelity. The disk cost of storing all
~15 numeric fields per slice is trivial (see §3.3). The complexity cost
of the slim/rehydrate machinery is not. Storing the full entry means
the asat query path can pass historical slices directly to the existing
projection functions (`projectProbabilityPosterior`,
`projectLatencyPosterior`) with zero adaptation — the types already
match.

### 2.3 Retention is date-bounded, not count-bounded

The retention window is expressed as **maximum days of history to retain**
(setting: `bayes_fit_history_max_days`), not a maximum entry count. This
decouples retention policy from fit frequency: if fits run daily, 100
days means 100 entries; if fits run weekly, 100 days means ~14 entries.
The intent is always "how far back can I look?", which is a time
question.

### 2.4 Interval filtering controls history density, not fit execution

The `bayes_fit_history_interval_days` setting controls only whether a
completed fit's posterior is *appended to fit_history* — not whether the
fit runs at all. If Bayes is commissioned, the fit always runs and the
current `posterior.slices` is always updated. The interval setting only
gates history retention: "is this fit too close to the last retained
entry to be worth archiving?"

When unset or zero (the default), **every** fit is retained. When set
to a positive value (e.g. 7), the system skips the history append if
the most recent entry's `fitted_at` is fewer than that many days ago.

---

## 3. Full-fidelity fit_history

### 3.1 Eliminating SlimSlice

The `SlimSlice` type is removed. The `FitHistoryEntry.slices` field
changes from `Dict[str, SlimSlice]` to `Dict[str, SlicePosteriorEntry]`
(Python) / `Record<string, SlicePosteriorEntry>` (TS).

The compression block in `bayesPatchService.ts` (currently lines
390–397, which cherry-picks alpha/beta/mu_mean/sigma_mean) is replaced
with a direct copy of the full slice entry.

### 3.2 Updated FitHistoryEntry schema

| Field | Type | Present | Purpose |
|---|---|---|---|
| `fitted_at` | string | Always | UK date of this fit (existing) |
| `fingerprint` | string | Always | Model hash (existing) |
| `slices` | dict | Always | Per-slice `SlicePosteriorEntry` (was `SlimSlice`) |
| `hdi_level` | float | Always | HDI level used for this fit (e.g. 0.9) |
| `prior_tier` | string | Always | Prior tier that produced this fit |

`hdi_level` and `prior_tier` are copied from the parent `Posterior` at
the time of archival. They make each entry self-describing: you know
what settings produced it without reference to the current posterior.

### 3.3 Storage budget

`SlicePosteriorEntry` has ~15 numeric fields + 2 string fields per
slice. For a parameter with 2 slices (window + cohort):

- Per entry: ~30 numeric fields + 4 strings + 2 metadata strings
  ≈ 300–400 bytes in YAML
- At 100 daily entries: ~30–40 KB per parameter file

This is modest. Parameter files are already multi-KB YAML documents;
the fit_history will be the largest section but not problematically so.
If file size becomes a concern, the `max_days` setting can be reduced.

### 3.4 Backward compatibility

Existing fit_history entries use the old `SlimSlice` shape (alpha, beta,
mu_mean, sigma_mean only). The updated `FitHistoryEntry` type must
accept both shapes:

- `SlicePosteriorEntry` has `p_hdi_lower`, `p_hdi_upper`, `ess`,
  `rhat` as required fields. For legacy entries these will be absent.
- **Solution**: in the TS interface, make all `SlicePosteriorEntry`
  fields optional on `FitHistoryEntry.slices` entries (i.e. the slice
  type within fit_history is `Partial<SlicePosteriorEntry>` with
  `alpha` and `beta` required). In Python, use a permissive model or
  a union type.
- Legacy entries will have probability point estimates (alpha/beta →
  mean is computable) but no HDI, no latency dispersions, no quality
  metrics. The asat path handles this as partial data (§5.5).

No migration of existing data. New fits write full entries; old entries
remain as-is and degrade gracefully.

### 3.5 Full impact assessment

Every reference to `SlimSlice`, `FitHistoryEntry`, and `fit_history`
has been traced. This is the exhaustive change list.

**A. Type definitions (MUST CHANGE)**

- `graph-editor/src/types/index.ts` lines 687–692: Delete the
  `SlimSlice` interface entirely.
- `graph-editor/src/types/index.ts` lines 695–699: Update
  `FitHistoryEntry` — change `slices` from `Record<string, SlimSlice>`
  to `Record<string, FitHistorySlice>` where `FitHistorySlice` is a new
  type: `Partial<SlicePosteriorEntry> & { alpha: number; beta: number }`.
  This accepts both legacy (alpha/beta only) and full entries. Add
  optional `hdi_level?: number` and `prior_tier?: string` fields.
- `graph-editor/lib/graph_types.py` lines 170–177: Delete the
  `SlimSlice` class entirely.
- `graph-editor/lib/graph_types.py` lines 180–184: Update
  `FitHistoryEntry` — change `slices` from `Dict[str, SlimSlice]` to a
  permissive model that accepts both legacy and full entries. In
  Pydantic, this can be a model with all `SlicePosteriorEntry` fields
  but with `p_hdi_lower`, `p_hdi_upper`, `ess`, `rhat`, etc. marked
  `Optional` (they are required on `SlicePosteriorEntry` but optional
  here for backward compat). Add optional `hdi_level` and `prior_tier`.

**B. YAML parameter schema (MUST CHANGE)**

- `graph-editor/public/param-schemas/parameter-schema.yaml` lines
  271–285: The `fit_history.items.slices.additionalProperties` object
  currently defines only `alpha`, `beta`, `mu_mean`, `sigma_mean`. Add
  all `SlicePosteriorEntry` fields as optional properties. Add
  `hdi_level` and `prior_tier` to the `fit_history.items` properties.

**C. Compression/archival logic (MUST CHANGE)**

- `graph-editor/src/services/bayesPatchService.ts` lines 390–397:
  Replace the cherry-pick compression block (which builds `{ alpha,
  beta, mu_mean?, sigma_mean? }`) with a direct copy of the full
  `SlicePosteriorEntry` from the outgoing `posterior.slices`.
- `graph-editor/src/services/bayesPatchService.ts` lines 399–403:
  Add `hdi_level` and `prior_tier` (from the outgoing posterior) to
  the pushed `FitHistoryEntry`.
- `graph-editor/src/services/bayesPatchService.ts` line 20 and lines
  404–406: Replace count-based cap with date-based eviction (§4).

**D. Prior service — NO CHANGE NEEDED**

- `graph-editor/src/services/bayesPriorService.ts`: Only *deletes*
  the `fit_history` field from `posterior` objects. Never reads the
  contents of entries. The delete operation (`delete posterior.fit_history`)
  is schema-agnostic — no change required.

**E. Update manager — NO CHANGE NEEDED**

- `graph-editor/src/services/updateManager/mappingConfigurations.ts`
  line 350: Comment noting that cascade strips `fit_history` from
  file→graph projection. This is descriptive only; no code change
  needed.

**F. Python compiler — NO CHANGE NEEDED**

- `bayes/compiler/`: The compiler does not read `fit_history` at all.
  It reads the current `posterior.slices` and `_model_state` for
  warm-start. The `fit_history` array is only written by the FE patch
  service and consumed by the FE asat path. No compiler changes.

**G. Existing tests (MUST UPDATE)**

- `graph-editor/src/services/__tests__/bayesPosteriorRoundtrip.e2e.test.ts`
  line 95: Test fixture has a `fit_history` array with legacy SlimSlice
  entries. Update to include full `SlicePosteriorEntry` fields and
  `hdi_level`/`prior_tier` on the entry. Update corresponding assertions
  at lines 164–167.
- `graph-editor/src/services/__tests__/bayesPriorService.integration.test.ts`
  line 71: Test fixture builds a `fit_history` with slim entries. Update
  fixture shape. The deletion assertions (line 194) are schema-agnostic
  and do not need changing.
- `bayes/tests/test_bayes_reset.py` lines 55–58: Test fixture has
  `fit_history` with `{"alpha": 70, "beta": 190}` only. This is a
  legacy-shaped entry. If the Python `FitHistoryEntry` model uses a
  permissive slice type (all fields optional except alpha/beta), this
  fixture remains valid without changes. If using strict validation,
  update to include required fields.
- `graph-editor/lib/tests/test_forecasting_settings.py` lines 55–59:
  Rename `test_bayes_fit_history_max_entries` to
  `test_bayes_fit_history_max_days` and update assertion value when the
  settings rename happens (§4).

**H. Settings and constants (MUST CHANGE — §4)**

- `graph-editor/src/constants/latency.ts` line 463: Rename
  `BAYES_FIT_HISTORY_MAX_ENTRIES` → `BAYES_FIT_HISTORY_MAX_DAYS`.
  Update `ForecastingSettings` interface field name and
  `buildForecastingSettings()` mapping.
- `graph-editor/lib/runner/forecasting_settings.py` line 71: Rename
  `bayes_fit_history_max_entries` → `bayes_fit_history_max_days`.

**I. Documentation (UPDATE AFTER IMPLEMENTATION)**

- `docs/current/project-bayes/21-unified-posterior-schema.md` §3.4:
  Update the `FitHistoryEntry` schema description and SlimSlice
  references to reflect the new full-fidelity entries.
- `docs/current/project-bayes/9-fe-posterior-consumption-and-overlay.md`
  line 111: References old split types — update to reference unified
  `FitHistoryEntry` with `SlicePosteriorEntry` slices.
- Several other docs reference `fit_history` descriptively
  (`4-async-roundtrip-infrastructure.md`, `programme.md`,
  `statistical-domain-summary.md`, `codebase/STATISTICAL_DOMAIN_SUMMARY.md`).
  Update retention policy descriptions (interval_days default,
  max_entries → max_days, weekly → daily default).

---

## 4. Retention policy redesign

### 4.1 Settings

Two `ForecastingSettings` fields control retention:

| Setting | Type | Default | Semantics |
|---|---|---|---|
| `bayes_fit_history_max_days` | float | 100 | Maximum age in days of the oldest retained entry. Entries older than `newest_fitted_at - max_days` are evicted on each fit. |
| `bayes_fit_history_interval_days` | float | 0 | Minimum days between retained entries. 0 (default) = store every fit. Positive value = skip append if the most recent entry is younger than this. |

### 4.2 Replacing the count-based cap

The existing `bayes_fit_history_max_entries` (count-based) and the
hardcoded `FIT_HISTORY_MAX_ENTRIES` constant in `bayesPatchService.ts`
are replaced by the date-based `bayes_fit_history_max_days`.

**Eviction logic** (applied after appending):

1. Parse `fitted_at` on each entry to a date.
2. Compute the cutoff date: `fitted_at` of the newest entry minus
   `max_days`.
3. Remove all entries whose `fitted_at` is strictly before the cutoff.

This is applied in `bayesPatchService.ts` when building the
`fit_history` array for the new posterior.

### 4.3 Interval filtering logic

Applied **before** appending a new entry:

1. If `interval_days` is 0 or absent, always append — no filtering.
2. Otherwise, parse `fitted_at` of the last (most recent) entry in
   `fit_history`.
3. If fewer than `interval_days` have elapsed since that date, skip
   the append entirely — the current fit's `posterior.slices` is still
   updated (it's the live state), but no history entry is created.

**Interaction with max_days**: interval filtering reduces the density
of entries within the retention window. With `max_days=365` and
`interval_days=7`, you get ~52 weekly snapshots spanning a year.

**The fit always runs** regardless of these settings. They control only
the history archive, never whether the model executes.

### 4.4 Implementation touchpoints

**Settings (both languages)**:
- `latency.ts` — rename `BAYES_FIT_HISTORY_MAX_ENTRIES` to
  `BAYES_FIT_HISTORY_MAX_DAYS`, update `ForecastingSettings` interface
  and `buildForecastingSettings()`
- `forecasting_settings.py` — rename `bayes_fit_history_max_entries` to
  `bayes_fit_history_max_days`, change default semantics
- `bayes_fit_history_interval_days` — default 0 (store every fit)

**Patch service**:
- `bayesPatchService.ts` — replace the count-based splice with
  date-based eviction; add interval check before appending

**Tests**:
- `test_forecasting_settings.py` — update assertions for renamed
  setting and new defaults

### 4.5 Backward compatibility

The old `bayes_fit_history_max_entries` setting may exist in persisted
settings files. If the code encounters it, treat it as a count fallback
(keep at most N entries) — but prefer the new `max_days` if both are
present. This avoids breaking existing workspaces during the transition.

---

## 5. asat posterior query path

### 5.1 Overview

When a query includes `asat(d-MMM-yy)`, two things must happen:

1. **Evidence**: the snapshot DB returns historical n/k data as-at that
   date (existing behaviour, implemented in asatQuerySupport.ts).
2. **Posterior**: the model's fitted belief state is selected from
   `fit_history` rather than the current `posterior.slices` (new).

Both must use the same date. The result is a complete point-in-time
view: "what did we observe, and what did the model believe, on that
date."

### 5.2 Posterior selection algorithm

For a given parameter's `posterior` and an asat date:

1. **Check the current posterior first**: if `posterior.fitted_at <=
   asat_date`, the current posterior IS the correct answer (it was the
   most recent fit as of that date). Use `posterior.slices` directly —
   full fidelity, no adaptation needed.

2. **Otherwise search fit_history**: parse `fitted_at` on each entry.
   Filter to entries where `fitted_at <= asat_date`. Select the entry
   with the largest (most recent) `fitted_at`.

3. **If a fit_history entry is found**: construct a synthetic
   `Posterior` object from the entry (slices, fitted_at, fingerprint,
   hdi_level, prior_tier). Pass it to the existing projection functions.

4. **If no entry matches**: return no posterior. Do not fall back to
   the current posterior. The absence is the true answer.

This is "most recent on or before" — the same semantics the user
expects from `asat()` everywhere else: "what would I have seen if I
ran this query on that date."

### 5.3 Where the selection happens

A new function `resolveAsatPosterior()` in
`posteriorSliceResolution.ts` takes the full `Posterior` (with
fit_history), the asat date string, and returns either a
`Posterior`-shaped object or `undefined`.

Because fit_history now stores full `SlicePosteriorEntry` objects (§3),
the returned object is type-compatible with the existing `Posterior`
interface. The projection functions (`projectProbabilityPosterior`,
`projectLatencyPosterior`) receive it without any adaptation. No
downstream code changes.

### 5.4 Cascade integration

The cascade mapping that projects posteriors onto graph edges is in
`mappingConfigurations.ts` and calls `projectProbabilityPosterior()`
and `projectLatencyPosterior()`. The effective DSL is available at this
point.

Integration approach:
- In the mapping configuration's transform function, parse the
  effective DSL for an `asat` clause.
- If present, call `resolveAsatPosterior()` on the parameter file's
  `posterior` to get the historical posterior (or undefined).
- Pass the result (historical or original) to the existing projection
  functions.
- If `resolveAsatPosterior()` returns undefined, set the edge's
  posterior fields to null/cleared — do not call the projection
  functions at all.

### 5.5 Handling absence and partial data

**No fit available on or before the asat date**:
- The edge's posterior fields are set to `null` / cleared.
- The quality tier computation returns `'no-data'` (existing behaviour
  when ess/rhat are null).
- The FE shows no posterior overlay — just the evidence time-series.
- This is NOT an error — it is the true answer.

**Legacy fit_history entry** (old SlimSlice shape — alpha/beta only, no
dispersions, no quality metrics):
- Probability point estimate: alpha/beta → mean is computable as
  alpha/(alpha+beta).
- Probability HDI: absent (`p_hdi_lower`/`p_hdi_upper` not stored and
  not computable without the HDI computation that produced them). The
  projection will pass `undefined` through. UI consumers already null-
  check these fields — the HDI row simply does not render.
- Latency: `mu_mean`/`sigma_mean` may be present (old SlimSlice stored
  these). If so, the latency point estimate renders. Dispersions,
  onset, t95 HDI are absent — those UI rows do not render.
- Quality metrics: absent. Quality tier returns `'no-data'`.
- This is graceful degradation for legacy entries. Over time, as new
  full-fidelity entries accumulate, the old entries age out via the
  `max_days` retention policy.

**Full-fidelity entry** (new format):
- Complete reconstruction. All fields present. The view is
  indistinguishable from a live fit.

### 5.6 Interaction with evidence asat

The evidence path and the posterior path use the same `asat` date from
the parsed query constraints. They are independent lookups:

- Evidence: snapshot DB query with `as_at` filter → historical n/k
  time-series.
- Posterior: fit_history selection → historical model parameters.

It is possible (and expected in early history) that evidence exists for
a date but no fit does (data was collected before the first Bayes run).
In this case the evidence time-series renders normally but the posterior
overlay is absent. This is correct and not misleading.

The reverse (fit exists but no evidence snapshot) is unlikely but
handled: the model posterior renders but the evidence time-series is
empty. The FE already handles empty evidence gracefully.

### 5.7 Interaction with slice keys

The `FitHistoryEntry.slices` map uses the same DSL-string keys as
`posterior.slices`. Slice key matching for the asat case follows the
same normalisation logic as the live case (via the synthetic `Posterior`
object): exact match first, then normalised match. If the requested
slice key does not exist in the historical entry's slices (e.g. a
context dimension was added after that fit), the posterior for that
slice is absent.

### 5.8 Implementation touchpoints

**New code**:
- `resolveAsatPosterior()` in `posteriorSliceResolution.ts` — asat
  selection, returns a `Posterior`-shaped object or undefined

**Modified code**:
- `mappingConfigurations.ts` — cascade transform for file-to-graph
  posterior projection: add asat conditional

**No changes needed**:
- `projectProbabilityPosterior()` — unchanged, receives historical
  posterior with same type
- `projectLatencyPosterior()` — unchanged
- All UI consumers — unchanged, already null-safe
- `bayesQualityTier.ts` — unchanged, already handles null ess/rhat
- `bayesPatchService.ts` — only the storage and retention logic
  changes (§3, §4), not the projection path

---

## 6. Consumer null-safety audit

All consumers of posterior fields that may be absent on legacy
fit_history entries have been audited:

| Field | Consumer | Null handling |
|---|---|---|
| `p_hdi_lower/upper` | `PosteriorIndicator.tsx` | Conditional render: `{posterior.hdi_lower != null && ...}` |
| | `BayesPosteriorCard.tsx` | Conditional render: `{post!.hdi_lower != null && ...}` |
| | `posteriorSliceResolution.ts` | Direct copy — value propagated as-is |
| `hdi_t95_lower/upper` | `PosteriorIndicator.tsx` | Conditional render: `{posterior.hdi_t95_lower != null && ...}` |
| | `BayesPosteriorCard.tsx` | Conditional render: `{lat!.hdi_t95_lower != null && ...}` |
| | `posteriorSliceResolution.ts` | Direct copy — value propagated as-is |
| `mu_sd`, `sigma_sd` | `PosteriorIndicator.tsx` | `fmtNum()` handles null → '—' |
| | `BayesPosteriorCard.tsx` | Guarded by `hasEdgeLat` |
| `onset_mean`, `onset_sd` | All display components | Conditional render or fallback to `onset_delta_days` |
| `onset_mu_corr` | All consumers | Conditional render: `!= null` checks everywhere |
| `ess` | `bayesQualityTier.ts` | Explicit: `if (ess == null) return 'no-data'` |
| | Display components | Conditional render |
| `rhat` | `bayesQualityTier.ts` | Explicit: `if (rhat == null ...) return 'no-data'` |
| | Display components | Conditional render |
| `divergences` | All consumers | Defensive: `?? 0` everywhere |
| `evidence_grade` | `posteriorSliceResolution.ts` | Defaults: `?? 0` |
| `provenance` | `posteriorSliceResolution.ts` | Defaults: `?? 'bayesian'` |

**Conclusion**: no consumer will crash if any field is `undefined`/
`null`. The worst case is graceful degradation (missing rows in UI
display, `'no-data'` quality tier). No consumer-side code changes are
needed for the asat path.

---

## 7. Test coverage design

### 7.1 Approach: blind testing

Tests should be written from this specification, not from the
implementation code. The test author knows:
- The function signatures and return types
- The invariants from this document
- The input/output contracts

They do NOT know:
- Internal branching logic
- Variable names or helper decomposition
- Implementation shortcuts

This produces tests that verify behaviour rather than implementation.

### 7.2 Test file placement

One new test file:
`graph-editor/src/services/__tests__/asatPosteriorResolution.integration.test.ts`

This file tests the complete asat posterior path: fit_history selection,
synthetic posterior construction, and projection to graph edge shapes.
It uses the existing IDB mock + fileRegistry pattern.

### 7.3 Invariants to protect

**A. asat selection (on-or-before semantics)**

| # | Invariant |
|---|-----------|
| A1 | Given fit_history entries at 1-Jan, 15-Jan, 1-Feb and asat=20-Jan: returns the 15-Jan entry |
| A2 | Given posterior.fitted_at = 1-Mar and asat=15-Mar: returns the current posterior (fitted_at <= asat) |
| A3 | Given fit_history entries at 15-Jan, 1-Feb and asat=10-Jan: returns undefined (no fit on or before) |
| A4 | Given empty fit_history and posterior.fitted_at = 1-Mar and asat=15-Feb: returns undefined (current posterior is after asat; no history before) |
| A5 | Given fit_history entry at 15-Jan and asat=15-Jan: returns the 15-Jan entry (exact date match) |
| A6 | Given posterior.fitted_at = 15-Jan, fit_history=[1-Jan] and asat=15-Jan: returns current posterior (current fitted_at <= asat takes priority over history) |

**B. Synthetic posterior construction**

| # | Invariant |
|---|-----------|
| B1 | The returned object has the same shape as `Posterior` (fitted_at, fingerprint, hdi_level, prior_tier, slices) |
| B2 | The `slices` are the fit_history entry's slices, not the current posterior's slices |
| B3 | `fitted_at` and `fingerprint` come from the fit_history entry, not the current posterior |
| B4 | `hdi_level` and `prior_tier` come from the fit_history entry when present; fall back to current posterior when absent (legacy entries) |

**C. Projection round-trip (full-fidelity entry)**

| # | Invariant |
|---|-----------|
| C1 | A full-fidelity fit_history entry, resolved via asat, then projected by `projectProbabilityPosterior()`, produces a ProbabilityPosterior with alpha, beta, hdi_lower, hdi_upper, ess, rhat, divergences, evidence_grade, provenance all matching the historical entry's values |
| C2 | Same entry projected by `projectLatencyPosterior()` produces a LatencyPosterior with mu_mean, mu_sd, sigma_mean, sigma_sd, hdi_t95_lower, hdi_t95_upper, onset_mean, onset_sd all matching the historical entry |
| C3 | The `fitted_at` and `fingerprint` on the projected edge posterior match the historical entry, not the current posterior |

**D. Projection round-trip (legacy entry)**

| # | Invariant |
|---|-----------|
| D1 | A legacy SlimSlice entry (alpha, beta only) resolved via asat, then projected, produces a ProbabilityPosterior with alpha and beta present; hdi_lower/hdi_upper are undefined/null |
| D2 | A legacy entry with mu_mean/sigma_mean but no dispersions produces a LatencyPosterior with mu_mean and sigma_mean present; mu_sd, sigma_sd, hdi_t95_lower, hdi_t95_upper are undefined/null |
| D3 | A legacy entry with no latency fields produces no LatencyPosterior (projectLatencyPosterior returns undefined) |

**E. Absence (strict — no fallback)**

| # | Invariant |
|---|-----------|
| E1 | When resolveAsatPosterior returns undefined, projectProbabilityPosterior with that result returns undefined |
| E2 | When resolveAsatPosterior returns undefined, projectLatencyPosterior with that result returns undefined |
| E3 | No combination of inputs causes resolveAsatPosterior to return the current posterior when fitted_at > asat_date (the strict-no-fallback invariant) |

**F. Full-fidelity storage (compression eliminated)**

| # | Invariant |
|---|-----------|
| F1 | After a patch is applied, the new fit_history entry's slices contain all fields from the outgoing SlicePosteriorEntry (p_hdi_lower, p_hdi_upper, mu_sd, sigma_sd, onset_mean, onset_sd, ess, rhat, divergences, evidence_grade, provenance) — not just alpha/beta |
| F2 | After a patch is applied, the new fit_history entry has hdi_level and prior_tier from the outgoing posterior |
| F3 | The fit_history entry's slices are the same object shape as posterior.slices entries |

**G. Retention policy**

| # | Invariant |
|---|-----------|
| G1 | Date-based eviction removes entries older than max_days from the newest entry's fitted_at |
| G2 | Eviction cutoff is relative to newest entry's fitted_at, not wall-clock time |
| G3 | interval_days=0 stores every fit |
| G4 | interval_days=7 with last entry 3 days ago: new entry is NOT appended (but posterior.slices IS still updated) |
| G5 | interval_days=7 with last entry 8 days ago: new entry IS appended |

### 7.4 Blind testing methodology

1. **Fixture builder**: a helper function that constructs a `Posterior`
   object with configurable fit_history entries. Each entry can be
   "full" (all SlicePosteriorEntry fields) or "legacy" (alpha/beta
   only). The fixture builder constructs objects conforming to the type
   contract, not informed by implementation internals.

2. **Tests call the public API**: `resolveAsatPosterior()`, then pass
   the result to `projectProbabilityPosterior()` /
   `projectLatencyPosterior()` and assert on the final output shape.
   Internal decomposition is opaque to the tests.

3. **No mocking of the selection or projection functions**: all
   assertions are on outputs. If the implementation uses helper
   functions internally, the tests neither know nor care.

4. **Retention tests**: exercise the patch service's history append
   logic with controlled inputs and assert on the resulting
   fit_history array length, content, and ordering.

---

## 8. Settings summary

After implementation, the `ForecastingSettings` Bayesian retention
fields are:

| Setting | Type | Default | Description |
|---|---|---|---|
| `bayes_fit_history_max_days` | float | 100 | Evict entries older than this many days from the most recent fit |
| `bayes_fit_history_interval_days` | float | 0 | Minimum days between retained entries. 0 = store every fit (default). |

These replace the old `bayes_fit_history_max_entries` (count-based cap).

---

## 9. Implementation sequence

1. Remove `SlimSlice` type (Python + TS); update `FitHistoryEntry` to
   use full `SlicePosteriorEntry` (or partial variant for backward
   compat) — §3
2. Add `hdi_level` and `prior_tier` to `FitHistoryEntry` — §3.2
3. Replace compression block in `bayesPatchService.ts` with direct
   copy of full slice entries — §3.5
4. Rename retention settings from count-based to date-based — §4
5. Implement date-based eviction and interval filtering in
   `bayesPatchService.ts` — §4
6. Implement `resolveAsatPosterior()` — §5
7. Integrate into cascade mapping — §5.4
8. Write blind integration tests — §7

---

## 10. Open questions

1. **Should `_model_state` be stored per fit_history entry?** Currently
   only stored on the live posterior. Storing it historically would
   allow full warm-start replay from any historical point. Storage cost
   is higher (variable-length dict of model internals). Recommendation:
   defer — warm-start replay from arbitrary historical points is not a
   current requirement.

2. **Should the asat posterior selection be exposed as a separate API
   endpoint?** Currently the cascade is FE-side. If a Python API needs
   historical posterior data (e.g. for automated drift detection), the
   selection logic would need to be replicated or exposed. Recommendation:
   implement FE-side first; extract to shared utility if Python needs it.

3. **Should fit_history entries include the evidence fingerprint?** This
   would allow correlating "which evidence produced this fit" without
   git archaeology. The `fingerprint` field is the model hash, not the
   evidence hash. Adding `evidence_fingerprint` would increase
   traceability. Recommendation: consider for a future enrichment pass.
