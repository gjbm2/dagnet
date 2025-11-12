# Scenarios Manager Specification

## Purpose
Enable users to create, view, and compare multiple “scenario” overlays of graph parameters on top of the current working state (base). Scenarios are captured snapshots of the full parameter surface (the same surface the What‑If system manipulates). Multiple scenarios can be displayed concurrently; differences surface visually via colored fringes where edge widths diverge.

## Scope
- Adds a Scenarios palette above the existing What‑If controls. What‑If remains unchanged.
- Scenarios are snapshots of graph parameters and can be opened for direct JSON editing in a Monaco modal.
- When visible, each scenario is rendered as an additional edge layer with its own widths and Sankey offsets.
- Graph routing (topology/control points) is NOT re-generated per scenario; scenarios follow the current graph structure and fail gracefully if the graph has changed.

## Terminology
- Base: The current working state (what the user actively edits).
- Scenario: A named, colored, editable snapshot of parameters, rendered as an overlay when visible.

## UX
- Location: “Scenarios” section at the top of the What‑If panel
- Scenario list items (stacked):
  - Drag handles (drag and drop up/down to reorder palette; order affects visual render order only, not computation)
  - Color swatch (click to change color - manual override)
  - Name (inline editable; default: timestamp like "2025-11-12 14:30")
  - View toggle (eye icon) — visibility is per tab
  - Open (launches Monaco modal to edit YAML/JSON)
  - Delete (trash)
  - Tooltip on hover: Shows snapshot metadata (window, What-If state, context, created timestamp)
- Footer actions:
  - "+ Create Snapshot" (from current state; creates new scenario with current parameters), on top of stack
  - "New" (creates blank scenario and opens Monaco modal for initial YAML/JSON entry)
- Monaco modal (uses FormEditor component pattern, but rendered as modal overlay, not a tab):
  - Displays full scenario YAML/JSON (parameters payload)
  - Live validation with inline diagnostics
  - Actions: Apply, Cancel
  - Toggle: YAML/JSON (switches editor format)
  - Users can copy/paste within Monaco; no separate copy/paste buttons needed

- Special "Current" scenario:
  - Always shown at top of list (non-draggable)
  - Represents the base/working state (not a stored snapshot)
  - Not deletable
  - Has color swatch, name (read-only "Current"), view toggle, and Open button
  - Open button: launches Monaco modal showing current parameter state (editable)
  - When user edits "Current" params in Monaco and clicks Apply: creates a NEW scenario with those edited parameters and makes it visible automatically
  - When visible, renders as overlay like other scenarios but uses live current parameters
  - Auto-visibility: When graph changes (user edits), "Current" is automatically made visible if hidden (with brief toast)

## Data Model
Scenario (stored in graph runtime; see Persistence):
```ts
type Scenario = {
  id: string;              // uuid
  name: string;
  color: string;           // hex or hsl string, consistent luminance
  createdAt: string;       // ISO
  updatedAt?: string;      // ISO
  version: number;         // schema version for params payload
  params: ScenarioParams;  // full parameter surface snapshot
};
```

Notes:
- Visibility is tracked per tab, not in the Scenario object (see Persistence).
- `ScenarioParams` uses the same schema as the What‑If parameter surface (edges, conditional ps, node weights, global multipliers/overrides), using the same rounding and determinism constraints as update flows.

## Persistence
- Scenarios are stored in the graph runtime and shared across tabs for the same graph session.
- Scenarios are NOT saved into the project `.json` files.
- Per‑tab state persists which scenario IDs are visible and the active selection:
```ts
type TabScenarioState = {
  visibleScenarioIds: string[];   // order reflects legend/render order
  selectedScenarioId?: string;    // for “Open” default target, optional
};
```

## Color Strategy (Complementarity)
- Goal: When two scenarios with identical parameters are visible, their colors visually neutralize (over the base), so no bias appears; differences show as colored fringes.
- **Auto-assignment model** (see Open Questions #10 for manual override options):
  - Colors are assigned only to visible scenarios. When visibility changes, colors are dynamically reassigned to maintain geometric neutralization among the currently visible set.
  - When a scenario is toggled off: it loses its color assignment (color is freed for reassignment).
  - When a scenario is toggled on: it receives a color computed via `assignColor()` based on the current set of visible scenarios.
  - Color assignment algorithm:
    - For two visible scenarios: assign complementary hues (≈180° apart) at equal perceived luminance/saturation.
    - For N > 2: distribute hues evenly around the wheel (maximal separation). Prefer pairwise complementaries when possible (even N).
    - Keep luminance stable to avoid bias.
  - Manual color override: TBD (see Open Questions #10 for options).
- Blending:
  - Default: `mix-blend-mode: multiply`
  - Low, stable `strokeOpacity` (e.g., 0.25–0.40) per scenario to support neutralization when overlaps are equal.
  - Exact neutralization is display/scene dependent; tune defaults empirically.

## Rendering Pipeline

**CLARIFICATION NEEDED: Layering Model**

Two possible interpretations:

### Option A: Independent Comparison (Parallel Model)
- Each scenario is a complete, independent parameter snapshot.
- Scenarios render in parallel (not stacked/layered).
- "Current" is just one scenario among others; order doesn't affect computation.
- Use case: Compare time periods, A/B variants, etc. Each is a full snapshot.
- Snapshot scope: Always captures full param set (What-If is part of "current params").

### Option B: Additive Layering (Stacked Model)
- Scenarios are partial parameter overrides.
- Render order matters: bottom layer computed first, each layer above overrides/adjusts previous.
- "Current" is typically bottom; user can stack partial overlays (e.g., "change only probabilities").
- Use case: Build up scenarios incrementally (base + what-if + context adjustment).
- Snapshot scope: Can capture partial param sets (only changed params).

**User's caps comment suggests Option B** ("each param pack adjusts param pack of previous layer"), but the rest of the spec describes Option A (full snapshots, parallel comparison).

**PROPOSAL**: Start with Option A (simpler, clearer semantics). Add Option B layering in Phase 2 if needed.

---

### Rendering Pipeline (assuming Option A: Independent Comparison)

Base render:
- Edges render using current working parameters.
- Existing confidence intervals, selections, and highlights continue to function.

Scenario overlays (for each visible scenario S):
1. Parameter computation
   - Use S.params as the **complete** parameter surface for this scenario.
   - Each scenario is computed independently (no dependency on other scenarios' order).
2. Widths
   - Compute edge widths with the existing `calculateEdgeWidth(...)` pipeline using S.params.
3. Sankey offsets (per scenario)
   - Compute lateral source/target offsets using S.params (flows/weights).
   - Result: For each edge, S has its own width and its own source/target lateral offsets.
4. Routing and geometry
   - Scenarios use the current graph geometry (base's paths/control points).
   - Apply per‑scenario source/target lateral offsets to current geometry.
5. Drawing
   - Render scenario path using S.color, `mix-blend-mode: multiply`, fixed `strokeOpacity`.
   - Use `strokeLinecap: 'butt'`, `strokeLinejoin: 'miter'` for crisp, truncated ends.
6. Edge coloring suppression
   - If >1 scenario visible: suppress conditional probability and case edge coloring (render all grey).
   - This frees edge colors for scenario overlays.

Fail‑gracefully rules when graph changed since snapshot:
- If an edge present in S.params no longer exists:
  - Skip rendering for that edge (optionally log/debug mark).
- If a new edge exists that S.params does not cover:
  - Skip for that edge under S (only base shows it).
- If node ids/edge ids map changed:
  - Attempt matching by stable IDs; otherwise skip.

Render order:
- Scenarios render in the order of the scenarios palette (user can reorder via drag handles).
- Reordering updates the `visibleScenarioIds` array order for the current tab.
- "Current" scenario (if visible) renders first, then stored scenarios in palette order. 

## Operations (ScenariosContext API)
```ts
interface ScenariosContext {
  list(): Scenario[];
  get(id: string): Scenario | undefined;
  createFromCurrent(name?: string): Scenario; // snapshots current parameter surface + What-If/context state, assigns color when visible
  createBlank(name?: string): Scenario;      // creates empty scenario, opens editor
  openInEditor(id: string): void;            // launches Monaco modal for scenario
  applyContent(id: string, content: string, format: 'yaml' | 'json'): Result<Scenario, Error>; 
  // validate & persist; if id is "current", creates NEW scenario instead of modifying base
  rename(id: string, name: string): void;
  setColor(id: string, color: string): void;
  reorder(scenarioIds: string[]): void;      // updates order (affects render order)
  delete(id: string): void;

  // Per-tab visibility state
  getVisible(tabId: string): string[];       // returns IDs in palette order
  setVisible(tabId: string, scenarioIds: string[]): void;
  toggleVisible(tabId: string, id: string): void;
  setSelected(tabId: string, id?: string): void;
  
  // Color assignment
  assignColor(scenarioId: string, existingVisibleIds: string[]): string; // computes complementary color
  
  // "Current" scenario helpers
  getCurrentParams(): ScenarioParams;       // returns current working state parameters
  openCurrentInEditor(): void;              // opens "Current" in Monaco modal
}
```

## Validation 
- Validate `ScenarioParams` on Apply (Monaco modal). 
- Warn inline with diagnostics, but do not block Apply (allow users to save partial/invalid data if needed).
- On Apply with errors: persist anyway but mark scenario as "has validation errors" (visual indicator in list). 

## Performance
- Cache per-scenario computed widths/offsets per edge, keyed by:
  - `(scenarioId, edgeId, geometryHash, paramsHash)`
- Batch recompute on idle or microtask after parameter changes to avoid jank.
- Soft cap: recommend ≤5 visible scenarios; warn/degrade gracefully beyond.

## Accessibility
- Ensure color assignments meet minimum contrast when drawn over the base gray.
- Provide tooltip/legend entries that identify scenario name/color.

## Interactions & Compatibility
- Highlights/selection: apply to base and overlays consistently; overlays use their own colors but respect selection emphasis.
- Confidence intervals: CI can remain enabled when scenarios are visible. CI bands render on base layer only (scenario overlays render without CI for v1).
- Edge labels: base labels remain primary; optional future: per-scenario delta badges on hover.

## Open‑In‑Monaco Modal
- Displays the full YAML/JSON for the scenario’s `params` (and optionally metadata).
- Validation:
  - YAML/JSON syntax and schema validation with error annotations.
  - On Apply, persist and bump `updatedAt` 
- No separate Copy/Paste UI; users use Monaco’s editor commands.

## User Flow Examples

### Flow 1: Compare current state against historic state
1. User starts with current graph (showing latest data)
2. User clicks "+ Create Snapshot" → snapshot created **on top of Current** (per user's edit), visible=true
3. Two layers now visible (Current + Snapshot), each assigned a color (e.g., Blue & Pink)
4. User changes window (date range) → new data retrieves for Current
5. User sees deltas: colored fringes show where Current differs from historic Snapshot

**Status**: ✓ Semantics clear (Option A model works well).

### Flow 2: Investigate before/after of experiment in progress
1. User starts with current graph
2. User applies What-If: `case1=treatment`
3. User unchecks all options in "Create Snapshot" dropdown except "What-If" and clicks snapshot
4. **PROBLEM**: Partial snapshots (What-If only) don't make sense in Option A (independent comparison). Snapshot would be incomplete.
5. **RESOLUTION**: See "Snapshot Scope Semantics" below.

### Flow 3: Multi-scenario comparison (time series)
1. User loads data for Week 1, clicks snapshot → "Week 1" scenario created
2. User changes window to Week 2, clicks snapshot → "Week 2" scenario created
3. User changes window to Week 3, clicks snapshot → "Week 3" scenario created
4. Three scenarios visible (all with different colors: Cyan, Magenta, Yellow)
5. User can toggle visibility to compare any subset (e.g., Week 1 vs Week 3)

**Status**: ✓ Clear use case for Option A.

---

## Snapshot Scope Semantics

**Problem**: Partial parameter snapshots (e.g., "What-If only") don't make semantic sense in Option A (independent comparison). Each scenario must be a complete parameter set to render.

**Proposal**: Rethink snapshot scope options:

1. **"Parameters" (default)**: Snapshot all underlying graph parameters (probabilities, costs, lags) in their current state. **Excludes** What-If overrides.
2. **"Parameters + What-If"**: Snapshot underlying params **with** What-If overrides applied (merged into params).
3. ~~**"What-If only"**~~: Removed. Doesn't make sense semantically (incomplete snapshot).

**Rationale**:
- "Parameters" = base state (useful for time-series comparisons across windows)
- "Parameters + What-If" = hypothetical state (useful for experiment comparisons)
- Mutually exclusive makes sense; partial snapshots don't.

**Updated "Create Snapshot" dropdown**:
- ☑ Include What-If overrides (default: unchecked)
- ~~Checkboxes for Probabilities/Costs/Lags~~: Removed (all params always included)

---

## Additional Clarifications

### 3. Default labels for scenarios
- **Default name**: Timestamp (e.g., "2025-11-12 14:30")
- **Tooltip on hover**: Shows metadata about snapshot creation state:
  - Window: `2025-11-05 to 2025-11-12`
  - What-If: `case1=treatment` (if any)
  - Context: `channel=mobile` (if any, future)
  - Created: ISO timestamp

### 4. What happens if "Current" is hidden?
- **Behavior**: User edits to graph won't display visually (only stored scenarios render).
- **Risk**: Potentially confusing.
- **Solution**: When graph changes (user edits params), automatically make "Current" visible if it's hidden.
- **Implementation**: On graph mutation, check if "Current" is hidden → if yes, toggle it visible and show brief toast: "Current state is now visible".

### 5. Snapshot scope rethinking
See "Snapshot Scope Semantics" above. Recommendation: Drop partial snapshots; only allow:
- Full params (excluding What-If)
- Full params + What-If merged

## Acceptance Criteria
- Users can create a snapshot from current parameters; it appears in the list with an assigned color and is invisible by default or follow product choice (tunable).
- Users can rename, recolor, toggle visibility (per tab), open the JSON modal, apply edits, and delete scenarios.
- When scenarios are visible, overlays render with per-scenario widths and per-scenario Sankey offsets using current graph geometry.
- If two visible scenarios are identical, their overlays produce neutral appearance over the base (no obvious color bias), subject to blending and display variance.
- If widths differ, colored fringes appear where one scenario’s edge extends beyond another.
- Scenarios persist in graph runtime (shared across tabs); visibility is stored per tab.

## Open Questions / Areas Needing Design
1. **Exact blending and alpha defaults**: Best values for neutralization across a variety of base colors and background themes (empirical tuning needed).
2. **Confidence intervals with scenarios**:
   - **Decision**: Permit user to leave CI on if they wish. No reason we cannot accommodate.
   - CI bands render on base layer; scenario overlays render without CI (for simplicity in v1).
   - Sankey diagram mode: No blocking issue; scenarios should work in Sankey mode.
3. **"Current" scenario implementation**:
   - **Revised decision** (see "Rendering Pipeline" clarification): "Current" is **not draggable**. Scenarios render independently (parallel comparison model, not stacked/layering). Order affects only visual render order, not computation.
   - **Color assignment for "Current"**: Same as for other scenarios. If 1 visible scenario, render normally (grey). If >1 visible, assign colors to all visible scenarios including "Current" using the complementary color algorithm.
   - **When "Current" is opened and edited, Apply**: Creates a new scenario and makes it visible automatically.
   - **Auto-visibility on edit**: When graph changes (user edits params), automatically make "Current" visible if hidden (with brief toast notification).
4. **Tooling/Architecture**:
   - Where to host `ScenariosContext` (new context vs extend existing ViewPreferences/Operations)?
   - Recommendation: New `ScenariosContext` for separation of concerns.
5. **Invalid data handling**:
   - **Decision**: Store raw YAML/JSON string. Parse to ScenarioParams when needed (on scenario visibility change, data change, graph structure change, etc.).
   - Parsing is lightweight: enumerate through each visible scenario layer from bottom to top, apply params sequentially, store result.
   - Schema evolution: attempt best-effort parsing; mark scenario as invalid if parsing fails; allow user to fix in Monaco editor.
6. **Color conflict with conditional/case edges** (PHASE 2):
   - **Decision**: Move conditional/case indicators to "blobs" (small colored markers/shapes) on edges instead of coloring the entire edge stroke.
   - This is PHASE 2 work (deferred from v1).
   - Blob design (placement, size, interaction) TBD.
7. **UI layout reorganization**:
   - **Decision**: Add a new floating panel just to the right of the date picker (WindowSelector).
   - Panel contains:
     - **What-If button**: Shows What-If options in a dropdown. Uses existing What-If icon (lucide icon already used to indicate What-If is applied on graph).
     - **Context button**: Shows context dropdown (currently contains "Coming soon"). Uses same icon as used for contexts globally.
   - Both buttons use consistent Lucide icons.
   - Scenarios palette remains in sidebar What-If panel (renamed accordingly).
8. **Snapshot scope**:
   - **Revised decision** (see "Snapshot Scope Semantics" section): "Create Snapshot" button has simplified affordance:
     - Click: Copies all current parameters (excluding What-If overrides)
     - Dropdown arrow (right side): Shows dropdown menu with single checkbox:
       - ☑ Include What-If overrides (default: unchecked)
   - Partial parameter snapshots (e.g., "only probabilities") removed: doesn't make semantic sense in independent comparison model.
   - Context: TO FOLLOW (deferred).
9. **Selection behavior (Photoshop layers palette pattern)** (PHASE 2):
   - **Decision for v1**: Eye icon = toggle visibility. Keep this approach.
   - "View only this layer" feature: PHASE 2 (deferred). Users can manually deselect other layers, so this is convenience, not MVP.
   - No row-level click or double-click at this stage.
   - Only interactions: eye icon (toggle), Open button (editor), Delete button, color swatch (picker), name (inline edit), drag handle (reorder).
10. **Color assignment strategy**:
    - **Decision**: Auto-assignment with standard color sequence.
    - Colors assigned in standard sequence based on number of visible scenarios:
      - 1 visible: Grey (normal mode, no overlay color)
      - 2 visible: Blue and Pink (complementary pair)
      - 3 visible: Cyan, Magenta, Yellow (evenly distributed)
      - 4+ visible: Continue geometric distribution around color wheel
    - Users can control color assignment by ordering visibility: hide all, then make visible in desired order.
    - Color swatch click: allows manual color override (Option B approach).
    - PHASE 2: Add advanced "Color Settings" option to allow user to specify custom color sequence.

