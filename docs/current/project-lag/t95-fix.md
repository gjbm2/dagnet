# t95 Fix: Parameter-Level Overrides for `t95` and `path_t95`

Date: 12-Dec-25

## Purpose

We currently compute `t95` and `path_t95` automatically from fetched evidence and graph topology. This has two problems:

- The system can be systematically wrong in the presence of long-tail latency, especially on deeper paths.
- There is no simple, inspectable mechanism for a user to override the computed horizons when they know better.

This document specifies a simpler and more traceable model:

- `t95` and `path_t95` are treated as parameter-level fields with standard `*_overridden` companions.
- The system computes and writes derived values when not overridden.
- If the user overrides a value, downstream logic uses the override (no mixing of derived + manual).
- A global default is used for first fetches when neither derived values nor overrides exist.

## Scope

This proposal covers:

- Data model (parameter schema + types)
- UpdateManager behaviour (how values flow between stored parameter data and the in-memory edge parameter view)
- The “effective value” selection rules (override precedence)
- Where in the application `t95` and `path_t95` are used (fetch planning, Amplitude conversion windows, LAG analytics)
- Tests and documentation updates required

This proposal is intentionally designed for the current test environment (single graph), with a focus on traceability and predictable behaviour.

## Terminology

- `t95`: the edge-local latency horizon (intended to approximate “95% of eventual converters have converted by this many days” for the edge’s conversion).
- `path_t95`: the cumulative latency horizon from the anchor to the end of the edge (used for downstream cohort horizons and for Amplitude conversion windows in cohort mode).
- “Parameter-level”: stored and versioned alongside the parameter’s time-series values (the same layer where `maturity_days` currently lives in practice).
- “Derived”: computed by the system from observed cohorts and model fitting.
- “Override”: user-supplied value that replaces the derived value for all downstream logic.

## High-level behaviour

### User workflow (target behaviour)

1. User enables latency tracking for an edge.
2. User may optionally specify:
   - edge `t95` (and mark it overridden), and/or
   - `path_t95` (and mark it overridden).
3. User fetches data.
4. On first fetch:
   - if no user overrides exist, the system falls back to a global default horizon (for cohort-mode conversion windows and retrieval bounds) until enough evidence exists to compute derived values.
5. On subsequent fetches:
   - the system computes derived `t95` and derived `path_t95` and writes them to the parameter data (only if not overridden).
6. User may later overwrite either value; from that point onward the system uses the override.

### Override precedence (no mixing)

For each of `t95` and `path_t95`, selection is:

- If `*_overridden` is true and the overridden value is present and valid, use it.
- Else, use the derived value if present and valid.
- Else, use the global default horizon (for operational needs).

There is no blending between overridden and derived values. An override replaces the derived value for all consumers.

## Data model changes

### New/standardised fields (parameter-level)

The following fields are treated as parameter-level fields (persisted in the parameter data backing an edge’s `p.latency` view):

- `t95`
- `t95_overridden`
- `path_t95`
- `path_t95_overridden`

### Latency enablement

Latency enablement should be represented in a way that is:

- explicit (“is latency edge”)
- independent of the numeric horizons
- consistent across the stack

This proposal supports two phased approaches:

#### Phase 1 (minimal change)

Keep the existing enablement mechanism as-is, but decouple its meaning:

- `maturity_days` remains the marker that latency tracking is enabled.
- `maturity_days` is no longer treated as the canonical numeric horizon once `t95` and `path_t95` are available (derived or overridden).
- A global default horizon is used when neither `t95` nor `path_t95` is present.

#### Phase 2 (clean-up)

Replace numeric `maturity_days` with a boolean “latency enabled” marker, and treat horizons as separate, overridable numeric fields:

- `latency_enabled` (boolean)
- `t95` + `t95_overridden`
- `path_t95` + `path_t95_overridden`

This second phase is optional and should be executed only after Phase 1 is stabilised and fully tested.

## Computation and write-back rules

### Derived `t95`

Derived `t95` continues to be computed from cohort evidence via the existing fitting logic and quality gates.

Write-back policy:

- If `t95_overridden` is true, do not overwrite `t95`.
- Else, write the derived `t95` into the parameter data (and therefore into the edge parameter view).

### Derived `path_t95`

Derived `path_t95` continues to be computed in the current fashion:

- It may be computed via topological accumulation and/or via anchor-aware estimation when the necessary anchor lag evidence exists.
- The computed result is written into the parameter data as `path_t95`.

Write-back policy:

- If `path_t95_overridden` is true, do not overwrite `path_t95`.
- Else, write the derived `path_t95`.

### Effective value resolution

Introduce a single, centralised “effective horizon” selection concept used across the app:

- `effective_t95` is the value chosen by the precedence rules above.
- `effective_path_t95` is the value chosen by the precedence rules above.

Consumers must use the effective values, not the raw stored fields.

## Application impact areas

### Types

Update TypeScript types so the latency block contains both values and override flags.

Impacted area:

- `graph-editor/src/types/index.ts` (and any shared latency types used by services)

### Parameter schema

Update the parameter YAML schema so these fields are valid, persisted, and round-trip cleanly.

Impacted area:

- `graph-editor/public/param-schemas/parameter-schema.yaml`

### UpdateManager

UpdateManager must treat these fields as standard graph-mastered/parameter-backed fields with override flags:

- Read them from stored parameter data into the edge parameter view.
- Write derived values back into the parameter data unless overridden.
- Ensure the override flags prevent write-back overwrites.

Impacted area:

- `graph-editor/src/services/UpdateManager.ts`

### LAG computation pipeline

The statistical computation must:

- compute derived `t95` and derived `path_t95` as it does today, but
- avoid silently overriding user overrides.

Additionally, when effective values are needed for downstream decisions, consumers should resolve overrides first.

Impacted areas:

- `graph-editor/src/services/statisticalEnhancementService.ts`
- `graph-editor/src/services/fetchDataService.ts` (path computation application step)

### Fetch planning and refetch policy

Places that currently use `maturity_days`, `t95`, or `path_t95` must be updated to use:

- `effective_t95` when making maturity/refetch decisions that are edge-local.
- `effective_path_t95` for cohort bounding decisions that depend on anchor-to-edge horizons.

Impacted areas:

- `graph-editor/src/services/fetchRefetchPolicy.ts`
- `graph-editor/src/services/windowFetchPlannerService.ts`
- `graph-editor/src/services/cohortRetrievalHorizon.ts`
- `graph-editor/src/services/dataOperationsService.ts`

### Amplitude cohort-mode conversion window (`cs`)

The Amplitude adapter uses `cohort.maturity_days` to construct `cs`. The application sets `queryPayload.cohort.maturity_days` during query payload build.

We must ensure cohort-mode `cs` is driven by an effective, overridable horizon:

- use `effective_path_t95` if present
- otherwise fall back to `effective_t95`
- otherwise fall back to global default horizon

Impacted area:

- `graph-editor/src/lib/das/buildDslFromEdge.ts`

### UI / editing controls

This proposal requires a user-accessible way to set and clear overrides.

Minimum UI requirements:

- Allow the user to input numeric `t95` and/or `path_t95` values.
- Provide a clear “override on/off” toggle per value (setting a value should set the override flag; clearing should unset).
- Provide a “revert to derived” action that clears the override flag and allows the system to write derived values again.

Impacted areas (exact components to be confirmed by implementation):

- the edge properties editor (latency section)
- any “advanced” properties panel where parameter-backed edge fields are edited

## Operational and analytical semantics

### What these values are used for

- `t95` is used as an edge-local maturity horizon and as a component in derived `path_t95`.
- `path_t95` is used for:
  - cohort-mode conversion windows (Amplitude `cs`)
  - cohort retrieval bounding / “how far back to fetch”
  - downstream latency-aware analytics requiring anchor-to-edge horizons

### What these values are not

Overrides are a user policy tool. An overridden value should not be presented or logged as a purely empirical estimate.

## Defaults and first-fetch behaviour

Define a single global default horizon used when no values exist yet:

- used for cohort-mode `cs` when neither overridden nor derived values exist
- used for cohort bounding when neither overridden nor derived values exist

The default should be documented and centrally defined (single source of truth) so it is consistent across fetch planning and query construction.

## Tests

Update/add tests that prove:

- If `*_overridden` is true, derived computation does not overwrite the stored value.
- Effective value selection uses override first, then derived, then default.
- Amplitude cohort-mode `cs` uses `effective_path_t95` when present and overridden.
- Cohort bounding uses `effective_path_t95` consistently.

Expected impacted test areas:

- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
- `graph-editor/src/services/__tests__/pathT95Computation.test.ts`
- `graph-editor/src/lib/das/__tests__/buildDslFromEdge.cohortAnchor.test.ts`
- integration tests covering fetch planning + bounded windows (planner → DAS call chain)

## Rollout plan (phased)

### Phase 1: Introduce overrides and effective selection

- Add schema + type support for `t95_overridden` and `path_t95_overridden`.
- Add effective selection logic in a single place and update all consumers to use it.
- Update UpdateManager to respect overrides.
- Add UI controls to set/clear overrides.
- Update tests.

### Phase 2 (optional): Clean up `maturity_days`

- Replace numeric `maturity_days` with a boolean `latency_enabled` marker.
- Ensure all consumers use effective horizons and no longer depend on numeric `maturity_days` as a horizon.
- Update schema, types, and tests accordingly.

## Non-goals

- Replacing the existing statistical fitting approach in this change.
- Implementing new probability models for long-tail behaviour.
- Multi-graph migration concerns (out of scope for the current test environment).


