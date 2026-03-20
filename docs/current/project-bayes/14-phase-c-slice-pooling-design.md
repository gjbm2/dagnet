# Phase C: Slice pooling and hierarchical Dirichlet — detailed design

**Status**: Ready for implementation — Phase D prerequisites met
**Date**: 20-Mar-26
**Purpose**: Technical design for Phase C compiler implementation. Covers
slice parsing, IR extension, model emission, posterior output, and
interaction with existing compiler phases.

**Related**: `6-compiler-and-worker-pipeline.md` (end-state design, Layer 2
Contexts), `8-compiler-implementation-phases.md` (phase sequencing),
`11-snapshot-evidence-assembly.md` (Phase S data that Phase C consumes),
`programme.md` (programme-level sequencing)

---

## 1. Goal

Context slices (e.g. `context(channel:google)`, `visited(classic-cart)`,
`case(test:variant)`) are partially pooled toward the edge-level base rate
via hierarchical shrinkage. High-data slices deviate freely; low-data
slices borrow strength from the base rate and from other slices.

Branch groups with slices maintain a per-slice simplex constraint via a
hierarchical Dirichlet construction.

`conditional_p` entries are treated as separate simplexes (not pooled).

---

## 2. sliceDSL structure and the cartesian product

### 2.1 How pinnedDSL expands to values[] entries

A parameter's `pinnedDSL` (the fetch specification) has the form:

```
(window(...);cohort(...))(context(a);context(b))
```

This is a cartesian product: each observation type × each context value
produces a separate `values[]` entry. For 2 temporal modes × 2 contexts,
the result is 4 entries:

| sliceDSL (canonical) | obs type | context slice |
|---|---|---|
| `context(a:v1).window(...)` | window | `context(a:v1)` |
| `context(a:v2).window(...)` | window | `context(a:v2)` |
| `context(a:v1).cohort(...)` | cohort | `context(a:v1)` |
| `context(a:v2).cohort(...)` | cohort | `context(a:v2)` |

Cross-product contexts are also possible:

```
(window(...);cohort(...))(context(channel).context(device))
```

This produces `2 obs_types × |channels| × |devices|` entries. Each
entry's sliceDSL has the form
`context(channel:google).context(device:mobile).window(...)`.

### 2.2 Canonical order

The existing `normalizeConstraintString()` in `queryDSL.ts` defines the
canonical part order:

```
visited → visitedAny → exclude → case → context → contextAny → window → cohort → asat
```

Parts are dot-joined. Context keys are sorted alphabetically. The
compiler can rely on this ordering for identity comparison.

### 2.3 Observation type vs context identity

The `sliceDSL` string stored on each `values[]` entry contains BOTH the
temporal qualifier (`window(...)` or `cohort(...)`) and the context
qualifiers (`context(...)`, `case(...)`, `visited(...)`). The compiler
currently classifies observation type via regex (`_is_cohort()`,
`_is_window()` in `evidence.py`).

**Key invariant**: observation type (window/cohort) and context slice are
orthogonal dimensions. The same context slice appears in both window and
cohort entries. The compiler must:

1. Parse the context portion out of the full `sliceDSL`
2. Use the context portion as the **slice identity key**
3. Use the temporal portion for observation type classification (as now)

### 2.4 Context-only slice key

Define `context_key(sliceDSL)` as the sliceDSL with temporal qualifiers
(`window(...)`, `cohort(...)`, `asat(...)`) stripped. This is the slice
identity — two values[] entries with the same context_key but different
temporal qualifiers are window and cohort observations of the **same
slice**.

Examples:
- `context(channel:google).window(6-Sep-25:16-Mar-26)` → context_key =
  `context(channel:google)`
- `context(channel:google).cohort(Landing,6-Sep-25:16-Mar-26)` →
  context_key = `context(channel:google)`
- `context(channel:google).context(device:mobile).window(...)` →
  context_key = `context(channel:google).context(device:mobile)`
- `window(6-Sep-25:16-Mar-26)` → context_key = `""` (empty = aggregate)
- `cohort(Landing,6-Sep-25:16-Mar-26)` → context_key = `""` (aggregate)

The empty context_key represents the unsliced aggregate observation.

### 2.5 Context dimensions

A **context dimension** is a grouping of slices by key. All
`context(channel:*)` entries belong to the `channel` dimension. All
`visited(*)` entries belong to the `visited` dimension.

Cross-product contexts (e.g. `context(channel:google).context(device:mobile)`)
belong to the `channel×device` compound dimension. Each unique combination
of dimension keys forms a compound dimension.

---

## 3. Slice classification: MECE vs non-MECE

### 3.1 Definition

A context dimension is **MECE** (mutually exclusive, collectively
exhaustive) when each observation (user) belongs to exactly one slice
value within that dimension. MECE dimensions support partition-based
aggregate exclusion.

| Dimension type | MECE? | Rationale |
|---|---|---|
| `context(channel:*)` | Yes | Channel attribution is exclusive |
| `context(device:*)` | Yes | Exclusive within a session |
| `case(test:variant)` | Yes | A/B assignment is exclusive |
| `visited(node_id)` | No | A user can visit multiple nodes |

Cross-products of MECE dimensions are themselves MECE.

### 3.2 Classification source

MECE classification is a **per-dimension metadata flag** on the graph's
`dataInterestsDSL`, not runtime-detected. Sampling noise makes runtime
detection unreliable.

**Schema addition**: the `dataInterestsDSL` syntax or a companion
metadata field must encode which dimensions are MECE. Design options:

- **Option A**: annotation syntax in DSL, e.g. `context(channel!)`
  where `!` = MECE
- **Option B**: separate graph-level field `meceContextDimensions: ["channel", "device"]`
- **Option C**: all `context()` dimensions are MECE by default;
  `visited()` is always non-MECE; explicit opt-out for non-MECE contexts

Option C is the pragmatic default. In practice, `context()` dimensions
(channel, device, region, etc.) are MECE by construction — they come
from attribution or classification systems. `visited()` is the only
common non-MECE dimension. This avoids requiring metadata changes for
the common case.

### 3.3 Aggregate handling by MECE status

**MECE dimension with exhaustive slices** (`Σ n_slice ≈ n_aggregate`):
- Exclude the aggregate from the likelihood entirely
- Use only per-slice likelihood terms
- The aggregate is available as a posterior check but must not enter the
  model (double-counting)

**MECE dimension with partial slices** (`Σ n_slice < n_aggregate`):
- Compute residual: `(n_agg - Σ n_slice, k_agg - Σ k_slice)`
- Bind residual as a separate likelihood term for the base-rate variable
- Bind per-slice terms to per-slice variables

**Non-MECE dimension** (`visited()`):
- Independent per-slice likelihoods without partition constraint
- No residual computation (residual is undefined when slices overlap)
- Exclude the aggregate to avoid double-counting from overlap
- Each slice is a separate observation of `p_slice` with pooling toward
  `p_base`

---

## 4. IR extension

### 4.1 New types in `compiler/types.py`

```
SliceKey
    context_key: str            # context portion of sliceDSL (temporal stripped)
    dimensions: list[str]       # sorted dimension keys, e.g. ["channel", "device"]

SliceObservations
    context_key: str
    window_obs: list[WindowObservation]
    cohort_obs: list[CohortObservation]

SliceGroup
    dimension_key: str          # e.g. "channel" or "channel×device"
    is_mece: bool
    is_exhaustive: bool         # True if Σ n_slice ≈ n_aggregate
    slices: dict[str, SliceObservations]   # context_key → observations
    residual: SliceObservations | None     # non-None for partial MECE
```

### 4.2 Extension to EdgeEvidence

```
EdgeEvidence (existing fields preserved)
    + slice_groups: dict[str, SliceGroup]   # dimension_key → group
    + has_slices: bool                       # True if any slice_groups non-empty
```

The existing `window_obs` and `cohort_obs` lists on `EdgeEvidence`
become the **aggregate** observations. Per-slice observations live in
`slice_groups`.

### 4.3 Evidence binding changes

The `bind_evidence()` function (and `bind_snapshot_evidence()`) must:

1. Parse `context_key()` from each `values[]` entry's `sliceDSL`
2. Group entries by context dimension
3. Classify each dimension as MECE or non-MECE
4. Detect exhaustiveness per MECE dimension
5. Compute residuals for partial MECE dimensions
6. Route aggregate entries to existing `window_obs`/`cohort_obs`
7. Route sliced entries to `slice_groups`

---

## 5. Model emission

### 5.1 Hierarchy: edge → slice → observation type

The slice deviation applies to `p_base` (before the window/cohort split).
This gives a three-level hierarchy:

```
p_base                              # edge-level (Beta or Dirichlet component)
  └─ p_slice_base                   # per-slice (logit offset from p_base)
       └─ p_slice_window            # tight pooling toward p_slice_base
       └─ p_slice_cohort            # path-informed divergence from p_slice_base
```

This is consistent with the existing p_base/p_window/p_cohort structure.
Context slicing is a cross-cutting dimension: the same channel has
different window and cohort observations, and the window/cohort
divergence allowance applies within each slice independently.

For edges with no slices, the existing two-level hierarchy
(p_base → p_window/p_cohort) is unchanged.

### 5.2 Solo edges with slices

```
# Edge-level anchor
p_base ~ Beta(α, β)

# Per-edge shrinkage parameter
τ_slice ~ HalfNormal(σ_τ)

# Per-slice deviations (non-centred)
ε_slice_i ~ Normal(0, 1)                          # one per slice
p_slice_base_i = logistic(logit(p_base) + ε_slice_i * τ_slice)

# Window/cohort split within each slice (existing pattern)
# If slice has both window and cohort observations:
p_slice_window_i = logistic(logit(p_slice_base_i) + ε_window_i * τ_window)
p_slice_cohort_i = logistic(logit(p_slice_base_i) + ε_cohort_i * τ_cohort)

# Likelihoods per slice per observation type
obs_window_slice_i ~ Binomial(n_window_i, p_slice_window_i * completeness)
obs_cohort_slice_i ~ per-day Potential (existing pattern)
```

**Variable count per edge**: 1 (τ_slice) + S (ε_slice) + up to 2S
(ε_window, ε_cohort per slice) = 1 + 3S. For 5 slices: 16 variables.

**σ_τ prior**: the prior on the HalfNormal scale for τ_slice controls
default pooling strength. Doc 6 mentions a user setting for pooling
strength. Recommended default: `σ_τ = 0.5` (moderate — allows slices to
differ by ~±0.5 on the logit scale, roughly ±12% on the probability
scale at p=0.5).

### 5.3 Branch groups with slices — hierarchical Dirichlet

For a branch group with K siblings at a branching node:

```
# Branch-level base simplex (the "typical" split at this node)
base_weights ~ Dirichlet(α_hyper)           # K+1 components (incl. dropout)

# Concentration parameter (controls slice-to-base tightness)
κ ~ Gamma(α_κ, β_κ)                        # positive, learned

# Per-slice simplex (drawn around the base)
weights_slice_i ~ Dirichlet(κ * base_weights)    # one per slice

# Multinomial likelihood per slice
obs_slice_i ~ Multinomial(n_slice_i, weights_slice_i * completeness_vec)
```

**Variable count per node**: K+1 (base_weights) + 1 (κ) + S × (K+1)
(per-slice weights) = K + 2 + S(K+1). For 3 siblings + dropout × 5
slices: 4 + 1 + 20 = 25 variables.

**Window/cohort within branch group slices**: each slice may have both
window and cohort observations. The per-slice Multinomial handles
window observations (shared denominator across siblings). Cohort
observations use per-sibling Potentials within each slice, with the
probability drawn from `weights_slice_i[j]` for sibling j in slice i.

**Exhaustive groups**: omit the dropout component (as in Phase B).
Per-slice `weights_slice_i` has K components summing to 1.

### 5.4 Aggregate likelihood for partial MECE dimensions

When MECE slices partially cover the aggregate, the residual
`(n_residual, k_residual)` enters the likelihood under `p_base` (not a
slice variable). This residual represents un-sliced observations that
don't belong to any named slice.

For branch groups, the residual enters as a Multinomial under
`base_weights` (not a per-slice simplex).

### 5.5 Non-MECE dimensions

`visited()` slices get independent per-slice likelihoods without the
partition constraint. Each slice has its own `p_slice` (pooled toward
`p_base` via τ_slice). No residual computation. The aggregate is
excluded from the likelihood.

No Multinomial constraint across slices (a user can appear in multiple
visited() slices).

### 5.6 Multiple context dimensions

When an edge has observations sliced by multiple dimensions (e.g.
channel AND device), the compound dimension `channel×device` forms a
single SliceGroup. Each unique `(channel, device)` pair is a slice.
The model emits one τ_slice per compound dimension per edge, and one
deviation per unique combination.

Separate, non-cross-product dimensions (e.g. channel slices exist
independently of device slices, not as a cross-product) would form
separate SliceGroups, each with its own τ_slice. However, this is
uncommon in practice — the pinnedDSL expansion produces cross-products
when multiple bare keys are dotted together.

---

## 6. `conditional_p` support

### 6.1 Semantics

Conditionals represent mutually exclusive alternative populations
(first-match routing), not additive deviations from a shared base.
They are **separate simplexes, not pooled slices**.

### 6.2 Model emission

For a branch group with a conditional `case(test:treatment)`:

```
# Default simplex (users not matching any condition)
weights_default ~ Dirichlet(α_default)

# Treatment simplex (users matching the condition)
weights_treatment ~ Dirichlet(α_treatment)

# No pooling between default and treatment — they are independent
```

Each condition gets its own independent Dirichlet with its own latent
variables. The data pipeline provides condition-specific `values[]`
entries; the evidence binder routes them to the correct simplex.

### 6.3 Downstream propagation (current limitation)

Downstream edges without their own conditionals use a blended `p` from
all populations:
`p_blended = f_X * p|X + (1 - f_X) * p_default`
where `f_X` is the observed condition fraction.

Full per-condition latent variables downstream require per-condition
data on downstream edges, which the data pipeline does not yet produce.

---

## 7. Interaction with Phase D (latent latency)

### 7.1 Sequencing: D before C

Doc 11 §10.4 proposes A → B → S → **D → C** (revised from A → B → S →
C → D). The arguments:

- Phase D extracts more value from Phase S data than Phase C
- Latency drift matters more for forecast accuracy than segmentation
- Phase C (Dirichlet across slices) builds on latent latency more
  naturally than the reverse

The current `model.py` already has Phase D latent latency partially
built: edge-level latent `(mu, sigma)` variables, cohort-level
FW-composed path latency with non-centred parameterisation, and
Potential emission that handles latent CDFs as PyTensor expressions.

### 7.2 Implication for Phase C completeness

Phase D latent latency is confirmed stable (20-Mar-26: 0 divergences,
rhat=1.004, ESS=1805). Per-slice completeness CDFs are PyTensor
expressions of latent `(mu, sigma)`. Each slice's Potential/BetaBinomial
term naturally inherits the latent coupling — no special per-slice
completeness wiring needed beyond using the same CDF expression.

Per-slice likelihoods use the edge's κ (Beta-Binomial/DM overdispersion,
also Phase D). No per-slice overdispersion variable is needed.

### 7.3 Temporal drift × slices

Phase D's time-binned latency drift (`mu_t` random walk per edge)
applies uniformly across slices — different channels don't have
different latency models (there is no per-slice latency). The latency
model describes the conversion process's timing, which is a property
of the product pipeline, not the user segment.

Each slice's cohort observations use the same per-edge latent
`(mu_t, sigma)` for completeness. The slice deviation affects only
the probability, not the latency.

---

## 8. Posterior output

### 8.1 `posterior.slices` map

The edge-level `posterior` block (α, β, HDI, ESS, r-hat) remains
unchanged and always present. A `slices` sub-map is added when slice
pooling is active:

```yaml
posterior:
  alpha: 42.3
  beta: 7.8
  hdi_lower: 0.78
  hdi_upper: 0.89
  ess: 2400
  rhat: 1.002
  slices:
    "context(channel:google)":
      alpha: 38.1
      beta: 6.2
      hdi_lower: 0.80
      hdi_upper: 0.91
      ess: 1800
      rhat: 1.003
    "context(channel:meta)":
      alpha: 4.2
      beta: 1.6
      hdi_lower: 0.55
      hdi_upper: 0.85
      ess: 620
      rhat: 1.008
```

The slice key is the **context_key** (temporal qualifiers stripped),
matching the canonical normalisation from `normalizeConstraintString()`.
Each entry has the same summary fields as the edge-level posterior.

### 8.2 Slice key canonicalisation

The `posterior.slices` keys must match the context_key values used by
the FE for display and lookup. The compiler must use the same
canonicalisation as `normalizeConstraintString()`: sorted by dimension
key, dot-joined, with specific values (not bare enumeration keys).

**Implementation**: a Python port of the canonical ordering (case,
context, visited — sorted by key within each type, temporal stripped)
in the evidence binder. This is a simple string manipulation — the
grammar is fixed and the ordering rule is explicit.

### 8.3 Per-slice quality metrics

Each slice entry carries `ess` and `rhat` from the slice-level
variables. Low-data slices may have lower ESS and higher r-hat due to
shrinkage — this is expected and should be surfaced but not treated as
a quality failure. The edge-level quality tier remains the primary
quality signal.

### 8.4 fit_history remains edge-level only

Per-slice trajectory history would be prohibitively verbose and is not
needed for prior calibration (the DerSimonian-Laird estimator operates
on the edge aggregate). `fit_history` entries do not carry per-slice
snapshots.

---

## 9. Evidence binding for snapshot DB rows (Phase S integration)

Phase S delivers snapshot DB rows with `slice_key` fields. The evidence
binder (`bind_snapshot_evidence()`) must:

1. Parse `context_key()` from each row's `slice_key`
2. Group rows by context dimension (same logic as for param file
   `values[]` entries)
3. Build per-slice trajectories (`CohortDailyTrajectory` per slice)
4. Apply recency weighting per-slice (existing mechanism)
5. Populate `EdgeEvidence.slice_groups` from snapshot data

The snapshot DB `slice_key` follows the same DSL grammar as param file
`sliceDSL`. The parsing and classification logic is shared.

---

## 10. Variable count scaling and performance

### 10.1 Variable count estimates

| Graph shape | Slices | Variables (Phase C) | Variables (Phase B) | Ratio |
|---|---|---|---|---|
| 4 solo edges, no slices | 0 | ~20 | ~20 | 1× |
| 4 solo edges, 3 slices each | 3 | ~68 | ~20 | 3.4× |
| 3 siblings + 4 solo, 5 slices | 5 | ~145 | ~30 | 4.8× |
| 3 siblings + 4 solo, 5 slices × 2 dims | 10 | ~270 | ~30 | 9× |

NUTS scales roughly linearly with variable count for moderate-dimension
models (< 500 variables). The `target_accept=0.95` from Phase A may
need relaxing if step-size adaptation struggles with the larger model.

### 10.2 Minimum-n gate per slice

The existing `min_n_threshold` (default 10) applies per edge. Phase C
needs a per-slice minimum-n gate: slices with fewer than `min_n_slice`
observations (default 10) should be excluded from the likelihood and
not given their own latent variable. Their observations fold into the
aggregate/residual.

This prevents the model from wasting variables on slices with
insufficient data to inform a deviation, and avoids numerical issues
in the Multinomial likelihood with very small counts.

---

## 11. Recommended implementation order

1. **Slice DSL parser** (Python, in `compiler/evidence.py` or new
   `compiler/slices.py`): `context_key()` extraction, dimension
   grouping, MECE classification. Pure functions, unit-testable.

2. **IR types** (`compiler/types.py`): `SliceKey`, `SliceObservations`,
   `SliceGroup` dataclasses. `EdgeEvidence.slice_groups` field.

3. **Evidence binding** (`compiler/evidence.py`): observation routing to
   slice groups, aggregate exclusion, residual computation. Both param
   file and snapshot DB paths.

4. **Solo-edge slice pooling** (`compiler/model.py`): `τ_slice`,
   `δ_slice`, `p_slice_base`, per-slice window/cohort split, per-slice
   likelihoods. Follows existing logit-offset pattern.

5. **Branch-group hierarchical Dirichlet** (`compiler/model.py`):
   `base_weights`, `κ`, per-slice `Dirichlet(κ * base_weights)`.
   Per-slice Multinomials and Potentials.

6. **`conditional_p` support** (`compiler/model.py`): separate
   simplexes per condition, evidence routing by condition key.

7. **Posterior summarisation** (`compiler/inference.py`): per-slice
   extraction from trace, `posterior.slices` output map, webhook
   payload extension.

8. **Parameter recovery tests**: synthetic slice data per doc 8 §Phase
   C test scenarios (high-data slice, low-data slice, different true p,
   MECE partition, non-MECE dimension).

Steps 1–3 are independent of Phase D. Steps 4–7 require Phase D
latent latency — confirmed stable 20-Mar-26 (see §7.2).

---

## 12. Test data for Phase C

**Graph**: `conversion-flow-v2-recs-collapsed` — added to data repo
`feature/bayes-test-graph` branch (20-Mar-26).

**Why this graph**: 12 nodes, 17 edges (10 with parameters), branch
groups (household-delegated out=3+), join nodes (energy-rec in=3,
switch-registered in=2), and a `context(channel)` dimension with 4
values (paid-search, paid-social, influencer, other). The
`dataInterestsDSL` is `(window(-100d:);cohort(-100d:)).context(channel)`
— exactly the pattern Phase C must handle.

**Snapshot DB**: context-sliced rows exist for all 10 parameter edges,
across all 4 channel values, both window and cohort modes. Total ~100k+
rows across multiple `param_id` workspace prefixes (main branch and
extracted-candidate variants). Hash equivalence mappings will be needed
to bridge `param_id` differences (same `core_hash` across branches/param
names by design).

**Files in data repo** (alongside existing bayes-test-gm-rebuild):
- 1 graph JSON, 10 parameter YAMLs, 4 new event YAMLs (4 shared with
  existing graph), 1 context YAML, 8 new node YAMLs (4 shared)
- Index files updated for all new entries

**What this graph exercises that the bayes-test graph does not**:
- MECE context dimension (`channel`) with 4 values
- Branch groups with 3+ siblings (household-delegated → 3 outgoing)
- Join nodes with multiple inbound paths (energy-rec, switch-registered)
- `exclude()` and `minus()` query modifiers on edges
- `n_query` overrides for denominator computation

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Variable count explosion (many slices × branch groups) | Slow MCMC, poor convergence | Per-slice min-n gate; compound dimensions bounded by data availability |
| MECE misclassification | Double-counting or data loss | Default `context()` = MECE, `visited()` = non-MECE; explicit opt-out for exceptions |
| DSL canonicalisation mismatch (Python vs TS) | `posterior.slices` keys don't match FE lookup | Python port of `normalizeConstraintString()` ordering; integration test with round-trip |
| Overdispersion amplified by more likelihood terms | Overconfident per-slice posteriors | Resolved: per-edge κ via Beta-Binomial/DM (Phase D, 20-Mar-26). Phase C extends this — each slice's likelihood uses the edge's κ. No per-slice tempering needed |
| Sparse slice data (n < 10) | Numerical issues in Multinomial | Per-slice min-n gate excludes tiny slices from model |
| ~~Phase D latent latency instability~~ | ~~Per-slice completeness must be retrofitted~~ | Resolved: Phase D stable (20-Mar-26), per-slice completeness uses latent CDFs directly |

---

## 13. What this document does NOT cover

- FE consumption of `posterior.slices` (see doc 9 Phase C overlay)
- FE per-slice visualisation components
- Data pipeline changes to produce context-sliced observations
  (existing — the pipeline already fetches per-context data when
  `dataInterestsDSL` includes `context()` dimensions)
- Temporal drift interaction details (see doc 11 §10)
- Full downstream `conditional_p` propagation (future, data-dependent)
