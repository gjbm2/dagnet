# 73b — BE Topo Removal and Forecast State Separation Plan

**Date**: 24-Apr-26 (last revised 27-Apr-26)  
**Status**: Active implementation plan  
**Audience**: engineers working on the standard fetch pipeline, model vars, FE topo, conditioned forecast, CLI parity, and graph-state consumers  
**Supersedes**: doc 72 as the active execution plan for graph-surface forecast state  
**Relates to**: `../codebase/STATS_SUBSYSTEMS.md`, `../codebase/FE_BE_STATS_PARALLELISM.md`, `../codebase/PARAMETER_SYSTEM.md`, `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `60-forecast-adaptation-programme.md`, `72-fe-cli-conditioned-forecast-parity-fix-plan.md`, `../cohort-cf-defect-and-cli-fe-parity.md`

## Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [x] Stage 0 — completed 27-Apr-26
- [x] Stage 1 — completed 27-Apr-26
- [x] Stage 2 — completed 27-Apr-26
- [ ] Stage 3
- [ ] Stage 4
- [ ] Stage 5
- [ ] Stage 6

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
system no longer uses that transition plan. The FE topo pass is the fast
fallback writer. BE conditioned forecast is the careful authoritative writer.
The substantive BE-topo removal is already done in code; Work package A
verifies that and removes residue (fixtures, docs, CLI noise).

The deeper defect is field-role ambiguity. The same flat scalar can currently
mean model forecast, query-scoped evidence blend, or conditioned answer,
depending on write order. This plan removes that ambiguity and retires the
redundant BE analytic branch against a single target contract.

A parallel ambiguity exists at the source layer. Today, `manual` appears as a
source-ledger entry that is also auto-coupled to a selector pin and to
per-field locks on outputs. The target model treats user authoring as a
concern of the **selector** (a pin layer above the source ledger that
**influences** which source promotion projects, but is not itself part of
L2 `p.forecast.*`) and of the **current-answer layer** (per-field scalar
locks). Sources are generator-owned only. The canonical layer assignment
is in §3.3.3 and the per-edge layered model (Appendix B / B.2):

- **L1.5 selector** — `model_source_preference` and
  `model_source_preference_overridden`. User-authored. Influences L2
  promotion's choice of source; does not itself carry projected
  scalars.
- **L5 current answer** — `p.mean`, `p.stdev`, `p.stdev_pred`,
  `p.n`, completeness. Only `p.mean` and `p.stdev` are user-overtypable
  and carry `*_overridden` lock flags (per OP7 / §3.3.4); `p.stdev_pred`,
  `p.n`, and completeness are not user-authored at this layer.

Users never write source params (L1) or promoted scalars (L2)
directly; promoted scalars are computed by `applyPromotion` from L1
under L1.5's influence. This removes `manual` from the source
ledger entirely.

### 1.1 Terminology used in this plan

- "FE topo pass" (canonical) is the single FE-side pass, also known in
  earlier wording as "FE quick pass" or "FE quick path". It serves two
  logically distinct roles that share the same traversal but have
  separate inputs and outputs:
  - **FE topo Step 1** — *source-layer writer.* Reads aggregate
    window-family inputs (and cohort-family inputs where path fields
    exist) and writes the `analytic` source entry under
    `model_vars[]`. Output is generator-owned, query-agnostic.
  - **FE topo Step 2** — *current-answer writer.* Reads the promoted
    aggregate source plus the user's scoped evidence and writes
    provisional `p.mean`, `p.stdev`, optional `p.stdev_pred`, and
    completeness fields on the current-answer surface. Output is
    query-scoped.
  Step 1 and Step 2 are two **roles** served by one FE-side code path,
  not two separate processes. The plan does not specify their
  ordering. Implementation is free to fuse them, run them in any
  order, or interleave them within the traversal — as long as both
  contracts are honoured: Step 1's output (`model_vars[analytic]`)
  matches §3.9; Step 2's output (`p.mean`, `p.stdev`, optional
  `p.stdev_pred`, completeness) matches §3.3 and §3.3.4; the two
  outputs are layer-correct (Step 1 writes L1 source-layer state,
  Step 2 writes L5 current-answer state); and Step 2's blend reads
  the promoted source consistently (whatever sequencing or fusing
  yields a stable result). Where this plan refers to "FE topo pass"
  without qualification, it means the pass as a whole; role-specific
  references use "FE topo Step 1" or "FE topo Step 2" explicitly.
- "FE fallback model" means the model-bearing FE source entry (`analytic`)
  produced by FE topo Step 1, not the query-owned provisional answer
  produced by Step 2.
- "Standard fetch pipeline" means the live Stage 2 enrichment pipeline used in
  normal operation. This replaces mixed terms "standard fetch path", "live
  fetch path", and "standard Stage 2 enrichment path".
- "Carrier behaviour" means runtime reach/carrier propagation outcomes,
  including tier selection, reach multiplication, and latency propagation for a
  fixed graph/query input.
- "Scenario-owned enriched graph state" means the per-scenario graph after
  baseline plus scenario composition and enrichment projection, including
  query-owned fields, rather than a stripped param-only representation.
- **`conditional_p` notation.** Two storage forms exist (per 73a §3
  rule 7); the compositor converts between them at the pack boundary:
  - **Live graph form**: an *array* of `{condition: <string>, p: ...}`
    objects. Identity of an entry is the `condition` string; access is
    by walking the array and matching `condition`. Confirmed in code at
    [`graph_types.py:487`](graph-editor/lib/graph_types.py#L487) and
    [`src/types/index.ts:1212`](graph-editor/src/types/index.ts#L1212).
  - **Pack form**: a `Record<conditionString, ProbabilityParam>` keyed
    by the condition string itself. Confirmed in code at
    [`src/types/scenarios.ts:138`](graph-editor/src/types/scenarios.ts#L138).
  
  Throughout this doc, `conditional_p[X]` is **shorthand** for "the
  entry whose condition string is `X`", regardless of which storage
  form is meant. When the storage form matters (e.g. for `*_overridden`
  flag location, or pack-paste mechanics), the prose says so
  explicitly. The condition string is the identity in **both** forms;
  array position is never used as identity.

## 2. Binding decisions (non-negotiable)

**Note on numbering.** Decisions appear in roughly chronological order of
when they were settled, not strictly monotonic ascending order. Decisions
14 and 15 retain their numbers from earlier doc revisions and so appear
out of sequence (Decision 15 between 7 and 8; Decision 14 at the end).
The substantive content is unaffected; readers grepping for a specific
decision will still find it by number.

Decision 1. The FE topo pass stays as a quick, rough, resilient immediate
writer. Step 1 (source-layer) keeps producing `model_vars[analytic]` from
aggregate window/cohort inputs; Step 2 (current-answer) keeps producing
provisional scoped scalars. This plan does not replace either role with
a slower solve.

Decision 2. BE conditioned-forecast pass stays as the careful, authoritative
writer of current query-scoped answer fields.

Decision 3. After delivery, only two query-time statistical writers remain in
the standard fetch pipeline: the FE topo pass and the BE conditioned-forecast
pass. There is no replacement quick BE analytic pass.

Decision 4. Sources are generator-owned. Live source families are exactly two:
`bayesian` (offline-fitted, file-backed, per query context) and `analytic`
(runtime-computed by FE topo from globally aggregated, context-shaped fetched
data — **not** from the user's currently scoped evidence and **not**
date-scoped to the active query's temporal window). Both source families are
**contexted but not date-scoped**: their material is shaped by the slice
context dimensions (channel, case, etc.) but not bound to the active query's
date range. Date-scoping happens at the current-answer layer (L5), never at
the source layer (L1) — see §3.3.3 for the layer-isolation rule. Sources are
not user-editable. There is no `manual` source.

Decision 5. Promotion selects one source per edge per param family by the
existing quality-gated rule (`bayesian` wins if its quality gate passes;
otherwise `analytic`), respecting per-edge user pins when the pinned source
exists. User choice overrides the quality gate: if the user pins `bayesian`
and the bayesian source entry exists, promotion uses bayesian even when the
quality gate would otherwise prefer `analytic`. Source absence is the only
override of user choice: if the pinned source does not exist for that edge /
scenario, promotion falls back to the available source (`analytic` in the
standard no-bayesian-file case) while retaining the pin state. Promotion
materialises the selected source's params into flat promoted fields: the
narrow probability surface `p.forecast.{mean, stdev, source}` (note: `k`
is excluded — runtime-derived population helper with a different writer;
see §6.2 carve-out and §12.2 row S4) and the existing promoted latency
fields. Promotion is the only writer of promoted fields. Promotion never
writes current-answer fields.

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
Several other out-of-schema fields BE consumers do require — `_bayes_evidence`
(file evidence including cohort daily-row time series), `_bayes_priors`
(bayesian prior provenance, ESS hint, latency priors, onset observations),
and `_posteriorSlices.fit_history` (per-`asat` fit history for
`epistemic_bands.py`) — are the legitimate engorgement set. The canonical
list, with consumers, lives in §3.2a (ii); see Decision 15 for why
engorgement is conceptually distinct from contexting. Persistent storage
of the multi-context slice library on the live graph (the
`_posteriorSlices` stash) is retired regardless: under Stage 4(a)
`fit_history` is engorged per call from the parameter file, and
`_bayes_evidence` / `_bayes_priors` continue to be engorged by
`bayesEngorge.ts` as today.

Decision 15 (revised; numbering retained from prior doc references). Two
distinct request-graph operations are required; they are different in kind
and must not be conflated:

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
current-answer scalars (`p.mean`, `p.stdev`, optional `p.stdev_pred`,
completeness) are
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

Decision 14. Doc 73a is a binding prerequisite for Stage 3 onwards.
All §-numbers in this Decision refer to **doc 73a**, not to this
plan; this plan's own §3.9 (FE topo analytic source mirror contract)
is unrelated. Doc 73a owns: pack field membership (73a §8),
`applyComposedParamsToGraph` mechanics, per-scenario CF supersession
(73a §7), the CF response → graph apply mapping (73a §10),
`awaitBackgroundPromises` orchestration (73a §10), the request-graph
engorgement *pattern* (73a §3.9 — note: the per-scenario engorgement
of slice material into the request graph at analysis-prep time is
owned by this plan's Stage 4(a); doc 73a retains only the existing
CF request-snapshot use of the same pattern), and CLI/FE
prepared-graph alignment (73a §12; binding for this plan only after
Stage 4(a) delivers per-scenario engorgement). Stages 0–2 of this plan (test pinning,
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

Selector layer (L1.5): user pin — `model_source_preference` and
`model_source_preference_overridden`. Influences which L1 source L2
promotion projects; carries no projected scalars itself.

Promoted model layer (L2): selected baseline model projection (including
`p.forecast.{mean, stdev, source}` and promoted latency fields) written by
`applyPromotion` only. No user authoring lands at L2.

Current query-scoped layer: active-query answer fields (including `p.mean`,
`p.stdev`, optional `p.stdev_pred`, `p.evidence.*`, and completeness fields)
written by FE topo Step 2 provisionally and CF authoritatively. User
authoring at this layer is the per-field overtype with `*_overridden` lock
companion flag; per OP7 / §3.3.4 only `p.mean` and `p.stdev` are
user-overtypable.

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
`p.stdev`, optional `p.stdev_pred`, completeness) are written by two
combination passes —
FE topo Step 2 (quick blend of aggregate source + scoped evidence)
and CF (careful IS-conditioning of the same inputs). Both passes
take whichever source promotion has selected and treat it uniformly
as an aggregate prior. Both write the same persistent fields with
the same persistence model. CF wins because it runs second and is
more careful, not because it has special persistence status, and
not because the source family changes its behaviour.

`manual` is no longer a source. User authoring lives at the selector
layer (L1.5 pin, see 3.5) and at the current-answer layer (L5 per-field
locks, see 3.3 and 3.5), never in the source ledger.

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
parameters (`alpha`, `beta`, `alpha_pred`, `beta_pred`, `n_effective`)
and the latency posterior block are NOT placed on a persistent promoted
surface; they reach BE consumers as **in-schema contexting** — projected
onto the request graph's `p.posterior.*` and `p.latency.posterior.*`
fields per scenario (§3.2a (i), Decision 15(i)). This is *not*
engorgement, even though it traverses the same code path during
request-graph build. The only out-of-schema material that crosses the
boundary as engorgement (§3.2a (ii), Decision 15(ii)) is `_bayes_evidence`,
`_bayes_priors`, and `_posteriorSlices.fit_history` — fields that have
no place in the normal graph schema. Putting Beta-shape and latency
posterior on a *persistent* promoted surface would either require
keeping the live graph in sync with the parameter file's full slice
library (the current `_posteriorSlices` tumour) or accepting
promoted-surface staleness on every DSL change; the
contexting-per-request-graph model avoids both, with the live edge
holding only the slice for `currentDSL` (refreshed by Stage 4(e)) and
each request graph holding its own scenario-context slice (Stage 4(a)).

Promotion (`applyPromotion` in
[modelVarsResolution.ts](graph-editor/src/services/modelVarsResolution.ts))
is the only **computer** of promoted fields. Promoted fields are
**written** into a graph by exactly two paths:

(a) `applyPromotion` running on the live edge in response to a change
    in `model_vars[]`, the selector pin, or the quality gate;
(b) scenario composition pasting frozen, pre-computed promotion output
    from a param pack onto a graph at compose time.

Path (b) is a rehydration of past promotion output for a frozen
scenario, not a fresh computation. The single-computer rule — and the
invariants in §3.4 / §6.5 about consumer reads — apply uniformly to
both paths.

No other code path may compute or mutate `p.forecast.*` or the
promoted latency block. In particular:

- CF must not write `p.forecast.*` (Stage 4(c) removes the
  current `forecast.mean = p_mean` write at
  `conditionedForecastService.ts:227-239`).
- Batch helpers (notably `applyBatchLAGValues` in
  [`UpdateManager.ts`](graph-editor/src/services/UpdateManager.ts))
  and runtime cascades must write to `model_vars[]` (so promotion runs
  downstream) and never to the promoted block directly. Today
  `applyBatchLAGValues` writes both `targetP.forecast.mean` and the
  promoted latency block (`path_sigma`, `path_onset_delta_days`,
  `path_t95`, completeness, etc.) directly; **Stage 4(c)** migrates
  these promoted writes to land in `model_vars[analytic].probability.*`
  and `model_vars[analytic].latency.*` respectively, so `applyPromotion`
  fans them out. Current-answer writes by `applyBatchLAGValues`
  (`p.mean`, `p.stdev`, `p.evidence.*`, `p.latency.completeness*`)
  remain direct — those are L4/L5, not promoted.
- File load / IDB rehydration is rehydration of stored promotion
  output, not a fresh write.

**Centralisation principle.** The "single computer" rule binds *across
languages*: there is **one promotion computer in TS** (`applyPromotion`
in [`modelVarsResolution.ts`](graph-editor/src/services/modelVarsResolution.ts))
and **one in Python** (`resolve_model_params` in
[`model_resolver.py`](graph-editor/lib/runner/model_resolver.py)).
Both implement the same selection rule (user pin > quality-gated
default; per OP3, source absence falls back to the available source
while retaining the pin) and produce the same promoted output for
the same inputs. Any other consumer needing model-input semantics
must delegate to one of these two functions; hand-coded source
selection in any other site is a regression.

**Cross-language parity testing.** A new contract test must pin TS/Py
parity: for a fixed graph + selector + quality-gate state, the TS
`applyPromotion` and the Python `resolve_model_params` must agree on
which source promotes and what the promoted Beta-shape / latency
parameters are. Test sites: `modelVarsResolution.test.ts` (TS) and
`test_model_resolver.py` (Py); both run a shared fixture matrix with
identical inputs and assert byte-equal promoted output. Stage 4(c)
delivers the test alongside the writer extension. This sits next to
the existing schema-parity tests
(`schemaParityAutomated.test.ts` / `test_schema_parity.py`).

**Trigger discipline.** For the single-computer rule to hold in
practice, every site that mutates a promotion input must trigger
`applyPromotion` downstream. The audit list:

1. `model_vars[analytic]` change (FE topo Step 1 finishes; aggregate
   refresh on fetch).
2. `model_vars[bayesian]` change (live-edge re-context on `currentDSL`
   change, Stage 4(e); bayes patch apply).
3. `model_source_preference` and `model_source_preference_overridden`
   change (user pin set or clear).
4. Quality-gate inputs change (fit-quality metadata on a bayesian
   entry, e.g. ESS/R̂/LOO).

Any mutation of those inputs that does not reach `applyPromotion`
produces silent staleness in the promoted surface and is a regression.

**Today's gap.** `applyPromotion` writes only the latency promoted
block (lines 160–186) with a comment at lines 156–158 deferring
`p.forecast.*` to "the topo pass / pipeline". Stage 4(c) extends
`applyPromotion` to write the three promoted-probability fields and
removes the deferral. Promotion is also responsible for the per-edge
selector default (quality-gated rule), respecting any user pin.

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

**Conditional probabilities are not a special case at this layer.** Each
entry under `conditional_p[X]` carries its own `p` block with the same
shape as the unconditional `p` (posterior, latency posterior, forecast,
evidence, locks — see 73a §3 rule 7). Contexting therefore re-projects
`conditional_p[X].p.posterior.*` and `conditional_p[X].p.latency.posterior.*`
on the same trigger and to the same shape as the unconditional
projection. The condition string `X` is the Record key, not a contexting
parameter; the slice match is still on the scenario's effective DSL.

**(ii) Engorgement** — write onto the request-graph copy any
out-of-schema fields a BE consumer needs that don't fit the normal
graph schema. Engorgement is **presence-conditional**, not
source-promotion-conditional: each field is written when its
corresponding source material exists for the edge, regardless of
which source the selector / quality gate has promoted. CF still
runs uniformly per Decision 13 — it reads its IS prior from
`_bayes_priors` (engorged) when the resolved prior source is
bayesian, and from in-schema `model_vars[analytic]` (per §3.9 /
Stage 2) when the resolved prior source is analytic. Today's
engorged set, all bayes-derived from the parameter file:

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
query in a given scenario.

Minimum surface includes `p.evidence.*`, `p.mean`, `p.stdev`, optional
`p.stdev_pred` when predictive flavour exists, `p.n`,
`p.latency.completeness`, and `p.latency.completeness_stdev`.

`p.n` is the active-query population scalar (effective denominator under the
current DSL). Both writers populate it: FE topo Step 2 from the live data
fetch only; BE CF authoritatively from a broader evidence base (DB snapshot
rows plus engorged file evidence). Sibling helper `p.forecast.k =
p.mean × p.n` is computed by the FE topo inbound-n pass; see §6.2 carve-out.

FE topo Step 2 writes provisional values immediately. CF overwrites the fields
it owns as the careful authoritative solve. Neither writer touches the source
ledger or promoted fields.

#### 3.3.1 Where these fields live across scenarios

Current-answer fields are **scenario-owned**: each scenario holds its own
copy, and edits in one scenario do not propagate to any other. The storage
shape and the lock mechanism differ between Current and the rest:

- **Current** is the only scenario whose state lives on the *live edge*.
  Each user-overtypable scalar on the live edge carries a per-field
  `*_overridden` companion flag (for example `mean` and `mean_overridden`).
  Setting the flag to `true` freezes that scalar from automated rewrite
  by the writers enumerated in Action B8c (FE topo Step 2, CF, runtime
  cascades, and batch helpers such as `applyBatchLAGValues`). Per-field
  lock is a **Current-only** concept.
- **Non-Current scenarios** are held as param packs (per-edge
  post-projection scalar state, no lock metadata). The pack
  representation itself is a **sparse diff** over base — only edges and
  fields that differ from baseline are stored, per the canonical pack
  contract in [73a §8](./73a-scenario-param-pack-and-cf-supersession-plan.md).
  "Pack scalars" throughout this plan means the literal scalar values
  stored for each diffed field. A non-Current scenario is in one of two
  states:
  - *Live*: pack scalars are overwritten on each refresh by FE topo and
    CF running for that scenario's effective DSL. No per-field lock —
    the values are always re-derived.
  - *Static*: pack scalars are frozen and used as-is on compose. The
    whole pack is the lock; no per-field flag is needed because nothing
    automatic recomputes static-scenario state.

The `*_overridden` flag is therefore the Current-side mechanism for
"this scalar is user-authored, do not auto-rewrite"; the *static* scenario
flag is the non-Current-side equivalent at scenario granularity.
Param packs do not carry `*_overridden` flags (§3.6); locked Current
values land in a pack as plain scalars.

#### 3.3.2 Edit semantics across scenarios

Implication of §3.3.1: when the user overtypes a current-answer scalar, the
edit is per-scenario.

- Editing on Current's properties panel writes to the live edge: updates
  the scalar and flips the corresponding `*_overridden` flag. No other
  scenario is touched.
- Editing a non-Current scenario's pack (directly or via that
  scenario's view, when supported) writes to that pack's sparse
  diff for the edited field. Current and other scenarios are
  unaffected. **Per-field state on a non-Current pack is provided by
  the sparse-diff representation itself, not by `*_overridden` lock
  flags** (per §3.3.1, packs carry no lock metadata). The scenario's
  *live* / *static* status (per `meta.isLive` in
  [`graph-editor/src/types/scenarios.ts`](graph-editor/src/types/scenarios.ts))
  determines whether automated regeneration runs at all: live
  scenarios are regenerated on data change by `regenerateScenario`;
  static scenarios are not refreshed and their diffs are frozen by
  construction. Whether a user's edit on a *live* scenario survives
  the next regeneration is governed by the scenario authoring code's
  regeneration policy, not by lock flags or by this plan.

This is the deliberate behaviour. Propagating a Current overtype across
all scenarios would silently invalidate every other scenario's
computation; per-scenario differentiation lets the user tune the answer
they are looking at without committing to a bulk change.

Clearing a lock is sticky: the previously-locked value remains visible
until the next legitimate automated write replaces it. Promotion does
not write current-answer fields and therefore has no `*_overridden`
check at this layer; scenario composition pastes pack state and does
not "write through" a live-edge lock either (per OP6 — composition
preserves the live-edge flag as-was).

#### 3.3.3 Layer-isolation rule (model-input prohibition)

These fields are scoped to the user's current query for their
scenario; they are not aggregate model state. They are also
**date-scoped to the active query's temporal window** (window-mode
DSL or cohort-mode anchor). They must not be read as model-bearing
inputs by later solves. The positive form of this rule is in §3.4
and §6.5: model-input reads go through the shared resolver against
L1 / L1.5 / L2, never against L5.

**Date-scoping invariant** (cross-layer summary):

| Layer | Contexted? | Date-scoped? |
|---|---|---|
| L1 source ledger (`model_vars[bayesian]`, `model_vars[analytic]`) | Yes — context-shaped per slice key | **No** — generator-owned, query-temporally agnostic |
| L1.5 selector | n/a | n/a |
| L2 promoted baseline (`p.forecast.*`, promoted latency) | Yes (inherited from selected L1 source) | **No** (inherited) |
| L3 posterior display (`p.posterior.*`, `p.latency.posterior.*`) | Yes (single context per live edge or per-scenario request-graph copy) | No — slice library, not query-window-bound |
| L4 evidence (`p.evidence.{n,k,mean}`) | Yes | **Yes** — observed counts under the active query |
| L5 current answer (`p.mean`, `p.stdev`, `p.stdev_pred`, `p.n`, completeness) | Yes | **Yes** — answer at the active query |

Reading any L4/L5 field as input to a later solve violates both the
contexting invariant *and* the date-scoping invariant.

#### 3.3.4 Dispersion-flavour accounting

The current-answer dispersion slot at L5 splits into two fields under the
doc 61 convention (bare name = epistemic; `_pred` suffix = predictive),
mirroring the existing latency convention (`mu_sd` / `mu_sd_pred`):

- **`p.stdev`** — always **epistemic**. Posterior SD of the rate from
  Beta(α, β). Both writers can always produce this; FE topo Step 2
  produces it from the promoted source's epistemic α/β plus scoped
  evidence; BE CF produces it as `p_sd_epistemic` from the conditioned
  posterior's α/β.
- **`p.stdev_pred`** — always **predictive**. Posterior SD of the rate
  from Beta(α_pred, β_pred), kappa-inflated. Only present when a
  predictive flavour is available — i.e. the promoted source is
  bayesian and `kappa` was fitted. Absent under analytic source
  (analytic has no overdispersion model — §3.9). Absent when bayesian
  source has no kappa fit.

**Rationale.** Without this split, `p.stdev` carries different
statistical content depending on which writer last ran (Step 2 vs CF)
and which source the selector picked (analytic vs bayesian) — and the
value alone does not tell consumers which they have. Display surfaces
silently mix kappa-inflated predictive widths with raw epistemic
widths. The split makes the choice explicit at every read site and
makes the rule grep-auditable by suffix, exactly as doc 61 did for
latency.

**Asymmetry with the CF response convention.** The CF response
continues to use the doc 49 convention (`p_sd` = predictive,
`p_sd_epistemic` = epistemic), inverted relative to doc 61. The CF
apply mapping (73a §10) translates by name at the boundary:
`p_sd → p.stdev_pred`, `p_sd_epistemic → p.stdev`. The graph is
internally consistent with doc 61; the residual asymmetry stays at the
CF response boundary and is documented in
[STATS_SUBSYSTEMS §3.3](../codebase/STATS_SUBSYSTEMS.md). A future
extension may unify the response-side names; that work is out of
scope for 73b.

**Reader rule.** Display surfaces and any consumer that wants a
predictive band reads `p.stdev_pred` if present, falls back to
`p.stdev` if absent — same fallback pattern as `ResolvedLatency.mu_sd_predictive`
on the latency side. Consumers that explicitly want the epistemic
flavour (posterior card; model-rate mini-chart per doc 61's bands
contract) read `p.stdev` only.

**Consumer table.**

| Consumer | Reads | Flavour | Rationale |
|---|---|---|---|
| `'f+e'` mode chart bands | `p.stdev_pred` → fallback `p.stdev` | Predictive when available | Forecast bands want the kappa-aware width |
| Posterior card | `p.stdev` | Epistemic | Card displays posterior summary, not predictive |
| Model-rate mini-chart | `p.stdev` | Epistemic | Per doc 61 bands contract |
| Edge labels | `p.stdev` | Epistemic | Display of the rate's posterior SD |
| Funnel runner (doc 52) | `p_sd`, `p_sd_epistemic` direct from CF response | Both | Whole-graph CF call; no graph read |
| BE forecast runners | model_vars, not L5 | n/a | §6.5 forbids L5 reads as model input |

**Lock semantics.** Only `p.stdev` carries a `*_overridden` companion
flag (`p.stdev_overridden`, already in the schema). `p.stdev_pred` is
not user-overtypable in the UI and carries no lock flag — there is no
overtype path for the predictive flavour because users author
posterior summaries, not kappa-inflated predictive widths.

**Stale-clearing rule.** When FE topo Step 2 or CF runs and the
currently promoted source has no predictive flavour available
(analytic source; bayesian source without kappa fitted; bayesian
source unavailable for the active scenario), the writer must
explicitly **delete** any pre-existing `p.stdev_pred` on the target.
The "absent" state is achieved by deletion, not by a sentinel value.
The same rule applies under each `conditional_p[X].p` block. This
prevents stale predictive widths from a previously-bayesian source
persisting into an analytic-source context after, e.g., the user
flips the selector pin from `bayesian` to `analytic`, the bayesian
source becomes unavailable for the active query, or a re-fit
removes a previously-fitted kappa. Same discipline applies to any
other "scope-shrinks" event where the resolved source can supply
strictly less than before.

Implementation lands in **Stage 4(f)** (§8). 73a §8 (pack contract)
and 73a §10 (CF apply mapping) carry coordinated edits.

### 3.4 Consumer read rules

Consumers needing baseline model forecast read the promoted model surface.

Consumers needing current query answer read the current query-scoped surface.

Consumers must not infer model state from whichever field was populated first.

`*_overridden` flags are write-side gates only. Reading a current-answer field
is unaffected by its lock state.

### 3.5 User authoring affordances

User authoring has exactly two affordances, both above the source layer.

(a) Selector pin. In the edge properties panel the user can pin which source
promotes for an edge by writing `model_source_preference` to one of the
user-pinnable values {`bayesian`, `analytic`} and setting
`model_source_preference_overridden = true`. The full
`model_source_preference` domain after Stage 3 is
{`best_available`, `bayesian`, `analytic`} per §12.2 row S3 — the
default `best_available` is the unpinned/quality-gated state and is
not a user-pinned value. The pin is edge-global — it persists across
scenarios and is not exposed in the param pack. Clearing the pin
returns the edge to `best_available`.

(b) Output overtype. The user writes a value into a current-answer scalar
through one of two paths, each affecting one scenario only (per §3.3.1 /
§3.3.2). **Known limitation (deferred):** an overtype on `p.mean` updates
the edge's own local display surfaces (own-edge `'f+e'` chart, label,
stroke width) but does **not** propagate to downstream carriers (node
arrival probabilities, path / reach analyses, conversion funnel,
cohort-maturity v3 per-tau curves, posterior bands). See §7 stub
"Known limitation deferred to future workstream" and the full charter
in [`docs/current/project-what-if/01-rate-overtype-and-carrier-propagation.md`](../project-what-if/01-rate-overtype-and-carrier-propagation.md).

  - **Edit on Current** (edge properties panel while viewing Current).
    The new value lands on the live edge; the corresponding `*_overridden`
    flag flips to `true`. Per-field lock now blocks automated rewrites of
    that scalar (FE topo Step 2, CF, runtime cascades, batch helpers).
    No other scenario is touched.
  - **Edit on a non-Current scenario** (that scenario's view, or its
    param pack edited directly). The new value lands in that scenario's
    pack scalar. There is no `*_overridden` flag — packs do not carry one.
    Whether subsequent automated writers can overwrite the pack is
    determined by the scenario's *live*-vs-*static* state (§3.3.1).
    Current is unaffected.

Param packs do not carry `*_overridden` flags — pack values are
unconditional pasted scalars. The two authoring paths produce equivalent
*visible* state for the scenario being authored but they target different
storage and use different lock mechanisms; they do not produce equivalent
state across scenarios.

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
  `p.stdev_pred` (Stage 4(f) — predictive flavour, present only when
  the source supplies one — see §3.3.4), `p.evidence.*`, completeness
  fields, and the additional fields enumerated in doc 73a such as
  `p.posterior.*`, `conditional_p`, `p.n`). 73a §8 carries the
  authoritative pack-field list; Stage 4(f) extends it with
  `p.stdev_pred`.
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
`analytic` onto promoted fields; the FE topo pass and CF run as normal.

Bayes-dependent operations (e.g. running the Bayes compiler) fail explicitly
when files they require are absent. They are not in scope for this fallback;
only the standard rendering pipeline must continue to work.

### 3.8 Fallback and degradation register

Fallbacks are not allowed to be implicit. Any fallback or degraded path
inside the standard fetch pipeline, resolver, CF runtime, scenario transport,
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
4. ~~Context-stripping posterior-slice fallback.~~ **Withdrawn.** This
   register entry incorrectly classified the existing slice-resolution
   stack's bare-mode aggregate fallback as a defect. The stack
   ([`resolvePosteriorSlice`](graph-editor/src/services/posteriorSliceResolution.ts),
   [`meceSliceService`](graph-editor/src/services/meceSliceService.ts),
   [`dimensionalReductionService`](graph-editor/src/services/dimensionalReductionService.ts))
   implements the FE/BE slice-resolution contract that's already live
   and correct. 73b uses it unchanged at both call sites (live-edge
   re-context per Stage 4(e); per-scenario request-graph build per
   Stage 4(a)). 73b does not relegislate slice-match semantics. Entry
   retained as a withdrawal marker so a future reader does not
   re-introduce the relegislation.
5. Scenario param-only analysis transport. Status: invalid for analysis
   execution. Param packs are export/edit artefacts, not a lossless carrier
   for scenario-owned enriched graph state. **Stage 4(a)** delivers the
   lossless per-scenario request-graph build (contexting + engorgement on
   a graph copy). **Doc 73a Stage 6** owns the CLI/FE parity gate that
   verifies the build is lossless across both consumers (FE TS and CLI).
   73b's own Stage 6 (Cleanup) does not own this register entry.
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
standard fetch pipeline now runs the FE topo pass plus CF only. Residual
fixtures and doc references to the BE-topo era are addressed by Work
package A. No live mismatch remains here.

Mismatch 2. `analytic` currently behaves as already-query-scoped (see
`graph-editor/lib/runner/model_resolver.py:107-108`,
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
mismatch is twofold: (i) downstream model consumers in **Python** read
`p.mean` as a model-bearing input, conflating current-answer with promoted
forecast (TS reads of `p.mean` are display-side or integrity-check, not
model-input — verified by grep at audit time); (ii) FE quick's model-bearing forecast estimate is not separately
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

Mismatch 5a. `applyBatchLAGValues` has two outstanding defects today
(`graph-editor/src/services/UpdateManager.ts`).

**(i) Direct writes to promoted fields** — bypassing `applyPromotion`.
The function writes `targetP.forecast.mean = update.forecast.mean`
(around line 2208) and the promoted latency block
(`targetP.latency.path_sigma`, `path_onset_delta_days`, `path_t95`,
completeness, etc.) directly. This violates §3.2's single-computer
rule for promoted fields. Stage 4(c) migrates these writes to land
in `model_vars[analytic].probability.*` and `model_vars[analytic].latency.*`
respectively; `applyPromotion` then fans them out to the promoted
surface. Current-answer writes by the function (`p.mean`,
`p.stdev`, `p.evidence.*`, `p.latency.completeness*`) remain direct —
those are L4 / L5, not promoted.

**(ii) Asymmetric lock check.** The primary blendedMean write path
(around line 2254-2257) writes `p.mean` from `blendedMean` without
checking `mean_overridden`, so a user-locked `p.mean` can still be
overwritten on that path. The evidence-mean fallback path (around
line 2264) does check `targetP.mean_overridden !== true` before
writing. The two paths must be brought into a consistent lock
discipline; Action B8c (Stage 5) gates both paths on `*_overridden`
so the function as a whole respects the lock regardless of which
branch fires.

(i) and (ii) are independent; Stage 4(c) closes (i), Stage 5 closes
(ii). The function's writing role itself is fine — what it writes,
and whether it respects locks, are the two things changing.

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
`graph-editor/src/services/fetchDataService.ts` runs only the FE topo pass
plus CF; the `/api/lag/topo-pass` endpoint and `analyse --topo-pass` are gone or
are deprecated no-ops; `analytic_be` no longer appears in live code paths and
survives only in test fixtures.

Work package A is therefore reduced to verification and residue cleanup. It
is delivered as Stage 1 (§8), as hygiene/verification work that runs ahead
of Work package B rather than as substantive contract change.

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

Action B1. Implement the analytic source mirror contract in §3.9. This means
extending the analytic model-var shape to carry aggregate window-family and,
when available, cohort-family probability Beta shape plus source mass;
preserving the existing analytic latency split; omitting predictive probability
fields unless a principled predictive model is introduced; and teaching the
Python resolver to consume only source-layer analytic shape or an explicitly
registered degradation path. The Stage 2 gate is that changing scoped
`p.evidence.{n,k}` cannot alter the resolved analytic prior when a valid
`model_vars[analytic]` source-layer shape exists.

### 6.2 Give probability a (narrow) promoted model surface

Promotion projects the winning probability source onto the three-field
`p.forecast.{mean, stdev, source}` surface (§3.2). Owner: `applyPromotion`
in `modelVarsResolution.ts`.

- `modelVarsResolution.ts:156-158` — replace the latency-only avoidance
  with positive promotion of the three `p.forecast.*` fields.
- `conditionedForecastService.ts:227-239` — stop writing
  `forecast.mean = p_mean` (the `f` vs `f+e` collapse).

**Carve-out — `p.forecast.k` is not promoted.** `ForecastParams` also
carries `k` (`= p.mean × p.n`), the expected-converters scalar used
by inbound-n propagation. `k` is a runtime-derived population helper,
not part of the promoted surface: it is written by the FE topo
inbound-n pass (`statisticalEnhancementService.ts` around line 3787)
and read by `graph_builder.py:302`. **Promotion does not write `k`**.
The "three-field" framing throughout this plan (§3.2, §6.2, §6.5,
Appendix A) excludes `k` deliberately; `k` survives on the same
struct because it shares the `p.forecast` namespace, but has a
different writer and lifecycle. See §12.2 row S4 for the field-set
partition.

Action B2. Preserve the no-bayesian-file path from §3.7 as an explicit
Work-package B gate. When bayesian source files are unavailable, selector
defaulting must fall to `analytic`, FE topo Step 1 must supply the analytic
source entry, promotion must populate the narrow promoted surface from that
source, and the FE topo Step 2 / CF current-answer writers must still populate
their normal fields. Any analytic-source weakness is handled only through the
fallback register in §3.8, with diagnostics and tests.

**Slice-material BE readers are not migrated.** Consumers that read
`p.posterior.{α, β, alpha_pred, beta_pred, n_effective, ...}`,
`p.latency.posterior.*`, or `p.model_vars[bayesian]` (e.g. predictive
maturity inputs in `cohort_forecast_v3.py`; latency joint draws in
`forecast_state.py`; Beta-shape in `model_resolver.py`) keep their
existing reads. What changes is *where* those values come from: from
the per-scenario contexted request graph (Stage 4(a) (i)) and the
re-contexted live edge (Stage 4(e)) instead of from the persistent
`_posteriorSlices` stash, which is removed in Stage 4(b). Consumer
code is unchanged for this class of reader.

Other classes of BE consumer **do** migrate as part of 73b. The full
classification is:

| Consumer class | Migration in 73b? | Owning stage |
|---|---|---|
| Slice-material readers (above) | No | n/a |
| Engorgement readers (`_bayes_evidence`, `_bayes_priors`, `fit_history`) | No | n/a |
| Quality-gate readers in `model_resolver.py` | No | n/a |
| **Carrier consumers reading L5 as model input** (`forecast_state.py::_resolve_edge_p`, `graph_builder.py:202`, `path_runner.py:105`) | **Yes** | Stage 4(d) — route via `resolve_model_params` |
| **Analytic-source resolver** (`model_resolver.py` D20 shortcut at lines 392-417) | **Yes** | Stage 2 — D20 removed; reads analytic α/β from `model_vars[analytic]` source layer |
| **CF apply path on FE** (`applyConditionedForecastToGraph`) | **Yes** | Stage 4(c) — drop `p_mean → p.forecast.mean`; Stage 4(f) — dispersion split (73a §10 co-edit) |

So 73b *does* change three named consumer classes; it leaves the other
three unchanged. The "broad" claim that BE consumers are unchanged
applies **only** to slice-material readers and is not a global
statement. Stage 4(d), Stage 2, and Stage 4(c)/(f) carry the actual
consumer-migration work.

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

### 6.3 Keep the FE topo pass as the immediate query-owned projector

FE topo Step 2 may keep computing and writing approximate `p.mean` and
completeness immediately.

Required change is input ownership: Step 2 must consume promoted
baseline model state as forecast input and scoped evidence as evidence input.
It must not rewrite the model ledger or the promoted forecast slot with a
query-owned answer.

Primary surfaces:
`graph-editor/src/services/statisticalEnhancementService.ts`,
`graph-editor/src/services/fetchDataService.ts`,
`graph-editor/src/services/UpdateManager.ts`.

FE topo Step 1 may still refresh the `analytic` source entry, but that
remains a model-layer update. The immediate blended answer (Step 2) remains
a current-answer-layer write.

### 6.4 Keep CF as careful authoritative current-answer writer

CF remains authoritative writer of current query-scoped answer.

`graph-editor/src/services/conditionedForecastService.ts` should continue
projecting CF-owned fields such as `p.mean`, `p.stdev_pred`, `p.stdev`, and
CF-owned completeness fields, while stopping overwrite of promoted baseline
forecast slot. Per §3.3.4 / Stage 4(f), the response-name translation is
`p_sd → p.stdev_pred` (predictive) and `p_sd_epistemic → p.stdev`
(epistemic).

Current "already query-scoped posterior" degraded rule remains valid migration
guard. End state removes query-scoped sources from promoted model layer rather
than relying on permanent ambiguity. Any future genuinely query-scoped source
must be explicit and non-default.

### 6.5 Make runtime and graph consumers obey layer split

BE runtime and graph consumers must not read current-answer fields
(`p.mean`, `p.stdev`, `p.stdev_pred`, completeness fields) as
model-bearing input.
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
open point 7 resolution). **These flags live only on the live
edge**, never on a param pack: per §3.5 / §3.6 / §3.3.1, packs
carry no `*_overridden` lock metadata. On the live edge,
`conditional_p` is the array form (per 73a §3 rule 7 and the
`conditional_p` notation note in §1.1); the flags live on each
array entry's `p` block — i.e. on the `p` of the entry whose
`condition` string matches. Identity is by condition string in
both storage forms; array position is never an identity. Both
flags already exist in the schema; no additions. **`p.stdev_pred`
carries no lock flag** — per §3.3.4 it is not user-overtypable in
the UI (users author posterior summaries, not kappa-inflated
predictive widths), so no `*_overridden` companion is added for it.

Action B8b. The `AutomatableField` wrapper component remains the canonical UI
for these locks. Lock-clear UX writes `*_overridden: false` only and leaves
the previous value visible (sticky on unlock). Next legitimate automated
write may overwrite that value.

Action B8c (rule definition; implementation lands in Stage 5). The
lock-respecting writer set is FE topo Step 2, CF, runtime cascades, and
`applyBatchLAGValues` (currently writes `p.mean` from
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
- **OP3 — Selector pin when pinned source becomes unavailable**. User
  choice wins over quality gates but not over source absence. If
  `model_source_preference_overridden = true` and the pinned source exists,
  promotion uses that source even if its quality metadata would fail the
  default gate. If the pinned source is absent (for example bayesian vars
  do not exist for that edge / scenario), promotion falls back to the
  available source, normally `analytic`, while retaining the pin so the UI
  can show "pinned but currently inactive". The implementation must not
  auto-clear the pin merely because the source is temporarily unavailable.
- **OP4 — Quality-gate volatility**. Default behaviour is silent
  flip-with-gate; revisit only if instability becomes user-visible.
- **OP5 — Per-edge `model_vars[]` refresh on query-context change**.
  Two refresh paths, named distinctly per the contexting/engorgement
  distinction (§3.2a):
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
- **OP8 — Analytic semantic transition (Decision 13)**. Resolved as a
  real behaviour change, not documentation cleanup. Stage 2 implements
  the aggregate analytic source contract in §3.9, removes or quarantines
  resolver paths that synthesise analytic prior mass from current-answer
  `p.evidence.{n,k}`, and deletes the permanent need for
  `alpha_beta_query_scoped` / `analytic_degraded` as compensating modes
  once analytic source priors are genuinely source-layer values. CF then
  conditions analytic and bayesian through the same aggregate-prior path;
  any missing analytic shape is handled only by a registered degradation
  path or explicit no-prior/skipped diagnostic.
- **OP9 — CF dispersion projection**. Superseded by the §3.3.4 /
  Stage 4(f) L5 dispersion split. The graph follows doc 61 naming:
  bare `p.stdev` is epistemic and `_pred` is predictive. The CF
  response still follows doc 49 naming at the boundary, so apply logic
  translates `p_sd → p.stdev_pred` (predictive) and
  `p_sd_epistemic → p.stdev` (epistemic). Promoted carries
  `p.forecast.stdev` separately; neither L5 dispersion field is a
  promoted model slot.

**Open** (must be settled before the named stage)

None.

**Stabilised fast-follow requirement (present but switched off)**

- **WP8 interaction (doc 60 open item)**. Doc 60 WP8 is the live
  narrow direct-`cohort()`-for-`p` rate-conditioning path. It is a real
  product/statistical requirement and a fast-follow item after this
  project, but it is not implemented by the 73b workstream and it is not
  a blocker for Stage 2 or Stage 3. This project's job is to stop analytic
  source resolution reading current-answer evidence as hidden prior mass;
  it does not also deliver WP8's direct-`cohort()` conditioning path.

  WP8 previously depended on `ResolvedModelParams.alpha_beta_query_scoped`
  to avoid double-counting when analytic behaved like query-scoped
  posterior state. Under Decision 13 that compensating discriminator is
  not a stable contract. When WP8 is resumed, it must either use the
  repaired aggregate analytic source contract without double-counting,
  or define a replacement source-layer discriminator that does not read
  current-answer evidence.

  73b stabilises WP8 as **present but switched off**:

  - if a WP8 feature flag or dormant dispatch path exists, keep it
    available but default it to **false/off** in app, CLI, tests, and
    regression harnesses;
  - do not delete WP8 entry points merely because this project does not
    implement the path, but do not route standard 73b runs through them;
  - any test that enables WP8 must be explicitly labelled as WP8-only and
    must not be part of the Stage 0–6 acceptance gates;
  - ordinary 73b regressions prove the factorised `window()` forecasting
    logic, source-layer analytic shape, and resolver behaviour with WP8
    disabled, so the not-yet-ratified direct-`cohort()` path cannot
    confound the baseline.

  WP8 fast-follow begins only after the 73b acceptance gates for the basic
  factorised `window()` path are green. The fast-follow must re-ratify its
  discriminator against the post-73b aggregate-source contract before it is
  enabled by default.

  Current known status before 73b implementation: doc 60 specifies WP8 as
  a flagged follow-on, but the live runtime does not yet expose a working
  direct-cohort feature switch. `build_prepared_runtime_bundle` accepts
  `p_conditioning_direct_cohort` and immediately discards it; diagnostics
  tests assert that `direct_cohort_enabled` is absent; at the same time,
  existing runtime-bundle plumbing can still carry
  `p_conditioning_temporal_family = 'cohort'` and `forecast_state.py`
  applies rate conditioning whenever `alpha_beta_query_scoped` is false.
  Stage 0 therefore has an explicit stabilisation gate: audit the current
  WP8-adjacent plumbing, and if any standard app / CLI / regression path can
  route through direct `cohort()` rate conditioning, clamp it behind an
  explicit default-false switch or equivalent guard before Stage 2 begins.
  This is not WP8 implementation; it is test-surface stabilisation.

**Known limitation deferred to future workstream: rate overtype does not
propagate to carriers**

After Stage 4(d), carrier consumers read model-bearing inputs
exclusively via `resolve_model_params`; they do not read `p.mean`. A
user overtype on `p.mean` therefore updates only the edge's own local
display surfaces (`'f+e'` chart, label, stroke width); it does NOT
propagate to downstream node arrivals, path / reach analyses, conversion
funnel, cohort-maturity v3 per-tau curves, or posterior bands. This is
a UX regression vs today's behaviour. The bright-line rule
(`*_overridden` purely write-side; no consumer branches on it) prevents
fixing it within 73b.

**Owner**: deferred fast-follow alongside doc 60 WP8. The full
problem statement, broad resolution direction (reintroduce `manual`
source as a model-vars snapshot), connection to the broader "what-if"
redesign, and open questions live in:

→ [`docs/current/project-what-if/01-rate-overtype-and-carrier-propagation.md`](../project-what-if/01-rate-overtype-and-carrier-propagation.md)

Neither WP8 nor the rate-overtype workstream blocks 73b acceptance.

**Mitigation in 73b scope.** Users wanting "what if this edge converted
at rate X" should use the **scenarios** mechanism (pack-based override
composes onto a graph copy via `applyComposedParamsToGraph` and
propagates through carriers). Hand-editing `p.mean` on the live edge is
reserved for "I'm overtyping the displayed answer". A UX badge / help-text
update flagging the limitation on edges with `mean_overridden = true` is
listed as out-of-scope for 73b but worth shipping ahead of the full
fast-follow design — see the project-what-if doc for detail.

## 8. Delivery stages and execution order

This workstream lands in seven stages. Stages are sequential **within
73b** and each stage closes a concrete boundary before the next stage
starts. (73b stages 0–2 may proceed in parallel with **doc 73a work**
per Decision 14; this is parallelism *across docs*, not parallelism
within 73b's own stage order.)

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
Stage 4 implements the writer extension; the Stage 4 contexting step
(§3.2a (i)) carries the Beta-shape and predictive fields on the request
graph via `p.posterior.*` / `p.latency.posterior.*` projection rather than
on the persistent surface. Engorgement (§3.2a (ii)) carries the
out-of-schema fields BE consumers also need (`_bayes_evidence`,
`_bayes_priors`, `_posteriorSlices.fit_history`).

Stage 0 also stabilises WP8 as present-but-off. The audit covers current
WP8-adjacent code paths (`p_conditioning_direct_cohort`,
`p_conditioning_temporal_family`, runtime-bundle diagnostics, and the
`forecast_state.py` rate-conditioning gate). If any standard app, CLI, or
regression path can admit direct `cohort()` rate conditioning, Stage 0 adds
or verifies a default-false guard so ordinary 73b runs report the
non-WP8/default evidence path and cannot exercise WP8 accidentally. Any test
that enables the guard is labelled WP8-only and is outside the Stage 0–6
acceptance gates.

**Stage 0 WP8 regression test (binding deliverable).** Stage 0 must
land an automated test that exercises a representative
analytic-source graph in the post-Stage-2 state (i.e. with
`alpha_beta_query_scoped = False` for analytic edges, mocked or
forced) and asserts:

- the standard CF / forecast pipeline does not invoke the
  direct-`cohort()` rate-conditioning path;
- any WP8 dispatch flag (`p_conditioning_direct_cohort` or its
  successor) remains default-false in the runtime bundle;
- `direct_cohort_enabled` (or the equivalent diagnostic) reports
  absent / off in the response.

Test name: `wp8DefaultOff.test.py` (or equivalent under
`graph-editor/lib/tests/`). The test must be green before Stage 2
begins (see Stage 2 entry condition).

Stage 0 receiving handoff receipt (from doc 73a-2, dated 27-Apr-26). This
receipt is baseline evidence for the Stage 0 gates, not additional
implementation scope:

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

Stage 2. Land the analytic semantic transition (Decision 13).

**Stage 2 entry condition (binding).** Stage 2 may not begin until
Stage 0's WP8 default-off regression test (`wp8DefaultOff.test.py`)
is green. Stage 2's resolver changes make
`alpha_beta_query_scoped = False` uniform for analytic edges, removing
today's implicit suppression of the WP8 path; without the verified
clamp from Stage 0, ordinary Stage-2-onwards runs could silently
exercise WP8 and corrupt the acceptance baseline.

Open point 8 is RESOLVED as a real behaviour change, not documentation
cleanup. Implement the FE topo analytic source mirror contract in §3.9:

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
from source-ledger and selector writes (Actions B7a–B7g, B8d, plus the
B8c rule definition). The B8c writer changes themselves land in Stage 5.
Execute the migration policy resolved under open point 1. Commit the
analytic transition shadowed in Stage 2. After Stage 3, `manual` no longer
exists as a source; analytic is safe as a generator-owned aggregate; output
overtype writes only the value plus its `*_overridden` flag. Doc 73a
acceptance gates must pass before Stage 3 begins.

Stage 4. **Slice material moves from persistent to transient; live edge
re-contexts on currentDSL change; L5 dispersion is split by flavour.** The
core defect — `_posteriorSlices` as a durable in-memory multi-context
library on the live graph — is closed in this stage, alongside the live-edge
contexting refresh that keeps the canvas correct on currentDSL change and
the `p.stdev` / `p.stdev_pred` split that makes current-answer dispersion
flavour explicit.

**Stage 4 entry preconditions.** OP3 is resolved in §7: user choice wins
over quality gates when the pinned source exists; source absence falls back
to the available source while retaining the pin state. Stage 4(c)'s narrow
promoted writer implements that rule when `applyPromotion` writes
`p.forecast.{mean, stdev, source}`.

(Open point 5 is resolved by Stage 4(e); see §7.)

**Stage 4 internal order.** These pieces are one stage, but their dependency
order is constrained:

1. Land 4(a)'s request-graph contexting/engorgement helper and wire both FE
   and CLI analysis-prep callers.
2. Land 4(b)'s persistent-stash removal only after 4(a) can read slices from
   the parameter file; otherwise analysis-prep and share-restore lose their
   slice source.
3. Land 4(e)'s live-edge `currentDSL` re-contexting with or before 4(c), so
   removing CF's compensating `forecast.mean = p_mean` write cannot stale the
   canvas promoted forecast.
4. Land 4(c)'s promoted writer extension and 4(d)'s carrier-consumer resolver
   switch as one bisectable group: 4(c) creates the promoted probability
   surface and 4(d) makes model-input consumers honour it.
5. Land 4(f)'s L5 dispersion split only with the coordinated 73a §8/§10
   mapping updates: `p_sd → p.stdev_pred`, `p_sd_epistemic → p.stdev`, and
   `p.stdev_pred` added to the pack contract. This can land after 4(c)/(d),
   but must not land without the CF apply mapping and pack round-trip tests.

The six pieces:

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

Slice-resolution semantics — including any fallback or aggregation —
are inherited from the existing slice-resolution stack
([`resolvePosteriorSlice`](graph-editor/src/services/posteriorSliceResolution.ts),
[`meceSliceService`](graph-editor/src/services/meceSliceService.ts),
[`dimensionalReductionService`](graph-editor/src/services/dimensionalReductionService.ts))
unchanged. Stage 4(a) calls those functions; it does not relegislate
their match rules. The same applies to Stage 4(e) on the live edge.

**CLI subtask (binding for doc 73a Stage 6 parity)**: the same
contexting + engorgement step must be wired into the CLI's analysis-prep
code path, not just the FE TS one. Today the CLI loads graphs through
[`graph-editor/src/cli/aggregate.ts`](graph-editor/src/cli/aggregate.ts) /
[`analyse.ts`](graph-editor/src/cli/commands/analyse.ts) and shares
`analysisComputePreparationService` with the FE; that sharing is the
binding contract — both must call the slice helper with the scenario's
effective DSL before dispatching to the BE. Without this, CLI requests
go out with stale slices and **doc 73a Stage 6's CLI/FE parity gate**
fails. (73b's own Stage 6 is Cleanup and defines no CLI/FE parity gate
— see §11.2 for the cross-doc ownership.)

(b) **Stop persistent stash writes.** Remove the `_posteriorSlices`
write from
[mappingConfigurations.ts](graph-editor/src/services/updateManager/mappingConfigurations.ts)
Flow G. The Flow F single-context `posterior.*` / `latency.posterior.*`
projection on the live edge stays — it is the props-panel and
BayesPosteriorCard display source for the active edge in the live
editor's current context. Replace `reprojectPosteriorForDsl`'s read
from the persistent stash with a call to the shared slice helper.

(c) **Narrow promoted writer extension, CF de-collapse, and
batch-helper migration.**
`applyPromotion` in
[modelVarsResolution.ts](graph-editor/src/services/modelVarsResolution.ts)
extended to populate the three-field `p.forecast.{mean, stdev, source}`
surface (§3.2) from the selected source. The deferral comment at lines
156–158 is removed. CF stops writing `forecast.mean = p_mean` per
[conditionedForecastService.ts:227-239](graph-editor/src/services/conditionedForecastService.ts#L227-L239).
`applyBatchLAGValues` in
[UpdateManager.ts](graph-editor/src/services/UpdateManager.ts) is
migrated per Mismatch 5a (i): its direct writes of `targetP.forecast.mean`
and the promoted latency block (`path_sigma`, `path_onset_delta_days`,
`path_t95`, completeness, etc.) are redirected to land in
`model_vars[analytic].probability.*` and `model_vars[analytic].latency.*`,
so `applyPromotion` fans them out. Current-answer writes by the function
(`p.mean`, `p.stdev`, `p.evidence.*`, `p.latency.completeness*`) stay
direct. After this stage, `applyPromotion` is the only writer of the
promoted surface; CF, batch helpers, and runtime cascades all delegate
through `model_vars[]` per the centralisation principle in §3.2.

**TS/Py promotion-parity contract test** lands in this stage (per §3.2
Centralisation principle). A shared fixture matrix exercises
`applyPromotion` (TS) and `resolve_model_params` (Py) on identical
inputs (graph, selector, quality-gate state) and asserts byte-equal
promoted output.

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
unless the Stage 4(b) rewiring of `reprojectPosteriorForDsl` to
read from the parameter file via the shared slice helper is in
place.** (Both the stash removal and the function rewiring are
within Stage 4(b) per §8.) Coverage is therefore transitive through
Stage 4(b) — not through the hooks themselves. A dedicated regression test
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

(f) **L5 dispersion split.** Apply doc 61's bare-name = epistemic,
`_pred` = predictive convention to the L5 current-answer dispersion
slot, mirroring the existing latency convention. After this step,
`p.stdev` is always epistemic and `p.stdev_pred` is always predictive
(when a predictive flavour is available — only the bayesian source
with kappa fitted produces it).

The defect this closes is that `p.stdev` today carries different
statistical content depending on which writer last ran (FE topo
Step 2 vs BE CF) and which source the selector picked (analytic vs
bayesian); display surfaces silently mix kappa-inflated predictive
widths with raw epistemic widths. The split makes the choice
explicit at every read site and grep-auditable by suffix.

Audit and update workscope:

- **Writers** must split: FE topo Step 2
  ([statisticalEnhancementService.ts](graph-editor/src/services/statisticalEnhancementService.ts))
  always writes the epistemic blend into `p.stdev`, and writes
  `p.stdev_pred` only when the promoted source carries
  `α_pred / β_pred`; CF apply path
  ([conditionedForecastService.ts](graph-editor/src/services/conditionedForecastService.ts))
  changes `p_sd → p.stdev_pred` and adds `p_sd_epistemic → p.stdev`;
  batch helpers (`applyBatchLAGValues` in
  [UpdateManager.ts](graph-editor/src/services/UpdateManager.ts))
  and bayes patch projection
  ([bayesPatchService.ts](graph-editor/src/services/bayesPatchService.ts))
  are audited to ensure they either split correctly or only touch
  `p.stdev` (epistemic). Mapping configurations Flow F
  ([mappingConfigurations.ts](graph-editor/src/services/updateManager/mappingConfigurations.ts))
  is audited for any direct `p.stdev` write.
- **Readers** adopt the predictive-preferred fallback pattern (read
  `p.stdev_pred` if present, else `p.stdev`) at: `'f+e'` mode chart
  bands and any forecast-band consumer. Epistemic-only readers
  (posterior card; model-rate mini-chart per doc 61's bands contract;
  edge labels) read `p.stdev` only.
- **BE consumers** are confirmed not to read L5 (per §6.5); any
  surviving `p.stdev` read in `graph-editor/lib/runner/` is
  reclassified as a display-only consumer or removed.
- **Pack contract**: 73a §8 pack-field list extends to include
  `p.stdev_pred`. `GraphParamExtractor.ts` and
  `applyComposedParamsToGraph` carry it through.
- **CF apply mapping**: 73a §10 changes two rows in lockstep with
  this stage — `p_sd → p.stdev_pred` (was `p_sd → p.stdev`);
  `p_sd_epistemic → p.stdev` (was response-only, not persisted).
  These are coordinated edits, not independent.
- **Locks (Action B8c)**: `p.stdev_pred` carries no `*_overridden`
  flag; not user-overtypable in the UI. `p.stdev` retains its
  existing `stdev_overridden` flag.
- **Tests**: 73a §10 sentinel test (`cfFieldMappingSentinel.test.ts`)
  updated for the new mapping rows. New contract tests assert: FE
  topo Step 2 with analytic source writes `p.stdev` and leaves
  `p.stdev_pred` absent; with bayesian source + kappa fitted both
  are written and `p.stdev_pred ≥ p.stdev` (kappa monotonicity); CF
  writes both per 73a §10 mapping; reader fallback rule holds.

Migration of pre-split graphs is **out of scope for 73b**. Old graphs
will carry single-flavour `p.stdev` until a re-fit or refresh; the
reader fallback handles the absent `p.stdev_pred` case correctly.

By stage end: `p.stdev` is always epistemic, `p.stdev_pred` is always
predictive (or absent); the dispersion semantics are grep-auditable
by suffix; the doc 49 vs doc 61 naming inversion is contained at the
CF response boundary and translated by the apply mapping; consumers
of forecast bands have a deterministic flavour rule; the funnel
runner's direct CF-response read of `p_sd` / `p_sd_epistemic` is
unaffected (no graph read).

Stage 5. **Lock-respecting writer discipline.** Bring the lock-respecting
writer set into checking `p.mean_overridden` / `p.stdev_overridden`
(and the equivalents on each entry under `conditional_p`) before
writing those two scalars (open point 7). Concrete sites:
`applyBatchLAGValues`
(currently writes `p.mean` from `blendedMean` without checking),
the CF apply path
([conditionedForecastService.ts](graph-editor/src/services/conditionedForecastService.ts)),
FE topo Step 2
([statisticalEnhancementService.ts](graph-editor/src/services/statisticalEnhancementService.ts)),
and any runtime cascades. Locked ⇒ skip. Each writer is its own
commit so the sequence is bisectable.

(Action B8c — the lock-respecting writer set definition — is in
Stage 3 as documentation of the rule; the actual implementation lives
here. No code change to `applyBatchLAGValues` lands in Stage 3.)

Stage 6. **Cleanup.** Residual code that survived Stage 4's structural
fix:

- Remove `reprojectPosteriorForDsl` once no caller remains. Stages
  4(a), 4(b), and 4(e) collectively migrate analysis-prep, persistent-stash
  readers, and live-edge re-context off the function (4(a) / 4(e) call
  the shared slice helper directly; 4(b) keeps the function alive but
  rewires its read source). After Stage 4 lands, any remaining caller
  must be migrated to the shared helper before Stage 6 can delete the
  function and the helpers (`projectProbabilityPosterior`,
  `projectLatencyPosterior`, `resolveAsatPosterior`). The slice-resolution
  helper (`resolvePosteriorSlice`) used by the engorgement stays.
- Remove `_posteriorSlices` cleanup paths in
  [`bayesPriorService.ts`](graph-editor/src/services/bayesPriorService.ts).
- Remove remaining compatibility writes, parity-era diagnostics, dead
  source-selection branches, and stale docs so the codebase cleanly
  represents one FE topo pass plus one BE careful path.

Stage 6 entry condition (i.e. post-S7a state): no remaining write
site to the live graph's `_posteriorSlices`; but the schema entry
(if typed), Pydantic / TS types, and reader code paths in
`bayesPriorService.ts` may still reference it — those are the
S7b cleanup targets that Stage 6 itself lands. After Stage 6 / S7b,
`grep -rn _posteriorSlices graph-editor/` returns matches only
inside the engorgement helper(s) (which use the same key for the
engorged transient field) and tests. Classification table pinned
in this doc.

(Note: this Stage 6 is small because Stage 4 already removed the
load-bearing defect. There is no consumer migration to clean up after.)

## 9. Final acceptance criteria

This plan is complete only when all statements below are true.

1. Standard fetch pipeline has exactly two live statistical writers:
   the FE topo pass and the BE conditioned-forecast pass.
2. `analytic_be` no longer appears in graph state, source preference
   hierarchies, overlays, CLI output, or live-system docs — except as the
   documented compatibility reference in `bayes/compiler/loo.py` per §5
   Action A1, which intentionally retains the literal as a source-name
   fallback for legacy graph snapshots.
3. Selected baseline model forecast is stable across scoped queries unless
   underlying model source changes. Narrow or zero-evidence queries no longer
   rewrite canonical baseline forecast for an edge.
4. `f` and `f+e` remain distinct after FE fallback and CF landing. `f` reads
   promoted baseline forecast. `f+e` reads current query-owned answer.
5. Changing only current query-owned fields cannot alter runtime carrier
   behaviour, promoted source selection, or model inputs for later solves.
6. The FE topo pass remains fast and resilient and still provides immediate
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
13. The standard rendering pipeline (FE topo pass plus CF) operates
    correctly when no bayesian source files are present: the selector
    fallback rule selects `analytic`, FE topo Step 1 supplies `analytic`,
    and promoted plus current-answer fields populate as normal.
14. WP8 from doc 60 is stabilised as present but switched off: any existing
    feature flag or dormant dispatch path defaults to false/off in app, CLI,
    tests, and regression harnesses; no Stage 0–6 acceptance gate depends on
    enabling it; and the doc 60 WP8 implementation remains a named fast-follow
    after the basic factorised `window()` forecasting path is reliable.
15. The L5 dispersion slot is split per §3.3.4: `p.stdev` is always
    epistemic; `p.stdev_pred` is always predictive (or absent when the
    source supplies no predictive flavour). FE topo Step 2 and CF
    always write `p.stdev`. They write `p.stdev_pred` only when a
    predictive flavour is available (bayesian source with kappa
    fitted); otherwise they explicitly **delete** any pre-existing
    `p.stdev_pred` on the target so a stale predictive width from a
    previously-bayesian source cannot persist into an analytic-source
    context (per §3.3.4 stale-clearing rule). 73a §10 CF apply mapping
    carries the coordinated row changes. Display surfaces follow the
    predictive-preferred fallback pattern at forecast bands and the
    epistemic-only read at posterior card / mini-chart. `p.stdev_pred`
    carries no `*_overridden` flag.
16. Every graph-schema and Pydantic/TypeScript change required by 73b is
    enumerated in §12.2 (rows S1–S5, S7a, S7b, S8, S9 plus the S6 non-add row), assigned to a named stage in §12.3,
    and landed via the procedure in §12.4. Schema parity tests
    (`schemaParityAutomated.test.ts`, `test_schema_parity.py`) pass at the
    end of every owning stage. No engorgement field appears in the
    persistent graph schema. `'manual'` does not appear in any post-73b
    schema, literal, or persisted in-app state. The full schema-acceptance
    detail is in §12.5.
17. All open points listed in section 7 have either been resolved with the
    resolution recorded in this plan or in a linked follow-up doc, or have
    been explicitly deferred with a documented owner and target stage.
18. **Promotion is centralised in exactly one TS function**
    (`applyPromotion` in `modelVarsResolution.ts`) and **one Python
    function** (`resolve_model_params` in `model_resolver.py`). No other
    code path computes promoted-field values; all other writers of the
    promoted surface (CF, `applyBatchLAGValues`, runtime cascades) are
    either removed or routed through `model_vars[]` so promotion runs
    downstream. A TS/Py promotion-parity contract test (sibling to the
    schema-parity tests) pins that the two implementations produce
    byte-equal output for the same inputs.

## 10. Non-goals

This plan does not add replacement quick BE analytic path.

This plan does not redesign Bayes compiler.

This plan does not reopen cohort-versus-window semantics.

This plan does not turn the FE topo pass into a second careful forecast engine.

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

**Closing item — promote Appendix B companion to codebase.** When
73b is fully implemented and accepted, promote
[73b-appendix-b-data-flow-and-interfaces.md](73b-appendix-b-data-flow-and-interfaces.md)
from `docs/current/project-bayes/` into `docs/current/codebase/` as the
durable post-73b reference for the layered contract, the per-edge
field surface, the per-scenario request graph, and the BE analyse
dispatch surface (interfaces I1–I17). Suggested codebase name:
`FORECAST_STACK_DATA_FLOW.md` (final name to be agreed at promotion
time). After promotion: this 73b plan retains only the cross-link;
the codebase doc becomes the maintained artefact and is updated in
lockstep with future contract changes per the
[SCHEMA_AND_TYPE_PARITY.md](../codebase/SCHEMA_AND_TYPE_PARITY.md) /
[CHANGE_CHECKLIST.md](../codebase/CHANGE_CHECKLIST.md) discipline.
Link the new codebase doc from `STATS_SUBSYSTEMS.md` at the top of
the relevant section so a future reader lands there first.

### 11.2 Cross-doc alignment with docs 74 and 73a

This plan, doc 74, and doc 73a form a related set. The following ownership
boundaries and conflicts are established by reading docs 74 and 73a against
this plan; they must be reconciled by end of Stage 0 — i.e. before any
substantive contract change in Stage 1 onwards. **Doc reconciliation**
(stale labels in docs 74 / 60 / STATS_SUBSYSTEMS) is distinct from **doc
73a §15A pre-handoff acceptance gates**: reconciliation is a Stage 0 gate
on doc edits; 73a §15A is a Stage 3 gate on substantive 73a delivery (per
Decision 14).

**Confirmed ownership boundaries** (verified against doc 73a content):

- Pack field membership, compositor mechanics, CF supersession, CF
  response → graph apply mapping (the 73a §10 table), `awaitBackgroundPromises`
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
   (six pieces: a/b/c/d/e/f, where (f) is the L5 dispersion split per
   §3.3.4); lock-respecting writer discipline → Stage 5; residual
   cleanup → Stage 6. The slice-material BE readers
   do not migrate (per-scenario contexting supplies their fields
   in-schema). The consumer changes that **do** land in 73b are: the
   carrier read in Stage 4(d) routed through `resolve_model_params`;
   the analytic-source resolver path in `model_resolver.py` reworked
   in Stage 2 (D20 shortcut removed; analytic α/β read from
   `model_vars[analytic]` source layer); and the FE-side CF apply
   path is edited twice — Stage 4(c) removes CF's legacy
   `forecast.mean = p_mean` write (CF de-collapse), and Stage 4(f)
   updates the 73a §10 dispersion mapping rows
   (`p_sd → p.stdev_pred`, `p_sd_epistemic → p.stdev`). See §6.2
   classification table for the full list. The CLI's analysis-prep code path is a
   binding subtask of (a) — without it, Stage 6's CLI/FE parity gate
   fails. Any surviving `5a`/`5b`/`5c` citation in doc 73a, or any
   citation of "first consumer switch" / "consumer migration" against
   this plan that does not align with the §6.2 classification, is a
   reconciliation defect.
2. **CF dispersion persistence** — the earlier `p_sd → p.stdev`
   persistence decision is superseded by Stage 4(f) (§3.3.4
   dispersion-flavour split). Under the new mapping `p_sd → p.stdev_pred`
   (predictive) and `p_sd_epistemic → p.stdev` (epistemic). 73a §8 must
   add `p.stdev_pred` to the pack-field list; 73a §10 must update the
   two corresponding rows of the CF apply mapping table; 73a §10's
   sentinel test (`cfFieldMappingSentinel.test.ts`) updates accordingly.
   These are **coordinated edits** — the writer changes in this plan's
   Stage 4(f) cannot land before 73a §8/§10 reflect the new mapping,
   and 73a §10's mapping is non-functional without this plan's writer
   audit. Both PRs must reach acceptance together.
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

## 12. Graph schema changes (73b scope)

73b introduces several persistent-graph-schema and parameter-file-schema
changes. This section is the canonical ledger of every change and the
canonical procedure for landing it; if a change isn't here, it isn't
in 73b's scope.

The reference docs that govern this work are
[SCHEMA_AND_TYPE_PARITY.md](../codebase/SCHEMA_AND_TYPE_PARITY.md) and
the "Adding New Fields or Features" section of
[CHANGE_CHECKLIST.md](../codebase/CHANGE_CHECKLIST.md). Every entry
below must follow that procedure end-to-end. There is no "schema-only"
change in this project — a graph-schema addition is a schema-plus-
Pydantic-plus-TypeScript-plus-tests change by definition.

### 12.1 Schema surfaces touched by 73b

The full set of schema files this plan changes:

| Surface | File(s) | Why |
|---|---|---|
| Primary graph schema | `graph-editor/public/schemas/conversion-graph-1.1.0.json` | Persistent fields (`p.forecast.source`, `p.stdev_pred`); enum changes (`model_source_preference`); analytic source-block shape under `p.model_vars[].probability` |
| Python Pydantic models | `graph-editor/lib/graph_types.py` | Mirror every graph-schema change. Affected classes: `ProbabilityParam`, `ForecastParams`, `ModelVarsEntry`, `ModelVarsProbability` |
| TypeScript core types | `graph-editor/src/types/index.ts` | Mirror every graph-schema change. Affected types: `ModelSource`, `ModelSourcePreference`, the model-vars probability/forecast types |
| Parameter-file schema | `graph-editor/public/param-schemas/parameter-schema.yaml` | Per-slice carrier expansion if Stage 2's analytic source mirror requires file-level changes (audit needed; analytic is graph-only so likely none here) |
| UI schemas | `graph-editor/public/ui-schemas/` | None expected — promoted/current-answer fields are not user-edited via `FormEditor`; props-panel edits hit them via dedicated handlers |
| Schema parity tests | `graph-editor/src/services/__tests__/schemaParityAutomated.test.ts`, `graph-editor/lib/tests/test_schema_parity.py` | Each schema addition extends the parity-checked field set |

The graph-schema bump policy is documented at
[SCHEMA_AND_TYPE_PARITY.md §Versioning](../codebase/SCHEMA_AND_TYPE_PARITY.md):
1.1.0 → 1.1.0 if every change is additive/relaxing (the default for
73b's additions); the only mandatory bump is if a removal or tightening
is non-back-compatible. Stage 3's `'manual'` removal is borderline —
the loader's graceful-degrade rule (§7 OP1) makes it back-compatible
in practice (in-the-wild `'manual'` is silently rewritten on read), so
the version stays at 1.1.0 unless review concludes otherwise.

### 12.2 Schema-change ledger

Each row is a discrete schema change owned by a named stage. The "Owning
stage" column is binding: if a stage doesn't list one of these changes
in its scope, it must not land it; if a stage lists a change but the
schema work isn't done, the stage's acceptance gate fails.

| # | Change | Affected schema(s) / type(s) | Status today | Target | Owning stage |
|---|---|---|---|---|---|
| **S1** | `model_vars[analytic].probability` gains aggregate Beta-shape fields: `alpha`, `beta`, `n_effective` (or `window_n_effective`), `provenance`, `cohort_alpha`, `cohort_beta`, `cohort_n_effective`, `cohort_provenance` | `ModelVarsProbability` (Pydantic + TS); `model_vars` schema in `conversion-graph-1.1.0.json` (currently `additionalProperties: true` — tighten to typed object); §3.9 contract | `ModelVarsProbability` carries only `mean`, `stdev` | Per §3.9 list. Predictive Beta fields explicitly NOT added (analytic has no overdispersion model — see §3.9 and §3.3.4). | Stage 2 |
| **S2** | `'manual'` removed from `ModelSource` literal union | `ModelVarsEntry.source: Literal['analytic', 'bayesian', 'manual']` (Pydantic); `ModelSource` (TS at `src/types/index.ts:618`); `model_vars[].source` enum in graph schema | `'manual'` is one of three values | Two values: `'analytic'`, `'bayesian'` | Stage 3 |
| **S3** | `'manual'` removed from `ModelSourcePreference` literal union | `ProbabilityParam.model_source_preference: Literal['best_available', 'bayesian', 'analytic', 'manual']` (Pydantic at `graph_types.py:315`); `ModelSourcePreference` (TS at `src/types/index.ts:623`); enum in graph schema | Four values | Three values: `'best_available'`, `'bayesian'`, `'analytic'` | Stage 3 |
| **S4** | `ForecastParams` gains `source` (provenance label) | `ForecastParams` (Pydantic at `graph_types.py:288`); graph schema `ForecastParams` def at `conversion-graph-1.1.0.json:$defs/ForecastParams`; TS type | `ForecastParams: { mean, stdev, k }` | `ForecastParams: { mean, stdev, source, k }`. **Field-set partition**: the **promoted surface** is `{ mean, stdev, source }` — written exclusively by `applyPromotion` per §3.2. `k` is **not** part of the promoted surface; it is a **runtime-derived population helper** (`k = p.mean × p.n`) computed by the FE topo pass's inbound-n propagation in [`statisticalEnhancementService.ts`](graph-editor/src/services/statisticalEnhancementService.ts) (around line 3787) and read by [`graph_builder.py:302`](graph-editor/lib/runner/graph_builder.py#L302). It happens to share the `p.forecast` namespace with the three promoted fields but has a different writer and a different lifecycle. **Promotion does not write `k`**; the inbound-n propagation pass does. The "three-field promoted surface" framing in §3.2 / §6.2 / Appendix A is correct precisely because `k` is excluded. `source` is the source-basis label written by `applyPromotion` (`'bayesian'` / `'analytic'` / future). Per OP2 — required field. | Stage 4(c) |
| **S5** | `p.stdev_pred` (predictive flavour) added at L5 | `ProbabilityParam` (Pydantic at `graph_types.py:298`); graph schema `ProbabilityParam` def; TS type. Mirror under `conditional_p[X].p` (same shape — Record-keyed by condition string per 73a §3 rule 7) | Only `stdev` exists | `stdev` (epistemic) + `stdev_pred` (predictive) per §3.3.4 | Stage 4(f) |
| **S6** | `p.stdev_pred_overridden` — **NOT added** | n/a | n/a | Decision: no lock flag for `stdev_pred` (§3.3.4, Action B8a — `stdev_pred` is not user-overtypable in the UI) | n/a (recorded so a future reader doesn't accidentally add it) |
| **S7a** | `_posteriorSlices` writer removal | `mappingConfigurations.ts` Flow G (the Flow G write site); supporting code paths in `bayesPriorService.ts` that *write* into the stash | Flow G writes the persistent multi-context library on every fetch; `_posteriorSlices` accumulates per-DSL slices on the live edge | Flow G write site removed. After this row lands the stash is no longer being populated, but existing stash entries on in-the-wild graphs remain (cleared on next save). The schema entry — if one is typed — and the dead types are not yet removed (S7b). | Stage 4(b) |
| **S7b** | `_posteriorSlices` schema entry + dead-type cleanup | Graph schema (if `_posteriorSlices` is explicitly typed under `Edge.p` — currently lives under `additionalProperties: true` so may not have a typed entry; audit at Stage 6 entry); Python `Graph` / `ProbabilityParam` types in `lib/graph_types.py`; TS types under `src/types/`; reader/cleanup paths in `bayesPriorService.ts` (the *read* paths that survived S7a) | Schema and types may still name `_posteriorSlices`; cleanup paths still exist | Schema entry, Pydantic field, TS type entries, and any remaining reader paths in `bayesPriorService.ts` deleted. After this row lands `grep -rn _posteriorSlices graph-editor/` returns matches only inside the engorgement helper(s) (which use the same key for the engorged transient field) and tests. | Stage 6 |
| **S8** | Pack contract extended with `p.stdev_pred` | 73a §8 pack-field list; `GraphParamExtractor.ts`; `applyComposedParamsToGraph`; sentinel test | Pack carries `p.stdev` only | Pack carries both `p.stdev` and `p.stdev_pred`; mirrored under `conditional_p[X].p` | Stage 4(f) (coordinated edit in 73a §8 — see §11.2 conflict 2) |
| **S9** | CF apply mapping (73a §10) updated for the dispersion split | 73a §10 mapping table; `applyConditionedForecastToGraph` in `conditionedForecastService.ts`; sentinel test | `p_sd → p.stdev`; `p_sd_epistemic` response-only | `p_sd → p.stdev_pred`; `p_sd_epistemic → p.stdev` | Stage 4(f) (coordinated edit in 73a §10 — see §11.2 conflict 2) |

**Engorgement fields** (`_bayes_evidence`, `_bayes_priors`,
`_posteriorSlices.fit_history`) are explicitly **not** persistent
graph-schema additions. They are out-of-schema transient fields written
onto request-graph copies per §3.2a (ii). They do not belong in
`conversion-graph-1.1.0.json` or the persistent Pydantic model. If a BE
consumer needs a typed contract for them, that contract belongs in a
request-graph-only Pydantic class (e.g. an existing or new
`PreparedRequestGraph` model under `lib/`), not in `Graph`.

**Conditional-probability mirroring**: every persistent-field change
that touches the `p` block applies under each `conditional_p[X].p`
block as well (per 73a §3 rule 7 / OP7), regardless of which layer
the field belongs to. The rows that mirror under conditional_p[X]:

- **S4** — `ForecastParams` adds `source` (L2 promoted surface). Each
  `conditional_p[X].p.forecast` gains the same `source` field.
- **S5** — `p.stdev_pred` (L5 current-answer). Each
  `conditional_p[X].p.stdev_pred` exists with the same shape.
- **S6** — explicit non-add (`p.stdev_pred_overridden`). Mirror is
  also "non-add" — neither unconditional nor conditional `p` carries
  the flag.
- **S8** — pack contract extension. The pack's `conditional_p` Record
  carries `p.stdev_pred` per condition.
- **S9** — CF apply mapping. Per 73a's CF response shape (which
  carries per-condition results when conditional probabilities are
  forecast), the apply path applies the same mapping under each
  scenario's `conditional_p[X].p`.

Rows that do **not** mirror: S1 (analytic source-mirror under
`model_vars[]`, not under `p`); S2/S3 (literal-union changes — global
to the type, not per-block); S7a/S7b (`_posteriorSlices` removal —
not under `p` either, lives directly under `Edge.p`).

The Pydantic class `ProbabilityParam` is shared between unconditional
`p` and conditional `p`, so adding `stdev_pred` to `ProbabilityParam`
covers both call sites in one change. Same for `ForecastParams`'s
`source` addition (S4) since `conditional_p[X].p` reuses
`ProbabilityParam` (which embeds `ForecastParams`).

### 12.3 Per-stage schema-change subsets

Each stage's schema work is exactly the rows below. Other schema
changes are in scope for other stages and must not be sneaked into
the wrong stage.

| Stage | Schema rows |
|---|---|
| Stage 2 | S1 |
| Stage 3 | S2, S3 |
| Stage 4(c) | S4 |
| Stage 4(b) | S7a |
| Stage 4(f) | S5, S8, S9 |
| Stage 6 | S7b |

Stages 0, 1, 4(a), 4(d), 4(e), 5 carry no schema changes.

### 12.4 Per-change implementation procedure

Every row in the ledger is delivered by following the
[SCHEMA_AND_TYPE_PARITY.md §Adding a new field checklist](../codebase/SCHEMA_AND_TYPE_PARITY.md)
and the
[CHANGE_CHECKLIST.md §Adding New Fields or Features](../codebase/CHANGE_CHECKLIST.md)
expansion of it. The combined seven-step procedure, applied per row,
is:

1. Update the JSON Schema source of truth in `graph-editor/public/schemas/conversion-graph-1.1.0.json` (or `param-schemas/parameter-schema.yaml` if the change is parameter-file-side).
2. Update the Pydantic model in `graph-editor/lib/graph_types.py`.
3. Update the TypeScript interface in `graph-editor/src/types/index.ts` (and any service-specific type files that mirror the field).
4. If user-editable via `FormEditor`: update the paired UI schema in `graph-editor/public/ui-schemas/`. (None of 73b's changes go through `FormEditor`; this step is expected to be a no-op for every row except a future case we haven't identified.)
5. If the field has an `_overridden` companion: mirror the override pattern. (Only S5 has a candidate, and S6 explicitly says NO.)
6. If the field contains node references: update `UpdateManager` rename logic. (None of 73b's changes carry node refs.)
7. Run parity tests: `npm test -- --run schemaParityAutomated` and `pytest lib/tests/test_schema_parity.py`. Both must pass before the row is considered landed.

For S1 specifically (analytic source-mirror fields under
`model_vars[analytic].probability`), the analogue of
[CHANGE_CHECKLIST.md anti-pattern 14](../codebase/CHANGE_CHECKLIST.md)
applies. Anti-pattern 14 itself targets the *Bayes* posterior path
(`PosteriorSummary` / `LatencyPosteriorSummary` additions also
require `_build_unified_slices()` in `worker.py` and
`bayesPatchService.ts` projection updates). S1 is on the analytic
side, not the bayesian side, so anti-pattern 14 does not apply
directly. The analogous analytic-side discipline: FE topo Step 1's
writer in `statisticalEnhancementService.ts` and any FE patch
projection that handles the analytic source must emit the new
fields consistently. Both writers must be updated together; a parity
test pins the field set.

For S7a / S7b (`_posteriorSlices` removal), the discipline is reversed:
every listed location must be confirmed empty / type-safe before the
row is considered landed. S7a verifies no remaining writer; S7b
verifies no remaining schema entry, type, or reader. Stage 6's entry
condition (§8) is the grep gate for S7b.

### 12.5 Acceptance criteria for schema changes

Adds to §9:

- All schema rows S1–S5, S7a, S7b, S8, S9 in §12.2 land in their owning
  stage and pass both parity tests. No schema row crosses a stage boundary.
- S6 (`p.stdev_pred_overridden` — explicit non-add) is satisfied by
  **absence**: there is no schema work to land. Acceptance is verified by
  the parity tests not gaining a `stdev_pred_overridden` entry on either
  side, plus the absence of any reader / writer / schema reference to the
  flag in code.
- No row leaks back to an earlier stage as a side effect of later
  work.
- No engorgement field (`_bayes_evidence`, `_bayes_priors`,
  `_posteriorSlices.fit_history`) appears in `conversion-graph-1.1.0.json`
  or in the persistent Pydantic `Graph` / `ProbabilityParam` types.
- `'manual'` does not appear in any post-73b schema, Pydantic literal,
  TS literal, or persisted in-app graph state (graceful-degrade rule
  on load handles in-the-wild graphs per OP1).
- `cfFieldMappingSentinel.test.ts` is updated for the Stage 4(f) row
  changes (S8, S9) and passes.
- The graph-schema version remains 1.1.0 unless the review of S2/S3's
  `'manual'` removal concludes that the removal is non-back-compatible
  enough to warrant 1.2.0; in that case the bump and matching loader
  changes are in Stage 3.

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
  - **Engorgement** (out-of-schema, all bayes-derived from the
    parameter file; **presence-conditional, not
    source-promotion-conditional** — each field is written when the
    corresponding source material exists for the edge): writes
    `_bayes_evidence` (file evidence including cohort daily-row
    time series — consumed by CF to supplement DB-snapshot rows
    via `api_handlers.py:2099`, regardless of which prior source
    CF resolved); `_bayes_priors` (bayesian prior material — CF
    reads this as the IS prior **when** the resolved prior source
    is bayesian; under analytic-source CF, the IS prior is read
    from in-schema `model_vars[analytic]` per §3.9, not from
    `_bayes_priors`); and `_posteriorSlices.fit_history`
    (per-`asat` fit history consumed by `epistemic_bands.py` for
    time-axis bands; bayesian-fit-presence-conditional). The first
    two are engorged today by `bayesEngorge.ts`; the third is added
    in Stage 4(a) because Stage 4(b) removes the persistent stash
    that supplies it today. DB-snapshot evidence is not engorged —
    the BE queries the DB directly. The graph copy is discarded
    after the call. CF still runs uniformly per Decision 13.
- **Promoted layer** (`p.forecast.{mean, stdev, source}` plus promoted
  latency block, persistent): the narrow display surface for `'f'`
  mode and the FE charts. Written only by `applyPromotion`.
  Quality-gated source selection respecting the selector pin.
- **Evidence layer** (`p.evidence.*`, persistent): raw query-scoped
  k/n.
- **Current-answer layer** (`p.mean`, `p.stdev`, optional
  `p.stdev_pred`, `p.latency.completeness`,
  `p.latency.completeness_stdev`, persistent): query-conditioned.
  FE topo Step 2 writes provisional values; CF overwrites
  authoritatively. `p.stdev` is epistemic; `p.stdev_pred` is
  predictive when present. Only `p.mean` / `p.stdev` carry
  `*_overridden` locks (per OP7 / §3.3.4).
- **Display modes**: `'f'` → `p.forecast.mean` (promoted aggregate);
  `'e'` → `p.evidence.mean`; `'f+e'` → `p.mean` (blend).
- **FE topo pass** (one code path, two roles; ordering unconstrained — see §1.1):
  - *Step 1* (source-layer): produces `model_vars[analytic]` from
    aggregate window/cohort inputs.
  - *Step 2* (current-answer): reads the promoted layer for forecast
    contributions, aggregates scoped evidence, writes provisional
    current-answer scalars.
- **CF**: receives a contexted+engorged request graph, IS-conditions
  on query-scoped evidence, writes current-answer scalars only. At
  the CF response boundary, `p_sd` maps to graph `p.stdev_pred`
  (predictive) and `p_sd_epistemic` maps to graph `p.stdev`
  (epistemic).
- **Carrier consumers** (`forecast_state.py::_resolve_edge_p` and
  any sibling reach/carrier sites): read model inputs only via the
  shared `resolve_model_params` resolver, never `p.mean` directly.
  The shared resolver honours the same promotion decision as
  `applyPromotion`, so reading `p.forecast.{mean, stdev, source}`
  directly and reading `model_vars[]` via the resolver are
  equivalent. Hand-coded source selection in a consumer is a
  regression.
- **Pack contract**: promoted (narrow) + current-answer (including
  `p.stdev_pred` when present) + evidence + `p.posterior.*`
  (single-context display projection) + `conditional_p` + `p.n`.
  Not in pack: source ledger, selector, `*_overridden` flags, slice
  library. Lock state reconstituted at compose time on the live edge.

## Appendix B — pointer to companion doc

> **Appendix B has been extracted to a standalone companion document:**
>
> ### → [73b-appendix-b-data-flow-and-interfaces.md](73b-appendix-b-data-flow-and-interfaces.md)
>
> That document contains B.1–B.4 in full:
> - **B.1** Source-material provenance (bayesian + analytic pipelines)
> - **B.2** Per-edge layered model (L1/L1.5/L2/L3/L4/L5)
> - **B.3** Per-scenario request graph (transient, per BE call)
> - **B.4** BE analyse dispatch — full surface (CF + runner + snapshot + cohort_maturity + funnel)
>
> …plus the full **interface contracts I1–I17**.
>
> **Why a separate doc**: the diagrams and interface contracts are
> long-lived reference material — not just a 73b artefact. They survive
> 73b's completion; the 73b plan does not. Keeping them in one
> standalone file lets us evolve them in lockstep with the layered
> contract and lets reviewers cite specific interfaces (e.g. "see I12")
> without grep-walking 73b.
>
> **Promotion plan after 73b lands**: the standalone doc is promoted
> from `docs/current/project-bayes/` into `docs/current/codebase/` —
> likely as `FORECAST_STACK_DATA_FLOW.md` or a similar canonical name —
> as the durable post-73b reference. This 73b plan retains only the
> cross-link; the codebase doc becomes the maintained artefact. The
> promotion is recorded as a closing item in §11.1's documentation
> follow-through; until promotion, the project-bayes copy is the
> authoritative location.
