# Live Scenarios Feature Design

**Status:** Design Draft  
**Created:** 2-Dec-25  
**Last Updated:** 2-Dec-25  

---

## Executive Summary

This document specifies the design for extending DAGNet's Scenarios feature with **Live Scenarios**—scenarios that retain a link to the query DSL used to generate them and can be regenerated from fresh data at any time.

Currently, scenarios are static snapshots of parameter values. Live scenarios introduce a dynamic alternative: instead of capturing parameter values at a point in time, they capture the **query that produces those values**. This enables:

1. **Regeneration** — Refresh scenario data from live sources with one click
2. **Simplified creation** — Specify just a DSL fragment (e.g., `context(channel:google)`) to create a scenario
3. **Bulk scenario generation** — "Create scenarios for all values" from context chips
4. **DSL-based naming** — Default scenario labels show the query that defines them
5. **URL-based presets** — Deep-link to graphs with pre-configured scenarios

---

## 1. Motivation

### 1.1 Current Limitations

Today, scenarios are **snapshots**:
- Created by capturing parameter values at a moment in time
- Named with timestamps by default (e.g., "Snapshot 2-Dec-25 14:32")
- No link to the query/context that produced them
- Cannot be refreshed without manual recreation

This works for "what if" analysis but falls short for:
- **Tracking multiple segments** (Google vs Meta vs Email) over time
- **Comparing date windows** (Last 7d vs Last 30d) with fresh data
- **Automating scenario updates** when underlying data changes
- **Sharing pre-configured views** via URL

### 1.2 What Live Scenarios Enable

| Capability | Description |
|------------|-------------|
| **One-click refresh** | Regenerate scenario from its stored DSL |
| **DSL-based labels** | `context(channel:google)` as the scenario name |
| **Bulk creation** | Right-click context → "Create [N] scenarios" |
| **Window scenarios** | Right-click 7d preset → expanded window options |
| **Base propagation** | "To Base" pushes current query, triggers regeneration |
| **URL presets** | `?scenarios=context(channel)` creates scenarios on load |

---

## 2. Conceptual Model

### 2.1 Scenario Types

We distinguish two scenario types:

| Type | Description | Label Default | Refresh? |
|------|-------------|---------------|----------|
| **Snapshot** | Static parameter capture | Timestamp | No |
| **Live** | DSL-linked, regenerable | DSL string | Yes |

Both types share the same underlying `Scenario` structure—live scenarios simply have additional metadata (`queryDSL`) and behaviour (regeneration).

### 2.2 Query DSL Composition & Inheritance

Live scenarios store a **fragment DSL** that is **smart-merged** with the **inherited DSL** when fetching data.

**Key rule:** Live scenarios inherit DSL from the **composed layers below them**, not just from Base.

```
Inherited DSL = SmartMerge(Base DSL, lower live scenario DSLs...)
Effective Query = SmartMerge(Inherited DSL, This Scenario's DSL Fragment)
```

**Smart merge behaviour:**
- Same constraint type **replaces** (e.g., `context(channel:meta)` replaces `context(channel:google)`)
- Different constraint types **combine** (e.g., `context(...)` + `window(...)` = both)

Uses existing `augmentDSLWithConstraint` logic which already implements smart merge.

**Example with stacked scenarios:**
```
Base DSL: window(-30d:)

A (live): context(channel:google)
   → Inherited: window(-30d:)
   → Effective: window(-30d:).context(channel:google)

B (static): manual params only — no DSL contribution

C (live): window(-7d:)
   → Inherited: window(-30d:).context(channel:google)  ← from A!
   → Effective: window(-7d:).context(channel:google)   ← context inherited!
```

**DSL inheritance rules:**
1. **Live scenarios inherit and extend** the DSL from layers below
2. **Static scenarios don't contribute DSL** — they only have params, no queryDSL
3. **Each live scenario specifies what it wants to CHANGE** — unspecified constraints are inherited
4. **To REMOVE an inherited constraint**, explicitly clear it (e.g., `context()`)

This enables:
- Build complex queries incrementally (A adds context, C changes window, both apply)
- Static scenarios can still override specific params without affecting DSL inheritance
- User CAN specify complete DSL if they want full control

### 2.3 Mixed DSL: Fetch Elements + What-If Elements

Live scenario DSLs can contain BOTH fetch elements and what-if elements:

```
context(channel:google).case(my-case:treatment).visited(gave-bds)
```

**DSL element types:**

| Element | Type | Purpose | Example |
|---------|------|---------|---------|
| `window()` | Fetch | Date range for API query | `window(-30d:-1d)` |
| `context()` | Fetch | Segment filter for API query | `context(channel:google)` |
| `case()` | What-If | Override case variant weight | `case(my-case:treatment)` |
| `visited()` | What-If | Conditional edge selection | `visited(gave-bds)` |
| `exclude()` | What-If | Exclude nodes from analysis | `exclude(failed-step)` |

**Parsing strategy:**

The existing `parseConstraints()` in `queryDSL.ts` already parses ALL element types:

```typescript
// parseConstraints() returns:
{
  window: { start, end },           // Fetch
  context: [{ key, value }],        // Fetch
  contextAny: [...],                // Fetch
  cases: [{ key, value }],          // What-If
  visited: ['node-a', 'node-b'],    // What-If
  visitedAny: [...],                // What-If
  exclude: [...]                    // What-If
}
```

**Regeneration flow with mixed DSL:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ Live Scenario: context(channel:google).case(my-case:treatment)      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 1: Parse DSL with parseConstraints()                           │
│   fetchParts: { context: [{key:'channel', value:'google'}] }        │
│   whatIfParts: { cases: [{key:'my-case', value:'treatment'}] }      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 2: Build effective fetch DSL                                   │
│   baseDSL: window(-30d:-1d)                                         │
│   + fetchParts → window(-30d:-1d).context(channel:google)           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 3: Fetch data from source                                      │
│   API call with effective fetch DSL                                 │
│   → Raw n/k/p values for channel:google                             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 4: Apply what-if overlay                                       │
│   Rebuild whatIfDSL: case(my-case:treatment)                        │
│   computeEffectiveEdgeProbability() for each edge                   │
│   Apply case variant weights (treatment=1.0, others=0.0)            │
│   → Effective params with what-if baked in                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 5: Store in scenario.params                                    │
│   scenario.params = { edges: {...}, nodes: {...} }                  │
│   (What-if effects are "baked in" to the params)                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Key insight:** The what-if elements ARE applied during regeneration. The resulting `scenario.params` contains the EFFECTIVE values with what-if baked in — exactly like snapshots today.

### 2.4 Live Scenarios in Compositing

The compositing machinery remains **unchanged**. Here's why:

**Current compositing flow:**
```
Rendered Params = compose(Base.params, scenario1.params, scenario2.params, ..., Current.params)
```

**What each scenario stores:**
- **Snapshot:** `params` = captured values at creation time (what-if already baked in)
- **Live:** `params` = values from last regeneration (what-if already baked in)

**Both scenario types work identically in composition** because:
1. Live scenarios store `params` just like snapshots
2. The `params` are the RESULT of regeneration (with what-if applied)
3. The `queryDSL` is only used for regeneration, not composition

**Live scenario lifecycle:**

```
Create Live Scenario
        │
        ▼
┌───────────────────┐
│ Regenerate        │ ←─── Manual click ↻, or "To Base" trigger
│  1. Fetch data    │
│  2. Apply what-if │
│  3. Store params  │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Composite         │ ←─── Same as snapshots
│  (uses params)    │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Render            │
└───────────────────┘
```

**The `queryDSL` is metadata for regeneration — it doesn't participate in compositing.**

### 2.5 Compositing Corner Cases

#### Example: Mixed Scenario Stack

Consider this scenario stack (top = highest precedence):

```
Current ────────────── (live working state, what-if applied at render)
   │
(C) Manual diff ────── { e.someEdge.p.mean = 0 }
   │
(B) Live Scenario ──── queryDSL: context(channel:google).case(treatment)
   │
(A) Snapshot All ───── all params captured at creation
   │
Base ──────────────── params extracted when file opened
```

**Compositing flow:**

```typescript
// CompositionService.composeParams()
result = deepClone(Base.params)
result = merge(result, (A).params)   // (A) overwrites everything it specifies
result = merge(result, (B).params)   // (B) overwrites everything it specifies  
result = merge(result, (C).params)   // (C) only overwrites someEdge.p.mean
// Current is applied separately (at render time with live what-if)
```

**Key insight:** Each layer is **sparse** — it only contains the params it wants to override. The merge is additive; keys not mentioned are preserved from lower layers.

#### Scenario: (B) Live Regeneration Overwrites (A)

When (B) regenerates:
1. Fetches data for `context(channel:google)` 
2. Applies `case(treatment)` what-if
3. Stores ALL affected edge params in `(B).params`

If (B) fetches all edges with connected parameters, `(B).params` will contain entries for all those edges, **overwriting** whatever (A) had for those same edges.

**This is correct behaviour.** (B) is saying "for this context, these are the values".

#### Scenario: (C) Applies as a Diff on Top

When user creates (C) with just `someEdge.p.mean = 0`:
- `(C).params = { edges: { someEdge: { p: { mean: 0 } } } }`
- Only `someEdge` is affected
- All other edges retain values from (B)

**Final composed result:**
```
someEdge.p.mean = 0              // from (C)
otherEdge.p.mean = <from (B)>    // preserved from (B)
anotherEdge.p.mean = <from (B)>  // preserved from (B)
```

#### What-If Timing

**Critical: What-if is baked at creation/regeneration time, not at render time.**

| Layer Type | When What-If Applied | What Graph State? |
|------------|----------------------|-------------------|
| Snapshot | At creation | Graph when snapshot taken |
| Live Scenario | At regeneration | Graph when regenerated |
| Current | At render | Live graph + active what-if |

This means:
- (B)'s `case(treatment)` is baked into (B).params during regeneration
- If graph structure changes (new edges, removed edges), regeneration computes fresh
- Current's what-if is always live — applied at render time, not stored

**Confirmed:** What-if DSL elements ARE reapplied during regeneration. Each regeneration:
1. Parses queryDSL to extract fetch + what-if parts
2. Fetches data with fetch parts
3. Applies what-if parts to compute effective params (using `computeEffectiveEdgeProbability`)
4. Stores fresh effective params in scenario.params

### 2.6 Worked Example: Mixed Live + Static Stack

Let's trace through a complex example to confirm the logic:

**Setup:**
```
Base DSL: window(-30d:)

Stack (bottom to top):
├── A (live): context(channel:google)
├── B (static): myedge.p.mean = 1
├── C (live): window(-7d:)
└── D (static): myedge.p.mean = 0
```

#### Step 1: Determine Effective Fetch DSL for Each Live Scenario

**Key rule:** Live scenarios inherit DSL from the composed layers below them (not just Base).

**For A:** `queryDSL = context(channel:google)`
```
Inherited DSL = Base DSL = window(-30d:)
Effective     = SmartMerge(inherited, A.queryDSL)
              = SmartMerge(window(-30d:), context(channel:google))
              = window(-30d:).context(channel:google)
```
→ API call fetches: **30-day window, Google channel only**

**After A:** Effective DSL for layers above = `window(-30d:).context(channel:google)`

**B (static):** No DSL contribution — static scenarios only have params.
→ Inherited DSL for layers above remains: `window(-30d:).context(channel:google)`

**For C:** `queryDSL = window(-7d:)`
```
Inherited DSL = window(-30d:).context(channel:google)  ← from A!
Effective     = SmartMerge(inherited, C.queryDSL)
              = SmartMerge(window(-30d:).context(channel:google), window(-7d:))
              = window(-7d:).context(channel:google)  ← window replaced, context INHERITED!
```
→ API call fetches: **7-day window, Google channel** (context inherited from A!)

**Important:** C inherits Google context from A because live scenarios build on the DSL stack below them. C only specifies what it wants to CHANGE (the window).

#### Step 2: Regeneration Results

Assume graph has edges: `e1`, `e2`, `myedge`

**Base params (30d, uncontexted):**
```yaml
edges:
  e1: { p: { mean: 0.10 } }
  e2: { p: { mean: 0.20 } }
  myedge: { p: { mean: 0.15 } }
```

**A.params (30d, Google):**
```yaml
edges:
  e1: { p: { mean: 0.12 } }      # Google 30d
  e2: { p: { mean: 0.22 } }      # Google 30d
  myedge: { p: { mean: 0.17 } }  # Google 30d
```

**B.params (manual):**
```yaml
edges:
  myedge: { p: { mean: 1.00 } }  # Just this one edge
```

**C.params (7d, Google — inherited context from A!):**
```yaml
edges:
  e1: { p: { mean: 0.08 } }      # Google 7d (more recent)
  e2: { p: { mean: 0.18 } }      # Google 7d (more recent)
  myedge: { p: { mean: 0.13 } }  # Google 7d (more recent)
```

**D.params (manual):**
```yaml
edges:
  myedge: { p: { mean: 0.00 } }  # Just this one edge
```

#### Step 3: Compositing (Base → A → B → C → D)

```
Start with Base:
  e1: 0.10, e2: 0.20, myedge: 0.15

After A (all edges, Google 30d):
  e1: 0.12, e2: 0.22, myedge: 0.17   ← A's Google 30d data

After B (just myedge):
  e1: 0.12, e2: 0.22, myedge: 1.00   ← B only touches myedge

After C (all edges, Google 7d):
  e1: 0.08, e2: 0.18, myedge: 0.13   ← C's Google 7d (inherited context!)

After D (just myedge):
  e1: 0.08, e2: 0.18, myedge: 0.00   ← D only touches myedge
```

#### Final Result

| Edge | Value | From Layer |
|------|-------|------------|
| `e1.p.mean` | 0.08 | C (7d, Google — inherited from A) |
| `e2.p.mean` | 0.18 | C (7d, Google — inherited from A) |
| `myedge.p.mean` | 0.00 | D (manual) |

#### Key Observations

1. **C inherited Google context from A** — C only specified `window(-7d:)` but got Google data because it built on A's DSL.

2. **B's manual override (1.00) is overwritten by C** — C fetched all edges for its query.

3. **D's manual override survives** — nothing above D to overwrite it.

4. **Live scenarios inherit DSL from lower live scenarios** — this enables building complex queries incrementally.

5. **Static scenarios don't contribute DSL** — B only has params, no queryDSL, so it doesn't affect the DSL inheritance chain.

#### DSL Inheritance Chain

```
Base DSL:                      window(-30d:)
                                    │
                                    ▼
A (live) adds context:         window(-30d:).context(channel:google)
                                    │
                                    ▼
B (static) — no DSL:           window(-30d:).context(channel:google)  (unchanged)
                                    │
                                    ▼
C (live) changes window:       window(-7d:).context(channel:google)
                                    │
                                    ▼
D (static) — no DSL:           window(-7d:).context(channel:google)  (unchanged)
```

#### Alternative: If C Wanted to REMOVE Context

If C wanted to fetch uncontexted data (all traffic, ignoring A's Google filter), it would need to explicitly clear it. Options:

**Option A: Explicit empty context**
```
C (live): window(-7d:).context()  ← clears inherited context
```

**Option B: Specify a different context**
```
C (live): window(-7d:).context(channel:meta)  ← replaces google with meta
```

The smart merge replaces same-type constraints, so specifying context() would replace the inherited context(channel:google)

### 2.7 Base Layer & "To Base"

The **Base** layer (currently called "Original" in UI — to be renamed) represents the default query applied to all data fetches. Live scenarios inherit from Base unless they override specific constraints.

**"To Base"** operation:
1. Takes the current graph's query DSL
2. Updates `graph.baseDSL`
3. If any live scenarios require fetch (data not in cache), shows confirmation
4. If all cached: proceeds immediately
5. Triggers parallel regeneration of all live scenarios
6. Shows progress toast

---

## 3. Data Model Changes

### 3.1 Scenario Type Extension

```typescript
// types/scenarios.ts

export interface ScenarioMeta {
  // ... existing fields ...
  
  /** 
   * Query DSL fragment for live scenarios.
   * When set, this scenario can be regenerated from source.
   * Composed with base DSL: effective = smartMerge(baseDSL, queryDSL)
   */
  queryDSL?: string;
  
  /**
   * Whether this is a live (regenerable) scenario.
   * Derived: true if queryDSL is set.
   */
  isLive?: boolean;
  
  /**
   * Timestamp of last data regeneration (for live scenarios).
   */
  lastRegeneratedAt?: string;
  
  /**
   * DSL used for last regeneration (may differ from queryDSL if base changed).
   */
  lastEffectiveDSL?: string;
}
```

### 3.2 Base Query Storage

**Decision:** Store `baseDSL` on graph object (persists to YAML file).

```typescript
// types/index.ts - ConversionGraph interface
interface ConversionGraph {
  // ... existing fields ...
  
  /** Base query DSL applied to all data fetches (persistent) */
  baseDSL?: string;
  
  /** Current query DSL (transient record, populates WindowSelector on load) */
  currentQueryDSL?: string;  // Already exists
}
```

**Distinction between DSL fields:**
| Field | Storage | Purpose | Survives F5? |
|-------|---------|---------|--------------|
| `graph.baseDSL` | YAML file | Persistent base for scenario composition | ✅ Yes |
| `graph.currentQueryDSL` | YAML file | Historic record of last query | ✅ Yes |
| `graphStore.currentDSL` | Runtime state | Authoritative source for live queries | ❌ No |

**Note:** `graphStore.currentDSL` is the runtime source of truth for all fetch operations. `graph.currentQueryDSL` is only for populating WindowSelector on first load.

### 3.3 ScenariosContext Extensions

```typescript
interface ScenariosContextValue {
  // ... existing interface ...
  
  // New operations for live scenarios
  createLiveScenario: (
    queryDSL: string,
    name?: string,  // Defaults to queryDSL
    tabId: string
  ) => Promise<Scenario>;
  
  regenerateScenario: (id: string) => Promise<void>;
  regenerateAllLive: () => Promise<void>;
  
  // Base operations
  baseDSL: string;
  setBaseDSL: (dsl: string) => void;
  putToBase: () => Promise<void>;  // Sets baseDSL from current graph DSL, regenerates all
}
```

### 3.4 Mixed DSL Storage & Processing

Live scenario DSLs can contain both fetch elements (`window`, `context`) and what-if elements (`case`, `visited`). 

**Storage approach:**

```typescript
export interface ScenarioMeta {
  // The FULL DSL as entered by user (or generated)
  // e.g., "context(channel:google).case(my-case:treatment).visited(gave-bds)"
  queryDSL?: string;
  
  // ... other fields
}
```

**Processing approach (during regeneration):**

```typescript
// In regenerateScenario():
const parsed = parseConstraints(scenario.meta.queryDSL);

// 1. Extract fetch elements
const fetchDSL = buildDSLFromParts({
  window: parsed.window,
  context: parsed.context,
  contextAny: parsed.contextAny
});

// 2. Extract what-if elements  
const whatIfDSL = buildDSLFromParts({
  cases: parsed.cases,
  visited: parsed.visited,
  visitedAny: parsed.visitedAny,
  exclude: parsed.exclude
});

// 3. Fetch with fetchDSL
await dataOperationsService.getFromSourceDirect({ currentDSL: effectiveFetchDSL, ... });

// 4. Apply whatIfDSL to compute effective params (same as snapshot creation)
const effectiveParams = computeEffectiveParams(graph, whatIfDSL);

// 5. Store in scenario
scenario.params = effectiveParams;
```

**Key design decisions:**
- Store the FULL DSL in `queryDSL` (not split)
- Parse and split at regeneration time
- What-if effects are baked into `params` (same as snapshots)
- Compositing works on `params`, unchanged

---

## 4. UI Changes

### 4.1 Scenarios Panel

#### 4.1.1 Rename "Original" → "Base"

Simple text change in `ScenariosPanel.tsx`:
- "Original" label → "Base"
- Tooltip: "Base parameters — inherited by all scenarios unless overridden"

#### 4.1.2 Header Actions

Add "Refresh All" button at top-right of panel header (inline with "Scenarios" label):
- Only visible if there are any live scenarios
- Regenerates all live scenarios in parallel
- Shows confirmation if any require fetch

```
┌─────────────────────────────────────────────────────────┐
│ Scenarios                                    [↻ All]    │
├─────────────────────────────────────────────────────────┤
```

#### 4.1.3 Scenario Row for Live Scenarios

Live scenarios display with additional indicators:

```
┌─────────────────────────────────────────────────────────┐
│ ◉ ⚡ context(channel:google)           ↻  ✎  🗑️  👁️    │
└─────────────────────────────────────────────────────────┘
```

- **⚡ (zap icon)**: Indicates live scenario (immediately after colour swatch)
- **Label**: DSL string (or user-renamed), truncated if long, full DSL in tooltip
- **↻ (refresh)**: Regenerate from source
- **✎ (pencil)**: Opens DSL edit modal
- **🗑️ (delete)**: Delete scenario
- **👁️ (eye)**: Toggle visibility

#### 4.1.4 DSL Edit Modal

Click ✎ opens a modal with QueryExpressionEditor for the scenario's DSL:

```
┌─────────────────────────────────────────────────────────┐
│ Edit Live Scenario Query                            [×] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Query DSL:                                              │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [context] [channel:google]  [+]                     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Effective (with base):                                  │
│ window(-30d:-1d).context(channel:google)                │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                              [Cancel]  [Save & Refresh] │
└─────────────────────────────────────────────────────────┘
```

- Chip view for quick context/window changes
- Shows effective (merged) DSL preview
- Save triggers regeneration

#### 4.1.5 "+ New Scenario" Menu Extension

Extended menu:
```
+ New scenario
├── Snapshot all
├── Snapshot differences
├── Create blank
├── ─────────────────
└── From current query    ← NEW (creates live scenario)
```

"From current query" creates a live scenario using the current `graphStore.currentDSL`.

#### 4.1.6 Footer Actions

Compact footer with inline actions:

```
┌─────────────────────────────────────────────────────────┐
│ [+ New] [Flatten] [↓ To Base]                           │
└─────────────────────────────────────────────────────────┘
```

- **+ New**: Opens new scenario menu
- **Flatten**: (renamed from "Flatten All") Merges all overlays into Base
- **↓ To Base**: (icon: `<CalendarArrowDown>`) Pushes current DSL to base, regenerates live scenarios

#### 4.1.7 Scenario Context Menu

Right-click on any scenario:
```
├── Rename
├── Change colour
├── ─────────────────
├── Create Snapshot    ← NEW (for live scenarios only)
├── ─────────────────
└── Delete
```

"Create Snapshot" captures current params from live scenario as a new snapshot.

### 4.2 Context Chip Affordances

#### 4.2.1 Context Chips in WindowSelector

Add context menu to context chips:

```
Right-click on [context(channel:google)] chip
├── Remove
├── ─────────────────
└── Create [4] scenarios...    ← Shows count
```

**Behaviour:**
- If ALL values are in cache → create immediately, no modal
- If ANY require fetch → show modal with selection and `[requires fetch]` indicators

Modal (when fetch required):
```
┌─────────────────────────────────────────────────────────┐
│ Create Scenarios for "channel"                          │
├─────────────────────────────────────────────────────────┤
│ This will create one live scenario per value:           │
│                                                         │
│ ☑ google          → context(channel:google)             │
│ ☑ meta            → context(channel:meta) [fetch]       │
│ ☑ email           → context(channel:email) [fetch]      │
│ ☑ organic         → context(channel:organic) [fetch]    │
│                                                         │
│ [Select All] [Select None]                              │
├─────────────────────────────────────────────────────────┤
│                              [Cancel]  [Create 4]       │
└─────────────────────────────────────────────────────────┘
```

#### 4.2.2 Context Sidebar Navigation

Right-click on context FILE in sidenav (sidenav shows files, not individual keys):
```
├── Open
├── ─────────────────
└── Create [N] scenarios...    ← Same hook as chip
```

### 4.3 Window Selector Affordances

#### 4.3.1 Quick Date Preset Context Menu

Right-click on preset buttons (7d, 30d, 90d) shows expanded options:

```
Right-click on [7d] button
├── Create scenario (-7d:-1d)
├── Create scenario (-14d:-7d)
├── Create scenario (-21d:-14d) [requires fetch]
├── Create scenario (-28d:-21d) [requires fetch]
├── ─────────────────
└── Create 4 scenarios (weekly) [requires fetch]
```

Similar patterns for 30d (monthly chunks) and 90d (quarterly chunks).

### 4.4 "To Base" Action

**Behaviour:**
1. Takes current graph's query DSL
2. Updates `graph.baseDSL`
3. Checks if any live scenarios require fetch (not in cache)
4. If fetch required: shows confirmation with count
5. If all cached: proceeds immediately
6. Triggers parallel regeneration of all live scenarios
7. Shows progress toast

---

## 5. URL Parameters for Scenarios

### 5.1 Overview

Allow scenarios to be created via URL query parameters for:
- Deep-linking to specific analyses
- Sharing pre-configured scenario sets
- Embedding dashboards with specific slices
- Automation / reporting pipelines

### 5.2 URL Format

```
http://dagnet.url?graph=<graph-id>&scenarios=<dsl-list>&hidecurrent
```

| Param | Description | Required |
|-------|-------------|----------|
| `graph` | Graph file ID to load | Existing |
| `scenarios` | DSL expressions, semicolon-separated | New |
| `hidecurrent` | Hide the Current layer | New |

### 5.3 Examples

**1. One scenario per context value (explode bare key):**
```
?graph=conversion-v2&scenarios=window(-30d:-1d).context(channel)
```
- `context(channel)` (bare key) explodes to all values
- Creates N live scenarios: `context(channel:google)`, `context(channel:meta)`, etc.
- Window inherited from URL DSL

**2. Explicit multiple scenarios:**
```
?graph=conversion-v2&scenarios=context(channel:google);context(channel:meta)
```
- Creates 2 explicit live scenarios
- Window uses graph's baseDSL

**3. Window comparison:**
```
?graph=conversion-v2&scenarios=window(-3m:-2m);window(-2m:-1m);window(-1m:-0m)
```
- Creates 3 live scenarios for different time windows
- Context uses graph's baseDSL if any

**4. Dashboard mode (hide current):**
```
?graph=conversion-v2&scenarios=context(channel)&hidecurrent
```
- Creates scenarios for all channels
- Hides Current layer for clean dashboard view

### 5.4 Implementation

**USE EXISTING `explodeDSL` — do NOT write new parsing logic.**

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

**Implementation steps:**
1. Parse `scenarios` param in app initialisation (after graph load)
2. URL-decode and pass to `explodeDSL(scenariosParam)`
3. Create one live scenario per returned slice
4. Handle `hidecurrent` by setting `visibleScenarioIds` to exclude `'current'`
5. Error handling: Toast + skip invalid DSL (don't block load)

---

## 6. Implementation Plan

### 6.1 Phase 1: Core Infrastructure (MVP)

1. **Type changes** — Add `queryDSL`, `isLive`, `lastRegeneratedAt` to `ScenarioMeta`
2. **Add baseDSL** — Add `baseDSL` to Graph type
3. **ScenariosContext** — Add `createLiveScenario`, `regenerateScenario`, `baseDSL`, `setBaseDSL`
4. **UI: Rename** — "Original" → "Base"
5. **UI: Live indicator** — Show ⚡ zap icon and ↻ refresh on live scenarios
6. **UI: Create from query** — "+ New scenario → From current query"
7. **UI: DSL edit modal** — ✎ opens modal with QueryExpressionEditor

### 6.2 Phase 2: Bulk Creation

1. **Cache-check generalisation** — Extract `itemNeedsFetch` to service for multi-DSL checking
2. **Context chip context menu** — "Create [N] scenarios..."
3. **Adaptive modal** — Show only if fetch required
4. **Window preset context menu** — Expanded options with weekly/monthly chunks
5. **Context sidebar affordance** — Right-click on context file

### 6.3 Phase 3: Base Propagation

1. **To Base action** — Footer button with icon
2. **Regenerate all live** — Parallel fetch with progress
3. **Refresh All button** — Header action

### 6.4 Phase 4: URL Parameters

1. **URL parsing** — Extract `scenarios` and `hidecurrent` params
2. **Use explodeDSL** — Parse using existing explosion logic
3. **Scenario creation on load** — After graph loads
4. **Error handling** — Toast + skip invalid DSL

---

## 7. Resolved Decisions

| Decision | Resolution | Rationale |
|----------|------------|-----------|
| Fragment vs Full DSL | Fragment (diff) by default | Enables base window changes to propagate |
| Base DSL storage | `graph.baseDSL` (persists to YAML) | Same pattern as `currentQueryDSL` |
| DSL editing UI | Modal (not inline) | Simpler, avoids data/DSL ambiguity |
| Bulk creation UX | Adaptive: immediate if cached, modal if fetch needed | Fast path for common case |
| Window presets | Expanded menu with weekly/monthly chunks | More powerful |
| Regeneration trigger | On base/lower change, confirm if fetch needed | User expectation |
| Scenario limit | No warnings needed | Easy to create/destroy |
| Staleness indicator | Phase 2 | Not critical for MVP |
| Sync vs Async creation | Synchronous | Keep it simple |
| Smart merge | Use existing augmentDSLWithConstraint | Already handles this |
| Mixed DSL handling | Parse+split at regen time, bake what-if into params | Reuses parseConstraints |
| Compositing | Unchanged — params is the interface | Live scenarios work like snapshots |
| URL parsing | Use existing explodeDSL | Don't duplicate logic |

---

## 8. Dependencies

- **QueryExpressionEditor** — Reuse for DSL editing modal
- **dataOperationsService.getFromSourceDirect** — For regeneration fetches
- **contextRegistry** — For bulk scenario creation (list all values for a key)
- **useFetchData hook** — For coordinated fetching with progress
- **augmentDSLWithConstraint** — For smart merge composition
- **explodeDSL** — For URL param and bulk creation parsing

---

## Appendix A: Example Workflows

### A.1 Channel Comparison

1. User is viewing funnel with `window(-30d:-1d)`
2. Clicks context chip, selects `channel:google`
3. Right-clicks the `context(channel:google)` chip
4. Selects "Create [4] scenarios..."
5. All values in cache → scenarios created immediately
6. Four live scenarios appear:
   - `context(channel:google)`
   - `context(channel:meta)`
   - `context(channel:email)`
   - `context(channel:organic)`
7. User can now compare all channels on the graph

### A.2 Window Comparison via Presets

1. User wants weekly comparison
2. Right-clicks "7d" preset button
3. Selects "Create 4 scenarios (weekly)"
4. Four live scenarios created:
   - `window(-7d:-1d)`
   - `window(-14d:-7d)`
   - `window(-21d:-14d)`
   - `window(-28d:-21d)`
5. Enables all → side-by-side weekly comparison

### A.3 Base Propagation

1. User has 3 live scenarios: google, meta, email
2. Changes base window from 30d to 90d
3. Clicks "To Base"
4. 2 of 3 scenarios need fetch → confirmation shown
5. User confirms
6. All scenarios refresh with 90d window
7. Each retains its channel context

### A.4 URL-Based Dashboard

1. User shares URL:
   ```
   ?graph=conversion-v2&scenarios=context(channel)&hidecurrent
   ```
2. Colleague opens link
3. Graph loads with all channel scenarios pre-created
4. Current layer hidden for clean dashboard view
5. Ready for presentation
