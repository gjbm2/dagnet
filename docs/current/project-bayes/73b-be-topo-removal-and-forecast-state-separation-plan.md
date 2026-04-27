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

Decision 7. `p.mean` and `p.forecast.mean` are distinct semantic slots and
stop collapsing onto one value. `p.mean` is current query-scoped answer
(FE-quick and CF write). `p.forecast.mean` is promoted baseline model
forecast (promotion writes). Probability gains the narrow promoted surface
`p.forecast.{mean, stdev, source}` symmetric to latency's existing promoted
fields. CF stops writing `forecast.mean = p_mean`.

The promoted persistent surface is intentionally narrow because the only
persistent consumers are FE display surfaces (`'f'` mode read; ModelRateChart;
edge labels), all of which need only mean/stdev/source. The Beta-shape
fields (`alpha`, `beta`, `alpha_pred`, `beta_pred`, `n_effective`) that BE
consumers read live in `p.posterior.*` (the standard posterior block),
which is contexted per scenario by Stage 4(a) — they reach the BE through
in-schema posterior projection on the request graph, not through engorgement.
The one field BE consumers read that has no place in the normal schema is
`fit_history`, used by `epistemic_bands.py`; that is the sole legitimate
engorgement need (see Decision 15). Persistent storage of the multi-context
slice library on the live graph (the `_posteriorSlices` stash) is retired.

Decision 15 (revised). Two distinct request-graph operations are required;
they are different in kind and must not be conflated:

(i) **Per-scenario contexting** — adapting a graph (live edge or
request-graph copy) for a specific effective DSL by selecting the
matching slice from the parameter file and projecting it onto the
*standard* schema fields (`model_vars[bayesian]`,
`p.posterior.*`, `p.latency.posterior.*`). All values land in fields the
schema already recognises. Required for normal app behaviour.

(ii) **Engorgement** — writing onto a transient request-graph copy a
field that does not belong to the normal graph schema, *for the
specific purpose of relaying file-depth data across a process boundary*
(BE analysis, BE CF, Bayes run). Examples are out-of-schema fields
like `fit_history` that BE consumers read but the live graph never
holds. The graph copy is discarded after the call.

The live editor edge needs (i) only — it never crosses a boundary.
Per-scenario request graphs (for CF dispatch and analysis-prep) need (i)
plus (ii). The implementation may share a helper, but the two operations
are conceptually distinct and the docs name them distinctly.

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

Decision 13. **Sources are aggregate; current answer is scoped;
combination is uniform.**

Both source families carry **aggregate** model material:

- `bayesian` — offline fit by the Bayes compiler on a training
  corpus, file-backed, multi-context slice library.
- `analytic` — FE topo Step 1 output, recency-weighted aggregation
  across window data.

`p.evidence.{n, k}` is **scoped** to the user's current query. The
current-answer scalars (`p.mean`, `p.stdev`, completeness) are
**always scoped** — there is no non-scoped writer of `p.mean`.

Two combination passes write the current answer:

- **FE topo Step 2** — quick blend of aggregate source +
  scoped evidence. Provisional.
- **CF** — careful IS-conditioning of aggregate source + scoped
  evidence (DB snapshot evidence and file evidence engorged as
  `_bayes_evidence`). Authoritative when it lands.

Both passes have the same input contract (aggregate source +
scoped evidence) and write the same persistent fields with the same
persistence model. Promotion picks which source feeds the pass; the
combination logic is source-agnostic. CF wins because it runs
second and is more careful, not because it has special status.

**There is no source-conditional skip path. CF runs uniformly for
every promoted source.**

**Implementation defects to remove** (the present runtime does not
match this design — flagged here, not part of the decision proper):

- The resolver's D20 shortcut at `model_resolver.py:392-417`
  synthesises α/β for analytic from current-answer fields
  (`p.evidence.{n,k}` and, in adjacent paths, `p.mean`) instead of
  from the promoted source layer. That is a layer violation. The
  current-answer evidence block is scoped to the active DSL and must
  never be used as a model prior or as a hidden concentration source.
  The only valid analytic-source inputs are FE topo **Step 1** source
  entries under `model_vars[analytic]` and promoted fields derived from
  that source. FE topo **Step 2** writes the scoped blended current answer
  (`p.mean`) using simple analytic conditioning over the active DSL's
  evidence. That `p.mean` is not a model-var field and must not be
  consumed by CF or any BE model-input path.
- If FE topo cannot provide a full Beta-shape source, the system must
  degrade honestly. Acceptable degradation is one of: moment-match from
  FE topo Step 1's aggregate `model_vars[analytic].probability.{mean, stdev}`
  when the variance is valid; use an explicitly named point-estimate prior
  strength recorded in the fallback register; or return a no-prior /
  skipped result with diagnostics. Borrowing `p.evidence.{n,k}` is not
  an acceptable degradation path.
- The discriminator (`alpha_beta_query_scoped` at
  `model_resolver.py:107-108`), the sweep-eligibility gate
  (`is_cf_sweep_eligible` at `forecast_runtime.py:514`), and the
  `'analytic_degraded'` CF mode at `forecast_runtime.py:524-528`
  are all artefacts of the current incorrect path. They are
  removed once the resolver supplies aggregate α/β for analytic.
  CF then runs uniformly; the conjugate-update branch in
  `cohort_forecast_v3.py:148-152` becomes the only branch.

OP8's earlier "no structural change required" stance is **superseded**.
Decision 13 names a real behavioural change. The earlier "transition
to aggregate" framing pointed at the right end-state but located the
change wrong: the source ledger has always been aggregate by design;
the transition is the runtime change above so analytic actually
behaves as aggregate at resolver-time, letting CF do its job.

Decision 14. Doc 73a is a binding prerequisite for Stage 3 onwards. Doc 73a
owns: pack field membership (§8), `applyComposedParamsToGraph` mechanics,
per-scenario CF supersession (§7), the CF response → graph apply mapping
(§10), `awaitBackgroundPromises` orchestration (§10), the request-graph
engorgement *pattern* (§3.9 — note: the per-scenario engorgement of
slice material into the request graph at analysis-prep time is owned by
this plan's Stage 4(a); doc 73a retains only the existing CF
request-snapshot use of the same pattern), and CLI/FE prepared-graph
alignment (§12; binding for this plan only after Stage 4(a) delivers
per-scenario engorgement). Stages 0–2 of this plan (test pinning,
Work-A verify, analytic-transition shadow) may proceed in parallel with
doc 73a work; Stage 3 (`manual` removal) and beyond must not start
until doc 73a's **§15A pre-handoff acceptance gates** pass. Doc 73a's
§15B final-cleanup gates depend on this plan's Stage 4 (slice-material
relocation) completing, so they cannot be the trigger for this plan's
Stage 3 — that would be circular. Once the source ledger and live-edge
state start changing, pack composition is on the critical path. Where
this plan and doc 73a disagree, doc 73a wins on its listed concerns;
this plan wins on source/promoted/current-answer layering, selector
mechanics, removal of `manual`, and lock discipline on the live edge.
Concrete cross-doc conflicts to reconcile before Stage 0 are listed
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
file-backed and keyed by query context. The full multi-context slice library
lives in the parameter file; the graph never holds the whole library
persistently. The **live editor edge** carries one slice — the one matching
the current DSL on the canvas — refreshed on `currentDSL` change by
**contexting** (Stage 4(e); see §8). Per-scenario request graphs are
copies of the live edge re-contexted to each scenario's effective DSL
(Stage 4(a)). Per-scenario contexting on a request graph is a
promotion-triggering event for that request graph (the new slice may
change the promoted source). All of this is in-schema field projection;
none of it is engorgement (see §3.2a for the precise distinction).

`analytic` is the FE fallback source. It is the output of FE topo
**Step 1**: recency-weighted aggregation across window data, producing
aggregate model material (probability `mean`/`stdev`, latency
`mu`/`sigma`/`t95`/...). It is graph-only, regenerated from graph
state, not persisted to files. Like `bayesian`, it is aggregate at
the source-ledger layer — never a scoped answer.

Per Decision 13, the scoped current-answer scalars (`p.mean`,
`p.stdev`, completeness) are written by two combination passes —
FE topo Step 2 (quick blend of aggregate source + scoped evidence)
and CF (careful IS-conditioning of the same inputs). Both passes
take whichever source promotion has selected and treat it uniformly
as an aggregate prior. Both write the same persistent fields with
the same persistence model. CF wins because it runs second and is
more careful, not because it has special persistence status, and
not because the source family changes its behaviour.

`manual` is no longer a source. User authoring lives at the promoted layer
(selector pin, see 3.5) and at the current-answer layer (per-field locks, see
3.3 and 3.5), never in the source ledger.

No fourth source family is introduced. With both `analytic_be` and `manual`
removed from the ledger, `bayesian` and `analytic` are the only entries.

### 3.2 Promoted model surface

Promotion projects the selected source's headline values into stable flat
graph fields meaning "selected baseline model".

Latency already follows this pattern through existing promoted latency
fields. Probability gains the symmetric pattern: `p.forecast.{mean, stdev,
source}` — three fields. This is the persistent display surface read by
the FE in `'f'` mode, by `ModelRateChart`, and by edge labels.

The persistent promoted surface is intentionally narrow. Beta-shape
parameters (`alpha`, `beta`, `alpha_pred`, `beta_pred`, `n_effective`),
the latency posterior block, fit_history, and other slice-level depth
that BE consumers read are NOT placed on a persistent promoted surface.
These are engorged onto each request graph at request-build time from
the parameter file's matching slice (Decision 15 and §3.3). Putting
them on a persistent surface would either require keeping the live
graph in sync with the parameter file's full slice library (the current
`_posteriorSlices` tumour) or accepting promoted-surface staleness on
every DSL change. The engorgement model avoids both.

Promotion is the only writer of promoted fields. The writer is
`applyPromotion` in
[modelVarsResolution.ts](graph-editor/src/services/modelVarsResolution.ts) —
today it writes only the latency promoted block (lines 160–186) with an
explicit comment at lines 156–158 deferring `p.forecast.*` to "the topo
pass / pipeline". Stage 4 extends `applyPromotion` to write the three
promoted-probability fields and removes the deferral comment. CF stops
writing `forecast.mean = p_mean`. Promotion is also responsible for the
per-edge selector default (quality-gated rule), respecting any user pin.

### 3.2a Per-scenario contexting and engorgement of request graphs

Two operations happen at request-build time. They are different in kind
(see Decision 15) and the docs name them distinctly to avoid eliding them.

**(i) Contexting** — the request graph is a copy of the live edge,
re-projected to the scenario's effective DSL. Concretely: pick the
matching slice from the parameter file for that DSL and project it onto
the standard schema fields on each edge of the copy:
`model_vars[bayesian]`, `p.posterior.*`, `p.latency.posterior.*`. All
three are in-schema fields the live graph already recognises. The BE
consumers that read Beta-shape and predictive parameters (`alpha`,
`beta`, `alpha_pred`, `beta_pred`, `n_effective`, `cohort_*`,
`window_*`) read them from `p.posterior.*`, and `forecast_state.py`
reads latency joint draws from `p.latency.posterior.*` — so
per-scenario contexting of those two blocks is sufficient for them.
**`model_vars[bayesian]` is also a runtime-read field, not just a
promotion input**:
[`cohort_forecast_v3.py`](graph-editor/lib/runner/cohort_forecast_v3.py)
reads `p.model_vars[bayesian]` directly when computing predictive
maturity rows, so contexting must keep `model_vars[bayesian]` in sync
with the scenario's effective DSL on every request graph (and on the
live edge per Stage 4(e)). No out-of-schema material is required for
any of these consumers.

**(ii) Engorgement** — write onto the request-graph copy any
out-of-schema fields a BE consumer needs that don't fit the normal
graph schema. Today's engorged set, all bayes-related (none written
when the active source is analytic):

- `_bayes_evidence` — file evidence material, including aggregate
  counts AND time-series cohort daily-row data
  (`cohort[].n_daily`, `k_daily`, `dates`). Consumed by CF for
  IS-conditioning, and by
  [`api_handlers.py:2099`](graph-editor/lib/api_handlers.py#L2099)
  to supplement DB-snapshot rows with file rows the snapshot
  doesn't cover. Engorged today by
  [`bayesEngorge.ts`](graph-editor/src/lib/bayesEngorge.ts); no
  change in Stage 4.
- `_bayes_priors` — bayesian prior material consumed by CF as the
  IS prior. Carries `prob_alpha`, `prob_beta`, `prob_source`
  (provenance — `warm_start` / `moment_matched` / `kn_derived` /
  `uninformative`), edge-level latency priors (`latency_mu`,
  `latency_sigma`, `latency_onset`, `latency_source`,
  `onset_uncertainty`), warm-start ESS hint (`kappa`), path-level
  cohort-derived latency (`cohort_mu`, `cohort_sigma`,
  `cohort_onset`), and histogram-derived onset observations
  (`onset_observations` per doc 41a). Engorged today by
  `bayesEngorge.ts`; no change in Stage 4.
- `_posteriorSlices.fit_history` — history of bayesian fits per
  `asat` date. Consumed by
  [`epistemic_bands.py:148-149`](graph-editor/lib/runner/epistemic_bands.py#L148-L149)
  for time-axis epistemic bands. **New in Stage 4(a)**: today
  supplied by the persistent Flow G stash; once Stage 4(b) removes
  the stash, it is engorged per call from the parameter file.

DB-snapshot evidence is not engorged — the BE queries the DB
directly. Engorgement covers file-sourced material only, in
compliance with rule §3.8 (the Python runtime is stateless about
parameter files). If a future BE consumer needs a new out-of-schema
field, it joins this list.

Both operations happen on the request-graph *copy*; the live graph is
unchanged by either. CF dispatch
(`buildConditionedForecastGraphSnapshot`) and analysis preparation
(`analysisComputePreparationService`) both run them via the existing
slice-resolution machinery (see "Wiring" below).

**Wiring — no new matching logic.** Stage 4(a) (per-scenario request
graphs) and Stage 4(e) (live-edge re-context on `currentDSL` change)
MUST use the existing, tested slice-resolution functions. They are
thin orchestration wrappers; correctness is owned by the existing
modules and their test suites. No new contract, no new fallback
rules, no new normalisation.

- **Param-file posterior slice library** (drives contexting of
  `model_vars[bayesian]`, `p.posterior.*`, `p.latency.posterior.*`):
  use [`buildSliceKey(effectiveDsl)`](graph-editor/src/services/posteriorSliceResolution.ts)
  to canonicalise the scenario's effective DSL and
  [`resolvePosteriorSlice(slices, effectiveDsl)`](graph-editor/src/services/posteriorSliceResolution.ts)
  to pick the matching entry from the parameter file's
  `posterior.slices`. Exact-match → bare-mode aggregate fallback →
  undefined; that semantics is inherited as-is.
- **Snapshot regime construction** (when the request also drives a
  snapshot subject): use
  [`buildCandidateRegimesByEdge(graph, workspace, parameterFiles)`](graph-editor/src/services/candidateRegimeService.ts)
  on the request-graph copy. The BE then calls
  [`select_regime_rows(rows, candidate_regimes)`](graph-editor/lib/snapshot_regime_selection.py)
  per the contract in
  [`30-snapshot-regime-selection-contract.md`](docs/current/project-bayes/30-snapshot-regime-selection-contract.md).
- **MECE / dimensional reduction** (when the effective DSL queries a
  subset of MECE-partitioned dimensions): the existing
  `meceSliceService` and `dimensionalReductionService` selectors
  apply unchanged.
- **Engorgement**: [`bayesEngorge.ts`](graph-editor/src/lib/bayesEngorge.ts)
  attaches `_bayes_evidence` and `_bayes_priors`. Stage 4(a) extends
  it (only) to attach `_posteriorSlices.fit_history` per the shape
  consumed by [`epistemic_bands.py`](graph-editor/lib/runner/epistemic_bands.py)
  (`fit_history`, `slices`, `fitted_at`, `hdi_level`, plus the
  per-fit-history slice fields `p_hdi_lower`, `p_hdi_upper`,
  `evidence_grade`).

Stage 4(a) and 4(e) differ only in caller and target (request-graph
copy vs live edge); they invoke the same functions with the same
contracts. Anything beyond orchestration — different fallbacks,
different normalisation, additional matching rules — is out of scope
for these stages and should be raised as a defect against the
existing slice-resolution modules instead.

The persistent live graph keeps its existing single-context `posterior.*`
/ `latency.posterior.*` projection (written by `mappingConfigurations.ts`
Flow F, the file→graph projection of the active edge's current-context
posterior). On `currentDSL` change, that projection is re-contexted on
the live edge by Stage 4(e), driven by the same shared slice helper.

What goes away: the persistent `_posteriorSlices` stash on the live
graph (`mappingConfigurations.ts` Flow G). It is no longer the source
for `reprojectPosteriorForDsl`; the live-edge re-context (Stage 4(e))
and the request-graph contexting/engorgement (Stage 4(a)) both read
the parameter file directly via the shared slice helper.

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

### 3.8 Fallback and degradation register

Fallbacks are not allowed to be implicit. Any fallback or degraded path
inside the Stage 2 fetch pipeline, resolver, CF runtime, scenario transport,
or analysis-prep request graph must be entered in this plan before it is kept
or introduced.

Each register entry must state:

- trigger condition;
- source layer read;
- output layer written;
- provenance / diagnostic exposed to callers;
- test or outside-in gate that proves the fallback fires only under that
  trigger;
- owner stage and removal condition.

Initial register items for this plan:

1. `model_resolver.py` D20 evidence-count prior synthesis. Status:
   invalid. It reads current-answer `p.evidence.{n,k}` as a model prior
   concentration source. Stage 2 removes or quarantines it behind an
   explicit failure diagnostic; it must not survive as a silent fallback.
2. `model_resolver.py` fixed point-estimate prior strength. Status:
   provisional. It may survive only if renamed and documented as an
   analytic point-estimate degradation path sourced from
   FE topo Step 1's `model_vars[analytic].probability.mean`, with the concentration
   constant named, tested, and surfaced in diagnostics. It must not read
   current-answer evidence.
3. `analytic_degraded` / query-scoped-posterior mode. Status: migration
   guard only. It exists because the resolver currently cannot always
   present analytic as an aggregate source. Stage 2/Stage 4 remove it once
   analytic source priors are source-layer values.
   While it exists, CF response projection must preserve provenance
   consistency: if `cf_reason == query_scoped_posterior` or conditioning
   reports `skip_reason == source_query_scoped`, the projector must not write
   horizon-row `evidence_k` / `evidence_n` back into graph
   `p.evidence.{k,n}`. Those counts belong to a different evidence family
   from the query-scoped posterior that produced `p_mean`; writing them makes
   repeated CF application non-idempotent. This projection guard is deleted
   when Stage 2/Stage 4 remove `analytic_degraded` and the resolver presents
   analytic as an aggregate prior source.
4. Context-stripping posterior-slice fallback. Status: invalid at the
   bayesian-source layer. Stage 4(a) removes or guards it so per-scenario
   request graphs use exact-context slice material only.
5. Scenario param-only analysis transport. Status: invalid for analysis
   execution. Param packs are export/edit artefacts, not a lossless carrier
   for scenario-owned enriched graph state. Stage 4(a) / Stage 6 must
   preserve the enriched scenario graph or prove an explicitly lossless
   request-graph build.
6. Carrier weak-prior / empirical fallback paths in `forecast_state.py`.
   Status: audit required. Stage 4(d)'s runner audit classifies each as
   designed degradation or removes it. Any survivor must expose provenance
   and have an outside-in regression.

### 3.9 FE topo analytic source mirror contract

FE topo Step 1 must export analytic source material in the same temporal
family shape that the Bayes compiler exports, while preserving the distinction
between source-layer model material and scoped current-answer state.

Bayes exports:

- a `window()` family for edge-rate probability and edge-level latency;
- a `cohort()` family for the same edge-rate probability family plus
  path-level latency, when path fields exist;
- context-qualified mirrors of those families for exact-context slices.

The analytic source must mirror that shape in `model_vars[analytic]`.

Required analytic probability fields:

- `probability.mean` — aggregate window-family analytic rate estimate, used
  by promotion as the default `p.forecast.mean`;
- `probability.stdev` — epistemic uncertainty for the aggregate window-family
  analytic rate estimate;
- `probability.alpha`, `probability.beta` — window-family epistemic Beta
  shape derived from the same aggregate source basis as `probability.mean`;
- `probability.n_effective` or `probability.window_n_effective` — source
  mass behind the window-family analytic shape;
- `probability.provenance` — source-basis label such as
  `analytic_window_baseline` or `analytic_mature_window_degraded`;
- `probability.cohort_alpha`, `probability.cohort_beta` — cohort-family
  epistemic Beta shape when aggregate cohort-family evidence exists;
- `probability.cohort_n_effective` — source mass behind the cohort-family
  analytic shape;
- `probability.cohort_provenance` — source-basis label for the cohort-family
  shape.

FE topo must not emit analytic `alpha_pred` / `beta_pred` or
`cohort_alpha_pred` / `cohort_beta_pred` unless a specific analytic
overdispersion model is designed and tested. Until then, analytic predictive
probability is absent and forecast consumers fall back to the epistemic shape.
This mirrors the Bayes contract when kappa is absent.

Window-family analytic shape is derived from aggregate window evidence, not
from current-answer evidence. Cohort-family analytic shape is derived from
aggregate cohort-family evidence and path-latency maturity, not from the
active query's scoped `p.evidence.{n,k}`. If cohort-family aggregate evidence
is unavailable, omit the cohort fields and let the resolver fall back to the
window-family shape, matching the existing Bayes projection behaviour.

For cohort-family analytic shape, the implementation must specify and test
the exact aggregate cohort evidence basis it uses. The minimum acceptable
rule is: use only cohort-family slices that are outside the active query's
current-answer surface, evaluate maturity against path-level latency, compute
`cohort_n_effective` from that same aggregate family, and omit the cohort
shape if those inputs are unavailable or too sparse. It is not acceptable to
derive `cohort_alpha` / `cohort_beta` from the active DSL's
`p.evidence.{n,k}`.

The smoothing convention for FE analytic Beta shape must be explicit. The
default recommendation is to use the source mass as the concentration basis:
`alpha = mean * n_effective + 1`, `beta = (1 - mean) * n_effective + 1`.
If implementation instead moment-matches from `mean` and `stdev`, that must
be a deliberate choice, with invalid-variance handling documented and tested.

Required analytic latency fields remain the existing split:

- window / edge-level: `mu`, `sigma`, `t95`, `onset_delta_days`, `mu_sd`,
  `sigma_sd`, `onset_sd`, `onset_mu_corr`;
- cohort / path-level: `path_mu`, `path_sigma`, `path_t95`,
  `path_onset_delta_days`, `path_mu_sd`, `path_sigma_sd`, `path_onset_sd`.

No Bayes quality metadata (`ess`, `rhat`, LOO, PPC, HDI quality claims) is
invented for analytic. Analytic provenance is source-basis provenance, not
Bayesian quality provenance.

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
double-counting. The target contract requires `analytic` to resolve from FE
topo Step 1 (`model_vars[analytic]`, aggregate source layer), never from FE
topo Step 2 (`p.mean`, scoped current-answer blend) and never from scoped
current-answer evidence. If the analytic source lacks sufficient shape for CF,
the runtime must use a
registered degradation path or fail explicitly; it must not synthesize prior
mass from `p.evidence.{n,k}`. Closing this mismatch includes adding the
window/cohort analytic source fields in §3.9 and teaching the Python resolver
to read them. Separately,
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
consumers to read instead. Stage 4(c) closes (ii) by promoting probability
to the narrow `p.forecast.{mean, stdev, source}` surface. Stage 4(d)
closes (i) by routing the carrier read in `_resolve_edge_p` (and any
sibling reach/carrier sites) through the shared `resolve_model_params`
resolver — so the carrier picks the promoted source by the same rule as
every other consumer. The FE quick write itself is preserved. See §6.5
for the principle and the drift-prevention rule that governs every future
model-input read.

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
Rebuilding analysis input from a stripped param pack is not sufficient unless
the build step is proven lossless for model source, promoted, current-answer,
and request-only fields. Param packs remain the export/edit contract; analysis
execution must consume scenario-owned enriched graph state or an explicitly
lossless request graph derived from it.

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

FE quick must produce `analytic` as a clean model source — full relevant
`window()` family for probability, existing lag-fit inputs for latency —
not a query-owned posterior in disguise. Current query-scoped evidence
remains in `p.evidence.*`; current query provisional answer remains in
current-answer fields. Baseline forecast estimate from
`windowAggregationService.ts` lands in `analytic` and then promotion, not
in CF-owned or current-answer fields.

### 6.2 Give probability a (narrow) promoted model surface

Promotion projects the winning probability source onto the three-field
`p.forecast.{mean, stdev, source}` surface (§3.2). Owner: `applyPromotion`
in `modelVarsResolution.ts`.

- `modelVarsResolution.ts:156-158` — replace the latency-only avoidance
  with positive promotion of the three `p.forecast.*` fields.
- `conditionedForecastService.ts:227-239` — stop writing
  `forecast.mean = p_mean` (the `f` vs `f+e` collapse).

BE consumers are not migrated as part of this work. They keep reading
from the field shapes they read today (`posterior.*`, `model_vars[]`,
`latency.posterior.*`). What changes is *where* those values come from
on the request graph: per-scenario contexting (Stage 4(a) (i)) supplies
them in-schema for the scenario's effective DSL; the `_posteriorSlices`
persistent stash on the live graph is removed. Consumer code is
unchanged for slice-material readers.

The narrowing of the persistent promoted surface to
`p.forecast.{mean, stdev, source}` is safe because the BE never reads
`p.forecast.{alpha, beta, alpha_pred, beta_pred, n_effective}` —
verified by grep: those fields are read from `posterior_block` (i.e.
`p.posterior.*`) in `model_resolver.py`, not from `p.forecast.*`. The
out-of-schema material BE consumers need (`_bayes_evidence`,
`_bayes_priors`, `_posteriorSlices.fit_history`) is supplied by
request-graph engorgement, not by the persistent promoted surface.
See §3.2a (ii) for the full list and consumer mapping.

The carrier `p.mean` read in `forecast_state.py` is the one consumer
that *does* change — that read is a model-input read of a current-answer
field (a layer-split defect) and is fixed by Stage 4(d) routing it
through the shared resolver (`resolve_model_params`). See §6.5.

### 6.2a Move slice material from persistent to transient

The structural defect this plan closes is that the live graph
persistently carries a per-edge slice library (`_posteriorSlices` stash
written by `mappingConfigurations.ts` Flow G), plus its dependent
`reprojectPosteriorForDsl` per-DSL projector. The persistent stash is
file-depth data living on the wrong layer.

Fix: separate the two operations the stash conflated and locate them
properly (using the contexting/engorgement distinction from §3.2a):

- **Stop the persistent multi-context stash.** Remove the `_posteriorSlices`
  write in `mappingConfigurations.ts` Flow G. The live graph no longer
  carries the multi-context library.
- **Live-edge contexting on `currentDSL` change** (Stage 4(e)). When the
  user changes the live current-DSL on the canvas, re-project the
  matching slice onto the live edge's standard schema fields:
  `model_vars[bayesian]`, `p.posterior.*`, `p.latency.posterior.*`. This
  is in-schema, single-context, no out-of-schema material. Driven by the
  shared slice helper. Replaces today's `reprojectPosteriorForDsl`
  read-from-stash with a read-from-parameter-file via the same helper.
- **Per-scenario request-graph contexting and engorgement** at
  analysis-prep / CF dispatch (Stage 4(a)). Each per-scenario request
  graph copy is contexted to the scenario's effective DSL (in-schema
  fields) and engorged with `fit_history` for `epistemic_bands.py`
  (out-of-schema). See §3.2a for the precise distinction.

Per-scenario contexting falls out from the helper accepting an effective
DSL parameter — same code, different DSL per call.

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

BE runtime and graph consumers must not read current-answer fields
(`p.mean`, `p.stdev`, completeness fields) as model-bearing input.
This is the negative invariant: changing only a current query-owned
scalar must not alter carrier behaviour, promoted source selection,
or baseline model used by later solves.

The positive rule is that all model-input reads go through one shared
resolver that re-applies the promotion decision. Today that resolver
is `resolve_model_params` in
[model_resolver.py](graph-editor/lib/runner/model_resolver.py); it
reads from `model_vars[]` honouring the selector pin and the
quality-gated default, falling back to `p.posterior` / `p.forecast`
as appropriate. A consumer that reads `model_vars[]` directly is fine
provided it goes through this resolver; a consumer that reads
`p.forecast.{mean, stdev, source}` directly is also fine because
`applyPromotion` and the resolver are bound to the same selection
rule. What is not fine is hand-coded paths that pick a source
themselves, or reads of `p.mean` as a model proxy.

The live defect is `_resolve_edge_p` in
[forecast_state.py](graph-editor/lib/runner/forecast_state.py),
which reads `p.mean` first for the upstream carrier — a path that
FE quick's provisional `p.mean` writes can poison. Fix: route the
carrier read through `resolve_model_params` (or an equivalent shared
helper if the call surface differs), so the carrier picks the
promoted source by the same rule as every other consumer. The
sibling carrier-style `p.mean` reads confirmed today —
[`graph_builder.py:202`](graph-editor/lib/runner/graph_builder.py#L202)
(`return p.get('mean')`) and
[`path_runner.py:105`](graph-editor/lib/runner/path_runner.py#L105)
(`pv = float(p.get('mean') or 0.0)`) — get the same treatment.
Stage 4(d)'s first task is an audit pass over `graph-editor/lib/runner/`
to confirm that list is exhaustive (any further `p.get('mean')` /
`p['mean']` site used as a model input, not as a current-answer
display, joins it).

This work lands in Stage 4(d), alongside Stage 4(c)'s narrow
promoted writer and CF de-collapse. The two are tightly coupled:
the promoted surface comes into existence in (c); the carrier
consumer starts honouring it in (d). One bisectable group.

Drift-prevention rule: any future model-input read must go through
the shared resolver. Hand-coded source-selection in a consumer is
a regression and should fail review.

This rule covers conditional probabilities the same way as the
unconditional `p`. Each entry under `conditional_p` carries its own
`p` block with the same field shape (posterior, evidence, forecast,
locks). Reads of any conditional `p.mean` for model purposes must go
through the same shared resolver, applied per condition. Conditionals
are not a special case at this layer — the storage form differs (see
73a §3 rule 7) but the resolver discipline is uniform.

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
4. **Output** — current-answer display. `mean` and `stdev` remain
   editable; edits write `p.mean`/`p.stdev` and flip `*_overridden`,
   sticking against subsequent automated writes (FE quick / CF / batch
   helpers).

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

Action B7e. Keep the existing "Output" card in
[`graph-editor/src/components/ModelVarsCards.tsx`](graph-editor/src/components/ModelVarsCards.tsx).
Editable `mean`/`stdev` fields and `AutomatableField` override
wrappers stay as today; edits write `p.mean`/`p.stdev` and flip
`*_overridden`. Remove only the manual-source side-effects: the
auto-flip-source-to-manual on first keystroke (`handleOutputStartEdit`
at lines 154-164), the "click-active-card-off → pin to manual" branch
at lines 125-127 of the `handleToggle` callback (replace with
"click-active-card-off → unpin (return to quality-gated default)"),
the `findEntry(modelVars, 'manual')` lookup at line 105, and any
`'manual'` references in the card header rendering at lines 246-256.

Action B7f. Cutover for in-the-wild graphs per OP1 (graceful degrade
in the loader). See §7 OP1 for the rule.

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

Action B8a. The lock-respecting flag set is `p.mean_overridden` and
`p.stdev_overridden`, on every parameter — meaning the unconditional
`p` and the `p` block of every entry under `conditional_p` (per
open point 7 resolution). The pack's `conditional_p` is a Record
keyed by the **actual condition string** (e.g.
`conditional_p["visited(b)"].p.mean_overridden`), never by a
numeric position. Both flags already exist in the schema; no
additions.

Action B8b. The `AutomatableField` wrapper component remains the canonical UI
for these locks. Lock-clear UX writes `*_overridden: false` only and leaves
the previous value visible (sticky on unlock). Next legitimate automated
write may overwrite that value.

Action B8c. The lock-respecting writer set: FE quick pass, CF, runtime
cascades, and `applyBatchLAGValues` (currently writes `p.mean` from
`blendedMean` without checking `mean_overridden`; must be brought into
the discipline). Locked ⇒ skip. The check applies uniformly to the
unconditional `p` and to every entry under `conditional_p`; conditionals
are not a special case for lock discipline. Promotion and scenario
composition are explicitly outside the discipline (per OP6 and §3.2 —
promotion writes only promoted fields; composition pastes pack state
without writing through locks).

Action B8d. Selector pin and output lock are independent. Pinning a selector
must not implicitly lock outputs. Locking an output must not implicitly pin
the selector.

Completion gates for Work package B are listed in §9.

## 7. Open points to settle before implementation

These items are explicitly unresolved and must be settled before the
corresponding stage lands. They are listed here so a reader can scan what is
still in flight versus what is binding.

**Resolved**

- **OP1 — `manual` migration policy**. Cutover with graceful degrade.
  Loader treats in-the-wild `model_vars[].source === 'manual'` as
  not-present and `model_source_preference === 'manual'` as unpinned;
  each occurrence logs an info entry via `sessionLogService`. No
  user-facing error. In-the-wild conversion is out of scope.
- **OP2 — `p.forecast.source` provenance**. Required (per Decision 7
  and §3.2). Consumers branch on it during the analytic semantic
  transition and read it for human readability thereafter.
- **OP4 — Quality-gate volatility**. Default behaviour is silent
  flip-with-gate; revisit only if instability becomes user-visible.
- **OP6 — Two-path manual edit interaction**. (i) Composition pastes
  scalars unconditionally; live-edge `*_overridden` is preserved
  as-was — composition never toggles the flag. (ii) The lock blocks
  subsequent automated rewrites (FE quick, CF, runtime cascades,
  `applyBatchLAGValues`) but never blocks pack-paste (pack-paste is
  composition, not automated rewrite). Both authoring affordances
  remain effective; the lock affects automation only. Doc 73a Stage 2
  must implement rule (i).
- **OP7 — `*_overridden` coverage**. Only `p.mean` and `p.stdev` (on
  every parameter, including each `conditional_p[X].p`). Both flags
  already exist in the schema; no additions. Stage 5 wires the
  writers.
- **OP8 — Analytic semantic transition (Decision 13)**. No structural
  change required. CF conditions on the analytic source the same way
  it conditions on the bayesian source — both project onto
  `p.forecast.{alpha, beta}` and are used as priors. The
  double-counting risk for analytic-as-aggregate-posterior is handled
  by CF's existing **subset blend adjustment**, regime-selected via
  `alpha_beta_query_scoped` at
  [model_resolver.py:107-108](graph-editor/lib/runner/model_resolver.py#L107-L108)
  (read by consumers at
  [cohort_forecast_v3.py:132](graph-editor/lib/runner/cohort_forecast_v3.py#L132),
  [forecast_runtime.py:472](graph-editor/lib/runner/forecast_runtime.py#L472),
  [forecast_state.py:1001](graph-editor/lib/runner/forecast_state.py#L1001)).
  Stage 2's work reduces to a comment-block rewrite at
  [model_resolver.py:100-108](graph-editor/lib/runner/model_resolver.py#L100-L108)
  and the mechanical rename of `alpha_beta_query_scoped` to a name
  that conveys "which subset-blend regime applies" (e.g.
  `evidence_already_aggregated`).
- **OP9 — `p_sd` projection**. CF writes `p_sd → p.stdev` (decision
  B-narrow). See doc 73a §10.

**Open** (must be settled before the named stage)

- **OP3 — Selector pin when pinned source becomes unavailable**.
  Candidate: silent fallback to `analytic`, pin retained, UI shows
  pin currently inactive. Alternative: auto-clear the pin. Settle
  before Stage 4(c) (narrow promoted writer extension).

**Also resolved**

- **OP5 — Per-edge `model_vars[]` refresh on query-context change**.
  RESOLVED. Two refresh paths, named distinctly per the
  contexting/engorgement distinction (§3.2a):
  - Per-scenario request graphs are contexted (and engorged) per
    dispatch by Stage 4(a). Fresh slice per call, no staleness
    possible at the BE boundary.
  - The live editor edge re-contexts on `currentDSL` change
    (Stage 4(e)) — re-projects `model_vars[bayesian]`, `p.posterior.*`,
    `p.latency.posterior.*` onto the live edge from the matching
    slice. Promotion re-runs as a downstream consequence, so
    `p.forecast.{mean, stdev, source}` updates and the canvas
    displays stay correct.

  An earlier version of this OP marked it "resolved-by-deferral",
  treating live-edge refresh as out of scope. That was wrong:
  Stage 4(c) removes CF's compensating write of
  `forecast.mean = p_mean`, so without Stage 4(e) the canvas would
  display stale forecast on every currentDSL change. Stage 4(e) is
  in scope; without it, Stage 4(c) is a regression.

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
rule that current-answer fields are not model inputs. The narrow promoted
probability surface (§3.2 — `p.forecast.{mean, stdev, source}`) and its
single writer (`applyPromotion` in
[modelVarsResolution.ts](graph-editor/src/services/modelVarsResolution.ts))
are pinned here. The fallback register in §3.8 is also pinned here: every
fallback/degraded path is either registered with provenance and tests or
removed. Outside-in CLI regressions that compare param-pack, CF, and
cohort-maturity public surfaces are mandatory gates, not optional follow-up.
At least one Stage 0 test must prove that changing scoped
`p.evidence.{n,k}` does not change the resolved source prior when
`model_vars[analytic]` carries a valid source-layer shape.
Stage 4 implements the writer extension; the Stage 4 engorgement step
(§3.2a) carries the Beta-shape and predictive fields on the request graph
rather than on the persistent surface.

Stage 0 receiving handoff receipt (from doc 73a-2, dated 27-Apr-26):

- baseline receipt source: recovered run log `tmp1.log`, stored at
  `graph-editor/lib/tests/fixtures/cf-baseline/regression-baseline.txt`
  and mirrored at
  `graph-editor/src/services/__tests__/__fixtures__/cf-baseline/regression-baseline.txt`;
- baseline counts: collected 1163, passed 1122, skipped 31, failed 10;
- current verification rerun (`pytest`): collected 1247, passed 1198,
  skipped 31, failed 18;
- delta: +84 collected, +76 passed, +0 skipped, +8 failed;
- unchanged failures: all 10 baseline failing tests remain failing;
- resolved baseline failures: none;
- newly failing tests relative to baseline (8 total):
  - `lib/tests/test_multihop_evidence_parity.py::TestMultihopCollapse::test_evidence_x_parity`
  - `lib/tests/test_multihop_evidence_parity.py::TestMultihopCollapse::test_evidence_y_parity`
  - `lib/tests/test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_midpoint_parity_per_tau[single-hop-cohort-wide]`
  - `lib/tests/test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_v2_returns_non_vacuous_data[single-hop-cohort-narrow]`
  - `lib/tests/test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_midpoint_parity_per_tau[multi-hop-cohort-wide]`
  - `lib/tests/test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_midpoint_parity_per_tau[multi-hop-cohort-narrow]`
  - `lib/tests/test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_midpoint_parity_per_tau[single-hop-window]`
  - `lib/tests/test_window_cohort_convergence.py::test_multi_hop_composition[synth-mirror-4step:c-d-e]`

Stage ownership and gate assignment for the 8 new failures:

- `test_multihop_evidence_parity.py::*` and
  `test_window_cohort_convergence.py::test_multi_hop_composition[...]`
  are assigned to Stage 4(d) runner-consumer audit plus Stage 2 resolver
  fallback removal, because they expose model-input collapse between promoted
  source and current-answer evidence families.
- `test_v2_v3_parity_outside_in.py::*` is assigned to Stage 4(d)
  runner-consumer audit and Stage 4(a) contexting/engorgement parity, with
  Stage 2 analytic-source/fallback correction as prerequisite where the
  failures depend on current-answer leakage into source-prior resolution.

Expected-versus-unexpected classification for this receipt:

- unexpected drift in baseline failure identity: none (all 10 baseline reds are
  unchanged);
- new red tests: expected for this handoff, because they come from additional
  parity/convergence suites now collected in the expanded run and they target
  exactly the unresolved Stage 2 / Stage 4 contracts this plan owns.

Stage 1. Complete Work package A. Verify absence of removed BE-topo
surfaces, clean residue (fixtures, docs, CLI noise), and rewrite any FE-only
contract tests that still describe the BE-topo era. Result is a known-clean
baseline for Work package B.

Stage 2. Land the analytic semantic transition (Decision 13). Open
point 8 is RESOLVED as a real behaviour change, not documentation cleanup.
Implement the FE topo analytic source mirror contract in §3.9:

- extend the TypeScript model-vars schema so `model_vars[analytic].probability`
  can carry window-family and cohort-family Beta shape and source mass;
- write window-family `alpha`, `beta`, and source mass from aggregate
  window-family analytic evidence;
- write cohort-family `cohort_alpha`, `cohort_beta`, and source mass from
  aggregate cohort-family analytic evidence when available;
- omit analytic predictive probability fields unless a principled predictive
  model is introduced;
- preserve existing edge-level and path-level analytic latency fields.

Remove the resolver path that treats current-answer evidence
(`p.evidence.{n,k}`) as prior concentration. Make the analytic source resolve
from `model_vars[analytic]` / promoted source-layer fields only. If analytic
has only an aggregate point estimate, use a registered degradation path with
named prior strength and diagnostics, or return no-prior/skipped explicitly.
Rename or remove `alpha_beta_query_scoped` only after the runtime no longer
needs it to compensate for current-answer evidence leakage. This stage may
run in parallel with doc 73a work but is a hard prerequisite for Stage 3.

Stage 2 also reconciles `STATS_SUBSYSTEMS.md` and
`FE_BE_STATS_PARALLELISM.md` so they no longer contradict the implemented
Step 1 / Step 2 split, resolver fallback removal, or analytic window/cohort
source mirror contract.

Stage 3. Remove `manual` from source taxonomy and decouple output overtype
from source-ledger and selector writes (Actions B7a–B7g, B8c, B8d).
Execute the migration policy resolved under open point 1. Commit the
analytic transition shadowed in Stage 2. After Stage 3, `manual` no longer
exists as a source; analytic is safe as a generator-owned aggregate; output
overtype writes only the value plus its `*_overridden` flag. Doc 73a
acceptance gates must pass before Stage 3 begins.

Stage 4. **Slice material moves from persistent to transient; live edge
re-contexts on currentDSL change.** The core defect — `_posteriorSlices`
as a durable in-memory multi-context library on the live graph — is
closed in this stage, alongside the live-edge contexting refresh that
keeps the canvas correct on currentDSL change.

**Stage 4 entry preconditions** — open points to settle before Stage 4:

- Open point 3 (selector pin behaviour when the pinned source becomes
  unavailable). Stage 4(c)'s narrow promoted writer needs the rule
  for "what does `applyPromotion` write when the pinned source is
  not available for this scenario / edge".

(Open point 5 is resolved by Stage 4(e); see §7.)

The five pieces:

(a) **Per-scenario request-graph contexting + engorgement at
analysis-prep.**
[analysisComputePreparationService](graph-editor/src/services/analysisComputePreparationService.ts)
gains a request-graph build step modelled on
[buildConditionedForecastGraphSnapshot](graph-editor/src/lib/conditionedForecastGraphSnapshot.ts)
+ [bayesEngorge.ts](graph-editor/src/lib/bayesEngorge.ts): builds an
in-memory request graph copy, then for each edge:

- **Contexting (i)** — pick the slice from the parameter file matching
  the scenario's effective DSL and project it onto the standard schema
  fields: `model_vars[bayesian]`, `p.posterior.*`, `p.latency.posterior.*`.
  All BE consumers that read Beta-shape (`alpha`, `beta`, `alpha_pred`,
  `beta_pred`, `n_effective`, `cohort_*`, `window_*`) read those from
  the posterior block, so contexting alone is sufficient for them
  (verified by grep against `lib/runner/`).
- **Engorgement (ii)** — write the out-of-schema field
  `_posteriorSlices.fit_history` for the matching slice, used by
  `epistemic_bands.py:148-149` (the only BE consumer that reads
  out-of-schema slice material).

The exact-context match is the only allowed match — no cross-context
fallback at the bayesian-source layer; `resolvePosteriorSlice`'s
context-stripping fallback at
[posteriorSliceResolution.ts:167-171](graph-editor/src/services/posteriorSliceResolution.ts#L167-L171)
is removed at source or guarded against at the seam.

**CLI subtask (binding for Stage 6 parity)**: the same contexting +
engorgement step must be wired into the CLI's analysis-prep code path,
not just the FE TS one. Today the CLI loads graphs through
[`graph-editor/src/cli/aggregate.ts`](graph-editor/src/cli/aggregate.ts) /
[`analyse.ts`](graph-editor/src/cli/commands/analyse.ts) and shares
`analysisComputePreparationService` with the FE; that sharing is the
binding contract — both must call the slice helper with the scenario's
effective DSL before dispatching to the BE. Without this, CLI requests
go out with stale slices and Stage 6's CLI/FE parity gate fails.

(b) **Stop persistent stash writes.** Remove the `_posteriorSlices`
write from
[mappingConfigurations.ts](graph-editor/src/services/updateManager/mappingConfigurations.ts)
Flow G. The Flow F single-context `posterior.*` / `latency.posterior.*`
projection on the live edge stays — it is the props-panel and
BayesPosteriorCard display source for the active edge in the live
editor's current context. Replace `reprojectPosteriorForDsl`'s read
from the persistent stash with a call to the shared slice helper.

(c) **Narrow promoted writer extension and CF de-collapse.**
`applyPromotion` in
[modelVarsResolution.ts](graph-editor/src/services/modelVarsResolution.ts)
extended to populate the three-field `p.forecast.{mean, stdev, source}`
surface (§3.2) from the selected source. The deferral comment at lines
156–158 is removed. CF stops writing `forecast.mean = p_mean` per
[conditionedForecastService.ts:227-239](graph-editor/src/services/conditionedForecastService.ts#L227-L239).
Promotion becomes the only writer of the narrow promoted surface.

(d) **Carrier consumer reads via the shared resolver.** The carrier
read in `_resolve_edge_p` at
[forecast_state.py](graph-editor/lib/runner/forecast_state.py) stops
reading `p.mean` first and instead routes through
`resolve_model_params` in
[model_resolver.py](graph-editor/lib/runner/model_resolver.py), so
the carrier picks the promoted source by the same rule as every
other consumer. The sibling carrier-style `p.mean` reads confirmed
today — [`graph_builder.py:202`](graph-editor/lib/runner/graph_builder.py#L202)
and [`path_runner.py:105`](graph-editor/lib/runner/path_runner.py#L105) —
get the same treatment. Stage 4(d) opens with an audit pass over
`graph-editor/lib/runner/` to confirm that list is exhaustive
(`p.get('mean')` / `p['mean']` reads used as model inputs, not as
current-answer display, all join). See §6.5 for the rule and the
drift-prevention principle. Slice-material readers (the BE consumers
served by the contexting/engorgement in (a)) are not touched here;
they keep their existing read paths.

Stage 4(d)'s audit also covers all registered fallback paths in Python
forecast runners. Any path that reads `p.evidence.{n,k}`, `p.mean`, or other
current-answer fields as model input is either removed or reclassified as a
documented display/current-answer consumer. No silent weak-prior or empirical
fallback may survive this audit without provenance in the response payload or
diagnostics and an outside-in regression.

(e) **Live-edge contexting on `currentDSL` change.** When the user
changes the live current-DSL on the canvas (the
[`useDSLReaggregation`](graph-editor/src/hooks/useDSLReaggregation.ts)
trigger that already exists), re-context the live edge: re-project the
matching slice onto `model_vars[bayesian]`, `p.posterior.*`, and
`p.latency.posterior.*`, using the same shared slice helper as (a) but
with the live edge as the target rather than a request-graph copy.
Promotion re-runs as a downstream consequence (it already runs on
`model_vars` mutation), so the narrow promoted surface
(`p.forecast.{mean, stdev, source}`) updates automatically. Without
this piece, after (c) lands the canvas displays that read the
promoted surface (`'f'` mode chart, ModelRateChart, edge labels)
would go stale on every currentDSL change because today's compensating
CF write of `forecast.mean = p_mean` is removed by (c).

This is contexting only — in-schema field projection on the live edge.
It is not engorgement (no out-of-schema fields are added; the live edge
never crosses a process boundary).

**Share-bundle / share-chart hydration coverage.** The hooks
[`useShareBundleFromUrl.ts`](graph-editor/src/hooks/useShareBundleFromUrl.ts)
and [`useShareChartFromUrl.ts`](graph-editor/src/hooks/useShareChartFromUrl.ts)
restore graph-level `baseDSL` / `currentQueryDSL` from the share
payload but do not themselves re-project edge posteriors. The
re-projection happens later at analysis-prep time via
`reprojectPosteriorForDsl` in
[`analysisComputePreparationService.ts`](graph-editor/src/services/analysisComputePreparationService.ts),
which today reads from the persistent `edge.p._posteriorSlices`
stash. **Once Stage 4(b) removes that stash, share-restore breaks
unless the Stage 4(a) rewiring of `reprojectPosteriorForDsl` to
read from the parameter file via the shared slice helper is in
place.** Coverage is therefore transitive through Stage 4(a) — not
through the hooks themselves. A dedicated regression test
(`shareRestorePosteriorRehydration.test.ts`, see doc 73d) pins
this so the dependency cannot rot silently.

By stage end: the live graph no longer carries the multi-context
`_posteriorSlices` library; the live edge always carries the
single slice matching the current DSL (refreshed by (e) on change);
per-scenario request graphs are contexted to each scenario's effective
DSL with `fit_history` engorged for `epistemic_bands.py`; the narrow
promoted surface is populated and stable; the carrier read no longer
treats `p.mean` as model input; CF and FE display modes are correctly
separated; share-bundle / share-chart restore picks up the right slice
on hydration.

Stage 5. **Lock-respecting writer discipline.** Bring the lock-respecting
writer set into checking `p.mean_overridden` / `p.stdev_overridden`
(and the equivalents on each entry under `conditional_p`) before
writing those two scalars (open point 7). Concrete sites:
`applyBatchLAGValues`
(currently writes `p.mean` from `blendedMean` without checking),
the CF apply path
([conditionedForecastService.ts](graph-editor/src/services/conditionedForecastService.ts)),
the FE quick pass
([statisticalEnhancementService.ts](graph-editor/src/services/statisticalEnhancementService.ts)),
and any runtime cascades. Locked ⇒ skip. Each writer is its own
commit so the sequence is bisectable.

(Action B8c — the lock-respecting writer set definition — is in
Stage 3 as documentation of the rule; the actual implementation lives
here. No code change to `applyBatchLAGValues` lands in Stage 3.)

Stage 6. **Cleanup.** Residual code that survived Stage 4's structural
fix:

- Remove `reprojectPosteriorForDsl` if Stage 4(b) replaced all callers
  with the engorgement helper, and the helpers
  (`projectProbabilityPosterior`, `projectLatencyPosterior`,
  `resolveAsatPosterior`) once no caller remains. The slice-resolution
  helper (`resolvePosteriorSlice`) used by the engorgement stays.
- Remove `_posteriorSlices` cleanup paths in
  [`bayesPriorService.ts`](graph-editor/src/services/bayesPriorService.ts).
- Remove remaining compatibility writes, parity-era diagnostics, dead
  source-selection branches, and stale docs so the codebase cleanly
  represents one FE quick path plus one BE careful path.

Stage 6 entry condition: `grep -rn _posteriorSlices graph-editor/`
returns matches only inside the engorgement helper(s) and tests; no
write site to the live graph remains. Classification table pinned in
this doc.

(Note: this Stage 6 is small because Stage 4 already removed the
load-bearing defect. There is no consumer migration to clean up after.)

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
  orchestration, the request-graph build pattern (rule §3.9 in
  doc 73a — covers both CF dispatch and analysis-prep request graphs;
  this plan's §3.2a refines what those request graphs carry per the
  contexting/engorgement distinction), and CLI/FE prepared-graph
  alignment — owned by doc 73a.
- Source taxonomy, selector mechanics, promoted-layer field set
  (narrow), lock discipline on the live edge, removal of `manual` as a
  source, analytic semantic transition, decoupling of overtype from
  source-ledger writes, **per-scenario request-graph contexting +
  `fit_history` engorgement** (Stage 4(a)), **stop persistent stash
  writes** (Stage 4(b)), **narrow promoted writer + CF de-collapse**
  (Stage 4(c)), **carrier consumer reads via the shared resolver**
  (Stage 4(d)), **live-edge re-contexting on currentDSL change**
  (Stage 4(e) — closes the canvas-display regression that 4(c) would
  otherwise introduce), and the associated cleanup of
  `reprojectPosteriorForDsl` — owned by this plan. The CLI subtask of
  Stage 4(a) (wiring contexting/engorgement into the CLI's
  `analysisComputePreparationService` consumer) is binding for
  doc 73a Stage 6's CLI/FE parity gate.

**Conflicts**:

1. **Stage references in doc 73a → this plan**. Under the current
   structure: per-scenario request-graph contexting + `fit_history`
   engorgement at analysis-prep + stop persistent stash + narrow
   promoted writer + CF de-collapse + carrier consumer read via shared
   resolver + live-edge re-contexting on currentDSL change → Stage 4
   (five pieces: a/b/c/d/e); lock-respecting writer discipline →
   Stage 5; residual cleanup → Stage 6. The slice-material BE readers
   do not migrate (per-scenario contexting supplies their fields
   in-schema); the only consumer change is the carrier read in (d),
   routed through `resolve_model_params` to honour the promotion
   decision. The CLI's analysis-prep code path is a binding subtask
   of (a) — without it, Stage 6's CLI/FE parity gate fails. Any
   surviving `5a`/`5b`/`5c` citation in doc 73a, or any citation of
   "first consumer switch" / "consumer migration" against this plan,
   is a reconciliation defect.
2. **`p_sd → p.stdev` persistence** — RESOLVED (open point 9; CF
   writes `p_sd → p.stdev`; doc 73a §10 reflects).
3. **`applyBatchLAGValues` ownership** — RESOLVED. Doc 73a §5 phasing
   note: "no new opts gate" binds only through 73a's lifetime; this
   plan's Stage 5 may extend the argument surface.
4. **Compositor lock-flag interaction** — RESOLVED. Open point 6:
   composition pastes scalars unconditionally; live-edge
   `*_overridden` preserved as-was. Doc 73a §8 must implement.
5. **Doc 74 stale ownership labels**. Doc 74 §6 lists items as
   "doc 73a owns" that 73a hands back to this plan (FE
   provisional-vs-model split, Python source-order unification).
   Doc 74 must be updated.
6. **Doc 60 Decision 9 / STATS_SUBSYSTEMS §6 on `p.forecast.mean`
   writer** — RESOLVED with option (a): doc 60 Decision 9 retired;
   `p.forecast.*` is promoted-only and written by `applyPromotion`,
   not CF. Doc 60 §3 and §9 WP5 list updated accordingly.
   STATS_SUBSYSTEMS §6 on §11.1's documentation-update list and is
   revised in lockstep with this plan's Stage 4.

Stage 0 test-pinning depends on docs 74, 60, and 73a being
reconciled. Reconciliation edits land in those docs; this plan only
records the deltas.

## Appendix A — Layered contract sketch

**Status**: sketch. Promote into `docs/current/codebase/`
(STATS_SUBSYSTEMS.md or a dedicated layer doc) only after the
73a/73b project lands in the live system; thicken with field lists
pulled from the implemented types at that point.

- **Source ledger** (`p.model_vars[]`, persistent): two entries only —
  `bayesian` (file-backed, single current-context entry on the live
  edge for display; full slice library lives in the parameter file,
  not on the graph) and `analytic` (FE-topo-derived). User authoring
  does not write the ledger.
- **Live-edge contexting** (in-schema, on `currentDSL` change): the
  shared slice helper picks the matching slice from the parameter
  file and re-projects `model_vars[bayesian]`, `p.posterior.*`, and
  `p.latency.posterior.*` on the live edge. No out-of-schema fields
  are written. Promotion re-runs as a downstream consequence and
  refreshes the narrow promoted surface.
- **Per-scenario request graphs** (transient, per-call) — built at
  CF dispatch and analysis-prep, with two operations on each edge of
  the request-graph copy:
  - **Contexting** (in-schema): same slice helper as the live edge,
    applied to each scenario's effective DSL; sets
    `model_vars[bayesian]`, `p.posterior.*`, `p.latency.posterior.*`.
    All Beta-shape and predictive fields BE consumers read
    (`alpha`, `beta`, `alpha_pred`, `beta_pred`, `n_effective`,
    `cohort_*`, `window_*`) reach the BE via this in-schema posterior
    projection.
  - **Engorgement** (out-of-schema, all bayes-related; nothing
    written when active source is analytic): writes `_bayes_evidence`
    (file evidence including cohort daily-row time series — consumed
    by CF for IS-conditioning and by `api_handlers.py:2099` for
    snapshot supplementation), `_bayes_priors` (bayesian prior
    material consumed by CF as the IS prior), and
    `_posteriorSlices.fit_history` (per-`asat` fit history consumed
    by `epistemic_bands.py`). The first two are engorged today by
    `bayesEngorge.ts`; the third is added in Stage 4(a) because
    Stage 4(b) removes the persistent stash that supplies it today.
    DB-snapshot evidence is not engorged — the BE queries the DB
    directly. The graph copy is discarded after the call.
- **Promoted layer** (`p.forecast.{mean, stdev, source}` plus promoted
  latency block, persistent): the narrow display surface for `'f'`
  mode and the FE charts. Written only by `applyPromotion`.
  Quality-gated source selection respecting the selector pin.
- **Evidence layer** (`p.evidence.*`, persistent): raw query-scoped
  k/n.
- **Current-answer layer** (`p.mean`, `p.stdev`,
  `p.latency.completeness`, `p.latency.completeness_stdev`,
  persistent): query-conditioned. FE quick pass writes provisional
  values; CF overwrites authoritatively. Only `p.mean` / `p.stdev`
  carry `*_overridden` locks (per OP7).
- **Display modes**: `'f'` → `p.forecast.mean` (promoted aggregate);
  `'e'` → `p.evidence.mean`; `'f+e'` → `p.mean` (blend).
- **FE quick pass**: produces `model_vars[analytic]`, reads promoted
  layer for forecast contributions, aggregates evidence, writes
  provisional current-answer scalars.
- **CF**: receives a contexted+engorged request graph, IS-conditions
  on query-scoped evidence, writes current-answer scalars only.
- **Carrier consumers** (`forecast_state.py::_resolve_edge_p` and
  any sibling reach/carrier sites): read model inputs only via the
  shared `resolve_model_params` resolver, never `p.mean` directly.
  The shared resolver honours the same promotion decision as
  `applyPromotion`, so reading `p.forecast.{mean, stdev, source}`
  directly and reading `model_vars[]` via the resolver are
  equivalent. Hand-coded source selection in a consumer is a
  regression.
- **Pack contract**: promoted (narrow) + current-answer + evidence +
  `p.posterior.*` (single-context display projection) + `conditional_p`
  + `p.n`. Not in pack: source ledger, selector, `*_overridden`
  flags, slice library. Lock state reconstituted at compose time on
  the live edge.
