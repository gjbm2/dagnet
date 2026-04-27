# 01 — Rate overtype and carrier propagation

**Date**: 27-Apr-26
**Status**: Charter / deferred fast-follow. Begins after 73b acceptance.
**Audience**: engineers picking up the next iteration of what-if
functionality; reviewers triaging post-73b UX regressions.
**Inherits from**: [project-bayes 73b §7](../project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md) — the limitation this doc owns the resolution of.

## 1. Why this exists

Project-bayes 73b establishes a strict layered contract for forecast
state — source ledger (L1), selector (L1.5), promoted baseline (L2),
posterior display (L3), evidence (L4), current answer (L5) — and a
bright-line rule that `*_overridden` flags are write-side locks only,
**never** consulted by readers. A consequence of that strict separation
is that the user's hand-edit of `p.mean` (current-answer field, L5) no
longer propagates to carrier consumers (the runner sites that compute
node arrival probabilities, path / reach analyses, conversion funnel,
cohort-maturity v3 model curves, etc.).

73b acknowledges this as a known UX regression and defers resolution
here. This doc is the charter for that work and a placeholder for the
broader "next iteration of what-if" design that the resolution naturally
folds into.

## 2. The handed-off limitation (verbatim summary)

After 73b's Stage 4(d), carrier consumers
([`forecast_state.py::_resolve_edge_p`](../../../graph-editor/lib/runner/forecast_state.py#L270),
[`graph_builder.py:202`](../../../graph-editor/lib/runner/graph_builder.py#L202),
[`path_runner.py:105`](../../../graph-editor/lib/runner/path_runner.py#L105))
read model-bearing inputs exclusively via `resolve_model_params`; they
do not read `p.mean`. A user overtype on `p.mean` (with
`mean_overridden = true` blocking system writers per 73b Stage 5)
therefore updates **only** the edge's own local display surfaces:

- `'f+e'` mode chart for the edge itself.
- Edge label and edge stroke width on the canvas.
- The edge's own properties-panel "Output" card.

It does **not** propagate to any downstream / derived display:

- node arrival probabilities computed from carrier reach;
- path-runner / graph-runner reach analyses (`path_between`,
  `path_through`, `to_node_reach`, `from_node_outcomes`,
  `branch_comparison`, `outcome_comparison`, `general_selection`,
  `graph_overview`, `multi_*_comparison`);
- conversion funnel reach;
- cohort-maturity v3 per-tau curves (these read model_vars
  Beta-shape — a single-rate overtype has nothing to project against);
- posterior card / predictive bands / latency curves.

This is a real UX regression vs pre-73b behaviour, where overtype
auto-creates a `model_vars[manual]` entry and the carrier picks up the
override via promotion. After 73b Stage 3 removes `manual`, no
mechanism exists in the post-73b contract to mark `p.mean` as
authoritative for carrier purposes.

## 3. Why 73b can't fix it

The bright-line rule — `*_overridden` is a write-side gate only; no
consumer branches on it — is load-bearing across the app. Softening it
to let carriers read `p.mean` would have unbounded downstream
consequences (every carrier-style read becomes a potential layer
violation; every consumer of a "rate" needs to decide whether to trust
the user). The proper fix requires reintroducing structural source
state for user authoring, which is more than a wording polish or one
new field, and is out of 73b's scope.

## 4. Broad resolution direction

The likely shape of the resolution is to **reintroduce a `manual`
source under `model_vars[]`** with **snapshot semantics**:

- When the user overtypes a scalar that wants to project through the
  model layer (today: `p.mean`; possibly others), the system **copies
  all current promoted model_vars** into a new `manual` ledger entry —
  a frozen snapshot of probability Beta-shape, latency, kappa,
  predictive flavour, etc., as they were at edit time.
- The user's overtyped value(s) replace the corresponding scalars in
  the manual block (e.g. `model_vars[manual].probability.mean = 0.7`).
- The selector pins to `manual` (or `manual` joins the quality gate
  with appropriate priority). Promotion projects the manual source
  onto `p.forecast.{mean, stdev, source}`. Carriers and sophisticated
  consumers all see consistent values because they all read through
  the standard model_vars path.
- The snapshot persists until the user explicitly clears the override
  or switches source.
- `*_overridden` stays purely a write-side lock. The
  user-authoritative semantics live in the source ledger, not in a
  flag.

This is the broad direction, not a binding spec. Open questions and
trade-offs in §6.

## 5. Connection to the next iteration of "what-if"

The narrow problem (rate overtype propagation) is the visible tip of a
larger design question: **how should DagNet support counterfactual
exploration?** The current app conflates several concerns:

- **Local what-if** ("what does this displayed answer become if I tweak
  this edge?") — today partially served by `p.mean` overtype + the
  `manual` source side-effect.
- **Scenario-as-counterfactual** — proper, isolated alternative
  parameter packs that propagate through composition. Already exists.
- **DSL-based what-if** — visited / case overrides expressed in the
  query DSL, applied at runtime via `applyWhatIfToGraph`.
- **Selector pin as model choice** — a different concern (which
  source's beliefs to use), often confused with what-if at the UX
  level.

73b separates these conceptually (selector is L1.5, overtype is L5,
scenarios are pack-based). But the overtype affordance no longer does
what users expect, and the alternative (use scenarios) is heavyweight
for quick exploration. This workstream should:

- decide what "local what-if" means as a first-class feature (does it
  exist? is it just sugar over a single-edge scenario?);
- design the manual-source snapshot mechanism in the context of that
  larger answer (or rule it out in favour of a different mechanic);
- align with doc 60 WP8 (direct-cohort rate conditioning), which is a
  sibling deferred item that touches the same surface;
- decide UX affordances (what does the Output card mean? when does
  overtype open a scenario instead of editing the live edge? clear /
  refresh / re-pin gestures for the manual snapshot).

## 6. Open questions for the workstream

Not pre-decided in 73b; for this project to resolve.

- **Snapshot freshness.** A manual block, once captured, can become
  stale relative to subsequent bayesian / analytic refits. What's the
  refresh policy? Auto-refresh + warn? Manual refresh button? Stale
  badge?
- **Per-field vs whole-block snapshots.** If the user overtypes only
  `p.mean`, does the snapshot capture only the probability block or
  also latency / kappa / etc.? Does each overtype family create its
  own narrow-scope manual entry?
- **Pin interaction with scenarios.** Selector pin is edge-global
  (per 73b §3.5 / Decision 10) and not in packs. If `manual` pin is
  edge-global, how does it interact with non-Current scenarios that
  override the same scalar? Two authors of the same field — which
  wins?
- **Schema reintroduction cost.** 73b Stage 3 / row S2 removes
  `manual` from `ModelSource`. Reintroducing requires walking back
  Stage 3's acceptance criterion and adding a Stage-3-equivalent
  schema row to whatever this workstream's plan looks like.
- **Composition mechanics.** `applyComposedParamsToGraph` doesn't
  carry source-ledger entries today (per 73b §3.6 / Decision 11). If
  `manual` is edge-global and not packed, how does scenario
  composition handle it? Does it just sit on the live edge and apply
  to all scenarios (the today-pre-73b behaviour)?
- **Clear / cancel UX.** What gesture clears a manual override? Does
  it return to bayesian/analytic per the previous selector state, or
  to `best_available`? What happens to the snapshot when cleared —
  discarded immediately, or held briefly for undo?
- **Relationship to WP8 (doc 60).** WP8's direct-`cohort()` rate
  conditioning may share design surface with the manual-source
  mechanic. Co-design or independent?
- **Prior-art / external reference.** Are there mature spreadsheet /
  modelling-tool patterns for "snapshot a model row, edit one cell,
  let it propagate" that this should align with?

## 7. Mitigation in the meantime (post-73b, pre-resolution)

While this workstream is unscheduled, users wanting "what if this edge
converted at rate X" should use the **scenarios** mechanism: create or
edit a scenario whose pack carries the override; analysis of that
scenario composes the override onto a graph copy via
`applyComposedParamsToGraph` and propagates through the carrier path.
Hand-editing `p.mean` on the live edge is reserved for "I'm overtyping
the displayed answer" and is documented as not affecting downstream
reach.

UX flagged for the meantime (out-of-scope for 73b but worth shipping
ahead of the full design):

- Surface a UI affordance — e.g. a badge or warning on edges with
  `mean_overridden = true` — indicating that the override does not
  propagate to downstream reach. Surface in the same area as the lock
  flag display.
- Update help text / tooltips on the Output card to direct users to
  scenarios for what-if analysis.

## 8. Acceptance (what "done" looks like for this workstream)

To be defined when the workstream is scheduled. Sketch:

- A user overtyping `p.mean` on the live edge (with appropriate UX)
  produces a result that propagates through carriers, posterior
  consumers, and cohort-maturity v3 — consistent across all surfaces.
- The bright-line rule (`*_overridden` purely write-side; no consumer
  branches on it) survives the change.
- Scenarios as a counterfactual mechanism remain fully functional and
  conceptually distinct from local overtype.
- Schema, contracts, and tests all up-to-date; parity (TS / Py /
  schema) preserved.
