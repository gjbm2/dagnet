# 73b — BE Topo Removal and Forecast State Separation Plan

**Date**: 24-Apr-26  
**Status**: Active implementation plan  
**Audience**: engineers working on the Stage 2 fetch pipeline, model vars, FE topo, conditioned forecast, CLI parity, and graph-state consumers  
**Supersedes**: doc 72 as the active execution plan for graph-surface forecast state  
**Relates to**: `../codebase/STATS_SUBSYSTEMS.md`, `../codebase/FE_BE_STATS_PARALLELISM.md`, `../codebase/PARAMETER_SYSTEM.md`, `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `60-forecast-adaptation-programme.md`, `72-fe-cli-conditioned-forecast-parity-fix-plan.md`, `../cohort-cf-defect-and-cli-fe-parity.md`

## 1. Objective and scope

This plan defines one integrated workstream delivered as two named work
packages.

Work package A is a verification and residue-cleanup step covering the BE
topo removal that has already largely landed. Work package B enforces a
strict three-layer graph contract: model vars, promoted model vars, and
current query-scoped graph params.

These work packages are linked. Verifying BE-topo absence without fixing
field ownership leaves semantic ambiguity intact. Fixing field ownership
without confirming BE-topo cleanup risks reintroducing the duplicate
analytic surface that BE topo previously fed.

The quick BE topo pass historically existed to populate `analytic_be`,
re-run promotion, support FE-versus-BE parity tooling, and preserve an older
transition plan where BE analytic would replace FE analytic. The intended
system no longer uses that transition plan. FE quick pass is the fast
fallback writer. BE conditioned forecast is the careful authoritative writer.
The substantive BE-topo removal is already done in code; Work package A
verifies that and removes residue (fixtures, docs, CLI noise).

The deeper defect is field-role ambiguity. The same flat scalar can currently
mean model forecast, query-scoped evidence blend, or conditioned answer,
depending on write order. This plan removes that ambiguity and retires the
redundant BE analytic branch against a single target contract.

A parallel ambiguity exists at the source layer. Today, `manual` appears as a
source-ledger entry that is also auto-coupled to a selector pin and to
per-field locks on outputs. The target model treats user authoring strictly as
an output-layer concern. Sources are generator-owned only. Users author via
selector overrides on the promoted layer and via per-field scalar locks on the
current-answer layer. Users never write source params. This removes `manual`
from the source ledger entirely.

### 1.1 Terminology used in this plan

- "FE quick pass" is the canonical term and is equivalent to earlier wording
  "FE topo pass" and "FE quick path".
- "FE fallback model" means the model-bearing FE source entry (`analytic`), not
  the query-owned provisional answer.
- "Standard fetch pipeline" means the live Stage 2 enrichment pipeline used in
  normal operation. This replaces mixed terms "standard fetch path", "live
  fetch path", and "standard Stage 2 enrichment path".
- "Carrier behaviour" means runtime reach/carrier propagation outcomes,
  including tier selection, reach multiplication, and latency propagation for a
  fixed graph/query input.
- "Scenario-owned enriched graph state" means the per-scenario graph after
  baseline plus scenario composition and enrichment projection, including
  query-owned fields, rather than a stripped param-only representation.

## 2. Binding decisions (non-negotiable)

Decision 1. FE quick pass stays as a quick, rough, resilient immediate writer
from local graph state plus fetched evidence. This plan does not replace FE
quick pass with a slower solve.

Decision 2. BE conditioned-forecast pass stays as the careful, authoritative
writer of current query-scoped answer fields.

Decision 3. After delivery, only two query-time statistical writers remain in
the standard fetch pipeline: FE quick pass and BE conditioned-forecast pass.
There is no replacement quick BE analytic pass.

Decision 4. Sources are generator-owned. Live source families are exactly two:
`bayesian` (offline-fitted, file-backed, per query context) and `analytic`
(runtime-computed by FE topo from current evidence and window-family inputs).
Sources are not user-editable. There is no `manual` source.

Decision 5. Promotion selects one source per edge per param family by the
existing quality-gated rule (`bayesian` wins if its quality gate passes;
otherwise `analytic`), respecting per-edge user pins. Promotion materialises
the selected source's params into flat promoted fields (`p.forecast.*` for
probability, existing promoted latency fields for latency). Promotion is the
only writer of promoted fields. Promotion never writes current-answer fields.

Decision 6. User authoring lives at the output layer, not the source layer.
The user has exactly two affordances: (a) selector pin via
`model_source_preference` plus `model_source_preference_overridden`, choosing
which source promotes for an edge; (b) per-field output locks via `*_overridden`
companion flags on current-answer scalars, freezing those scalars from
automated rewrite. Neither affordance writes to the source ledger.

Decision 7. `p.mean` and `p.forecast.mean` are distinct semantic slots and stop
collapsing onto one value. `p.mean` is current query-scoped answer (FE-quick
and CF write). `p.forecast.mean` is promoted baseline model forecast
(promotion writes). Probability gains a `p.forecast.*` promoted surface
symmetric to latency's existing promoted fields. This commits to `p.forecast.*`
as the steady-state name with no migration hedges.

The promoted probability surface must be wide enough for downstream consumers
(CF, runtime carriers, conjugate-update logic) to do their job without
reaching back into `model_vars[]` or the source ledger. Mean and standard
deviation alone are insufficient — Python today also reads predictive
alpha/beta and effective sample size that encode slice-specific upstream-
fit state. The frozen field list (binding) is `p.forecast.{mean, stdev,
alpha, beta, alpha_pred, beta_pred, n_effective, source}` — see §3.2 for
the full rationale, writer identification, and Python file:line citations.
Open point 8's resolution may add fields to this list (it cannot remove
any of the eight) if the analytic semantic transition requires further
state on the promoted surface.

Decision 8. Baseline forecast estimate from
`graph-editor/src/services/windowAggregationService.ts` is model-bearing input.
It belongs in the `analytic` source entry and is then projected by promotion
onto the promoted model surface. It does not belong in CF-owned current-answer
fields.

Decision 9. Changing only current query-owned fields must not alter runtime
carrier behaviour, promoted source selection, or baseline model inputs used by
later solves. Output locks (`*_overridden`) are write-side gates only;
consumers read the underlying field as normal.

Decision 10. Selector and output locks have different scopes. The selector is
edge-global — it travels with the edge across scenarios and is not exposed in
the param pack. Output-locked values are per-scenario — they travel in the
param pack as plain scalar values; lock flags themselves do not.

Decision 11. Param packs carry only post-projection scalar state. They do not
carry `*_overridden` lock flags, the source ledger, or the selector. The
no-lock-flags rule is this plan's own assertion (doc 73a specifies what packs
*do* carry without making a claim about lock metadata); the rule follows
from Decision 6's separation of authored-on-the-live-edge lock state from
pack-paste scalar state. The canonical pack field list (including
`p.posterior.*`, `conditional_p`, `p.n`, and the promoted/current-answer
scalars) lives in [doc 73a §8](./73a-scenario-param-pack-and-cf-supersession-plan.md)
and is treated as authoritative on field membership; this plan must not
contradict that field list.

Decision 12. The system must degrade gracefully when bayesian source files are
unavailable. The selector default falls through to `analytic`; FE topo supplies
`analytic`; the app renders and forecasts with analytic-only state. Bayes runs
and other file-dependent operations fail explicitly when their files are
absent, but standard rendering and FE-quick / CF passes continue.

Decision 13. The `analytic` source must transition from "already query-scoped
posterior" to generator-owned aggregate-style model source. Today the Python
runtime treats `analytic.alpha_beta_query_scoped == True` (see
`graph-editor/lib/runner/model_resolver.py:95-108`) and conjugate-update
consumers branch on this flag to avoid double-counting evidence. The target
contract requires `analytic` to be safe to combine with query-scoped Σk, Σn
on the consumer side, the same as `bayesian`. This change is load-bearing for
Work package B and is sequenced ahead of the promoted-probability work; the
exact resolution (split aggregate-vs-posterior fields inside the analytic
entry, change what FE topo writes, or rewrite the conjugate-update branch) is
captured as an open point in section 7.

Decision 14. Doc 73a is a binding prerequisite for Stage 3 onwards. Doc 73a
owns: pack field membership (§8), `applyComposedParamsToGraph` mechanics,
per-scenario CF supersession (§7), the CF response → graph apply mapping
(§10), `awaitBackgroundPromises` orchestration (§10), the request-graph
engorgement *pattern* (§3.9 — note: the per-scenario `model_vars[]` use
of this pattern moved to this plan's bundled switchover; doc 73a retains
only the existing CF request-snapshot use), and CLI/FE prepared-graph
alignment (§12; binding for this plan only after the bundled switchover
delivers per-scenario `model_vars[]`). Stages 0–2 of this plan (test
pinning, Work-A verify, analytic-transition shadow) may proceed in
parallel with doc 73a work; Stage 3 (`manual` removal) and beyond must
not start until doc 73a's **§15A pre-handoff acceptance gates** pass.
Doc 73a's §15B final-cleanup gates depend on this plan's Stage 5 consumer
migration completing, so they cannot be the trigger for this plan's Stage 3
— that would be circular. Once the source ledger and live-edge state start
changing, pack composition is on the critical path. Where this plan and doc 73a disagree, doc 73a wins on its
listed concerns; this plan wins on source/promoted/current-answer layering,
selector mechanics, removal of `manual`, and lock discipline on the live
edge. Concrete cross-doc conflicts to reconcile before Stage 0 are listed
in section 11.2.

### 2.1 Three-layer contract at a glance

Source layer (model-var ledger): generator-owned source state (`p.model_vars[]`
entries) written only by generators — offline bayesian fits and FE-fallback
analytic computation. Users never write this layer.

Promoted model layer: selected baseline model projection (including
`p.forecast.*` and promoted latency fields) written by promotion logic. User
authoring at this layer is limited to the selector pin (which source promotes),
not to the projected values themselves.

Current query-scoped layer: active-query answer fields (including `p.mean`,
`p.stdev`, `p.evidence.*`, and completeness fields) written by FE quick pass
provisionally and CF authoritatively. User authoring at this layer is the
per-field overtype with `*_overridden` lock companion flag.

## 3. Target end state (contract to implement)

### 3.1 Model-var ledger

After implementation, the source ledger contains generator-owned entries only.
There are exactly two source families.

`bayesian` is the aggregate fitted source from the offline pipeline. It is
file-backed and keyed by query context. **Per-scenario request graphs**
carry only the slice for that scenario's effective DSL (engorged at
request-build time by Stage 4(a) — see §8). The **live editor edge** does
not re-engorge on live-DSL change today and continues to carry the slice
loaded at file→graph time; live-edge re-engorgement is not in scope for
this plan and is left to a follow-up if user-visible per-context display
on the live canvas becomes a requirement. Refresh on query-context change
on per-scenario request graphs is a promotion-triggering event for that
graph; some staleness between context change and next regen on the live
canvas is acceptable.

`analytic` is the FE fallback source. It is runtime-computed by FE topo from
the current evidence slice and `window()` family inputs for probability, and
existing all-history lag-fit inputs for latency. It is not persisted to files;
it is regenerated from graph state. Active query-scoped answer state must not
live in `analytic`.

`manual` is no longer a source. User authoring lives at the promoted layer
(selector pin, see 3.5) and at the current-answer layer (per-field locks, see
3.3 and 3.5), never in the source ledger.

No fourth source family is introduced. With both `analytic_be` and `manual`
removed from the ledger, `bayesian` and `analytic` are the only entries.

### 3.2 Promoted model surface

Promotion projects the selected source's params into stable flat graph fields
meaning "selected baseline model".

Latency already follows this pattern through existing promoted latency fields.

Probability gains the symmetric pattern. `p.forecast.*` is the steady-state
home for promoted probability. The frozen field list is wider than just
`mean` plus `stdev` because the slot it replaces (`_posteriorSlices`)
carries Beta-posterior shape directly; consumers that today read alpha
and beta from that slot for conjugate updates and carrier dispersion math
must have a like-for-like replacement on the promoted surface.

Frozen promoted-probability field list (binding for Stage 4 writer and
Stage 5 consumer migration):

- `p.forecast.mean` — point forecast.
- `p.forecast.stdev` — epistemic uncertainty (single scalar).
- `p.forecast.alpha` — Beta-posterior alpha. Required so consumers can
  weight evidence properly and perform conjugate updates without reading
  the source ledger.
- `p.forecast.beta` — Beta-posterior beta. Same rationale as alpha.
- `p.forecast.alpha_pred` — predictive alpha. Today's Python runtime
  reads this via `resolved.alpha_pred` at
  [forecast_state.py:550](graph-editor/lib/runner/forecast_state.py)
  and
  [forecast_state.py:1374](graph-editor/lib/runner/forecast_state.py)
  for predictive dispersion math. The value is computed in
  [model_resolver.py:442-455](graph-editor/lib/runner/model_resolver.py)
  from cohort/window-specific posterior_block fields
  (`cohort_alpha_pred`, `window_alpha_pred`) and is **not derivable from
  posterior alpha + observed evidence** at runtime — the cohort/window
  slice context is lost. Promotion must project the slice-resolved
  predictive alpha onto the promoted surface.
- `p.forecast.beta_pred` — predictive beta. Same rationale and same
  slice dependency as alpha_pred.
- `p.forecast.n_effective` — predictive effective sample size. Read at
  [forecast_state.py:1000-1010](graph-editor/lib/runner/forecast_state.py).
  Computed in
  [model_resolver.py:421-441](graph-editor/lib/runner/model_resolver.py)
  from `cohort_n_effective` / `window_n_effective` with fallback to
  `ev_n`. Same slice dependency.
- `p.forecast.source` — source provenance ('bayesian' | 'analytic'), used
  by consumers that branch on the analytic semantic transition (Decision 13)
  while open point 8 is being implemented and as long-term provenance
  thereafter.

Choice of explicit `alpha`/`beta` plus separate `alpha_pred`/`beta_pred`/
`n_effective` (rather than effective sample size `pred_n` derived from
posterior) is deliberate: today's `_posteriorSlices` carries the full
set, and the predictive parameters encode slice-specific upstream-fit
state that is impossible to reconstruct at runtime from posterior alpha
+ evidence alone. Migration is a slot-for-slot read swap. Adopting any
derivation rule would force every consumer to recompute at the read
site, multiplying the migration surface and the test surface, and would
require slice context to be re-threaded through every read path — which
is the very coupling promotion is meant to break.

Source-specific distribution detail may remain inside source-ledger entries
where useful for fitting/diagnostic purposes, but everything a runtime
consumer needs must be on the promoted surface.

Promotion is the only writer of promoted fields. The writer is
`applyPromotion` in
[modelVarsResolution.ts](graph-editor/src/services/modelVarsResolution.ts) —
today it writes only the latency promoted block (lines 160–186) with an
explicit comment at lines 156–158 deferring `p.forecast.*` to "the topo
pass / pipeline". Stage 4 extends `applyPromotion` to write all eight
promoted-probability fields listed above (`mean`, `stdev`, `alpha`,
`beta`, `alpha_pred`, `beta_pred`, `n_effective`, `source`); the
deferral comment is removed. Promotion must not write current-answer
fields. Promotion is also
responsible for the per-edge selector default (quality-gated rule),
respecting any user pin.

### 3.3 Current query-scoped surface

Current query-owned surface contains scoped evidence and answer for the active
query in the current scenario.

Minimum surface includes `p.evidence.*`, `p.mean`, `p.stdev`,
`p.latency.completeness`, and `p.latency.completeness_stdev`.

FE quick pass writes provisional values immediately. CF overwrites the fields
it owns as the careful authoritative solve. Neither writer touches the source
ledger or promoted fields.

Each user-overtypable scalar carries a per-field `*_overridden` companion flag
(for example `mean` and `mean_overridden`). Setting the flag to `true` freezes
that scalar from automated rewrite by the writers enumerated in Action B8c
(FE quick, CF, runtime cascades, and batch helpers such as
`applyBatchLAGValues`). The value sits in its normal field; the flag only
gates automated writers. Promotion does not write current-answer fields and
therefore has no `*_overridden` check at this layer; scenario composition
pastes pack state and does not "write through" a lock. Clearing the flag is
sticky — the previously-locked value remains visible until the next legitimate
automated write replaces it.

These fields are scenario-owned. They must not be read as model inputs by
later solves.

### 3.4 Consumer read rules

Consumers needing baseline model forecast read the promoted model surface.

Consumers needing current query answer read the current query-scoped surface.

Consumers must not infer model state from whichever field was populated first.

`*_overridden` flags are write-side gates only. Reading a current-answer field
is unaffected by its lock state.

### 3.5 User authoring affordances

User authoring has exactly two affordances, both above the source layer.

(a) Selector pin. In the edge properties panel the user can pin which source
promotes for an edge by writing `model_source_preference` ∈ {`bayesian`,
`analytic`} and setting `model_source_preference_overridden = true`. The pin
is edge-global — it persists across scenarios and is not exposed in the param
pack. Clearing the pin returns the edge to the quality-gated default.

(b) Output overtype. In the edge properties panel for the current scenario,
or by editing a scenario's param pack directly, the user writes a value into a
current-answer scalar. On the *live edge*, the corresponding `*_overridden`
flag flips to true; lock state is a property of the live edge only. Param
packs themselves do not carry `*_overridden` flags — pack values are
unconditional pasted scalars. The two authoring paths produce equivalent
visible state but the lock-flag plumbing differs: props-panel edits flip the
live-edge flag directly; pack edits write a scalar that becomes the live
value when that scenario is composited, with the lock-flag behaviour at that
point governed by the rules in section 3.6 and doc 73a.

Neither affordance writes to the source ledger. There is no UI surface that
authors source params.

### 3.6 Param pack contents

The canonical, authoritative param-pack contract is defined in
[73a-scenario-param-pack-and-cf-supersession-plan.md](./73a-scenario-param-pack-and-cf-supersession-plan.md).
This plan must not contradict it; where this section is more cursory than
doc 73a, doc 73a wins.

Summary for the purposes of this plan:

- A pack carries per-edge post-projection scalar state. It is the snapshot
  the compositor pastes onto the graph for a frozen scenario.
- A pack includes promoted-layer scalars (`p.forecast.*` and promoted
  latency fields) and current-answer scalars (`p.mean`, `p.stdev`,
  `p.evidence.*`, completeness fields, and the additional fields enumerated
  in doc 73a such as `p.posterior.*`, `conditional_p`, `p.n`).
- A pack does **not** carry `*_overridden` lock flags. This is doc 73b's
  own rule (doc 73a §8 lists pack contents without addressing lock
  metadata); it follows from Decision 6's separation of live-edge lock
  state from pack-paste scalar state. Locked values land in the pack as
  plain scalars.
- A pack does **not** carry the source ledger (`bayesian` / `analytic`
  source params).
- A pack does **not** carry the selector
  (`model_source_preference`, `model_source_preference_overridden`).

Replaying a pack is a paste of frozen scenario state. Sources, selectors,
and the quality gate are not re-evaluated as part of replay.

### 3.7 Graceful degrade with no param files

The system must render and forecast usefully when bayesian source files are
absent.

Behaviour: bayesian entries are missing from the per-edge `model_vars[]`
ledger; the quality-gated selector default falls through to `analytic`;
FE topo computes `analytic` from current graph state; promotion projects
`analytic` onto promoted fields; FE quick pass and CF run as normal.

Bayes-dependent operations (e.g. running the Bayes compiler) fail explicitly
when files they require are absent. They are not in scope for this fallback;
only the standard rendering pipeline must continue to work.

## 4. Current mismatches to close

Mismatch 1. (Largely closed by prior work.) BE-topo orchestration has already
been removed from `graph-editor/src/services/fetchDataService.ts`; the
standard fetch pipeline now runs FE quick pass plus CF only. Residual
fixtures and doc references to the BE-topo era are addressed by Work
package A. No live mismatch remains here.

Mismatch 2. `analytic` currently behaves as already-query-scoped (see
`graph-editor/lib/runner/model_resolver.py:95-108`,
`alpha_beta_query_scoped == True`) rather than as a clean generator-owned
model source. Conjugate-update consumers branch on that flag to avoid
double-counting. The target contract requires `analytic` to be safe to
combine with query-scoped Σk, Σn the same as `bayesian`. Separately,
`manual` currently appears as a source-ledger citizen that is auto-coupled
to a selector pin and to per-field output locks; the target model removes
`manual` from the source layer entirely.

Mismatch 3. `graph-editor/src/services/modelVarsResolution.ts:156-158`
documents that the TS promoter only promotes latency parameters and
explicitly avoids writing `p.forecast.mean`. Probability state is split
across source entries, `p.forecast.mean`, `p.mean`, and ad hoc pipeline
writes. The target requires positive promotion of probability scalars
onto `p.forecast.*`.

Mismatch 4. The defect is on the consumer side, not on FE quick. FE quick
writing a provisional blended `p.mean` is correct under the target contract
(it is the provisional current-answer writer per Decision 1). The actual
mismatch is twofold: (i) downstream model consumers in TS and Python read
`p.mean` as a model-bearing input, conflating current-answer with promoted
forecast; (ii) FE quick's model-bearing forecast estimate is not separately
exposed as a promoted-layer field — there is no `p.forecast.*` for
consumers to read instead. Closing this requires both promoting probability
to its own surface (section 6.2) and switching consumers to read from it
(consumer-migration stage). The FE quick write itself is preserved.

Mismatch 5. `graph-editor/src/services/conditionedForecastService.ts:227-239`
writes `forecast.mean = edge.p_mean` per edge in the batch update,
collapsing promoted baseline forecast and conditioned answer into one slot
and destabilising `f` versus `f+e`. CF must stop writing this field; under
the target contract promotion is the only writer of `p.forecast.*`.

Mismatch 5a. `applyBatchLAGValues` has an asymmetric lock check today
(`graph-editor/src/services/UpdateManager.ts`). The primary blendedMean
write path (around line 2254-2257) writes `p.mean` from `blendedMean`
without checking `mean_overridden`, so a user-locked `p.mean` can still
be overwritten on that path. The evidence-mean fallback path (around
line 2264) does check `targetP.mean_overridden !== true` before writing.
The two paths must be brought into a consistent lock discipline; Action
B8c gates both paths on `*_overridden` so the function as a whole
respects the lock regardless of which branch fires.

Mismatch 6. FE, CLI, and analysis preparation still lack one clean
scenario-owned enriched-graph contract. Doc 72 exposed this as parity defect;
under this plan it is a query-owned state-isolation defect per scenario.

Mismatch 7. Output overtype in
`graph-editor/src/components/PropertiesPanel.tsx::updateEdgeParam` currently
auto-creates a `manual` entry in `model_vars[]`, sets
`model_source_preference = 'manual'`, and writes the per-field `*_overridden`
flag — three couplings in one user action. The target model decouples these:
output overtype writes only the value plus its `*_overridden` flag, never the
source ledger and never the selector. Selector pinning and output locking
become orthogonal user affordances.

## 5. Work package A — verify BE topo absence and clean residue

The substantive BE-topo removal has already landed. As of the current
codebase: `graph-editor/src/services/beTopoPassService.ts`,
`graph-editor/src/services/forecastingParityService.ts`, and
`graph-editor/lib/runner/stats_engine.py` no longer exist;
`graph-editor/src/services/fetchDataService.ts` runs only FE quick pass plus
CF; the `/api/lag/topo-pass` endpoint and `analyse --topo-pass` are gone or
are deprecated no-ops; `analytic_be` no longer appears in live code paths and
survives only in test fixtures.

Work package A is therefore reduced to verification and residue cleanup. It
runs ahead of Work package B as a hygiene step, not as an implementation
stage.

Action A1 (verify). Confirm absence of removed surfaces by file presence and
grep:
- Files: `beTopoPassService.ts`, `forecastingParityService.ts`,
  `lib/runner/stats_engine.py` — none should exist.
- Grep `analytic_be` in `graph-editor/src` and `graph-editor/lib` — only
  matches expected are inside `graph-editor/lib/tests/fixtures/`.
- Grep `topo-pass`, `topoPass`, `beTopoPass`, `handle_stats_topo_pass` in
  `graph-editor/src`, `graph-editor/lib`, `graph-editor/dev-server.py`,
  `graph-editor/lib/api_handlers.py` — no live matches.

Out of scope for Action A1: `bayes/` (the offline Bayes fitting and
LOO-validation pipeline). `bayes/compiler/loo.py` references `analytic_be`
intentionally as a source-name fallback when extracting analytic baselines
from historical graph snapshots that may pre-date the source-taxonomy
change. This is a standalone offline tool that consumes graph snapshots
written by older runtimes; its source-name handling is a compatibility
concern owned by the Bayes-pipeline workstream, not by Work package A.
Any future migration of `bayes/compiler/loo.py` to a new source taxonomy
is tracked separately and is not blocking for doc 73b.

Action A2 (residue cleanup — fixtures). Either delete BE-topo-era test
fixtures that still reference `analytic_be`, or rewrite them as FE-only
contract fixtures. Pick per-fixture; no fixture should be retained because
"it might still parse".

Action A3 (residue cleanup — docs and CLI). Remove final diagnostic and
documentation residue that still implies a quick BE topo stage. The legacy
`--topo-pass` no-op may be deleted once nothing references it. Update CLI
help, graph-ops playbooks, and any user-facing doc still mentioning BE topo.

Action A4 (test rewrite). Any FE-vs-BE-topo parity tests that still exist
should be rewritten to FE-only contract tests, not deleted casually. The aim
is to preserve coverage of FE quick-pass behaviour while removing the BE-side
parity assertion.

Completion gate for Work package A:
- All Action A1 verifications pass.
- No fixtures, docs, or CLI references mention `analytic_be`, BE topo, the
  topo-pass endpoint, or the parity service except as historical context.
- Work package B can begin against a known-clean baseline.

## 6. Work package B — separate model vars, promoted model vars, and current query-scoped graph params

Work package B restores intended semantic boundary across model, promoted, and
query-owned layers.

### 6.0 Parked issue carried from Phase 1

Known issue (parked; no intermediate fix): after Work package A removed
`analytic_be`, explicit horizon recompute can re-promote stale analytic latency
because preserved canonical latency and fresh FE-fitted latency share one lane,
`model_vars[source='analytic']`.

This is intentionally deferred to Work package B. Fix approach is completing
model-vs-promoted-vs-query separation, not adding temporary branches and not
reintroducing quick BE analytic path.

### 6.1 Redefine `analytic` as FE fallback model source

FE quick system still produces fallback model, but output must become clean
model source rather than query-owned posterior in disguise.

`analytic` target meaning is FE fallback model built from full relevant
`window()` family for probability and existing lag-fit inputs for latency.
Current query scoped evidence remains in `p.evidence.*`. Current query
provisional answer remains in current-answer fields.

Baseline forecast estimate from
`graph-editor/src/services/windowAggregationService.ts` lands in FE fallback
model (`analytic`) and then promotion, not in CF-owned or current-answer fields.

The promoted probability surface is the eight-field set fixed in §3.2:
`p.forecast.{mean, stdev, alpha, beta, alpha_pred, beta_pred,
n_effective, source}`. Mean plus stdev alone is insufficient because
back-end consumers explicitly need the Beta-shape parameters and the
predictive variants for conjugate updates and dispersion math.
Source-specific distribution details may remain inside model-var source
entries, but promotion must project the eight-field set onto the
promoted surface.

### 6.2 Give probability a promoted model surface

Promotion must become symmetric so probability has a clear promoted home, as
latency already does.

`graph-editor/src/services/modelVarsResolution.ts` owns projection of the
winning probability source onto the eight-field `p.forecast.*` surface
defined in §3.2. This makes the forecast-versus-current-answer distinction
explicit and matches latency's existing promoted-fields pattern.

This is a multi-surface migration, not just an edit to
`modelVarsResolution.ts`. Current state:

- `graph-editor/src/services/modelVarsResolution.ts:156-158` explicitly
  documents that the TS promoter only promotes latency parameters and avoids
  writing `p.forecast.mean`. This avoidance must be replaced with positive
  promotion of all eight `p.forecast.*` fields.
- `graph-editor/src/services/conditionedForecastService.ts:227-239` writes
  `forecast.mean = p_mean` per edge. This collapses `f` (promoted baseline)
  and `f+e` (current-answer) into one slot and must stop.
- BE consumers in `graph-editor/lib/runner/` that read forecast fields must
  be reviewed to ensure they read promoted `p.forecast.*` for model-bearing
  operations and current-answer scalars for query-result rendering.

Stage sequencing for the migration follows the bundled switchover laid out
in §8:

1. **Stage 4 — bundled switchover.** Per-scenario `model_vars[]` delivery,
   the promotion writer extension, and the first BE consumer migration land
   together so the commit produces an observable behavioural diff. Promotion
   writes the full eight-field `p.forecast.*` surface (per §3.2) from the
   selected source. CF stops writing `forecast.mean = p_mean`. One back-end
   reader (the bayesian probability-source path in `model_resolver.py`)
   switches to the new surface in this same stage.
2. **Stage 5 — remaining consumer migrations.** Every other consumer that
   currently reads `p.mean` as model proxy or reads `posterior.*` /
   `_posteriorSlices` is switched to the promoted surface, one consumer per
   commit so the sequence is bisectable.

This bundled sequencing replaces the earlier write-only Stage 4 / unified
Stage 5 split, which left Stages 4 and (the early part of) 5 producing no
observable diff and made bisection harder.

### 6.3 Keep FE quick pass as immediate query-owned projector

FE quick pass may keep computing and writing approximate `p.mean` and
completeness immediately.

Required change is input ownership: FE quick pass must consume promoted
baseline model state as forecast input and scoped evidence as evidence input.
It must not rewrite model ledger or promoted forecast slot with query-owned
answer.

Primary surfaces:
`graph-editor/src/services/statisticalEnhancementService.ts`,
`graph-editor/src/services/fetchDataService.ts`,
`graph-editor/src/services/UpdateManager.ts`.

FE quick path may still refresh FE fallback model source, but that remains
model-layer update. Immediate blended answer remains current-answer-layer
write.

### 6.4 Keep CF as careful authoritative current-answer writer

CF remains authoritative writer of current query-scoped answer.

`graph-editor/src/services/conditionedForecastService.ts` should continue
projecting CF-owned fields such as `p.mean`, `p.stdev`, and CF-owned completeness
fields, while stopping overwrite of promoted baseline forecast slot.

Current "already query-scoped posterior" degraded rule remains valid migration
guard. End state removes query-scoped sources from promoted model layer rather
than relying on permanent ambiguity. Any future genuinely query-scoped source
must be explicit and non-default.

### 6.5 Make runtime and graph consumers obey layer split

BE runtime and graph consumers must read model inputs from model/promoted
surfaces, not from current-answer fields.

Primary surfaces:
`graph-editor/lib/runner/model_resolver.py`,
`graph-editor/lib/runner/forecast_state.py`,
`graph-editor/lib/runner/forecast_runtime.py`,
`graph-editor/lib/runner/graph_builder.py`,
`graph-editor/lib/runner/runners.py`,
plus any reach/carrier path still treating `p.mean` as model proxy.

Negative requirement is strict: changing only current query-owned scalar must
not alter carrier behaviour, promoted source selection, or baseline model used
by later solves.

### 6.6 Make current query-owned state scenario-owned

FE graph surface, analysis preparation, and CLI must preserve one enriched
graph per scenario so current query-owned fields cannot leak across scenarios
or be reconstructed from stripped param-only view.

This carries forward valid core of doc 72. Parity defect remains real, but is
implemented here as part of three-layer separation, not as standalone parity
patch.

Primary surfaces:
`graph-editor/src/services/analysisComputePreparationService.ts`,
`graph-editor/src/services/GraphParamExtractor.ts`,
`graph-editor/src/cli/commands/analyse.ts`,
scenario-facing FE orchestration around conditioned forecast.

### 6.7 Remove `manual` from source taxonomy

`manual` is dropped from the source-ledger taxonomy entirely. User authoring
moves to the output layer (selector pin and per-field locks). The override
mechanism itself survives unchanged — overtype already writes the value plus
flips the `*_overridden` flag at the commit handler. What gets removed is
only the *side effect* of overtype that auto-creates a `model_vars[manual]`
entry and pins the selector to `manual`.

The edge-props UI does not collapse — it adapts. Today's Output card has
exactly two editable fields (mean, stdev) and the rest as read-only display
([ModelVarsCards.tsx:411-451](graph-editor/src/components/ModelVarsCards.tsx#L411-L451));
the latency override fields (`t95`, `path_t95`) are authored on the Analytic
card via `LatencyZapOff` per doc 19
([ModelVarsCards.tsx:225-235](graph-editor/src/components/ModelVarsCards.tsx#L225-L235)),
and structural inputs (connection, distribution, latency_parameter,
anchor_node_id) are authored elsewhere on the panel. Each of those fields
already has its own `*_overridden` companion flag and continues to work
unchanged. The card flow under the new model is:

1. **Input fields** — structural inputs (connection, distribution,
   parameter-file id, latency_parameter, anchor_node_id).
2. **Bayes** — read-only display of the bayesian `model_vars` entry +
   selector pin toggle.
3. **Analytic** — read-only display of the analytic `model_vars` entry +
   selector pin toggle. Continues to host the `t95`/`path_t95` override
   fields per doc 19 (input constraints to the analytic latency fit).
4. **Promoted vars** — repurposed from today's "Output" card. Shows what
   promotion wrote to `p.forecast.*` and the promoted latency block, with a
   source-provenance badge ("source: bayesian/analytic"). Only `mean` and
   `stdev` remain editable; everything else is `RoField`. Editing flips the
   corresponding `*_overridden` flag and the value sticks regardless of
   what promotion subsequently writes.

Concrete code actions:

Action B7a. Remove the `manual` source variant from TypeScript and Python
source enums and unions. Primary surfaces:
[`graph-editor/src/types/index.ts`](graph-editor/src/types/index.ts) (the
`ModelSource` and `ModelSourcePreference` unions at lines 618 and 623),
[`graph-editor/lib/runner/model_resolver.py`](graph-editor/lib/runner/model_resolver.py),
plus any `ModelSource` literal unions and source-preference enums.

Action B7b. Remove `'manual'` from the `model_source_preference` selector
domain. After this change the domain is `'best_available' | 'bayesian' |
'analytic'`.

Action B7c. Delete the auto-create-`model_vars[manual]` block in
[PropertiesPanel.tsx:1343-1367](graph-editor/src/components/PropertiesPanel.tsx#L1343-L1367)
and the parallel duplicate in
[UpdateManager.ts:458-483](graph-editor/src/services/UpdateManager.ts#L458-L483).
The override flag flip already happens upstream of these blocks (the field
write + `*_overridden = true` are set by the commit handler), so the value
and lock both survive their removal. The two other `source: 'manual'` writes
in
[UpdateManager.ts:917](graph-editor/src/services/UpdateManager.ts#L917) and
[UpdateManager.ts:1078](graph-editor/src/services/UpdateManager.ts#L1078)
follow the same pattern and are deleted alongside.

Action B7d. Remove the implicit selector pin to `'manual'` triggered by
output overtype (the `p.model_source_preference = 'manual'` assignment at
[PropertiesPanel.tsx:1365-1366](graph-editor/src/components/PropertiesPanel.tsx#L1365-L1366)
and
[UpdateManager.ts:480-481](graph-editor/src/services/UpdateManager.ts#L480-L481)).
Selector pinning becomes a deliberate, separate user action via the
Bayes/Analytic card pin toggles only.

Action B7e. Repurpose the "Output" card in
[`graph-editor/src/components/ModelVarsCards.tsx`](graph-editor/src/components/ModelVarsCards.tsx)
as the "Promoted vars" card per the flow above. The card is retained and
keeps `mean` and `stdev` as its editable fields with their existing
`AutomatableField` override wrappers; only the framing and badge change.
Remove the auto-flip-source-to-manual on first keystroke
(`handleOutputStartEdit` at lines 154-164) — it's no longer needed because
overtype no longer changes the source pin. Remove the
"click-active-card-off → pin to manual" branch at lines 125-127 of the
`handleToggle` callback; replace with "click-active-card-off → unpin
(return to quality-gated default)". Remove the `findEntry(modelVars,
'manual')` lookup at line 105 and any `'manual'` references in the card
header rendering at lines 246-256.

Action B7f. Cutover for in-the-wild graphs is per Open Point 1 (RESOLVED):
graceful degrade in the loader. A `model_vars[].source === 'manual'` entry
is silently treated as not-present; a `model_source_preference === 'manual'`
edge is treated as unpinned. Each occurrence is logged via
`sessionLogService` at info level with the edge id and which artefact was
ignored. No special-case loader code path beyond the type narrowing; the
log entry is the entire user-visible surface. Packs do not carry source
ledger or selector state and are not in scope.

Action B7g. Update consumers that read `'manual'` source params or check
for `'manual'` selector pin: the badge counts at
[PropertiesPanel.tsx:1990-2034](graph-editor/src/components/PropertiesPanel.tsx#L1990-L2034)
drop the `manual` count (or relabel as "X Locked" — count of edges with
any `*_overridden = true`); `effectivePreference` and
`resolveActiveModelVars` in
[`modelVarsResolution.ts`](graph-editor/src/services/modelVarsResolution.ts)
add the graceful-degrade clause from B7f. Tests asserting "overtype
creates a manual `model_vars` entry" become tests asserting "overtype sets
`mean_overridden = true` without touching `model_vars`".

### 6.8 Codify per-field output locks as the canonical author mechanism

The per-field `*_overridden` companion-flag pattern remains the canonical
mechanism for user output authoring. This subsection codifies and confirms
that pattern rather than introducing a new one.

Action B8a. Confirm that every overtypable current-answer scalar carries a
`*_overridden` companion flag. Scope includes probability `mean`/`stdev`,
latency outputs (`t95`, `onset_delta_days`, completeness fields), and any
other user-overtypable scalar identified during implementation.

Action B8b. The `AutomatableField` wrapper component remains the canonical UI
for these locks. Lock-clear UX writes `*_overridden: false` only and leaves
the previous value visible (sticky on unlock). Next legitimate automated
write may overwrite that value.

Action B8c. Define the lock-respecting writer set narrowly. The writers that
must check the relevant `*_overridden` flag before touching a current-answer
scalar are exactly the automated graph writers of current-answer fields:
FE quick pass, CF, runtime cascades, and any batch-write helper that
projects derived scalars onto the live edge (notably
`graph-editor/src/services/.../applyBatchLAGValues`, which currently
overwrites `p.mean` from `blendedMean` without checking `mean_overridden`
and must be brought into the discipline). Locked ⇒ skip.

Two writer roles are explicitly outside this discipline:

- Promotion. Promotion only writes promoted-layer fields and never writes
  current-answer scalars; it has nothing to check against current-answer
  locks. (It still skips promoted-layer writes only when the user has
  pinned the selector — the selector pin is the relevant gate at that
  layer, not `*_overridden`.)
- Scenario composition. Composition pastes pack state onto the graph; it
  is not an automated derivation. Pasted values become the live edge state
  for that scenario, including any pre-existing lock flag on the live edge.
  Composition does not "write through" a lock.

Action B8d. Selector pin and output lock are independent. Pinning a selector
must not implicitly lock outputs. Locking an output must not implicitly pin
the selector.

Completion gate for Work package B:
- `analytic` is model-bearing FE fallback source, not query-owned answer state.
- `p.forecast.*` is promoted baseline model surface and remains distinct from
  current query-owned answer fields.
- FE quick pass consumes promoted model state plus scoped evidence and writes
  query-owned fields without rewriting promoted baseline slots.
- CF remains authoritative current-answer writer and does not overwrite
  promoted baseline forecast slots.
- Runtime carrier/reach consumers read model/promoted surfaces rather than
  current query-owned fields.
- FE and CLI both prepare analysis from scenario-owned enriched graph state per
  scenario.
- `manual` no longer appears as a `model_vars[]` source entry, in the
  `model_source_preference` selector domain, or in any UI surface that exposes
  source taxonomy.
- Output overtype writes only the value plus its `*_overridden` flag; it does
  not write the source ledger and does not pin the selector.
- Selector pin and output lock are independent user affordances.
- Param packs match the doc 73a contract: post-projection scalar state only,
  no `*_overridden` flags, no source ledger, no selector.
- Standard rendering and FE-quick / CF passes continue to function when no
  bayesian source files are present.

## 7. Open points to settle before implementation

These items are explicitly unresolved and must be settled before the
corresponding stage lands. They are listed here so a reader can scan what is
still in flight versus what is binding.

Open point 1 — RESOLVED via cutover with graceful degrade. No migration
is owned by this plan. Stage 3 removes `manual` from the source taxonomy:
TypeScript types drop the variant, Python schemas drop the variant. The
loader gracefully degrades when it encounters an in-the-wild graph that
still carries `manual`: a `model_vars[].source === 'manual'` entry is
treated as not-present, and a `model_source_preference === 'manual'`
edge is treated as unpinned. The graph then behaves as if the manual
entry had never existed.

Each occurrence is logged via `sessionLogService` (per the codebase's
session-logging pattern) so the cutover is observable: an info-level
entry per affected edge, tagged so it's filterable, naming the edge id
and which manual artefact was ignored (entry vs. selector pin). No
user-facing error, no toast, no special UI path. Conversion of
in-the-wild graphs is out of scope for this plan and is handled
separately.

Open point 2 — RESOLVED. The promoted surface includes `p.forecast.source`
(and the equivalent latency provenance) by Decision 7 and section 3.2.
Provenance is required, not optional, because consumers branch on it during
the analytic semantic transition and use it for human readability
thereafter.

Open point 3 — Selector pin behaviour when the pinned source becomes
unavailable. If a user has pinned `bayesian` for an edge and the bayesian
source then becomes unavailable for the current query context, the candidate
behaviour is silent fallback to `analytic` for that edge with the pin
retained, plus a UI indicator that the pin is currently inactive. The
alternative (auto-clear the pin) is simpler but loses authoring intent.
Must be settled before Stage 4 (when promotion starts writing the promoted
surface and selector behaviour becomes user-visible).

Open point 4 — Quality-gate volatility. If a fit's `gate_passed` flag flips
between promotion runs (for example because the underlying fit is updated),
the selector default may flip with it. Whether such flips should be silent,
surfaced as a UI notice, or temporarily damped is open. Default is silent;
revisit only if instability becomes user-visible.

Open point 5 — Refresh discipline for the per-edge `model_vars[]` ledger on
query-context change. Section 3.1 commits to "current-context entry only"
without committing to immediate refresh. The trigger set for refresh
(promotion-run, explicit recompute, scenario switch, query-DSL edit) and the
acceptable staleness window need spelling out. Must be settled before Stage 4.

Open point 6 — Two-path manual edit interaction. Section 3.5 commits to two
authoring entry points (edge props for the current scenario; pack edit for a
specific scenario). Specifically open: (i) when a pack-pasted scalar lands on
the live edge during composition, what governs whether the live edge's
`*_overridden` flag is set, cleared, or left as-was; (ii) when both
authoring paths have been used on the same edge across different scenarios,
the precedence and reconciliation rules. These are doc 73b's questions to
answer because lock semantics are doc 73b's territory; doc 73a (which owns
the compositor) must respect doc 73b's chosen rule. Doc 73a §8 currently
specifies compositor replay mechanics for the active-projection blocks but
does not address `*_overridden` interaction — that gap is filled here.
Candidate rule: composition pastes scalar values unconditionally; the live
edge's `*_overridden` flag is preserved as-was (composition does not toggle
it). **Sequencing:** must be settled before doc 73a Stage 2 (the
extractor/compositor stage) lands, because doc 73a Stage 2 implements the
compositor that has to obey the chosen rule. The rule must be communicated
to doc 73a in time for its Stage 2 design, not deferred to this plan's
Stage 5.

Open point 7 — Coverage list for `*_overridden` flags. Action B8a says "every
overtypable current-answer scalar". The exact list (probability `mean`,
`stdev`; latency `t95`, `onset_delta_days`, completeness fields; anything
else) needs enumerating before Stage 5 (consumer migration) and pinned into
tests.

Open point 8 — RESOLVED. The original framing (three structural options
to "fix" analytic-as-query-scoped) was malformed. CF uses the analytic
source for conditioning identically to how it uses the bayesian source —
both are projected onto `p.forecast.alpha`/`p.forecast.beta` by promotion
and used as priors. The double-counting risk that arises from analytic
being an aggregate posterior over the slice's data is real and
acknowledged; it is handled by the **subset blend adjustment** in CF,
not by branching on source to skip conditioning. The
`alpha_beta_query_scoped` flag at
[model_resolver.py:107-108](graph-editor/lib/runner/model_resolver.py#L107-L108)
is the regime selector for that adjustment; consumers at
[cohort_forecast_v3.py:132](graph-editor/lib/runner/cohort_forecast_v3.py#L132),
[forecast_runtime.py:472](graph-editor/lib/runner/forecast_runtime.py#L472),
and
[forecast_state.py:1001](graph-editor/lib/runner/forecast_state.py#L1001)
read it to pick the correct subset-blend regime, NOT to skip analytic
in conditioning.

No structural change to FE topo, the analytic source, or promotion is
required. Stage 2's substantive work is documentation cleanup:
- Rewrite the
  [model_resolver.py:100-108](graph-editor/lib/runner/model_resolver.py#L100-L108)
  comment block so a reader does not infer "analytic is unsafe to
  condition on" from the current "Read directly; updating again
  double-counts" wording.
- Rename `alpha_beta_query_scoped` to a name that conveys "which
  subset-blend regime applies to this resolved source" (e.g.
  `evidence_already_aggregated`) — the rename is mechanical and
  affects the named consumer files plus the property definition. No
  semantic change.
- Update §3.1 of this plan to describe analytic as "aggregate posterior
  over the slice's data" rather than "query-scoped", with an explicit
  note that CF conditions on it via the subset blend adjustment.

Stage 2's "shadow-land the analytic semantic transition" reduces to
landing the documentation cleanup and the rename behind a green-test
gate; no behavioural change ships in Stage 3 from this resolution.

**WP8 interaction (doc 60 open item — tracked here)**. Doc 60 WP8 is the
live narrow direct-`cohort()`-for-`p` rate-conditioning path. Its dispatch
discriminator is `ResolvedModelParams.alpha_beta_query_scoped` (see
`graph-editor/lib/runner/model_resolver.py:95-108` and
`../codebase/STATS_SUBSYSTEMS.md` §3.3 "Runtime-bundle conditioning seam").
Option (b) above would make the flag always `False` for analytic-promoted
edges, routing every such CF call into the aggregate-prior conjugate-update
branch and double-counting query-scoped evidence — the exact failure mode
`52-subset-conditioning-double-count-correction.md` was written to fix.
The chosen resolution must therefore include an explicit decision about
WP8's discriminator: either pick option (a) (split inside the analytic
entry), keeping `alpha_beta_query_scoped` semantics intact for WP8's
branch; or pick option (b) and re-wire WP8 against a different
discriminator that captures "this analytic source has not been conditioned
on query-scoped evidence yet". WP8 is tracked as an open item carried
into this plan from doc 60: it is live but its behaviour is constrained
by Stage 2's resolution and may need explicit re-ratification before
Stage 3 lands.

Open point 9 — RESOLVED. CF writes `p_sd → p.stdev` on the current-answer
surface (option b). This was settled in doc 73a §3.10 (settled persistences)
and §10 (CF response → graph apply mapping table) under "decision B-narrow",
and is reflected in doc 73a's pack contract (§8) which lists `p.stdev` as a
contract field with CF as the writer. Promoted carries
`p.forecast.stdev` separately; the two surfaces are distinct (`p.stdev` is
the current-answer asymptotic dispersion scalar from CF, `p.forecast.stdev`
is the promoted baseline epistemic uncertainty from promotion).

## 8. Delivery stages and execution order

This workstream lands in seven stages. Stages are sequential and each stage
closes a concrete boundary before the next stage starts.

Stage-to-work-package mapping is explicit: Stage 0 is foundation work for
both packages, Stage 1 completes Work package A (verification and residue
cleanup), and Stages 2–6 deliver Work package B. Doc 73a acceptance is a
hard prerequisite for Stage 3 onwards (Decision 14).

Stage 0. Freeze target contract and failing tests. Before behaviour changes,
tests must pin baseline-forecast versus current-answer distinction, pin
`analytic_be` absence in live code, pin removal of `manual` from source
taxonomy, pin the canonical pack contract from doc 73a, and pin the consumer
rule that current-answer fields are not model inputs. The promoted
probability field list (§3.2 — `p.forecast.{mean, stdev, alpha, beta,
alpha_pred, beta_pred, n_effective, source}`) and its single writer
(`applyPromotion` in
[modelVarsResolution.ts](graph-editor/src/services/modelVarsResolution.ts))
are also frozen here; Stage 4 implements the writer extension and Stage 5
consumer migration cannot begin without this list pinned.

Stage 1. Complete Work package A. Verify absence of removed BE-topo
surfaces, clean residue (fixtures, docs, CLI noise), and rewrite any FE-only
contract tests that still describe the BE-topo era. Result is a known-clean
baseline for Work package B.

Stage 2. Resolve open point 8 and shadow-land the analytic semantic
transition (Decision 13). This is a decision stage followed by a shadow
implementation; it does not yet change source-ledger taxonomy or live
consumer reads. By Stage 2 end the chosen resolution (split fields, change
FE topo writes, or rewrite consumers) is documented in this plan and
demonstrated to work in shadow form against tests, with old behaviour still
live. This stage may run in parallel with doc 73a work but is a hard
prerequisite for Stage 3.

Stage 3. Remove `manual` from source taxonomy and decouple output overtype
from source-ledger and selector writes (Actions B7a–B7g, B8c, B8d).
Execute the migration policy resolved under open point 1. Commit the
analytic transition shadowed in Stage 2. After Stage 3, `manual` no longer
exists as a source; analytic is safe as a generator-owned aggregate; output
overtype writes only the value plus its `*_overridden` flag. Doc 73a
acceptance gates must pass before Stage 3 begins.

Stage 4. **Bundled switchover.** Three pieces land in one stage so
each commit produces an observable behavioural diff. Earlier drafts
(of this plan, and of doc 73a) split these into "deliver" (formerly
doc 73a Stage 5a), "write" (a write-only Stage 4), and a later
consumer migration. In isolation each was inert until the next
landed; bundling them removes the dead window.

The three pieces:

(a) **Per-scenario `model_vars[]` delivery.** At analysis-prep time
and at CF request-build time the FE derives each scenario's bayesian
`model_vars[]` entry per edge from the parameter file's slice that
matches that scenario's effective DSL. Same derivation function used
by `analysisComputePreparationService.ts`,
`buildConditionedForecastGraphSnapshot`, and the CLI's `analyse.ts`.
The exact-context match is the only allowed match — no cross-context
fallback at the bayesian-source layer (`resolvePosteriorSlice`'s
context-stripping fallback at
[posteriorSliceResolution.ts:167-171](graph-editor/src/services/posteriorSliceResolution.ts#L167-L171)
is removed at source or guarded against at the seam). When no
exact-context slice exists, the bayesian entry is omitted, leaving
only the analytic entry for promotion to project. Output contract
for the derived bayesian entry: probability widened to carry `mean`,
`stdev`, `alpha`, `beta`, `alpha_pred`, `beta_pred`, `n_effective`;
latency block in current shape; quality block; a `derivation`
provenance block with `slice_key`, `effective_dsl`, optional
`fit_fingerprint`, and `derived_at`.

(b) **Promoted writer extension.** `applyPromotion` in
[modelVarsResolution.ts](graph-editor/src/services/modelVarsResolution.ts)
extended to populate the full eight-field `p.forecast.*` surface
defined in §3.2 (`mean`, `stdev`, `alpha`, `beta`, `alpha_pred`,
`beta_pred`, `n_effective`, `source`) from the promoted source's
ledger entry. The deferral comment at lines 156–158 is removed. CF
stops writing `forecast.mean = p_mean` per
[conditionedForecastService.ts:227-239](graph-editor/src/services/conditionedForecastService.ts#L227-L239).
Promotion becomes the only writer of the promoted surface.

(c) **First BE consumer migration.** One back-end consumer is
switched off the legacy `posterior.*` / `_posteriorSlices` read path
and onto the canonical `p.forecast.*` surface in this same stage.
The recommended target is the probability-source resolution branch
in `graph-editor/lib/runner/model_resolver.py::resolve_model_params`
— specifically the path that today reads bayesian alpha/beta from
`posterior.*`. Switching this one reader is the smallest consumer
change that proves the delivery + writer chain end-to-end and
produces a measurable diff: a scenario whose effective DSL resolves
to a non-`window()` slice now produces a different probability than
before. Other consumers stay on their current read paths and are
migrated in Stage 5.

By stage end: the promoted surface is populated with per-scenario
contexted values, one back-end consumer reads from it, and the
behavioural change is observable on a sentinel scenario. The legacy
`_posteriorSlices` / `reprojectPosteriorForDsl` paths remain live
because Stage 5 consumers still need them.

Stage 5. **Remaining consumer migrations.** Switch the rest of the
back-end and front-end consumers off `posterior.*` /
`latency.posterior.*` / `_posteriorSlices` / `p.mean`-as-model-proxy
onto the canonical `p.forecast.*` surface. Scope includes
`forecast_state.py`, `forecast_runtime.py`, `graph_builder.py`,
`runners.py`, `epistemic_bands.py`, reach/carrier paths, the TS UI
display surfaces that read posterior alpha/beta directly, the CLI,
and `applyBatchLAGValues` (also brought into the `*_overridden` lock
discipline at the same time). Each consumer is its own commit so the
sequence is bisectable.

By stage end: mutating `p.mean` alone cannot alter model selection
or carrier behaviour, overtype no longer touches the source ledger,
and no live consumer reads from the legacy posterior surfaces.

Stage 6. **Cleanup.** With every consumer migrated, the legacy
delivery and projection paths can be removed.

- Remove the `_posteriorSlices` write from
  [mappingConfigurations.ts](graph-editor/src/services/updateManager/mappingConfigurations.ts)
  Flow G.
- Remove
  [`reprojectPosteriorForDsl`](graph-editor/src/services/analysisComputePreparationService.ts)
  and its helpers
  ([`projectProbabilityPosterior`, `projectLatencyPosterior`, `resolveAsatPosterior`](graph-editor/src/services/posteriorSliceResolution.ts))
  once no analysis path calls them. The slice-resolution helpers
  (`resolvePosteriorSlice`) used by Stage 4(a)'s per-scenario
  derivation stay.
- Remove `_posteriorSlices` cleanup paths in
  [`bayesPriorService.ts`](graph-editor/src/services/bayesPriorService.ts).
- Remove `posterior.*` / `latency.posterior.*` writes from the
  mapping config IF no FE display path still reads them. If FE
  display still reads them, leave them as display-only fields,
  annotated as no longer load-bearing for analysis.
- Remove remaining compatibility writes, parity-era diagnostics,
  dead source-selection branches, and stale docs so the codebase
  cleanly represents one FE quick path plus one BE careful path.

Stage 6 entry condition: a `grep -rn _posteriorSlices graph-editor/`
classification table is pinned in this doc with three columns
(file:line, classification, action). Removal proceeds only when no
"still-read" entries remain. Same treatment for the projection
helpers above.

## 9. Final acceptance criteria

This plan is complete only when all statements below are true.

1. Standard fetch pipeline has exactly two live statistical writers:
   FE quick pass and BE conditioned-forecast pass.
2. `analytic_be` no longer appears in graph state, source preference
   hierarchies, overlays, CLI output, or live-system docs.
3. Selected baseline model forecast is stable across scoped queries unless
   underlying model source changes. Narrow or zero-evidence queries no longer
   rewrite canonical baseline forecast for an edge.
4. `f` and `f+e` remain distinct after FE fallback and CF landing. `f` reads
   promoted baseline forecast. `f+e` reads current query-owned answer.
5. Changing only current query-owned fields cannot alter runtime carrier
   behaviour, promoted source selection, or model inputs for later solves.
6. FE quick pass remains fast and resilient and still provides immediate
   approximation when CF is pending or unavailable.
7. CF remains the only careful query-conditioning writer and no longer
   overwrites model-bearing baseline slots.
8. FE and CLI parity is demonstrated scenario-by-scenario from the
   scenario-owned enriched graph state defined in section 6.6, without relying
   on second analytic BE pass.
9. `manual` is no longer a citizen of the source ledger or the
   `model_source_preference` selector domain. The source-ledger families are
   exactly `bayesian` and `analytic`.
10. Output overtype writes only the value plus its `*_overridden` flag. It
    does not auto-create a `manual` source entry, does not touch the source
    ledger, and does not pin the selector.
11. Selector pin and output lock are independent affordances: pinning a
    selector does not implicitly lock outputs, and locking an output does not
    implicitly pin the selector.
12. Param packs match the canonical contract in doc 73a: per-edge
    post-projection scalar state only. Packs contain no `*_overridden` lock
    flags, no source-ledger entries, and no selector state.
13. The standard rendering pipeline (FE quick pass plus CF) operates
    correctly when no bayesian source files are present: the selector
    fallback rule selects `analytic`, FE topo supplies `analytic`, and
    promoted plus current-answer fields populate as normal.
14. All open points listed in section 7 have either been resolved with the
    resolution recorded in this plan or in a linked follow-up doc, or have
    been explicitly deferred with a documented owner and target stage.

## 10. Non-goals

This plan does not add replacement quick BE analytic path.

This plan does not redesign Bayes compiler.

This plan does not reopen cohort-versus-window semantics.

This plan does not turn FE quick pass into second careful forecast engine.

This plan does not propose clean-slate graph-schema rewrite. Goal is clean
responsibility separation with smallest lasting field and source surface.

## 11. Documentation follow-through

### 11.1 Codebase reference docs

When implementation starts landing, current-state docs must be updated in a
coordinated pass. Highest-priority targets are:
`docs/current/codebase/STATS_SUBSYSTEMS.md` (notably §6, which currently
documents `p.forecast.mean → BE CF pass` per doc 60 Decision 9 — this
ownership claim must be revised in lockstep with doc 73b Stage 4),
`docs/current/codebase/FE_BE_STATS_PARALLELISM.md`,
`docs/current/codebase/PARAMETER_SYSTEM.md`,
`docs/current/project-bayes/60-forecast-adaptation-programme.md` §6 Decision
9 (CF ownership of `p.forecast.mean` and `p.latency.completeness*` — see
§11.2 conflict 6 for the resolution path),
graph-ops CLI playbooks,
and remaining docs that still describe quick BE topo pass or treat
`p.forecast.mean` and `p.mean` as one semantic slot.

These documentation updates should land with code changes, not before, so
reference docs continue to describe live system accurately while this plan
remains the execution note.

### 11.2 Cross-doc alignment with docs 74 and 75

This plan, doc 74, and doc 73a form a related set. The following ownership
boundaries and conflicts are established by reading docs 74 and 75 against
this plan; they must be reconciled before implementation begins.

**Confirmed ownership boundaries** (verified against doc 73a content):

- Pack field membership, compositor mechanics, CF supersession, CF
  response → graph apply mapping (the §10 table), `awaitBackgroundPromises`
  orchestration, the request-graph engorgement pattern (rule §3.9 in
  doc 73a — note: the per-scenario `model_vars[]` *use* of this pattern
  has moved to this plan's bundled switchover; doc 73a retains only
  the existing CF request-snapshot use), and CLI/FE prepared-graph
  alignment — owned by doc 73a. Fit-history engorgement for
  `epistemic_bands.py` (per-asat slice resolution) is currently
  unowned by either plan and is left as a follow-up; if it becomes
  required for cleanup, it is added to this plan's Stage 5
  (consumer migration) rather than re-opening doc 73a.
- Source taxonomy, selector mechanics, promoted-layer field set, lock
  discipline on the live edge, removal of `manual` as a source, analytic
  semantic transition, decoupling of overtype from source-ledger writes,
  **per-scenario `model_vars[]` delivery** (formerly held in doc 73a
  Stage 5a), and **removal of the `_posteriorSlices` /
  `reprojectPosteriorForDsl` legacy paths** (formerly held in doc 73a
  Stage 5c) — owned by this plan.

**Conflicts to resolve before Stage 0**:

1. **Stage references in doc 73a → doc 73b**. Doc 73a §3.3, Defect 1,
   Defect 2, §3.10, and §10 cite this plan's stages for FE-side split,
   consumer-side unification, and the CF `forecast.mean = p_mean`
   change. Under the bundled-switchover restructure: per-scenario
   delivery, the promoted-writer extension, and the first BE consumer
   switch all land in **Stage 4** (the bundled switchover). Remaining
   FE-side split and consumer-side unification land in **Stage 5**.
   Legacy-path cleanup (formerly doc 73a Stage 5c) lands in **Stage 6**.
   Doc 73a's text was updated when its Stage 5 was retired; if any
   citation in 73a still names a sub-stage 5a/5b/5c, that is a
   reconciliation defect and should be reported back here.

2. **`p_sd` projection decision** — RESOLVED. Open point 9 is closed:
   CF writes `p_sd → p.stdev` (decision B-narrow). Doc 73a §3.10 and §10
   both reflect this, and doc 73a's pack contract (§8) carries `p.stdev`
   with CF as the named writer. No remaining contradiction.

3. **`applyBatchLAGValues` ownership clarification** — RESOLVED. Doc 73a
   §5 (Stop rules) now carries an explicit phasing note: the "no new
   opts gate" rule binds only during doc 73a's lifetime; doc 73b Stage 5
   takes ownership thereafter and may extend the argument surface to
   bring the function into the `*_overridden` lock discipline. The two
   plans sequence rather than conflict.

4. **Compositor lock-flag interaction**. Doc 73a §8 specifies replay
   mechanics for active-projection blocks but does not address
   `*_overridden` flag behaviour during composition. Open point 6 in
   this plan owns the rule (candidate: composition pastes scalars
   unconditionally; live-edge `*_overridden` is preserved as-was).
   **Sequencing:** open point 6 must be settled and communicated to
   doc 73a *before* doc 73a Stage 2 (the extractor/compositor stage)
   lands — not deferred to this plan's Stage 5. Doc 73a Stage 2's
   compositor implementation cannot land safely without the rule.

5. **Doc 74 references**. Doc 74 §6 currently lists settled outcomes as
   "doc 73a owns" — including items that doc 73a explicitly hands back to
   doc 73b (FE provisional-vs-model split, Python source-order
   unification). Doc 74 must be updated to match doc 73a's actual scope
   handoffs.

6. **Direct contradiction with doc 60 Decision 9 and STATS_SUBSYSTEMS §6
   on the writer of `p.forecast.mean`.** Doc 60 §6 Decision 9 (marked
   landed via WP0–WP9) declares CF the owner of `edge.p.mean`,
   `edge.p.forecast.mean`, `edge.p.latency.completeness`, and
   `edge.p.latency.completeness_stdev`. STATS_SUBSYSTEMS §6 documents
   `p.forecast.mean → BE CF pass` (with the same value as `p.mean` once
   CF lands). Doc 73b Decision 7 reverses this: it makes `p.forecast.*`
   the promoted-layer surface, declares promotion the only writer, and
   stops CF writing `p.forecast.mean` entirely. This is a settled-and-
   tested invariant being silently overwritten.

   Resolution requires explicit choice between:

   (a) Retire doc 60 Decision 9 as part of doc 73b Stage 4 (the stage
       that lands the change). This means amending doc 60 §6, updating
       any tests that pin CF as the writer of `p.forecast.mean` /
       `p.latency.completeness*`, and updating STATS_SUBSYSTEMS §6 to
       describe the new ownership. Cleaner architecturally; matches
       this plan's three-layer split.

   (b) Back off doc 73b Decision 7 to "promotion writes
       `p.forecast.*`; CF continues to write the same fields and the
       two writers must agree numerically when CF lands". Preserves
       doc 60's invariant but reintroduces the dual-writer pattern the
       three-layer split exists to remove.

   Default position of this plan is (a). Decision must be confirmed
   and recorded before doc 73b Stage 4 begins. Until confirmed, doc 60
   Decision 9 and doc 73b Decision 7 are in active conflict and any
   test pinned against either is at risk.

Reconciliation pass on docs 74, 60, and 73a is a hard prerequisite for
Stage 0 test-pinning — tests cannot pin contracts that contradict each
other across docs. Reconciliation edits land in the affected docs (60,
73a, 74, STATS_SUBSYSTEMS); this plan only records what needs to
change there.

## Appendix A — Layered contract sketch (post-completion writeup TODO)

**Status**: sketch only. Recorded here so the framing is not lost. Do
NOT promote into `docs/current/codebase/` (e.g. STATS_SUBSYSTEMS.md or a
new dedicated layer doc) until the 73a/73b project is complete and the
contract has actually landed in the live system. After project
completion, this sketch must be (a) thickened with the full per-layer
field lists pulled from the implemented `ProbabilityParam` /
`LatencyConfig` / `ModelVarsEntry` / `Evidence` types, and (b) written
up properly as the canonical layered-contract reference, replacing the
current-state field tables in STATS_SUBSYSTEMS.md §2 and §6.

---

**Source ledger** — `p.model_vars[]`. Two entries only: `bayesian`,
`analytic`. No `manual` — user authoring lives at promoted (selector
pin) and current-answer (per-field locks). Bayesian is file-backed and
per query context — has slices keyed by `window()`, `cohort()`,
`context(channel:foo).window()`, etc. Each per-scenario request graph
carries the slice for that scenario's effective DSL only, derived
per-fetch by Stage 4(a) from the parameter file (request-graph
engorgement, not persisted).

**Promoted layer** — `p.forecast.{mean, stdev, alpha, beta, alpha_pred,
beta_pred, n_effective, source}` plus the existing promoted latency
block. Written only by `applyPromotion`. Quality-gated source selection
(bayesian if gates pass, else analytic) respecting the user's selector
pin. Per-scenario by construction, because the per-scenario source slice
differs per effective DSL — same source family promoted on two scenarios
still produces different α/β if the slices differ. (Earlier "only
diverges if source changes" framing was wrong precisely here.)

**Evidence layer** — `p.evidence.*`. Raw query-scoped k/n.

**Current-answer layer** — `p.mean`, `p.stdev`, `p.latency.completeness`,
`p.latency.completeness_stdev`. Query-conditioned. FE quick pass writes
provisional values; CF overwrites authoritatively. Per-field
`*_overridden` flags freeze a scalar from automated rewrite.

**Display modes select layer:**

- `'f'` → `p.forecast.mean` (promoted aggregate for the active context —
  not IS-conditioned)
- `'e'` → `p.evidence.mean` (raw query-scoped evidence)
- `'f+e'` → `p.mean` (CF's IS-conditioned blend, or FE's pre-CF blend)

**FE quick pass roles**: produces `model_vars[analytic]`; reads the
promoted layer for forecast contributions; aggregates evidence into
`p.evidence.*`; writes provisional current-answer scalars.

**CF roles**: reads the promoted layer as proposal; IS-conditions on
query-scoped evidence; writes only the current-answer scalars.

**Pack contract**: promoted scalars + current-answer scalars +
`p.evidence.*` + `p.posterior.*` (during phasing) + `conditional_p` +
`p.n`. Not in pack: source ledger, selector, `*_overridden` flags. Pack
values are unconditional pasted scalars; lock state is reconstituted at
compose time on the live edge.
