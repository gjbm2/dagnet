# Live Scenarios: Open Issues & Decisions

**Status:** Active  
**Created:** 2-Dec-25  
**Last Updated:** 2-Dec-25  

---

## Summary

This document tracks open questions and pending decisions for the Live Scenarios feature. Items are grouped by priority and area.

---

## ✅ Resolved Issues

### OI-1: DSL Fragment vs Full DSL Storage — RESOLVED

**Decision:** Fragment approach (diff scenarios) by default.

- Most creation modes produce fragments (e.g., `context(channel:google)`)
- User can change base window and instantly regen context scenarios
- User CAN specify complete DSL if desired
- Store `queryDSL` (fragment) and `lastEffectiveDSL` (composed) for debugging

---

### OI-2: Base DSL Storage Location — RESOLVED ✅

**Decision:** Store `baseDSL` on graph object (alongside `currentQueryDSL`).

**Code Review Findings:**
1. **Scenarios persist via IndexedDB** (`db.scenarios` table, keyed by `fileId`)
2. **Graph properties persist to YAML file** (e.g., `currentQueryDSL` is saved/loaded with graph)
3. **F5 behaviour:** Graph file is reloaded from IndexedDB → YAML content → parsed into graph object
4. **Conclusion:** Adding `baseDSL` to graph type will persist exactly like `currentQueryDSL`

**Implementation:**
```typescript
// types/index.ts - ConversionGraph interface
baseDSL?: string;  // Persistent base query for scenario composition
currentQueryDSL?: string;  // Current user query (transient record-keeping)
```

**Distinction:**
- `baseDSL` — Persistent base for scenario composition (survives F5)
- `currentQueryDSL` — Current session's query, populates WindowSelector on load
- `graphStore.currentDSL` — Runtime authoritative source for queries (not saved to file)

---

### OI-3: Relationship to Existing Metadata Fields — RESOLVED

**Decision:** Option B (Derive)

- `queryDSL` is source of truth for live scenarios
- `window`, `context` derived from queryDSL for display
- `whatIfDSL` separate for case/conditional overrides
- Existing snapshots unaffected

---

### OI-4: Regeneration Trigger Policy — RESOLVED

**Decision:** Changes to base (or lower scenario in stack) trigger refresh.

- Only base/lower scenario changes warrant regeneration
- Show confirmation modal IF a fetch will be required (not in cache)
- No confirmation if all data is cached

---

### OI-6: DSL Editor Expansion Behaviour — RESOLVED

**Decision:** Use modal for DSL editing, not inline expansion.

- Click ✎ (pencil) icon opens modal with QueryExpressionEditor
- Avoids ambiguity between static data vs dynamic DSL
- Simplifies execution

---

### OI-7: Bulk Creation UX Flow — RESOLVED

**Decision:** Adaptive based on cache state.

- If ALL values in cache → create immediately, no modal
- If ANY require fetch → show modal with `[requires fetch]` indicators
- Button text: "Create [X] scenarios..." where X = count

---

### OI-8: Window Preset Affordance — RESOLVED

**Decision:** Right-click with expanded options.

Example for 7d button:
```
Right-click on [7d]
├── Create scenario (-7d:-1d)
├── Create scenario (-14d:-7d)
├── Create scenario (-21d:-14d) [requires fetch]
├── Create scenario (-28d:-21d) [requires fetch]
├── ─────────────────
└── Create 4 scenarios (for each) [requires fetch]
```

Similar patterns for 30d and 90d variants.

---

### OI-9: Scenario Limit Handling — RESOLVED

**Decision:** Don't worry about it.

- Scenarios are easy to create and destroy
- No warning needed
- Keep existing limit, raise if users complain

---

### OI-11: Staleness Indicator — RESOLVED (DEFERRED)

**Decision:** Phase 2.

- Scenarios don't age in a way that matters for MVP
- Add tooltip with last regeneration timestamp
- Visual indicator deferred

**However:** Add "Refresh All" button at top-right of Scenarios panel header (inline with "Scenarios" label) if any live scenarios exist.

---

### OI-12: Snapshot ↔ Live Conversion — RESOLVED

**Decision:** Add "Create Snapshot" on scenario right-click context menu.

- Captures current params from live scenario
- Creates new snapshot with those values
- Simple, discoverable

---

### OI-5: Scenario Label Default — RESOLVED

**Decision:** Raw DSL as label.

- Live scenario named `context(channel:google)` etc.
- Truncate in UI if needed
- Show full DSL in tooltip

---

### OI-10: Failed Regeneration Handling — RESOLVED (PARTIAL)

**Decision:** Use existing toast infrastructure.

- Existing fetch machinery toasts extensively
- Fix verbosity separately
- For MVP, rely on existing toasts
- Session log captures errors

---

### OI-13: Composition/Merge Behaviour — RESOLVED

**Decision:** Smart merge using existing `augmentDSLWithConstraint` logic.

- Scenario `context(channel:meta)` atop base `window(-30d:-1d).context(channel:google)` 
- Result: Keep window, replace context → `window(-30d:-1d).context(channel:meta)`

---

### OI-14: Sync vs Async for Bulk Creation — RESOLVED

**Decision:** Synchronous is fine.

- Don't complicate with async patterns
- Just create scenarios with spinner

---

### OI-15: What-If DSL + QueryDSL Processing — RESOLVED ✅

**Decision:** They are separate concerns. What-If does NOT affect data fetching.

**Code Review Findings:**
1. **`whatIfDSL`** — Stored in tab state (`editorState.whatIfDSL`), used for case/conditional overrides in rendering
2. **`currentDSL`** — Stored in graphStore, used for window/context in data fetching
3. **They are NOT combined** by fetch machinery — `dataOperationsService.getFromSourceDirect` uses only `currentDSL` parameter
4. **What-If affects:** Edge probability display, conditional highlighting, analytics
5. **What-If does NOT affect:** API calls, data caching, window aggregation

**For Live Scenarios:**
- `queryDSL` on scenario = window/context fragment (for fetching)
- Snapshot can optionally capture what-if state in `meta.whatIfDSL` (existing behaviour)
- No additional parsing logic needed — they're separate concerns

---

### OI-16: Context Sidenav Affordance — RESOLVED ✅

**Decision:** Right-click on context FILE in sidenav shows "Create [X] scenarios...".

- Sidenav shows context files, not individual keys
- Same hook as context chip, using all values from that context definition
- Confirmed as intended behaviour

---

### OI-19: Mixed DSL (Fetch + What-If Elements) — RESOLVED ✅

**Question:** How do we handle DSLs that contain both fetch elements (`window`, `context`) and what-if elements (`case`, `visited`)?

**Example:**
```
context(channel:google).case(my-case:treatment).visited(gave-bds)
```

**Decision:** Parse at regeneration time, process in two stages.

**Processing flow:**
1. Parse full DSL with `parseConstraints()` (already handles all element types)
2. Split into:
   - **Fetch parts:** `window`, `context`, `contextAny` → used for API call
   - **What-If parts:** `cases`, `visited`, `visitedAny`, `exclude` → applied to compute effective params
3. Fetch data with effective fetch DSL (merged with base)
4. Apply what-if to compute effective params (using existing `computeEffectiveEdgeProbability`)
5. Store effective params in `scenario.params`

**Key insight:** What-if effects are "baked in" to params at regeneration time — same as existing snapshot behaviour. Compositing machinery unchanged.

**No new parsing logic needed** — `parseConstraints()` already parses all element types.

---

### OI-20: Compositing with Live Scenarios — RESOLVED ✅

**Question:** How do live scenarios integrate with the compositing machinery?

**Decision:** No changes to compositing. Live scenarios work identically to snapshots.

**Rationale:**
- Both scenario types store `params` (edges/nodes with parameter values)
- For live scenarios, `params` is populated at regeneration time (with what-if baked in)
- `queryDSL` is metadata for regeneration only — doesn't participate in composition
- Composition formula unchanged: `Base.params + overlay1.params + ... + Current.params`

---

### OI-21: What-If Reapplication on Regeneration — CONFIRMED ✅

**Question:** Are what-if DSL elements (case, visited) reapplied during regeneration?

**Answer:** Yes, confirmed.

**Flow during regeneration:**
1. Parse `queryDSL` → extract fetch parts + what-if parts
2. Fetch fresh data using effective fetch DSL (merged with base)
3. Apply what-if parts using `computeEffectiveEdgeProbability()`
4. Store fresh effective params in `scenario.params`

**Key insight:** What-if is computed against the CURRENT graph state at regeneration time. If graph structure has changed (new edges, conditionals), the what-if computation produces fresh results.

**Timing difference:**
| Layer | What-If Applied | Against |
|-------|-----------------|---------|
| Snapshots | At creation | Graph at creation time |
| Live Scenarios | At regeneration | Graph at regeneration time |
| Current | At render | Live graph |

---

### OI-22: Mixed Scenario Stack Compositing — CONFIRMED ✅

**Question:** What happens with: Base → (A) Snapshot All → (B) Live Diff → (C) Manual Diff?

**Answer:** Works correctly via sparse merge.

**Example:**
- (A) has all edges → overwrites Base
- (B) regenerates with context:google → overwrites edges it fetches
- (C) has just `someEdge.p.mean=0` → only overwrites that one edge

**Result:** `someEdge` uses (C)'s value, all other edges use (B)'s values.

**The compositing merge is additive** — each layer only specifies what it wants to change. Keys not mentioned are preserved from lower layers. This is implemented in `CompositionService.mergeScenarioParams()`.

---

### OI-17: Fetch Button Refactor — RESOLVED (DESIGN) ✅

**Decision:** Generalise existing cache-checking for multi-DSL scenarios.

**Code Review Findings:**

**Existing infrastructure in `useFetchData.ts`:**
```typescript
// Line 202-244: Check if single item needs fetch
itemNeedsFetch(item: FetchItem, window: DateRange): boolean

// Line 249-305: Get all items needing fetch for a window  
getItemsNeedingFetch(window: DateRange): FetchItem[]

// Uses calculateIncrementalFetch() from windowAggregationService.ts
```

**Generalisation needed:**
1. Extract `itemNeedsFetch` logic to a service function (not hook)
2. New function: `checkDSLsNeedFetch(dsls: string[]): { dsl: string; needsFetch: boolean }[]`
3. Can batch-check cache coverage for multiple scenario DSLs
4. Used by:
   - Bulk creation UI (show `[requires fetch]` indicators)
   - "To Base" confirmation (count scenarios needing fetch)
   - "Refresh All" (identify which scenarios to refresh)

**Key insight:** Must be careful about API spam — the entire scenarios feature should gate external calls through cache checks to ensure users explicitly opt into fetches.

---

## 🆕 URL Parameters for Scenarios

### OI-18: URL-Based Scenario Creation — READY FOR IMPLEMENTATION

**Feature:** Allow scenarios to be created via URL query parameters.

**Use cases:**
1. Deep-linking to specific analyses
2. Sharing pre-configured scenario sets
3. Embedding dashboards with specific slices
4. Automation / reporting pipelines

**Proposed URL format:**

```
http://dagnet.url?graph=<graph-id>&scenarios=<dsl-list>&hidecurrent
```

**Parameters:**

| Param | Description | Required |
|-------|-------------|----------|
| `graph` | Graph file ID to load | Existing |
| `scenarios` | DSL expressions, semicolon-separated | New |
| `hidecurrent` | Hide the Current layer | New |

**Examples:**

1. **One scenario per context value:**
   ```
   ?graph=conversion-v2&scenarios=window(-30d:-1d).context(channel)
   ```
   - `context(channel)` (bare key) explodes to all values
   - Creates N live scenarios: `context(channel:google)`, `context(channel:meta)`, etc.
   - Window inherited from URL DSL

2. **Explicit multiple scenarios:**
   ```
   ?graph=conversion-v2&scenarios=context(channel:google);context(channel:meta)
   ```
   - Creates 2 explicit live scenarios
   - Window uses graph's baseDSL/currentQueryDSL

3. **Window comparison:**
   ```
   ?graph=conversion-v2&scenarios=window(-3m:-2m);window(-2m:-1m);window(-1m:-0m)
   ```
   - Creates 3 live scenarios for different time windows
   - Context uses graph's baseDSL if any

4. **Dashboard mode (hide current):**
   ```
   ?graph=conversion-v2&scenarios=context(channel)&hidecurrent
   ```
   - Creates scenarios for all channels
   - Hides Current layer for clean dashboard view

**Parsing rules:**
- Semicolon (`;`) separates scenario DSLs
- Each DSL segment creates one live scenario
- Bare context keys (e.g., `context(channel)`) explode to create one scenario per value
- URL-encode special characters as needed (`%28` for `(`, `%29` for `)`, etc.)

**Implementation — USE EXISTING explodeDSL:**

The existing `dslExplosion.ts` module handles all DSL parsing:

```typescript
// lib/dslExplosion.ts — ALREADY EXISTS
export async function explodeDSL(dsl: string): Promise<string[]>

// Handles:
// - Semicolons: a;b;c → 3 slices
// - Bare keys: context(channel) → all values via contextRegistry
// - or(): or(a,b,c) → 3 slices  
// - Distribution: (a;b).window(...) → window applied to each
```

**Do NOT write new parsing logic.** URL scenario param just:
1. URL-decode the `scenarios` param
2. Pass to `explodeDSL(scenariosParam)`
3. Create one live scenario per returned slice

**Implementation notes:**
1. Parse `scenarios` param in app initialisation (after graph load)
2. Use `explodeDSL()` for parsing (same as pinned queries)
3. Create live scenarios using same logic as "From current query"
4. Handle `hidecurrent` by setting scenario visibility state

**Open sub-questions:**

| Sub-Q | Question | Decision |
|-------|----------|----------|
| A | When to create scenarios? | On graph load complete |
| B | Error handling for invalid DSL? | Toast + skip (don't block load) |
| C | Conflict with existing scenarios? | Add to existing (don't clear) |
| D | URL encoding | Standard percent-encoding |

**Decision:** ✅ Ready for implementation

---

## Decision Log

| ID | Decision | Date | Rationale |
|----|----------|------|-----------|
| OI-1 | Fragment approach | 2-Dec-25 | Enables easy base window changes |
| OI-2 | baseDSL on graph object | 2-Dec-25 | Persists with file like currentQueryDSL |
| OI-3 | Derive from queryDSL | 2-Dec-25 | queryDSL is authoritative |
| OI-4 | Regen on base/lower change + confirm if fetch needed | 2-Dec-25 | User expectation |
| OI-6 | Modal for DSL edit | 2-Dec-25 | Simplifies execution |
| OI-7 | Adaptive: no modal if cached | 2-Dec-25 | Fast path for common case |
| OI-8 | Expanded window options | 2-Dec-25 | More powerful UX |
| OI-9 | No limit warnings | 2-Dec-25 | Low priority |
| OI-11 | Phase 2 + Refresh All button | 2-Dec-25 | MVP simplification |
| OI-12 | "Create Snapshot" in context menu | 2-Dec-25 | Simple conversion path |
| OI-15 | What-If separate from fetch DSL | 2-Dec-25 | Code review confirmed separate concerns |
| OI-16 | Context file right-click | 2-Dec-25 | Confirmed intended behaviour |
| OI-17 | Generalise itemNeedsFetch to service | 2-Dec-25 | Reuse for multi-DSL checking |
| OI-18 | Use explodeDSL for URL parsing | 2-Dec-25 | Don't duplicate existing logic |
| OI-19 | Parse+split at regen time, bake what-if into params | 2-Dec-25 | Reuses existing parseConstraints and snapshot logic |
| OI-20 | Compositing unchanged, params is the interface | 2-Dec-25 | Live scenarios store params like snapshots |
| OI-21 | What-if reapplied at regeneration time | 2-Dec-25 | Fresh computation against current graph state |
| OI-22 | Sparse merge preserves lower layers | 2-Dec-25 | CompositionService already implements this |
| OI-23 | Live scenarios INHERIT DSL from lower layers | 2-Dec-25 | C inherits A's context; static layers don't contribute DSL |

---

## Action Items

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Add baseDSL to Graph type | - | ⬜ Pending | OI-2 resolved |
| Refactor itemNeedsFetch to service | - | ⬜ Pending | OI-17 |
| Implement URL params parsing | - | ⬜ Pending | OI-18 |
| Update design.md with all resolutions | - | ✅ Done | This update |
