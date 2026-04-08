# Phase C: Slice pooling and hierarchical Dirichlet — detailed design

**Status**: Ready for implementation — Phase D prerequisites met,
doc 30 regime selection in progress (hard prerequisite for step 3+)
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

Three stages addressing three distinct challenges: data binding
contract, hierarchical model, and multi-dimension extensions.

**Hard prerequisite**: `select_regime_rows()` (doc 30 §6) must be
implemented before Stage 1a's snapshot supplementation path. Doc 30
is being implemented now.

**Prior work completed**: slice DSL parser (`compiler/slices.py`) ✅,
IR types (`SliceKey`, `SliceObservations`, `SliceGroup` in
`compiler/types.py`) ✅, evidence binding scaffolding
(`_populate_slices()` in `compiler/evidence.py`) ✅.

### Stage 1 — Engorged graph contract (data binding)

No model changes. Proves the new data contract works with the
existing aggregate model.

**1a — BE refactoring** (`compiler/evidence.py`):
- Replace param file `values[]` parsing (current lines 99-166) with
  graph-edge reader: read `_bayes_evidence`, `_bayes_priors`
- Replace prior resolution from param files (current lines 86-97,
  1021-1216) with graph-edge reader
- Keep completeness computation (same CDF logic)
- Keep snapshot evidence binding (unchanged)
- Update snapshot supplementation to read graph-edge observations
  for uncovered anchor_days (replacing param file fallback)

**1b — FE engorging step** (`useBayesTrigger.ts` or new service):
- For each per-slice graph, for each edge: filter param file
  `values[]` by slice, resolve priors (apply quality gates),
  inject onto edge as `_bayes_evidence` and `_bayes_priors`
- Run topo pass per slice → per-slice model_vars on edges
- Remove `parameter_files` and `parameters_index` from payload
- Can develop in parallel with 1a

**Gate**: run existing aggregate model via engorged graph, verify
identical posteriors to current param-file path. Parity test.

### Stage 2 — Single-dimension hierarchical model

Core statistical work. Single MECE dimension (e.g.
`context(channel)` with 3-4 values).

**2a — Synthetic data generator** (`compiler/tests/`):
- Generate known-parameter synthetic engorged graphs: parent
  `p_base`, per-slice deviations from known `τ_slice`, window +
  cohort observations per slice
- Recovery tolerance: per-slice posterior HDI must contain the true
  value; parent HDI must contain the true aggregate
- Generator is the test harness for all subsequent stages

**2b — Solo-edge slice pooling** (`compiler/model.py`):
- `τ_slice` (HalfNormal), per-slice logit-offset deviations (§5.2)
- Per-slice window/cohort likelihoods
- Per-date routing: parent terms for uncontexted-regime dates,
  child terms for mece-regime dates (§5.7)
- Parameter recovery test: recover known slice deviations

**2c — Branch-group hierarchical Dirichlet** (`compiler/model.py`):
- `κ`, `base_weights`, per-slice `Dirichlet(κ * base_weights)` (§5.3)
- Per-slice Multinomials and Potentials
- Parameter recovery test: recover known per-slice weights

**2d — Per-date routing validation**:
- Mixed-epoch synthetic data: some dates aggregate-only, some
  per-slice
- Verify no double-counting: parent posterior width matches
  single-source expectations
- Satisfies doc 30 RB-003 contract (regime tag drives likelihood)

**2e — Posterior summarisation** (`compiler/inference.py`):
- Per-slice α/β/HDI/ESS/rhat in `posterior.slices` output
- Webhook payload extension

**2f — Real data validation**:
- Run on `conversion-flow-v2-recs-collapsed` test graph (channel
  dimension, 4 values, 10 edges, branch groups)
- Per-slice posteriors should be consistent with aggregate
- Compare against analytic baselines

**Gate**: parameter recovery passes for solo edges and branch groups.
Real test graph produces sensible per-slice posteriors.

### Stage 3 — Multi-dimension and advanced cases

Builds on Stage 2. Only needed when real graphs have multiple
context dimensions.

**3a — Independent dimensions** (`compiler/model.py`):
- Two separate Dirichlets sharing a parent (§5.6)
- 1/N κ correction (§14.6d) — start with it, validate in recovery
- Parameter recovery: parent posterior width with two dimensions
  matches single-dimension case

**3b — Multi-level hierarchy for subsumption** (`compiler/model.py`):
- Cross-product + marginals (§5A.3 Rule 2)
- Per-date suppression: most granular wins
- Synthetic data with mixed epochs across granularities

**3c — `conditional_p` support** (`compiler/model.py`):
- Separate simplexes per condition (§6)
- Independent of 3a/3b

**Gate**: multi-dimension parameter recovery. Mixed-epoch suppression
verified.

### Parallelism

- 1a (BE refactoring) and 1b (FE engorging) are independent
- 2a (synth generator) can start immediately
- 2b-2e depend on 1a but NOT on 1b (hand-crafted test graphs)
- 3a-3c depend on 2 but are independent of each other
- Critical path: 1a → 2a → 2b → 2c → 2d → 2e → 2f

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

**Test data gaps for §5A scenarios**: this graph has a single context
dimension. §5A's multi-dimension scenarios (independent dimensions,
subsumption/marginals, cross-product + marginals, mixed-epoch regime
transitions) require synthetic multi-dimension data for parameter
recovery tests (step 8). The real test graph covers the common
single-dimension case only.

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Variable count explosion | Slow MCMC, poor convergence | Independent dimensions scale additively (§5.6); hierarchical shrinkage handles low-data slices (§5.4) |
| MECE misclassification | Double-counting | All `context()` dimensions are MECE by construction; `case()` is MECE by definition |
| DSL canonicalisation mismatch (Python vs TS) | `posterior.slices` keys don't match FE lookup | Python port of `normalizeConstraintString()` ordering; integration test with round-trip |
| Multi-regime double-counting | Evidence inflated by rows from multiple hash families | `select_regime_rows()` (doc 30) + per-date suppression (§5A.3 Rule 2) |
| Per-date likelihood routing error | Same observations feed both parent and child terms | Per-date routing (§5.7). Mixed-epoch parameter recovery test (§11 Stage 2d) |
| No MECE partition exists for any date | Parent `p_base` unconstrained | Compiler validation: reject edge with diagnostic (§5A.3 Rule 2) |
| FE sends wrong candidate regime order | Wrong data selected | Inherent contract risk (doc 30 §7.3.11). FE tests + end-to-end tests |
| 1/N κ correction approximate | Parent overconfident with multiple independent dimensions | Start with 1/N, validate in parameter recovery (§11 Stage 3a) |

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
