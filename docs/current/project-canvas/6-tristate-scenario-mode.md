# Tristate Scenario Mode for Canvas Analyses

## Overview

Replace the binary Live/Custom toggle on canvas analyses with a three-state cycle: **Live → Custom → Fixed → Live**.

| Mode | Base | Rendered scenarios | Responds to navigator? |
|---|---|---|---|
| **Live** | implicit | from tab's ScenariosContext (including 'current' and 'base') | fully |
| **Custom** | live `currentDSL` (invisible infrastructure) | chart-owned delta DSLs composed onto live base; slots 1..n only | base tracks navigator; scenario definitions are stable |
| **Fixed** | none | chart-owned absolute DSLs | no |

**Key insight**: Custom mode reuses the existing scenario compositing machinery (`augmentDSLWithConstraint`) — each custom scenario's `effective_dsl` is a delta fragment composed onto the live `currentDSL`. The base is infrastructure, not a rendered layer: the chart renders only slots 1..n, each of which is `augmentDSLWithConstraint(currentDSL, slot.effective_dsl)`. A Custom chart where every scenario specifies a complete DSL is behaviourally identical to Fixed, but the intent differs: Custom says "track my base", Fixed says "I am self-contained".

**Base is not rendered**: In Custom mode the live `currentDSL` feeds into every scenario's composition but does not appear as its own series. There is no "Base" row in the scenario list — the user sees only their custom delta scenarios, knowing they're relative to whatever the navigator currently shows.

**Context availability**: Chart tabs and standalone chart files collapse to Fixed only (no live base context). The full tristate is available only on canvas analyses.

---

## Phase 0: DSL Per-Key Clear Semantics

### 0.1 Prerequisite: `context(key:)` as per-key clear

The rebase algebra requires the ability to express "remove this specific key from the inherited context" without clearing ALL context keys. This is distinct from the existing `context(key)` (bare key, no colon) which means "enumerate all values of this axis."

Three forms of context clause:
- `context(channel)` — **enumerate**: iterate over all values of the `channel` axis (no colon)
- `context(channel:)` — **clear**: remove the `channel` key from inherited context (colon, empty value)
- `context(channel:google)` — **set**: constrain `channel` to `google` (colon, value present)

The colon is the discriminator between enumerate and clear/set.

**Changes needed:**

**File**: `graph-editor/src/lib/queryDSL.ts`

- `parseConstraints()`: adjust the context regex to distinguish bare key (no colon) from key-with-empty-value (trailing colon). Currently both parse as `{ key, value: '' }`. Add a flag or sentinel to distinguish (e.g. `value: undefined` for enumerate vs `value: ''` for clear).
- `augmentDSLWithConstraint()`: when merging context and the new constraint has a key-clear entry (`value: ''` with colon), remove that key from the merged context array entirely (rather than keeping it with empty value).
- Serialisation: key-clear entries emit `context(key:)` (with colon); enumerate entries emit `context(key)` (bare).

**File**: `graph-editor/src/services/scenarioRegenerationService.ts`

- New function `computeRebaseDelta(base, target)`: compute the minimal delta such that `augmentDSLWithConstraint(base, delta) = target`. For each context key in base that is absent from target, emit `context(key:)` (per-key clear). This makes the rebase algebra lossless.

Same pattern applies to `contextAny` if per-axis clear is needed, though this is less common.

---

## Phase 1: Type and Schema Changes

### 1.1 TypeScript types

**File**: `graph-editor/src/types/index.ts`

- Add a new type: `export type CanvasAnalysisMode = 'live' | 'custom' | 'fixed';`
- On `CanvasAnalysis`, replace `live: boolean` with `mode: CanvasAnalysisMode`
- Keep `live` as a deprecated computed getter or remove entirely (see migration note below)

### 1.2 ChartRecipeScenario

**File**: `graph-editor/src/types/chartRecipe.ts`

- No structural changes needed. The `effective_dsl` field already stores the DSL string.
- In Custom mode, `effective_dsl` stores a delta fragment. In Fixed mode, it stores an absolute DSL. The interpretation is determined by `CanvasAnalysis.mode`, not per-scenario.

### 1.3 Python schema

**File**: `graph-editor/lib/graph_types.py`

- On `CanvasAnalysis`, replace `live: bool = True` with `mode: str = 'live'` (validated to `'live' | 'custom' | 'fixed'`)
- Add backward-compat: if `live` field is present in incoming data, map `true → 'live'`, `false → 'fixed'` (existing frozen charts become Fixed, which matches their current semantics)

### 1.4 JSON schema

**File**: `graph-editor/public/schemas/conversion-graph-1.1.0.json`

- Replace the `live` boolean property with `mode` enum property on `CanvasAnalysis`

### 1.5 Migration / backward compatibility

- Existing graphs have `live: true` or `live: false`. On load, map:
  - `live: true` (no `recipe.scenarios`) → `mode: 'live'`
  - `live: false` (has `recipe.scenarios`) → `mode: 'fixed'`
- This mapping should happen in the graph loading/normalisation path (wherever `CanvasAnalysis` objects are deserialised)
- The `live` field is removed from the type; no compatibility shim

---

## Phase 2: Transition Logic

### 2.1 Cycle: Live → Custom → Fixed → Live

Single handler, advances one step per click.

**Live → Custom** (rebase within the chart):

This transition rebases the chart's scenario composition from `baseDSL` to `currentDSL`. Within the chart (not the graph), Current replaces Base as the composition foundation.

Two operations:

1. **Promote Current to a named scenario**: Current becomes a formal slot with a generated name derived from its DSL (e.g. "7d Google channel" from `window(-7d:).context(channel:google)`). Its delta from the new base is empty (since Current IS `currentDSL`), but it has identity — name, colour, position. Users treat Current as a de facto scenario (they may or may not have clicked "+" to formalise it), so this promotion preserves their mental model.

2. **Rebase user scenarios onto `currentDSL`**: Each user scenario's output must stay the same, but re-expressed as a delta from the new base (`currentDSL` instead of `baseDSL`):
   - Compute each scenario's effective DSL as it was in Live mode
   - `delta = computeRebaseDelta(currentDSL, scenario.effective_dsl)` (Phase 0 function — handles additions, replacements, and per-key clears via `context(key:)`)
   - Verify round-trip: `augmentDSLWithConstraint(currentDSL, delta)` reproduces the original effective DSL (should always pass with Phase 0's lossless algebra)

The old Live-mode Base layer disappears — it is neither rendered nor used as infrastructure. The chart has moved from `baseDSL` to `currentDSL` as its foundation.

- Set `mode: 'custom'`
- Store delta DSLs in `recipe.scenarios[].effective_dsl`
- Display order preserved: promoted Current at position 1, user scenarios below in their Live-mode order

Examples:
  - 1 visible (current) → 1 slot: promoted Current (empty delta, named from DSL)
  - 2 visible (current + scenario A) → slot 1 = promoted Current (empty delta), slot 2 = scenario A (rebased delta)
  - 2 visible (scenario A + scenario B) → slot 1 = A (rebased delta), slot 2 = B (rebased delta); no Current slot since it wasn't visible
  - 3 visible (current + B + A) → slot 1 = promoted Current (empty delta), slot 2 = B (rebased delta), slot 3 = A (rebased delta)

**Custom → Fixed**:
- For each scenario in `recipe.scenarios`, bake the live base into its delta: `augmentDSLWithConstraint(currentDSL, scenario.effective_dsl)`
- Replace each scenario's `effective_dsl` with the composed absolute DSL
- Set `mode: 'fixed'`
- This is lossless — the delta is fully resolved against the current base

**Fixed → Live**:
- Clear `recipe.scenarios` (discard chart-owned scenarios)
- Clear `recipe.analysis.what_if_dsl`
- Set `mode: 'live'`

### 2.2 Location of transition logic

**File**: `graph-editor/src/services/canvasAnalysisMutationService.ts` (or new `canvasAnalysisTransitionService.ts`)

- New service method `advanceMode(analysis, currentDSL, scenariosContext)` that reads `analysis.mode`, computes the next state (including rebase/bake operations), and returns the mutated analysis
- The rebase computation, scenario promotion, and DSL composition are business logic — they belong in a service, not a UI component

**File**: `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx`

- Replace `handleLiveToggle(live: boolean)` with `handleModeCycle()` that calls the service method
- Same handler used by both the toolbar popover and the PropertiesPanel

### 2.3 Auto-promotion

**File**: `graph-editor/src/hooks/useCanvasAnalysisScenarioCallbacks.ts`

- Currently: editing a scenario in Live mode auto-promotes to Custom (captures + flips `live: false`)
- New behaviour: auto-promotion from Live still goes to Custom. The `mutateRecipeScenarios` callback sets `mode: 'custom'` and computes delta DSLs for the captured scenarios.
- Editing in Custom or Fixed mode stays in that mode (no further promotion)

---

## Phase 3: Compute Path Changes

### 3.1 prepareAnalysisComputeInputs

**File**: `graph-editor/src/services/analysisComputePreparationService.ts`

- Currently has two modes: `'live'` and `'custom'`
- Add a third mode: `'custom-live-base'` (or reuse `'custom'` with an additional flag)
- **Custom mode with live base**: for each scenario, compose `augmentDSLWithConstraint(currentDSL, scenario.effective_dsl)` to get the effective query DSL, then apply `chart_current_layer_dsl` on top via `composeScenarioDsl()`
- **Fixed mode**: identical to current `'custom'` mode behaviour (scenario `effective_dsl` used as-is, then `chart_current_layer_dsl` applied)

### 3.2 useCanvasAnalysisCompute

**File**: `graph-editor/src/hooks/useCanvasAnalysisCompute.ts`

- Currently branches on `analysis.live` (boolean) to choose between live and custom params
- Change to branch on `analysis.mode`:
  - `'live'` → existing live params (unchanged)
  - `'custom'` → new custom-with-live-base params: pass `currentDSL` as the base, plus `recipe.scenarios` with delta DSLs
  - `'fixed'` → existing custom params (scenarios with absolute DSLs, no `currentDSL` dependency)

### 3.3 Reactivity

- In Custom mode, the chart must recompute when `currentDSL` changes (since the base is live). This is already the case — `currentDSL` is in the dependency array of the prepare effect.
- In Fixed mode, the chart should NOT recompute when `currentDSL` changes. Currently it does (since `currentDSL` is always a dependency). Consider: is this worth optimising, or is the no-op recompute acceptable? Likely acceptable since the effective DSLs won't change, and the signature-based dedup will skip the actual computation.

---

## Phase 4: UI Changes

### 4.1 Toolbar popover (AnalysisChartContainer)

**File**: `graph-editor/src/components/charts/AnalysisChartContainer.tsx`

- Replace the binary Live/Custom toggle with a tristate indicator
- Icon per state:
  - Live: `<Zap />` (lightning — dynamic, tracking tab)
  - Custom: `<Layers />` (or similar — delta layers on live base)
  - Fixed: `<Lock />` (padlock — self-contained snapshot)
- Label shows current mode name
- Click advances the cycle: Live → Custom → Fixed → Live
- Tooltip describes current mode and what click will do ("Custom — click for Fixed")

### 4.2 CSS for tristate toggle

**File**: `graph-editor/src/styles/components-dark.css`

- Replace the `.cfp-lc-toggle` binary switch with a tristate indicator
- Options: (a) three-segment pill where active segment is highlighted, (b) single icon button that cycles, (c) three dots/pips with active one highlighted
- Recommendation: simple icon-only button that cycles, with label text showing the mode name. Keeps the UI compact in the toolbar popover.

### 4.3 Mode badge on canvas node

**File**: `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx`

- Currently shows `LIVE` or `CUSTOM` badge
- Change to show `LIVE`, `CUSTOM`, or `FIXED`
- Badge CSS class varies per mode for colour differentiation

### 4.4 PropertiesPanel

**File**: `graph-editor/src/components/PropertiesPanel.tsx`

- The "Data Source" CollapsibleSection currently uses a binary checkbox with labels "Live" / "Custom"
- Replace with a tristate control (three radio-style options, or a cycling button matching the toolbar)
- Section should be open (expanded) when mode is Custom or Fixed, collapsed when Live
- Scenario list and "Add scenario" button visible in Custom and Fixed modes
- In Custom mode, scenario DSL editing should indicate that DSLs are deltas ("relative to current base")

### 4.5 Callback prop changes

**File**: `graph-editor/src/components/charts/AnalysisChartContainer.tsx`

- Replace `onLiveToggle?: (live: boolean) => void` with `onModeCycle?: () => void`
- Replace `analysisLive?: boolean` with `analysisMode?: CanvasAnalysisMode`
- All callers updated accordingly

---

## Phase 5: Scenario Layer List Adjustments

### 5.1 Custom mode layer display

**File**: `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx` (scenario layer item construction)

- In Custom mode, **no base row** in the scenario list — the base is invisible infrastructure
- The scenario list shows only the user-defined delta scenarios (slots 1..n)
- The mode badge and/or a subtle indicator in the popover header communicates that deltas are relative to the live navigator state
- In Fixed mode, scenario list shows scenarios as today (self-contained absolute DSLs)

### 5.2 Scenario DSL editing

- In Custom mode, the ScenarioQueryEditModal should indicate that the DSL is a delta fragment (e.g. placeholder text: "Delta from current navigator state")
- In Fixed mode, editing works as today (full absolute DSL)

### 5.3 Minimum slot guarantee

- Custom mode always has at least one slot (since Live mode always has at least 'current' visible)
- The "Add scenario" button is always visible in Custom and Fixed modes

---

## Phase 6: Tests

### 6.0 Phase 0 tests: DSL per-key clear and rebase algebra

**File**: `graph-editor/src/lib/__tests__/queryDSL.test.ts` (extend existing suite)

**Per-key clear parsing and round-trip:**
- `context(channel)` parses as enumerate (value: undefined), serialises as `context(channel)`
- `context(channel:)` parses as clear (value: ''), serialises as `context(channel:)`
- `context(channel:google)` parses as set, serialises as `context(channel:google)`
- All three forms survive parse → serialise round-trip without confusion

**Per-key clear in augmentDSLWithConstraint:**
- `augment('context(channel:google).context(region:uk)', 'context(channel:)')` → `context(region:uk)` (channel removed, region kept)
- `augment('context(channel:google)', 'context(channel:)')` → `` (channel removed, nothing left — contextClausePresent but empty)
- `augment('context(channel:google).context(region:uk)', 'context(channel:meta).context(region:)')` → `context(channel:meta)` (channel replaced, region removed)
- Per-key clear does not affect keys it doesn't mention: `augment('context(a:1).context(b:2).context(c:3)', 'context(b:)')` → `context(a:1).context(c:3)`

**File**: `graph-editor/src/services/__tests__/rebaseDelta.test.ts` (new suite)

**computeRebaseDelta round-trip — common cases:**
- Context key replacement: `computeRebaseDelta('window(-7d:).context(channel:google)', 'window(-7d:).context(channel:meta)')` → `context(channel:meta)`. Verify: `augment(base, delta)` = target.
- Window change: `computeRebaseDelta('window(-7d:).context(channel:google)', 'window(-30d:).context(channel:google)')` → `window(-30d:)`. Verify round-trip.
- Context addition: `computeRebaseDelta('window(-7d:)', 'window(-7d:).context(region:uk)')` → `context(region:uk)`. Verify round-trip.
- Context key removal: `computeRebaseDelta('window(-7d:).context(channel:google)', 'window(-7d:)')` → `context(channel:)`. Verify round-trip.
- Selective key removal: `computeRebaseDelta('context(channel:google).context(region:uk)', 'context(channel:meta)')` → `context(channel:meta).context(region:)`. Verify round-trip.
- Window change + context replacement: `computeRebaseDelta('window(-7d:).context(channel:google)', 'window(-30d:).context(channel:organic).context(region:uk)')` → `window(-30d:).context(channel:organic).context(region:uk)`. Verify round-trip.
- No change (base = target): `computeRebaseDelta('window(-7d:).context(channel:google)', 'window(-7d:).context(channel:google)')` → empty string. Verify round-trip.
- Window removal (window→cohort switch): `computeRebaseDelta('window(-7d:)', 'cohort(-30d:)')` → `cohort(-30d:)`. Verify round-trip.
- Asat removal: `computeRebaseDelta('window(-7d:).asat(2025-01-01)', 'window(-7d:)')` → `asat()`. Verify round-trip.

**Edge cases:**
- Empty base, non-empty target: delta = target (everything is new)
- Non-empty base, empty target: delta clears every axis present in base
- Both empty: delta = empty
- Enumerate context (`context(channel)`) survives rebase — enumerate is a different use class from set/clear and should pass through unchanged

### 6.1 Tristate transition tests

**File**: `graph-editor/src/services/__tests__/canvasAnalysisFreezeUnfreeze.test.ts` (extend existing)

- Update all references from `live: true/false` to `mode: 'live'/'custom'/'fixed'`

**Live → Custom transition:**
- 1 visible (current only): produces 1 slot with empty delta, named from DSL
- 3 visible (current + B + A): produces 3 slots preserving display order; promoted Current at position 1 with empty delta; B and A rebased with correct deltas; round-trip verified for each
- Scenario with context key different from current: delta correctly captures the replacement
- Scenario with context key removed vs current: delta includes `context(key:)` per-key clear
- Verify chart output (effective DSLs) is identical before and after transition

**Custom → Fixed transition:**
- Bakes base into each delta: `augment(currentDSL, delta)` produces absolute DSL stored in effective_dsl
- Empty delta slot gets currentDSL baked in as its absolute DSL
- Delta with `context(channel:organic)` + base `window(-7d:).context(channel:google)` → absolute `window(-7d:).context(channel:organic)`
- Verify chart output is identical before and after transition

**Fixed → Live transition:**
- Clears recipe.scenarios
- Clears recipe.analysis.what_if_dsl
- Sets mode to 'live'

**Full cycle:**
- Live → Custom → Fixed → Live: verify no data corruption, final state matches original Live state (assuming tab scenarios unchanged)

### 6.2 Custom mode compute path tests

**File**: `graph-editor/src/services/__tests__/analysisComputePreparation.test.ts` (extend existing or new)

- Custom mode composes `augmentDSLWithConstraint(currentDSL, deltaDsl)` for each scenario
- Custom mode applies `chart_current_layer_dsl` on top of the composed DSL
- Custom mode recomputes when `currentDSL` changes (e.g. navigator window change): slot with `window(-30d:)` delta retains its window; slot with empty delta tracks the new window
- Fixed mode uses `effective_dsl` as-is (existing behaviour preserved)
- Fixed mode does NOT change when `currentDSL` changes (output is stable)

### 6.3 Custom mode user workflow tests

- User adds a new scenario in Custom mode with delta `context(channel:google)`: chart shows two series (base-as-is + base-with-google-context)
- User changes navigator window: both series update (empty-delta tracks, context-delta inherits new window)
- User changes navigator context: context-delta overrides the navigator's context for its key but inherits other keys
- Bridge chart between empty-delta slot and context-delta slot: produces meaningful comparison that tracks navigator changes

### 6.4 Migration tests

- Graph with `live: true` deserialises to `mode: 'live'`
- Graph with `live: false` + `recipe.scenarios` deserialises to `mode: 'fixed'`

---

## Phase 7: Downstream Consumers

### 7.1 captureTabScenariosService

**File**: `graph-editor/src/services/captureTabScenariosService.ts`

- Add a variant or parameter to produce delta DSLs (for Live → Custom transition)
- The existing `captureTabScenariosToRecipe` produces absolute DSLs; a new function or mode computes `computeRebaseDelta(currentDSL, absoluteDsl)` for each scenario (using the Phase 0 function, not the legacy `diffQueryDSLFromBase` which cannot express removals)

### 7.2 canvasAnalysisMutationService

**File**: `graph-editor/src/services/canvasAnalysisMutationService.ts`

- Update any references to `analysis.live` to use `analysis.mode`

### 7.3 Graph serialisation

- Wherever graphs are serialised/saved, ensure `mode` is written instead of `live`
- Wherever graphs are loaded, apply the backward-compat migration (Phase 1.5)

### 7.4 Share payloads / "Open as Tab"

- When a canvas analysis is opened as a chart tab, it should always export as Fixed (absolute DSLs), regardless of its canvas mode
- Share payloads similarly use Fixed semantics (self-contained)

---

## File Impact Summary

| File | Change |
|---|---|
| `src/lib/queryDSL.ts` | Phase 0: per-key clear parsing, augment, serialisation, `computeRebaseDelta()` |
| `src/types/index.ts` | Add `CanvasAnalysisMode`, replace `live` with `mode` on `CanvasAnalysis` |
| `src/types/chartRecipe.ts` | No structural change (interpretation changes) |
| `lib/graph_types.py` | Replace `live: bool` with `mode: str`, add migration |
| `public/schemas/conversion-graph-1.1.0.json` | Replace `live` with `mode` enum |
| `src/services/canvasAnalysisMutationService.ts` | Transition logic (`advanceMode`), `live` → `mode` references |
| `src/services/analysisComputePreparationService.ts` | Add custom-with-live-base compute path |
| `src/hooks/useCanvasAnalysisCompute.ts` | Branch on `mode` instead of `live` |
| `src/components/nodes/CanvasAnalysisNode.tsx` | Tristate handler (calls service), badge, scenario layer items |
| `src/components/charts/AnalysisChartContainer.tsx` | Tristate toggle UI, updated props |
| `src/components/PropertiesPanel.tsx` | Tristate control in Data Source section |
| `src/hooks/useCanvasAnalysisScenarioCallbacks.ts` | Auto-promotion uses `mode` |
| `src/services/captureTabScenariosService.ts` | Delta DSL capture via `computeRebaseDelta` |
| `src/styles/components-dark.css` | Tristate toggle styles, mode badge colours |
| `src/services/__tests__/canvasAnalysisFreezeUnfreeze.test.ts` | Extended for tristate |
| `src/lib/__tests__/queryDSL.test.ts` | Phase 0 per-key clear tests + `computeRebaseDelta` round-trip tests |
| `src/lib/transform.ts` | Phase 1 backward-compat migration `live` → `mode` in `toFlow` |
| `src/lib/dslExplosion.ts` | Phase 0 bare-key filter fix |

---

## Implementation Progress

### Phase 0: DSL Per-Key Clear Semantics — DONE (14-Mar-26)

**`src/lib/queryDSL.ts`:**
- `ParsedConstraints.context` type: `value: string` → `value: string | undefined` (undefined = enumerate, '' = per-key clear, non-empty = set)
- Context regex updated: `/context\(([^:)]+)(?::([^)]*))?\)/g` — captures `context(key:)` distinctly from `context(key)`
- Serialisation updated in `normalizeConstraintString` and `augmentDSLWithConstraint` rebuild (3-way: bare key, colon-only, colon+value)
- `augmentDSLWithConstraint`: per-key clear (`value: ''`) deletes that key from merged context map. Uses `contextMergeResult` pattern to track clause presence correctly (per-key clears that empty the map → no context clause emitted, vs explicit `context()` whole clear → `context()` emitted)
- New `computeRebaseDelta(base, target)`: computes minimal delta for all clause types. Placed in `queryDSL.ts` (pure DSL function) rather than `scenarioRegenerationService.ts` as originally planned — better cohesion with parsing/augment
- Downstream type fixes: 11 files updated with `?? ''`, `.filter()`, or `!== undefined` guards

**`src/lib/dslExplosion.ts`:** Bare-key filter tightened from `!ctx.value` to `ctx.value === undefined` (prevents per-key clear entries being treated as enumerate)

**Tests:** 27 new tests in `src/lib/__tests__/queryDSL.test.ts` — per-key clear parsing, round-trip serialisation, augment behaviour, `computeRebaseDelta` common cases and edge cases. All round-trip verified via `augment(base, delta) = target`.

### Phase 1: Type and Schema Changes — DONE (14-Mar-26)

**`src/types/index.ts`:** Added `CanvasAnalysisMode = 'live' | 'custom' | 'fixed'`. Replaced `live: boolean` → `mode: CanvasAnalysisMode` on `CanvasAnalysis`. No compat shim.

**`lib/graph_types.py`:** `live: bool = True` → `mode: str = Field('live', pattern=...)`. Added `@model_validator(mode='before')` for backward compat: `live: true` → `mode: 'live'`, `live: false` → `mode: 'fixed'`.

**`public/schemas/conversion-graph-1.1.0.json`:** `live` boolean → `mode` enum `["live", "custom", "fixed"]` with default `"live"`.

**`src/lib/transform.ts`:** Migration in `toFlow`: if analysis has `live` but no `mode`, maps to appropriate mode value and deletes the legacy field.

**References updated (17 files):** All `.live` → `.mode` across components, hooks, services, and tests. Boolean checks → string comparisons. Object literals: `live: true` → `mode: 'live'`, `live: false` → `mode: 'fixed'` or `mode: 'custom'` depending on context.

### Phase 2–7: Not yet started

---

## Resolved Questions

1. **"Add scenario" in Custom mode**: Create with empty delta, then immediately open the ScenarioQueryEditModal for that slot. The empty delta is consistent with the promoted-Current pattern; opening the editor immediately guides the user to differentiate it.

2. **`chart_current_layer_dsl` interaction**: Non-issue. `chart_current_layer_dsl` is internal infrastructure derived from the analysis recipe — it's not user-facing. The compute pipeline already applies it on top of scenario DSLs in Fixed mode. Custom mode is no different; it just adds the live base underneath the scenario delta before the same pipeline runs. No change needed.

3. **Rebase lossiness**: With Phase 0's per-key clear (`context(key:)`), the rebase algebra is lossless for all clause types. The `computeRebaseDelta` function can express additions, replacements, and per-key removals. Round-trip verification is still worth doing as a safety check, but should always pass.
