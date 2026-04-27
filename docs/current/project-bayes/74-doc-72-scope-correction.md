# 74 — Scope Correction for Doc 72 After Reversion

**Date**: 24-Apr-26  
**Status**: Companion scope note  
**Audience**: engineers resuming FE/CLI conditioned-forecast parity work after the reversion  
**Relates to**: `72-fe-cli-conditioned-forecast-parity-fix-plan.md`, `73a-scenario-param-pack-and-cf-supersession-plan.md`, `../cohort-cf-defect-and-cli-fe-parity.md`, `../codebase/STATS_SUBSYSTEMS.md`, `../codebase/FE_BE_STATS_PARALLELISM.md`

## 1. Purpose

This note does not replace doc 72. It records the narrower reading that
should govern any next attempt after the reversion.

Its job is purely scoping. The settled implementation shape now lives in
doc 73a. This note exists to preserve the valid architectural warning from
doc 72 while explicitly de-scoping the parts that would turn the parity
repair into a broader forecast-state or source-taxonomy clean-up.

## 2. The binding insight that should stay

The FE topo pass should stay. It is quick, rough, resilient, and already
well-exercised. This pass is not the place to replace that machinery with a
second careful solver or to redesign the whole Stage 2 pipeline around a
different fast path.

The real architectural distinction is between three things that the live
graph still does not separate cleanly enough: source-owned model vars,
promoted or best-available model vars, and the current query-scoped answer on
the graph. That three-layer framing is the useful part of doc 72 and should
remain binding.

The BE conditioned-forecast pass should treat promoted model state as its
model input and scoped evidence as its conditioning input. The FE quick pass
may write a provisional current answer for display, but that answer should not
be silently re-used later as though it were the model.

Scenario ownership also remains binding. Current query-scoped graph state is
scenario-specific work. FE/CLI parity is weak if each side is effectively
reconstructing a different scenario projection, even when the BE runtime is
shared.

## 3. What should be de-scoped from doc 72

The next pass should not be framed as a general clean-up of the statistical
source taxonomy. In particular, it should not depend on removing the quick BE
topo pass, redesigning every model-var source, or solving the full long-term
question of probability field naming before the parity defect can move again.

It should also not be framed as a general scenario-system rewrite. The live
concern is narrower: whether FE and CLI can reconstruct the same scenario
projection without widening scenarios into stored graph snapshots.

Finally, the pass should not absorb every open posterior-provenance witness in
the same motion. The target-edge mass-inflation witness from doc 72 may be
real and important, but unless tracing proves it shares the same root cause,
it should remain an explicitly separate open witness rather than forcing this
parity pass to become a wider posterior-audit programme.

## 4. How doc 72 should be read now

Doc 72 should still be read as correct on its two core claims. First, model
estimation and query conditioning have been collapsing onto the same flat
graph fields. Second, carrier or reach code is still exposed to query-owned
FE state in places where it should be reading promoted model state instead.

Doc 72 should be read more cautiously where it starts to widen into a broader
execution programme. The parts that lean toward a larger field-taxonomy tidy,
source-system redesign, or a broad scenario-owned graph-store re-architecture
should be treated as future possibilities rather than as prerequisites for the
next repair pass.

The most useful narrow reading is this. First, stop the runtime from reading
FE provisional current-answer fields as model input. Second, make scenario
reconstruction faithful without storing full scenario graphs. Third, keep the
target-edge mass witness visible, but do not merge it into the same
implementation batch unless tracing proves that it belongs there.

## 5. Non-goals for this narrowed pass

This narrowed pass does not replace the FE quick topo machinery.

It does not reopen cohort-versus-window semantics.

It does not require a clean-slate scenario store or persisted per-scenario
graphs.

It does not require a general rewrite of the statistical source taxonomy.

It does require discipline about which fields are model-bearing, which fields
are promoted model state, and which fields are the current query's answer.

## 6. Where the implementation now lives

Docs 73a and 73b together carry the active implementation. Ownership split
(reconciled 27-Apr-26 by doc 73b §11.2 conflict 5):

- **Doc 73a** owns the param-pack and CF-supersession spine: parameter
  files as the deep store, the graph as structure plus current projection,
  user scenarios as ordered thin param-pack deltas, per-scenario CF
  supersession in tab context, and scenario packs widened only to the
  active projected fields needed for faithful rebuild.
- **Doc 73b** owns the source/promoted/current-answer layer split that
  follows from the app's data design. Specifically:
  - The FE provisional answer no longer serves as authoritative model
    input — the FE-provisional-vs-model split is delivered by doc 73b
    Stages 2 and 4(c)/4(d) (analytic semantic transition; narrow promoted
    writer; carrier consumer reads via the shared resolver).
  - The Python runtime uses one consistent probability-source contract
    across target-edge and carrier reads — Python source-order
    unification is delivered by doc 73b Stage 4(d) (carrier consumer
    audit and switch through `resolve_model_params`).

Both items above were originally framed in this section as "doc 73a
captures the settled shape"; doc 73a hands them back to 73b for
implementation, and doc 73b §11.2 records the resolved boundary. Doc 73a
remains the active implementation note for the param-pack / CF
supersession items in the first bullet.
