---
title: "fix: Dual-mode exclude compilation — segment conditions + exclusionSteps"
type: fix
status: active
date: 2026-03-18
---

# fix: Dual-mode exclude compilation — segment conditions + exclusionSteps

## Overview

dagnet's `.exclude()` DSL modifier silently fails for certain event types, causing MECE fork edges to return 100% conversion instead of the correct partitioned rate. The root cause is a combination of incorrect Amplitude API semantics in the adapter and a missing DSL modifier for order-aware exclusion. This plan adds a second exclude mode (`.excludeBetween()`) and fixes the existing `.exclude()` compilation.

## Problem Statement

When a dagnet graph has a fork (node A → B1 or B2), the `.exclude(B2)` on the A→B1 edge should filter out users who visited B2. Currently:

1. **`.exclude()` compiles to a segment condition** (`op: "="`, `value: 0`) in `connections.yaml` — this is the correct approach for MECE partitioning, but the API semantics may be wrong (`op: "="` vs `op: "<"`)
2. **There is no way to use Amplitude's `exclusionSteps`** (between-step funnel exclusion) — this is needed for order-aware queries like "users who went A→C without doing B in between"
3. **The `time_value: 366` window** on the segment condition may be too broad, catching users from previous sessions/flows

## Proposed Solution

### Two DSL modifiers, two Amplitude constructs

| DSL | Semantic | Amplitude construct | Use case |
|-----|----------|-------------------|----------|
| `.exclude(nodeX)` | "users who NEVER performed event X in the time window" | Segment condition: `type: "event"`, `op: "<"`, `value: 1` | MECE fork partitioning (default) |
| `.excludeBetween(nodeX)` | "users who did NOT perform event X between step A and step B" | `exclusionSteps` funnel parameter | Order-aware analysis |

### Fix 1: Correct the segment condition semantics

The current adapter (connections.yaml lines 145–180) uses `op: "="` + `value: 0`. Amplitude testing confirmed that `op: "<"` + `value: 1` is the working format. Additionally, `time_value` should match the graph's query window (typically 30 days), not a hardcoded 366 days.

### Fix 2: Add `.excludeBetween()` to the DSL

New DSL modifier that compiles to Amplitude's `exclusionSteps` parameter. This is between-step exclusion — only excludes users who fired the event between the funnel's from and to events.

### Fix 3: Align `time_value` with graph window

The segment condition's `time_value` should derive from the graph's `currentQueryDSL` window (e.g., `window(-30d:)` → `time_value: 30`), not a hardcoded 366 days.

## Technical Approach

### Files to modify

#### 1. DSL Parser — `graph-editor/src/lib/queryDSL.ts`

- Add `excludeBetween` to `QUERY_FUNCTIONS` array (line 32)
- Add `excludeBetween: string[]` to `ParsedConstraints` interface (after line 72)
- Add parsing logic in `parseConstraints()` (after line 233) — same pattern as `exclude` parsing but for `excludeBetween(...)` syntax

#### 2. Query Payload — `graph-editor/src/lib/das/buildDslFromEdge.ts`

- Add `excludeBetween?: string[]` to `QueryPayload` interface (line 63)
- Add processing block for `query.excludeBetween` (after line 279) — same node→event_id translation as `exclude`
- Add to payload construction (after line 348)

#### 3. Amplitude Adapter — `graph-editor/public/defaults/connections.yaml`

**For `.exclude()` (segment condition) — fix lines 145–180:**
- Change `op: "="` to `op: "<"` and `value: 0` to `value: 1`
- Replace hardcoded `time_value: 366` with the graph's window duration derived from `queryPayload.window` or `connection.window`. If no window available, default to 30 days
- Add `group_type: "User"` to each filter (required by Amplitude segment conditions)

**For `.excludeBetween()` (exclusionSteps) — new block after line 180:**
- Build `exclusionSteps` array from `queryPayload.excludeBetween`
- Each exclusion step needs: `event_type`, `filters` (from event definition), and the step position (between which funnel steps)
- Amplitude's `exclusionSteps` format: `[{ "event_type": "X", "filters": [...], "between": [0, 1] }]` — the `between` array specifies which funnel step indices the exclusion applies between

#### 4. Query Spec — `graph-editor/src/lib/das/buildDataQuerySpec.ts`

- Add `excludedBetween` field to DataQuerySpec (alongside existing `excluded` field, line 69)
- Include in cache signature so different exclude modes produce different cache keys

#### 5. Capabilities Declaration — `connections.yaml` line 14–18

- Add `supports_exclude_between: true` to capabilities
- Keep `supports_native_exclude: true`

### Files to add tests to

#### Existing test files to extend:

- `graph-editor/src/lib/das/__tests__/buildDataQuerySpec.test.ts` — add cases for `excludeBetween` in spec generation
- `graph-editor/src/services/__tests__/amplitudeFunnelBuilder.conformance.test.ts` — add conformance tests for both exclude modes

#### New integration test scenarios (add to existing files, do not create new files):

- Segment condition exclude: verify `op: "<"`, `value: 1`, correct `time_value`
- ExclusionSteps exclude: verify `exclusionSteps` array in Amplitude payload
- Mixed: edge with both `.exclude()` and `.excludeBetween()` (should this be allowed?)
- FlowStep event with property filters: verify filters propagate correctly to segment condition
- Event with empty `amplitude_filters`: verify segment condition still works (uses event_type only)

### DSL syntax examples

```
# MECE fork partitioning (segment condition — "never did X"):
from(A).to(B).exclude(C)
from(A).to(B).exclude(C, D)

# Order-aware exclusion (exclusionSteps — "didn't do X between A and B"):
from(A).to(B).excludeBetween(C)
from(A).to(B).excludeBetween(C, D)

# Both (theoretical — needs design decision):
from(A).to(B).exclude(C).excludeBetween(D)
```

## Acceptance Criteria

- [ ] `.exclude()` correctly filters users via segment condition with `op: "<"`, `value: 1`
- [ ] `.exclude()` uses graph window duration for `time_value`, not hardcoded 366
- [ ] `.excludeBetween()` compiles to Amplitude `exclusionSteps` parameter
- [ ] Both modifiers work with FlowStep events (same event_type, different property filters)
- [ ] Both modifiers work with golden events (distinct event_types)
- [ ] Cache keys differentiate between `exclude` and `excludeBetween` on the same edge
- [ ] Existing graphs with `.exclude()` continue to work (no breaking change to DSL)
- [ ] Conformance tests pass for both modes

## Verification Plan

After implementation, verify on the `li2-energy-wizard-v1` graph:

1. Revert the 4 conditional-intermediate edges back to fetchable with `.exclude()`
2. Run data fetch
3. Verify that fork edges at fuel-type, tariff-picker, quizzard now show correct partitioned rates (not 100%)
4. Verify that probabilities at each fork sum to ≤100% (with complement filling the gap)

## Dependencies and Risks

**Risk: `op: "<"` vs `op: "="` may not be the actual fix.** The Amplitude testing showed `op: "<"` + `value: 1` works, but we haven't confirmed that `op: "="` + `value: 0` doesn't work. The issue might be elsewhere (e.g., event definition not loaded in IDB, filters not propagating). The first implementation step should be a targeted test: change ONLY the `op`/`value` in the adapter and re-fetch one edge to confirm.

**Risk: `exclusionSteps` has limited documentation.** Amplitude's API documentation for funnel exclusion steps is sparse. The Amplitude research showed `exclusionSteps` had zero effect in testing — this may be because the excluded event occurred before the funnel start. Need to verify with an event that genuinely occurs BETWEEN funnel steps.

**Risk: `time_value` alignment.** Deriving `time_value` from the graph window requires passing window information through to the adapter. Currently `queryPayload` has window info but it may not be in a format the adapter can easily parse.

## Sources

- Amplitude adapter: `graph-editor/public/defaults/connections.yaml` (lines 145–180)
- DSL parser: `graph-editor/src/lib/queryDSL.ts` (lines 32, 72, 228–233)
- Query builder: `graph-editor/src/lib/das/buildDslFromEdge.ts` (lines 63, 260–279, 346–348)
- Exclude architecture doc: `docs/archive/graph-editor-docs/DAS_DSL_EXCLUDES_AND_SUBTRACTION.md`
- Amplitude adversarial review: `docs/current/amplitude-funnel-adversarial-review.md`
- Pitfalls: `data repo .claude/skills/dagnet-graph-builder/references/pitfalls.md` (#27, #32, #33)
- Amplitude testing (this session): segment condition `op: "<"` + `value: 1` confirmed working; `exclusionSteps` had zero effect when excluded event occurs before funnel start
