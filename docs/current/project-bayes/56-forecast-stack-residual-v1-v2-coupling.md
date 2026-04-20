# 56 — Forecast stack: residual v1/v2 coupling in BE CF and v3 row builder

**Status**: Implementation plan — migrate the live forecast stack off residual v1/v2 runtime helpers before landing new engine consumers.
**Created**: 20-Apr-26
**Updated**: 20-Apr-26
**Relates to**: doc 29e (forecast engine implementation plan, §HARD RULE: v2 is frozen), doc 29f (forecast engine implementation status, Phase G), doc 45 (forecast parity design), doc 47 (whole-graph forecast pass), doc 50 (CF generality gap — where this was surfaced)

## TL;DR

The BE CF pass (`handle_conditioned_forecast`) and the v3 row builder
(`compute_cohort_maturity_rows_v3`) still directly depend on v1
(`cohort_forecast.py`) and v2 (`cohort_forecast_v2.py`) symbols at
runtime. Two of those dependencies (`build_span_params`,
`build_upstream_carrier`) are on v2 — the module doc 29e §HARD RULE
explicitly freezes as the parity reference. A third tier of
dependencies is on the "frozen infrastructure" (`span_kernel`,
`span_evidence`, `span_adapter`, `cohort_forecast` v1 carrier
helpers) that doc 29e also freezes.

This contradicts the stated design principle: BE CF is supposed to
be a **clean generalisation** of the forecasting machinery, with
zero residual dependencies on analysis-type-specific code. It and
cohort_maturity_v3 (and future analyses consuming the same engine)
should rely on the same general-purpose engine layer, not on v1/v2
helpers.

Concrete consequence: v1 and v2 **cannot be deleted** as the
programme expected them to be in the near term. Worse, a defect in
v2's `build_span_params` (a κ=20 weak prior when no Bayesian
posterior exists, ignoring analytic α/β that the resolver already
has) is operational in the live CF path and produces systematic
undershoot on laggy edges. Doc 50's truth-parity test surfaced it.

This document started as a stop-and-think note. It now records the
chosen migration: keep v2 frozen as the parity oracle, remove all
production imports of v1/v2 helpers, promote the genuinely generic
span infrastructure, and cut the live engine, v3, and CF handler over
to a small runtime layer keyed on `ResolvedModelParams`.

## 1. What doc 29e specified

Doc 29e §HARD RULE ([29e-forecast-engine-implementation-plan.md:26-35](29e-forecast-engine-implementation-plan.md)):

> `cohort_forecast_v2.py` and its call sites (`_handle_cohort_maturity_v2`
> in `api_handlers.py`) must not be modified. v2 is the parity
> reference that all engine work tests against. This also applies to
> v2's infrastructure: `cohort_forecast.py` (v1 carrier hierarchy),
> `span_kernel.py`, `span_evidence.py`, `span_adapter.py`. All frozen
> until v3 passes parity and v2 is retired (Phase 5.5).

Doc 29e Phase 5.5 exit states v1/v2 deletion and unfreezing of the
supporting modules once v3 reaches parity. Doc 29f tracks v3 parity
as 17/17 PASSED (as of 16-Apr-26). The plan's next block is
retirement, which is blocked by what this doc describes.

## 2. Design principle being violated

BE CF (whole-graph conditioned forecast) is architecturally **the
engine's canonical multi-subject caller**. It should read a graph,
resolve per-edge `ResolvedModelParams` via `model_resolver`, run the
engine (`compute_forecast_trajectory`) per edge, and emit scalars.
No analysis-type-specific logic, no composition helpers tied to a
particular row shape.

v3 (`cohort_maturity_v3`) is supposed to be a **thin consumer** of
the same engine — per doc 29f, it's 185 lines that routes to the
engine and assembles chart rows.

Both are supposed to read from the same general-purpose engine
layer. v1 and v2 are supposed to be deletable.

**The residual coupling breaks that principle.** See §3.

## 3. Current dependency map (verified by direct code inspection, 20-Apr-26)

### 3.1 BE CF entry point

[`handle_conditioned_forecast`](../../graph-editor/lib/api_handlers.py)
at `api_handlers.py:2068`:

| Call site (line) | Imported from | Tier per doc 29e |
|---|---|---|
| 2088 | `compute_cohort_maturity_rows_v3` ← `cohort_forecast_v3` | v3 (engine consumer) — expected |
| 2089 | `compose_path_maturity_frames` ← `span_evidence` | **FROZEN INFRA** |
| 2279 | `find_edge_by_id` ← `cohort_forecast` | **FROZEN v1** |
| 2291 | `compose_span_kernel`, `_build_span_topology`, `mc_span_cdfs` ← `span_kernel` | **FROZEN INFRA** |
| 2316 | `span_kernel_to_edge_params` ← `span_adapter` | **FROZEN INFRA** |
| 2317 | `build_span_params` ← `cohort_forecast_v2` | **FROZEN v2 — direct violation** |
| 2350 | `_build_span_topology`, `mc_span_cdfs` ← `span_kernel` | **FROZEN INFRA** |
| 2362 | `XProvider`, `get_incoming_edges`, `read_edge_cohort_params` ← `cohort_forecast` | **FROZEN v1** |
| 2467 | `_last_forensic` ← `forecast_state` | engine |

### 3.2 v3 row builder

[`compute_cohort_maturity_rows_v3`](../../graph-editor/lib/runner/cohort_forecast_v3.py)
at `cohort_forecast_v3.py:466-467`:

| Imported from | Tier |
|---|---|
| `find_edge_by_id, XProvider, build_x_provider_from_graph` ← `cohort_forecast` | **FROZEN v1** |
| `build_upstream_carrier` ← `cohort_forecast_v2` | **FROZEN v2 — direct violation** |

### 3.3 Engine

[`compute_forecast_trajectory`](../../graph-editor/lib/runner/forecast_state.py)
at `forecast_state.py:312-313`:

| Imported from | Tier |
|---|---|
| `build_upstream_carrier` ← `cohort_forecast_v2` | **FROZEN v2 — direct violation** (inside the engine itself) |
| `read_edge_cohort_params` ← `cohort_forecast` | **FROZEN v1** |

### 3.4 Summary

Three distinct v2 symbol uses are reachable at runtime:

1. `build_span_params` — called by `handle_conditioned_forecast`
   directly.
2. `build_upstream_carrier` — called by `compute_cohort_maturity_rows_v3`.
3. `build_upstream_carrier` — called by `compute_forecast_trajectory`
   (the engine itself).

Plus the entire "frozen infrastructure" tier (v1 carrier helpers,
span_kernel, span_evidence, span_adapter) is consumed by both the
CF handler and v3.

## 4. Why this matters

### 4.1 v2 cannot retire

Doc 29e Phase 5.5 exit requires v2 to be deletable. It isn't. Every
CF request hits `build_span_params`; every v3 chart request hits
`build_upstream_carrier` via both the row builder and the engine.

### 4.2 Defects in v2 are operational

Doc 50 truth-parity testing (20-Apr-26) uncovered a systematic
undershoot on laggy edges, visible in both all-laggy fixtures
(`synth-simple-abc` Δ≈0.10) and mixed fixtures (`cf-fix-deep-mixed`
laggy edges Δ≈0.05-0.08 at long windows; up to 0.68 on cohort-mode
terminal edges).

Root cause traced to [span_adapter.py:98-117](../../graph-editor/lib/runner/span_adapter.py#L98-L117)
+ [cohort_forecast_v2.py:73-90](../../graph-editor/lib/runner/cohort_forecast_v2.py#L73-L90):
both read `p.posterior.alpha/beta` (Bayesian-only), and when absent,
fall back to **κ = 20** centred on `span_p`. The resolver's
analytic α/β from evidence.n/k (via D20 fallback in
`model_resolver.py`) is ignored. On synth-simple-abc that analytic
posterior has α=224,802, β=95,497 — 4 orders of magnitude more
informative than κ=20. The sweep's IS proposal is accordingly
wide, and IS weights cannot recover the true rate from per-cohort
likelihoods.

The defect is fixable in place — but the freeze rule forbids
modifying the module where it lives. This is the concrete cost of
the coupling: we can see the bug, can't remediate it without
violating the rule.

### 4.3 Any new analysis that depends on the engine inherits the coupling

Docs 52 (funnel v2) and 54 (CF readiness protocol) assume a clean
engine + CF layer. Building on the current coupling would pull v1/v2
into the new analyses' dependency graph.

## 5. What the clean end state looks like

Design intent:

- **engine layer** (`forecast_state.py` + sibling helpers) —
  general-purpose, reads `ResolvedModelParams`, produces trajectories.
- **row builder layer** (v3, and eventual v3-style builders for other
  analyses) — thin consumers of the engine.
- **handler layer** (CF, topo pass, analysis runners) — orchestration
  only. No engine-internal imports.

Every v1/v2 symbol currently imported by the CF handler, v3, or the
engine needs a counterpart in the engine layer. The engine has the
resolver's α/β available; it should construct its own prior and
carrier without help from v1/v2.

Specifically, the three v2 dependencies need replacement:

- `build_span_params` (handler-level) → engine-level prior
  construction keyed on `ResolvedModelParams` directly, incorporating
  the analytic α/β fallback the resolver already knows about.
- `build_upstream_carrier` (×2 call sites) → engine-level carrier
  construction keyed on the span kernel output and per-edge
  parameters, without a v2 detour.

The "frozen infrastructure" tier (`span_kernel`, `span_evidence`,
`span_adapter`, `cohort_forecast` carrier helpers) needs a decision:
either (a) promote its contents into the engine layer permanently
(and drop the "frozen" label), or (b) rewrite the subset the engine
needs, and delete the rest alongside v1/v2. Doc 29e Phase 5.5
anticipated (b); reality is closer to (a).

## 6. Resolved migration decisions

This plan adopts a **partial-retirement boundary**.

1. **The freeze rule remains operative for `cohort_forecast_v2.py`.**
   The module stays frozen as a parity oracle. The migration removes
   production imports of v2 helpers; it does not fix live behaviour by
   patching v2 in place.

2. **v2 retirement remains the target.** `cohort_forecast_v2.py` is not
   accepted as permanent runtime infrastructure. It exists only until
   the new runtime layer has taken over its remaining production jobs.

3. **`span_kernel.py` and `span_evidence.py` are promoted.** They are
   no longer treated as disposable transitional scaffolding. They are
   the permanent span-composition and evidence-composition
   infrastructure used by the general engine.

4. **`span_adapter.py` is not promoted.** It is transitional by design
   and must be deleted as part of this migration. The live handler must
   stop converting `SpanKernel` back into v2-shaped edge params.

5. **`cohort_forecast.py` is not promoted wholesale.** Any small graph
   or carrier helpers still needed by production callers are re-homed
   into a neutral runtime module. Production CF, v3, and engine paths
   must reach zero imports from `cohort_forecast.py`.

6. **The κ=20 defect is fixed structurally, not locally.** The live
   span-prior path is rebuilt on top of `ResolvedModelParams`, so the
   resolver's D20 fallback for analytic α/β becomes the canonical prior
   source. No production path should continue to derive a span prior
   from v2's weak default when resolver evidence exists.

7. **No new engine consumers land before the cut-over gates pass.**
   Docs 52 and 55 remain blocked on this migration. Doc 47 may proceed
   only on the new boundary, not by adding more imports from v1/v2.

## 7. Target module boundaries after migration

The intended runtime boundary is:

- `forecast_state.py` remains the engine maths layer. It may depend on
  `model_resolver.py`, promoted span infrastructure, and a new neutral
  runtime helper module. It must not import from
  `cohort_forecast.py` or `cohort_forecast_v2.py`.

- A new `forecast_runtime.py` becomes the only place that assembles
  live forecast inputs around the engine. It owns resolver-driven span
  prior construction, upstream-carrier construction, node-arrival input
  assembly, and any tiny graph helpers still needed by both v3 and the
  CF handler.

- `span_kernel.py` is the permanent home for deterministic and MC span
  CDF composition.

- `span_evidence.py` is the permanent home for frame and maturity
  evidence composition.

- `cohort_forecast_v3.py` becomes a thin row builder only. It may call
  the engine and the new runtime layer, but it must not import from
  `cohort_forecast.py` or `cohort_forecast_v2.py`.

- `handle_conditioned_forecast` in `api_handlers.py` remains an
  orchestration layer only. It may build scenario inputs, run subject
  resolution, and delegate to the runtime layer plus engine. It must
  not reconstruct v2-era span params or carrier inputs locally.

- `cohort_forecast_v2.py` remains as a parity oracle during migration
  and is deleted at the end.

- `span_adapter.py` is deleted at the end.

- `cohort_forecast.py` is either deleted with v1 retirement or reduced
  to dev-only legacy chart support during a short overlap. In either
  case it is not an acceptable dependency of the production engine, CF,
  or v3 paths.

## 8. Specific implementation plan

### Phase 0 — Lock the target with red tests and oracle captures

Start by writing the migration tests before editing the live callers.
The point of this phase is to freeze the desired boundary and the
numeric oracle before the refactor begins.

- Add focused tests for the three behaviours that currently leak
  through the legacy helpers: resolver-driven span prior
  concentration, carrier-tier selection, and chart-versus-CF parity on
  the same edge.

- Extend the existing doc 50 fixture coverage so the laggy-edge
  undershoot remains visible throughout the migration rather than being
  hidden behind green structural tests.

- Add a dependency-audit test or script for the production forecast
  stack. Its target is explicit: after cut-over, `forecast_state.py`,
  `cohort_forecast_v3.py`, and the CF handler must have no imports from
  `cohort_forecast_v2.py`, `span_adapter.py`, or `cohort_forecast.py`.

- Record the current v2-oracle outputs on the existing parity fixtures
  before any refactor begins. These captured outputs become the
  comparison baseline for the new runtime layer.

The exit gate for Phase 0 is that the new tests exist, the intended red
cases have been observed against the current implementation, and the
existing parity harnesses still pass on the baseline code.

### Phase 1 — Introduce the neutral runtime layer with no caller cut-over

Create `forecast_runtime.py` and move the remaining production-worthy
runtime assembly into it without changing the live engine, v3, or CF
caller paths yet.

- Port the v2-only span-prior job into the new runtime layer. The new
  implementation reads `ResolvedModelParams` directly and derives its
  concentration from the resolver output rather than from v2's
  Bayesian-only extraction path.

- Port the upstream-carrier job into the same runtime layer. The new
  implementation accepts resolved upstream inputs plus optional
  empirical observations, preserving the current Tier 1, Tier 2, and
  Tier 3 behaviour but removing the dependency on the v2 module.

- Re-home any tiny production graph helpers currently being pulled from
  `cohort_forecast.py` so that later cut-over work does not need to
  keep importing the legacy file for incidental utilities.

- Keep `span_kernel.py` and `span_evidence.py` unchanged in behaviour
  but update their role in the docs and comments: they are now promoted
  runtime infrastructure rather than frozen transitional scaffolding.

The exit gate for Phase 1 is that the new runtime module reproduces the
legacy carrier behaviour on the parity fixtures, uses resolver-derived
α/β on the D20 cases, and is ready to take over callers one by one.

### Phase 2 — Cut the engine over first

Move `forecast_state.py` off the legacy helpers before touching the row
builder or the CF handler. The engine is the strictest boundary in the
system; once it is clean, later callers become straightforward.

- Rewrite `build_node_arrival_cache` to use the new runtime-layer
  carrier builder and resolver-derived upstream inputs.

- Remove the engine's imports from `cohort_forecast_v2.py` and
  `cohort_forecast.py`.

- Keep the externally visible engine contract unchanged. This phase is
  about runtime ownership, not a semantic redesign of the sweep.

- Re-run the engine-level tests and the doc 50 fixtures immediately
  after the cut-over so any carrier drift is caught before the
  row-builder and handler changes are layered on top.

The exit gate for Phase 2 is that `forecast_state.py` is clean of
v1/v2 imports, engine tests stay green, and the existing parity and
truth suites do not regress beyond the known laggy-edge bias already
tracked by doc 50.

### Phase 3 — Cut v3 and the CF handler over to the same runtime layer

Once the engine is clean, move the two production callers that still
assemble forecast inputs through legacy modules.

- Rewrite `cohort_forecast_v3.py` so its carrier construction,
  x-provider preparation, and any residual graph helpers come from the
  new runtime layer rather than from `cohort_forecast.py` or
  `cohort_forecast_v2.py`.

- Rewrite `handle_conditioned_forecast` so it stops routing `SpanKernel`
  through `span_adapter.py` and stops calling v2's
  `build_span_params`. The handler should assemble span priors directly
  from `SpanKernel` plus resolved model params through the runtime
  layer.

- Centralise the shared per-edge preparation between CF and v3 on the
  runtime layer. This is the point of the migration: one runtime path
  feeding both callers, not two slightly different pieces of handler
  glue.

- Re-run the v2-v3 parity harness, the doc 50 topology suite, and the
  truth-parity suite after the caller cut-over. The new boundary is not
  accepted until the migrated callers remain numerically coherent.

The exit gate for Phase 3 is that the live production forecast stack
has zero runtime imports from `cohort_forecast_v2.py`,
`span_adapter.py`, and `cohort_forecast.py`, while the existing parity
and topology suites remain green.

### Phase 4 — Delete transitional code and update the programme docs

Only after the production callers are clean and the parity gates are
green should the legacy files be removed.

- Delete `cohort_forecast_v2.py` and its remaining dev-only handler
  path.

- Delete `span_adapter.py`.

- Delete `cohort_forecast.py` if no dev-only legacy path still needs
  it. If a short overlap is required for v1 verification, reduce it to
  that role explicitly and track its final deletion as a small follow-on
  task. What is not acceptable after this phase is any production
  engine, CF, or v3 import from that file.

- Update doc 29e so the old "frozen with v2" wording no longer claims
  that `span_kernel.py` and `span_evidence.py` are transitional.

- Update doc 29f so its status section and dependency discussion match
  the new runtime boundary rather than the legacy-coupled one.

The exit gate for Phase 4 is that the deleted modules are absent, the
remaining docs describe the new truth, and the full forecast regression
suite is green on the post-deletion tree.

### Phase 5 — Resume blocked consumer work on the new boundary

After Phase 4, the forecast stack is clean enough for new consumers.

- Resume doc 47 implementation on top of the runtime layer rather than
  on top of v2-era helper imports.

- Resume doc 52 funnel work and doc 55 surprise-gauge work, now that
  both can consume CF and engine outputs without inheriting the old
  coupling.

- Keep doc 50 truth-parity in the regression set permanently so the
  next round of consumer work cannot hide another runtime leak behind
  structural green tests.

The exit gate for Phase 5 is not a new code boundary. It is simply that
all downstream feature work now lands on the cleaned runtime stack.

## 9. Blocking gates for the migration

The migration is not complete until all of the following are true:

- The resolver-driven span prior path is the only production path and
  the κ=20 fallback no longer appears when resolver α/β exists.

- Carrier parity remains acceptable across Tier 1, Tier 2, and Tier 3
  fixtures after the runtime cut-over.

- The existing v2-v3 parity harness stays green throughout the refactor.

- `cf-topology-suite.sh` stays green and `cf-truth-parity.sh` remains
  green for the lagless and mixed-topology fixtures already landed by
  doc 50.

- The production dependency audit shows zero imports from
  `cohort_forecast_v2.py`, `span_adapter.py`, and `cohort_forecast.py`
  in `forecast_state.py`, `cohort_forecast_v3.py`, and the CF handler.

- Docs 29e and 29f have been updated to reflect the new runtime truth.

## 10. What remains out of scope

- A redesign of CF semantics. This plan changes runtime ownership and
  dependency boundaries, not the higher-level meaning of the CF pass.

- New consumer features from docs 47, 52, and 55. Those resume only
  after the migration gates above are green.

- A separate arithmetic investigation beyond the structural κ=20 fix.
  If laggy-edge bias remains after the runtime cut-over, it is a new
  engine-accuracy issue, not a reason to reintroduce legacy helpers.
