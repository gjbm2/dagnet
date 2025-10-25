# Context Parameters Design Specification

**Created:** October 21, 2025  
**Status:** Design Proposal  
**Related:** PARAMETER_REGISTRY_STATUS.md, CONDITIONAL_PROBABILITY_REFERENCES.md

---

## Overview

Context parameters represent external variables (channel, utm_source, device, etc.) that affect conversion probabilities but are not part of the graph structure itself. This design extends the parameter registry to support context-aware conditional probabilities.

### Key Requirements

1. **Canonical context definitions** - Contexts like 'channel' or 'utm_source' need standardized names and values
2. **Context-aware conditional probabilities** - `e.edgename.context(channel='google').p.mean`
3. **UI filtering** - What-if analysis with context checkboxes
4. **Registry integration** - Contexts stored alongside other parameters

---

## Design Decisions

### 1. Reference Notation: Chainable Context

**Format:**
```
Base:               e.<edge-slug>.p.{mean|stdev}
Context only:       e.<edge-slug>.context(<key>=<val>[,<key>=<val>...]).p.{mean|stdev}
Visited only:       e.<edge-slug>.visited(<node>[,<node>...]).p.{mean|stdev}
Both:               e.<edge-slug>.visited(<node>...).context(<key>=<val>...).p.{mean|stdev}
```

**Examples:**
```
e.signup.context(channel='google').p.mean
e.signup.context(channel='google',device='mobile').p.mean
e.signup.visited(landing-page).context(channel='google').p.mean
e.checkout.context(device='mobile',browser='chrome').p.stdev
```

**Rationale:**
- Separates structural (`visited`) from external (`context`) conditions
- Allows both types simultaneously
- Order-independent (alphabetically sort for determinism)
- Natural fallback hierarchy

**Parsing Rules:**
- Context keys/values sorted alphabetically: `context(a='x',b='y')`
- Chain order normalized: always `visited()` before `context()`
- Single quotes required for values (to distinguish from numbers)

---

### 2. Context Definition Structure

**New file:** `param-registry/contexts.yaml`

```yaml
# Context Definitions
# Defines all available context variables and their valid values

contexts:
  - id: channel
    name: "Marketing Channel"
    description: "Source channel for user acquisition"
    type: categorical
    values:
      - id: google
        label: "Google Ads"
        description: "Google Ads campaigns"
      - id: facebook
        label: "Facebook Ads"
        description: "Facebook advertising"
      - id: organic
        label: "Organic Search"
        description: "Unpaid search traffic"
      - id: email
        label: "Email Campaign"
        description: "Email marketing"
      - id: direct
        label: "Direct"
        description: "Direct URL entry"
    metadata:
      category: marketing
      created_at: "2025-10-21T00:00:00Z"
      version: "1.0.0"
  
  - id: utm_source
    name: "UTM Source"
    description: "UTM source parameter from URL"
    type: categorical
    values:
      - id: google
        label: "Google"
      - id: facebook
        label: "Facebook"
      - id: newsletter
        label: "Newsletter"
      - id: twitter
        label: "Twitter"
    metadata:
      category: marketing
      created_at: "2025-10-21T00:00:00Z"
      version: "1.0.0"
  
  - id: device
    name: "Device Type"
    description: "User's device category"
    type: categorical
    values:
      - id: mobile
        label: "Mobile"
      - id: desktop
        label: "Desktop"
      - id: tablet
        label: "Tablet"
    metadata:
      category: technical
      created_at: "2025-10-21T00:00:00Z"
      version: "1.0.0"
  
  - id: browser
    name: "Browser"
    description: "Browser family"
    type: categorical
    values:
      - id: chrome
        label: "Chrome"
      - id: firefox
        label: "Firefox"
      - id: safari
        label: "Safari"
      - id: edge
        label: "Edge"
    metadata:
      category: technical
      created_at: "2025-10-21T00:00:00Z"
      version: "1.0.0"
  
  - id: browser_version
    name: "Browser Version"
    description: "Major browser version number"
    type: ordinal
    values:
      - id: chrome_120
        label: "Chrome 120+"
        order: 120
      - id: chrome_119
        label: "Chrome 119"
        order: 119
      - id: chrome_118
        label: "Chrome 118"
        order: 118
    comparison_support: true  # Supports >, <, >=, <=
    metadata:
      category: technical
      created_at: "2025-10-21T00:00:00Z"
      version: "1.0.0"
  
  - id: geo_country
    name: "Country"
    description: "User's country (ISO 3166-1 alpha-2)"
    type: categorical
    values:
      - id: GB
        label: "United Kingdom"
      - id: US
        label: "United States"
      - id: FR
        label: "France"
      - id: DE
        label: "Germany"
    metadata:
      category: geographic
      created_at: "2025-10-21T00:00:00Z"
      version: "1.0.0"
  
  - id: time_of_day
    name: "Time of Day"
    description: "Time bucket when action occurred"
    type: ordinal
    values:
      - id: morning
        label: "Morning (6am-12pm)"
        order: 1
      - id: afternoon
        label: "Afternoon (12pm-6pm)"
        order: 2
      - id: evening
        label: "Evening (6pm-12am)"
        order: 3
      - id: night
        label: "Night (12am-6am)"
        order: 4
    metadata:
      category: temporal
      created_at: "2025-10-21T00:00:00Z"
      version: "1.0.0"

metadata:
  version: "1.0.0"
  created_at: "2025-10-21T00:00:00Z"
  updated_at: "2025-10-21T00:00:00Z"
  description: "Canonical context definitions for Dagnet parameter registry"
```

**Key features:**
- Centralized context definitions
- Categorical and ordinal types
- Human-readable labels for UI
- Metadata for versioning and categorization

---

### 3. Parameter File Extensions

Parameters can now specify context filters:

```yaml
# param-registry/parameters/probability/signup-google-mobile.yaml

id: signup-google-mobile-conversion
name: "Signup Conversion - Google Mobile"
type: probability

# The canonical reference this parameter maps to
edge_reference: e.signup.context(channel='google',device='mobile').p.mean

# Context filter specification
context_filter:
  channel: google
  device: mobile

# Visited node filter (optional, can combine with context)
visited_filter: []  # or: [landing-page, pricing]

value:
  mean: 0.35
  stdev: 0.05
  distribution: beta

metadata:
  description: "Signup conversion rate for Google Ads traffic on mobile devices"
  units: "probability"
  constraints:
    min: 0.0
    max: 1.0
  tags: ["conversion", "signup", "google", "mobile"]
  created_at: "2025-10-21T00:00:00Z"
  author: "data-team"
  version: "1.0.0"
  status: "active"
```

**Example with visited + context:**
```yaml
id: checkout-returning-google
name: "Checkout - Returning Google Users"
type: probability
edge_reference: e.checkout.visited(product-page).context(channel='google').p.mean

visited_filter: [product-page]
context_filter:
  channel: google

value:
  mean: 0.42
  stdev: 0.06

# ... metadata
```

---

### 4. Schema Extensions

#### 4.1 Context Schema

**New file:** `param-registry/schemas/context-schema.yaml`

```yaml
# Context Definition Schema
type: object
required: [id, name, type, values]
properties:
  id:
    type: string
    pattern: '^[a-z_][a-z0-9_]*$'
    description: "Context identifier (snake_case)"
  
  name:
    type: string
    description: "Human-readable context name"
  
  description:
    type: string
    description: "Description of what this context represents"
  
  type:
    type: string
    enum: [categorical, ordinal, continuous]
    description: "Context type"
  
  values:
    type: array
    items:
      type: object
      required: [id, label]
      properties:
        id:
          type: string
          pattern: '^[a-z0-9_-]+$'
        label:
          type: string
        description:
          type: string
        order:
          type: integer
          description: "Order value for ordinal contexts"
    description: "Valid values for this context"
  
  comparison_support:
    type: boolean
    default: false
    description: "Whether this context supports comparison operators"
  
  metadata:
    type: object
    properties:
      category:
        type: string
        enum: [marketing, technical, geographic, temporal, behavioral]
      created_at:
        type: string
        format: date-time
      version:
        type: string
```

#### 4.2 Parameter Schema Extensions

Add to existing `parameter-schema.yaml`:

```yaml
properties:
  # ... existing properties ...
  
  edge_reference:
    type: string
    pattern: '^e\.[a-z0-9-]+(\.(visited|context)\([^)]+\))*(\.p\.(mean|stdev))$'
    description: "Canonical edge reference (e.g., e.signup.context(channel='google').p.mean)"
  
  context_filter:
    type: object
    description: "Context variable filters for this parameter"
    patternProperties:
      '^[a-z_][a-z0-9_]*$':  # Context ID
        type: string          # Context value
    additionalProperties: false
    examples:
      - channel: google
        device: mobile
      - utm_source: newsletter
  
  visited_filter:
    type: array
    items:
      type: string
      pattern: '^[a-z0-9-]+$'
    description: "Node slugs that must be visited for this parameter to apply"
    examples:
      - [landing-page, pricing]
```

---

### 5. TypeScript Type Extensions

**File:** `graph-editor/src/lib/types.ts`

Add new types:

```typescript
// Context definition
export interface ContextDefinition {
  id: string;
  name: string;
  description?: string;
  type: 'categorical' | 'ordinal' | 'continuous';
  values: ContextValue[];
  comparison_support?: boolean;
  metadata?: {
    category?: 'marketing' | 'technical' | 'geographic' | 'temporal' | 'behavioral';
    created_at?: string;
    version?: string;
  };
}

export interface ContextValue {
  id: string;
  label: string;
  description?: string;
  order?: number;  // For ordinal contexts
}

// Context filter in parameters
export interface ContextFilter {
  [contextId: string]: string;  // e.g., { channel: 'google', device: 'mobile' }
}

// Extended parameter definition
export interface Parameter {
  id: string;
  name: string;
  type: 'probability' | 'monetary_cost' | 'time_cost' | 'standard_deviation';
  value: number | ParameterValue;
  
  // New context fields
  edge_reference?: string;
  context_filter?: ContextFilter;
  visited_filter?: string[];
  
  metadata: ParameterMetadata;
}

// Active context selection (UI state)
export interface ActiveContexts {
  [contextId: string]: string[];  // e.g., { channel: ['google', 'facebook'], device: ['mobile'] }
}
```

---

### 6. Reference Parser Extensions

**File:** `graph-editor/src/lib/conditionalReferences.ts`

Extend existing functions:

```typescript
export interface ConditionalReference {
  edgeSlug: string;
  visitedNodes: string[];      // Existing
  contextFilters: ContextFilter; // NEW
  paramType: 'mean' | 'stdev';
}

/**
 * Parse conditional reference with context support
 * 
 * Examples:
 *   e.signup.p.mean
 *   e.signup.context(channel='google').p.mean
 *   e.signup.visited(landing).context(channel='google',device='mobile').p.mean
 */
export function parseConditionalReference(ref: string): ConditionalReference | null {
  // Regex: e.<slug>(.visited(<nodes>))?(.context(<filters>))?.p.(mean|stdev)
  const pattern = /^e\.([a-z0-9-]+)(?:\.visited\(([^)]+)\))?(?:\.context\(([^)]+)\))?\.p\.(mean|stdev)$/;
  const match = ref.match(pattern);
  
  if (!match) return null;
  
  const [, edgeSlug, visitedStr, contextStr, paramType] = match;
  
  // Parse visited nodes
  const visitedNodes = visitedStr
    ? visitedStr.split(',').map(s => s.trim()).sort()
    : [];
  
  // Parse context filters
  const contextFilters: ContextFilter = {};
  if (contextStr) {
    const pairs = contextStr.split(',');
    for (const pair of pairs) {
      const [key, value] = pair.split('=').map(s => s.trim().replace(/^'|'$/g, ''));
      contextFilters[key] = value;
    }
  }
  
  return {
    edgeSlug,
    visitedNodes,
    contextFilters,
    paramType: paramType as 'mean' | 'stdev',
  };
}

/**
 * Generate canonical reference string
 */
export function generateConditionalReference(
  edgeSlug: string,
  visitedNodes: string[],
  contextFilters: ContextFilter,
  paramType: 'mean' | 'stdev'
): string {
  let ref = `e.${edgeSlug}`;
  
  // Add visited (sorted)
  if (visitedNodes.length > 0) {
    const sorted = [...visitedNodes].sort();
    ref += `.visited(${sorted.join(',')})`;
  }
  
  // Add context (sorted by key)
  const contextKeys = Object.keys(contextFilters).sort();
  if (contextKeys.length > 0) {
    const pairs = contextKeys.map(k => `${k}='${contextFilters[k]}'`);
    ref += `.context(${pairs.join(',')})`;
  }
  
  ref += `.p.${paramType}`;
  return ref;
}

/**
 * Check if a parameter matches active contexts
 */
export function matchesActiveContexts(
  paramFilter: ContextFilter,
  activeContexts: ActiveContexts
): boolean {
  for (const [contextId, contextValue] of Object.entries(paramFilter)) {
    const activeValues = activeContexts[contextId];
    if (!activeValues || activeValues.length === 0) {
      // No filter active for this context - matches all
      continue;
    }
    if (!activeValues.includes(contextValue)) {
      // Parameter's context value not in active selection
      return false;
    }
  }
  return true;
}
```

---

### 7. Parameter Resolution Logic

When resolving parameters for an edge, we now have a fallback hierarchy:

```typescript
/**
 * Resolve parameter for an edge given current graph state and context filters
 * 
 * Fallback order:
 * 1. Exact match: visited + context
 * 2. Context-only match: context (no visited requirement)
 * 3. Visited-only match: visited (no context requirement)
 * 4. Base parameter: no visited, no context
 */
export function resolveEdgeParameter(
  edgeSlug: string,
  visitedNodes: string[],
  activeContexts: ActiveContexts,
  paramType: 'mean' | 'stdev',
  parameters: Parameter[]
): number | null {
  
  // Filter parameters for this edge and param type
  const candidates = parameters.filter(p => 
    p.edge_reference?.includes(`e.${edgeSlug}`) &&
    p.edge_reference?.includes(`.p.${paramType}`)
  );
  
  // 1. Try exact match (visited + context)
  for (const param of candidates) {
    if (param.visited_filter && param.visited_filter.length > 0 &&
        param.context_filter && Object.keys(param.context_filter).length > 0) {
      
      const visitedMatch = arraysEqual(param.visited_filter.sort(), visitedNodes.sort());
      const contextMatch = matchesActiveContexts(param.context_filter, activeContexts);
      
      if (visitedMatch && contextMatch) {
        return extractValue(param, paramType);
      }
    }
  }
  
  // 2. Try context-only match
  for (const param of candidates) {
    if ((!param.visited_filter || param.visited_filter.length === 0) &&
        param.context_filter && Object.keys(param.context_filter).length > 0) {
      
      if (matchesActiveContexts(param.context_filter, activeContexts)) {
        return extractValue(param, paramType);
      }
    }
  }
  
  // 3. Try visited-only match
  for (const param of candidates) {
    if (param.visited_filter && param.visited_filter.length > 0 &&
        (!param.context_filter || Object.keys(param.context_filter).length === 0)) {
      
      if (arraysEqual(param.visited_filter.sort(), visitedNodes.sort())) {
        return extractValue(param, paramType);
      }
    }
  }
  
  // 4. Try base parameter
  for (const param of candidates) {
    if ((!param.visited_filter || param.visited_filter.length === 0) &&
        (!param.context_filter || Object.keys(param.context_filter).length === 0)) {
      return extractValue(param, paramType);
    }
  }
  
  return null; // No matching parameter found
}
```

---

### 8. UI Implementation

#### 8.1 What-If Panel: Context Selector

**Location:** New component `graph-editor/src/components/ContextSelector.tsx`

```typescript
import React from 'react';
import { ContextDefinition, ActiveContexts } from '../lib/types';

interface ContextSelectorProps {
  contexts: ContextDefinition[];
  activeContexts: ActiveContexts;
  onChange: (contexts: ActiveContexts) => void;
}

export const ContextSelector: React.FC<ContextSelectorProps> = ({
  contexts,
  activeContexts,
  onChange,
}) => {
  
  const toggleContextValue = (contextId: string, valueId: string) => {
    const current = activeContexts[contextId] || [];
    const updated = current.includes(valueId)
      ? current.filter(v => v !== valueId)
      : [...current, valueId];
    
    onChange({
      ...activeContexts,
      [contextId]: updated,
    });
  };
  
  const selectAll = (contextId: string) => {
    const context = contexts.find(c => c.id === contextId);
    if (!context) return;
    
    onChange({
      ...activeContexts,
      [contextId]: context.values.map(v => v.id),
    });
  };
  
  const selectNone = (contextId: string) => {
    onChange({
      ...activeContexts,
      [contextId]: [],
    });
  };
  
  return (
    <div className="context-selector">
      <h3>Context Filters</h3>
      <p className="help-text">
        Select which context values to include in what-if analysis
      </p>
      
      {contexts.map(context => (
        <div key={context.id} className="context-group">
          <div className="context-header">
            <h4>{context.name}</h4>
            <div className="context-actions">
              <button onClick={() => selectAll(context.id)}>All</button>
              <button onClick={() => selectNone(context.id)}>None</button>
            </div>
          </div>
          
          {context.description && (
            <p className="context-description">{context.description}</p>
          )}
          
          <div className="context-values">
            {context.values.map(value => {
              const isActive = (activeContexts[context.id] || []).includes(value.id);
              
              return (
                <label key={value.id} className="context-value">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={() => toggleContextValue(context.id, value.id)}
                  />
                  <span className="value-label">{value.label}</span>
                  {value.description && (
                    <span className="value-description">{value.description}</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
```

#### 8.2 Integration into Graph Editor

**Location:** `graph-editor/src/components/GraphEditor.tsx` (or main component)

Add state management:

```typescript
const [contexts, setContexts] = useState<ContextDefinition[]>([]);
const [activeContexts, setActiveContexts] = useState<ActiveContexts>({});

// Load contexts from registry
useEffect(() => {
  loadContexts().then(setContexts);
}, []);

// Initialize with all contexts active
useEffect(() => {
  const initial: ActiveContexts = {};
  contexts.forEach(context => {
    initial[context.id] = context.values.map(v => v.id);
  });
  setActiveContexts(initial);
}, [contexts]);

// Recalculate graph when contexts change
useEffect(() => {
  if (Object.keys(activeContexts).length > 0) {
    recalculateGraphWithContexts(activeContexts);
  }
}, [activeContexts]);
```

#### 8.3 Edge Properties Panel: Context Display

When editing an edge, show which context-specific parameters exist:

```typescript
// In edge properties panel
<div className="context-parameters">
  <h4>Context-Specific Parameters</h4>
  <p>This edge has parameters for:</p>
  <ul>
    {contextAwareParams.map(param => (
      <li key={param.id}>
        {formatContextFilter(param.context_filter)} - {param.value.mean}
        <button onClick={() => editParameter(param.id)}>Edit</button>
      </li>
    ))}
  </ul>
  <button onClick={() => createContextParameter(edge)}>
    Add Context Parameter
  </button>
</div>
```

---

### 9. Registry Loader Extensions

**File:** `graph-editor/src/lib/parameterRegistry.ts` (to be created)

Add context loading:

```typescript
/**
 * Load all context definitions from registry
 */
export async function loadContexts(): Promise<ContextDefinition[]> {
  // Load from param-registry/contexts.yaml
  const response = await fetch('/param-registry/contexts.yaml');
  const yaml = await response.text();
  const data = parseYAML(yaml);
  return data.contexts;
}

/**
 * Load parameters filtered by context
 */
export async function loadParametersForContexts(
  activeContexts: ActiveContexts
): Promise<Parameter[]> {
  const allParams = await loadAllParameters();
  
  return allParams.filter(param => {
    if (!param.context_filter) return true; // Base parameters always included
    return matchesActiveContexts(param.context_filter, activeContexts);
  });
}

/**
 * Get all unique context combinations used in parameters
 */
export async function getUsedContextCombinations(): Promise<ContextFilter[]> {
  const allParams = await loadAllParameters();
  
  const combinations = new Set<string>();
  allParams.forEach(param => {
    if (param.context_filter) {
      combinations.add(JSON.stringify(param.context_filter));
    }
  });
  
  return Array.from(combinations).map(s => JSON.parse(s));
}
```

---

### 10. Example Use Cases

#### Use Case 1: Channel-Specific Conversion Rates

**Scenario:** Google Ads converts at 35%, Facebook at 28%, Organic at 42%

**Parameters:**
- `param-registry/parameters/probability/signup-google.yaml`
- `param-registry/parameters/probability/signup-facebook.yaml`
- `param-registry/parameters/probability/signup-organic.yaml`

Each with `context_filter: { channel: google/facebook/organic }`

**What-If Analysis:**
1. User checks "Google" and "Facebook" in channel filter
2. Graph recalculates using only those two parameters
3. Can compare expected conversion with/without organic traffic

#### Use Case 2: Mobile vs Desktop Checkout

**Scenario:** Mobile users have 40% checkout rate, desktop 55%

**Parameters:**
- `checkout-mobile.yaml` with `context_filter: { device: mobile }`
- `checkout-desktop.yaml` with `context_filter: { device: desktop }`

**Analysis:**
- Toggle device filters to see impact
- Combined with channel context: "Google mobile" vs "Facebook desktop"

#### Use Case 3: Returning User Behavior

**Scenario:** Google users who visited pricing page convert at 45%

**Parameter:**
```yaml
id: checkout-returning-google
edge_reference: e.checkout.visited(pricing).context(channel='google').p.mean
visited_filter: [pricing]
context_filter:
  channel: google
value:
  mean: 0.45
```

---

### 11. Migration Path

#### Phase 1: Context Infrastructure (Week 1)
1. Create `contexts.yaml` with initial definitions
2. Extend parameter schema
3. Update TypeScript types
4. Extend reference parser

#### Phase 2: Registry Integration (Week 1-2)
5. Update parameter loader to handle contexts
6. Implement resolution logic with fallback hierarchy
7. Create example context-aware parameters
8. Test end-to-end loading and resolution

#### Phase 3: UI Components (Week 2-3)
9. Build `ContextSelector` component
10. Integrate into what-if panel
11. Add context display to edge properties
12. Implement "create from edge" workflow

#### Phase 4: Advanced Features (Week 3-4)
13. Context combination suggestions
14. Usage analytics (which contexts are most impactful)
15. Parameter gap detection (missing context combinations)
16. Bulk parameter generation tools

---

### 12. Open Questions & Decisions Needed

#### Q1: Context Combinations Explosion
**Problem:** With 4 channels × 3 devices × 4 time periods = 48 combinations

**Options:**
A. Create parameters for all combinations (comprehensive but verbose)
B. Use fallback hierarchy (create only important combinations)
C. Support wildcard matching (e.g., `device='*'` matches all devices)

**Recommendation:** Start with **Option B** (fallback hierarchy), add wildcards later if needed

#### Q2: Context in Case Parameters
**Question:** Should case parameters also support contexts?

**Example:**
```yaml
# Case with context-specific variants
id: ab-test-signup-button-mobile
type: case
context_filter:
  device: mobile
case:
  variants: [blue, green, red]
  weights: [0.5, 0.3, 0.2]
```

**Recommendation:** Yes, extend case parameters to support contexts for device-specific A/B tests

#### Q3: Dynamic Context Values
**Question:** Should context values be extensible at runtime (e.g., new UTM sources)?

**Options:**
A. Strictly validate against `contexts.yaml` (safer)
B. Allow dynamic values (flexible but risky)
C. Hybrid: warn on unknown values but allow

**Recommendation:** **Option A** for now (strict validation), add dynamic later if needed

#### Q4: Context Hierarchies
**Question:** Should contexts support hierarchies (e.g., device > mobile > ios)?

**Example:**
```yaml
- id: device
  values:
    - id: mobile
      children:
        - id: ios
        - id: android
    - id: desktop
```

**Recommendation:** **Not in v1** - adds complexity, can add later if use cases emerge

---

### 13. Success Criteria

#### Minimum Viable Product (MVP)
- ✅ Can define contexts in `contexts.yaml`
- ✅ Parameters can specify `context_filter`
- ✅ Reference notation supports `.context()` syntax
- ✅ UI shows context checkboxes in what-if panel
- ✅ Graph recalculates when contexts change
- ✅ Fallback hierarchy works (context > base)

#### Full Feature Set
- ✅ All MVP features
- ✅ Combined visited + context parameters work
- ✅ Can create context parameters from edge properties
- ✅ Context coverage analysis ("which combinations are missing?")
- ✅ Case parameters support contexts
- ✅ Documentation and examples complete

---

## Summary

This design extends the parameter registry with context support through:

1. **Chainable reference notation**: `e.signup.visited(node).context(channel='google').p.mean`
2. **Centralized context definitions**: `param-registry/contexts.yaml`
3. **Context filters in parameters**: `context_filter: { channel: google, device: mobile }`
4. **Fallback resolution hierarchy**: exact → context → visited → base
5. **UI context selector**: Checkbox-based filtering in what-if panel
6. **Schema extensions**: New fields for `context_filter`, `visited_filter`, `edge_reference`

This approach maintains backward compatibility (no context = base parameter) while enabling powerful context-aware modeling.

**Next steps:** Review and approve design, then proceed with Phase 1 implementation.



