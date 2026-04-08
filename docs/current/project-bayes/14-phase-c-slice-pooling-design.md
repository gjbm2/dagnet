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
  (but see §14.5 for interaction with per-date routing — residual
  feeding `p_base` on a mece-regime date conflicts with §5.7)
- Bind per-slice terms to per-slice variables

**Non-MECE dimension** (`visited()`):
- Independent per-slice likelihoods without partition constraint
- No residual computation (residual is undefined when slices overlap)
- Exclude the aggregate to avoid double-counting from overlap
- Each slice is a separate observation of `p_slice` with pooling toward
  `p_base`

### 3.4 Residual computation is intra-regime only

Residual `(n_agg - Σ n_slice, k_agg - Σ k_slice)` is meaningful only
when aggregate and per-slice observations come from the **same regime**
(same `core_hash` family, same `retrieved_at`). Doc 30 §11.5
establishes that regime selection picks one regime per `retrieved_at`
date: either MECE-partition rows (per-slice) or uncontexted rows
(aggregate), never both. The aggregate and per-slice observations
therefore never coexist for the same date.

Residual arises only within a MECE-partition regime when some context
values are below `min_n_slice` and are excluded from per-slice
modelling. Their observations fold into the residual term, which
enters the likelihood under `p_base`. This is an intra-regime
computation — no cross-regime subtraction.

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

The `bind_evidence()` function (and `bind_snapshot_evidence()`) must:

1. **Snapshot DB path only**: call `select_regime_rows()` (doc 30 §6)
   before any observation routing. This filters the input rows to one
   regime per `retrieved_at` date and returns `regime_per_date` mapping
   each date to its winning regime kind (`mece_partition` or
   `uncontexted`). Hard prerequisite for snapshot evidence — without
   it, multi-regime rows double-count (doc 30 §1.1). Param-file
   evidence skips this step (single DSL era, no hash ambiguity).
2. Parse `context_key()` from each row's `slice_key` / `sliceDSL`
3. Group entries by context dimension
4. Classify each dimension as MECE or non-MECE
5. Detect exhaustiveness per MECE dimension (intra-regime only, §3.4)
6. Compute residuals for partial MECE dimensions (intra-regime only)
7. Route aggregate entries to existing `window_obs`/`cohort_obs` —
   only for dates where `regime_per_date[date] == 'uncontexted'`
8. Route sliced entries to `slice_groups` — only for dates where
   `regime_per_date[date] == 'mece_partition'`
9. Store `regime_per_date` on `EdgeEvidence` for model emission (§5.7)

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

### 5.4 Aggregate likelihood for partial MECE dimensions

When MECE slices within a single regime partially cover the aggregate
(some context values below `min_n_slice`), the residual
`(n_residual, k_residual)` enters the likelihood under `p_base` (not a
slice variable). This residual represents un-sliced observations that
don't belong to any named slice. See §3.4 — residual is always
intra-regime.

For branch groups, the residual enters as a Multinomial under
`base_weights` (not a per-slice simplex).

### 5.5 Non-MECE dimensions

`visited()` slices get independent per-slice likelihoods without the
partition constraint. Each slice has its own `p_slice` (pooled toward
`p_base` via τ_slice). No residual computation. The aggregate is
excluded from the likelihood.

No Multinomial constraint across slices (a user can appear in multiple
visited() slices).

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

**Hard prerequisite**: `select_regime_rows()` (doc 30 §6) must be
implemented and wired into the evidence binder before step 3. Without
regime selection, multi-hash rows double-count. Doc 30 is being
implemented now — Phase C step 3 depends on it.

1. **Slice DSL parser** (Python, in `compiler/evidence.py` or new
   `compiler/slices.py`): `context_key()` extraction, dimension
   grouping, MECE classification. Pure functions, unit-testable.
   ✅ Done.

2. **IR types** (`compiler/types.py`): `SliceKey`, `SliceObservations`,
   `SliceGroup` dataclasses. `EdgeEvidence.slice_groups` field. Add
   `regime_per_date` to `EdgeEvidence`. ✅ Done (needs
   `regime_per_date` addition).

3. **Evidence binding** (`compiler/evidence.py`): call
   `select_regime_rows()` first, then route observations to aggregate
   or per-slice based on `regime_per_date` (§5.7). Both param file and
   snapshot DB paths. **Depends on doc 30 regime selection utility.**

4. **Solo-edge slice pooling** (`compiler/model.py`): `τ_slice`,
   `δ_slice`, `p_slice_base`, per-slice window/cohort split, per-slice
   likelihoods. Per-date likelihood routing (§5.7): parent terms only
   for uncontexted-regime dates, child terms only for mece-regime
   dates. Follows existing logit-offset pattern.

5. **Branch-group hierarchical Dirichlet** (`compiler/model.py`):
   `base_weights`, `κ`, per-slice `Dirichlet(κ * base_weights)`.
   Per-slice Multinomials and Potentials. Independent Dirichlet per
   dimension (§5.6).

6. **`conditional_p` support** (`compiler/model.py`): separate
   simplexes per condition, evidence routing by condition key.

7. **Posterior summarisation** (`compiler/inference.py`): per-slice
   extraction from trace, `posterior.slices` output map, webhook
   payload extension.

8. **Parameter recovery tests**: synthetic slice data per doc 8 §Phase
   C test scenarios (high-data slice, low-data slice, different true p,
   MECE partition, non-MECE dimension). Must include mixed-epoch
   scenarios (some dates uncontexted, some mece-partition) to verify
   per-date likelihood routing.

Steps 1–2 are independent of Phase D and doc 30. Step 3 requires doc
30 regime selection. Steps 4–7 require Phase D latent latency —
confirmed stable 20-Mar-26 (see §7.2).

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
| Variable count explosion (many slices × branch groups) | Slow MCMC, poor convergence | Per-slice min-n gate; independent dimensions scale additively not multiplicatively (§5.6) |
| MECE misclassification | Double-counting or data loss | Default `context()` = MECE, `visited()` = non-MECE; explicit opt-out for exceptions |
| DSL canonicalisation mismatch (Python vs TS) | `posterior.slices` keys don't match FE lookup | Python port of `normalizeConstraintString()` ordering; integration test with round-trip |
| Overdispersion amplified by more likelihood terms | Overconfident per-slice posteriors | Resolved: per-edge κ via Beta-Binomial/DM (Phase D, 20-Mar-26). Phase C extends this — each slice's likelihood uses the edge's κ. No per-slice tempering needed |
| Sparse slice data (n < 10) | Numerical issues in Multinomial | Per-slice min-n gate excludes tiny slices from model |
| ~~Phase D latent latency instability~~ | ~~Per-slice completeness must be retrofitted~~ | Resolved: Phase D stable (20-Mar-26), per-slice completeness uses latent CDFs directly |
| Multi-regime double-counting | Per-slice or aggregate evidence inflated by rows from multiple hash families | Hard prerequisite: `select_regime_rows()` (doc 30) filters to one regime per `retrieved_at`. Without it, Phase C amplifies the double-counting bug |
| Per-date likelihood routing error | Same observations feed both parent and child terms → double-counting within the model | `regime_per_date` drives routing (§5.7). Mixed-epoch parameter recovery test (step 8) must verify correct routing |
| FE sends wrong candidate regime order | Less-preferred regime selected → wrong data used | Inherent contract risk (doc 30 §7.3.11 Gap 4/7). Mitigated by FE tests (EP-001–EP-004) and end-to-end tests |

---

## 14. Open issues (as of 7-Apr-26)

### ~~14.1 Per-date likelihood routing: masking vs separate terms~~ — RESOLVED

The compiler already partitions observations by type (window vs
cohort) and emits separate likelihood terms for each. Per-date
regime routing is the same pattern: filter observation arrays by
`regime_per_date`, emit parent terms for uncontexted-regime dates
and child terms for mece-regime dates. No new mechanism needed —
standard observation partitioning.

### 14.2 ~~Multi-dimension regime selection wiring~~ — RESOLVED

~~Each independent MECE dimension has its own hash family. Does
`select_regime_rows()` need to be called once per dimension?~~

Resolved: doc 30 §5.1 specifies "the Bayes case is a loop over the
analysis case: for each exploded DSL instance, apply regime
selection." Each exploded instance has its own `core_hash`, and
instances from the same context dimension share a hash family.
`select_regime_rows()` is called per exploded DSL instance — the
dimension grouping falls out naturally from the explosion. The
evidence binder receives per-instance regime-selected rows and
groups them into `SliceGroup`s by `dimension_key()`. Each dimension's
`regime_per_date` is derived from its instances' regime selections.
No special multi-dimension wiring needed.

### ~~14.3 Param-file evidence path and regime selection~~ — RESOLVED

Param files don't need regime selection. The FE fetches over the
current query DSL before triggering a Bayes run — one coherent set
of observations per edge, no hash ambiguity, no overlapping eras.
Regime selection is a snapshot DB concern only (multiple fetch eras
coexisting under different `core_hash` values). §4.3 step 1 applies
only when binding from snapshot rows.

### 14.4 Non-MECE dimensions and regime kind

§5.5 defines `visited()` as non-MECE: independent per-slice
likelihoods, no partition constraint, aggregate excluded. But doc
30's `CandidateRegime.regime_kind` is `'mece_partition'` or
`'uncontexted'`. A `visited()` hash is neither — it is a non-MECE
partition.

The §5.7 per-date routing rule ("mece → child terms, uncontexted →
parent terms") does not cover this case. For `visited()` slices:
- The aggregate is always excluded (§5.5) regardless of regime
- Per-slice terms are emitted for dates where the visited hash has
  data
- No parent term on any date (not because of Dirichlet upward
  flow as in the MECE case, but because the aggregate double-counts
  overlapping visits)

**Likely resolution**: add `'non_mece_partition'` as a third
`regime_kind`. Routing rule: emit per-slice terms, never emit parent
term, no residual. Or: treat `visited()` as a special case in the
evidence binder that bypasses the regime routing entirely (since
there is no parent/child ambiguity — the aggregate is always
excluded).

Needs decision before step 3.

### 14.5 `min_n_slice` residual on mece-regime dates

§10.2 says slices below `min_n_slice` fold into the residual, which
enters the likelihood under `p_base`. §5.7 says mece-regime dates
have no parent likelihood term. These conflict: below-threshold
residual on a mece-regime date IS a parent term.

Options:
- **Allow the exception**: residual from below-threshold slices feeds
  `p_base` directly even on mece-regime dates. This is a small,
  controlled amount of data (by definition, the excluded slices have
  few observations) and does not cause meaningful double-counting
  because the excluded slices' data is NOT also feeding children.
- **Discard below-threshold observations**: no residual on mece
  dates. Data loss, but keeps the routing rule clean.
- **Pool below-threshold slices into a synthetic "other" child**:
  a catch-all slice child in the Dirichlet that receives the
  residual. No parent term needed — the residual flows through the
  hierarchy like any other child. Avoids both double-counting and
  data loss.

The "other child" option is likely cleanest. Needs decision before
step 4.

### 14.6 DSL shape detection and hierarchy construction (§5A)

§5A defines the taxonomy and rules but several implementation
decisions remain:

**a) Detection implementation**: §5A.6 defines the dimension-key
intersection test for classifying semicoloned parts as independent vs
subsumption vs partial overlap. This must be implemented in the
evidence binder (or a pre-processing step) to determine which
Dirichlet hierarchies to construct. Needs to happen in step 3.

**b) Flat vs multi-level for subsumption (§5A.3 Rule 2)**: the v1
recommendation is flat compound Dirichlet with coarser-than-model
data routing to parent. The multi-level alternative (intermediate
a-marginal nodes) is deferred. If parameter recovery tests (step 8)
show the parent is poorly constrained when most training dates have
only marginal data and few dates have cross-product data, revisit.

**c) Partial overlap rejection**: §5A.6 says partial overlap should
be rejected by DSL validation. Need to confirm this is enforced in
`explodeDSL` or at graph validation time, and decide the error
handling (hard error vs warning + fallback).

**d) Independent dimension overcounting**: when a pinned DSL has
`context(a);context(b)` (semicolon = independent dimensions), N
Dirichlet groups each constrain the parent with the same underlying
evidence. This overcounts the parent's effective sample size by a
factor of N.

**Proposed approach**: downweight each group's Dirichlet
concentration parameter by 1/N. If 2 independent groups each see
100 conversions, each contributes concentration × 0.5, giving the
parent ESS ≈ 100 (not 200). In PyMC: multiply the concentration
prior by `1/N` per group.

**This is approximate.** κ controls how tightly children cluster
around the parent (Dirichlet concentration), not the likelihood
contribution directly. Loosening κ reduces the parent's effective
sample size indirectly — children can deviate more, so the parent
is less constrained. But the relationship between κ and parent ESS
is not linear, and the correction is exact only when dimensions
have equal sample sizes and zero correlation. **Verify via parameter
recovery test** (step 8): generate synthetic data with known parent
rate and two independent MECE decompositions, compare parent
posterior width with vs without the 1/N correction, confirm it
matches the single-dimension case.

This assumes independence between dimensions — which is forced
when using semicolons (no cross-product data to estimate
correlation). If the DSL uses dot-product (`context(a).context(b)`),
the full cross-product is available and a single joint hierarchy
could model the correlation, but 1/N is a valid conservative
default.

### ~~14.7 Cross-instance coordination and `regime_per_date` type~~ — RESOLVED

When multiple granularities have data for the same date, **most
granular wins, coarser data is discarded for that date.** This is
the same principle as doc 30's regime selection applied one level up.
Not an architectural problem — a straightforward per-date
suppression rule folded into §5A.3 Rule 2.

The multi-level hierarchy (§5A.3 Rule 2) gives each granularity a
natural home. The evidence binder collects per-instance results,
then for each date keeps only the most granular set.

**One real validation corner case**: if no complete MECE partition
exists over `window()` or `cohort()` for any date in the training
window, the parent `p_base` has no anchor — no direct observations
and no children to inform it through the Dirichlet. This is almost
certainly a pinned DSL misconfiguration (e.g., context slices
specified but no values registered, or all slices below
`min_n_slice`). The compiler should **fail with a diagnostic** rather
than emit an unconstrained parent. Check: after evidence binding, if
`p_base` has zero likelihood terms (no aggregate obs, no children
with obs on any date), reject the edge with a clear error naming the
missing data.

### 14.8 `doc 30b` references in §14.12

§14.12 references "Use Case B in doc 30b §6" and "Use Case C/D in
doc 30b §7–8". If doc 30b exists, it should be added to the Related
header. If it is a draft or does not yet exist, the references
should be marked as forward-looking. Verify before implementation.

### 14.9 §14.12 (FE commissioning) is a design spec, not an open issue

§14.12 is ~100 lines of implementation-ready design: the two data
classes, the 4-step commissioning flow, the schema implication. It
reads as a settled design, not an open question. Consider promoting
to a main-body section (e.g. §5B or §9A) since steps 3–4 of Phase C
implementation depend on it. The one genuinely open part — the
`model_vars` schema change (two options at the end) — could remain
as an open issue.

### 14.10 Doc 30 RB-003 as Phase C contract test

Doc 30 §7.3.11 Gap 5 explicitly flags RB-003 (regime tag drives
likelihood structure) as a Phase C test prerequisite. When Phase C
is built, a corresponding test must verify the evidence binder
consumes `regime_per_date` and emits the correct likelihood
structure. §11 step 8 should cross-reference RB-003.

### 14.11 `context()` DSL fix and the absent-aggregate path

Doc 30 §10 resolves the `context()` syntax for "also fetch
uncontexted aggregate". If this ships before Phase C, the common
case becomes "aggregate observations usually present" (both
uncontexted and contexted data fetched). §5.7's absent-aggregate
path ("parent informed solely through hierarchy") becomes a fallback
for legacy data, not the primary path.

If it does NOT ship before Phase C, the absent-aggregate path is
the primary path for all contexted edges. This affects testing
priority — the absent-aggregate scenario needs thorough coverage
either way, but especially if it is the default.

Not blocking — either path works architecturally. But affects
testing emphasis in step 8.

### 14.12 FE per-slice commissioning contract

Phase C requires the FE to produce a complete, per-slice "one-time
picture" for the Bayes worker. This section specifies what that
picture contains, why, and how the FE produces it.

**Two classes of data the Bayes worker consumes:**

1. **Snapshot DB rows** — the worker queries these itself via
   `snapshot_subjects` and the DB connection. The snapshot DB is
   context-aware natively: rows carry `slice_key` and the worker
   filters by it. **No FE per-slice prep needed for this source.**

2. **The "one-time picture"** — the graph snapshot and parameter
   files as they exist at trigger time. This picture is
   DSL-dependent because the FE topo pass (analytics) runs on
   data filtered by the active query DSL. **This source must be
   prepared per slice by the FE.**

The graph topology (nodes, edges, connections) is invariant across
slices — one graph is sent. What varies per slice is the analytic
model_vars on the edges and the posterior/prior entries on the
param files.

**Why per-slice analytics are required:**

1. **LOO-ELPD denominator** (doc 32 §3.3): ΔELPD compares the
   Bayesian posterior against the analytic baseline. Each context
   slice gets its own Bayesian posterior (§5.2–5.3). The denominator
   must be the analytic model_vars for **that slice** — not the
   aggregate. The analytic model_vars are DSL-dependent (the topo
   pass runs on DSL-filtered data), so using the aggregate baseline
   for a context-specific ΔELPD is a category error.

2. **Prior resolution**: when no previous Bayesian posterior exists
   for a slice (cold start), the Bayes compiler falls back to
   analytic priors. These must be slice-specific — the p for
   `context(channel:google)` differs from the aggregate p. The
   param files already support per-slice posterior storage (doc 21
   `posterior.slices`), but the analytic fallback values come from
   the graph's model_vars.

3. **Warm-start quality gating**: the quality gate for warm-start
   uses the previous posterior's rhat/ESS. For Phase C, this is
   per-slice. The analytic fallback when the gate fails must also
   be per-slice.

**Why the worker cannot produce analytics itself:**

The BE topo pass (`enhance_graph_latencies` in `stats_engine.py`)
requires pre-filtered inputs: `param_lookup` (cohort data filtered
by DSL dimensions), `edge_contexts` (onset from window slices,
forecast cohorts), and `query_mode`. These are constructed in
`fetchDataService.ts` and `beTopoPassService.ts` from the active
DSL and param file values. The worker has no DSL context and no
param file filtering logic — it receives the finished picture.
There is one code path for analytics (the topo pass), and the FE
drives it.

**FE commissioning flow:**

1. **Explode the pinned DSL** into per-slice DSLs. This already
   happens during fetch planning. The explosion produces:
   - The bare (uncontexted) parent: `window()` or `cohort()` —
     **always produced**, regardless of whether the pinned DSL
     includes context clauses. This is mandatory: the Dirichlet
     hierarchy (§5.2–5.3) needs the parent as its anchor. Without
     a parent analytic baseline, LOO scoring has no denominator
     for the aggregate model, and cold-start prior fallback has
     no aggregate p to fall back to.
   - Each context slice: `window().context(channel:google)`,
     `window().context(channel:organic)`, etc.

2. **Run the topo pass per slice.** For each exploded slice DSL,
   FE filters param file values by that slice's dimensions (same
   filtering `fetchDataService.ts` already does during Stage 2)
   and calls `enhance_graph_latencies` on the filtered data. This
   produces per-slice analytic model_vars: p, p_sd, onset, mu,
   sigma, t95, completeness, blended_mean. The FE already does
   this once on the aggregate as part of every fetch cycle — the
   change is doing it N+1 times (parent + N children).

3. **Put per-slice analytic model_vars on the graph edges.** The
   model_vars array on each edge grows from one `analytic` entry
   per edge to one per (edge, context_key). See schema
   implications below.

4. **Build the Bayes trigger payload** as today: graph_snapshot
   (now with per-slice model_vars), parameter_files (with per-slice
   `posterior.slices` for warm-start — doc 21), snapshot_subjects
   (with per-slice hashes — doc 30). All three are slice-coherent
   because the FE produced them from the same exploded DSL.

**What the Bayes worker does with this:**

The worker receives one graph with per-slice analytic model_vars,
param files with per-slice posteriors, and per-slice snapshot
subjects. It queries the DB per slice hash (Use Case B in doc 30b
§6 — no regime selection needed for per-slice reads). The
aggregate/parent uses regime selection (Use Case C/D in doc 30b
§7–8) across candidate hashes. The evidence binder builds per-slice
observations (§4.3). The LOO scorer (`loo.py`) reads per-slice
analytic baselines from the graph and computes per-slice ΔELPD.

The worker does not run the topo pass. It does not filter param
data. It does not know the DSL. It consumes the finished per-slice
picture the FE prepared.

**Cost:**

Running the topo pass N+1 times instead of once.
`enhance_graph_latencies` is fast (< 1s per call), so even with
10 context slices the overhead is under 10s — negligible compared
to MCMC time (30–120s).

**Schema implication:**

The `model_vars` array on graph edges currently holds entries keyed
only by `source` (`analytic`, `analytic_be`, `bayesian`, `manual`).
For Phase C, `analytic` entries must also be keyed by context_key
(or slice DSL). Design options:
- Add a `context_key` field to `ModelVarsEntry` (empty string for
  aggregate) — minimal schema change, backward compatible.
- Nest per-slice entries under a `slices` map within the `analytic`
  entry — mirrors the `posterior.slices` pattern from doc 21.

To be resolved during Phase C implementation.

---

## 15. What this document does NOT cover

- FE consumption of `posterior.slices` (see doc 9 Phase C overlay)
- FE per-slice visualisation components
- Regime selection utility implementation and wiring (see doc 30 —
  hard prerequisite, being implemented now)
- FE candidate regime construction (see doc 30 §4.1)
- DSL parsing gap for `context()` as uncontexted (see doc 30 §10)
- Data pipeline changes to produce context-sliced observations
  (existing — the pipeline already fetches per-context data when
  `dataInterestsDSL` includes `context()` dimensions)
- Temporal drift interaction details (see doc 11 §10)
- Full downstream `conditional_p` propagation (future, data-dependent)
