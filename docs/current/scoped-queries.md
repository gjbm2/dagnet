# Scoped Queries (from()/to() selectors)

**Status**: Design notes (not ready to implement)  
**Date**: 5-Mar-26  
**Audience**: DagNet graph-editor developers  

## Overview

Today, the graph-level “query DSL” (e.g. `context(...)`, `window(...)`, `cohort(...)`) is treated as **unscoped**: it applies uniformly to all fetch targets (edge parameters, conditional probabilities, and case targets). This document proposes extending the *user query DSL* so constraints can be **scoped to only a portion of a graph** using `from(nodeId)` / `to(nodeId)` selectors.

High-level intention:

- Let users say “apply `context(energysupplier:british_gas)` only to edges that start at `delegation` (or only the `delegation→…` subgraph)”.
- Keep existing semantics for unscoped queries unchanged.
- Make scope errors debuggable: warn when scoped clauses overlap or leave parts of the graph uncovered.

This is primarily a **fetch-planner / executor / signature** design problem, with a secondary **UI ergonomics** problem (help users construct these clauses).

## Motivation

Examples of things that are awkward in the current unscoped model:

- A graph contains multiple conceptual funnels/branches that need different context filters.
- A single window selection should drive all planning, but different subgraphs should use different contextual slices.
- Users want to compose this without creating multiple graphs or repeatedly editing global query state.

## Proposed DSL shape

We already use `from(...)` / `to(...)` in other DSLs (notably analytics DSL). The novelty here is using `from(...)` / `to(...)` as *selectors* that scope constraints.

One possible syntax (illustrative):

```
(to(delegation);from(delegation).context(energysupplier:british_gas)).window(3-Mar-26:3-Mar-26)
```

Interpretation (intended):

- Clause A: `to(delegation)` (selector only; no extra constraints) applies to targets matching `to=delegation`.
- Clause B: `from(delegation).context(energysupplier:british_gas)` applies to targets matching `from=delegation`.
- The `.window(...)` suffix is distributed across the OR branches (existing compound DSL equivalences).

### Terms

- **Query DSL**: the graph’s `currentQueryDSL` (and related pinned `dataInterestsDSL`). These currently carry context + temporal bounds, and are treated as global.
- **Analytics DSL**: analysis recipes use an `analytics_dsl` that commonly encodes `from()/to()` and identifies analysis scope; the query DSL provides window/context.
- **Scoped clause**: an atomic DSL string that may contain selectors (`from`, `to`) plus constraints (context/case/visited/window/cohort/asat).

## Intended semantics (draft)

### Selector matching

Selectors refer to **node ids** (not UUIDs). This is consistent with existing fetch/query authoring patterns and was chosen explicitly for this design.

Matching rules (draft):

- **Edges (parameters, conditional probabilities)**:
  - A clause with `from(X)` matches an edge whose `from` endpoint resolves to node id `X`.
  - A clause with `to(Y)` matches an edge whose `to` endpoint resolves to node id `Y`.
  - A clause with both `from(X).to(Y)` matches the specific edge `X→Y` (by node ids).
- **Cases (node targets)**:
  - A clause with `from(X)` matches the case target on node `X`.
  - A clause with `to(X)` matches the case target on node `X`.
  - (This is a “cases_all” rule: selectors apply to both edges and cases where meaningful.)

Implementation note: graph edges/nodes may reference by `uuid` internally; matching must resolve endpoint refs to **node.id** before comparison.

### Constraint combination

Default rule: **AND / merge**.

- Unscoped (selector-less) constraints apply to all targets.
- A matching scoped clause adds constraints on top of the unscoped set.
- When both provide constraints for the same “axis”, existing merge/override semantics apply (e.g. `context()` empty meaning explicit clear vs inherit; window/cohort being mutually exclusive).

### Multi-clause behaviour (union)

If a target matches multiple scoped clauses:

- The system should “do its best”:
  - Plan/fetch **the union** of all implied slice intents.
  - De-duplicate identical intents (same target + same slice family + same signature + same mode).
- The system should warn when this happens, because it may imply unexpected duplication or increased cost.

If selectors are used but some targets match **no** clause:

- The system should warn about incompleteness (“parts of the graph are unqueried”), ideally at the time the query is constructed/edited, not only during execution.

## Planner / executor implications

### Current architecture (relevant bits)

- Atomic constraint parsing is in `graph-editor/src/lib/queryDSL.ts` (`parseConstraints`, `normalizeConstraintString`, `parseDSL`).
- Compound expression explosion is in `graph-editor/src/lib/dslExplosion.ts`, which currently normalises atomic slices using `normalizeConstraintString`.
- Fetch planning is driven by `graph-editor/src/services/windowFetchPlannerService.ts` and `graph-editor/src/services/fetchPlanBuilderService.ts`.
- Slice matching uses `graph-editor/src/services/sliceIsolation.ts` (`extractSliceDimensions`, `isolateSlice`).
- Canonical query signatures are computed via `graph-editor/src/services/dataOperationsService.ts::computeQuerySignature`, and planner-grade matching via `graph-editor/src/services/plannerQuerySignatureService.ts`.

### Critical design constraint: preserve selectors through explosion

`normalizeConstraintString()` is constraint-only and will not preserve `from()`/`to()` semantics. Any scoped design must ensure that:

- Scoped clauses are exploded/distributed (`;`, `or()`, parentheses) **without losing** `from()` / `to()` tokens.
- Bare-key expansion (`context(key)` → cartesian product) still works.

This likely requires a new “scoped-preserving explosion” function alongside `explodeDSL()`.

### Planning model: per-clause planning + union

The existing planner assumes a single global DSL applies to all items. Scoped queries require introducing a per-clause plan stage:

1. Expand the user DSL into atomic scoped clauses.
2. For each clause:
   - Determine the in-scope targets (edges + cases).
   - Compute per-item query signatures for those targets under that clause’s effective constraints.
   - Run the existing `buildFetchPlan` logic, then filter/retain only in-scope items.
3. Union all clause plans into a single plan used by analysis, dry-run, and execution.

Key properties:

- **De-dupe**: identical fetch intents should collapse so we do not refetch the same slice twice.
- **Diagnostics**: overlap/incomplete warnings should be produced during analysis.

### Cache and signature invariants

The scoped-query design should not change the existing invariants unless explicitly agreed:

- Signatures must include **context definition hashes** (so changes to context YAML invalidate cached data).
- Signatures must **not** vary by context value.
- Signatures must **not** vary by explicit window/cohort bounds (bounds are excluded from the hashed “original query”).

Scoped queries introduce a new risk: we accidentally treat scoped constraints as global in signature computation or slice isolation. The per-clause computation model is intended to keep signatures aligned with the effective clause constraints for each target.

## UI / ergonomics (draft direction)

The WindowSelector makes adding unscoped contexts easy; adding scoped clauses by typing is fiddly. We likely need a small “clause builder” UX that generates correct scoped DSL.

Low-complexity options:

1. **Scope picker within WindowSelector**:
   - A control next to context selection: “Scope: All / From node / To node / From+To / Selected edges”.
   - When a context value is selected, it inserts/updates a scoped clause rather than forcing manual typing.

2. **Selection-based quick actions**:
   - If the user selects one or more edges on the canvas, a button “Add scoped context…” inserts:
     - semicolon-separated clauses, or
     - `or(...)` form.
   - Both forms should be supported by the planner (they’re logically equivalent).

3. **Warnings as you type**:
   - When a query contains any selector clause(s), show non-blocking warnings in the editor:
     - uncovered targets
     - overlap count
     - implied slice count

Important: UI components should remain access points; diagnostics and string transformation should live in a service/hook.

## Open questions (must resolve before implementation)

### Semantics and user expectations

- **Overlap resolution**: If a target matches multiple clauses, do we always fetch the union of slice intents, or do we define a precedence rule? Current leaning: “do our best” (union) + warn.
- **Completeness**: When selectors exist and some connected targets match no clause:
  - Is this merely a warning, or should it block execution in some modes (e.g. automated runs)?
  - How do we define “connected targets” (only those with connections? only those with parameter ids?)?
- **Case scoping details**: “cases_all” was selected, but the precise matching rule should be nailed down:
  - Should `from(X)` and `to(X)` both match the case on node `X`, or should only one apply?
- **Temporal clauses per clause**:
  - Are clause-local `window(...)` / `cohort(...)` allowed, and if so, what happens if different clauses specify different modes/ranges?
  - Current leaning: allow but warn on inconsistency; prefer a single authoritative range from WindowSelector state.
- **Selectors inside compound constructs**:
  - Do we allow `or(from(A).to(B), from(C).to(D)).context(...)` (selector-only branches with shared suffix constraints)?
  - This is desirable for ergonomics, but requires correct distribution logic without normalising away selectors.

### Parsing and normalisation

- **Generalised parsing**: Today, atomic parsing of constraints is regex-based and treats `from/to` separately. We likely need a more general tokenisation/parsing strategy for scoped clauses so that we do not lose selectors through “constraint-only” utilities.
- **Canonical form**: Do we need a canonical ordering of selector and constraint functions (like `normalizeConstraintString` does for constraints), and if so, where does it live (and how do we avoid breaking existing normalisation semantics)?

### Planner, execution, and caching

- **Plan identity**: Should `FetchPlan.dsl` store the original scoped DSL, or the per-clause effective DSLs, or both?
- **De-dupe key**: What exactly defines an “identical fetch intent” for de-duping? Likely:
  - `(itemKey, mode, sliceFamily, querySignature, requestedWindow)` but window bounds are a planning input, not signature input.
- **Snapshot DB**: Any scoped behaviour that affects signature/core_hash or slice_keys must remain consistent with snapshot read/write planning.

### UX / query construction

- **Primary entrypoint**: Do we prioritise scope-picking in WindowSelector, selection-based insertion, or both?
- **Generated form**: Should the UI default to semicolon lists, `or(...)`, or a hybrid?
- **Editing model**: How do we let users edit scoped clauses without turning the DSL editor into a footgun?

## Non-goals (for this design phase)

- Implementing this feature (this doc is intentionally pre-implementation).
- Redesigning query signatures or slice key semantics.
- Introducing new node reference formats (selectors are node id only for this design).

## Related files and docs

- DSL parsing:
  - `graph-editor/src/lib/queryDSL.ts`
  - `graph-editor/src/lib/dslExplosion.ts`
  - `graph-editor/src/lib/DSL_PARSING_ARCHITECTURE.md`
- Planning:
  - `graph-editor/src/services/windowFetchPlannerService.ts`
  - `graph-editor/src/services/fetchPlanBuilderService.ts`
  - `graph-editor/src/services/plannerQuerySignatureService.ts`
  - `graph-editor/src/services/sliceIsolation.ts`
- Signatures:
  - `graph-editor/src/services/dataOperationsService.ts` (`computeQuerySignature`)
  - `graph-editor/src/services/signatureMatchingService.ts`
- Contexts architecture:
  - `docs/current/project-contexts/CONTEXTS_ARCHITECTURE.md`
  - `docs/current/project-contexts/DSL_COMPOUND_EXPRESSIONS.md`

