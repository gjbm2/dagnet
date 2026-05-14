# Promotion fixes & param-file persistence cleanup

**Status**: proposal (Section 5 changes not yet landed)
**Date**: 13-May-26

## 1. Frame

The graph carries two layers of state for every edge:

1. **The source ledger** — `edge.p.model_vars[]`, one entry per source
   (`analytic`, `bayesian`). Each entry holds what its source produced:
   probability block (`mean`, `stdev`, Beta `alpha`/`beta`, cohort_*, …)
   and latency block (`mu`, `sigma`, `t95`, `path_*`, dispersions, …).
2. **The promoted surfaces** — `edge.p.posterior.*`, `edge.p.latency.*`
   (the L5 scalars `mu`, `sigma`, `promoted_t95`, `promoted_*_sd`, …),
   `edge.p.latency.posterior.*`, `edge.p.forecast.*`. These are derived
   by `applyPromotion`, which picks the active source from the model-
   source preference and projects that source's ledger entry onto the
   promoted surfaces.

Everything downstream (charts, info cards, DSL `e.X.p.latency.*`
accessors, planners, CF inputs, integrity checks) reads from the
promoted surfaces. The source ledger is read by `applyPromotion` only.

The promotion contract has been muddled over time by:

- writers of `model_vars[]` that did not pair with `applyPromotion`,
- non-writers (CF) that were going through a path that wiped
  `model_vars[analytic]` as a side effect,
- a partial atomic-replacement pattern in promotion that left stale
  fields on the promoted surfaces when the active source did not supply
  every field,
- param-file persistence whitelists that store promoted derivatives as
  if they were inputs.

This document is the plan that puts each of those right.

## 2. The promotion contract

The rules below are stated as a unified contract so the codebase can be
audited against a single source of truth.

**R1 — `model_vars[]` is the only source of probability and latency
fits.** Probability blocks and latency blocks live on
`model_vars[<source>].probability` and `model_vars[<source>].latency`.
The promoted surfaces are derivations; they hold no information that
isn't recoverable from the source ledger.

**R2 — There are exactly four legitimate writers of `model_vars[]`.**
File→graph sync, when the param file carries a fresh analytic
probability (sidecar mechanism in `addEvidenceAndForecastScalars`),
writes `model_vars[analytic].probability`. The same sync, when the
param file carries `posterior.slices`, projects the active DSL slice
onto `model_vars[bayesian]` via `posteriorSliceContexting`. FE topo,
running through `applyBatchLAGValues` with `scope:'fe_topo'`, writes
`model_vars[analytic].latency` (and probability mean, via
`buildAnalyticProbabilityBlock` upstream). The bayes-patch upload path
(`bayesPatchService`) writes `model_vars[bayesian]` directly. Nothing
else may touch `model_vars[]`.

**R3 — Every `model_vars[]` writer must call `applyPromotion`
immediately after.** No exceptions. The pairing is what guarantees the
promoted surfaces stay consistent with the source ledger.

**R4 — `applyPromotion` is atomic and complete.** It resolves the
active source, then writes *every* promoted field from that source —
including writing `undefined` where the source does not supply a
value. Stale residue from a previous active source is not permitted.
There is no "skip this field if absent" branch; absent in the source
means absent on the promoted surface.

**R5 — Conditioned Forecast does not write `model_vars[]`.** CF
produces scenario-conditioned *current-answer scalars* (`p.mean` via
`blendedMean`, `p.latency.completeness` and its stdev, evidence stats).
Those live alongside the promoted surfaces but are not derived from
`model_vars[]`. CF must therefore route its updates through a code
path that bypasses the model_vars-writing branches in
`applyBatchLAGValues`.

**R6 — Promotion is a graph concept.** It runs on graph state. The
graph file (graph IDB) legitimately stores the promoted surfaces as
the editor's current state — they're not a second copy of anything,
they *are* the graph. By contrast, param files are the input boundary
and must not carry promoted derivatives (Section 5).

## 3. Recent fixes — landed

### 3.1 CF→`model_vars` wipe defect

Before the fix, `applyConditionedForecastToGraph` called
`UpdateManager.applyBatchLAGValues` on its scenario edge-values payload.
That path also contains the FE-topo analytic-ledger writer (R2), and
because CF's payload omits the analytic latency fields (μ, σ, onset,
dispersions), the atomic-replacement branch wiped every one of those
thirteen fields on `model_vars[analytic].latency` to `undefined`. The
next FE topo pass re-derived the analytic ledger and the symptom became
transient at steady state, which kept the defect hidden during
diagnosis.

The fix added a `scope?: 'fe_topo' | 'cf'` option to
`applyBatchLAGValues`. The two `model_vars[analytic]` write branches
inside that function are gated on `scope === 'fe_topo'`.
`conditionedForecastService` passes `scope:'cf'` when it calls in. CF
still writes the current-answer scalars it owns (`p.mean`,
`p.latency.completeness`, `p.latency.completeness_stdev`, evidence
stats) — those write paths are not gated.

A deterministic vitest (`cfDoesNotWriteModelVars.test.ts`) pins the
contract: directly invoke `applyConditionedForecastToGraph` on a graph
with a populated analytic ledger and assert every `model_vars[*]`
field is unchanged. Without the fix the test fails on thirteen
analytic-latency fields; with the fix it passes.

### 3.2 `applyPromotion` atomic-and-complete refactor

Before the refactor, `applyPromotion` paired a `clearPromotedSurfaces`
helper with a conditional projection: it cleared the promoted fields,
then wrote each one only if the active source supplied it. The clear
step left stale residue on `p.latency` when promotion changed source
(e.g. bayes → analytic where the analytic entry was missing a
dispersion) and on `p.forecast.{mean, stdev}` when the active source's
probability mean was absent. The "entry exists but has no latency
block" case left every L5 latency field untouched.

The refactor retired `clearPromotedSurfaces` entirely. The atomic
projection now writes every promoted field unconditionally from the
resolved active-source entry, defaulting to `undefined` where the
source doesn't supply. This is R4 made literal in code: there is one
write per field, and that write is the only thing that produces or
clears the field. `applyPromotion` now also initialises `p.latency` on
demand when the resolved source supplies a latency posterior but
`p.latency` did not exist on the input.

### 3.3 Test coverage pinning the contracts

Two test additions:

- `cfDoesNotWriteModelVars.test.ts` (vitest) — direct invocation of
  `applyConditionedForecastToGraph`, asserts both analytic and
  bayesian entries are byte-for-byte unchanged, and asserts CF's own
  current-answer scalars still land correctly.
- `bayesVarsToCanvasInfo.spec.ts` (Playwright) — end-to-end: seed a
  graph with analytic + bayesian model_vars and a param file with
  `posterior.slices`, stub the CF endpoint, pin a canvas-analysis
  edge-info card to the graph, assert every promoted variable on the
  card maps back to the bayesian source for the active DSL slice. The
  test runs in ~10 seconds and covers the full bayes upsert →
  contexting → promotion → canvas wiring chain.

`modelVarsResolution.test.ts` was updated where one assertion had been
pinning the leaky pre-refactor behaviour ("skip projection when
`p.latency` is absent"). The replacement asserts the correct
atomic-projection behaviour: when the source supplies a latency block,
`p.latency` is created on demand and every L5 scalar is projected.

The full vitest suite (5,262 tests) passes after the refactor.

## 4. Where the contract is still missing — proposed

### 4.1 `workspaceService` legacy-bayes migration

`_migrateBayesianPosteriorToSourceLedgerInPlace` in
`workspaceService.ts` rebuilds `model_vars[bayesian]` for legacy graphs
that carry the data on `p.posterior` only. It writes the bayesian
entry's probability and latency sub-blocks from the legacy projection
fields. It does *not* call `applyPromotion` at the end. This violates
R3.

The violation is benign at run time today because the migration leaves
the legacy `p.posterior` intact, so display reads from the legacy
surface until the next promotion event refreshes the new shape. The
migration also sets `isDirty: true` so the new shape gets saved. But
nothing about that pattern is guaranteed by the contract; the next
person who touches the migration could remove either crutch and the
graph would land in a half-promoted state on cold load with no
subsequent fetch.

**Proposed fix.** Pair the migration with an `applyPromotion` sweep
over every migrated edge before the function returns. Same one-line
pattern every other `model_vars[]` writer already uses. The legacy
`p.posterior` field can then be deleted at the end of the migration
because promotion will have populated `p.posterior` from the new
ledger.

### 4.2 No load-time sweep is required

This was on an earlier draft and is removed deliberately. Promotion is
a graph concept (R6). The graph file persists the promoted surfaces
because they are the graph's state. Loading the graph back from IDB
restores that state verbatim. The trigger pattern in R3 guarantees the
graph is consistent at save time; load is not a write and does not
require re-derivation.

The only thing missing on the load path is the R4.1 pairing in the
migration, which is in-graph re-derivation, not a separate sweep.

## 5. Param-file persistence cleanup — proposed

### 5.1 Principle

Param files are the input boundary. They round-trip through tooling
outside the editor, can be edited externally, can disagree with what
the editor would derive from `model_vars[]`. They must therefore
contain only inputs (and fit artifacts the editor cannot reproduce
on its own). Promoted derivatives in param files create a dual source
of truth against `model_vars[]` and the trigger pattern, with no
mechanism to keep the two in sync.

This principle does not extend to the graph file. The graph is the
editor's own state, with a single canonical owner. Storing promoted
surfaces in the graph file is just persisting state, not creating a
second source.

### 5.2 The three whitelists in `GraphParamExtractor`

`LATENCY_FIELD_WHITELIST` controls which fields under `edge.p.latency`
are extracted into the param file's `latency` block.

- **Keep.** `median_lag_days` is a true input to `fitLagDistribution`.
  `t95`, `path_t95`, and `onset_delta_days` are stored unconditionally
  per the policy that storage is unconditional and the override flags
  govern *apply* only — when the corresponding `*_overridden` flag is
  true the file value is the user-supplied constraint; when false the
  file value is a transient cache that gets ignored on the next topo
  run.
- **Drop.** `mu` and `sigma` are derived by `fitLagDistribution` from
  median and mean. `path_mu`, `path_sigma`, and `path_onset_delta_days`
  are FE-topo Fenton–Wilkinson outputs. All `promoted_*` scalars are
  `applyPromotion` projections by definition. `completeness` and
  `completeness_stdev` are query-date-dependent and always recomputed
  by the topo pass — the code already says so explicitly.

`PROBABILITY_POSTERIOR_FIELD_WHITELIST` controls which fields under
`edge.p.posterior` are extracted. Every field — `alpha`, `beta`,
`cohort_*`, `*_pred`, `n_effective` variants, `provenance` variants —
is an `applyPromotion` projection of `model_vars[bayesian].probability`.
The whitelist as a whole should be dropped.

`LATENCY_POSTERIOR_FIELD_WHITELIST` controls fields under
`edge.p.latency.posterior`. Same story: every field is an
`applyPromotion` projection of `model_vars[bayesian].latency` (with
the name convention shift `mu → mu_mean`). Drop the whole whitelist.

### 5.3 The bayes fit artifact stays

The canonical bayesian data on a param file is `parameter.posterior.slices[]`
— the per-DSL-slice posterior packets produced by the bayes fitter.
That is a true fit artifact: the editor cannot reproduce it without
re-running the bayes pipeline. It stays on the param file as the
canonical input from which `model_vars[bayesian]` is reconstructed on
every file→graph sync.

### 5.4 The graph→file writer for latency

`persistGraphMasteredLatencyToParameterFiles` in `fetchDataService.ts`
is the function that closes the graph→param-file loop for latency
horizons. Today it copies the promoted `t95`, `path_t95`, and
`onset_delta_days` values onto the latency block before
`putParameterToFile` extracts and writes. It also has a separate
"`mu`/`sigma` always persist for bootstrap continuity" branch that
forces a write whenever either is present on the graph.

The first behaviour stays: the t95 family is unconditionally stored
per Section 5.2. The "bootstrap continuity" branch retires — μ and σ
are derivatives, not inputs, and the user explicitly does not want
derivatives in files.

### 5.5 Behavioural change — the only one

After the cleanup there is one user-visible change. Cold-open a param
file whose daily evidence has never been fetched, into a fresh graph
that has never carried this edge before. Previously the file's
persisted μ, σ, path_mu, path_sigma seeded the graph display via
`analyticLatencyFromFile`. After the cleanup the graph shows the
inputs (`median_lag_days`, `t95`) but no fit until a fetch or topo
run produces one. This is the honest outcome of the principle: a fit
that cannot be reproduced from inputs is not a fit the system should
display.

A soft-landing option is available if needed. `fileToGraphSync` could,
when `analyticLatencyFromFile` is absent but `median_lag_days` and
`mean_lag_days` are both present on the file, run an in-browser
`fitLagDistribution` and seed `model_vars[analytic].latency.{mu,
sigma}` from the aggregates. This adds nothing to file storage; the
seed is derived on read. Path quantities still wait for the topo pass.

### 5.6 Downstream sync effects

The shape change to `analyticLatencyFromFile` (now carrying only the
kept fields) is absorbed by `fileToGraphSync` without restructuring.
The bayes file→graph projection (`posteriorSliceContexting`) is
unaffected — it reads from `posterior.slices`, not the dropped
whitelists. The FE-topo writeback merge in `fetchDataService` is
unaffected. Cleanup is local: three whitelists in `GraphParamExtractor`,
one writer branch in `persistGraphMasteredLatencyToParameterFiles`, and
the surrounding doc comments.

## 6. Order of work

The Section 3 fixes are landed. The remaining work is independent and
can ship in any order; a sensible sequence is:

First, the Section 4.1 migration pairing — single-line change, retires
the only known unpaired writer of `model_vars[]`, makes R3 a complete
invariant. Adding a unit test that loads a legacy-shape fixture and
asserts the promoted surfaces are populated immediately after migration
gives the invariant teeth.

Second, the Section 5 whitelist trim — the three whitelists in
`GraphParamExtractor`, the writer-branch retirement, and updated
comments. The behaviour change in Section 5.5 should be confirmed
(and the soft-landing option decided on) before the trim lands.

No structural changes are required outside those files.
