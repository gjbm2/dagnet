# 73o — Carrier state cache performance plan

**Status**: Implementation plan, pending review  
**Date opened**: 30-Apr-26  
**Depends on**: [`73m-carrier-composition-and-router-unification-implementation-plan.md`](73m-carrier-composition-and-router-unification-implementation-plan.md)  
**Semantic dependency**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md)  
**Parent problem statements**: [`73h-v3-router-and-carrier-conditioning-forensic.md`](73h-v3-router-and-carrier-conditioning-forensic.md), [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md)  
**Semantic source of truth**: [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)  

## Purpose

73m fixes carrier composition and router unification. 73n fixes carrier evidence conditioning, including reach/probability when closure is claimed. This plan is separate: it makes whole-graph CF and related runtime paths reuse already-resolved carrier and node-arrival state within one scenario/query solve instead of rebuilding equivalent upstream objects repeatedly.

The goal is performance, consistency, and observability. It is not a semantic prerequisite for 73m or 73n correctness tests. An uncached implementation may pass all correctness gates if it constructs the same resolved objects. This plan exists because repeated reconstruction is wasteful and increases the chance that equivalent consumers accidentally read different carrier contracts.

The desired end state is a pass-local topological carrier-state cache:

- scoped to one scenario, query DSL, as-at boundary, context/regime selection, and carrier-conditioning policy;
- populated in topological order from the same resolved runtime objects that projection consumes;
- read by downstream carrier consumers instead of recomposing the same `A -> X` state from scratch;
- discarded at the end of the solve.

## Non-goals

This plan does not condition carrier reach. That belongs to 73n.

It does not change the meaning of the displayed rate. The displayed rate remains `Y / X`.

It does not make graph `p.mean` a carrier input. Carrier state must be built from typed runtime objects, not from projection fields.

It does not introduce a persistent cross-query cache, IndexedDB cache, file cache, or process-global memo that survives a scenario solve.

It does not relax evidence identity, as-at, context, regime, or population identity rules. Cache hits are valid only after those identities have already matched.

It does not attempt to optimise every repeated span computation in the codebase. The first target is carrier and node-arrival state used by whole-graph CF, scoped CF, and cohort_maturity/v3 surfaces that already share the 73m/73n runtime contract.

## Core design contract

The cache stores resolved runtime state, not raw inputs and not projection outputs.

For each relevant population root and denominator node, the cached state may include:

- the identity carrier for `window()` and `A = X`;
- the composed prior carrier from 73m;
- the conditioned carrier from 73n when a carrier-conditioning policy has been selected;
- the node-arrival state derived from that carrier;
- compact diagnostics describing source, conditioning policy, reach prior, conditioned reach, timing source, horizon adequacy, and cache provenance.

The cache must preserve the same semantic split as 73m and 73n:

- `carrier_to_x` owns denominator arrival at `X`;
- `subject_span` owns progression from `X` to the subject end;
- `p_conditioning_evidence` owns which subject evidence may move subject rate;
- projection reads the resolved objects and must not re-decide carrier semantics.

A cache hit is allowed only when the cached object's semantic identity is exactly the identity the caller would otherwise resolve. It is better to miss than to share across an unsafe boundary.

## Cache identity

Cache identity must include every dimension that can change the resolved carrier object.

Minimum identity dimensions:

- scenario id or request scope;
- query mode and temporal origin;
- population root or anchor node;
- denominator node `X`;
- selected date bounds and anchor-day set where applicable;
- as-at boundary;
- context, case, regime, and hash-family selection;
- selected population identity or selector hash where available;
- graph/source version for model parameters consumed by the carrier;
- source preference and promoted source decision;
- carrier-conditioning policy from 73n;
- carrier evidence role, observation-shape policy, and evidence identity summary when 73n conditioning is active;
- draw family or deterministic-summary flavour when the caller distinguishes particle and deterministic objects;
- horizon and tau grid used to build the CDF arrays.

The identity must not be a loose string assembled from display labels. It should be built from the same structured scope objects used by the evidence merge and runtime bundle. If an identity dimension is unavailable, the implementation should miss the cache or mark the object non-cacheable rather than widening reuse.

## Correctness invariants

Cached and uncached solves must be numerically equivalent within the same tolerances used by the underlying stochastic path. If the same random seed and draw family are used, cached and uncached deterministic summaries should match exactly except for known floating-point ordering effects.

The cache must not change whether evidence is admitted, rejected, or used to condition reach, timing, or subject rate.

The cache must not allow one scenario, as-at boundary, context, regime, or selected population to reuse another's carrier state.

The cache must not convert a prior carrier into a conditioned carrier or a conditioned carrier into a prior carrier. Prior-vs-conditioned status is part of the cache identity and diagnostics.

The cache must not pair carrier and subject particles after separate resampling in a way forbidden by 73n. If 73n selected a joint particle policy, the cached carrier state must preserve the joint draw identity required by that policy.

The cache must be pass-local and bounded. It must be cleared when the scenario solve completes or fails.

## Stage 0 — Baseline and inventory

Stage 0 records where repeated carrier and node-arrival construction happens before any implementation changes.

Inventory the live carrier construction and consumption surfaces after 73m/73n:

- whole-graph CF carrier/node-arrival construction;
- scoped CF carrier preparation;
- cohort_maturity v3 runtime preparation;
- any remaining `XProvider` or node-arrival helper surfaces;
- diagnostics and projection surfaces that expose carrier provenance.

Record focused baseline timings and counters for representative queries:

- identity carrier (`window()` or `A = X`);
- single-hop cohort with active carrier;
- multi-hop cohort with active carrier;
- fan-in or multi-path carrier;
- one large whole-graph CF traversal where repeated recomposition is visible.

Stop condition: the plan has a current call-site inventory, baseline recomposition counts, and baseline wall-clock numbers. No cache implementation begins until the target surfaces and measurements are explicit.

## Stage 1 — Cache identity and diagnostics contract

Stage 1 defines the structured cache identity and diagnostic shape before introducing cache hits.

The identity must be testable without relying on logs. Tests should be able to inspect why two requests share a cache entry or miss.

Diagnostics should expose:

- cache enabled or disabled;
- cache key summary;
- hit, miss, bypass, or non-cacheable reason;
- carrier object source;
- prior-vs-conditioned status;
- reach prior and conditioned reach summary when present;
- timing source;
- draw family or deterministic flavour;
- horizon and tau grid;
- scenario and as-at scope.

Stop condition: pure identity tests prove that distinct scenarios, as-at boundaries, contexts, regimes, selected populations, carrier-conditioning policies, and horizons do not share cache entries.

## Stage 2 — Pass-local cache shell

Stage 2 introduces the pass-local cache container without changing carrier semantics.

The cache lifecycle is:

- create at the start of one scenario/query solve;
- pass explicitly through runtime preparation surfaces that may need carrier state;
- store only resolved carrier or node-arrival objects;
- clear when the solve completes or errors.

The cache must not be module-global ambient state. It must be explicit enough that tests can run two solves in one process without cross-contamination.

For the first implementation, cache misses should call the existing uncached construction path and store the returned object. Cache bypass should be available for parity tests and diagnostics.

Stop condition: with cache enabled but no consumers reading hits yet, public output is unchanged and diagnostics show only controlled misses or bypasses.

## Stage 3 — Read-through carrier reuse

Stage 3 wires read-through cache access into carrier construction surfaces.

On a miss, the construction path builds the same object it would have built before and stores it. On a hit, the caller receives the cached object and must not recompute an equivalent carrier in parallel.

The first live consumers should be the carrier and node-arrival paths identified in Stage 0. Partial rollout is allowed only if diagnostics make the remaining uncached surfaces visible; silent mixed contracts are not allowed.

Stop condition: focused parity tests prove cached and uncached outputs match for identity, single-hop active-carrier, multi-hop active-carrier, and fan-in/multi-path cases. Diagnostics must show at least one real hit on a query that previously recomposed the same carrier state.

## Stage 4 — Conditioned carrier compatibility

Stage 4 verifies compatibility with 73n's selected carrier-conditioning policy.

If 73n selected Policy A or Policy B, cache identity must still distinguish unconditioned, provenance-only, and timing-conditioned carriers.

If 73n selected Policy R, cache identity must include the reach prior/posterior representation and evidence identity summary. A cached Policy R carrier must preserve conditioned reach and must not fall back to topological reach on hit.

If 73n selected Policy C, cache identity must preserve the particle draw coupling required by the joint carrier/subject posterior. A cache hit must not detach carrier particles from the subject particle family when the selected policy requires joint resampling.

Stop condition: reach-conditioning and particle-coupling tests from 73n pass with cache enabled and disabled, and cached diagnostics prove the conditioned object, not the prior object, was reused.

## Stage 5 — Whole-graph CF integration

Stage 5 applies the cache to the whole-graph CF traversal where repeated upstream carrier work is most expensive.

The traversal should still process subjects in topological order. The cache is an optimisation of object reuse, not a replacement for topological ordering.

Downstream subjects should consume cached upstream carrier or node-arrival state when the identity matches. The implementation must not read downstream graph projection fields as a shortcut for carrier state.

Stop condition: whole-graph CF parity holds with cache enabled and disabled across the representative Stage 0 queries, and recomposition counters drop on the large traversal without changing `p_mean`, completeness, evidence totals, provenance, or row projections beyond accepted stochastic tolerance.

## Stage 6 — Scoped CF and cohort_maturity surfaces

Stage 6 extends cache usage to scoped CF and cohort_maturity/v3 only where it reuses the same runtime identity rules.

These surfaces may have less repeated work than whole-graph CF, so performance improvement is not the main acceptance criterion. The main goal is avoiding parallel construction contracts.

Stop condition: scoped CF, cohort_maturity v3, and whole-graph CF diagnostics name the same carrier object identity for the same semantic request, whether the object was built fresh or read from cache.

## Stage 7 — Performance acceptance

Stage 7 records performance outcomes after correctness parity is proven.

Required measurements:

- carrier composition count before and after caching;
- node-arrival construction count before and after caching;
- wall-clock time for the large traversal baseline;
- memory footprint or cache entry count for the same traversal;
- hit/miss/bypass counts by surface.

The plan succeeds only if performance improves without hiding semantic work. A small wall-clock gain is acceptable if recomposition count drops and parity is exact; a large gain is not acceptable if diagnostics become unable to explain which carrier object was consumed.

Stop condition: performance report is attached to the implementation record, and any query where caching is bypassed has an explicit reason.

## Review checklist

Reviewers should reject an implementation if:

- cache identity omits scenario, as-at, context, regime, selected population, conditioning policy, or horizon dimensions;
- cached objects survive beyond one scenario/query solve;
- cache hits read or write graph `p.mean` as carrier input;
- prior and conditioned carriers can share a cache entry;
- Policy R conditioned reach is lost on cache hit;
- Policy C joint particle coupling is broken by cache reuse;
- tests compare only cached output to itself rather than cached versus uncached output;
- diagnostics cannot say whether a carrier object was built fresh, hit, missed, bypassed, or non-cacheable;
- performance claims are made without recomposition counters or wall-clock baselines;
- cache implementation changes reach, timing, evidence admission, subject `p`, or projection semantics.

