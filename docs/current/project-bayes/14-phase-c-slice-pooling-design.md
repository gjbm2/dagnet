# Phase C: Slice pooling and hierarchical Dirichlet — detailed design

**Status**: Partially implemented (10-Apr-26). Slice routing
(`evidence.py`), per-slice hierarchical Dirichlet emission (`model.py`
§2b), per-slice posterior extraction (`inference.py`), `bayesEngorge.ts`
wired. Doc 30 regime selection substantially implemented. Remaining:
`conditional_p`, dedicated Phase C test suite, FE per-slice visualisation
**Date**: 20-Mar-26 (revised 7-Apr-26 for doc 30 alignment)
**Purpose**: Technical design for Phase C compiler implementation. Covers
slice parsing, IR extension, model emission, posterior output, and
interaction with existing compiler phases.

**Related**: `6-compiler-and-worker-pipeline.md` (end-state design, Layer 2
Contexts), `8-compiler-implementation-phases.md` (phase sequencing),
`11-snapshot-evidence-assembly.md` (Phase S data that Phase C consumes),
`30-snapshot-regime-selection-contract.md` (regime selection — hard
prerequisite for Phase C evidence binding),
`30b-regime-selection-worked-examples.md` (regime selection use cases),
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
- All slices participate regardless of n — the hierarchical
  shrinkage handles low-data slices naturally (see §10.2)
- No residual computation needed — there is no `min_n_slice` gate
  to create excluded slices
- If a MECE partition genuinely doesn't sum to the aggregate (e.g.,
  some context values were not fetched), the difference is
  unobserved — the model handles this through the parent's prior,
  not through a residual term

**Non-MECE dimensions**: not applicable to Phase C. `visited()` is a
query filter (used in analytics DSLs and `conditional_p` definitions),
not a context partitioning dimension. It does not appear in pinned
DSL context positions and does not produce sliced observations for
the Bayes model. All context dimensions used for slicing (`context()`,
`case()`) are MECE by construction.

### 3.4 No residual computation

With no `min_n_slice` gate (§10.2), all slices participate in the
model. There are no excluded slices to produce a residual. The
aggregate and per-slice observations never coexist for the same date
(doc 30 §11.5 — regime selection picks one per `retrieved_at`). No
cross-regime subtraction, no intra-regime residual.

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
```

### 4.2 Extension to EdgeEvidence

```
EdgeEvidence (existing fields preserved)
    + slice_groups: dict[str, SliceGroup]   # dimension_key → group
    + has_slices: bool                       # True if any slice_groups non-empty
    + regime_per_date: dict[str, str]        # retrieved_at → regime_kind
                                             # ('mece_partition' | 'uncontexted')
                                             # Per-date suppression (§5A.3 Rule 2)
                                             # keeps only most granular data
```

The existing `window_obs` and `cohort_obs` lists on `EdgeEvidence`
hold **aggregate** observations — but only for `retrieved_at` dates
where the winning regime is `uncontexted`. Per-slice observations
live in `slice_groups` and cover dates where the regime is
`mece_partition`. See §5.7 for the per-date likelihood routing rule.

**Aggregate observations may be absent.** When the pinned DSL
produces only contexted slices (no uncontexted fetch — see doc 30
§5.2), the aggregate `window_obs`/`cohort_obs` may be empty. In this
case `p_base` has no direct likelihood term and is informed solely
through the Dirichlet link to children (see §5.7). This is
architecturally sound — the hierarchy naturally produces aggregate
posteriors from per-slice evidence.

### 4.3 Evidence binding changes

Evidence binding has two paths, with different responsibilities:

**File-based path** (engorged graphs, §9A):

1. Read `_bayes_evidence` from graph edge → build
   `WindowObservation` / `CohortObservation` (direct field mapping)
2. Read `_bayes_priors` from graph edge → populate
   `ProbabilityPrior`, `LatencyPrior`, κ warm-start
3. Compute completeness from edge topology latency (unchanged CDF
   logic)

No sliceDSL parsing, no dimension grouping, no MECE classification.
Each per-slice graph IS one slice — the FE already filtered and
routed the data (§9A.4).

**Snapshot DB path** (unchanged from doc 30):

1. Call `select_regime_rows()` (doc 30 §6) — filters rows to one
   regime per `retrieved_at`. Hard prerequisite — without it,
   multi-regime rows double-count (doc 30 §1.1).
2. Parse `context_key()` from each row's `slice_key`
3. Route rows by regime: `mece_partition` dates → per-slice obs,
   `uncontexted` dates → aggregate obs (§5.7)
4. Per-date suppression: most granular wins (§5A.3 Rule 2)
5. Build trajectories, apply recency weighting (existing logic)
6. For uncovered anchor_days, supplement from graph edge
   observations (replacing param file fallback)

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
# NB: emitted only for mece-regime dates (§5.7). Aggregate
# observations on uncontexted-regime dates feed p_base directly
# via existing window/cohort likelihood. Per-date suppression
# (§5A.3 Rule 2) ensures no double-counting across granularities.
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
# NB: emitted only for mece-regime dates (§5.7). See §5.2 note.
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

### 5.4 All slices participate — no minimum-n gate

All slices enter the model regardless of sample size. Low-data slices
(n=8) are naturally handled by hierarchical shrinkage — the posterior
sits close to `p_base` with wide uncertainty. No residual
computation, no threshold, no special routing (see §10.2).

If a MECE partition doesn't sum to the aggregate (some context values
not fetched), the unobserved portion is handled by the parent's
prior — not by a residual likelihood term.

### 5.6 Multiple context dimensions — independent Dirichlets

**Revised per doc 30 §11.2.** When a pinned DSL produces multiple
independent MECE dimensions (e.g. `context(channel);context(device)`
in semicolon position), each dimension forms a **separate, independent
Dirichlet hierarchy** — not a compound `channel×device` SliceGroup.

```
Parent (p_base)                                ← aggregate
  ├── Channel children (Dirichlet)             ← one MECE group
  │     ├── channel:google (p_ch_google)
  │     └── channel:meta (p_ch_meta)
  └── Device children (Dirichlet)              ← separate MECE group
        ├── device:mobile (p_dv_mobile)
        └── device:desktop (p_dv_desktop)
```

Each dimension provides an independent view of how the parent rate
decomposes. The channel values sum to the parent, and the device
values separately sum to the parent. They are NOT jointly Dirichlet
across the combined group — `channel:google + device:mobile` would
not sum to the parent.

Each dimension has:
- Its own `SliceGroup` in `EdgeEvidence.slice_groups`
- Its own regime (each dimension's data comes from a different
  `core_hash`; regime selection picks one hash per `retrieved_at`)
- Its own τ_slice (solo edges) or κ + base_weights (branch groups)
- Its own per-slice deviations

The parent's posterior is informed by ALL dimensions — multiple
independent constraints that the parent must be consistent with.
With two MECE dimensions, the parent has two independent sets of
constraints, which is more informative than a single uncontexted
observation.

**Cross-product dimensions** (dot-product in pinned DSL, e.g.
`context(channel).context(device)`) remain a single compound
SliceGroup with one `(channel, device)` pair per slice. These are
a single regime (one `core_hash`). The distinction:

| DSL form | Dimensions | SliceGroups | Regimes |
|---|---|---|---|
| `context(channel);context(device)` | 2 independent | 2 separate | 2 (one per dimension) |
| `context(channel).context(device)` | 1 compound | 1 compound | 1 |

### 5.7 Per-date likelihood routing (regime-dependent structure)

**New section — required by doc 30 §11.5.**

The regime selected for each `retrieved_at` date determines the
likelihood structure for observations on that date. This is not just a
filtering decision — it changes which model variables receive
likelihood terms.

| Regime for this `retrieved_at` | Child likelihood terms | Parent likelihood term |
|---|---|---|
| `mece_partition` (per-slice rows) | **Yes** — per-slice on children | **No** — parent informed only through Dirichlet |
| `uncontexted` (aggregate rows) | **No** — no per-child data | **Yes** — direct aggregate term |

**Why this matters**: if the same observations feed both the children's
likelihood AND the parent's likelihood, the data is double-counted.
The Dirichlet link already propagates children's evidence to the
parent — adding a separate parent term on the same data counts it
twice.

**Mixed-epoch example**: modelling on 28-Feb with a 60-day window:

- Jan dates: only uncontexted data exists (pre-context era). Regime =
  `uncontexted`. These observations feed `p_base` directly as
  aggregate likelihood terms. No per-slice terms.
- Feb dates: MECE partition data exists. Regime = `mece_partition`.
  These observations feed per-slice variables. `p_base` is informed
  only through the Dirichlet link. No direct parent term.

**Implementation**: the evidence binder stores `regime_per_date` on
`EdgeEvidence`. The model emitter checks each observation's
`retrieved_at` against this map to determine whether to emit a
parent term or child terms. Observations from uncontexted-regime
dates go into the existing `window_obs`/`cohort_obs` aggregate
likelihood. Observations from mece-regime dates go into per-slice
likelihoods only.

**Consistency across dimensions**: when multiple independent MECE
dimensions exist (§5.6), each dimension has its own regime selection
per date. It is possible for channel data to exist on a date where
device data does not (or vice versa). Each dimension's regime
decision is independent — the per-date routing applies per dimension,
not globally per edge.

**When aggregate observations are absent**: if no `retrieved_at` date
has regime `uncontexted`, `p_base` has no direct likelihood term. It
is informed entirely through the Dirichlet links to whichever
children have evidence. This is expected and well-behaved — the
hierarchy naturally produces aggregate posteriors from per-slice
evidence (doc 30 §11.4).

**Subsumption scenarios**: when the pinned DSL has overlapping
context specifications (§5A.3 Rule 2), multiple granularities may
have data for the same date. The per-date suppression rule applies:
most granular wins, coarser data is discarded. The two-case table
above covers the result — after suppression, each date has either
children data (mece) or aggregate data (uncontexted), never both.

---

## 5A. DSL shape taxonomy and hierarchy construction

### 5A.1 The core distinction: fetch specification vs model structure

The pinned DSL's semicoloned context parts are a **fetch
specification** — "retrieve data under these slicings." They are NOT
a model specification. The compiler must derive the model hierarchy
from the fetch results, and the relationship between semicoloned parts
determines whether they produce independent hierarchies, redundant
views, or a multi-level tree.

Getting this wrong causes double-counting: the same underlying
conversions feed multiple likelihood terms through different
decomposition paths.

### 5A.2 Three relationships between semicoloned context parts

Given a pinned DSL with semicoloned context groups after the temporal
clause, any two groups have exactly one relationship:

**Independent** — different dimension keys, neither is a marginal of
the other. Each produces an independent MECE decomposition of the
population.

Example: `context(channel);context(device)`
- channel slices: `{channel:google, channel:meta}` — one hash family
- device slices: `{device:mobile, device:desktop}` — different hash
  family
- A channel:google row is NOT a sum-over-devices — it is a different
  query that counted users attributed to Google, regardless of device
- These are genuinely independent constraints on the parent

**Subsumption (marginal)** — one group is a marginal of another. The
coarser group can be derived by summing the finer group over one or
more dimensions.

Example: `context(a).context(b);context(a);context(b)`
- `context(a)` is a marginal of `context(a).context(b)` (sum over b)
- `context(b)` is a marginal of `context(a).context(b)` (sum over a)
- ALL THREE are representations of the same underlying population
- Using more than one simultaneously double-counts

Example: `context(channel);` (trailing semicolon = uncontexted)
- The uncontexted aggregate is a marginal of the channel partition
  (sum over channels)
- Both represent the same population — use one per date

**Subset** — one group is a specific value of another's expansion.

Example: `context(a);context(a:p)`
- `context(a:p)` is one slice of the `context(a)` expansion
- Same hash family — `context(a:p).window()` produces the same query
  whether it came from expanding `context(a)` or from the explicit
  `context(a:p)` (same `core_hash`)
- Regime selection handles this naturally — no distinct regime

### 5A.3 Hierarchy construction rules

**Rule 1 — Independent dimensions produce independent Dirichlets.**

`context(channel);context(device)` →

```
Parent (p_base)
  ├── Channel Dirichlet (from channel hash)
  │     ├── channel:google
  │     └── channel:meta
  └── Device Dirichlet (from device hash)
        ├── device:mobile
        └── device:desktop
```

Each dimension's data enters the model once, through its own
Dirichlet children. The parent is constrained by both decompositions
independently. Each dimension has its own regime selection per
`retrieved_at` (per §5.7). No double-counting because the two hash
families fetch data via different queries — they are genuinely
different observations of the population.

**Statistical validity note**: both decompositions observe the SAME
underlying conversions counted in different ways. The model treats
them as independent constraints on the parent, which makes the
parent's posterior tighter than either decomposition alone. This is
valid under the assumption that the two dimensions are conditionally
independent given the parent rate. If channel and device are
correlated (e.g., mobile users disproportionately from social), the
parent's posterior will be somewhat overconfident. In practice this
is acceptable — the hierarchical shrinkage absorbs moderate
correlation, and the alternative (modelling the full joint
distribution) requires cross-product data.

**Rule 2 — Subsumption: multi-level hierarchy, most granular wins
per date.**

`context(a).context(b);context(a);context(b);` →

The cross-product `context(a).context(b)` subsumes both marginals.
These are NOT independent — using more than one for the same date
double-counts. The model hierarchy has a natural multi-level
structure with each granularity at its own level:

```
Parent (p_base)
  ├── a:n (intermediate)     ← Dirichlet group 1 (a-dimension)
  │     ├── (a:n, b:p) (leaf) ← Dirichlet group 2 (a×b compound)
  │     └── (a:n, b:q)
  ├── a:m (intermediate)
  │     ├── (a:m, b:p)
  │     └── (a:m, b:q)
```

The intermediates (`a:n`, `a:m`) form one Dirichlet group. The
leaves (`(a:n,b:p)`, ...) form another, with the structural
constraint that each intermediate equals the sum of its leaves.
Each granularity has a natural home for its data.

**Per-date suppression rule**: on any given `retrieved_at` date,
only the **most granular** data available is used. Coarser data for
that date is discarded. This is the same principle as doc 30's
regime selection, applied across hierarchy levels:

- Date has cross-product data (H_axb) → leaves get likelihood
  terms. Intermediates and parent informed through Dirichlet only.
  Any H_a or H_bare data for this date is discarded.
- Date has only a-marginal data (H_a, no H_axb) → intermediates
  get likelihood terms. Leaves are silent. Parent informed through
  Dirichlet only.
- Date has only uncontexted data (H_bare) → parent gets direct
  aggregate term. Intermediates and leaves are silent.

The a-marginal and b-marginal semicoloned parts serve as **fallback
fetch specifications** — they provide data for dates before the
cross-product DSL was adopted, routed to the correct intermediate
level.

**Validation**: after evidence binding, if `p_base` has zero
likelihood terms on any level (no aggregate obs, no intermediates
with obs, no leaves with obs on any date), this is a pinned DSL
misconfiguration. The compiler should reject the edge with a
diagnostic naming the missing data (see §14.7).

**Rule 3 — Subset values are absorbed by the dimension expansion.**

`context(a);context(a:p)` →

`context(a:p)` is one value of the `context(a)` expansion. Same
`core_hash` for `context(a:p).window()` regardless of provenance. No
distinct regime — regime selection handles this. No special model
treatment.

### 5A.4 Worked example: complex mixed-mode DSL

```
(window();cohort()).(context(a).context(b);context(a);context(b);context(a:p);)
```

**Step 1 — Classify semicoloned parts.**

| Part | Dimension shape | Relationship to others |
|---|---|---|
| `context(a).context(b)` | compound a×b | Subsumes parts 2, 3, 4 |
| `context(a)` | single dim a | Marginal of part 1 |
| `context(b)` | single dim b | Marginal of part 1 |
| `context(a:p)` | specific value | Subset of part 2 |
| (trailing `;`) | uncontexted | Marginal of everything |

**Step 2 — Identify independent groups.**

No independent dimensions — parts 1–4 all decompose the same
population along related axes. Part 1 subsumes parts 2 and 3. Part 4
is a subset of part 2.

Compare with `context(channel);context(device)` — there, channel and
device are unrelated dimension keys. Here, parts 2 and 3 are both
marginals of part 1.

**Step 3 — Choose model hierarchy (Rule 2).**

Multi-level: a-intermediates + a×b leaves.

```
Parent (p_base)
  ├── a:n (intermediate)     ← Dirichlet group 1
  │     ├── (a:n, b:p) (leaf) ← Dirichlet group 2
  │     └── (a:n, b:q)
  ├── a:m (intermediate)
  │     ├── (a:m, b:p)
  │     └── (a:m, b:q)
```

**Step 4 — Evidence routing by date (most granular wins).**

| Data available for this `retrieved_at` | Most granular | Feeds | Suppressed |
|---|---|---|---|
| H_axb + H_a + H_bare | H_axb | Leaves | H_a, H_bare |
| H_a + H_bare (no H_axb) | H_a | Intermediates | H_bare |
| H_bare only | H_bare | Parent | — |
| H_axb + H_b (no H_a) | H_axb | Leaves | H_b |
| Nothing | — | No data | — |

Each date uses exactly one granularity. Coarser data is discarded.
Higher levels are informed only through the Dirichlet link.

**Step 5 — Hash families and regime preference.**

Exploded instances and their regime candidates (closest match first):

| Instance | Candidates |
|---|---|
| `context(a:n).context(b:p).window()` | [H_axb] |
| `context(a:n).context(b:q).window()` | [H_axb] |
| `context(a:n).window()` | [H_a, H_axb (superset)] |
| `context(b:p).window()` | [H_b, H_axb (superset)] |
| `context(a:p).window()` | [H_a (same family)] |
| `window()` | [H_bare, H_a, H_b, H_axb] |

The evidence binder groups regime-selected results by dimension and
routes them per the rules above.

### 5A.5 Contrast: two truly independent dimensions

```
(window();cohort()).(context(channel);context(device);)
```

**Step 1 — Classify.**

| Part | Dimension shape | Relationship |
|---|---|---|
| `context(channel)` | single dim | Independent of device |
| `context(device)` | single dim | Independent of channel |
| (trailing `;`) | uncontexted | Marginal of both |

**Step 2 — Identify independent groups.**

channel and device are unrelated dimension keys → independent. The
uncontexted part is a marginal of both (subsumption).

**Step 3 — Model hierarchy (Rule 1 for independent dims).**

```
Parent (p_base)
  ├── Channel Dirichlet (from H_channel hash)
  │     ├── channel:google
  │     └── channel:meta
  └── Device Dirichlet (from H_device hash)
        ├── device:mobile
        └── device:desktop
```

Two independent Dirichlets, each with its own regime selection per
date. Each dimension's data enters once through its own children. The
uncontexted part serves as fallback data for the parent on dates where
neither dimension has data.

**Step 4 — Evidence routing (per dimension, per date).**

Channel dimension's `regime_per_date` is independent of device
dimension's. On a given date:
- H_channel has data → channel children get likelihood terms
- H_device has data → device children get likelihood terms
- Both have data → both sets of children get terms (this is correct —
  they are independent observations)
- Neither has data, H_bare does → parent gets aggregate term

### 5A.6 Detection: when are semicoloned parts independent?

The compiler must classify the relationship between each pair of
semicoloned context parts. The test:

1. Extract the set of dimension keys from each part.
   - `context(channel)` → `{channel}`
   - `context(channel).context(device)` → `{channel, device}`
   - `context(channel:google)` → `{channel}` (specific value, same
     dimension key)
   - (empty / `context()`) → `{}` (uncontexted)

2. For two parts with key sets K₁ and K₂:
   - **Independent**: K₁ ∩ K₂ = ∅ (no shared dimension keys)
   - **Subsumption**: K₁ ⊂ K₂ or K₂ ⊂ K₁ (one is a subset)
   - **Partial overlap**: K₁ ∩ K₂ ≠ ∅ but neither is a subset
     (e.g., `context(a).context(b)` and `context(b).context(c)`) —
     this case is pathological and should be rejected by DSL
     validation

3. Group independent parts into independent dimension groups. Within
   each group, identify the most granular part (largest key set) as the
   model hierarchy source. Coarser parts in the same group are fallback
   fetch specifications.

**Example**: `context(a).context(b);context(a);context(channel);`

| Part | Keys | Group |
|---|---|---|
| `context(a).context(b)` | `{a, b}` | Group 1 (most granular) |
| `context(a)` | `{a}` | Group 1 (marginal, `{a} ⊂ {a,b}`) |
| `context(channel)` | `{channel}` | Group 2 (independent, no overlap) |
| (trailing `;`) | `{}` | Marginal of both groups |

Result: two independent hierarchies — compound a×b Dirichlet (Group 1)
and channel Dirichlet (Group 2).

### 5A.7 Double-counting risks and guards

| Risk | Cause | Guard |
|---|---|---|
| Two granularities feed the same hierarchy level on the same date | Marginal and cross-product data both present for same `retrieved_at` | Per-date suppression: most granular wins, coarser discarded (§5A.3 Rule 2) |
| Independent dimensions double-count at parent level | Both decompositions observe the same n underlying conversions | Accepted — structurally independent constraints. Modest parent overconfidence under dimension correlation. See §5A.3 Rule 1 note. 1/N κ correction (§14.6d). |
| No MECE partition or aggregate exists for any date | DSL misconfiguration — context slices specified but no values registered, or all below `min_n_slice` | Compiler validation: reject edge if `p_base` has zero likelihood terms at any level after evidence binding (§14.7) |
| Partial overlap (`context(a).context(b);context(b).context(c)`) | Shared dimension b, but neither subsumes the other | DSL validation should reject. No sensible hierarchy. |

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

Per-slice likelihoods use per-slice κ (Beta-Binomial/DM overdispersion).
Each context slice has its own `kappa_slice_i` — between-day variation
differs by user segment (e.g. paid traffic may be noisier than organic).

### 7.3 Temporal drift × slices

Phase D's time-binned latency drift (`mu_t` random walk per edge)
applies at the edge level. Per-slice latency deviations (§5.2b) are
layered on top: each slice has its own `mu_slice_i`, `sigma_slice_i`,
`onset_slice_i` drawn from a hierarchy around the edge-level values.
Different user segments genuinely convert on different timescales —
e.g. paid-search users may convert faster than organic visitors.

Each slice's cohort observations use that slice's latent latency
for completeness computation, not the edge-level values.

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

Phase S delivers snapshot DB rows with `slice_key` and `core_hash`
fields. The evidence binder (`bind_snapshot_evidence()`) must:

1. **Call `select_regime_rows()`** (doc 30 §6) with the raw rows and
   the edge's `candidate_regimes`. This filters to one regime per
   `retrieved_at` date and returns `RegimeSelection` with both
   filtered rows and `regime_per_date`.
2. Parse `context_key()` from each filtered row's `slice_key`
3. Group rows by context dimension (same logic as for param file
   `values[]` entries)
4. Route rows to aggregate or per-slice observations based on
   `regime_per_date` (§5.7): uncontexted-regime dates → aggregate
   obs, mece-regime dates → per-slice obs
5. Build per-slice trajectories (`CohortDailyTrajectory` per slice)
6. Apply recency weighting per-slice (existing mechanism)
7. Populate `EdgeEvidence.slice_groups` from snapshot data
8. Store `regime_per_date` on `EdgeEvidence` for model emission

The snapshot DB `slice_key` follows the same DSL grammar as param file
`sliceDSL`. The parsing and classification logic is shared. The
`core_hash` field is needed by `select_regime_rows()` to match rows
against candidate regimes.

**Regime selection is not optional.** Without it, rows from multiple
hash families (different MECE dimensions, hash mapping equivalents,
DSL era transitions) are mixed, causing double-counting (doc 30
§1.1). The Bayes evidence binder is one of eight vulnerable consumers
identified in doc 30 §7.3.1.

---

## 9A. FE per-slice commissioning: engorged graphs

Phase C requires the FE to produce a complete, per-slice picture for
the Bayes worker. The design principle: **all file-based data goes
onto the graph edges. The BE reads structured data off edges. No
param files in the Bayes payload.**

### 9A.1 Two evidence sources, different handling

1. **Snapshot DB rows** — the BE queries the DB directly via
   `snapshot_subjects` + regime selection (doc 30). No change from
   current design. The FE sends hashes and candidate regimes; the
   BE does the querying.

2. **File-based data** (observations, priors, warm-start) — currently
   sent as separate param files, parsed by the BE evidence binder
   (`evidence.py` lines 99-166 for observations, lines 1021-1216
   for priors). **Replaced by engorged graph edges.** The FE injects
   everything the BE needs directly onto each per-slice graph's
   edges. Param files drop out of the Bayes payload entirely.

### 9A.2 What goes onto each engorged graph edge

The FE puts all file-based evidence onto each edge at trigger time.
The BE reads it directly — no param file lookup, no sliceDSL
parsing, no file filtering.

**Observations** (currently from param file `values[]`):
```python
@dataclass
class BayesWindowObs:
    n: int                       # denominator (x, from-node arrivals)
    k: int                       # numerator (target conversions)
    window_from: str             # ISO date
    window_to: str               # ISO date

@dataclass
class BayesCohortObs:
    anchor_day: str              # ISO date
    n_daily: list[int]           # daily denominators
    k_daily: list[int]           # daily numerators
    dates: list[str]             # ISO dates for daily arrays

@dataclass
class BayesEvidence:
    window: list[BayesWindowObs]
    cohort: list[BayesCohortObs]

# On graph edge: edge["_bayes_evidence"] = BayesEvidence
```

**Priors and warm-start** (currently from param file posteriors +
`_model_state`):
```python
@dataclass
class BayesPriors:
    prob_alpha: float            # Beta prior α
    prob_beta: float             # Beta prior β
    prob_source: str             # 'warm_start' | 'moment_matched' |
                                 # 'kn_derived' | 'uninformative'
    prob_rhat: float | None      # from previous posterior (for diagnostics)
    prob_ess: float | None       # from previous posterior (for diagnostics)
    latency_onset: float | None  # onset_delta_days
    latency_mu: float | None     # lognormal μ
    latency_sigma: float | None  # lognormal σ
    latency_source: str | None   # 'warm_start' | 'topology'
    kappa: float | None          # overdispersion warm-start
    cohort_mu: float | None      # path-level latency warm-start
    cohort_sigma: float | None
    cohort_onset: float | None

# On graph edge: edge["_bayes_priors"] = BayesPriors
```

**Analytics** (from per-slice topo pass — already on model_vars):
- p, p_sd, onset, mu, sigma, t95, completeness, blended_mean

Each per-slice graph is fully self-contained. The BE evidence binder
reads `_bayes_evidence` and `_bayes_priors` off each edge. No param
files needed.

### 9A.3 Why this is simpler

**All fetch planning, slice filtering, and DSL-aware logic stays in
the FE.** The BE never needs to:

- Parse `sliceDSL` strings or classify observation types from DSL
- Group observations by context dimension
- Look up param files by param_id via params_index
- Filter `values[]` entries per slice
- Resolve priors from param file posteriors (FE pre-resolves and
  injects the result)
- Understand the warm-start quality gates (FE applies them and
  sends the winning prior)

The BE evidence binder for file-based data becomes: for each edge,
read `_bayes_evidence` and `_bayes_priors`. Compute completeness
(using edge topology latency — already on the graph). Done.

### 9A.4 FE commissioning flow

1. **Explode the pinned DSL** into per-slice DSLs (existing fetch
   planning). Produces the bare parent (`window()` / `cohort()` —
   always produced) + each context slice.

2. **Ensure data is fetched** for all slices. The fetch planner
   already handles this.

3. **Run the topo pass per slice.** Filter param file values by
   slice dimensions (same filtering `fetchDataService.ts` already
   does), call `enhance_graph_latencies`. N+1 topo passes. Overhead:
   < 1s per call, negligible vs MCMC time.

4. **Engorge each graph.** For each per-slice graph, for each edge:
   - Inject filtered observations from param file `values[]`
     → `_bayes_evidence`
   - Resolve warm-start priors (apply quality gates: rhat ≤ 1.10,
     ess ≥ 100) and inject the winning prior → `_bayes_priors`
   - Analytics already on model_vars from step 3

5. **Build the Bayes trigger payload:**
   - N+1 engorged graph snapshots
   - Snapshot subjects + candidate regimes + mece_dimensions
   - Settings
   - **No `parameter_files`. No `parameters_index`.**

### 9A.5 What the Bayes worker does

For each edge on each graph:
- Read `_bayes_evidence` → build `WindowObservation` /
  `CohortObservation` (direct field mapping, no parsing)
- Read `_bayes_priors` → populate `ProbabilityPrior`,
  `LatencyPrior`, κ warm-start (direct field mapping)
- Compute completeness from edge topology latency (unchanged)
- If snapshot subjects provided: query DB, apply regime selection,
  merge snapshot observations with graph-based observations
  (supplementation reads graph for uncovered dates)

The worker does not parse sliceDSL. Does not look up param files.
Does not know the DSL. Does not apply quality gates. It reads
structured data off graph edges and builds the model.

### 9A.6 Refactoring in `evidence.py`

**Replace** (`bind_evidence()` lines 99-166): param file `values[]`
parsing loop → read `_bayes_evidence` off graph edge.

**Replace** (lines 86-97, 1021-1216): prior resolution from param
files (`_resolve_prior()`, `_resolve_latency_prior()`,
`_resolve_warm_start_extras()`) → read `_bayes_priors` off graph
edge. The FE already applied quality gates.

**Keep**: completeness computation (same CDF logic, edge topology
source). Keep model emission, inference. Keep snapshot evidence
binding (unchanged — BE still queries DB directly).

**Snapshot supplementation** (lines 297-307): for anchor_days not
covered by snapshot rows, falls back to graph edge observations
instead of param file values[].

### 9A.7 Phase C slice routing simplification

With engorged per-slice graphs, the file-based evidence path needs
no slice routing. Each graph IS one slice. The `_route_slices()`
function (lines 1239-1368) is only relevant for the snapshot path
where the BE receives multi-slice rows from the DB.

### 9A.8 Why per-slice analytics are required

1. **LOO-ELPD denominator** (doc 32 §3.3): per-slice ΔELPD needs
   per-slice analytic baseline, not the aggregate.

2. **Prior resolution**: cold-start falls back to analytic priors.
   Must be slice-specific.

3. **Warm-start quality gating**: per-slice rhat/ESS gates.

### 9A.9 Cost

- FE: N+1 topo passes (< 1s each) + engorging step (copy filtered
  values + resolved priors onto edges)
- Payload: N+1 graphs sharing identical topology. Observation data
  moves from param files to graph edges — roughly neutral payload
  size, minus the params_index overhead.
- BE: simpler evidence binder, fewer dependencies, easier to test.
  No param file parsing code. No sliceDSL parsing code. No prior
  resolution code (moved to FE engorging step).

---

## 10. Variable count scaling and performance

### 10.1 Variable count estimates

| Graph shape | Slices | Variables (Phase C) | Variables (Phase B) | Ratio |
|---|---|---|---|---|
| 4 solo edges, no slices | 0 | ~20 | ~20 | 1× |
| 4 solo edges, 3 slices each (1 dim) | 3 | ~68 | ~20 | 3.4× |
| 3 siblings + 4 solo, 5 slices (1 dim) | 5 | ~145 | ~30 | 4.8× |
| 3 siblings + 4 solo, 3+3 slices (2 independent dims) | 6 | ~170 | ~30 | 5.7× |

**Note on §5.6 revision**: with independent Dirichlets per dimension,
two dimensions with S₁ and S₂ slices scale as S₁ + S₂ (additive),
not S₁ × S₂ (multiplicative). The previous estimate of ~270 for
"5 slices × 2 dims" assumed a compound cross-product; independent
dimensions are substantially cheaper.

NUTS scales roughly linearly with variable count for moderate-dimension
models (< 500 variables). The `target_accept=0.95` from Phase A may
need relaxing if step-size adaptation struggles with the larger model.

### 10.2 No per-slice minimum-n gate

All slices participate regardless of sample size. Hierarchical
shrinkage handles low-data slices naturally — the posterior sits
close to `p_base` with wide uncertainty (see §5.4). The existing
per-edge `min_n_threshold` remains for edges with zero total
observations.

---

## 11. Implementation staging

Two macro-phases addressing two distinct risks. Risk 1 must be
fully retired before Risk 2 work begins.

**Risk 1 — right data gets into the model.** Hash computation,
DB query, regime selection, dedup, slice routing, observation
assembly. Covered by R1 steps below and §16.

**Risk 2 — we do the right things with the data.** Hierarchical
shrinkage, Dirichlet, per-date routing, posterior summarisation.
Covered by R2 steps below.

**Hard prerequisite**: `select_regime_rows()` (doc 30 §6) must be
implemented before R1c's snapshot supplementation path. Doc 30
is being implemented now.

**Prior work completed**: slice DSL parser (`compiler/slices.py`) ✅,
IR types (`SliceKey`, `SliceObservations`, `SliceGroup` in
`compiler/types.py`) ✅, evidence binding scaffolding
(`_populate_slices()` in `compiler/evidence.py`) ✅.

### R1 — Data binding assurance (Risk 1) — COMPLETE (9-Apr-26)

**Status**: all steps done, gate passed. Zero defects across all
available graphs (7 synth + 1 contexted prod). Contexted carriage
verified on `conversion-flow-v2-recs-collapsed` (4 channel values,
10 parameterised edges). Parity confirmed between legacy and
engorged paths via `content_hash()` comparison.

~~**R1a — Receipt infrastructure**~~ ✅ (§16.3-16.9):
- `BindingReceipt` and `EdgeBindingReceipt` dataclasses in
  `compiler/types.py`
- Receipt builder in `worker.py` (`_build_binding_receipt`)
- Three modes: log, gate, preflight
- `evidence_hash` (SHA-256 of model inputs) for parity comparison
- 10 contract tests in `bayes/tests/test_binding_receipt.py`

~~**R1b — CLI tool**~~ ✅ (§16.12):
- `dagnet-cli bayes` command (`graph-editor/src/cli/commands/bayes.ts`)
- `--output` (payload JSON), `--preflight` (receipt from server)
- Shell wrapper `graph-ops/scripts/bayes.sh`
- Uses real FE service layer (same codepath as browser)

~~**R1c — Engorged graph contract**~~ ✅ (`compiler/evidence.py`):
- `bind_evidence_from_graph()` reads `_bayes_priors` and
  `_bayes_evidence` from graph edges
- `_bind_from_engorged_edge()` for file-based evidence fallback
- `bind_snapshot_evidence()` accepts optional `graph_snapshot`
  parameter — reads engorged priors when present, snapshot row
  handling unchanged
- `engorge_graph_for_test()` for parity testing
- Worker dispatch detects engorged graph and passes it through

~~**R1d — FE engorging step**~~ ✅:
- `graph-editor/src/lib/bayesEngorge.ts` — shared module
- Wired into `useBayesTrigger.ts` and CLI `commands/bayes.ts`
- Resolves priors (warm-start quality gates, ESS cap) and
  extracts observations from param file `values[]`
- Contexted observations carried correctly (per-slice sliceDSL)

~~**R1e — Certification**~~ ✅:
- CLI preflight regression: all 8 graphs clean (zero divergences)
- Parity tests: 6 tests confirm identical `content_hash()` between
  legacy and engorged paths (snapshots + priors combined)
- Contexted parity: verified on real prod graph with
  `context(channel)` dimension

~~**R1f — Harness bridge**~~ ✅:
- Core hashes match between CLI and harness on synth-fanout-test
  (6/6 hashes identical)

**Bugs found and fixed during R1**:
- js-yaml Date conversion corrupted context definition hashes in
  CLI (anti-pattern 23). Fix: `YAML.JSON_SCHEMA` in disk loader.
- Slice comparison used different naming conventions (temporal
  qualifiers). Fix: `_extract_context_key` strips temporals.
- Aggregate slice ("") falsely flagged as unexpected. Fix:
  excluded from unexpected_slices comparison.
- Anchor dates in mixed formats. Fix: normalise to date objects.
- Preflight mode ran MCMC. Fix: added `"preflight"` mode.
- Skipped edges bypassed verdict. Fix: only bypass when no
  subjects.

**Gate: Risk 1 is retired.** Data binding is certified. R2 work
can begin.

### R2 — Model work (Risk 2)

Uses the harness for intensive parallel compute. Data binding is
trusted.

**R2-prereq-i — Slice commissioning contract** ✅ (10-Apr-26):
- Worker extracts `commissioned_slices: dict[str, set[str]]` from
  subject `slice_keys` (edge_id → set of normalised context keys).
  Passed to `bind_snapshot_evidence` and through to `_route_slices`
  and `_bind_from_snapshot_rows`.
- `_route_slices` only creates `SliceGroups` for commissioned context
  keys. When `commissioned` is None (no FE subjects), no slices are
  created — context modelling requires explicit commission.
- `_bind_from_snapshot_rows` only collects per-context rows into
  `ctx_window_rows`/`ctx_cohort_rows` for commissioned keys.
  Uncommissioned context rows contribute only to the aggregate.
- **MECE aggregation gating**: `mece_dimensions` (list of dimension
  IDs declared MECE by the FE) flows from payload → worker → binder.
  Only context rows whose dimension is in `mece_dimensions` may be
  summed into the aggregate. Non-MECE context rows are skipped with
  a diagnostic warning. This prevents double-counting when contexts
  overlap.
- **`computeMeceDimensions` fix**: the FE function now scans ALL
  context definitions in the registry (via `getCachedIds`), not just
  those mentioned in the DSL. MECE is a property of the data, not
  the query. In CLI mode, `diskLoader.ts` preloads contexts with
  the correct workspace key (cache key mismatch fix).
- **Parent always produced**: aggregate observations for the parent
  are synthesised from MECE context rows even when no bare `window()`
  or `cohort()` DSL was commissioned.
- **Binding receipt**: scans `edge_ev.slice_groups` for observed
  slices (not just `cohort_obs`/`window_obs` which only contain
  aggregate observations after `_route_slices`).

**R2-prereq-ii — Harness payload via CLI** ✅ (10-Apr-26):
- `--fe-payload` flag on `test_harness.py`: calls `_build_payload_via_cli`
  which invokes the CLI (`bayes.ts`) to construct the payload using
  the real FE service layer. Supports both data-repo graphs (via
  `bayes.sh`) and non-data-repo graphs (direct tsx invocation with
  `--graph <dir>`).
- `--payload PATH` flag: accept a pre-built payload JSON file.
- When `--graph-path` is given with `--fe-payload`, derives graph
  name and directory from the path for the CLI call.
- `param_files`, `graph_path`, and `truth` variables correctly
  resolved in the payload code path (previously unbound).
- **synth_gen uses CLI for hashes**: `compute_snapshot_subjects.mjs`
  replaced with CLI calls in `synth_gen.py` Step 2. The generator
  calls the CLI twice (window DSL, cohort DSL) to get per-obs-type
  hashes. Creates a temp directory with DSL-overridden graph JSON
  and symlinked supporting dirs.

**R2a — Synthetic data generator** ✅ (9-Apr-26):
- `synth_gen.py` generates contexted data from truth files with
  `context_dimensions` (per-slice `p_mult`, `mu_offset`,
  `onset_offset`)
- Two contexted synth graphs: S1 (`synth-context-solo`, solo edge)
  and S2 (`synth-fanout-context`, branch group Dirichlet)
- Generator pipeline: Step 0 (simulation) → Step 1 (metadata) →
  Step 1b (context files) → Step 2 (CLI hashes) → Step 3 (DB) →
  Step 4 (param files) → Step 5 (verify). See doc 19 §3.1.

**R2b — Solo-edge slice pooling: p + kappa** ✅ (9-Apr-26):
- `τ_slice` (HalfNormal), per-slice logit-offset deviations
- Per-slice `kappa_slice_i` (independent LogNormal prior)
- Per-slice endpoint BetaBinomial via `_emit_edge_likelihoods`
  (single code path for aggregate and per-slice emissions)
- Parent always emitted unless all slices exhaustive
- Param recovery: all per-slice p, kappa recovered within threshold

**R2b2 — Per-slice latency** ✅ (9-Apr-26):
- `mu_slice_i = mu_base + eps_mu_i * τ_mu_slice` (non-centred)
- Same pattern for `sigma_slice_i` and `onset_slice_i`
- Truth file extended with `mu_offset`, `onset_offset` per context
- Param recovery: per-slice mu, sigma, onset recovered

**R2c — Branch-group hierarchical Dirichlet** ✅ (10-Apr-26):
- Per-slice `Dirichlet(κ_bg * base_weights)` from Section 2b
  in `model.py` (lines 689-707)
- **Per-slice Multinomial likelihoods**: `_emit_branch_group_multinomial`
  called per context key with per-slice observations and per-slice
  p vars from `bg_slice_p_vars`. Uses per-slice kappa. Fixed
  10-Apr-26: originally only aggregate Multinomial was emitted,
  per-slice p vars had no data driving them.
- `has_window` detection fix: `SliceObservations` from
  `CohortObservation` with window-type trajectories now correctly
  sets `has_window=True` (trajectories checked by `obs_type`).
- Param recovery: per-slice branch weights recovered, correct
  ordering (google favours fast, email favours slow), all z-scores
  under 2.5.

**R2d — Per-date routing validation**:
- Mixed-epoch synthetic data: some dates aggregate-only, some
  per-slice
- Verify no double-counting: parent posterior width matches
  single-source expectations
- Satisfies doc 30 RB-003 contract (regime tag drives likelihood)

**R2e — Posterior summarisation** ✅ (10-Apr-26):
- Per-slice α/β/HDI/kappa/mu/sigma/onset in `posterior.slices` output
- Slice keys denominated with temporal qualifier:
  `context(channel:google).window()` (not bare `context(…)`)
- Cohort-denominated entries emitted when parent has cohort slice
- `_build_unified_slices` in `worker.py` copies all per-slice vars
  from `slice_posteriors` into the webhook payload
- `bayesPatchService.ts` writes full `slices` dict to
  `paramDoc.posterior.slices` — per-context entries persisted
- `posteriorSliceResolution.ts` `_findSliceByMode` already handles
  context-qualified keys (tries `context(…).window()` first, falls
  back to bare `window()`)
- **Predictive latency uncertainty**: NOT YET FIXED. Current
  mu_sd/sigma_sd/onset_sd are raw MCMC posterior SDs. Pre-existing
  issue — documented in `programme.md` as upstream blocker.

**R2f — Real data validation**:
- Run on `conversion-flow-v2-recs-collapsed` test graph (channel
  dimension, 4 values, 10 edges, branch groups)
- Per-slice posteriors should be consistent with aggregate
- Compare against analytic baselines
- Receipt: populate pipeline Stage 4 fields (slice routing),
  activate slice mismatch verdicts (§16.11 contexted fixtures 9-14)
- Per-slice recovery assertions (§12.5e)

**Gate**: parameter recovery passes for solo edges and branch groups.
Real test graph produces sensible per-slice posteriors.

### R2g — Multi-dimension and advanced cases (compound `;` DSLs)

Builds on R2a-R2f. **Required before compound pinned DSLs with
orthogonal hierarchies can be supported** — i.e. any pinned DSL using
`;` to combine independent MECE dimensions (e.g.
`(window();cohort()).(context(channel);context(variant)).`). See
§15A.2 for the structural gaps this milestone closes.

**R2g-i — Independent dimensions** (`compiler/model.py`):
- Two separate Dirichlets sharing a parent (§5.6)
- 1/N κ correction (§14.6d) — start with it, validate in recovery
- Parameter recovery: parent posterior width with two dimensions
  matches single-dimension case

**R2g-ii — Multi-level hierarchy for subsumption** (`compiler/model.py`):
- Cross-product + marginals (§5A.3 Rule 2)
- Per-date suppression: most granular wins
- Synthetic data with mixed epochs across granularities

**R2g-iii — `conditional_p` support** (`compiler/model.py`):
- Separate simplexes per condition (§6)
- Independent of R2g-i/R2g-ii

**Gate**: multi-dimension parameter recovery. Mixed-epoch suppression
verified.

### Parallelism

- R1a (receipt) and R1b (CLI) are independent
- R1c (BE refactoring) and R1d (FE engorging) are independent
- R1a-R1d can overlap; R1e (certification) requires all four
- R2a (synth generator) can start immediately after R1 gate
- R2b-R2e depend on R1c but NOT on R1d (hand-crafted test graphs)
- R2g substeps are independent of each other
- R2-prereq-i and R2-prereq-ii can be done in parallel
- R2-prereq-i blocks R2b (binder must honour the contract before slice modelling is correct)
- R2-prereq-ii blocks regression testing (harness must use CLI payload for accurate slice commissioning)
- Critical path: ~~R1a → R1c → R1e → R2-prereqs → R2a → R2b → R2b2 → R2c~~ → **R2d** → ~~R2e~~ → **R2f**
- Current position (10-Apr-26): R2c complete. Next: R2d (per-date routing) then R2f (real data validation).

---

## 12. Test data for Phase C

### 12.1 Real test graph

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

**Test data gaps for §5A scenarios**: this graph has a single context
dimension. §5A's multi-dimension scenarios (independent dimensions,
subsumption/marginals, cross-product + marginals, mixed-epoch regime
transitions) require synthetic multi-dimension data for parameter
recovery tests (step 8). The real test graph covers the common
single-dimension case only.

### 12.2 Synthetic graph requirements for model testing

Doc 17 (synthetic data generator) covers generation of snapshot DB
rows and Phase 2 extends it to context slices. But snapshot rows are
only the BE side. Model testing requires complete graph definitions
with context definitions, pinnedDSLs, and the full FE artefact set
so that:
- The FE trigger path can compute candidate regimes and snapshot
  subjects from the graph (testing the FE expectation computation)
- The binding receipt (§16) can compare FE expectations against
  BE reality on synthetic data with known-correct answers
- Parameter recovery tests exercise the full pipeline, not just
  the evidence binder in isolation

Doc 17 §11 specifies the artefact set (graph JSON, node/event/param/
context YAMLs, index files) and §11.2 covers core hash computation.
But it does not specify **which graph topologies** are needed for
contexted model testing or **what pinnedDSL shapes** each graph
should have.

**Required synthetic graphs:**

Each graph below needs the full artefact set (doc 17 §11.1), a
truth config (doc 17 §10.6), and generated snapshot rows. The graphs
are small (2-5 edges) — just enough topology to exercise the
specific scenario. They are not production-realistic; they isolate
one concern each.

**Graph S1 — Single MECE dimension, solo edge:**

Simplest possible contexted graph. One edge, one context dimension
with 3 values. Exercises basic slice pooling without branch group
or join complexity.

- Topology: 2 nodes, 1 edge
- Context: `channel` with values `[google, direct, email]`
- pinnedDSL: `(window(-90d:);cohort(-90d:)).context(channel)`
- Truth config: different `p` per channel (e.g. 0.4, 0.25, 0.15),
  same latency parameters
- Recovery target: per-slice posterior HDI contains true `p`;
  parent `p_base` HDI contains weighted aggregate
- What it validates: §5.2 logit-offset deviations, §5.4
  hierarchical shrinkage (email with low traffic should shrink
  toward base rate)

**Graph S2 — Single MECE dimension, branch group:**

Adds the Dirichlet constraint (§5.3). Three sibling edges sharing
a branch node, one context dimension.

- Topology: 4 nodes, 3 edges from one branch node
- Context: `channel` with values `[google, direct, email]`
- pinnedDSL: `(window(-90d:);cohort(-90d:)).context(channel)`
- Truth config: per-channel simplex weights differ from aggregate
  (e.g. google traffic favours edge 1, email favours edge 3)
- Recovery target: per-slice simplex weights + per-slice `p`
- What it validates: §5.3 hierarchical Dirichlet, per-slice
  simplex constraint, κ concentration parameter

**Graph S3 — Two independent MECE dimensions:**

The multi-dimension case. Two context dimensions that independently
partition the same conversions.

- Topology: 2 nodes, 1 edge
- Contexts: `channel` [google, direct], `device` [mobile, desktop]
- pinnedDSL: `(window(-90d:);cohort(-90d:)).context(channel);context(device)`
- Truth config: `p` varies by channel AND by device, but the two
  dimensions are independent (no interaction term)
- Snapshot rows: stored under two different core_hashes (one per
  MECE dimension — the signature includes context definition
  hashes). Also include aggregate (uncontexted) rows under a third
  hash
- Recovery target: per-dimension slice posteriors; parent `p_base`
  not double-counted (the 1/N κ correction from §14.6d)
- What it validates: §5.6 independent dimensions, §5A.3
  multi-regime handling, doc 30 regime selection across dimensions,
  1/N κ correction, binding receipt §16 regimes_seen > 1

**Graph S4 — Mixed-epoch regime transition:**

The DSL changed at some point in the past: originally uncontexted,
then context was added. Snapshot DB has rows under the old hash
(uncontexted) for early dates and under the new hash (contexted)
for later dates.

- Topology: 2 nodes, 1 edge
- Context: `channel` [google, direct] (added after 6 months of
  uncontexted fetching)
- pinnedDSL (current): `(window(-180d:);cohort(-180d:)).context(channel)`
- Snapshot rows: first 90 days under old core_hash with
  `slice_key = "window()"`, last 90 days under new core_hash with
  `slice_key = "context(channel:google).window()"` etc.
- FE candidate regimes include both hashes (epoch-aware enumeration
  via `computePlausibleSignaturesForEdge`)
- Truth config: same underlying `p` throughout, but observation
  format changes at the epoch boundary
- Recovery target: posterior uses all data correctly; no
  double-counting at the boundary
- What it validates: §5A.3 per-date routing (early dates →
  parent-only likelihood, late dates → per-slice likelihood),
  regime selection across epoch boundary, binding receipt §16
  shows mixed regimes

**Graph S5 — Cross-product with marginals:**

The subsumption case from §5A.3 Rule 2. Cross-product context
`context(channel).context(device)` produces fine-grained rows.
Marginal rows (`context(channel)` only) also exist for some dates.

- Topology: 2 nodes, 1 edge
- Contexts: `channel` [google, direct], `device` [mobile, desktop]
- pinnedDSL: `(window(-90d:);cohort(-90d:)).context(channel).context(device)`
- Snapshot rows: cross-product rows for all dates, plus marginal
  `context(channel)` rows for some dates (simulating a period
  where the DSL was less specific)
- Truth config: `p` varies by channel×device combination
- Recovery target: marginal rows suppressed by Rule 2; model fits
  on cross-product only; posteriors match truth
- What it validates: Rule 2 suppression, binding receipt §16
  rows_suppressed count, no double-counting from marginals

**Graph S6 — Engorged graph parity (R1e gate):**

Not a new topology — this is the existing `bayes-test-gm-rebuild`
graph with its data, but fed through the engorged graph pathway
(§9A) instead of the param file pathway. The parity gate for
R1c/R1d.

- Uses existing graph + existing snapshot rows
- FE engorges the graph edges with observations and priors from
  param files
- BE reads from engorged edges instead of param files
- Recovery target: posteriors identical to current param-file path
  (field-by-field parity, not just "both converge")
- What it validates: the engorged graph contract (§9A) produces
  identical model inputs to the param file contract

### 12.3 Relationship to doc 17 Phase 2

Doc 17 §10 specifies the context-aware row generation algorithm.
Doc 17 §12 Phase 2 specifies its delivery scope. The graphs above
(S1-S5) are the **consumers** of doc 17 Phase 2's generator — they
define the truth configs and graph topologies that the generator
must support.

The implementation order is:
1. Build graph definitions (artefacts) for S1-S5 in the data repo
   — these are just YAML/JSON files, no code
2. Extend doc 17 generator to support context slices (doc 17 §10,
   Phase 2)
3. Generate snapshot rows for each graph using the extended
   generator
4. Run parameter recovery tests against each graph

S6 (engorged parity) doesn't need the context generator — it uses
existing uncontexted data.

### 12.4 Relationship to §16.11 binding receipt fixtures

The synthetic graphs in §12.2 are for **model testing** — the model
runs, posteriors are checked against ground truth. The fixtures in
§16.11 are for **receipt contract testing** — the model never runs,
only the binding and receipt logic are exercised.

They serve different purposes and have different data requirements:
- §12.2 graphs need statistically valid data (counts that reflect
  known conversion rates and latency parameters)
- §16.11 fixtures need structurally valid data (correct field names
  and formats) but statistically arbitrary counts

Some §16.11 fixtures deliberately introduce mismatches (wrong hashes,
missing slices) that would never appear in §12.2's correctly
generated data. Conversely, §12.2's graphs exercise model behaviour
(shrinkage, convergence, Dirichlet concentration) that §16.11 cannot
test because the model never runs.

Both are needed. Neither substitutes for the other.

### 12.5 Regression pipeline changes for Phase C

The current regression pipeline (`run_regression.py` → `param_recovery.py`
→ `test_harness.py`) discovers synth graphs from truth files,
bootstraps snapshot data, runs MCMC, and asserts parameter recovery
via z-scores, rhat, and ESS. It needs to evolve in three ways for
Phase C.

#### 12.5a Current state and gaps

**What exists:**
- `synth_gen.py` has `context_dimensions` support in the row
  generator (person-level context assignment, per-slice snapshot
  rows with correct `slice_key` values, `dataInterestsDSL`/
  `pinnedDSL` generation). Coded, tested, never exercised — **no
  truth file uses `context_dimensions` yet**.
- `graph_from_truth.py` generates graph JSON and param/event/node
  YAMLs from truth files. **Does not generate `contexts/*.yaml`
  artefacts** — context dimensions are in the truth config but
  the data repo artefact (needed for FE `explodeDSL` and hash
  computation) is not produced.
- `run_regression.py` asserts z-scores, rhat, ESS, convergence
  percentage. **Does not assert LOO/ELPD** — the worker computes
  LOO scores and emits `delta_elpd` and `pareto_k_max` per edge
  to posteriors (doc 32, implemented 8-Apr-26), but
  `param_recovery.py` and `run_regression.py` do not read or
  check these fields.
- **No binding receipt assertions** — the receipt (§16) does not
  exist yet, and the regression pipeline has no hook for checking
  it.

#### 12.5b Context artefact generation

`graph_from_truth.py` must be extended to produce `contexts/*.yaml`
for each `context_dimensions` entry in the truth file. The YAML
format follows doc 17 §10.5:

```yaml
id: channel
name: Channel
type: categorical
values:
  - id: google
    label: Google
  - id: direct
    label: Direct
metadata:
  status: active
```

The values list comes directly from the truth config's
`context_dimensions[].values[]`. The context file must exist in
the data repo for the FE's `explodeDSL()` to expand bare
`context(channel)` into per-value slices, and for
`normalizeContextDefinition()` to compute the context definition
hash that enters the signature.

Without this artefact, FE-side hash computation cannot work, which
means `candidateRegimesByEdge` and `snapshotSubjects` cannot be
built, which means the binding receipt (§16) has nothing to compare
against.

#### 12.5c LOO/ELPD as a regression assertion

On synthetic data with known ground-truth parameters, the model
should fit well — LOO/ELPD should reflect this. Specifically:

**ΔELPD ≥ 0 per edge**: on synthetic data generated from the
model's own generative process, the Bayesian model should not be
worse than the analytic null. A negative ΔELPD on synthetic data
means either: (a) evidence binding is wrong (wrong data entered
the model), (b) the model is misspecified relative to its own
generative process (a code bug), or (c) LOO computation is broken.
All three are worth catching.

**Pareto k < 0.7 per edge**: high Pareto k on synthetic data means
an observation has outsized influence, which shouldn't happen when
the data matches the model. Values above 0.7 on synth data indicate
a binding or model geometry problem.

**What to add to `run_regression.py`:**

New assertion tier (alongside existing z-score/rhat/ESS checks):

```
# LOO assertions (synth-data-specific)
delta_elpd_min: 0.0        # per-edge ΔELPD must be ≥ 0
pareto_k_max: 0.7          # per-edge max Pareto k must be < 0.7
```

These are soft assertions initially (warn, not fail) because LOO
is new and thresholds need calibration against the existing synth
graphs before being promoted to hard gates.

**Implementation**: `param_recovery.py` already parses the harness
log output. The worker emits `delta_elpd` and `pareto_k_max` to
the posterior summary. The test harness log needs to include these
in its structured output (currently it doesn't — add a LOO summary
line per edge alongside the existing z-score/Δ lines).

#### 12.5d Binding receipt as a regression assertion

When the binding receipt (§16) is implemented, the regression
pipeline should check it as a pre-fit gate:

- **All edges pass**: no verdict = fail in the receipt
- **Receipt logged**: the receipt appears in the harness log for
  post-hoc inspection
- **Known divergences flagged**: on synthetic data, the receipt
  should show zero divergences (the truth file generated the data,
  so expectations and reality should match perfectly). Any
  divergence on synth data is a generator or binding bug.

This is a stronger assertion than on real data, where partial
coverage and hash transitions are expected. On synth data, the
generator controls both sides — any mismatch is a bug.

#### 12.5e Per-slice recovery assertions (Phase C specific)

The existing z-score assertions are per-edge (one `p` per edge).
Phase C adds per-slice posteriors. The regression pipeline needs:

- **Per-slice z-scores**: for each `(edge, context_value)` pair,
  the posterior slice's HDI must contain the true per-slice `p`
  from the truth config's `edge_overrides`
- **Parent recovery**: `p_base` posterior HDI must contain the
  true aggregate `p` (weighted by context traffic shares from
  truth config)
- **Shrinkage validation**: low-traffic slices should shrink toward
  the base rate. Not a hard assertion — visual inspection via a
  shrinkage diagnostic plot (truth vs posterior mean vs base rate,
  with traffic volume on x-axis)
- **Simplex recovery** (branch groups): per-slice simplex weights
  HDI must contain truth; `κ` concentration parameter should be
  in a sensible range

`param_recovery.py` currently parses per-edge results. It needs
to parse per-slice results from the harness log. The harness log
format needs to extend: currently emits one line per edge per
parameter (`mu`, `sigma`, `onset`, `p`); needs to emit one line
per slice per edge for `p_slice` and `weight_slice`.

Truth file format needs a new `testing.per_slice_thresholds`
section:

```yaml
testing:
  thresholds:
    p_z: 2.5
    mu_z: 2.5
  per_slice_thresholds:
    p_slice_z: 3.0       # looser — smaller n per slice
    weight_z: 3.0         # simplex weight recovery
```

#### 12.5f Implementation order

1. **R1 (data binding assurance)**: write first contexted truth
   file for graph S1 (§12.2). Extend `graph_from_truth.py` for
   context YAML generation. Verify `synth_gen.py` context support
   works end-to-end with real artefacts. Add receipt assertions
   to regression pipeline (zero divergences on synth data). Add
   ΔELPD and Pareto k assertions as soft gates, calibrate
   thresholds, then promote to hard gates. All of this works with
   the existing aggregate model — no Phase C model changes needed.

2. **R2 (model work)**: add per-slice recovery assertions. Write
   truth files for S2-S5 (§12.2). Run full regression with
   per-slice z-scores.

| Risk | Impact | Mitigation |
|---|---|---|
| Variable count explosion | Slow MCMC, poor convergence | Independent dimensions scale additively (§5.6); hierarchical shrinkage handles low-data slices (§5.4) |
| MECE misclassification | Double-counting | All `context()` dimensions are MECE by construction; `case()` is MECE by definition |
| DSL canonicalisation mismatch (Python vs TS) | `posterior.slices` keys don't match FE lookup | Python port of `normalizeConstraintString()` ordering; integration test with round-trip |
| Multi-regime double-counting | Evidence inflated by rows from multiple hash families | `select_regime_rows()` (doc 30) + per-date suppression (§5A.3 Rule 2) |
| Per-date likelihood routing error | Same observations feed both parent and child terms | Per-date routing (§5.7). Mixed-epoch parameter recovery test (§11 R2d) |
| No MECE partition exists for any date | Parent `p_base` unconstrained | Compiler validation: reject edge with diagnostic (§5A.3 Rule 2) |
| FE sends wrong candidate regime order | Wrong data selected | Inherent contract risk (doc 30 §7.3.11). FE tests + end-to-end tests |
| 1/N κ correction approximate | Parent overconfident with multiple independent dimensions | Start with 1/N, validate in parameter recovery (§11 R2g-i) |

---

## 14. Design decisions log (7-Apr-26 revision)

Decisions made during the doc 30 alignment review, recorded for
context. All resolved — no open issues remain.

- **Regime selection is a hard prerequisite** for snapshot evidence
  binding. File-based evidence uses engorged graphs (§9A) and does
  not need regime selection.
- **No non-MECE slice dimensions** in practice. `visited()` is a
  query filter, not a partitioning dimension.
- **No per-slice min-n gate.** Hierarchical shrinkage handles
  low-data slices naturally (§5.4, §10.2).
- **No residual computation.** All slices participate. No threshold
  creates excluded slices.
- **Multi-level hierarchy** for subsumption cases (§5A.3 Rule 2).
  Most granular wins per date — straightforward suppression.
- **Independent dimensions** get 1/N κ correction (approximate,
  validate in recovery tests).
- **Engorged graphs** replace param files in the Bayes payload
  (§9A). FE injects observations, priors, and warm-start onto
  graph edges. BE reads structured data. No sliceDSL parsing on BE.
- **One graph per slice.** N+1 engorged graphs (parent + children).
  Each self-contained.
- **`context()` DSL fix** (doc 30 §10) is independent work, not
  blocking. Either path works architecturally.

---

## 15. What this document does NOT cover

- FE consumption of `posterior.slices` (see doc 9 Phase C overlay)
- FE per-slice visualisation components
- Regime selection utility implementation (see doc 30)
- FE candidate regime construction (see doc 30 §4.1)
- DSL parsing gap for `context()` as uncontexted (see doc 30 §10)
- FE engorging implementation detail (§9A defines the contract;
  `useBayesTrigger.ts` integration is FE work)
- Temporal drift interaction details (see doc 11 §10)
- Full downstream `conditional_p` propagation (future, data-dependent)

---

## 15A. Implementation status audit (14-Apr-26)

### 15A.1 What is correctly implemented

- DSL parsing and `SliceGroup` routing (`slices.py`, `evidence.py`)
- Per-slice hierarchical p emission for **single-dimension** graphs
  (solo edges: logit-Normal offset + τ_slice; branch groups:
  hierarchical Dirichlet with κ)
- Per-slice posterior extraction (`inference.py`)
- Per-slice mu offsets (tau_mu_slice) — mu-only latency hierarchy
- Per-slice (m, r) offsets via `latency_reparam` (doc 34 §11.9.1) —
  per-slice onset and sigma variation, shared a
- Per-date regime filtering in evidence binder (`evidence.py:668-684`)
  — aggregate rows removed on `mece_partition` dates, achieving §5.7's
  intent at the data level rather than the emission level
- Aggregate emission suppression for exhaustive MECE slices
- `bayesEngorge.ts` wired for FE→BE payload
- Per-slice regression reporting (doc 35)

### 15A.2 Structural gaps (multi-dimension)

**Known limitation — compound pinned DSLs not supported**: pinned DSL
strings with `;`-separated orthogonal hierarchies (e.g.
`(window(-30d:);cohort(li-c-account-created,-30d:)).(context(channel);context(onboarding-blueprint-variant);context(energy-blueprint-variant)).`)
cannot be correctly modelled until Gaps 1–3 below are resolved. The
core issue is that overlapping/orthogonal dimension groups each
constrain the same base edge variables (`p_base`, `kappa`), requiring
per-dimension τ (Gap 1) and 1/N κ correction (Gap 2) to avoid
over-constraining the parent. This is the R2g milestone.

These gaps are invisible on single-dimension synth graphs but will
produce misspecified models on production graphs with multiple context
dimensions.

**Gap 1 — Single τ across all dimensions (CRITICAL)**

Design (§5.6, line 409): each dimension has its own τ_slice (solo
edges) or κ + base_weights (branch groups).

Implementation: `model.py:1299-1305` flattens all slices from all
context dimensions into a single list. One `tau_slice` governs all
slices across all dimensions. One `tau_mu_slice` / `tau_m_slice` /
`tau_r_slice` similarly shared.

Impact: cannot express "channel has high p variation but low latency
variation" vs "onboarding has low p variation but high latency
variation." The single τ is forced to compromise, over-shrinking the
high-variation dimension and under-shrinking the low-variation one.
This applies to p, mu, m, r — every hierarchical parameter.

Fix: iterate over `ev.slice_groups.items()` creating per-dimension
τ and offset vectors. Each dimension's slices get their own shrinkage.

**Status (14-Apr-26): FIXED.** `model.py` now creates per-dimension
tau variables (`tau_slice_{edge}__{dim}`, `tau_m_slice_{edge}__{dim}`,
`tau_r_slice_{edge}__{dim}`, `tau_mu_slice_{edge}__{dim}`) when
multiple dimensions exist. Single-dimension graphs unchanged. Branch
group kappa is also per-dimension (`kappa_slice_bg_{group}__{dim}`).
Tested in `test_compiler_phase_s.py::TestTwoDimensionModelWiring`.

**Gap 2 — 1/N κ correction ~~not implemented~~**

Design (§5A.7, §14.6d): with N independent MECE dimensions each
constraining the same parent, the parent sees N× the information it
should. A 1/N κ correction prevents parent overconfidence.

**Status (14-Apr-26): FIXED.** When N > 1 dimensions, the aggregate
emission's kappa is scaled by 1/N via `kappa_agg_corrected_{edge}`.
This is an approximate correction (see risk table). Tested in
`test_compiler_phase_s.py::TestTwoDimensionModelWiring`.

**Gap 3 — Multi-dimension synth graphs ~~(R2g never tested)~~**

Design (§11, Graph S3): specifies a two-dimension synth graph
(channel + device) to validate independent Dirichlets and 1/N κ.

**Status (14-Apr-26): PARTIAL.** S5 truth file created
(`synth-context-two-dim.truth.yaml`) with channel (3 values) + device
(2 values). Graph JSON generated. Dry run passes. Synth generator hash
pipeline fixed for multi-dimension (per-dimension `core_hash` storage
and assignment). Full MCMC param recovery not yet run. R2g-ii
(subsumption) and R2g-iii (`conditional_p`) remain untested.

**Gap 4 — `conditional_p` not implemented**

Design (§6): conditional populations get separate simplexes.

Implementation: `conditional_p` does not appear in `model.py`.

**Gap 5 — Multi-level hierarchy for subsumption not implemented**

Design (§5A.3 Rule 2): when one dimension subsumes another, a
multi-level hierarchy with per-date suppression should be built.

Implementation: not implemented. Only independent dimensions handled
(and those incorrectly per Gap 1).

### 15A.3 Proposed addition: `per_slice_latency` context flag

**Date**: 14-Apr-26.
**Status**: Proposed. Not yet implemented.

**Problem**: per-slice latency parameters (doc 34 §11.9.1) add
significant model complexity — 2S+5 latency params per edge vs 3
for shared latency. For context dimensions that don't affect timing
(e.g. acquisition channel), this complexity is wasted: the sampler
explores a direction where there's nothing to find, the edge-level
mean becomes weakly identified for no benefit, and convergence
suffers (doc 34 §11.11).

**Observation**: whether a context dimension affects latency is
genuine domain knowledge that the user can provide. Channel is
unlikely to affect timing (the funnel steps have the same mechanics
regardless of acquisition source). Onboarding flow variant genuinely
changes the process steps and timing. The model doesn't need to
discover this — it's structural prior knowledge.

**Proposal**: add a `per_slice_latency` boolean to the context
definition. Default `false`.

- **`per_slice_latency: false`** (default): this dimension's slices
  share edge-level latency (onset, mu, sigma). Only p varies per
  slice. All slice data constrains the shared (m, a, r) directly.
  No latency-related τ or offset RVs for this dimension.

- **`per_slice_latency: true`**: this dimension gets per-slice
  latency offsets (m and r, shared a — doc 34 §11.9.1). Per-dimension
  τ_m and τ_r control shrinkage independently.

**Where the flag lives**: on the context definition YAML, not on the
edge or graph. It is a property of the context dimension:

```yaml
contexts:
  channel:
    slices: [google, direct, email, ...]
    per_slice_latency: false    # timing doesn't vary by channel
  onboarding-blueprint-variant:
    slices: [flow_a, flow_b, flow_c]
    per_slice_latency: true     # timing genuinely differs
  energy-blueprint-variant:
    slices: [plan_x, plan_y]
    per_slice_latency: false    # timing unaffected
```

Could also be specified per-edge if needed (some edges may have
channel-dependent timing while others don't). Context-level with
edge-level override is the pragmatic default.

**Parameter count impact** (5-edge graph, 3 context dims as above):

| Configuration | Latency params / edge | Total |
|---|---|---|
| All shared (all flags false) | 3 | 15 |
| Onboarding only true (S=3) | 2×3 + 5 = 11 | 55 |
| All true (S=5+3+2=10) | 2×10 + 5 = 25 | 125 |

**PPC validation**: if the user sets `per_slice_latency: false`
incorrectly, per-slice timing residuals in the PPC layer will show
systematic patterns (one slice's maturation curve consistently faster
or slower than predicted). This provides a feedback loop: default
conservative → run → check PPC → upgrade to `true` if residuals
indicate timing heterogeneity.

**Interaction with Gap 1**: the per-dimension τ fix (Gap 1) is a
prerequisite for this flag. Without per-dimension τ, there's no
mechanism to apply different shrinkage to different dimensions. With
per-dimension τ, the flag simply controls whether the latency τ and
offsets are created for a given dimension.

**Interaction with multi-dimension latency**: with multiple
`per_slice_latency: true` dimensions, each gets its own τ_m and τ_r.
Per-slice m for a trajectory is additive:
`m_slice = m_edge + Σ(delta_m_dim[dim_index])`. This is a main-effects
model — no interaction terms. See doc 34 §11.11 for the geometry
implications.

### 15A.4 Priority ordering

**Prerequisite — contexted geometry (RESOLVED 14-Apr-26)**

Geometry was previously blocking: adding contexts dropped ESS from
690–1356 to 66–113. Centred parameterisation (doc 34 §11.11.7) and
(m, a, r) quantile coordinates (doc 34 §11.9.1) resolved this —
performance is now adequate.

**Sequencing (updated 14-Apr-26):**

1. **Gap 1 (per-dimension τ)** — **DONE.** Structural correctness for
   multi-dimension graphs. Per-dimension tau and kappa implemented.
2. **`per_slice_latency` flag** — enables practical use of per-slice
   latency without geometry collapse. Also reduces compute load for
   complex multi-context graphs by eliminating unnecessary per-slice
   latency RVs on dimensions where timing doesn't vary.
3. **Gap 2 (1/N κ correction)** — **DONE.** Aggregate kappa scaled by
   1/N when N > 1 dimensions.
4. **Gap 3 (multi-dimension synth graphs)** — **PARTIAL.** S5 truth
   file + graph created. Synth generator hash pipeline fixed. Full
   MCMC param recovery pending.
5. **Gap 4 (`conditional_p`)** — not needed until production graphs
   use conditionals.
6. **Gap 5 (subsumption hierarchy)** — not needed until production
   DSLs use nested dimensions.

---

## 16. Binding receipt: FE expectation vs BE reality (9-Apr-26)

### 16.1 Problem

The Bayes pipeline has a systematic debugging gap at the evidence
binding step. The FE computes what data *should* exist (candidate
hashes, expected slices, anchor date ranges) and sends these
expectations in the payload. The BE queries the DB, runs regime
selection, and binds evidence. But the two views are never compared.

When a posterior looks wrong, there is no way to determine whether the
problem is in the data (wrong rows bound), the model (correct rows,
wrong inference), or the binding (rows exist but were misrouted,
deduplicated incorrectly, or silently dropped). The only diagnostic
is free-text log lines that require manual interpretation.

This is already a problem for uncontexted data. Phase C makes it
worse: context slice routing adds another stage where rows can be
misassigned, and the deduplication logic (regime selection + Rule 2
suppression + MECE aggregation) becomes multi-layered.

The cost of a bad binding is high: the model runs (minutes of compute
on Modal), produces plausible-looking posteriors, and the problem only
surfaces when someone notices the numbers are wrong — potentially much
later.

### 16.2 Design: compare at the BE, fail fast before fitting

The FE already sends per-edge expectations in the payload:

- `snapshot_subjects`: param_id, edge_id, core_hash, slice_keys,
  anchor_from/to, sweep_from/to, equivalent_hashes
- `candidate_regimes_by_edge`: core_hash + equivalent_hashes per edge
- `mece_dimensions`: which dimensions are safe to sum across

The BE has the reality after DB query + regime selection + evidence
binding. The comparison happens at the BE — not round-tripped to the
FE — so that mismatches halt the pipeline *before* the model runs.

### 16.3 The binding pipeline and where counts are captured

The evidence pipeline has five stages. The receipt captures row counts
at each stage boundary, because a problem at each stage has a
different diagnostic meaning.

```
Stage 1: DB query
  snapshot_subjects → raw rows per edge
  (failure here = hash mismatch, DB empty, query error)

Stage 2: Regime selection (dedup across hash families)
  raw rows → select_regime_rows() → filtered rows
  (rows discarded here = duplicate regimes for same conversions)
  RegimeSelection.regime_per_date tells you WHICH regime won per date

Stage 3: Rule 2 suppression (dedup across granularity)
  filtered rows → most-granular-wins per (anchor_day, retrieved_at)
  (rows discarded here = coarser data superseded by finer)

Stage 4: Slice routing (Phase C only — which context slice?)
  surviving rows → assigned to expected slices by context_key()
  (orphan rows here = context_key doesn't match any expected slice)

Stage 5: Trajectory building
  routed rows → CohortObservation trajectories + daily obs
  (rows lost here = zero-count filter, parse failures, dedup by
   retrieved_at within an anchor_day)
```

### 16.4 Receipt structure

The receipt is a structured dict returned alongside `BoundEvidence`,
built by comparing the FE's `snapshot_subjects` (grouped by edge_id)
against what each pipeline stage actually produced.

**Per-edge receipt fields:**

```
edge_id              — edge identifier
param_id             — which param file
verdict              — pass | warn | fail (derived mechanically, see §16.5)

# Stage 1: hash resolution
expected_hashes      — core_hash + equivalents from FE candidate regimes
hashes_with_data     — which of those actually had rows in the DB
hashes_empty         — expected but no rows found

# Stage 2: regime selection
rows_raw             — total rows from DB for this edge
rows_post_regime     — rows surviving regime selection
regimes_seen         — how many distinct regimes appeared in raw data
regime_selected      — which regime's core_hash won (per-date detail
                       available in regime_per_date but not in receipt
                       summary — too verbose)

# Stage 3: Rule 2 suppression
rows_post_suppression — rows surviving granularity dedup
rows_suppressed       — count removed by Rule 2

# Stage 4: slice routing (Phase C; omitted for uncontexted)
expected_slices      — slice_keys from FE snapshot_subjects
observed_slices      — context_key values parsed from surviving rows
missing_slices       — expected but not observed
unexpected_slices    — observed but not expected
orphan_rows          — rows that couldn't be assigned to any slice

# Stage 5: what entered the model
evidence_source      — snapshot | param_file | mixed | none
window_trajectories  — count
window_daily         — count
cohort_trajectories  — count
cohort_daily         — count
total_n              — total observations bound

# Date coverage
expected_anchor_from — from FE subject
expected_anchor_to   — from FE subject
actual_anchor_from   — earliest anchor_day in bound evidence
actual_anchor_to     — latest anchor_day in bound evidence
anchor_days_covered  — distinct anchor_days with ≥1 observation

# Gate outcomes
skipped              — bool: edge excluded from fitting
skip_reason          — why (min_n, no data, etc.)

# Divergences (the useful part)
divergences          — list of human-readable mismatch descriptions
                       (empty = everything matched)
```

**Graph-level summary:**

```
edges_expected       — edges the FE sent subjects for
edges_bound          — edges with evidence successfully bound
edges_fallback       — edges that fell back to param_file evidence
edges_skipped        — edges excluded (min_n, no data, etc.)
edges_no_subjects    — edges in topology but not in FE subjects
edges_warned         — edges with non-empty divergences
edges_failed         — edges where verdict = fail
```

### 16.5 Verdict derivation

Per-edge verdict is mechanical, not heuristic:

**fail** — the binding is broken, model output for this edge would be
unreliable:
- All expected hashes empty (hash mismatch — FE thinks data exists,
  DB disagrees)
- rows_raw > 0 but total_n = 0 (data exists but entire pipeline
  discarded it)
- All expected slices missing (Phase C: context topology completely
  divergent)

**warn** — the binding produced evidence but something is off:
- Some expected hashes empty (partial hash coverage)
- regime selection discarded >50% of rows (high dedup ratio —
  indicates complex multi-regime topology, worth inspecting)
- missing_slices non-empty (some context slices have no data)
- unexpected_slices non-empty (DB has slices the FE didn't expect)
- orphan_rows > 0 (rows survived dedup but couldn't be routed)
- evidence_source = param_file when FE sent snapshot_subjects
  (silent fallback)
- coverage_gap: actual anchor range covers <50% of expected range

**pass** — everything matched within tolerance.

### 16.6 Where it lives in the code

**Worker (`worker.py`):**

Currently (lines 458-487) the worker runs regime selection per edge
but discards `RegimeSelection.regime_per_date` — it keeps only
`.rows`. The receipt requires preserving the full `RegimeSelection`
object per edge so that regime_selected and regimes_seen can be
populated.

The receipt is built after `bind_snapshot_evidence()` returns, in the
existing "intermediate evidence summary" block (lines 505-532). This
block already iterates per edge and logs counts — the receipt
replaces those ad-hoc log lines with structured data.

The `snapshot_subjects` from the payload (line 436) must be grouped
by edge_id at receipt-build time to provide the FE expectation side
of the comparison.

**Evidence binder (`compiler/evidence.py`):**

The binder itself does not need to change for the receipt. It already
returns `BoundEvidence` with per-edge `EdgeEvidence` containing all
the Stage 5 counts. The receipt is built *outside* the binder by
comparing binder output against FE expectations.

However, Stage 3 (Rule 2 suppression) and Stage 4 (slice routing)
happen *inside* `_bind_from_snapshot_rows()`, which currently does not
report how many rows were suppressed or orphaned. Two options:

1. Add suppression/routing counts to `EdgeEvidence` (new fields)
2. Return them as a separate side-channel from
   `_bind_from_snapshot_rows()`

Option 1 is simpler and keeps everything on the existing dataclass.

**Types (`compiler/types.py`):**

New `BindingReceipt` and `EdgeBindingReceipt` dataclasses. Kept
separate from `BoundEvidence` — the receipt is a diagnostic artefact,
not model input.

### 16.7 Behaviour: gate vs log

The receipt supports two modes, controlled by a setting:

- **`binding_receipt: "log"`** (default) — build the receipt, log
  divergences at warning level, proceed with fitting. This is the
  dev/test diagnostic mode.

- **`binding_receipt: "gate"`** — build the receipt, and if any edge
  has verdict = fail, halt the pipeline before fitting and return the
  receipt as the job result. No compute wasted on bad data.

Both modes always build the receipt. The difference is whether a
`fail` verdict stops the pipeline.

A third option for the future: **`binding_receipt: "gate_and_refit"`**
— exclude failed edges and fit the rest. Not needed now.

### 16.8 Interaction with existing diagnostics

The receipt does not replace `BoundEvidence.diagnostics` (the
free-text log lines). Those remain for detailed per-row tracing. The
receipt is a structured summary for programmatic comparison and
go/no-go decisions.

The receipt does replace the ad-hoc evidence summary logging in
`worker.py` lines 505-532. That block currently duplicates
information that the receipt captures more completely.

### 16.9 Interaction with Phase C

For uncontexted data (current state), Stage 4 (slice routing) is
trivially empty — all rows are aggregate, no routing needed. The
receipt still captures Stages 1-3 and 5, which is where the known
failure modes live (anti-pattern 11, double-counting).

Phase C adds Stage 4. The receipt fields `expected_slices`,
`observed_slices`, `missing_slices`, `unexpected_slices`, and
`orphan_rows` become populated. The verdict rules for slice
mismatches (§16.5) activate.

This means the receipt can be implemented and validated *now* on
uncontexted data, before Phase C adds the slice routing complexity.
When Phase C lands, the receipt automatically picks up the new stage
without structural changes — only the Stage 4 fields get populated.

### 16.10 Implementation staging

The binding receipt is part of the R1 (data binding assurance)
phase defined in §11. See §11 for the authoritative programme.

The receipt-specific work maps to R1 steps as follows:

- **R1a** — receipt infrastructure (this section: §16.3-16.9)
- **R1b** — CLI tool to commission runs via FE codepath (§16.12)
- **R1e** — certification using receipt + CLI against all test
  graphs; receipt must show zero divergences
- **R1f** — harness bridge: one-time receipt parity check

During R2 (model work), the receipt picks up contexted data:

- **R2f** — populate pipeline Stage 4 fields (slice routing),
  activate slice mismatch verdicts (§16.11 contexted fixtures 9-14)

### 16.12 CLI tool for Bayes commissioning

#### 16.12a Purpose and phasing

A new `dagnet-cli bayes` command, following the existing `analyse`
command pattern: Node process, FE service layer, same codepath the
browser uses.

This tool is used during the **data binding assurance phase** to
achieve zero defects in evidence binding before any model work
begins. It commissions Bayes runs via the real FE pipeline so that
the binding receipt (§16.3-16.5) reflects the actual production
data pathway.

Once data binding is certified (R1 gate passes), R2 model work
begins. Model work requires intensive parallel compute iterations
— that's what the existing harness (`test_harness.py` +
`run_regression.py`) is good at. The harness is retained unchanged
for that purpose.

#### 16.12b Implementation

Follows the `cli/commands/analyse.ts` pattern exactly:

1. `cli/bootstrap.ts` loads graph from disk, seeds fileRegistry
   with events, contexts, parameters, workspace
2. Command calls the same service functions as
   `useBayesTrigger.ts`: `explodeDSL`, `buildFetchPlanProduction`,
   `mapFetchPlanToSnapshotSubjects`, `buildCandidateRegimesByEdge`,
   `computeMeceDimensions`
3. Assembles the payload and POSTs to the local Python server
4. Displays the binding receipt and fit result

Low complexity — the services are pure functions, the CLI
infrastructure already exists, and the `analyse` command proves
the pattern works.

#### 16.12c Harness contract verification

The existing harness has its own payload construction path
(`compute_snapshot_subjects.mjs`). This is fine for model work —
it's optimised for parallel execution. But before using the harness
for R2 model work, a one-time dev step confirms it honours the same
data binding contract:

1. Run CLI tool against a graph → get binding receipt A
2. Run harness against the same graph → get binding receipt B
3. Confirm receipts match (same hashes, same rows bound, same
   regime selection, same observation counts)

This is a do-it-once step per graph, not an ongoing gate. Once
confirmed, the harness is cleared for intensive model iteration on
that graph.

### 16.11 Test fixtures: synthetic graphs for receipt validation

The existing test data (§12, real graph `conversion-flow-v2-recs-
collapsed`) and synthetic data generator (doc 17) are necessary but
not sufficient. The real graph exercises "does binding work on correct
data" — it cannot exercise "does the receipt correctly detect binding
failures" because the real data is (presumably) correctly bound. The
synthetic generator (doc 17) produces snapshot rows but not the FE
side: graph definitions, context YAMLs, pinnedDSLs, candidate
regimes, and snapshot subjects.

The receipt needs test fixtures where **both sides are hand-crafted**
— FE expectations and BE rows — with deliberate mismatches in known
locations so that verdicts can be asserted.

**What each fixture contains:**

Each fixture is a self-contained test case:
- A small graph definition (2-4 edges) with explicit `pinnedDSL`
- Context definitions (YAML) where applicable
- `snapshot_subjects` array (the FE expectation)
- `candidate_regimes_by_edge` dict (the FE expectation)
- `mece_dimensions` list
- Synthetic snapshot DB rows (the BE reality)
- Expected receipt per edge: verdict, divergence list, key counts

The graph definitions don't need to be valid for model fitting. They
need valid topology (node IDs, edge IDs, param IDs) and realistic
DSL structure so the evidence binder's classification logic runs.
The snapshot rows need valid `core_hash`, `slice_key`, `anchor_day`,
`retrieved_at`, `x`, `y` fields — the actual counts don't matter
for receipt testing (they matter for model testing, which is doc 17's
job).

**Required fixture set (R1 — uncontexted):**

1. **Happy path**: FE expects 1 hash, DB has rows under that hash.
   Receipt: pass, zero divergences. Baseline sanity check.

2. **Hash mismatch**: FE expects hash `abc123`, DB has rows only
   under `def456` (no equivalence mapping). Receipt: fail,
   divergence = "all expected hashes empty."

3. **Hash equivalence**: FE expects hash `abc123` with equivalent
   `def456`. DB has rows under `def456` only. Receipt: pass (the
   equivalence mapping bridges it). Verifies regime selection
   handles equivalent hashes.

4. **Multi-regime dedup**: DB has rows under 2 different hashes for
   the same edge (e.g. DSL era transition). FE sends both as
   candidate regimes. Receipt: pass, but `regimes_seen = 2`,
   `rows_post_regime < rows_raw`. Verifies dedup happened and
   receipt reports the ratio.

5. **Partial date coverage**: FE expects anchors 1-Jan-25 to
   1-Apr-26. DB has rows only from 1-Jun-25 to 1-Feb-26. Receipt:
   warn, divergence = coverage gap.

6. **Silent fallback**: FE sends snapshot_subjects for an edge, but
   DB returns zero rows. Evidence binder falls back to param file.
   Receipt: warn, `evidence_source = param_file` when snapshot was
   expected.

7. **Total pipeline discard**: DB has rows, regime selection keeps
   some, but all surviving rows have zero counts and get filtered.
   Receipt: fail, `rows_raw > 0` but `total_n = 0`.

8. **No FE subjects for edge**: Edge exists in topology but FE
   didn't send snapshot_subjects (e.g. no pinnedDSL). Receipt:
   edge appears in `edges_no_subjects`, no divergence (this is
   expected behaviour).

**Required fixture set (R2 — contexted, with Phase C model):**

9. **Single MECE dimension — happy path**: FE expects slices
   `[context(channel:google), context(channel:meta)]`. DB has rows
   with matching `slice_key` values. Receipt: pass, both slices
   observed.

10. **Missing slice**: FE expects 3 slices, DB has rows for only 2.
    Receipt: warn, `missing_slices = ["context(channel:other)"]`.

11. **Unexpected slice**: DB has rows with a `slice_key` the FE
    didn't expect (e.g. a context value added after the last fetch
    plan). Receipt: warn, `unexpected_slices` non-empty.

12. **Orphan rows**: After regime selection, some rows have a
    `context_key()` that doesn't match any expected slice (e.g.
    normalisation mismatch between FE DSL explosion and DB
    slice_key format). Receipt: warn, `orphan_rows > 0`.

13. **Multi-dimension independent**: FE sends 2 MECE dimensions
    as candidate regimes. DB has rows under both. Regime selection
    picks one per date. Receipt: pass, `regimes_seen = 2`,
    regime_selected shows which won.

14. **Cross-product with marginals**: DB has rows at cross-product
    granularity and marginal granularity. Rule 2 suppression
    removes marginals. Receipt: pass, `rows_suppressed > 0`
    with correct count.

**Fixture format:**

Fixtures live in `bayes/tests/fixtures/binding_receipt/` as Python
dicts (or JSON files loaded by the test). Each fixture is a function
returning `(payload_fragment, snapshot_rows, expected_receipt)`.
The test calls the receipt builder with the fixture data and asserts
the receipt matches expectations field by field.

This is distinct from doc 17's synthetic data generator, which
produces statistically valid data for parameter recovery. The receipt
fixtures produce structurally valid but statistically meaningless
data — the counts are arbitrary because the model never runs.
