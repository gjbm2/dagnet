# Doc 15 — Model Variables: Provenance, Selection, and Scalar Promotion

**Status**: Draft
**Date**: 20-Mar-26
**Purpose**: Design for storing multiple model variable sets with provenance
on graph edges, selecting among them, and promoting the selected set to the
flat scalars that the rest of the system consumes.

**Supersedes**: programme.md §"Model variable precedence and source
provenance" and doc 9 §5.7–5.8 (model source UI). Those sections described
a cascade-based approach with `model_source` metadata blocks. This document
replaces that with a cleaner pattern: structured model var entries on the
edge, a pure selection function, and the existing `_overridden` guard
semantics folded into the model_vars structure.

**Related**: `programme.md` (programme), `9-fe-posterior-consumption-and-overlay.md` (FE overlay),
`13-model-quality-gating-and-preview.md` (quality gating)

---

## 1. Principles

1. **Both analytic and Bayesian model vars live on the graph edge as
   first-class peers.** Neither is privileged structurally; the difference
   is provenance.

2. **The promoted scalars (`p.mean`, `p.stdev`, `latency.mu`, etc.) are
   derived from whichever model var entry the resolution function selects.**
   They are not duplicated per source.

3. **UpdateManager stays a dumb data sync.** It copies fields between files
   and graph. It does not resolve which source to promote — that is the
   resolution function's job.

4. **Manual user input is a model var entry, not a separate override
   mechanism.** When the user edits `p.mean`, the system snapshots the
   current promoted scalars into a `source: 'manual'` entry, applies the
   edit, and selects that entry. The `_overridden` guard semantics are
   captured by the existence and selection of the manual entry.

5. **Selection preference follows the connection/default_connection
   pattern.** Graph-level default, overrideable per edge. Not a cascade —
   a simple inheritance with local override.

6. **Graceful degradation is inspectable.** When the system falls back from
   Bayesian to analytic (quality gate failure, missing posterior), the
   analytic vars are right there on the edge. The user can see both sets
   and understand why one was chosen.

---

## 2. Data model

### 2.1 ModelVarsEntry

A provenance-tagged set of model variables. Each entry is a complete
snapshot from one source — no sparse entries, no per-field mixing.

```typescript
interface ModelVarsEntry {
  source: 'analytic' | 'bayesian' | 'manual';
  source_at: string;  // d-MMM-yy — when this entry was last updated

  probability: {
    mean: number;      // [0,1]
    stdev: number;     // >= 0
  };

  latency?: {
    mu: number;              // log-normal location
    sigma: number;           // log-normal scale
    t95: number;             // 95th percentile (days) = exp(mu + 1.645 * sigma) + onset
    onset_delta_days: number;
    // Path-level (cohort) — present when path model is available
    path_mu?: number;
    path_sigma?: number;
    path_t95?: number;
  };

  // Bayesian-specific metadata (present only when source === 'bayesian')
  quality?: {
    rhat: number;
    ess: number;
    divergences: number;
    evidence_grade: number;
    gate_passed: boolean;  // meetsQualityGate() result at write time
  };
}
```

**Complete entries only.** When the user edits one field (e.g. `p.mean`),
the system copies ALL current promoted scalars into the manual entry, then
applies the edit. The manual entry is always a full snapshot of
"the world as the user wants it."

**Why complete, not sparse.** Sparse manual entries require per-field
resolution ("manual mean + bayesian stdev") which creates mixed-source
promoted scalars. Complete entries keep resolution simple: pick an entry,
promote all its fields. No stitching.

### 2.2 Where model_vars lives

On `ProbabilityParam` (i.e. `edge.p`):

```typescript
interface ProbabilityParam {
  // ... existing fields ...

  /** Candidate model variable sets from different sources */
  model_vars?: ModelVarsEntry[];

  // Promoted scalars (unchanged — these remain the consumption interface)
  mean?: number;
  stdev?: number;
  // ... latency.mu, latency.sigma, etc. unchanged ...
}
```

The promoted scalars and `model_vars` coexist on the same object.
`model_vars` is the ledger; the promoted scalars are the working values.

### 2.3 model_source_preference

**Graph level** (default for all edges):

```typescript
interface ConversionGraph {
  // ... existing fields ...

  /** Which model var source to promote to scalars. Default: 'best_available'. */
  model_source_preference?: 'best_available' | 'bayesian' | 'analytic';
}
```

**Edge level** (optional override):

```typescript
interface ProbabilityParam {
  // ... existing fields ...

  /** Per-edge override of graph.model_source_preference.
   *  If present, takes precedence over graph-level setting.
   *  Set automatically when user creates a manual entry.
   *  Cleared when user explicitly reverts to graph default.
   */
  model_source_preference?: 'best_available' | 'bayesian' | 'analytic' | 'manual';
}
```

Note: `'manual'` is valid only at edge level (a graph-level "manual" makes
no sense). The edge-level preference does not need an `_overridden` flag
because it is inherently a user choice — no automated pipeline writes it.
Its absence means "inherit from graph." Its presence means "I've chosen."

---

## 3. Resolution function

A pure function, no side effects. Called at display/calc time.

```
resolveActiveModelVars(
  modelVars: ModelVarsEntry[],
  preference: 'best_available' | 'bayesian' | 'analytic' | 'manual'
): ModelVarsEntry | undefined
```

**Selection logic:**

1. If `preference === 'manual'` — return the `source: 'manual'` entry if
   present, else fall through to `'best_available'`.

2. If `preference === 'bayesian'` — return the `source: 'bayesian'` entry
   if present AND `quality.gate_passed === true`. Else fall back to
   `source: 'analytic'`.

3. If `preference === 'analytic'` — return the `source: 'analytic'` entry.

4. If `preference === 'best_available'` (default) — Bayesian if present and
   quality-gated, else analytic.

**Effective preference** (combining graph + edge levels):

```
effectivePreference =
  edge.p.model_source_preference   // edge-level override, if present
  ?? graph.model_source_preference  // graph-level default
  ?? 'best_available'               // system default
```

The resolution function runs with the effective preference and the edge's
`model_vars` array. It returns the winning entry. The caller promotes that
entry's values to the flat scalars.

---

## 4. Scalar promotion

When the resolution function selects an entry, its values are written to
the promoted scalar positions:

| ModelVarsEntry field | Promoted scalar |
|---|---|
| `probability.mean` | `edge.p.mean` |
| `probability.stdev` | `edge.p.stdev` |
| `latency.mu` | `edge.p.latency.mu` |
| `latency.sigma` | `edge.p.latency.sigma` |
| `latency.t95` | `edge.p.latency.t95` |
| `latency.onset_delta_days` | `edge.p.latency.onset_delta_days` |
| `latency.path_mu` | `edge.p.latency.path_mu` |
| `latency.path_sigma` | `edge.p.latency.path_sigma` |
| `latency.path_t95` | `edge.p.latency.path_t95` |

The promoted scalars are the ONLY interface consumed by:
- Edge rendering (`buildScenarioRenderEdges`)
- BE analysis (`_read_edge_model_params` / `_resolve_completeness_params`)
- Statistical enhancement (blend calculations)
- Downstream propagation (forecast.k, inbound-n)

Nothing downstream reads `model_vars` directly. The promoted scalars are
the consumption API; `model_vars` is the provenance ledger.

---

## 5. How each source populates its entry

### 5.1 Analytic source

**Writer**: The existing analytic pipeline — data fetch → LAG pass →
`statisticalEnhancementService` → file write → UpdateManager cascade.

**When it writes**: On data retrieval (batch or single), the LAG pass
computes mu/sigma from histogram data and writes to the parameter file.
The UpdateManager cascade copies these to the graph edge.

**Change needed**: After the cascade populates `edge.p.latency.mu`,
`edge.p.latency.sigma`, etc., upsert a `source: 'analytic'` entry in
`model_vars` with the current analytic values. This can be done as a
post-cascade step in the same update — not a separate service.

For probability, the analytic `mean` is `values[latest].mean` (which
today is either `k/n` from evidence or the Bayesian `α/(α+β)` — see §7
for how to separate these). The analytic `stdev` is
`values[latest].stdev`.

### 5.2 Bayesian source

**Writer**: Bayes webhook → `bayesPatchService.applyPatch()`.

**When it writes**: On patch application. The patch carries posterior
summaries per edge.

**Change needed**: `applyPatch()` already writes `edge.p.posterior` and
`edge.p.latency.posterior` on the graph. Additionally, upsert a
`source: 'bayesian'` entry in `model_vars` with:

- `probability.mean = α / (α + β)`
- `probability.stdev = sqrt(αβ / ((α+β)² × (α+β+1)))`
- `latency.mu = posterior.mu_mean`
- `latency.sigma = posterior.sigma_mean`
- `latency.t95 = exp(mu + 1.645 × sigma) + onset`
- `latency.onset_delta_days = posterior.onset_delta_days`
- Path-level fields from `posterior.path_*` when present
- `quality = { rhat, ess, divergences, evidence_grade, gate_passed }`

The quality gate is evaluated once here. `gate_passed` is persisted so
downstream consumers don't re-evaluate with potentially different
thresholds.

### 5.3 Manual source

**Writer**: The FE, in response to user edits of promoted scalars.

**When it writes**: When the user edits any scalar field that is part of
the model vars (mean, stdev, mu, sigma, t95, onset).

**Flow**:

1. User edits `p.mean` (or any model var scalar) in the PropertiesPanel
2. System reads current promoted scalars → snapshots into a complete
   `ModelVarsEntry` with `source: 'manual'`, `source_at: now`
3. Applies the user's edit to the snapshot
4. Upserts this entry into `edge.p.model_vars`
5. Sets `edge.p.model_source_preference = 'manual'`
6. Promoted scalars update from the manual entry
7. Normal graph dirty tracking / persistence follows

Subsequent edits update the existing manual entry in place (no
re-snapshot — it's already complete).

### 5.4 Future sources

The `source` field is a string, not a closed enum. Future sources
(cross-graph prior transfer, ensemble model, etc.) add new entries
without schema changes to the structure.

---

## 6. Interaction with _overridden flags

### 6.1 Current state

Today, `mean_overridden`, `stdev_overridden`, `t95_overridden`,
`onset_delta_days_overridden` etc. serve as guards on the UpdateManager
cascade: "if overridden, don't copy from file."

### 6.2 Transition

With model_vars, these guards become redundant for model var fields:
- Automated pipelines write to their own `model_vars` entries, not to
  promoted scalars
- The resolution function selects which entry's values to promote
- Manual values are safe because they live in the manual entry

However, the `_overridden` flags serve a second purpose: they prevent
the UpdateManager from overwriting user-set values on the promoted
scalars. During transition, we keep the existing `_overridden` flags
working as today. The manual model_vars entry is the source of truth
for "what the user set"; the `_overridden` flags are a backward-compat
guard.

### 6.3 End state

Once model_vars is the primary mechanism:
- `mean_overridden` is derivable: `true` iff a `source: 'manual'` entry
  exists in `model_vars` AND `model_source_preference === 'manual'`
- The `_overridden` flags can be deprecated (derived rather than stored)
- UpdateManager mappings for model var fields can drop the `overrideFlag`
  because they write to `model_vars` entries, not to promoted scalars

This is a future simplification, not a prerequisite for shipping.

---

## 7. The probability identity problem

Today, `mergePosteriorsIntoParam` writes `values[0].mean = α/(α+β)` and
`values[0].stdev` from the Bayesian posterior. This means
`values[latest].mean` — which the cascade copies to `edge.p.mean` — is
already Bayesian, not analytic. The analytic value (`k/n` from evidence
or blend output) has been overwritten.

Under model_vars this must change:

**Option A — stop overwriting `values[0].mean` in the webhook.**
`values[0].mean` stays as the analytic pipeline's output. The Bayesian
mean lives only in `posterior.alpha/beta` (and in the `model_vars`
Bayesian entry). The cascade copies `values[0].mean` → promoted `p.mean`
as today; the resolution function then overwrites the promoted scalar if
Bayesian is selected.

**Option B — add an `analytic` sub-block to the parameter file.**
`values[0].analytic_mean` / `values[0].analytic_stdev` preserve the
analytic values. The webhook continues to write `values[0].mean` from
the posterior. The analytic model_vars entry reads from the
`analytic_*` fields.

**Recommendation: Option A.** It's the smallest change. `values[0].mean`
returns to being "the value from the data pipeline" (which is what it
was before the Bayes webhook started overwriting it). The Bayesian mean
is always derivable from `posterior.alpha/beta`. The model_vars entries
are populated at cascade/patch time, not stored redundantly on the
parameter file.

**Impact**: `mergePosteriorsIntoParam` stops writing `values[0].mean`
and `values[0].stdev`. Instead, `applyPatch` populates the Bayesian
`model_vars` entry on the graph edge directly. The parameter file's
`values[0]` stays analytic.

---

## 8. Where resolution runs

### 8.1 FE display and calculation

Resolution is called whenever the system needs promoted scalars:
- `buildScenarioRenderEdges` (edge display)
- `statisticalEnhancementService` (blend calculations)
- PropertiesPanel (scalar display)
- Any analysis computation that reads `p.mean` or `latency.*`

In practice, resolution runs as part of the graph update cycle. When
`model_vars` or `model_source_preference` changes, the promoted scalars
are recomputed and the graph revision increments. Downstream consumers
read promoted scalars as today — they don't call the resolution function
directly.

### 8.2 BE analysis

`_read_edge_model_params` reads from the graph edge, which already has
promoted scalars. No change needed to the BE — it reads `latency.mu`,
`latency.sigma` as today. Those values are already resolved.

The Bayesian overlay curve continues to read from `latency.posterior`
for comparison rendering. When the active source IS Bayesian, the
overlay could show the analytic vars for comparison (reading from the
analytic `model_vars` entry).

### 8.3 On preference change

User changes `model_source_preference` on the graph (or on an edge).
This triggers a re-resolution of promoted scalars for affected edges.
No file writes, no cascade, no async recompute. The `model_vars`
entries are already on the graph — the resolution function just picks a
different one and updates the promoted scalars.

This is instant. The user can flip between sources and see the effect
immediately.

---

## 9. Scalar surface area inventory

Complete list of scalars that are model vars (appear in
`ModelVarsEntry`) vs those that are NOT model vars (observed data,
configuration, or derived quantities).

### Model var scalars (in ModelVarsEntry)

| Scalar | Current location | Source: analytic | Source: bayesian |
|---|---|---|---|
| `mean` | `edge.p.mean` | `values[latest].mean` (k/n or blend) | `α / (α + β)` |
| `stdev` | `edge.p.stdev` | `values[latest].stdev` (binomial SE or blend) | `sqrt(αβ / ((α+β)²(α+β+1)))` |
| `mu` | `edge.p.latency.mu` | LAG pass MLE fit | `posterior.mu_mean` |
| `sigma` | `edge.p.latency.sigma` | LAG pass MLE fit | `posterior.sigma_mean` |
| `t95` | `edge.p.latency.t95` | `exp(mu + 1.645σ) + onset` | `exp(mu + 1.645σ) + onset` (from posterior means) |
| `onset_delta_days` | `edge.p.latency.onset_delta_days` | Histogram min | `posterior.onset_delta_days` |
| `path_mu` | `edge.p.latency.path_mu` | Fenton-Wilkinson composition | `posterior.path_mu_mean` |
| `path_sigma` | `edge.p.latency.path_sigma` | Fenton-Wilkinson composition | `posterior.path_sigma_mean` |
| `path_t95` | `edge.p.latency.path_t95` | `exp(path_mu + 1.645 × path_sigma) + path_onset` | Same from posterior |

### NOT model var scalars (unchanged, not in ModelVarsEntry)

| Scalar | Why not a model var |
|---|---|
| `evidence.n`, `evidence.k` | Observed data, not fitted |
| `evidence.mean`, `evidence.stdev` | Raw observed rate (k/n), not model output |
| `evidence.window_from/to` | Observation window metadata |
| `latency.median_lag_days`, `latency.mean_lag_days` | Observed summary stats |
| `latency.completeness` | Derived display metric |
| `latency.model_trained_at` | Timestamp metadata |
| `latency.latency_parameter` | Configuration flag |
| `latency.anchor_node_id` | Graph topology, not model |
| `forecast.mean` | Derived from model vars + blend logic, not a model var itself |
| `forecast.k`, `p.n` | Downstream derived quantities |
| `distribution` | User choice, not model output |
| `connection`, `connection_string` | Data source config |
| `data_source.*` | Provenance for data retrieval, not model |
| `posterior.*` | Full Bayesian diagnostic structure — model_vars.quality carries the relevant summary |

---

## 10. Interaction with conditional_probability

`ConditionalProbability` entries carry their own `p: ProbabilityParam`.
Each conditional gets its own `model_vars` array. The same resolution
function applies per conditional.

The graph-level `model_source_preference` cascades to conditionals the
same way it cascades to the base probability. No separate preference
per conditional (unless the user overrides at the conditional level —
same mechanism as edge-level override).

---

## 11. Interaction with forecast (blend)

`forecast.mean` is NOT a model var — it's derived from model vars plus
the blend formula in `statisticalEnhancementService`. When the active
model var set changes (e.g. preference switches from analytic to
Bayesian), the blend recomputes using the new `p.mean` and
`latency.mu`/`sigma`.

The blend itself doesn't know about model_vars. It reads promoted
scalars. This is correct — the blend is a consumption step, not a model.

---

## 12. File-level storage

### 12.1 Parameter files

Parameter files do NOT store `model_vars`. They store the raw outputs
of each pipeline:

- `values[].mean/stdev` — analytic pipeline output
- `posterior.*` — Bayesian pipeline output
- `latency.mu/sigma` — analytic LAG pass output
- `latency.posterior.*` — Bayesian latency output

`model_vars` is assembled at cascade time (file → graph) from these
raw outputs. This avoids redundancy — the file is the source; the
graph edge's `model_vars` is the assembled view.

### 12.2 Graph files

Graph files DO store `model_vars` (and `model_source_preference`)
because the graph is the primary working document. When the graph is
saved/committed, `model_vars` is persisted. On reload, the cascade
re-populates from files and the resolution function re-promotes.

### 12.3 Edges without parameter files

The system works without files. `model_vars` can be populated directly
on the graph edge (e.g. by `applyPatch`, by manual entry, or by future
sources). The file → graph cascade is one population path, not the only
path.

---

## 13. Migration

### 13.1 Existing graphs (no model_vars)

When `model_vars` is absent, the system behaves exactly as today:
promoted scalars are consumed directly, `_overridden` flags work as
guards. No migration needed — absence of `model_vars` means "legacy
mode."

### 13.2 Populating model_vars on existing edges

On first cascade after the feature lands, the cascade populates the
analytic `model_vars` entry from the file's values. If a posterior
exists, it also populates the Bayesian entry. Default
`model_source_preference` is `'best_available'`.

For edges where the webhook previously overwrote `values[0].mean` with
the Bayesian value, the analytic model_vars entry will initially contain
the Bayesian value (since that's what `values[0].mean` holds). This is
slightly incorrect but self-corrects on the next data retrieval, which
writes a fresh analytic `values[0].mean`.

### 13.3 _overridden flags

Retained during transition. An edge with `mean_overridden = true` and
no manual model_vars entry gets a manual entry synthesised from the
current promoted scalars on first load. `model_source_preference` is
set to `'manual'` on that edge.

---

## 14. Impact summary

### 14.1 Type changes

| File | Change |
|---|---|
| `src/types/index.ts` | Add `ModelVarsEntry` interface. Add `model_vars?: ModelVarsEntry[]` and `model_source_preference?` to `ProbabilityParam`. Add `model_source_preference?` to `ConversionGraph`. |
| `lib/graph_types.py` | Matching Pydantic models. |
| `public/param-schemas/parameter-schema.yaml` | No change — model_vars is graph-side only, not in param files. |

### 14.2 Write-path changes

| Component | Change |
|---|---|
| `bayesPatchService.applyPatch()` | Upsert `source: 'bayesian'` model_vars entry on each edge. Stop writing `values[0].mean/stdev` from posterior (§7 Option A). |
| `mergePosteriorsIntoParam()` | Stop writing `values[0].mean/stdev`. Continue writing `posterior.*` and `latency.posterior.*` to param files as today. |
| UpdateManager file→graph cascade | After existing field copies, upsert `source: 'analytic'` model_vars entry from the cascaded values. |
| PropertiesPanel scalar edits | On manual edit: snapshot current promoted vars → upsert `source: 'manual'` entry → set edge `model_source_preference = 'manual'`. |

### 14.3 Read-path changes

| Component | Change |
|---|---|
| Resolution function (new) | Pure function: `(model_vars, preference) → selected entry`. |
| Scalar promotion (new) | After resolution, copy selected entry's fields to promoted scalar positions. Runs as part of graph update cycle. |
| `buildScenarioRenderEdges` | No change — reads promoted scalars. |
| `_read_edge_model_params` | No change — reads promoted scalars from graph edge. |
| `_resolve_completeness_params` | No change — reads promoted scalars. |
| `statisticalEnhancementService` | No change — reads promoted scalars. |
| Edge rendering | No change — reads promoted scalars. |

### 14.4 UI design

See §17 for the full UI specification. Summary of component changes:

| Component | Change |
|---|---|
| ParameterSection | Three-card layout (Bayesian, Analytic, Manual) with toggle-based source selection. Replaces current flat scalar layout for model var fields. |
| Graph Properties | `model_source_preference` dropdown (Auto / Bayesian / Analytic). Summary row. Last Bayes fit info. |
| PropertiesPanel scalar edits | Manual entry creation flow: snapshot → upsert → flip source. |
| PosteriorIndicator | Show active source in popover. |
| Distribution dropdown | Remove (stub, no runtime effect). |

### 14.5 No changes needed

UpdateManager mapping engine, mapping declarations for non-model-var
fields, edge rendering pipeline, composition/scenario system, analysis
services (they read promoted scalars), graph store persistence,
FileRegistry, IDB.

---

## 15. Implementation sequence

### Phase 1: Types and resolution function

Add `ModelVarsEntry`, `model_vars`, `model_source_preference` types.
Implement `resolveActiveModelVars()` as a pure utility function with
tests. No behavioural change — nothing calls it yet.

### Phase 2: Write paths

Modify `applyPatch` to upsert Bayesian model_vars entry. Modify
cascade to upsert analytic model_vars entry. Stop overwriting
`values[0].mean` from posterior. Wire scalar promotion after resolution.

At this point, edges with both analytic and Bayesian data have both
entries in `model_vars`. `'best_available'` preference causes Bayesian
to be promoted (when quality passes), matching current behaviour for
probability but now extending to latency.

### Phase 3: Manual entry and preference UI

Wire PropertiesPanel manual edits to create manual model_vars entries
(§5.3 flow). Implement the three-card layout in ParameterSection
(§17.2) with toggle-based source selection (§17.3). Add
`model_source_preference` dropdown to Graph Properties (§18). Remove
distribution dropdown (§17.5).

### Phase 4: Comparison and polish

Bayesian card quality section, data summary inline chart (§17.4),
graph properties summary row and last-fit info (§18.2–18.3). Override
flag surfacing in edge properties summary.

---

## 16. Open questions

1. **Should `forecast.mean` also be in ModelVarsEntry?** It's derived
   (blend of model vars + evidence) but it's source-dependent — a
   Bayesian source produces a different forecast than analytic. Currently
   it's recomputed; storing it in model_vars would make comparison
   views richer but adds a derived field to what should be a pure-model
   structure. Recommend: no, keep it derived.

2. **Graph-level model_vars summary?** The `_bayes` metadata block
   carries graph-level quality metrics. Should there be a graph-level
   model_vars summary (e.g. "8 edges Bayesian, 2 analytic, 1 manual")?
   This is a display concern, not a data model question — derivable by
   scanning edges. No schema impact.

3. **Bayesian model_vars entry without latency?** The compiler already
   produces both probability AND latency posteriors (Phase D is
   substantially implemented: `model.py` emits `p_window`/`p_cohort`
   with `sigma_temporal`/`tau_cohort`, latent cohort latency vars
   `onset_cohort`/`mu_cohort`/`sigma_cohort`, and BetaBinomial/
   DirichletMultinomial likelihoods; `inference.py` extracts
   `path_mu_mean`/`path_sigma_mean` into `LatencyPosterior`;
   `bayesPatchService` writes these to graph edges).

   So in practice, the Bayesian model_vars entry will have BOTH
   `probability` and `latency` domains populated for edges with data.
   The latency field on ModelVarsEntry should remain optional for edges
   where the compiler skipped latency fitting (no histogram data, no
   anchor), and resolution handles the absent case by falling back to
   the analytic entry's latency. This is per-domain resolution (two
   domains: probability, latency), not per-field stitching.

4. **Cost params?** `CostParam` has the same `mean`/`stdev` pattern
   but no Bayesian source today. The model_vars pattern could extend
   to cost params in future but is not needed now. No action.

   **Design debt**: the current `CostParam` and `ProbabilityParam`
   share similar scalar/override patterns but are structurally
   independent. If model_vars proves successful on probability params,
   extending it to cost params would unify the pattern. Tracked in
   programme.md as future work.

---

## 17. UI design — Edge Properties (ParameterSection)

### 17.1 Layout overview

The ParameterSection for a probability parameter is reorganised into
zones:

1. **Config fields** (above cards): Parameter ID, Data Source,
   Latency Tracking checkbox, Anchor node.
2. **Source cards** (the core of this design): Three cards
   — Bayesian (collapsible), Analytic (collapsible), Output (always
   expanded) — each with a toggle.
3. **Query** (below cards): The query DSL expression (existing field,
   unchanged).

The config fields and query are outside model var selection — they are
parameter-level settings that don't change with source.

### 17.2 Source cards

Three cards, always present, in fixed order: **Bayesian**, **Analytic**,
**Output**.

Each card has:
- **Header**: source name (left), active badge (centre-right), toggle
  (far right).
- **Body**: source-specific fields (collapsible).

#### 17.2.1 Bayesian card

Read-only. Displays the `source: 'bayesian'` model_vars entry.

Fields shown:
- **Probability**: mean, stdev, HDI (from posterior α/β)
- **Latency**: mu, sigma, onset (from posterior — read-only, NOT an
  overridable input here), t95, path-level (mu, sigma, t95) when
  present, HDI ranges
- **Quality**: rhat, ESS, divergences, evidence_grade, gate_passed
- **Fitted**: `source_at` date

If no Bayesian entry exists (model not yet run), the card body shows
a placeholder: "No Bayesian model available."

**Future**: fit_guidance annotations (user-provided hints to the Bayes
engine, e.g. prior overrides) will appear in this card as editable
fields. Not in scope for initial implementation.

#### 17.2.2 Analytic card

Mostly read-only. Shows the analytic fitting parameters and
overridable inputs — NOT the promoted output scalars (those appear
in the Output card to avoid duplication).

Fields shown:
- **Latency fit**:
  - mu, sigma (read-only — from LAG pass MLE fit)
  - **onset** (overridable — ZapOff pattern, `onset_delta_days_overridden`)
  - **t95** (overridable — ZapOff pattern, `t95_overridden`)
  - **path_t95** (overridable — ZapOff pattern, `path_t95_overridden`)
- **Retrieved**: `source_at` date

Probability mean/stdev and path_mu/path_sigma are promoted output
scalars — they appear in the Output card, not here.

The overridable fields (onset, t95, path_t95) are analytic model
inputs — they steer the analytic pipeline. They are NOT used by the
Bayesian engine and NOT part of manual specification. They live in the
Analytic card because they are meaningful only in the context of
analytic fitting.

**Onset clarification**: onset is currently conflated between analytic
and Bayesian contexts. Under this design:
- **Analytic onset**: user-overridable input that shifts the analytic
  latency curve. Lives in the Analytic card. This is the existing
  `onset_delta_days` + `onset_delta_days_overridden` pattern.
- **Bayesian onset**: a latent variable estimated by the model (doc 18,
  `18-latent-onset-design.md`). The histogram-derived onset enters as
  a soft observation; a graph-level hyperprior and learned dispersion
  (`tau_onset`) govern partial pooling across edges. The posterior
  onset (mean ± sd, HDI) is a derived output. Displayed read-only in
  the Bayesian card — NOT an input the user overrides here. The
  Bayesian model does NOT consume the user's analytic onset override
  as a prior, avoiding feedback loops.

Doc 18 specifies the full compiler-side design (latent edge-level onset,
path-level onset with learned dispersion, identifiability analysis,
FE consumption changes). Sequenced as Phase D.O in programme.md.

#### 17.2.3 Output card (data model: `source: 'manual'`)

**UI label: "Output".** Always expanded (not collapsible). Shows the
promoted scalar values — the numbers the rest of the system consumes.
All fields are editable.

When no manual entry exists:
- Fields show the current promoted values (from whichever source is
  active) as **read-only** placeholders.
- Editing any field triggers the manual entry creation flow (§5.3):
  snapshot all current promoted scalars → create manual entry → apply
  edit → set `model_source_preference = 'manual'` → toggle flips to
  green.

When a manual entry exists:
- Fields show the manual entry's values, all editable.
- Subsequent edits update the manual entry in place.

Fields shown:
- **Probability**: mean, stdev
- **Latency** (if latency tracking enabled): mu, sigma, t95,
  onset_delta_days, path-level fields

The Output card is fundamentally different from Bayesian/Analytic:
those show model parameters and fitting inputs; Output shows the
promoted scalars that the system actually uses. When the user edits
here, they are saying "use these numbers" — direct output
specification, not model guidance.

### 17.3 Toggle behaviour and source selection

#### 17.3.1 Toggle states

Each card's toggle has two visual states:

- **Grey (outline)**: auto-selected. The system chose this source via
  `resolveActiveModelVars()`. The user has not pinned a preference.
- **Green (filled)**: user-pinned. The user explicitly selected this
  source. `model_source_preference_overridden` is set on the edge.

At most one toggle is green at any time. When a toggle is switched to
green, any other green toggle reverts to off (grey or hidden).

#### 17.3.2 Hover behaviour

When the user hovers over a grey (auto-on) toggle, it previews as
green — indicating "click to pin this choice." Clicking converts it
from auto-on to user-pinned (green), setting
`edge.p.model_source_preference` to that source and setting
`model_source_preference_overridden = true`.

#### 17.3.3 All toggles off = auto mode

When no toggle is green, the edge uses `best_available` resolution
(inheriting from graph-level preference). The system auto-selects the
best source, and that card's toggle shows as grey (auto-on).

#### 17.3.4 Manual card toggle

The Manual card toggle follows the same grey/green pattern. When the
user edits a scalar in the Manual card, the toggle automatically flips
to green (user-pinned to manual). The user can click a green Manual
toggle to turn it off, reverting to auto selection (which will choose
Bayesian or Analytic, since Manual is not in the auto hierarchy).

#### 17.3.5 Override flag

When any toggle is green (user-pinned), the edge carries
`model_source_preference_overridden = true`. This flag:
- Is visible in the Edge Properties override summary (alongside other
  `_overridden` fields)
- Follows the same connection/connection_overridden pattern used
  elsewhere
- Is cleared when the user reverts all toggles to off (auto mode)

### 17.4 Data summary and completeness

A compact data summary section (above or between cards) shows:
- A small inline chart (existing hover-preview pattern: mini model
  curve with edge and path overlays)
- Completeness metric for the current query DSL

This leverages the existing chart-preview infrastructure as a generic
asset. Not a new component — reuse and embed.

### 17.5 Fields removed from ParameterSection

- **Distribution dropdown**: Remove. Currently a stub (`log_normal`
  always) with no runtime effect. If multi-distribution support is
  added later, it will be automatically selected by the model engine,
  not user-specified at edge level.

---

## 18. UI design — Graph Properties

### 18.1 Model Source Preference

A dropdown in Graph Properties:

- **Label**: "Model Source"
- **Options**: Auto (default) · Bayesian · Analytic
- **No "Manual" option** — manual is inherently per-edge, not
  graph-wide.
- **Stored as**: `graph.model_source_preference` (`'best_available'` |
  `'bayesian'` | `'analytic'`)

When changed, all edges without a per-edge override re-resolve their
promoted scalars. Edges with `model_source_preference_overridden = true`
are unaffected.

### 18.2 Summary row

Below the dropdown, a read-only summary:

> **Source breakdown**: 12 Bayesian · 3 Analytic · 1 Manual · 2 overridden

Derived by scanning edges — not stored. Shows the count of edges
currently promoted from each source, and how many have per-edge
overrides.

### 18.3 Last Bayes fit info

A compact line showing:
- Date of most recent Bayesian model run (`_bayes.fitted_at` or
  similar)
- Model quality summary (e.g. "14/16 edges passed quality gate")

This helps the user understand whether the Bayesian option is stale
or current.

---

## 19. UI design — Onset per-source summary

The onset field appears in different contexts depending on source:

| Source | Onset behaviour | Editable? | Location |
|---|---|---|---|
| Analytic | User-overridable input to LAG pass | Yes (ZapOff) | Analytic card |
| Bayesian | Latent variable; graph onset is prior, posterior is output | No (read-only) | Bayesian card |
| Manual | Part of complete snapshot; user specifies directly | Yes | Manual card |

This separates the current conflation where a single onset field serves
as both an analytic model input and a Bayesian model input. The
compiler-side change to treat onset as a Bayesian latent (using the
graph value as prior) is design debt tracked in programme.md.

---

## 20. Design rationale — three sources, three cards

The three sources differ fundamentally in user interaction model:

- **Analytic**: semi-automatic. The pipeline estimates values from data;
  the user steers by overriding onset, t95, and other inputs. Quick to
  recompute, imperfect but useful. User is a co-pilot.

- **Bayesian**: sophisticated model, hands-off. The engine produces
  posterior estimates; the user inspects but doesn't directly edit
  outputs. Future: user provides fit guidance (priors, constraints) but
  doesn't override posteriors. User is an observer (for now).

- **Manual**: direct output specification. The user is not guiding a
  model — they are saying "use these exact numbers." Useful for
  what-if analysis, known values from external sources, or overriding
  when both models are wrong.

This is why Manual is not a "tab" alongside Bayesian and Analytic in a
model selector. Bayesian and Analytic are model outputs with different
sophistication. Manual is a bypass — the user IS the model. The three-
card layout makes this distinction visible: the first two cards show
model outputs (read-only or lightly steerable); the third shows the
user's direct specification (fully editable).
