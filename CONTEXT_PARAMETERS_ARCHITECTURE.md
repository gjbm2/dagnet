# Context Parameters - Architecture Diagram

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GRAPH EDITOR UI                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │  Graph Canvas   │  │ Properties Panel │  │  What-If Panel    │  │
│  │                 │  │                  │  │                   │  │
│  │  • Nodes        │  │  • Edge Props    │  │  ┌─────────────┐ │  │
│  │  • Edges        │  │  • Probability   │  │  │Context      │ │  │
│  │  • Tooltips     │  │  • Costs         │  │  │Selector     │ │  │
│  │                 │  │  • Param Source  │  │  │             │ │  │
│  │                 │  │                  │  │  │☑ Google     │ │  │
│  │                 │  │  [Create Context │  │  │☑ Facebook   │ │  │
│  │                 │  │   Parameter...]  │  │  │☐ Organic    │ │  │
│  └────────┬────────┘  └─────────┬────────┘  │  └─────────────┘ │  │
│           │                     │            └───────┬───────────┘  │
│           └─────────────────────┼────────────────────┘              │
│                                 │                                   │
└─────────────────────────────────┼───────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      APPLICATION LOGIC                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Graph State Management                                      │   │
│  │                                                               │   │
│  │  • graph: GraphData                                          │   │
│  │  • activeContexts: ActiveContexts                            │   │
│  │  • parameters: Parameter[]                                   │   │
│  └──────────────┬───────────────────────────────────────────────┘   │
│                 │                                                    │
│  ┌──────────────▼───────────────────────────────────────────────┐   │
│  │  conditionalReferences.ts                                    │   │
│  │                                                               │   │
│  │  • parseConditionalReference()                               │   │
│  │  • generateConditionalReference()                            │   │
│  │  • matchesActiveContexts()                                   │   │
│  └──────────────┬───────────────────────────────────────────────┘   │
│                 │                                                    │
│  ┌──────────────▼───────────────────────────────────────────────┐   │
│  │  parameterRegistry.ts                                        │   │
│  │                                                               │   │
│  │  • loadContexts()                                            │   │
│  │  • loadParameters()                                          │   │
│  │  • resolveEdgeParameter() ← FALLBACK HIERARCHY              │   │
│  │  • createParameter()                                         │   │
│  └──────────────┬───────────────────────────────────────────────┘   │
│                 │                                                    │
└─────────────────┼────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PARAMETER REGISTRY (File System)                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  param-registry/                                                     │
│  │                                                                    │
│  ├── contexts.yaml ◄────────────── Context Definitions               │
│  │   └── contexts:                                                   │
│  │       ├── channel: [google, facebook, organic]                    │
│  │       ├── device: [mobile, desktop, tablet]                       │
│  │       └── utm_source: [newsletter, promo, ...]                    │
│  │                                                                    │
│  ├── registry.yaml ◄────────────── Parameter Index                   │
│  │   └── parameters: [list of all parameter IDs]                     │
│  │                                                                    │
│  └── parameters/                                                     │
│      ├── probability/                                                │
│      │   ├── signup-base.yaml ◄── Base (no context)                  │
│      │   ├── signup-google.yaml ◄── Context: channel=google          │
│      │   ├── signup-google-mobile.yaml ◄── Context: channel+device   │
│      │   └── ...                                                     │
│      │                                                                │
│      ├── cost/                                                       │
│      └── time/                                                       │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Parameter Resolution

```
┌───────────────────────────────────────────────────────────────────────┐
│                      1. USER INTERACTION                               │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                User checks [Google] and [Facebook] in context selector
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│                      2. STATE UPDATE                                   │
│                                                                         │
│  activeContexts = {                                                    │
│    channel: ['google', 'facebook'],                                   │
│    device: ['mobile', 'desktop', 'tablet']  // all checked           │
│  }                                                                     │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│                 3. TRIGGER GRAPH RECALCULATION                         │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                   For each edge in graph...
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│                 4. RESOLVE PARAMETER FOR EDGE                          │
│                                                                         │
│  resolveEdgeParameter(                                                 │
│    edgeSlug: 'signup',                                                 │
│    visitedNodes: ['pricing'],  // user's path                         │
│    activeContexts: { channel: ['google','facebook'], device: [...] }, │
│    paramType: 'mean'                                                   │
│  )                                                                     │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│              5. FALLBACK HIERARCHY (Most Specific First)               │
│                                                                         │
│  ┌─ Step 1: Check Exact Match ───────────────────────────────────┐    │
│  │  visited=[pricing] AND context={channel:google, device:mobile}│    │
│  │  Result: NOT FOUND                                            │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                  │                                     │
│  ┌─ Step 2: Check Context-Only ───────────────────────────────────┐   │
│  │  context={channel:google, device:mobile}                       │   │
│  │  Candidate: signup-google-mobile.yaml                          │   │
│  │  Context Filter: {channel: google, device: mobile}             │   │
│  │  Match Check:                                                  │   │
│  │    - channel: google in [google, facebook] ✓                   │   │
│  │    - device: mobile in [mobile, desktop, tablet] ✓             │   │
│  │  Result: MATCH FOUND ✓                                         │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                  │                                     │
│                          Return value: 0.32                            │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│                   6. UPDATE EDGE IN GRAPH                              │
│                                                                         │
│  edge.p.mean = 0.32                                                    │
│  edge.parameterSource = "signup-google-mobile"                         │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     7. RENDER UPDATED GRAPH                            │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Reference Notation: Anatomy

```
┌─────────────────────────────────────────────────────────────────────┐
│  e.signup.visited(pricing,landing).context(channel='google').p.mean  │
│  ▲   ▲       ▲                       ▲                        ▲  ▲   │
│  │   │       │                       │                        │  │   │
│  │   │       │                       │                        │  │   │
│  │   │       └─ Visited Nodes        └─ Context Filters      │  │   │
│  │   │          (sorted alphabetically)  (sorted by key)      │  │   │
│  │   │                                                        │  │   │
│  │   └─ Edge Slug                                            │  │   │
│  │                                                            │  │   │
│  └─ Prefix (edge)                                  Parameter  ─┘  │   │
│                                                     Category       │   │
│                                                                    │   │
│                                                        Parameter ──┘   │
│                                                        Type            │
└─────────────────────────────────────────────────────────────────────┘

Examples:
  e.signup.p.mean
    → Base parameter (no conditions)
  
  e.signup.context(channel='google').p.mean
    → Context only
  
  e.signup.visited(pricing).p.mean
    → Visited only
  
  e.signup.visited(pricing).context(channel='google',device='mobile').p.mean
    → Both visited and context (most specific)
```

---

## Parameter Resolution: Fallback Hierarchy Detailed

```
User Context:  channel=[google, facebook], device=[mobile]
Visited Nodes: [pricing]
Edge:          signup
Param Type:    mean

Available Parameters in Registry:
┌────────────────────────────────────────────────────────────────┐
│ ID: signup-base                                                │
│ Reference: e.signup.p.mean                                     │
│ Visited: []                                                    │
│ Context: {}                                                    │
│ Value: 0.30                                                    │
│ Priority: 4 (Base)                                             │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ ID: signup-google                                              │
│ Reference: e.signup.context(channel='google').p.mean           │
│ Visited: []                                                    │
│ Context: {channel: google}                                     │
│ Value: 0.35                                                    │
│ Priority: 2 (Context Only) ← MATCHES ✓                         │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ ID: signup-google-mobile                                       │
│ Reference: e.signup.context(channel='google',device='mobile')  │
│ Visited: []                                                    │
│ Context: {channel: google, device: mobile}                     │
│ Value: 0.32                                                    │
│ Priority: 2 (Context Only) ← MATCHES ✓ (more specific)         │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ ID: signup-visited-pricing                                     │
│ Reference: e.signup.visited(pricing).p.mean                    │
│ Visited: [pricing]                                             │
│ Context: {}                                                    │
│ Value: 0.40                                                    │
│ Priority: 3 (Visited Only) ← MATCHES ✓                         │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ ID: signup-visited-pricing-google                              │
│ Reference: e.signup.visited(pricing).context(channel='google') │
│ Visited: [pricing]                                             │
│ Context: {channel: google}                                     │
│ Value: 0.45                                                    │
│ Priority: 1 (Exact Match) ← MATCHES ✓ (most specific)          │
└────────────────────────────────────────────────────────────────┘

Resolution:
  1. Check Priority 1 (Exact) → Found: signup-visited-pricing-google
  2. ✓ RETURN 0.45
  
  (If not found, would check Priority 2, then 3, then 4)
```

---

## UI Component Hierarchy

```
App
├── GraphEditor
│   ├── GraphCanvas
│   │   ├── Nodes
│   │   │   └── Node
│   │   │       └── CaseBadge (if has case)
│   │   └── Edges
│   │       └── Edge
│   │           └── Tooltip (shows parameter source)
│   │
│   ├── PropertiesPanel
│   │   ├── NodeProperties
│   │   │   └── CaseEditor
│   │   └── EdgeProperties
│   │       ├── ProbabilityEditor
│   │       │   ├── ParameterSourceDisplay
│   │       │   └── [Create Context Parameter] Button
│   │       ├── CostEditor
│   │       └── ConditionalProbabilities
│   │
│   └── WhatIfPanel (NEW)
│       ├── ContextSelector (NEW)
│       │   └── ContextGroup (per context)
│       │       ├── Header ([All] [None] buttons)
│       │       └── ContextValueCheckbox[]
│       │
│       ├── ParameterOverrides
│       │   └── OverrideEditor
│       │
│       └── ScenarioManager
│           ├── SaveScenario
│           └── LoadScenario
│
├── ParameterBrowser (Modal)
│   ├── SearchBar
│   ├── ContextFilter
│   └── ParameterList
│       └── ParameterCard
│
└── CreateContextParameterDialog (Modal)
    ├── EdgeInfo (read-only)
    ├── ContextFilterSelector
    ├── ValueInputs
    └── Actions ([Cancel] [Create])
```

---

## File Organization

```
dagnet/
│
├── graph-editor/
│   └── src/
│       ├── components/
│       │   ├── GraphCanvas.tsx (existing)
│       │   ├── PropertiesPanel.tsx (existing, extend)
│       │   ├── WhatIfPanel.tsx (NEW)
│       │   ├── ContextSelector.tsx (NEW)
│       │   ├── ParameterBrowser.tsx (NEW)
│       │   └── CreateContextParameterDialog.tsx (NEW)
│       │
│       └── lib/
│           ├── types.ts (extend with context types)
│           ├── conditionalReferences.ts (extend for context)
│           ├── parameterRegistry.ts (NEW - core loader)
│           ├── contextAnalysis.ts (NEW - coverage analysis)
│           └── graphCalculations.ts (extend for context resolution)
│
└── param-registry/
    ├── contexts.yaml (NEW - context definitions)
    ├── registry.yaml (existing - parameter index)
    │
    ├── schemas/
    │   ├── context-schema.yaml (NEW)
    │   ├── parameter-schema.yaml (existing, extend)
    │   └── registry-schema.yaml (existing)
    │
    └── parameters/
        ├── probability/
        │   ├── signup-base.yaml
        │   ├── signup-google.yaml (NEW - with context_filter)
        │   ├── signup-google-mobile.yaml (NEW)
        │   └── ...
        ├── cost/
        └── time/
```

---

## Type System

```typescript
// Core Types

interface ContextDefinition {
  id: string;                    // e.g., "channel"
  name: string;                  // e.g., "Marketing Channel"
  type: 'categorical' | 'ordinal' | 'continuous';
  values: ContextValue[];
}

interface ContextValue {
  id: string;                    // e.g., "google"
  label: string;                 // e.g., "Google Ads"
  order?: number;                // For ordinal contexts
}

interface ContextFilter {
  [contextId: string]: string;   // e.g., { channel: 'google', device: 'mobile' }
}

interface ActiveContexts {
  [contextId: string]: string[]; // e.g., { channel: ['google', 'facebook'] }
}

interface Parameter {
  id: string;
  name: string;
  type: 'probability' | 'cost' | 'time';
  
  // NEW: Context fields
  edge_reference?: string;       // e.g., "e.signup.context(channel='google').p.mean"
  context_filter?: ContextFilter; // e.g., { channel: 'google' }
  visited_filter?: string[];     // e.g., ['pricing']
  
  value: number | ParameterValue;
  metadata: ParameterMetadata;
}

interface ConditionalReference {
  edgeSlug: string;              // e.g., "signup"
  visitedNodes: string[];        // e.g., ['pricing']
  contextFilters: ContextFilter; // e.g., { channel: 'google' }
  paramType: 'mean' | 'stdev';
}
```

---

## Key Algorithms

### 1. Context Matching
```typescript
function matchesActiveContexts(
  paramFilter: ContextFilter,
  activeContexts: ActiveContexts
): boolean {
  // For each context in parameter's filter
  for (const [contextId, contextValue] of Object.entries(paramFilter)) {
    const activeValues = activeContexts[contextId];
    
    // If no active filter for this context, matches all
    if (!activeValues || activeValues.length === 0) continue;
    
    // Parameter's value must be in active set
    if (!activeValues.includes(contextValue)) return false;
  }
  
  return true;
}
```

### 2. Parameter Resolution
```typescript
function resolveEdgeParameter(
  edgeSlug: string,
  visitedNodes: string[],
  activeContexts: ActiveContexts,
  paramType: 'mean' | 'stdev'
): number | null {
  
  const candidates = getParametersForEdge(edgeSlug, paramType);
  
  // Priority 1: Exact match (visited + context)
  for (const param of candidates) {
    if (matchesVisited(param, visitedNodes) && 
        matchesContext(param, activeContexts)) {
      return extractValue(param);
    }
  }
  
  // Priority 2: Context-only
  for (const param of candidates) {
    if (!hasVisitedFilter(param) && 
        matchesContext(param, activeContexts)) {
      return extractValue(param);
    }
  }
  
  // Priority 3: Visited-only
  for (const param of candidates) {
    if (matchesVisited(param, visitedNodes) && 
        !hasContextFilter(param)) {
      return extractValue(param);
    }
  }
  
  // Priority 4: Base
  for (const param of candidates) {
    if (!hasVisitedFilter(param) && !hasContextFilter(param)) {
      return extractValue(param);
    }
  }
  
  return null; // No parameter found
}
```

---

## Summary

This architecture provides:

1. **Clear separation of concerns**
   - Registry (file system) for parameter storage
   - Application logic for resolution
   - UI components for interaction

2. **Extensible design**
   - Easy to add new contexts
   - New parameter types supported
   - UI components reusable

3. **Performance-optimized**
   - Caching at multiple levels
   - Efficient resolution algorithm
   - Lazy loading where possible

4. **User-friendly**
   - Intuitive checkbox UI
   - Clear fallback hierarchy
   - Visual parameter sources

**Ready for implementation following CONTEXT_PARAMETERS_ROADMAP.md**



