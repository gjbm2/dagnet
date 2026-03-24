# Doc 19 — Model Vars: Production/Consumption Separation

**Status**: Design draft (simplified)
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

**Key**: the analytic fit is *constrained* by the user's t95 — so its output
t95 will equal (or closely match) the user's input. The Bayesian posterior
has its own t95 that is *not* constrained by the user's value.

### 2.4 Promotion (source selection)

`resolveActiveModelVars()` picks the winning entry. `applyPromotion()` writes
the winner's latency params to the edge. This is the bridge between
production and consumption.

**Change**: promotion writes `t95` to `promoted_t95` (a new field), not to
the user-configured `t95`. All other latency fields (`mu`, `sigma`,
`path_*`, `onset_delta_days`) continue writing where they do today — these
have no circular-dependency problem because the analytic fit does not read
them as constraints.

### 2.5 User overrides

**Per-field locks** (`_overridden` flags on the file): prevent system writes
to user-configured fields. Already exist and work correctly.

**The override IS the input constraint.** When a user overrides t95, they are
telling the analytic fit "constrain to this value". The fit honours it, its
output t95 reflects the constraint, that output gets promoted, and
consumption uses it. There is no need to separately override the promoted
output — the user's intent flows through the fit naturally.

**Manual model_vars entry**: created on direct edit of `p.mean`/`p.stdev`.
Selects via `model_source_preference: 'manual'`. Not needed for t95 — t95
edits are input constraints, not model-output overrides.

### 2.6 Consumption (display/scenario quantities)

The topo pass reads promoted values from the edge and computes:
- **completeness** — `logNormalCDF(age, mu, sigma)`
- **p_infinity** — recency-weighted k/n, mature relative to `promoted_t95`
- **blendedMean** — blend using completeness
- **path_t95** — FW composition or topo accumulation

These are display quantities. Not written back into any model_vars entry.

---

## 3. Minimal schema change: two new fields

### 3.1 The new fields

```
edge.p.latency.promoted_t95          ← NEW: winning model's t95 (written by applyPromotion)
edge.p.latency.promoted_path_t95     ← NEW: winning model's path_t95 (written by applyPromotion)
```

Everything else stays where it is:

```
edge.p.latency.t95              ← user-configured (from file, via UpdateManager) — UNCHANGED
edge.p.latency.t95_overridden   ← lock (from file) — UNCHANGED
edge.p.latency.path_t95         ← user-configured (from file, via UpdateManager) — UNCHANGED
edge.p.latency.path_t95_overridden ← lock (from file) — UNCHANGED
edge.p.latency.mu               ← promoted by applyPromotion (no circular problem) — UNCHANGED
edge.p.latency.sigma            ← promoted by applyPromotion (no circular problem) — UNCHANGED
edge.p.latency.path_mu          ← computed — UNCHANGED
edge.p.latency.path_sigma       ← computed — UNCHANGED
```

**Why only t95 and path_t95?** Both have the dual-role problem: they are
user-configurable input constraints (with `_overridden` locks) AND model
outputs written by promotion. `mu`, `sigma`, `path_mu`, `path_sigma` are
produced by the fit, not read as constraints — overwriting them is harmless.

### 3.2 Who writes what

| Writer | Writes | Does NOT write |
|---|---|---|
| UpdateManager (file→graph) | `t95`, `t95_overridden`, `path_t95`, `path_t95_overridden`, `onset_delta_days`, `mu`, `sigma`, etc. | `promoted_t95`, `promoted_path_t95` |
| `applyPromotion` | `promoted_t95`, `promoted_path_t95`, `mu`, `sigma`, `path_mu`, `path_sigma` | `t95`, `t95_overridden`, `path_t95`, `path_t95_overridden` |
| Persist (graph→file) | File's `mu`, `sigma` (for continuity); file's `t95`, `path_t95` from `promoted_*` **when unlocked** | File's `t95`, `path_t95` when locked (`_overridden: true`) |
| User | `t95`, `path_t95` (via UI), `_overridden` locks | `promoted_t95`, `promoted_path_t95` |

### 3.3 Who reads what

| Reader | Reads | Does NOT read |
|---|---|---|
| Analytic fit (production) | `t95` (user-configured, as sigma constraint) | `promoted_t95`, `promoted_path_t95` |
| Topo pass (consumption) | `mu`, `sigma`, `promoted_t95`, `promoted_path_t95` | `t95`, `path_t95` (user-configured) |
| Cohort retrieval planner | `promoted_t95` or `promoted_path_t95` (for window sizing) | `t95`, `path_t95` |
| Topo tail-pull (authoritative horizon) | `promoted_path_t95` | `path_t95` (user-configured) |
| Horizon persist | `mu`, `sigma` → file (continuity); `promoted_t95` → file's `t95` **when unlocked**; `promoted_path_t95` → file's `path_t95` **when unlocked** | File's `t95`/`path_t95` when locked |

### 3.4 Default behaviour: promoted equals user-configured

When the analytic source wins promotion, `promoted_t95` will equal (or
closely match) the user's `t95` — because the analytic fit is *constrained*
by that value. Similarly, `promoted_path_t95` will reflect the topo
composition of analytic-derived edge t95s. The user sets the input, the
output reflects it, and consumption sees what they expect.

The only time promoted values diverge from the user's inputs is when the
Bayesian source wins promotion. The Bayesian posterior has its own t95 and
path_t95 that are not constrained by the user's values.

---

## 4. What changes in the code

### 4.1 `applyPromotion` writes `promoted_t95` and `promoted_path_t95`

Currently writes the winning entry's t95 to `edge.p.latency.t95` and
path_t95 to `edge.p.latency.path_t95`. Changes to write to
`promoted_t95` and `promoted_path_t95` instead. All other field writes
(`mu`, `sigma`, `path_mu`, `path_sigma`, `onset_delta_days`) remain
unchanged.

### 4.2 Topo pass and planner read `promoted_*` for consumption

Where the topo pass currently reads `edge.p.latency.t95` for maturity
calculations and `edge.p.latency.path_t95` for tail-pull/horizon, it reads
`promoted_t95` and `promoted_path_t95` instead (falling back to the
unpromoted fields for backwards compatibility).

The window fetch planner similarly reads `promoted_path_t95` (falling back
to `promoted_t95`) for cohort window sizing and staleness classification.

### 4.3 Post-topo writeback removed

The block in fetchDataService that writes topo output into the analytic entry
is removed. The analytic entry is produced at fetch time by UpdateManager.
The topo pass is pure consumption.

### 4.4 Horizon persist: reads `promoted_*`, gates on override locks

`persistGraphMasteredLatencyToParameterFiles` changes to read from
`promoted_t95` / `promoted_path_t95` (the model's output) instead of
`t95` / `path_t95` (the user's input).

Write policy, gated by override locks:

- **`t95_overridden: true`** → do NOT write `promoted_t95` to file's `t95`.
  The user's value is authoritative.
- **`t95_overridden: false` (or absent)** → write `promoted_t95` to file's
  `t95`. The system manages the horizon.
- Same logic for `path_t95_overridden` / `promoted_path_t95`.
- `mu`/`sigma` always written (for bootstrap continuity), as today.

This preserves current semantics: locked = user controls, unlocked = system
updates from model output after each recompute.

### 4.5 UI changes

**Output card** (ModelVarsCards): the t95 and path_t95 fields in the Output
section become **read-only** (`RoField`), displaying `promoted_t95` and
`promoted_path_t95`. The user does not edit model output — they edit the
input constraints.

**Input/config side** (ParameterSection, Analytic card `LatencyZapOff`):
editable t95 and path_t95 stay here. This is where the user sets the
analytic fit constraints. The `_overridden` lock mechanism is unchanged.

**No manual model_vars entry for t95/path_t95**: the `hasModelVarOverride`
path in PropertiesPanel no longer needs to handle t95 or path_t95 edits
creating manual entries. These edits are input-constraint changes, not
model-output overrides.

**Model vars entry management on source cards**: two distinct actions,
reflecting the separation between the graph (live state) and parameter
files (history archive).

**Action 1: Retire current** (per-source, e.g. "Reset bayesian"):
- Removes the source's entry from `edge.p.model_vars[]` **on the graph
  only**.
- The parameter file retains the entry as history (fit_history).
- If this source was the active promoted source, re-run promotion so the
  next-best source takes over immediately.
- Next Bayesian run finds no current bayesian entry on the graph → the
  topology compiler falls back to analytic-derived mu/sigma as latency
  priors → Bayes gets a fresh start.
- Low-stakes, reversible: nothing is deleted from persistent storage,
  Bayes simply re-runs with clean priors on the next invocation.
- This is the normal corrective action when a Bayesian posterior has
  self-propagated into an unreasonable region.

**Action 2: Clear history** (per-source, e.g. "Clear bayesian history"):
- Removes all fit_history records for the source from the **parameter
  file**.
- **High-stakes**: fit_history is not just an audit trail — it will be
  used as a model input for edge volatility / meta-dispersion (how much
  an edge's parameters drift over time). Clearing it destroys signal.
- User should only need this if history is genuinely polluted (e.g.
  early runs with bad data that would skew volatility estimates).
- Does NOT affect the graph's current model_vars (use "Retire" for that).

Both actions apply to any source card (analytic, analytic_be, bayesian),
but the bayesian self-prior loop makes "Retire" most urgent there.

Both should log via sessionLogService.

### 4.6 Backwards compatibility

Edges without `promoted_t95`/`promoted_path_t95` (pre-migration): consumption
falls back to `edge.p.latency.t95`/`path_t95` as today. No breakage for
existing graphs.

---

## 5. User-flow walkthroughs

### 5.1 First enablement of latency

1. User sets `latency_parameter: true`.
2. System writes `t95 = DEFAULT_T95_DAYS (30)` to file (no override lock).
3. UpdateManager loads `t95 = 30` → `edge.p.latency.t95`.
4. Fetch triggers → analytic fit reads `t95 = 30` as constraint → entry
   with t95 ≈ 30.
5. `applyPromotion` → `promoted_t95 = 30`.
6. Topo pass computes `promoted_path_t95` from upstream composition.
7. Output card shows `promoted_t95 = 30` (read-only). ParameterSection
   shows `t95 = 30` (editable).
8. Persist (unlocked) → writes `promoted_t95 = 30` back to file's `t95`.
   Round-trips cleanly.

### 5.2 User tightens the horizon

1. User edits t95 from 30 → 14 in ParameterSection, locks it
   (`t95_overridden: true`).
2. File updated, UpdateManager pushes `t95 = 14` → edge.
3. Next fetch → analytic fit reads `t95 = 14` → entry with t95 ≈ 14.
4. `applyPromotion` → `promoted_t95 = 14`.
5. Output card shows 14. User sees their intent reflected.
6. Persist sees `t95_overridden: true` → does NOT overwrite file's `t95`.
   (Would be a no-op anyway since values match, but the lock is the
   semantic guarantee.)

### 5.3 Bayesian wins promotion

1. User's `t95 = 14` on the edge (their constraint, locked).
2. Bayesian posterior produces t95 = 85 (long tail in the data).
3. `model_source_preference` selects bayesian → `applyPromotion` writes
   `promoted_t95 = 85`.
4. Output card shows 85 (read-only). ParameterSection still shows 14 (the
   user's constraint).
5. Consumption uses 85 for completeness/maturity — the model's view of
   reality.
6. Persist sees `t95_overridden: true` → does NOT write 85 to file.
   **User's constraint survives.** If they switch back to analytic, the fit
   still uses 14.

This is the flow that is currently broken — today promotion stamps 85 onto
`t95`, destroying the user's 14.

### 5.4 User overrides path_t95

1. Topo computes `promoted_path_t95 = 46` from upstream composition.
2. User sets `path_t95 = 25` in ParameterSection, locks it.
3. File updated, UpdateManager pushes `path_t95 = 25` → edge.
4. Next fetch → topo tail-pull reads `promoted_path_t95` for consumption
   (the model's view). The user's `path_t95 = 25` does not constrain the
   topo composition — it is a file-level preference.
5. Persist sees `path_t95_overridden: true` → does NOT overwrite file's
   `path_t95 = 25`.

### 5.5 Global horizon recompute (Data menu)

1. User triggers "Latency horizons → Recompute all".
2. Topo pass runs for all edges → analytic fits re-run, each reading `t95`
   from the edge.
3. Promotion writes new `promoted_t95` / `promoted_path_t95`.
4. Persist runs:
   - Locked edges: file's `t95`/`path_t95` untouched.
   - Unlocked edges: file's `t95`/`path_t95` updated from `promoted_*`.
5. User's locked values survive. Unlocked values track the model.

### 5.6 Remove all horizon overrides (Data menu)

1. Clears all `t95_overridden` and `path_t95_overridden` locks.
2. Next recompute → persist writes `promoted_t95`/`promoted_path_t95` to
   the file's `t95`/`path_t95` (locks gone, system free to update).
3. The file's horizons now track the model output.
4. User can re-lock any edge at any time to regain control.

### 5.7 Set all horizon overrides (Data menu)

1. Sets all `t95_overridden` and `path_t95_overridden` locks.
2. File's current `t95`/`path_t95` values are frozen — persist will not
   overwrite them.
3. Analytic fit continues to use `t95` as its constraint. Model output
   appears in `promoted_t95` but does not flow back to the file.

---

## 6. Invariants

1. **User-configured `t95`/`path_t95` are never overwritten by promotion.**
   Promotion writes to `promoted_t95`/`promoted_path_t95`, separate fields.
   The user's values on `edge.p.latency.t95`/`path_t95` are only updated by
   the persist path, and only when the override lock is off.

2. **Override locks gate file writes, not promotion.** `t95_overridden`
   prevents persist from writing `promoted_t95` to the file. It does not
   affect what promotion writes to `promoted_t95` (that always reflects the
   winning model).

3. **Each source writes only to its own model_vars entry.** No source reads
   another source's output during production.

4. **Promotion does not touch `t95` or `path_t95`.** It writes
   `promoted_t95` and `promoted_path_t95`, plus the non-circular fields
   (`mu`, `sigma`, `path_mu`, `path_sigma`).

5. **Consumption reads `promoted_t95`/`promoted_path_t95` for horizons.**
   The topo pass and window planner do not read user-configured `t95` or
   `path_t95`.

6. **No circular dependencies.** User config → analytic production →
   model_vars entry. Promotion → `promoted_*`. Consumption reads promoted
   fields → display quantities. Display quantities do not feed back.
   Persist writes `promoted_*` → file only when unlocked, closing the loop
   without pollution.

7. **Overrides flow through the fit, not around it.** The user controls
   `t95` (the input constraint). The analytic fit honours it. The output
   reflects it. There is no mechanism to directly stamp a promoted value.

8. **Horizon persistence is lock-gated.** Persist writes `promoted_t95` →
   file's `t95` and `promoted_path_t95` → file's `path_t95` only when the
   corresponding `_overridden` lock is off. `mu`/`sigma` always persist
   (for bootstrap continuity).

---

## 7. Net effect (summary)

1. **User CAN override horizons** (`t95`, `path_t95`) to shape the analytic
   fit. The override is the input constraint; the fit honours it; the output
   reflects it.

2. **Otherwise, analytic curves are self-determining.** When unlocked, the
   system computes t95/path_t95 from the data, promotes the result, and
   persists it back to the file for the next run.

3. **Bayesian should use its own previous posteriors as latency priors**
   once available. The prior chain for Bayesian latency should be:

   1. Previous Bayesian posterior mu/sigma (from the `bayesian` model_vars
      entry on the edge, if it exists)
   2. Persisted mu/sigma from the parameter file (any source — analytic
      bootstrap)
   3. Derived from `median_lag_days`/`mean_lag_days`
   4. Derived from `t95` (with assumed sigma)
   5. Uninformative default (mu=0, sigma=0.5)

   **Current state**: the topology compiler (`bayes/compiler/topology.py`
   lines 112-139) reads `latency.mu`/`latency.sigma` from the edge's
   top-level latency block. It does not look at `model_vars[]` entries.
   This means it uses whatever was last persisted, regardless of source.

   **Change needed**: the compiler should first check for a `bayesian`
   entry in `edge.p.model_vars[]` and prefer its `latency.mu`/`.sigma`
   as the prior. This ensures the Bayesian chain builds on itself rather
   than being pulled toward the analytic fit's output on each run.
