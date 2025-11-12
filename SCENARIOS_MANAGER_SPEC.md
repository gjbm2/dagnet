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
  - Drag handles (drag and drop up/down to reorder palette; order affects render order)
  - Color swatch (click to change color)
  - Name (inline editable)
  - View toggle (eye icon) — visibility is per tab
  - Open (launches Monaco modal to edit YAML/JSON)
  - Delete (trash)
- Footer actions:
  - "+ Create Snapshot" (from current state; creates new scenario with current parameters)
  - "New" (creates blank scenario and opens Monaco modal for initial YAML/JSON entry)
- Monaco modal (uses FormEditor component pattern, but rendered as modal overlay, not a tab):
  - Displays full scenario YAML/JSON (parameters payload)
  - Live validation with inline diagnostics
  - Actions: Apply, Cancel
  - Toggle: YAML/JSON (switches editor format)
  - Users can copy/paste within Monaco; no separate copy/paste buttons needed

- Special "Current" scenario:
  - Always shown at top of list (non-draggable, or draggable? TBD)
  - Represents the base/working state (not a stored snapshot)
  - Not deletable
  - Has color swatch, name (read-only "Current"), view toggle, and Open button
  - Open button: launches Monaco modal showing current parameter state (read-only view, or editable?)
  - When user edits "Current" params in Monaco and clicks Apply: creates a NEW scenario with those edited parameters (does not modify the base graph directly)
  - When visible, renders as overlay like other scenarios but uses live current parameters

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
Base render (unchanged):
- Edges render using current working parameters.
- Existing confidence intervals, selections, and highlights continue to function.

Scenario overlays (for each visible scenario S):
1. Parameter injection
   - Use S.params as the parameter surface for computation.
2. Widths
   - Compute edge widths with the existing `calculateEdgeWidth(...)` pipeline using S.params.
3. Sankey offsets (per scenario)
   - Compute the same lateral source/target offsets we use today, but using S.params (flows/weights) for that scenario.
   - Result: For each edge, S has its own width and its own source/target lateral offsets.
4. Routing and geometry
   - No need to re-route control points or topology. Scenarios use the current graph geometry (the base’s paths/control points).
   - Apply per‑scenario source/target lateral offsets to the current geometry when constructing the path for S (as we do today for Sankey lanes).
5. Drawing
   - Render the scenario path over the base using S.color, `mix-blend-mode: multiply`, and a fixed `strokeOpacity` (per scenario, not per edge).
   - Use `strokeLinecap: 'butt'`, `strokeLinejoin: 'miter'` for crisp, truncated ends.

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
- Confidence intervals: out of scope for scenarios in v1 (render base CI only, or disable CI when scenarios visible — see Open Questions).
- Edge labels: base labels remain primary; optional future: per-scenario delta badges on hover.

## Open‑In‑Monaco Modal
- Displays the full YAML/JSON for the scenario’s `params` (and optionally metadata).
- Validation:
  - YAML/JSON syntax and schema validation with error annotations.
  - On Apply, persist and bump `updatedAt` 
- No separate Copy/Paste UI; users use Monaco’s editor commands.

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
   - Disable CI when scenarios visible, or render CI on base only, or per-scenario CI (complex)?
   - Recommendation: Disable CI when any scenario is visible (simplest, avoids visual clutter).
3. **"Current" scenario implementation**:
   - Should it be a special pseudo-scenario object, or handled separately in rendering?
   - How to handle color assignment for "Current" if it's visible?
   - Should "Current" be draggable in the palette? (TBD - probably not)
   - When "Current" is opened and edited, Apply creates a new scenario - should the new scenario be auto-selected/opened?
4. **Tooling/Architecture**:
   - Where to host `ScenariosContext` (new context vs extend existing ViewPreferences/Operations)?
   - Recommendation: New `ScenariosContext` for separation of concerns.
5. **Invalid data handling**:
   - When Apply is called with invalid JSON/YAML, should we store raw string or attempt partial parse?
   - How to handle schema evolution gracefully?
6. **Color conflict with conditional/case edges**:
   - Scenarios reserve colors for edge rendering, so conditional probabilities and case node inheritance currently shown via edge colors need a new visual approach.
   - Proposed: Move conditional/case indicators to "blobs" (small colored markers/shapes) on edges instead of coloring the entire edge stroke.
   - Need to design blob placement, size, and interaction (hover tooltips, etc.).
7. **UI layout reorganization**:
   - Move What-If options up next to the window (where context will also be located).
   - Make space in current What If palette for Scenarios (and re name accordingly)
8. **Snapshot scope**:
   - "Create Snapshot" should capture both current parameter status AND What-If/context status (not just base parameters).
   - This ensures scenarios are fully self-contained and reproducible.
   - Need to define what "context status" includes (filters, selections, view state?).
9. **Selection behavior (Photoshop layers palette pattern)**:
   - When user selects a row in the palette, should we show only that scenario and hide others? (like Photoshop's "show only this layer")
   - Need to design the affordance clearly:
     - Eye icon = toggle visibility (current design)
     - Click row/name = select (what does this do? show-only? highlight? both?)
     - Need to distinguish between "show/hide" and "show only" actions
   - Consider: Click row selects, double-click opens editor? Or click row shows-only, eye icon toggles?
10. **Color assignment strategy**:
    - **Auto-assignment approach**: Colors are attached only to visible scenarios. When scenarios are toggled on/off, colors are reassigned to maintain geometric neutralization among the currently visible set.
    - **Implication**: Toggle a scenario off → it loses its color. Toggle it back on → it gets a new color (possibly different) based on current visible set.
    - **Question**: Should users be able to manually choose which visible scenario gets which color?
      - **Option A**: No manual override - colors are always auto-assigned for optimal neutralization.
      - **Option B**: Allow manual color picker, but warn if it breaks neutralization (e.g., two scenarios with similar hues).
      - **Option C**: Color swatch click opens palette, but system suggests/completes complementary colors based on visible set.
      - **Option D**: User can "lock" a scenario's color, preventing auto-reassignment when toggling others.
    - **Recommendation needed**: Which approach balances user control with visual harmony?

