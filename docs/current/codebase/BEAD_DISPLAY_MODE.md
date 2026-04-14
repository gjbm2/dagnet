# Bead Display Mode

How probability beads render values on graph edges. Controlled by `BeadDisplayMode` — a per-tab enum persisted in editor state.

## The Three Modes

| Mode | Type value | Bead shows | Denominator | Formatter |
|------|-----------|------------|-------------|-----------|
| **Edge rate** (default) | `'edge-rate'` | Edge-level percentage (k/n as %) | Edge's own n | `formatProbability` (0 d.p.) |
| **Data values** | `'data-values'` | Absolute counts (k/n as integers) | Edge's coherent n from topo walk | `buildDataValuesLabel` (thousands separators, dimmed /n) |
| **Path view** | `'path-rate'` | Path-level percentage (k/anchor_n as %) | Cohort anchor node's population | `formatPathRate` (1 d.p.) |

The three modes are **mutually exclusive**. Selecting one deselects the others (radio-group semantics in the UI).

## Where the n/k Values Come From

All three modes share the same population flow computation: `computeInboundN` in `statisticalEnhancementService.ts`. This is a pure, synchronous topological walk that propagates population from START nodes downstream:

1. **Seed**: START node population = `max(evidence.n)` on its outgoing edges
2. **Propagation**: at each node, outgoing edge gets `n = nodePopulation`, `k = n × effectiveP`
3. **Accumulation**: each node's population = sum of inbound `forecast_k`

### Edge ID Key Order (Critical)

`computeInboundN` uses `getEdgeId()` which returns `edge.uuid || edge.id` (uuid-first). All call sites must use the same key order — the `activeEdges` set, the `getEffectiveP` callback lookup, and the inbound-n map lookup. Using `id || uuid` instead silently breaks the topo walk (edges miss the active set, siblings get different n values). This was a real bug that caused incoherent sibling populations.

### Per-Scenario Behaviour

The inbound-n map is currently computed once per edge render using `p.mean` as the effective probability. This means all scenarios share the same coherent population flow. In E or F mode, the displayed **k** uses the mode's rate (evidence or forecast), but **n** always comes from the topo walk. This means the flow invariant (downstream n = sum of incoming k) holds in F+E mode but not in E or F mode — by design.

## Data Values Mode

Shows `k/n` as integer counts with thousands separators (e.g. `8,711/16,267`).

- The `/n` portion renders with `opacity: 0.7` and `fontWeight: 400` (lighter than the k portion) for visual hierarchy
- Values are encoded as tab-separated `"k\tn"` strings through the bead pipeline, then split by `BeadLabelBuilder.renderDataValue()` into styled React nodes
- When n=0 (no population data anywhere), falls back to percentage display via `formatProbability`
- The `extractTextAndColours` function in `EdgeBeads.tsx` propagates `opacity` and `fontWeight` from React spans into SVG `<tspan>` attributes for correct rendering in the SVG textPath pipeline

## Path View Mode

Shows `k/anchor_n` as a percentage at 1 d.p. (e.g. `10.3%`).

### Anchor Resolution

The anchor node determines the denominator for all path rates:

1. **Explicit cohort anchor**: parsed from the DSL via `parseConstraints(graph.currentQueryDSL)`. The DSL format `cohort(household-created,1-Mar-26:31-Mar-26)` yields anchor node ID `household-created`. The anchor node is found in the graph by matching `node.id` or `node.uuid`.
2. **Fallback (no explicit anchor)**: uses the START node — `max(evidence.n)` on outgoing edges from nodes with `entry.is_start === true`.

The anchor node's population (`anchor_n`) is read from the inbound-n map: find any outgoing edge from the anchor node and read its `n` value (= population arriving at that node).

### Cohort Mode Coupling

Path view is semantically coupled to cohort mode:

- **Toggling path view ON**: if the current DSL uses `window(...)`, it is automatically switched to `cohort(...)` by replacing the function name. `WindowSelector` picks up the change.
- **Switching to window mode**: an effect in `ScenarioLegendWrapper` detects that the DSL no longer contains `cohort(` and resets `beadDisplayMode` to `'edge-rate'`.
- **Mixed scenarios**: not yet implemented at per-scenario level. Currently the mode applies uniformly to all visible scenarios.

### Anchor Node Highlight

When a cohort anchor is specified in the DSL, the anchor node receives a blue border highlight (3px, `#2563eb` light / `#60a5fa` dark). This is applied in `ConversionNode.tsx` for both CSS border rendering (non-SVG nodes) and SVG path stroke rendering (outline-path nodes). Detection uses `parseConstraints(currentDSL)` memoised on `[currentDSL, data.id, data.uuid]`.

### Upstream vs Downstream

With an explicit anchor at a mid-funnel node:
- Edges **upstream** of the anchor show >100% (more people entered the funnel than reached the anchor)
- Edges **downstream** show <100%
- The **anchor's own outgoing edges** show 100% × their edge rate

## State Plumbing

| Layer | Location | Field |
|-------|----------|-------|
| Type | `types/index.ts` | `BeadDisplayMode = 'edge-rate' \| 'data-values' \| 'path-rate'` |
| Editor state | `TabState.editorState` | `beadDisplayMode?: BeadDisplayMode` |
| Context | `ViewPreferencesContext.tsx` | `beadDisplayMode`, `setBeadDisplayMode` |
| Hook | `hooks/useDataValuesView.ts` | `useBeadDisplayMode()` → `{ beadDisplayMode, setBeadDisplayMode, isDataValues, isPathRate, isEdgeRate }` |
| View menu | `ViewMenu.tsx` | Two checkbox items (Data Values, Path View) with radio toggle logic |
| Scenario legend | `GraphEditor.tsx` → `viewModes[]` | Two entries under "Display mode" submenu (Hash icon, Route icon) |
| Bead pipeline | `edgeBeadHelpers.tsx` → `buildBeadDefinitions()` | `beadDisplayMode` param + `inboundNMap` + `anchorN` |
| Edge rendering | `EdgeBeads.tsx` → `useEdgeBeads()` | `beadDisplayMode` prop, computes `inboundNMap` and `anchorN` |
| Memo comparison | `EdgeBeadsRenderer` | `beadDisplayMode` in custom `React.memo` comparator |

## Latency Bead Gate

The latency bead `checkExists` gate in `edgeBeadHelpers.tsx` requires **both** `latency_parameter === true` and `median_lag_days !== undefined`. Without the `latency_parameter` check, the BE topo pass can write `median_lag_days` to edges with `latency: { latency_parameter: false }`, causing non-latency edges to show latency beads (a regression discovered during this work).

## Key Files

| File | Role |
|------|------|
| `types/index.ts` | `BeadDisplayMode` type definition |
| `contexts/ViewPreferencesContext.tsx` | State storage and per-tab persistence |
| `hooks/useDataValuesView.ts` | `useBeadDisplayMode()` hook |
| `components/edges/edgeBeadHelpers.tsx` | `buildBeadDefinitions()` — mode switching, value extraction |
| `components/edges/BeadLabelBuilder.tsx` | Formatters: `formatPathRate`, `buildDataValuesLabel`, `renderDataValue` |
| `components/edges/EdgeBeads.tsx` | `computeInboundN` call, `anchorN` computation, opacity/fontWeight extraction |
| `components/editors/GraphEditor.tsx` | `viewModes[]` registration, cohort mode auto-switch/auto-disable |
| `components/nodes/ConversionNode.tsx` | Cohort anchor node blue border highlight |
| `services/statisticalEnhancementService.ts` | `computeInboundN()` — the topo walk |

## Test Coverage

`EdgeBeads.dataValues.test.tsx` — 43 tests covering:
- **Data values invariants** (37 tests): sibling n equality, flow conservation, k ≤ n, integer values, anchor seed, mode-off fallback, no-data fallback. Tested across 3 graph topologies (linear, branching, diamond) × 3 visibility modes (F+E, F, E).
- **Path rate invariants** (6 tests): correct path percentages for linear/branching/diamond graphs, anchor edge identity (path rate = edge rate), monotonic decrease in linear funnels, no-data fallback.
