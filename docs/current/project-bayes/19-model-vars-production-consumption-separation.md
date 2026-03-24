# Doc 19 — Model Vars: Production/Consumption Separation

**Status**: Design draft
**Date**: 24-Mar-26
**Purpose**: Clarify the boundary between *producing* model variable entries
and *consuming* promoted values for display. The current implementation
tangles these — in particular, model-derived horizons overwrite user-
configured horizons, polluting analytic fit inputs.

**Related**: Doc 15 (model vars provenance), programme.md (FE stats deletion)

---

## 1. The problem in one sentence

User-configured `t95` and model-output `t95` share one field. Writing the
promoted value destroys the user's value. The analytic fit then reads the
model output as if it were user guidance.

---

## 2. The six layers

### 2.1 Input data (evidence)

Observations from parameter files: `n`, `k`, `dates`, `n_daily`, `k_daily`,
`median_lag_days`, `mean_lag_days`. Fetched from Amplitude, stored in YAML
`values[]` entries, loaded via the fetch pipeline. Raw — no model produces
these.

### 2.2 Persisted configuration (parameter files)

Parameter files hold user-editable configuration for the analytic fit:

| Field | Meaning | Who writes | Who reads |
|---|---|---|---|
| `latency.t95` | User's horizon guidance ("tail extends at least this far") | User (UI/YAML), or system on first enablement | Analytic fit (as sigma constraint) |
| `latency.t95_overridden` | Lock — prevents system overwrite | User | Persist logic (gates writes) |
| `latency.onset_delta_days` | Dead-time before conversion starts | User or system | Analytic fit, consumption |
| `latency.onset_delta_days_overridden` | Lock | User | Persist logic |
| `latency.latency_parameter` | Whether this edge has latency | User | Everything |
| `latency.mu`, `.sigma` | Last-persisted model params | System (persist from graph) | Continuity / bootstrap |

**Horizon lifecycle (user-configured t95):**

1. **First enablement**: `latency_parameter` set to `true`. If no `t95`
   exists, system writes `DEFAULT_T95_DAYS` (currently 30).
2. **User adjusts**: User sets `t95` via Properties Panel or YAML. May lock
   it (`t95_overridden: true`).
3. **Analytic fit reads it**: The analytic fit uses `t95` as a one-way sigma
   constraint ("sigma must be wide enough that the lognormal's 95th
   percentile reaches at least t95").
4. **User's value must survive model runs.** If Bayesian computes t95=85
   days, that must not overwrite the user's t95=14.

### 2.3 Production (model var entries)

Three independent systems each produce a `ModelVarsEntry` (doc 15 §2.1):

| Source | Inputs | Produces |
|---|---|---|
| `analytic` | Evidence + user-configured t95 (as constraint) | probability + latency (mu/sigma/t95) |
| `analytic_be` | Same, Python side | Same structure |
| `bayesian` | Snapshot DB evidence, jointly with p (MCMC) | probability (posterior) + latency (posterior) |

Plus `manual` (user direct edit).

**Each system writes only to its own entry.** Independence is required for
comparison and fallback.

### 2.4 Promotion (source selection)

`resolveActiveModelVars()` picks the winning entry. `applyPromotion()` writes
the winner's latency params to `edge.p.latency.*`. This is the bridge between
production and consumption.

**New**: promotion writes to *promoted* fields (see §3), not to the user-
configured fields.

### 2.5 User overrides

**Per-field locks** (`_overridden` flags on the file): prevent system writes
to user-configured fields. Already exist and work correctly.

**Manual model_vars entry**: created on direct edit of `p.mean`/`p.stdev`.
Selects via `model_source_preference: 'manual'`.

**No override mechanism needed on promoted fields.** Promoted fields are pure
model output. If the user wants to override the active model, they either
lock the user-configured field (which constrains the analytic fit) or create
a manual entry (which wins promotion).

### 2.6 Consumption (display/scenario quantities)

The topo pass reads promoted values from the edge and computes:
- **completeness** — `logNormalCDF(age, promoted_mu, promoted_sigma)`
- **p_infinity** — recency-weighted k/n, mature relative to promoted t95
- **blendedMean** — blend using completeness
- **path_t95** — FW composition or topo accumulation

These are display quantities. Not written back into any model_vars entry.

---

## 3. New schema: separate user-configured and promoted horizons

### 3.1 Parameter file

No changes. `latency.t95` remains the user-configured horizon.
`latency.t95_overridden` remains the lock. These are never overwritten by
promotion.

### 3.2 Edge (`edge.p.latency`)

New promoted fields alongside the existing ones:

```
edge.p.latency.t95              ← user-configured (from file, via UpdateManager)
edge.p.latency.t95_overridden   ← lock (from file)

edge.p.latency.promoted_t95     ← NEW: winning model's t95 (written by applyPromotion)
edge.p.latency.promoted_mu      ← NEW: winning model's mu
edge.p.latency.promoted_sigma   ← NEW: winning model's sigma
edge.p.latency.promoted_path_t95    ← NEW: winning model's path_t95
edge.p.latency.promoted_path_mu     ← NEW: winning model's path_mu
edge.p.latency.promoted_path_sigma  ← NEW: winning model's path_sigma
```

No `_overridden` flags on promoted fields — they are pure model output.

### 3.3 Who writes what

| Writer | Fields written | Fields NOT written |
|---|---|---|
| UpdateManager (file→graph) | `t95`, `t95_overridden`, `onset_delta_days`, `mu`, `sigma`, `median_lag_days`, etc. | `promoted_*` |
| `applyPromotion` | `promoted_t95`, `promoted_mu`, `promoted_sigma`, `promoted_path_*` | `t95`, `t95_overridden` |
| Persist (graph→file) | File's `mu`, `sigma` (from promoted, for continuity) | File's `t95` (NEVER overwritten by promotion) |
| User | `t95` (via UI), `t95_overridden` | `promoted_*` |

### 3.4 Who reads what

| Reader | Reads | Does NOT read |
|---|---|---|
| Analytic fit (production) | `t95` (user-configured, as sigma constraint) | `promoted_*` |
| Topo pass (consumption) | `promoted_mu`, `promoted_sigma`, `promoted_t95` | `t95` (user-configured) |
| Cohort retrieval planner | `promoted_t95` or `promoted_path_t95` (for window sizing) | `t95` |
| Horizon persist | `promoted_t95`, `promoted_path_t95` → file's `mu`, `sigma` | Does NOT write file's `t95` |

---

## 4. What changes in the code

### 4.1 `applyPromotion` writes to `promoted_*` fields

Currently writes to `edge.p.latency.mu`, `.sigma`, `.t95`. Changes to write
to `edge.p.latency.promoted_mu`, `.promoted_sigma`, `.promoted_t95`, etc.
Stops writing to `mu`, `sigma`, `t95` (those remain file-mastered).

### 4.2 Topo pass reads `promoted_*` for consumption

`computeEdgeLatencyStats` gets new optional params `promotedMu`,
`promotedSigma`. When present, uses them for the completeness CDF instead of
re-fitting. The analytic fit still runs (using `t95` from the file as its
constraint) to produce the analytic entry.

### 4.3 Post-topo writeback removed

The block in fetchDataService that writes topo output into the analytic entry
is removed. The analytic entry is produced at fetch time by UpdateManager.
The topo pass is pure consumption.

### 4.4 Horizon persist writes `mu`/`sigma` to file, not `t95`

`persistGraphMasteredLatencyToParameterFiles` writes `promoted_mu` and
`promoted_sigma` to the file's `latency.mu`/`.sigma` (for bootstrap
continuity). It does NOT write `promoted_t95` to the file's `latency.t95`.
The file's `t95` is user-controlled.

### 4.5 Backwards compatibility

Edges without `promoted_*` fields (pre-migration): the topo pass falls back
to `edge.p.latency.mu`/`.sigma`/`.t95` as today (these are the analytic-
derived values from UpdateManager). No breakage for existing graphs.

---

## 5. Invariants

1. **User-configured `t95` is never overwritten by model output.** It lives
   on the file, flows to `edge.p.latency.t95` via UpdateManager, and is read
   by the analytic fit. Promotion writes to `promoted_t95`, a separate field.

2. **Each source writes only to its own model_vars entry.** No source reads
   another source's output during production.

3. **Promotion writes only to `promoted_*` fields.** It does not touch
   user-configured fields or file-mastered fields.

4. **Consumption reads only `promoted_*` fields.** The topo pass does not
   read user-configured `t95` or resolve model_vars. Source-agnostic.

5. **No circular dependencies.** User config → analytic production →
   model_vars entry. Promotion → promoted fields. Consumption reads promoted
   fields → display quantities. Display quantities do not feed back.

6. **Horizon persistence writes model params (mu/sigma), not horizons
   (t95).** The file's `t95` is the user's domain. The file's `mu`/`sigma`
   are system-derived and persisted for continuity/bootstrap.
