# Scenarios Manager — Implementation Plan

## Overview

This plan details the implementation of the Scenarios Manager feature per `SCENARIOS_MANAGER_SPEC.md`. The feature enables users to create, compare, and compose parameter overlays (scenarios) on top of a working graph state.

## Goals

- Enable layered parameter authoring with Base + Current + overlays
- Support "All" and "Differences" snapshot types
- Provide Monaco-based editing with YAML/JSON and Flat/Nested views
- Track metadata (window, context, what-if) per scenario
- Maintain per-tab visibility/color state; graph-level scenario storage
- Minimal performance impact (≤5 visible layers; on-demand composition)

## High-Level Architecture

### State Model

```
Graph (session-scoped)
  ├─ Base (persisted baseline)
  ├─ Current (live working state)
  └─ Scenarios[] (shared across tabs)
       └─ Scenario { id, name, color, params: ScenarioParams, meta: ScenarioMeta }

Tab (view-scoped)
  └─ TabScenarioState
       ├─ visibleScenarioIds: string[]        // render order
       ├─ visibleColorOrderIds: string[]      // activation order for color assignment
       └─ selectedScenarioId?: string
```

### Key Services

1. **ScenariosContext** — CRUD, snapshot creation, flatten
2. **CompositionService** — Deep-merge diffs; produce composed params
3. **HRNResolver** — Parse and resolve human-readable names to IDs
4. **ColorAssigner** — Assign complementary/distributed colors by activation order
5. **ScenarioRenderer** — Render overlays with per-layer colors and widths

---

## Implementation Phases

### Phase 0: Preparation (1-2 days)

**Goal**: Set up data structures, contexts, and scaffolding without UI changes.

#### Tasks

1. **Define types** (`src/types/scenarios.ts`):
   ```ts
   export interface Scenario {
     id: string;
     name: string;
     color: string;
     createdAt: string;
     updatedAt?: string;
     version: number;
     params: ScenarioParams;
     meta?: ScenarioMeta;
   }

   export interface ScenarioMeta {
     window?: { start: string; end: string };
     context?: Record<string, string>;
     whatIfDSL?: string;
     whatIfSummary?: string;
     source?: 'all' | 'differences';
     sourceDetail?: string;
     createdBy?: string;
     createdInTabId?: string;
     note?: string;
   }

   export type ScenarioParams = {
     edges?: Record<string, EdgeParamDiff>;
     nodes?: Record<string, NodeParamDiff>;
   };

   export interface EdgeParamDiff {
     p?: ProbabilityParam;
     conditional_p?: Record<string, ProbabilityParam | null>;
     weight_default?: number;
     cost_gbp?: CostParam;
     cost_time?: CostParam;
   }

   export interface NodeParamDiff {
     entry?: { entry_weight?: number };
     costs?: { monetary?: any; time?: any };
     case?: {
       variants?: Array<{ name: string; weight: number }>;
     };
   }

   export interface TabScenarioState {
     visibleScenarioIds: string[];
     visibleColorOrderIds: string[];
     selectedScenarioId?: string;
   }
   ```

2. **Create ScenariosContext** (`src/contexts/ScenariosContext.tsx`):
   - Provider wraps app (shares scenarios across tabs within a graph session)
   - State: `scenarios: Scenario[]`
   - Methods: `createSnapshot`, `createBlank`, `get`, `list`, `rename`, `delete`, `applyContent`, `openInEditor`, `flatten`
   - Persists scenarios in runtime only (not saved to project JSON)

3. **Extend TabContext** to store `TabScenarioState`:
   - Add `scenarioState: TabScenarioState` per tab
   - Methods: `getVisible`, `setVisible`, `toggleVisible`, `getColorOrder`, `updateColorOrder`

4. **Create CompositionService** (`src/services/CompositionService.ts`):
   - `composeParams(base: ScenarioParams, overlays: ScenarioParams[]): ScenarioParams`
   - Deep-merge logic with deterministic precedence

5. **Create HRNResolver** (`src/services/HRNResolver.ts`):
   - `resolveEdgeHRN(hrn: string, graph: Graph): string | null` // returns edge UUID
   - `resolveNodeHRN(hrn: string, graph: Graph): string | null` // returns node UUID
   - Implements precedence: `e.<edgeId>` → `e.from(<fromId>).to(<toId>)` → `e.uuid(<uuid>)`

6. **Create ColorAssigner** (`src/services/ColorAssigner.ts`):
   - `assignColors(visibleIds: string[], activationOrder: string[]): Map<string, string>`
   - Returns color map keyed by scenario ID
   - 1 visible → grey; 2 → complementary; N → evenly distributed hues

**Acceptance**:
- Types defined and imported without errors
- ScenariosContext provider compiles; no-op methods stubbed
- TabContext extended with scenario state
- Services export functions with correct signatures

---

### Phase 1: Core CRUD and Storage (2-3 days)

**Goal**: Implement scenario creation, editing, deletion, and in-memory persistence.

#### Tasks

1. **Implement ScenariosContext CRUD**:
   - `createSnapshot({ name, type, source, diffThreshold })`:
     - Compute composed params from visible layers (excluding Current)
     - Diff Current against composed params
     - If type = 'all', include all params; if 'differences', only deltas above threshold
     - Capture `ScenarioMeta` (window, context, whatIfDSL, source, note auto-generated)
     - Insert at position 2 (just below Current in stack)
   - `createBlank(name)`: Create empty scenario, open editor
   - `applyContent(id, content, format)`: Parse YAML/JSON, validate, update scenario
   - `rename(id, name)`, `delete(id)`: Simple mutations

2. **Implement diffing logic** (`src/services/DiffService.ts`):
   - `computeDiff(current: ScenarioParams, base: ScenarioParams, type: 'all' | 'differences', epsilon?: number): ScenarioParams`
   - For 'all': return full current params
   - For 'differences': return sparse diff (only keys that differ by > epsilon)

3. **Implement CompositionService deep-merge**:
   - `composeParams(base, overlays)`: iterate overlays, merge each into accumulator
   - Handle nested structures (edges, nodes, conditional_p)
   - Null values remove keys

4. **Wire up TabContext scenario state**:
   - Initialize `scenarioState` per tab
   - `toggleVisible(tabId, scenarioId)`:
     - Add/remove from `visibleScenarioIds`
     - Add/remove from `visibleColorOrderIds` (append on show, remove on hide)
   - `reorder(tabId, newOrder)`: update `visibleScenarioIds` (does NOT affect `visibleColorOrderIds`)

5. **Test CRUD in isolation**:
   - Unit tests for createSnapshot (all/differences)
   - Unit tests for CompositionService (deep-merge edge cases)
   - Unit tests for diffing with epsilon

**Acceptance**:
- Can create scenarios programmatically
- Scenarios persist in runtime state
- Composition produces correct merged params
- Per-tab visibility state updates correctly

---

### Phase 2: HRN Resolution and Validation (2-3 days)

**Goal**: Parse and resolve human-readable parameter addresses; validate scenario content.

#### Tasks

1. **Implement HRNResolver**:
   - Parse HRN strings (e.g., `e.checkout-to-purchase.p.mean`, `n.landing.entry.entry_weight`)
   - Resolve to UUIDs using graph structure
   - Handle conditionals: `e.from(checkout).to(purchase).visited(promo).p.mean`
   - Fallback to UUID if ambiguous

2. **HRN Grammar Parser** (`src/services/HRNParser.ts`):
   - Tokenize HRN path
   - Extract entity type (e/n), selectors, conditionals, param path
   - Return parsed structure

3. **Validation** (`src/services/ScenarioValidator.ts`):
   - `validateScenarioParams(params: ScenarioParams, graph: Graph): ValidationResult`
   - Check HRN resolution
   - Check param schema compliance
   - Warn on unresolved HRNs (don't block Apply)

4. **Apply HRN resolution in CompositionService**:
   - Before merging, resolve HRNs to UUIDs
   - Cache resolution map per scenario (invalidate on graph structure change)

5. **Test HRN resolution**:
   - Unit tests for edge resolution (edgeId, endpoints, UUID)
   - Unit tests for node resolution
   - Unit tests for conditional resolution
   - Unit tests for ambiguity handling (parallel edges)

**Acceptance**:
- HRN strings resolve correctly to graph entities
- Validation warns on unresolved HRNs
- Composed params use UUIDs internally

---

### Phase 3: UI — Scenarios Palette (3-4 days)

**Goal**: Build the scenarios list UI in the What-If panel.

#### Tasks

1. **Create ScenariosPanel component** (`src/components/panels/ScenariosPanel.tsx`):
   - Render Base row (non-draggable, non-deletable, toggleable visibility)
   - Render Current row (pinned top, non-draggable, toggleable visibility)
   - Render scenario list (draggable, deletable, toggleable)
   - Each row: color swatch, name (inline edit), eye toggle, Open button, Delete button
   - Drag handles for reordering (updates `visibleScenarioIds` only)

2. **Integrate ScenariosPanel into WhatIfPanel**:
   - Add "Scenarios" section above existing What-If controls
   - Use collapsible section or always-visible

3. **Footer actions**:
   - "+ Create Snapshot" button with dropdown:
     - Primary click: "All" from visible
     - Dropdown: "All (from visible)", "All (from Base)", "Differences (from visible)", "Differences (from Base)"
   - "New" button: creates blank scenario, opens editor
   - "Flatten" button: sets Base := Current, clears all overlays, shows confirmation dialog

4. **Color swatch display**:
   - Use `ColorAssigner` to compute color per scenario based on `visibleColorOrderIds`
   - Display color swatch next to name
   - Click swatch to manually override color (store in `Scenario.color`)

5. **Tooltip on hover**:
   - Show `Scenario.meta` summary (window, context, what-if, source, created)

6. **Wire up visibility toggles**:
   - Click eye icon → `toggleVisible(tabId, scenarioId)`
   - Update `visibleColorOrderIds` on toggle
   - Re-assign colors via `ColorAssigner`

**Acceptance**:
- Scenarios palette renders correctly
- Can create snapshots via UI
- Can toggle visibility; colors update correctly
- Can drag to reorder; render order updates
- Can delete scenarios
- Can rename scenarios inline

---

### Phase 4: Monaco Editor Modal (3-4 days)

**Goal**: Build the Monaco modal for viewing/editing scenario parameters.

#### Tasks

1. **Create ScenarioEditorModal component** (`src/components/modals/ScenarioEditorModal.tsx`):
   - Monaco editor (reuse FormEditor pattern)
   - Toggles: YAML/JSON (syntax), Nested/Flat (structure)
   - Metadata panel (above editor):
     - Read-only: window, context, what-if, source, created
     - Editable: note (textarea)
   - Actions: Apply, Cancel
   - Export: "Copy as CSV" button (flat format, two-column key/value)

2. **Implement format converters** (`src/services/ScenarioFormatConverter.ts`):
   - `toYAML(params, format: 'nested' | 'flat'): string`
   - `toJSON(params, format: 'nested' | 'flat'): string`
   - `toCSV(params): string` (flat only; key,value pairs)
   - `fromYAML(content): ScenarioParams`
   - `fromJSON(content): ScenarioParams`

3. **Wire up modal to ScenariosContext**:
   - `openInEditor(scenarioId)` → open modal with scenario content
   - `applyContent(scenarioId, content, format)` on Apply click
   - Validate on Apply; show inline diagnostics (Monaco markers)

4. **Base/Current editing**:
   - `openBaseInEditor()` → open modal with Base params (editable)
   - Apply to Base mutates Base directly
   - "Save as Snapshot" action creates new overlay from editor content

5. **Metadata panel**:
   - Display `Scenario.meta` fields (read-only except note)
   - Update `meta.note` on Apply

**Acceptance**:
- Modal opens with correct content
- Can toggle YAML/JSON and Nested/Flat; content updates correctly
- Can edit and Apply; changes persist
- Validation errors display inline
- CSV export works
- Metadata panel displays and note is editable

---

### Phase 5: Rendering and Composition (3-4 days)

**Goal**: Render scenario overlays with correct colors, widths, and offsets.

#### Tasks

1. **Create ScenarioRenderer** (`src/services/ScenarioRenderer.ts`):
   - `renderScenarios(graph, visibleScenarioIds, visibleColorOrderIds, tabId): ScenarioRenderData[]`
   - For each visible scenario:
     - Compose params up to that layer
     - Compute edge widths using `calculateEdgeWidth` with composed params
     - Compute Sankey offsets per edge
     - Return render data: { scenarioId, color, edgePaths[] }

2. **Integrate with GraphCanvas**:
   - After rendering base edges, render scenario overlays
   - For each overlay: draw edge paths with scenario color, `mix-blend-mode: multiply`, `strokeOpacity: 0.3`
   - Use `strokeLinecap: 'butt'`, `strokeLinejoin: 'miter'`

3. **Color assignment**:
   - Use `ColorAssigner.assignColors(visibleScenarioIds, visibleColorOrderIds)`
   - 1 visible → grey
   - 2 visible → complementary (blue/pink)
   - N visible → evenly distributed hues

4. **Handle Current visibility**:
   - If Current is hidden, skip rendering Current layer
   - If user edits while Current is hidden, auto-unhide Current and show toast

5. **Optimize rendering**:
   - Memoize parsed ScenarioParams (content hash)
   - Throttle recompute on rapid visibility changes (use requestAnimationFrame)
   - Cache HRN resolution per scenario

**Acceptance**:
- Overlays render correctly with assigned colors
- Widths and offsets are computed per layer
- Color neutralization works (two identical overlays blend to neutral)
- Differences show as colored fringes
- Performance acceptable with ≤5 visible layers

---

### Phase 6: What-If Interplay and Flatten (2-3 days)

**Goal**: Handle What-If state correctly; implement Flatten.

#### Tasks

1. **What-If and Current**:
   - What-If applies only to Current
   - If Current is hidden, What-If effects are muted
   - On What-If change while Current hidden, auto-unhide Current (toast)

2. **Flatten implementation**:
   - `flatten()` in ScenariosContext:
     - Compute composed Current params (all visible layers + Current)
     - Set Base := composed params
     - Clear all overlays (delete all scenarios)
     - Current remains visible
   - Show confirmation dialog before Flatten
   - Update UI to reflect cleared overlays

3. **Snapshot creation with What-If**:
   - If What-If is active, capture `meta.whatIfDSL` and `meta.whatIfSummary`
   - "All" snapshot materializes What-If effects into params (e.g., variant weights set to 1.0/0.0)
   - "Differences" snapshot captures sparse diff including What-If changes

4. **Auto-generated note**:
   - On snapshot creation, generate `meta.note`:
     - "Snapshot of [window range] with What-If: [dsl summary]"
     - User can edit note in modal

**Acceptance**:
- What-If applies only to Current
- Auto-unhide on What-If change while Current hidden
- Flatten works correctly; overlays cleared
- Snapshot captures What-If metadata
- Auto-generated note is helpful and editable

---

### Phase 7: Testing and Polish (3-4 days)

**Goal**: Comprehensive testing, edge case handling, accessibility, and UX polish.

#### Tasks

1. **Unit tests**:
   - CompositionService (deep-merge, null removal)
   - DiffService (all/differences, epsilon)
   - HRNResolver (all selector types, ambiguity)
   - ColorAssigner (1/2/N colors)
   - ScenarioFormatConverter (round-trip YAML/JSON, flat/nested)

2. **Integration tests**:
   - Create snapshot → edit → apply → render
   - Toggle visibility → reorder → colors update
   - Flatten → overlays cleared → Base updated
   - Multi-tab: different visibility per tab

3. **Edge cases**:
   - Empty scenarios
   - Scenarios with unresolved HRNs (warn but allow)
   - Scenarios captured from changed graph (fail gracefully)
   - Parallel edges (UUID fallback)
   - Renamed nodes/edges (HRN resolution fails, warning)

4. **Accessibility**:
   - Color contrast checks (ensure colors meet WCAG AA)
   - Keyboard navigation (scenarios list, modal)
   - Screen reader labels (color swatches, buttons)

5. **Performance profiling**:
   - Test with 5+ visible scenarios
   - Profile composition and rendering
   - Add soft cap warning if > 5 visible

6. **UX polish**:
   - Smooth drag interactions
   - Toast notifications (auto-unhide, flatten confirmation)
   - Loading states (if parsing/validating large scenarios)
   - Error states (validation errors in modal)

**Acceptance**:
- All unit tests pass
- Integration tests cover main flows
- Edge cases handled gracefully
- Accessibility requirements met
- Performance acceptable

---

## Incremental Rollout Strategy

### Stage 1: Internal Alpha (Phase 0-3 complete)

- Enable scenarios palette and basic CRUD
- No rendering; scenarios are "view-only" via modal
- Collect feedback on UX and data model

### Stage 2: Beta with Rendering (Phase 0-5 complete)

- Enable scenario rendering
- Soft cap at 3 visible scenarios
- Feature flag: `enable_scenarios_beta`
- Monitor performance and user feedback

### Stage 3: General Availability (Phase 0-7 complete)

- Remove feature flag
- Increase soft cap to 5 visible scenarios
- Full documentation and help tooltips
- Announce feature

---

## Risk Mitigation

### Risk: Performance degradation with many scenarios

**Mitigation**:
- Soft cap at ≤5 visible scenarios; warn if exceeded
- Throttle recompute on rapid toggles
- Memoize parsed params and HRN resolution
- Defer heavy caching to post-v1 if needed

### Risk: HRN resolution ambiguity or breakage

**Mitigation**:
- Fallback to UUID for ambiguous cases
- Validation warns but does not block Apply
- Provide linter in modal to suggest UUID disambiguation
- Document HRN best practices

### Risk: Tab state vs graph state confusion

**Mitigation**:
- Clear separation: scenarios (graph-level), visibility/color (tab-level)
- UI affordances show "Tab: A" indicator
- Tooltip shows scenario is "visible in this tab"

### Risk: What-If and scenario state conflicts

**Mitigation**:
- What-If applies only to Current
- Auto-unhide Current on What-If change
- Snapshot captures What-If metadata for provenance

### Risk: Flatten confusion (data loss)

**Mitigation**:
- Show confirmation dialog with clear explanation
- Flatten is session-local; repo commit is separate
- Undo: not supported in v1; consider for v2

---

## Dependencies and Prerequisites

1. **Existing systems**:
   - TabContext (extend with `TabScenarioState`)
   - WhatIfContext (read What-If state for snapshot metadata)
   - ViewPreferencesContext (for window/date range)
   - FormEditor/Monaco (reuse for modal)

2. **New dependencies**:
   - YAML parser: `js-yaml` (already used?)
   - CSV export: built-in or simple string builder
   - Deep-merge utility: custom or use `lodash.merge`

3. **Data structures**:
   - No changes to graph JSON schema
   - Scenarios stored in runtime only (not persisted to project files)

---

## Timeline Estimate

| Phase | Duration | Cumulative |
|-------|----------|------------|
| Phase 0: Preparation | 1-2 days | 2 days |
| Phase 1: CRUD and Storage | 2-3 days | 5 days |
| Phase 2: HRN Resolution | 2-3 days | 8 days |
| Phase 3: UI Palette | 3-4 days | 12 days |
| Phase 4: Monaco Modal | 3-4 days | 16 days |
| Phase 5: Rendering | 3-4 days | 20 days |
| Phase 6: What-If & Flatten | 2-3 days | 23 days |
| Phase 7: Testing & Polish | 3-4 days | 27 days |

**Total: ~4-5 weeks (27 days)**

Adjust for parallel work (e.g., UI and services can overlap) or team size.

---

## Success Metrics

- **Adoption**: % of users who create ≥1 scenario per week
- **Usage**: Average # of visible scenarios per session
- **Performance**: P95 render time for 3 visible scenarios < 100ms
- **Errors**: Validation warnings per scenario < 5%
- **Feedback**: User satisfaction score ≥4/5 in post-release survey

---

## Post-v1 Enhancements (Future)

1. **Persistent scenarios**: Save scenarios to project JSON or separate `.scenarios.json` file
2. **Scenario templates**: Pre-built scenarios for common use cases
3. **Scenario comparison view**: Side-by-side diff of two scenarios
4. **Undo/redo for Flatten**: Store snapshot of pre-flatten state
5. **Conditional blob indicators** (PHASE 2): Move conditional/case indicators to blobs instead of edge colors
6. **Advanced color settings**: User-customizable color palettes
7. **Scenario export/import**: Share scenarios between projects
8. **Scenario version history**: Track changes to scenarios over time

---

## Conclusion

This implementation plan provides a structured, phased approach to building the Scenarios Manager feature. Each phase has clear goals, tasks, and acceptance criteria. The incremental rollout strategy minimizes risk and allows for feedback-driven iteration. Total estimated effort is ~4-5 weeks for a single developer, or ~2-3 weeks with two developers working in parallel on UI and services.

