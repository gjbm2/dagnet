# Scenarios Manager Specification

## Purpose
Enable users to create, view, and compare multiple “scenario” overlays of graph parameters on top of the current working state (base). Scenarios are captured snapshots of the full parameter surface (the same surface the What‑If system manipulates). Multiple scenarios can be displayed concurrently; differences surface visually via coloured fringes where edge widths diverge.

## Scope
- Adds a Scenarios palette above the existing What‑If controls. What‑If remains unchanged.
- Scenarios are snapshots of graph parameters and can be opened for direct JSON editing in a Monaco modal.
- When visible, each scenario is rendered as an additional edge layer with its own widths and Sankey offsets.
- Graph routing (topology/control points) is NOT re-generated per scenario; scenarios follow the current graph structure and fail gracefully if the graph has changed.

## Terminology
- Base: Session baseline; bottom layer reference (default hidden). Flatten sets Base := Current within the session. Persisting to repo is a separate commit action.
- Current: Live working state (in‑memory graph + What‑If); top layer; receives edits; can be hidden.
- Scenario: A named, coloured, editable overlay stored as a diff; rendered when visible.

## UX
- Location: “Scenarios” section at the top of the What‑If panel
- Scenario list items (stacked):
  - Drag handles (drag and drop up/down to reorder palette; order affects visual render order only, not computation)
  - Colour swatch (click to change colour - manual override)
  - Name (inline editable; default: timestamp like "2025-11-12 14:30")
  - View toggle (eye icon) — visibility is per tab
  - Open (launches Monaco modal to edit YAML/JSON)
  - Delete (trash)
  - Tooltip on hover: Shows snapshot metadata from `Scenario.meta` (window, context, what‑if summary, source, created timestamp)
- Footer actions:
  - "+ Create Snapshot" (from current state; creates new scenario with current parameters), on top of stack
  - "New" (creates blank scenario and opens Monaco modal for initial YAML/JSON entry)
  - "Flatten" (set Base := Current for this graph session; clear all overlays; does not commit to repo)
- Monaco modal (uses FormEditor component pattern, but rendered as modal overlay, not a tab):
  - Displays full scenario YAML/JSON (parameters payload)
  - Live validation with inline diagnostics
  - Actions: Apply, Cancel
  - Syntax toggle: YAML | JSON (switches serialization)
  - Structure toggle: Nested | Flat
    - Default: YAML + Nested
    - Flat representation uses dotted HRN keys (e.g., `e.checkout-to-purchase.p.mean`)
    - Nested representation uses hierarchical objects under `e:` and `n:` keys
    - Switching syntax/structure is lossless and round-trips to the same internal AST
  - Export: "Copy as CSV" (Flat) — copies two-column CSV (key,value) derived from the current content
  - Metadata panel:
    - Readonly preview of captured metadata (`meta.window`, `meta.context`, `meta.whatIfSummary`, `meta.source`)
    - Editable "Note" textarea bound to `meta.note`
  - Users can copy/paste within Monaco; no separate copy/paste buttons needed

- Base layer:
  - Always present; pinned at the bottom of the stack (non-draggable, not deletable).
  - Default: not visible. May be hidden or shown; used as reference even when hidden.
  - Represents the session baseline. Flatten updates Base within the session; committing to repo is a separate action.
  - Row shows colour swatch placeholder, name (read-only "Base"), and Open button.
  - Open button: launches Monaco modal showing Base parameter state (editable).
  - Applying edits to Base mutates Base; “Save as Snapshot” creates an overlay from editor content.

- Current layer:
  - Pinned at the top of the stack.
  - Represents the live working state (in‑memory graph + What‑If). Receives all edits and What‑If.
  - Can be hidden. If the user edits params or changes What‑If while Current is hidden, auto‑unhide Current (toast: “Current shown to reflect your change”).
  - Snapshot operations reference Current as the “from” side when computing diffs.

## Data Model
Scenario (stored in graph runtime; see Persistence):
```ts
type Scenario = {
  id: string;              // uuid
  name: string;
  colour: string;           // hex or hsl string, consistent luminance
  createdAt: string;       // ISO
  updatedAt?: string;      // ISO
  version: number;         // schema version for params payload
  params: ScenarioParams;  // diff overlay payload; "All" = complete diff (covers entire surface), "Differences" = sparse diff
  meta?: ScenarioMeta;     // optional metadata about how/when the scenario was created (window/context/what-if/etc.)
};
```

Notes:
- Visibility is tracked per tab, not in the Scenario object (see Persistence).
- `ScenarioParams` uses the same schema as the What‑If parameter surface (edges, conditional ps, node weights, global multipliers/overrides), using the same rounding and determinism constraints as update flows.

```ts
// Scenario metadata describing capture context and user-authored note
type ScenarioMeta = {
  // Data window used at capture time (optional)
  window?: {
    start: string;     // ISO date/time
    end: string;       // ISO date/time
    label?: string;    // e.g., "Week 45", "2025-11-05 → 2025-11-12"
  };
  // Context key/values (optional)
  context?: Record<string, string>;
  // What-If at capture time
  whatIfDSL?: string | null;  // DSL string if any (normalized)
  whatIfSummary?: string;     // human-readable summary, e.g., "case(checkout_case:treatment)"
  // Source and composition details for how the snapshot was generated
  source?: {
    type: 'all' | 'differences';
    from: 'visible' | 'base';           // 'visible' excludes Current by definition
    visibleExcludingCurrent?: string[]; // scenario IDs in order used as the source when from='visible'
  };
  createdBy?: string;          // optional user id/name
  createdInTabId?: string;     // optional tab id
  note?: string;               // user-editable narrative, auto-generated on creation
};
```

## Persistence
- Scenarios are stored in the graph runtime and shared across tabs for the same graph session.
- Scenarios are NOT saved into the project `.json` files.
- Per‑tab state persists which scenario IDs are visible and the active selection:
```ts
type TabScenarioState = {
  visibleScenarioIds: string[];         // order reflects legend/render order (drag handles)
  visibleColourOrderIds: string[];       // order reflects visibility activation sequence (for colour assignment)
  selectedScenarioId?: string;    // for “Open” default target, optional
};
```

## Colour Strategy (Complementarity)
- Goal: When two scenarios with identical parameters are visible, their colours visually neutralize (over the base), so no bias appears; differences show as coloured fringes.
- **Auto-assignment model** (see Open Questions #10 for manual override options):
  - Colours are assigned only to visible scenarios and follow the per‑tab visibility activation sequence:
    - When a scenario is toggled on: append its id to `visibleColourOrderIds` for that tab; assign the next colour in the N‑tuple for the current visible count.
    - When a scenario is toggled off: remove its id from `visibleColourOrderIds`; remaining visible layers keep their relative colour order; colours are reassigned from the tuple accordingly.
    - Drag reordering (legend/render order) does not change colour assignment; users can influence colours by toggling visibility order (hide all, then show in desired order).
  - Colour assignment algorithm:
    - For one visible layer: render that layer in neutral grey (no palette colour).
    - For two visible scenarios: assign complementary hues (≈180° apart) at equal perceived luminance/saturation.
    - For N > 2: distribute hues evenly around the wheel (maximal separation). Prefer pairwise complementaries when possible (even N).
    - Keep luminance stable to avoid bias.
  - Base participation:
    - If Base is visible alongside other layers, it participates in palette assignment like any other visible layer (e.g., with 3 visible layers, use a 3‑colour palette: colour[1] for first, colour[2] for second, colour[3] for Base).
  - Manual colour override: TBD (see Open Questions #10 for options).
- Blending:
  - Default: `mix-blend-mode: multiply`
  - Low, stable `strokeOpacity` (e.g., 0.25–0.40) per scenario to support neutralization when overlaps are equal.
  - Exact neutralization is display/scene dependent; tune defaults empirically.

## Rendering Pipeline

Decision: Option B — Additive Layering (Stacked Model)

Principles:
- Base is the background layer (always present; default hidden; can be shown; used as reference even when hidden).
- Every overlay is a diff applied over the composition so far. “All” is just a complete diff that overwrites the entire surface; “Differences” is a sparse diff.
- Layers are applied from bottom to top: Base → S1 → S2 → … → Sn. Each overlay overrides the composed parameters from the layers below it via deep-merge.

Pipeline:
1. Start with `composedParams = Base.params` (the current working state).
2. For each visible scenario overlay S in palette order:
   - Merge `S.params` (diff) into `composedParams` via deterministic deep override.
   - Geometry:
     - Use the current graph geometry (paths/control points) for all layers.
   - Compute edge widths and per-edge lateral offsets using `composedParams`.
   - Draw:
     - Render S as an overlay path using S.colour, `mix-blend-mode: multiply`, fixed `strokeOpacity`.
     - Use `strokeLinecap: 'butt'`, `strokeLinejoin: 'miter'` for crisp ends.
3. Confidence intervals, selections, and highlights continue to function; CI bands render on Base only.

Fail‑gracefully rules when graph changed since snapshot:
- If an edge present in any S.params no longer exists: skip for that edge under S (optionally log/debug mark).
- If a new edge exists that a given S.params does not cover: rendering uses whatever is in `composedParams` at that point (i.e., inherits from below).
- If node ids/edge ids map changed: attempt matching by stable IDs; otherwise skip.

Render order:
- Base renders first (always).
- Overlays render in the order of the scenarios palette (user can reorder via drag handles).
- Reordering updates the `visibleScenarioIds` array order (render order) for the current tab.
- Colour assignment order is independent and follows the `visibleColourOrderIds` activation sequence for the current tab.

## Operations (ScenariosContext API)
```ts
interface ScenariosContext {
  list(): Scenario[];
  get(id: string): Scenario | undefined;
  createSnapshot(options?: { 
    name?: string; 
    type?: 'all' | 'differences';  // default: 'all'
    source?: 'visible' | 'base';    // 'visible' = composition of all visible layers EXCLUDING Current; 'base' = Base only; default: 'visible'
    diffThreshold?: number;         // optional epsilon for "Differences" extraction
  }): Scenario; // creates snapshot from current state per options; captures ScenarioMeta; assigns colour when made visible
  createBlank(name?: string): Scenario;      // creates empty scenario, opens editor
  openInEditor(id: string): void;            // launches Monaco modal for scenario
  applyContent(id: string, content: string, format: 'yaml' | 'json'): Result<Scenario, Error>; 
  // validate & persist; if id is "current", creates NEW scenario instead of modifying base
  rename(id: string, name: string): void;
  setColour(id: string, colour: string): void;
  reorder(scenarioIds: string[]): void;      // updates order (affects render order)
  delete(id: string): void;

  // Per-tab visibility state
  getVisible(tabId: string): string[];       // returns IDs in palette order
  setVisible(tabId: string, scenarioIds: string[]): void;
  toggleVisible(tabId: string, id: string): void;
  setSelected(tabId: string, id?: string): void;
  
  // Colour assignment
  assignColour(scenarioId: string, existingVisibleIds: string[]): string; // computes complementary colour
  
  // Base helpers
  getBaseParams(): ScenarioParams;          // returns Base (working state) parameters
  openBaseInEditor(): void;                 // opens Base in Monaco modal
}
```

## Validation 
- Validate `ScenarioParams` on Apply (Monaco modal). 
- Warn inline with diagnostics, but do not block Apply (allow users to save partial/invalid data if needed).
- On Apply with errors: persist anyway but mark scenario as "has validation errors" (visual indicator in list). 

## Performance
- No precompute required for v1. Compute on demand:
  - Parse (YAML/JSON → AST) → resolve HRNs to IDs → deep‑merge diffs in order → compute widths/offsets per layer.
- Memoize only lightweight steps:
  - Parsed `ScenarioParams` per scenario content hash.
  - HRN→ID resolution map per scenario (invalidated on id/structure changes).
  - Optional per‑frame memo for edge width calculations keyed by `(edgeId, composedParamsHash, geometryHash)`.
- Throttle recomputes via microtask/rAF/idle to avoid jank during rapid toggles/reorder.
- Complexity: O(totalDiffSize + E × visibleLayers). With ≤5 visible layers and typical E, this is acceptable without heavy caching.
- Soft cap: recommend ≤5 visible scenarios; warn/degrade gracefully beyond.

## Accessibility
- Ensure colour assignments meet minimum contrast against the background and each other.
- Provide tooltip/legend entries that identify scenario name/colour.

## Interactions & Compatibility
- Highlights/selection: apply to base and overlays consistently; overlays use their own colours but respect selection emphasis.
- Confidence intervals: CI can remain enabled when scenarios are visible. CI bands render on base layer only (scenario overlays render without CI for v1).
- Edge labels: base labels remain primary; optional future: per-scenario delta badges on hover.

## Open‑In‑Monaco Modal
- Displays the full YAML/JSON for the scenario’s `params` (and optionally metadata).
- Validation:
  - YAML/JSON syntax and schema validation with error annotations.
  - On Apply, persist and bump `updatedAt` 
- No separate Copy/Paste UI; users use Monaco’s editor commands.

## User Flow Examples

### Flow 1: Apply What‑If, snapshot “All”, then compare
1. User applies What‑If (e.g., `case=treatment`) to Current.
2. User clicks Snapshot → All (copy Current as complete diff). New overlay inserted at position 2.
3. User hides Current to compare:
   - If Base is hidden: preview shows only the snapshot layer.
   - If Base is shown: preview = Base + [All overlay].
4. User tweaks a parameter while Current is hidden → auto‑unhide Current (toast), so the tweak is visible.

### Flow 2: Build a composite with stacked “Differences”
1. Start with Base (hidden) and Current visible.
2. User bulk‑edits on Current; Snapshot → Differences (source = visible minus Current → Base). New “Delta A” at position 2.
3. User makes a second targeted tweak; Snapshot → Differences (source now = Base + “Delta A”). New “Delta B” at position 2.
4. User hides Current to preview composition: Preview = Base + Delta B + Delta A (stack order).
5. User reorders Delta A/B to test precedence; composition updates deterministically (deep‑merge of diffs).

### Flow 3: Multi‑tab authoring and Flatten
1. Tab A: Overlays A1, A2 visible under Current (tab‑local view state). Preview = Base + A1 + A2 (+ Current if visible).
2. Tab B: Only B1 visible. User tweaks Current and Snapshot → Differences. Source = Base + B1 (visible minus Current in Tab B). New “B2” at position 2.
3. Switch to Tab A: “B2” exists globally, but preview differs because visibility in Tab A is Base + A1 + A2.
4. User chooses Flatten: Base := Current (session‑local). All overlays are cleared for this graph session. Current remains visible; tabs now show only Base (+ Current).

---

## Snapshot Scope Semantics

Two snapshot types are supported:

1. "All" (complete diff):
   - Captures a diff that fully overrides the chosen source.
   - By default, source = "visible": source is the composition of all visible layers EXCLUDING Current; produce a complete diff from Current to that source (include‑all; ignore epsilon).
   - Alternative source = "base": source is Base only; produce a complete diff from Current to Base.
   - Stored as a diff overlay; no special handling at composition time.

2. "Differences" (sparse diff):
   - Captures only the minimal parameter deltas between Current and the chosen source.
   - By default, source = "visible": source is the composition of all visible layers EXCLUDING Current; compute sparse diff(Current, source) with epsilon.
   - If no other layers are visible, the source falls back to Base.
   - Excludes keys equal to the source (respecting an optional epsilon `diffThreshold`).
   - Stored as a diff overlay to be layered on top of Base (and possibly other overlays).

Notes:
- Partial parameter overlays are first-class in additive layering.
- What‑If overrides applied at capture time are inherently included in "visible" captures; no separate What‑If checkbox is needed.
- Users can still manually edit overlays in Monaco to adjust full or partial content.

---

## Additional Clarifications

### 3. Default labels for scenarios
- **Default name**: Timestamp (e.g., "2025-11-12 14:30")
- **Tooltip on hover**: Shows `Scenario.meta` summary:
  - Window: `2025-11-05 → 2025-11-12`
  - Context: `channel=mobile` (if any)
  - What‑If: `case(checkout_case:treatment)` (if any)
  - Source: `All from visible` or `Differences vs Base`
  - Created: ISO timestamp

### 4. Base and Current visibility
- Base: always present; default hidden; can be shown/hidden. Used as the reference even when hidden.
- Current: can be hidden; on any param edit or What‑If change while hidden, auto‑unhide with a brief toast.

### 5. Snapshot insertion rules
- All: snapshot Current (complete diff). Insert new overlay at position 2 (just beneath Current).
- Differences: compute sparse diff(Current, source), where source = composition of visible layers excluding Current (fallback Base). Insert at position 2.
- Overlays are stored as diffs and composed via deterministic deep‑merge; no special render handling needed.

### 6. What‑If interplay
- What‑If applies only to Current.
- If Current is hidden, What‑If effects are muted from preview; on any What‑If change, auto‑unhide Current with a brief toast.
- Overlays are unaffected by What‑If after capture; captures include What‑If implicitly because they diff from Current at the time of snapshot.

## Acceptance Criteria
- Users can create a snapshot as "All" or "Differences" (from visible or Base); it appears in the list with an assigned colour and is invisible by default or follow product choice (tunable).
- Users can rename, recolour, toggle visibility (per tab), open the JSON modal, apply edits, and delete scenarios.
- When scenarios are visible, overlays render additively from Base upward with per-layer widths and per-layer Sankey offsets using current graph geometry.
- If two visible scenarios are identical, their overlays produce neutral appearance over the base (no obvious colour bias), subject to blending and display variance.
- If widths differ, coloured fringes appear where one scenario’s edge extends beyond another.
- Scenarios persist in graph runtime (shared across tabs); visibility is stored per tab.
- Current can be hidden; any param edit or What‑If change while hidden auto‑unhides Current with a toast.
- Monaco modal supports toggling Syntax (YAML/JSON) and Structure (Flat/Nested), with lossless round-trip between representations.
- Monaco modal provides "Copy as CSV" export of the flat representation (key,value).
- Snapshot creation captures `Scenario.meta` with window, context, what‑if DSL/summary, and source; modal allows editing `meta.note`.

## Open Questions / Areas Needing Design
1. **Exact blending and alpha defaults**: Best values for neutralization across a variety of base colours and background themes (empirical tuning needed).
2. **Confidence intervals with scenarios**:
   - **Decision**: Permit user to leave CI on if they wish. No reason we cannot accommodate.
   - CI bands render on base layer; scenario overlays render without CI (for simplicity in v1).
   - Sankey diagram mode: No blocking issue; scenarios should work in Sankey mode.
3. **Base layer implementation**:
   - Base is not draggable; it can be hidden or shown (default hidden). It is the background reference layer.
   - Colour behavior: 
     - If exactly one layer is visible (often Current), render that layer in neutral grey.
     - If multiple layers are visible, assign a palette colour to each visible layer, including Base if it is visible.
   - Opening Base in the editor allows direct mutation of Base; a “Save as Snapshot” action creates an overlay from editor content.
4. **Tooling/Architecture**:
   - Where to host `ScenariosContext` (new context vs extend existing ViewPreferences/Operations)?
   - Recommendation: New `ScenariosContext` for separation of concerns.
5. **Invalid data handling**:
   - **Decision**: Store raw YAML/JSON string. Parse to ScenarioParams when needed (on scenario visibility change, data change, graph structure change, etc.).
   - Parsing is lightweight: enumerate through each visible scenario layer from bottom to top, apply params sequentially, store result.
   - Schema evolution: attempt best-effort parsing; mark scenario as invalid if parsing fails; allow user to fix in Monaco editor.
6. **Colour conflict with conditional/case edges** (PHASE 2):
   - **Decision**: Move conditional/case indicators to "blobs" (small coloured markers/shapes) on edges instead of colouring the entire edge stroke.
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
   - "Create Snapshot" affordance:
     - Primary click: "All" with source='visible' (composition of visible layers excluding Current).
     - Dropdown:
       - Type: 'all' | 'differences'
       - Source: 'visible' (excluding Current) | 'base'
       - Optional: `diffThreshold` (epsilon for 'differences')
   - Context: TO FOLLOW (deferred).
9. **Selection behavior (Photoshop layers palette pattern)** (PHASE 2):
   - **Decision for v1**: Eye icon = toggle visibility. Keep this approach.
   - "View only this layer" feature: PHASE 2 (deferred). Users can manually deselect other layers, so this is convenience, not MVP.
   - No row-level click or double-click at this stage.
   - Only interactions: eye icon (toggle), Open button (editor), Delete button, colour swatch (picker), name (inline edit), drag handle (reorder).
10. **Colour assignment strategy**:
    - **Decision**: Auto-assignment with standard colour sequence.
    - Colours assigned in standard sequence based on number of visible scenarios:
      - 1 visible: Grey (normal mode, no overlay colour)
      - 2 visible: Blue and Pink (complementary pair)
      - 3 visible: Cyan, Magenta, Yellow (evenly distributed)
      - 4+ visible: Continue geometric distribution around colour wheel
    - Users can control colour assignment by ordering visibility: hide all, then make visible in desired order.
    - Colour swatch click: allows manual colour override (Option B approach).
    - PHASE 2: Add advanced "Colour Settings" option to allow user to specify custom colour sequence.

---

## Appendix A — Parameter Snapshot Schema and Graph Mapping

Purpose: Clarify that scenario payloads are parameter diffs only. They are not full graph copies and exclude structure and display concerns.

Inclusions (parameter surface):
- Edges (by stable ID/UUID):
  - Probability `p` (mean, stdev, distribution, overridden flags)
  - Conditional probabilities `conditional_p` keyed by condition string; values are probability params
  - Default weight `weight_default`
  - Costs: `cost_gbp`, `cost_time` (CostParam)
- Nodes (by stable ID/UUID):
  - Entry weights `entry.entry_weight`
  - Costs: `costs.monetary`, `costs.time`
  - Case variants (if node is a case): addressed as `case(<caseId>:<variantName>).weight`
- Optional future: global parameter multipliers/overrides (not yet implemented)

Exclusions:
- Graph structure: nodes list, edges connectivity (`from`, `to`, handles), routing/control points
- Layout and display: positions, colours, labels, descriptions, tags, display markers
- Metadata, policies, registry/connection details, data source queries/evidence
- What‑If state (DSL/overrides) after capture; overlays store only resolved parameter diffs

Identifier rules:
- Human‑readable references (HRNs) are preferred for readability; UUIDs are used as a fallback.
- On capture, include HRN keys; optionally include UUID hints for resilience when applying to changed bases.

Proposed diff schema (TypeScript-ish):
```ts
// Sparse diff; omit keys to leave underlying values unchanged
type ScenarioParams = {
  edges?: {
    [edgeId: string]: {
      p?: ProbabilityParam;                       // replaces base p when present
      conditional_p?: {
        [condition: string]: ProbabilityParam | null; // set to ProbabilityParam to upsert/replace;
                                                      // set to null to remove a conditional entry
      } | Array<{ condition: string; p: ProbabilityParam }>; // alternatively replace full set
      weight_default?: number;
      cost_gbp?: CostParam;
      cost_time?: CostParam;
    }
  };
  nodes?: {
    [nodeId: string]: {
      entry?: { entry_weight?: number };
      costs?: {
        monetary?: number | { value: number; stdev?: number; distribution?: string; currency?: string };
        time?: number | { value: number; stdev?: number; distribution?: string; units?: string };
      }
    }
  };
  // future: globals?: { ... } // global multipliers/overrides
};
```

Example “Differences” overlay (JSON):
```json
{
  "edges": {
    "edge-uuid-1": { "p": { "mean": 0.42 } },
    "edge-uuid-2": {
      "conditional_p": {
        "visited(promo)": { "mean": 0.30 },
        "visited(old-flow)": null
      },
      "cost_gbp": { "mean": 1.5 }
    }
  },
  "nodes": {
    "node-uuid-A": { "entry": { "entry_weight": 0.2 } },
    "node-uuid-B": { "costs": { "time": { "value": 3, "units": "days" } } }
  }
}
```

“All” overlay is simply a complete diff: it populates every relevant parameter field for all edges/nodes present at capture time, using the same schema. Composition always applies diffs via deterministic deep‑merge in stack order.

### Appendix A.1 — Human‑Readable Parameter Addressing (dagCal‑style)

Goal: Make param packs readable/editable by users without exposing UUIDs, while remaining deterministically applicable to Base.

Addressing grammar (HRN):
- Edges (selector precedence; resolver tries in this order):
  1) By edge id (best): `e.<edgeId>.<path>`
  2) By endpoints: `e.from(<fromNodeId>).to(<toNodeId>).<path>`
  3) Fallback by UUID: `e.uuid(<edgeUuid>).<path>`
  - If multiple edges match endpoints, do not add handle qualifiers; instead, fallback to UUID.
  - Conditions (normalized DSL) are appended inline:
    - `e.from(<fromNodeId>).to(<toNodeId>).visited(nodec).<path>`
  - Preference: when an `edgeId` exists, prefer the concise `e.<edgeId>...` form even with conditions (e.g., `e.checkout-to-purchase.visited(promo).p.mean`). Redundant endpoint qualifiers are allowed but not required.
- Nodes:
  - By node id (preferred): `n.<nodeId>.<path>`
  - Fallback by UUID: `n.uuid(<nodeUuid>).<path>`
  - Case variant addressing: `n.<nodeId>.case(<caseId>:<variantName>).weight`

Path suffixes map to param payload fields (see schema above). Condition strings MUST be normalized (same DSL used in graph: normalized whitespace, casing, order).

Normalization/canonicalization:
- `nodeId` and `edgeId` are human‑readable identifiers from the graph (not labels).
- Canonical form: lowercase; trim spaces; spaces→`-`; strip surrounding quotes.
- Condition strings are normalized using the existing query/constraint normalizer.

Resolution algorithm (apply‑time):
1) If an entry carries a UUID hint, attempt direct UUID resolution first; if found, apply and stop.
2) For edges:
   - Try human `edgeId` form `e.<edgeId>`; if unique, apply.
   - Else try endpoints `e.from(<fromId>).to(<toId>)`; if multiple edges match, fallback to `e.uuid(<uuid>)`.
   - Else if neither id nor endpoints resolve, and a UUID is provided via `e.uuid(<uuid>)`, use it.
3) For nodes: resolve by human `nodeId`; else use `n.uuid(<uuid>)`.
4) If resolution fails or is ambiguous:
   - Skip applying that entry; record a validation warning with the unresolved HRN and suggested disambiguators.

Where HRNs work well:
- Stable human ids (nodes/edges) and typical edits (param tweaks, adding overlays).
- Reading/editing param packs in code review, diffs remain legible.

Edge cases/limitations:
- Ambiguity: multiple edges between the same nodes without handles or human edge ids → use UUID fallback.
- Renames: if human ids change after capture, HRN resolution may fail; UUID hints mitigate this.
- Structural changes: removed edges/nodes or topology rewires will skip affected entries (warning).
- Conditional DSL refactors: condition normalization must remain stable; otherwise treat as different keys.

Recommendation:
- Default to HRNs in saved snapshot files and UI surfaces.
- Provide a linter in the editor that flags ambiguous HRNs and offers auto‑fix by inserting handles or switching to `e.<edgeId>`.

Examples (edges):
- By edge id:
  - `e.checkout-to-purchase.p.mean = 0.42`
  - `e.checkout-to-purchase.p.stdev = 0.05`
  - `e.checkout-to-purchase.cost_gbp.mean = 1.5`
- By endpoints:
  - `e.from(checkout).to(purchase).p.mean = 0.42`
  - `e.checkout-to-purchase.visited(promo).p.mean = 0.30`  // preferred concise form when edgeId exists
  - `e.from(checkout).to(purchase).weight_default = 0.8`
- Parallel edges (fallback to UUID for specificity):
  - `e.uuid(1f23c9a2-...-9bd1).p.mean = 0.55`
- By UUID (fallback):
  - `e.uuid(1f23c9a2-...-9bd1).p.mean = 0.42`
  - `e.uuid(1f23c9a2-...-9bd1).visited(promo).p.mean = 0.30`
- Conditional add/remove:
  - Add/update: `e.checkout-to-purchase.visited(promo).p.mean = 0.30`
  - Remove:      `e.from(checkout).to(purchase).visited(old-flow).p = null`

Examples (nodes):
- By node id:
  - `n.landing.entry.entry_weight = 0.2`
  - `n.billing.costs.time.value = 3`
  - `n.billing.costs.time.units = "days"`
- By UUID (fallback):
  - `n.uuid(ae45...c2).entry.entry_weight = 0.15`

### Appendix A.2 — Examples: Variant Weights, Conditional Params, Evidence, and Flatten

Variant weights (case what‑if materialization):
- Selecting a variant at a case node can be captured by setting its weight to 1.0 and complements to 0.0.
- Differences (HRN):
  - `n.checkout_case.case(checkout_case:treatment).weight = 1.0`
  - `n.checkout_case.case(checkout_case:control).weight = 0.0`
- All: include the full variants array with explicit weights for all variants (complete diff).

Conditional probabilities:
- Update a conditional probability’s mean (sparse diff):
  - `e.from(checkout).to(purchase).visited(promo).p.mean = 0.30`
- Remove a conditional entry:
  - `e.from(checkout).to(purchase).visited(old-flow).p = null`
- Optional materialization of a conditional selection into base p (policy):
  - Promote selected conditional into base p:
    - `e.from(checkout).to(purchase).p.mean = 0.30`
    - (and optionally keep conditionals unchanged)

Evidence (capture and editing):
- Probability evidence under base p:
  - `e.checkout-to-purchase.p.evidence.k = 12345`
  - `e.checkout-to-purchase.p.evidence.variants[0].allocation = 0.6`
- Conditional probability evidence:
  - `e.from(checkout).to(purchase).visited(promo).p.evidence.k = 98765`

Flatten (UI and semantics):
- UI: Footer action “Flatten” sets Base := Current for the active graph session (no repo commit).
- Behavior:
  - Writes the composed Current working parameters into Base.
  - Clears all overlays for this graph session (graph‑level overlays removed).
  - Current remains visible.
  - What‑If effects are materialized only if reflected in parameters (e.g., case variant weights or promoted base p). Otherwise What‑If continues to exist only in Current and is not implicitly written.

### Appendix A.3 — DSL and Representations (Explicit vs Implicit)

Single DSL:
- One addressing DSL for parameter packs, reusing the normalized condition/query DSL for conditional keys (e.g., `visited(promo)`).
- HRN path grammar (edge/node selectors + param paths) + condition DSL form a single unified grammar.

Two representations (same semantics):
- Explicit (flat key/value pairs) — ideal for CSV/Google Sheets import/export.
- Implicit (nested YAML/JSON) — easier for humans to read/edit.
- Both map to the same internal AST and round‑trip without loss (ignoring formatting).

Explicit examples (flat):
```text
e.checkout-to-purchase.p.mean = 0.42
e.checkout-to-purchase.p.stdev = 0.05
e.checkout-to-purchase.cost_gbp.mean = 1.5
e.from(checkout).to(purchase).visited(promo).p.mean = 0.30
n.checkout_case.case(checkout_case:treatment).weight = 1.0
n.checkout_case.case(checkout_case:control).weight = 0.0
```

Implicit examples (nested YAML):
```yaml
e:
  checkout-to-purchase:
    p:
      mean: 0.42
      stdev: 0.05
    cost_gbp:
      mean: 1.5
  from(checkout).to(purchase).visited(promo):
    p:
      mean: 0.30
n:
  checkout_case:
    case(checkout_case:treatment):
      weight: 1.0
    case(checkout_case:control):
      weight: 0.0
```

Import/export:
- Flat: 1:1 `key,value` rows for spreadsheets/CSV.
- Nested: preferred for code review/manual edits.
- Both validate against the same schema and resolve via the HRN algorithm.
