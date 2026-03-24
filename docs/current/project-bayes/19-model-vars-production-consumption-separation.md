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

## 3. Minimal schema change: one new field

### 3.1 The only new field

```
edge.p.latency.promoted_t95     ← NEW: winning model's t95 (written by applyPromotion)
```

Everything else stays where it is:

```
edge.p.latency.t95              ← user-configured (from file, via UpdateManager) — UNCHANGED
edge.p.latency.t95_overridden   ← lock (from file) — UNCHANGED
edge.p.latency.mu               ← promoted by applyPromotion (no circular problem) — UNCHANGED
edge.p.latency.sigma             ← promoted by applyPromotion (no circular problem) — UNCHANGED
edge.p.latency.path_t95          ← computed, not user-configured — UNCHANGED
edge.p.latency.path_mu           ← computed — UNCHANGED
edge.p.latency.path_sigma        ← computed — UNCHANGED
```

**Why only t95?** `mu` and `sigma` are *produced* by the fit, not read as
constraints. Overwriting them on the edge is harmless — no circular
dependency. `path_*` are computed by the topo pass, not user-configured.
Only `t95` has the dual-role problem (input constraint AND model output).

### 3.2 Who writes what

| Writer | Writes | Does NOT write |
|---|---|---|
| UpdateManager (file→graph) | `t95`, `t95_overridden`, `onset_delta_days`, `mu`, `sigma`, etc. | `promoted_t95` |
| `applyPromotion` | `promoted_t95`, `mu`, `sigma`, `path_*` | `t95`, `t95_overridden` |
| Persist (graph→file) | File's `mu`, `sigma` (for continuity) | File's `t95` (NEVER overwritten by promotion) |
| User | `t95` (via UI), `t95_overridden` | `promoted_t95` |

### 3.3 Who reads what

| Reader | Reads | Does NOT read |
|---|---|---|
| Analytic fit (production) | `t95` (user-configured, as sigma constraint) | `promoted_t95` |
| Topo pass (consumption) | `mu`, `sigma`, `promoted_t95` | `t95` (user-configured) |
| Cohort retrieval planner | `promoted_t95` or `path_t95` (for window sizing) | `t95` |
| Horizon persist | `mu`, `sigma` → file (for continuity) | Does NOT write file's `t95` |

### 3.4 Default behaviour: promoted equals user-configured

When the analytic source wins promotion, `promoted_t95` will equal (or
closely match) the user's `t95` — because the analytic fit is *constrained*
by that value. The user sets the input, the output reflects it, and
consumption sees what they expect.

The only time `promoted_t95` diverges from the user's `t95` is when the
Bayesian source wins promotion. The Bayesian posterior has its own t95 that
is not constrained by the user's input.

---

## 4. What changes in the code

### 4.1 `applyPromotion` writes `promoted_t95`

Currently writes the winning entry's t95 to `edge.p.latency.t95`. Changes to
write to `edge.p.latency.promoted_t95` instead. All other field writes
(`mu`, `sigma`, `path_*`, `onset_delta_days`) remain unchanged.

### 4.2 Topo pass reads `promoted_t95` for consumption

Where the topo pass currently reads `edge.p.latency.t95` for maturity/window
calculations, it reads `promoted_t95` instead (falling back to `t95` for
backwards compatibility).

### 4.3 Post-topo writeback removed

The block in fetchDataService that writes topo output into the analytic entry
is removed. The analytic entry is produced at fetch time by UpdateManager.
The topo pass is pure consumption.

### 4.4 Horizon persist writes `mu`/`sigma` to file, not `t95`

`persistGraphMasteredLatencyToParameterFiles` writes `mu` and `sigma` to the
file (for bootstrap continuity). It does NOT write `promoted_t95` to the
file's `latency.t95`. The file's `t95` is user-controlled.

### 4.5 UI changes

**Output card** (ModelVarsCards): the t95 field in the Output section becomes
**read-only** (`RoField`), displaying `promoted_t95`. The user does not edit
the model's output — they edit the input constraint.

**Input/config side** (ParameterSection, Analytic card `LatencyZapOff`):
editable t95 stays here. This is where the user sets the analytic fit
constraint. The `_overridden` lock mechanism is unchanged.

**No manual model_vars entry for t95**: the `hasModelVarOverride` path in
PropertiesPanel no longer needs to handle t95 edits creating manual entries.
t95 edits are input-constraint changes, not model-output overrides.

### 4.6 Backwards compatibility

Edges without `promoted_t95` (pre-migration): consumption falls back to
`edge.p.latency.t95` as today. No breakage for existing graphs.

---

## 5. Invariants

1. **User-configured `t95` is never overwritten by model output.** It lives
   on the file, flows to `edge.p.latency.t95` via UpdateManager, and is read
   by the analytic fit. Promotion writes to `promoted_t95`, a separate field.

2. **Each source writes only to its own model_vars entry.** No source reads
   another source's output during production.

3. **Promotion does not touch `t95`.** It writes `promoted_t95` and the
   non-circular fields (`mu`, `sigma`, `path_*`).

4. **Consumption reads `promoted_t95` for horizons.** The topo pass does not
   read user-configured `t95`.

5. **No circular dependencies.** User config → analytic production →
   model_vars entry. Promotion → `promoted_t95`. Consumption reads promoted
   fields → display quantities. Display quantities do not feed back.

6. **Overrides flow through the fit, not around it.** The user controls
   `t95` (the input constraint). The analytic fit honours it. The output
   reflects it. There is no mechanism to directly stamp a promoted value.

7. **Horizon persistence writes model params (mu/sigma), not horizons
   (t95).** The file's `t95` is the user's domain. The file's `mu`/`sigma`
   are system-derived and persisted for continuity/bootstrap.
