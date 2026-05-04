# 73n Stage 7 — Primitive and Composition Caching — note

**Status**: Stage 7 landed. Process-memory cache layer for primitive posteriors and composed carrier/subject objects. Existing snapshot DB cache machinery generalised into a reusable utility (`lib/result_cache.py`); snapshot, primitive, composed-carrier, composed-subject caches all register under a single registry. Cache invalidation is coarse-grained on purpose: any `cache_clear()` call (snapshot writes, the existing `/api/snapshots/cache-clear` endpoint, or the per-request `no_cache: true` body flag's bypass) flushes every registered cache via `result_cache.clear_all()`. The plan §735 list of invalidation triggers is handled by scope-bearing keys (changes to scope = different key = miss), with TTL bounding staleness for unchanged-scope cases. The plan §739 stop condition's "an unrelated primitive's cache entry survives" clause is intentionally NOT met — softened to "TTL + scope-bearing keys + bustcache via clear_all" per user direction (see §3 below).
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 7 — Primitive and Composition Caching" lines 729-739
**Stage 0c contracts**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §3.3 (numeric tolerances)
**Stage 1-6 inputs**: [`73n-stage-1-note.md`](73n-stage-1-note.md), [`73n-stage-2-note.md`](73n-stage-2-note.md), [`73n-stage-3-note.md`](73n-stage-3-note.md), [`73n-stage-4-note.md`](73n-stage-4-note.md), [`73n-stage-5a-note.md`](73n-stage-5a-note.md), [`73n-stage-5b-note.md`](73n-stage-5b-note.md), [`73n-stage-5c-note.md`](73n-stage-5c-note.md), [`73n-stage-6-note.md`](73n-stage-6-note.md)

---

## 1. Stage 7 deliverables

### 1.1. Generic TTL result-cache utility

[`graph-editor/lib/result_cache.py`](../../graph-editor/lib/result_cache.py) — extracted from the cache machinery that previously lived inline in `snapshot_service.py`. Public surface:

- `make_cache(name, *, ttl_s, max_entries, log_prints) → ResultCache` — creates and registers a named cache. Idempotent: the same name returns the same instance, so module re-imports under reload do not orphan caches.
- `ResultCache` — instance owns its own dict + lock + stats counters. `get(key) → (hit, value)`, `put(key, value, ttl_s=None)`, `clear() → stats`, `stats() → dict`. TTL + oldest-expiry eviction matches the existing snapshot-cache pattern exactly.
- `clear_all() → aggregate_stats` — flushes every registered cache. **The bustcache hook**: snapshot writes (`append_snapshots`, `delete_snapshots`) call this so caches in every other registered subsystem are flushed in lockstep with the data they consume.
- `clear(name)`, `get_cache(name)`, `stats_all()` — registry helpers.
- `make_key(fn_name, *args, **kwargs) → str` — deterministic SHA-256-truncated key from a function name + arguments (JSON `sort_keys`, `default=str`).
- `cache_bypass_ctx`, `set_cache_bypass(bypass=True)`, `reset_cache_bypass(token)`, `is_cache_bypassed()` — shared ContextVar bypass. Every registered cache observes it. The dev middleware's `?no-cache=1` URL param and `_handle_runner_analyze`'s body-level `no_cache: true` flag both flow through this same ContextVar (no per-cache plumbing required).

`_reset_registry_for_tests()` — test-only helper, NOT part of the production surface. Production code must not call it; orphaning ResultCache instances held by importers leads to silent divergence between a stale local handle and a freshly-registered cache of the same name.

### 1.2. Snapshot-service migrated onto the utility

[`graph-editor/lib/snapshot_service.py`](../../graph-editor/lib/snapshot_service.py) — local cache machinery replaced with a single `result_cache.make_cache('snapshot', ...)` call and thin wrappers preserving the existing public surface:

- `_cache_get`, `_cache_put`, `_cache_key` — delegate to the registered `_snapshot_cache` instance.
- `cache_clear()` — now delegates to `result_cache.clear_all()`. **Behavioural change**: previously flushed only the snapshot cache and returned per-cache flat stats; now flushes every registered cache (snapshot + primitive + composed-carrier + composed-subject) and returns aggregate stats `{caches_cleared: [...], total_entries_cleared: N}`. The snapshot-write call sites at [snapshot_service.py:494](../../graph-editor/lib/snapshot_service.py#L494) (`append_snapshots`) and [snapshot_service.py:1929](../../graph-editor/lib/snapshot_service.py#L1929) (`delete_snapshots`) inherit the broader flush automatically. The `/api/snapshots/cache-clear` endpoint at [api_handlers.py:5218](../../graph-editor/lib/api_handlers.py#L5218) likewise.
- `cache_stats()` — still returns just the snapshot cache's stats (backwards-compatible read).
- `cache_bypass_ctx`, `set_cache_bypass`, `reset_cache_bypass` — re-exported from `result_cache`. The `dev-server.py` middleware import at [dev-server.py:90](../../graph-editor/dev-server.py#L90) and the body-level bypass at [api_handlers.py:619](../../graph-editor/lib/api_handlers.py#L619) continue to work unchanged.

### 1.3. Primitive posterior cache (Stage 3 wrapper)

[`graph-editor/lib/runner/primitive_conditioning.py`](../../graph-editor/lib/runner/primitive_conditioning.py) gains:

- `_primitive_cache = result_cache.make_cache('primitive', ttl_s=15*60, max_entries=1024)` — registered under the shared registry, so `clear_all()` reaches it.
- `_primitive_cache_key(...)` — deterministic key derived from every load-bearing input that can change the conditioned posterior:
  - transition + scope + scenario_seed + draw_count via `DrawFamilyKey.canonical_string()`
  - raw evidence scope_key (from `resolution.raw_evidence_set.provenance.scope_key`)
  - weighted view summary `(evidence_scope_key, binding_policy, n_weighted_total, k_weighted_total)`
  - resolved-model priors `(alpha, beta, alpha_pred, beta_pred, n_effective)`
  - edge + path latency moments tuples `(mu, sigma, onset_delta_days, t95, mu_sd, mu_sd_pred, sigma_sd, onset_sd, onset_mu_corr)`
  - `options.timing_cdf_max_tau`, `prior_source`, `resolved_model.source`
- `condition_primitive(...)` is now a thin wrapper: builds the cache key, hits `_primitive_cache`, returns on hit, otherwise delegates to `_condition_primitive_uncached(...)` (the original body) and stores the result.

The function is deterministic given those inputs (the keyed RNG seam consumes the same `DrawFamilyKey`), so cached and uncached calls are guaranteed numerically identical — proven by `test_cached_and_uncached_results_have_identical_posterior_fields`.

### 1.4. Composed carrier cache (Stage 6 path)

[`graph-editor/lib/runner/carrier_composition.py`](../../graph-editor/lib/runner/carrier_composition.py) gains:

- `_carrier_cache = result_cache.make_cache('composed_carrier', ttl_s=15*60, max_entries=512)`.
- `_carrier_cache_key(...)` — key derived from `(anchor_canonical, x_canonical, max_tau, graph_preference, topology edge list, sorted transitions signature)` where the transitions signature flattens each `TransitionPrimitive` to `(p, mu, sigma, onset, p_sd, mu_sd, sigma_sd, onset_sd, source)`. Topology edges are extracted via the existing `_build_span_topology` call so different A→X subgraphs key distinctly even on the same graph dict.
- `compose_carrier_to_x(...)` checks the cache after topology + transitions are resolved (so the key reflects the same canonicalised inputs the body consumes). The cache check is **skipped** when MC mode is requested (`rng is not None and num_draws > 0`) because MC sampling is non-deterministic; returning a cached deterministic-mode entry would lose the `mc_cdf`. Identity short-circuits (window mode, A==X) bypass the cache entirely — they are cheap and have no composition work to amortise.
- `put` happens on both terminal return paths (composed-active and horizon-inadequate). The no-path return is not cached (no useful state to memoise).

### 1.5. Composed subject-span cache (Stage 5b/5c/6 path)

[`graph-editor/lib/runner/subject_span_composer.py`](../../graph-editor/lib/runner/subject_span_composer.py) gains:

- `_subject_span_cache = result_cache.make_cache('composed_subject_span', ttl_s=15*60, max_entries=512)`.
- `_subject_span_cache_key(...)` — key derived from `(x_node_id, end_node_id, topology edge list, [(edge_key, id(primitive)) for each consumed primitive], options.max_tau, options.cdf_renorm_tolerance)`.
  - **Per-edge `id(primitive)`** is the §417 wiring: when the primitive cache is flushed (e.g. by `snapshot_service.cache_clear`), the next `compose_subject_span` call gets newly-conditioned primitives with new in-process identities, so the composed-subject cache misses correctly. The composed cache invalidates as a consequence of the primitive cache invalidating, with no explicit dependency tracking required. Tested by `test_primitive_cache_flush_invalidates_subject_span_cache`.
- The cache check sits after the topology + primitive lookup (lines 240-269) but before the per-edge per-draw density-array allocation + DP convolution (the costly part). Both the draw-coherent and moments-only paths are cached uniformly via a single `put` at the end.

### 1.6. Tests

| File | Tests | Coverage |
|---|---|---|
| [`test_result_cache.py`](../../graph-editor/lib/tests/test_result_cache.py) | 31 | utility itself: `make_key` determinism, put/get round-trip + miss, TTL expiry, eviction, bypass via ContextVar, `clear`, `clear_all` aggregate, registry idempotency, `stats_all` |
| [`test_primitive_cache.py`](../../graph-editor/lib/tests/test_primitive_cache.py) | 16 | `condition_primitive` cache hit/miss across every load-bearing input (scenario_seed, transition, evidence, prior alpha/beta, n_effective, latency moments, options, prior_source); cached-vs-uncached numerical equivalence on posterior fields + draws; bypass via ContextVar AND via `snapshot_service.set_cache_bypass`; `clear_all` and `snapshot_service.cache_clear` flush; registry name confirmation |
| [`test_composed_cache.py`](../../graph-editor/lib/tests/test_composed_cache.py) | 15 | end-to-end `compose_carrier_to_x` and `compose_subject_span` wiring: identity-on-second-call hit; misses on changed transitions / topology / endpoints / `max_tau`; **MC mode bypasses cache** (verifies `mc_cdf` populated only when MC requested, not picked up from cached deterministic entry); cached-vs-uncached numerical equivalence on `reach`/`deterministic_cdf`/`span_p_mean`/`span_p_sd`/`cdf_mean`; **§417 invariant: primitive cache flush invalidates subject-span cache** (proven by id() change); `snapshot_service.cache_clear` flushes both composed caches across the package boundary; bypass via `snapshot_service.set_cache_bypass` propagates through the same ContextVar |

**Combined Stage 7 cache test totals**: 62 tests, all green.

**Existing-suite regression** — full primitive-substrate suite plus carrier object contract, span composer, all four readouts, audit, and the prefix-arrival tests:

```
287 passed in 7.36s
```

(Stage 6 baseline was 228; +31 result_cache + +16 primitive_cache + +15 composed_cache − +3 readout tests collected differently across the 5a→5b→5c→6 split.)

---

## 2. Stop-condition discharge

Plan §"Stage 7" stop condition (line 739):

> Stop condition: cached and uncached primitive posteriors and composed carrier/subject objects are numerically equivalent on focused fixtures, and a focused regression test mutates a snapshot row, observes that the affected primitive posterior recomputes on the next read, and observes that an unrelated primitive's cache entry survives.

| Stop-condition clause | Discharge |
|---|---|
| Cached and uncached primitive posteriors are numerically equivalent | **Discharged** by `test_primitive_cache.py::test_cached_and_uncached_results_have_identical_posterior_fields` — bypassed (uncached) and warmed (cached) calls agree on `mean`, `sd`, `draws`, `effective_evidence_totals`. Determinism of `condition_primitive` given its inputs is what makes this trivially true; the test pins it. |
| Cached and uncached composed carrier objects are numerically equivalent | **Discharged** by `test_composed_cache.py::TestCarrierCacheWiring::test_cached_and_bypassed_results_are_numerically_equivalent` — bypassed and cached calls agree on `reach`, `deterministic_cdf` (array equal), `diagnostics.tier`. |
| Cached and uncached composed subject objects are numerically equivalent | **Discharged** by `test_composed_cache.py::TestSubjectSpanCacheWiring::test_cached_and_bypassed_results_are_numerically_equivalent` — bypassed and cached calls agree on `span_p_mean`, `span_p_sd`, `primitive_count`, `cdf_mean` (array equal). |
| Snapshot mutation invalidates the affected primitive posterior; next read recomputes | **Discharged via `clear_all()`**, not per-key invalidation. Snapshot writes (`append_snapshots`, `delete_snapshots`) call `cache_clear()` which delegates to `result_cache.clear_all()`, flushing every registered cache. The next `condition_primitive` call re-conditions and produces a fresh primitive object. Tested by `test_primitive_cache.py::test_snapshot_cache_clear_flushes_primitive_cache` and the cross-boundary `test_composed_cache.py::TestCarrierCacheWiring::test_snapshot_cache_clear_flushes_carrier_cache` / `test_snapshot_cache_clear_flushes_subject_span_cache`. |
| An unrelated primitive's cache entry survives the snapshot mutation | **Intentionally NOT met** — softened to "TTL + scope-bearing keys + bustcache via clear_all" per user direction. See §3. |

---

## 3. Softening of the §739 invalidation clause

Per the dialogue that opened Stage 7, the user explicitly relaxed the plan's invalidation requirement:

> "we don't really need a sophisticated invalidation policy — snapshot writes only typically happen overnight anyway. we'll want to bust cache if user clicks 'refresh' button for an analysis (I think we do this anyway). Beyond that, I think it's pretty harmless to cache for 15 mins"

What this means in practice for Stage 7:

1. **Cache key carries scope.** Plan §405-415 enumerates the scope identity (transition id, evidence role, date bounds, context, regime, as-at, source preference, model fingerprint). Stage 7 includes every one of those in the primitive cache key, plus latency moments. Changes to any of these change the key, the next request misses, and stale entries age out via TTL or eviction.

2. **TTL bounds staleness.** Default 15 min, matching the existing snapshot cache TTL. Same trade-off the snapshot cache already accepts.

3. **Bustcache via `clear_all`.** A single call (`snapshot_service.cache_clear()`, the existing `/api/snapshots/cache-clear` endpoint, or the request-body `no_cache: true` flag's bypass) flushes every registered cache atomically. Snapshot-write boundaries already call `cache_clear()` (existing wiring at [snapshot_service.py:494, :1929](../../graph-editor/lib/snapshot_service.py#L494)) so the snapshot-mutation-flushes-primitives path is already wired.

4. **Per-key targeted invalidation NOT implemented.** The plan §739 "an unrelated primitive's cache entry survives" is the property a per-key policy would deliver; we have not added one. With `clear_all`, snapshot writes flush ALL primitives, including unrelated ones. The cost is that warm-cache hits are forfeited at the next read after each write. In practice (per user reasoning) snapshot writes happen overnight, so warm-cache state during working hours is rarely affected by writes.

5. **The deliberate-write-during-working-hours case** (e.g. user clicks "refresh & re-fetch" then immediately runs analysis) is covered by the same `cache_clear()` call sites: any code path that ends up writing through `snapshot_service.append_snapshots` or `delete_snapshots` invokes `cache_clear()` automatically. The user-driven `no_cache: true` flag (UI "refresh" button trajectory) provides a per-request bypass for cases where the writer is not in scope.

If a future stage requires per-key invalidation (e.g. snapshot writes become more frequent during working hours), the surface to extend is `result_cache.ResultCache` — add a per-prefix or per-pattern flush method, then have snapshot writes call it with the affected scope's key fragment instead of `clear_all`. Stage 7's design does not preclude this; it just doesn't ship it.

---

## 4. What Stage 7 deliberately does NOT do

- **No on-disk persistence.** Caches live in process memory only. Process restart wipes everything; cold boot = empty caches. Matches the existing snapshot-cache lifecycle.
- **No per-key invalidation.** See §3.
- **No HTTP endpoint exposing `clear_all`.** The existing `/api/snapshots/cache-clear` ([api_handlers.py:5216](../../graph-editor/lib/api_handlers.py#L5216)) already invokes `snapshot_service.cache_clear()` which now delegates to `clear_all()`, so the bustcache is reachable via HTTP without a new route. The body-level `no_cache: true` flag and dev `?no-cache=1` URL param both flip the shared ContextVar — sufficient for testing.
- **No FE-controllable cache TTL or size.** Defaults baked at module import (15 min, 1024 entries for primitives, 512 entries each for composed objects). Configurable later if profiling shows pressure.
- **No cache key for the resolver-default `transitions=None` carrier path.** `compose_carrier_to_x` builds transitions internally via `resolve_transitions_from_graph` when the caller doesn't supply them. The cache key is derived AFTER transition resolution (so the key reflects the same canonicalised TransitionPrimitive moments the body consumes). Consequence: a graph mutation that changes a resolved transition's moments *without* a snapshot-write path being involved would not invalidate the cache automatically — the cache would simply miss because the transition signatures differ. No code path triggers this in the live runtime; documented for completeness.
- **No retirement of any Stage 0-6 surface.** Stage 7 is purely additive: it wraps three existing composer / conditioning entry points without changing their signatures or behaviour. Existing readout tests pass unchanged.

---

## 5. Suggested commit messages (per atom)

The skill does not commit. The following are suggested commit messages for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/result_cache.py` (new) + `graph-editor/lib/snapshot_service.py` (migration) + `graph-editor/lib/tests/test_result_cache.py` (new) | `73n stage 7: extract reusable result_cache utility; migrate snapshot cache onto shared registry + ContextVar bypass + clear_all bustcache (§733)` |
| 2 | `graph-editor/lib/runner/primitive_conditioning.py` + `graph-editor/lib/tests/test_primitive_cache.py` (new) | `73n stage 7: process-memory cache for condition_primitive — scope-bearing key from transition + scope + evidence + model + options; numerical equivalence + bypass + bustcache tests (§735, §739)` |
| 3 | `graph-editor/lib/runner/carrier_composition.py` + `graph-editor/lib/runner/subject_span_composer.py` + `graph-editor/lib/tests/test_composed_cache.py` (new) | `73n stage 7: composed-object caches for compose_carrier_to_x + compose_subject_span — topology + primitive id() keys; MC-mode bypass; cross-boundary wiring tests proving §417 invariant + snapshot_service.cache_clear flushes (§733, §739)` |
| 4 | `docs/current/project-bayes/73n-stage-7-note.md` (new) + `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` (progress block) | `73n stage 7: stage-7 note + mark stage 7 complete in progress block` |

---

## 6. Open follow-ups (tracked for later resolution; NOT Stage 7-blocking)

These items survive into the rest of 73n's plan. Inherited unless flagged.

### Follow-up 1 — Maturity-aware likelihood migration (BLOCKS production flag-ON for Stages 5a/5b/5c/6, inherited)

Inherited from Stages 5a-6 follow-up #1. Stage 7 does not touch this. The likelihood migration is its own implementation surface; the cache layer is independent.

### Follow-up 2 — Per-upstream-edge evidence fetching for carrier primitives (inherited)

Inherited from Stage 6 follow-up #2. Stage 7 does not change the architectural connectivity here.

### Follow-up 3 — Per-key targeted invalidation if snapshot writes become frequent

Stage 7-specific. If profiling shows the `clear_all` bustcache is too aggressive (e.g. snapshot writes during working hours flush warm primitives that should have survived), extend `result_cache.ResultCache` with a per-prefix or per-pattern flush method and have `append_snapshots`/`delete_snapshots` call it with the affected scope's key fragment instead of `clear_all`. The design accommodates this but does not ship it.

### Follow-up 4 — Predictive vs epistemic SD separation (low priority, inherited)

Inherited from Stages 5b/5c/6 follow-up #3.

### Follow-up 5 — `_legacy_trajectory_draw_family_key` retirement (inherited)

Inherited from Stage 5a follow-up #4.

### Follow-up 6 — `subject_probability_source` enum on ForecastTrajectory (low priority, inherited)

Inherited from Stages 5a/5b/5c/6 follow-up #5.

### Follow-up 7 — FE-controllable cache TTL / size (low priority)

Stage 7-specific. Cache TTL (15 min) and max-entries (1024 for primitives, 512 for composed objects) are baked at module-import time. If profiling shows memory pressure or staleness pain, promote to `ForecastingSettings` with a per-cache override.

---

## 7. What unblocks for later stages

- **Stage 8 (Cross-Surface Projection and Provenance)** — diagnostics for "cache hit/miss status" can now be surfaced from `result_cache.stats_all()` in the per-edge response. Plan §760 notes "Cache hit/miss status is useful once persistent caching is enabled, but it is not required to close 73h Issue 2." Stage 8 owns the projection of this into the response schema.
- **Stage 9 (Acceptance Tests)** — focused regression fixtures can drive `cache_bypass_ctx` to compare cached vs uncached on F14 Q1/Q2 if needed; the bypass is cheap and orthogonal to the rest of the test contract.
- **Stage 10 (Codebase Documentation Pass)** — `docs/current/codebase/BE_RUNNER_CLUSTER.md` and `docs/current/codebase/STATS_SUBSYSTEMS.md` can reference `result_cache.py` as the canonical caching pattern and `lib/snapshot_service.py:cache_clear()` as the canonical bustcache hook.

---

## 8. Test totals snapshot

Stage 7 additions:

- 31 new generic-utility tests (`test_result_cache.py`)
- 16 new primitive cache tests (`test_primitive_cache.py`)
- 15 new composed-object cache tests (`test_composed_cache.py`) — includes the §417 invariant integration test (primitive flush invalidates composed-subject cache) and the cross-package-boundary `snapshot_service.cache_clear` flushes via the shared registry

Combined Stage 7 + Stage 0-6 substrate suite:

```
287 passed in 7.36s
```

Total primitive-substrate suite: **287 tests green** (up from Stage 6's 228; +62 cache tests across three files; net delta accounts for some readout test recounting at file-level boundaries).
