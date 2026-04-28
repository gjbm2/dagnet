# 73g — General-purpose F14 problem statement and invariants

**Status**: Active problem statement — no implementation plan yet  
**Date opened**: 28-Apr-26  
**Parent investigation**: [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md)  

## Purpose

This note freezes the problem statement and invariants for reattempting F14 after a failed implementation attempt introduced fork-shaped thinking. It exists to stop further work until the current BE conditioned forecast path is analysed against the semantic contract and the first violated runtime object is named.

This is not a fix plan. It is the minimum contract for any later fix plan.

## Required context

Any agent or human working on this must read these first:

- [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — semantic source of truth for `window()` / `cohort()`, `carrier_to_x`, `subject_span`, and factorised vs gross-fitted numerator representations.
- [`docs/current/project-bayes/59-cohort-window-forecast-implementation-scheme.md`](59-cohort-window-forecast-implementation-scheme.md) — target runtime object contract and projection responsibilities for first-class forecast consumers.
- [`docs/current/codebase/STATS_SUBSYSTEMS.md`](../codebase/STATS_SUBSYSTEMS.md) — subsystem boundary: FE topo, BE CF pass, and BE analysis runners are distinct, with CF owning conditioned `p.mean` when it lands.
- [`docs/current/codebase/BE_RUNNER_CLUSTER.md`](../codebase/BE_RUNNER_CLUSTER.md) — runner-cluster map for `forecast_runtime.py`, `forecast_state.py`, `cohort_forecast_v3.py`, and public-vs-inner entry points.
- [`docs/current/project-bayes/45-forecast-parity-design.md`](45-forecast-parity-design.md) — design intent that graph `p.mean` and cohort maturity `p@∞` are projections of the same conditioned forecast machinery.
- [`docs/current/project-bayes/73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) — empirical F9/F13/F14 evidence and current outside-in canary suite.

## Problem statement

F14 is a semantic failure in the BE conditioned forecast path for rates of the form `Y / X`.

The engine is supposed to build one resolved forecast object:

`population_root -> carrier_to_x -> subject_span -> numerator_representation -> p_conditioning_evidence -> projection`

and then project that same object into chart rows, CF scalar responses, and graph fields.

Current outside-in failures show that this contract is not being preserved. In particular, CF can return a public `p.mean` / `p_infinity_mean` that behaves like raw under-matured `Σy / Σx`, rather than the maturity-aware subject rate `p∞` for `X -> end`.

Concrete observed symptom from [`73f`](73f-outside-in-cohort-engine-investigation.md):

- Query: `from(simple-a).to(simple-b).window(-90d:)`
- Truth / FE analytic baseline: approximately `0.70`
- Raw under-matured count ratio: `144516 / 265035 ≈ 0.545`
- CF public scalar: approximately `0.546`

So the public BE output is effectively pinned to raw immature evidence, even though the semantic question is the mature edge rate. The same class appears in identity-collapse and low-evidence cohort cases, so this is not a one-off window-mode issue and not explained by carrier reach scaling alone.

The task is not to patch a row, scalar, or fixture. The task is to trace the single general runtime object and find where it stops preserving the semantic roles.

## Invariant statement

Any proposed change that violates one of these invariants is wrong, even if a focused test turns green.

1. **There is one general forecast machinery path.**  
   No parallel logic for window, cohort, single-hop, multi-hop, scalar projection, chart rows, or fixtures. Cases may differ only by natural degeneration of the same objects.

2. **The displayed rate is always `Y / X`, never `Y / A`.**  
   `cohort()` changes the selected population and time origin. It does not change the meaning of the displayed rate.

3. **`carrier_to_x` owns denominator arrival.**  
   For `cohort(A, X -> end)`, `carrier_to_x` answers “who reaches X by tau?”. In `window()` and `A = X`, this degenerates to identity.

4. **`subject_span` owns numerator progression.**  
   The subject object answers “given mass at X, when does it reach end?”. Single-hop is one edge. Multi-hop is the full `X -> Z` span. It must not silently become the last edge or an anchor-rooted whole-query object.

5. **Factorised and gross-fitted numerator representations are mutually exclusive.**  
   If factorised, Pop C and Pop D are additive future terms. If gross-fitted, Pop C and Pop D must not be re-added.

6. **Evidence binding must match the object it conditions.**  
   Raw under-matured `y_frozen/x_frozen` must not be treated as mature evidence for `p∞`. Completeness belongs inside the likelihood/evidence semantics, not as a post-hoc display patch.

7. **Projection must not re-decide semantics.**  
   Chart rows, CF scalar responses, and graph-enrichment fields must be projections of the already-resolved runtime object. They must not contain their own carrier, subject-span, or `p∞` logic.

8. **Tests must prove semantic contracts, not implementation quirks.**  
   A passing test is only meaningful if it exercises the public path and asserts one of these invariants.

## Required forensic trace before implementation

Before any further F14 code changes, trace at least these two failing public queries:

1. `from(simple-a).to(simple-b).window(-90d:)`
2. `from(simple-b).to(simple-c).cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)`

For each query, record the actual runtime object state:

- `population_root`
- `carrier_to_x`
- `subject_span`
- `numerator_representation`
- `p_conditioning_evidence`
- prior source and evidence basis used for the rate update
- projection consumed by `cohort_maturity` rows
- projection consumed by `conditioned_forecast` / graph `p.mean`

The first implementation step must be at the first object whose actual state contradicts the invariants above. No downstream projection patch is acceptable unless the upstream object state is already proven correct.
