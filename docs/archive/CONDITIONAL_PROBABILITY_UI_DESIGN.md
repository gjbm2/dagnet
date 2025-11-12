# Conditional Probability UI with Context Support

**Purpose:** Design UI for creating conditional probabilities with both visited nodes and context filters

---

## Current State (Without Contexts)

**Existing UI** allows specifying conditional probabilities based on visited nodes:

```
┌─ Conditional Probabilities ──────────────────┐
│                                               │
│ If user has visited certain nodes, this edge │
│ can have different probability values.        │
│                                               │
│ [Add Conditional Probability]                 │
│                                               │
│ ┌─ Condition 1 ────────────────────────────┐ │
│ │ Visited Nodes: landing-page, pricing     │ │
│ │                                           │ │
│ │ Probability:                              │ │
│ │   Mean:  [0.45] ± [0.05]                 │ │
│ │                                           │ │
│ │ [Edit] [Remove]                           │ │
│ └───────────────────────────────────────────┘ │
└───────────────────────────────────────────────┘
```

---

## Enhanced UI (With Context Support)

### Approach A: Combined Selector (RECOMMENDED)

**Single interface for both visited nodes and contexts:**

```
┌─ Conditional Probabilities ────────────────────────────────────────┐
│                                                                     │
│ Edge probability can vary based on:                                │
│ • Which nodes the user has visited                                 │
│ • External context (channel, device, etc.)                         │
│                                                                     │
│ [Add Conditional Probability]                                       │
│                                                                     │
│ ┌─ Condition 1 ─────────────────────────────────────────────────┐ │
│ │                                                                │ │
│ │ ▼ Visited Nodes (optional)                                     │ │
│ │   ☑ landing-page                                               │ │
│ │   ☑ pricing                                                    │ │
│ │   ☐ product-details                                            │ │
│ │   ☐ checkout                                                   │ │
│ │                                                                │ │
│ │ ▼ Context Filters (optional)                                   │ │
│ │   Channel:        [Google Ads      ▼] [×]                     │ │
│ │   Device:         [Mobile          ▼] [×]                     │ │
│ │   [+ Add Context Filter]                                       │ │
│ │                                                                │ │
│ │ Probability:                                                   │ │
│ │   Mean:  [0.45] ± [0.05]                                      │ │
│ │   [Lock]                                                       │ │
│ │                                                                │ │
│ │ Parameter Link: signup-google-mobile-returning                 │ │
│ │ [Link to Registry] [Create & Link]                            │ │
│ │                                                                │ │
│ │ [Save] [Remove]                                                │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ Condition 2 ─────────────────────────────────────────────────┐ │
│ │ ▼ Visited Nodes: None                                          │ │
│ │ ▼ Context Filters                                              │ │
│ │   Channel: Facebook Ads                                        │ │
│ │                                                                │ │
│ │ Probability: 28% ± 5%                                          │ │
│ │ Parameter: signup-facebook (from registry)                     │ │
│ │ [Edit] [Remove]                                                │ │
│ └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- ✅ Both visited nodes and context in same condition
- ✅ Either or both can be specified
- ✅ Visual grouping makes relationship clear
- ✅ Can link to registry parameter

---

### Approach B: Separate Tabs

```
┌─ Conditional Probabilities ────────────────────┐
│                                                 │
│ [Visited Based] [Context Based] [Combined]     │
│                                                 │
│ ┌─ Visited-Based Conditions ──────────────┐    │
│ │ • landing + pricing → 45%               │    │
│ │ • checkout → 55%                        │    │
│ └─────────────────────────────────────────┘    │
│                                                 │
│ ┌─ Context-Based Conditions ──────────────┐    │
│ │ • channel=google → 35%                  │    │
│ │ • channel=facebook → 28%                │    │
│ └─────────────────────────────────────────┘    │
│                                                 │
│ ┌─ Combined Conditions ────────────────────┐   │
│ │ • visited(pricing) + google → 45%       │   │
│ └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

**Issues:**
- ❌ Less intuitive (why separate?)
- ❌ Doesn't reflect fallback hierarchy well
- ❌ More complex to manage

**Recommendation:** Use Approach A (combined)

---

## Detailed Component Design

### 1. Add Conditional Probability Dialog

**Triggered by:** "Add Conditional Probability" button

```
┌─ Add Conditional Probability ─────────────────────────────────────┐
│                                                                    │
│ Configure when this edge probability should differ from base      │
│                                                                    │
│ ┌─ Conditions ───────────────────────────────────────────────┐    │
│ │                                                             │    │
│ │ This probability applies when:                              │    │
│ │                                                             │    │
│ │ ☐ User has visited specific nodes                          │    │
│ │   └─ [Select Nodes...]                                     │    │
│ │                                                             │    │
│ │ ☐ Context matches filters                                  │    │
│ │   └─ [Add Context Filters...]                              │    │
│ │                                                             │    │
│ │ Note: You can use both, either, or neither (base)          │    │
│ └─────────────────────────────────────────────────────────────┘    │
│                                                                    │
│ ┌─ Probability Value ───────────────────────────────────────┐     │
│ │                                                            │     │
│ │ ⦿ Enter manually                                          │     │
│ │   Mean:  [0.35]  StDev: [0.05]                           │     │
│ │                                                            │     │
│ │ ○ Link to registry parameter                              │     │
│ │   [Browse Parameters...]                                   │     │
│ │                                                            │     │
│ └────────────────────────────────────────────────────────────┘     │
│                                                                    │
│ [Cancel]  [Add Condition]                                          │
└────────────────────────────────────────────────────────────────────┘
```

---

### 2. Visited Nodes Selector (Multi-Select)

**When "Select Nodes..." clicked:**

```
┌─ Select Visited Nodes ────────────────────────┐
│                                                │
│ Select nodes that must be visited for this    │
│ conditional probability to apply.              │
│                                                │
│ ┌─ Available Nodes ────────────────────────┐  │
│ │                                          │  │
│ │ Search: [_______]  🔍                   │  │
│ │                                          │  │
│ │ ☑ landing-page                           │  │
│ │   Landing Page                           │  │
│ │                                          │  │
│ │ ☑ pricing                                │  │
│ │   Pricing Page                           │  │
│ │                                          │  │
│ │ ☐ product-details                        │  │
│ │   Product Details                        │  │
│ │                                          │  │
│ │ ☐ checkout                               │  │
│ │   Checkout Flow                          │  │
│ │                                          │  │
│ │ ☐ confirmation                           │  │
│ │   Order Confirmation                     │  │
│ │                                          │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Selected: landing-page, pricing                │
│                                                │
│ [Clear All] [Select All]                       │
│                                                │
│ [Cancel]  [Apply Selection]                    │
└────────────────────────────────────────────────┘
```

**Features:**
- ✅ Checkbox list of all nodes in graph
- ✅ Shows node slug and label
- ✅ Search/filter
- ✅ Select all / clear all
- ✅ Shows current selection

---

### 3. Context Filters Selector

**When "Add Context Filters..." clicked:**

```
┌─ Add Context Filters ─────────────────────────┐
│                                                │
│ Filter by external context variables          │
│                                                │
│ ┌─ Active Filters ──────────────────────────┐ │
│ │                                            │ │
│ │ Channel:  [Google Ads      ▼]  [Remove]  │ │
│ │ Device:   [Mobile          ▼]  [Remove]  │ │
│ │                                            │ │
│ └────────────────────────────────────────────┘ │
│                                                │
│ ┌─ Add Filter ──────────────────────────────┐ │
│ │                                            │ │
│ │ Context:  [Select context... ▼]           │ │
│ │           • channel                        │ │
│ │           • device                         │ │
│ │           • utm_source                     │ │
│ │           • browser                        │ │
│ │                                            │ │
│ │ Value:    [Select value...   ▼]           │ │
│ │           (appears after context selected) │ │
│ │                                            │ │
│ │ [Add Filter]                               │ │
│ └────────────────────────────────────────────┘ │
│                                                │
│ This will create reference:                   │
│ e.signup.context(channel='google',device='mob │
│                                                │
│ [Cancel]  [Apply Filters]                      │
└────────────────────────────────────────────────┘
```

**Features:**
- ✅ List current filters
- ✅ Add new filter (context + value)
- ✅ Context dropdown populated from registry
- ✅ Value dropdown populated from selected context's values
- ✅ Shows preview of resulting reference
- ✅ Can remove filters

---

### 4. Link to Registry Parameter

**When "Link to Registry" clicked:**

```
┌─ Link to Registry Parameter ──────────────────────────────────────┐
│                                                                    │
│ Browse parameters matching your conditions                        │
│                                                                    │
│ Current Conditions:                                                │
│ • Visited: landing-page, pricing                                  │
│ • Context: channel=google, device=mobile                          │
│                                                                    │
│ ┌─ Matching Parameters ─────────────────────────────────────────┐ │
│ │                                                                │ │
│ │ ⦿ signup-google-mobile-returning (exact match)                │ │
│ │   35% ± 4% | Updated: 2025-10-15                             │ │
│ │   ✓ Visited: [landing-page, pricing]                         │ │
│ │   ✓ Context: channel=google, device=mobile                   │ │
│ │                                                                │ │
│ │ ○ signup-google-mobile (context only)                         │ │
│ │   32% ± 6% | Updated: 2025-10-10                             │ │
│ │   ✓ Context: channel=google, device=mobile                   │ │
│ │                                                                │ │
│ │ ○ signup-google (partial match)                               │ │
│ │   35% ± 5% | Updated: 2025-10-08                             │ │
│ │   ✓ Context: channel=google                                  │ │
│ │                                                                │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│ Filter: [All] [Exact Matches Only] [Show Deprecated]              │
│                                                                    │
│ Can't find a match?                                                │
│ [Create New Parameter from Conditions]                             │
│                                                                    │
│ [Cancel]  [Link Selected Parameter]                                │
└────────────────────────────────────────────────────────────────────┘
```

**Features:**
- ✅ Shows parameters matching conditions (exact first)
- ✅ Highlights which conditions match
- ✅ Shows parameter metadata
- ✅ Can create new parameter if none match
- ✅ Smart sorting (exact matches first)

---

## TypeScript Component Structure

### Main Component

```typescript
interface ConditionalProbabilityEditorProps {
  edge: EdgeData;
  availableNodes: NodeData[];
  contexts: ContextDefinition[];
  onUpdate: (edge: EdgeData) => void;
}

export const ConditionalProbabilityEditor: React.FC<ConditionalProbabilityEditorProps> = ({
  edge,
  availableNodes,
  contexts,
  onUpdate,
}) => {
  const [editingCondition, setEditingCondition] = useState<ConditionalProbability | null>(null);
  
  return (
    <div className="conditional-probability-editor">
      <h4>Conditional Probabilities</h4>
      <p>Edge probability can vary based on visited nodes and external context.</p>
      
      {/* List existing conditions */}
      {edge.conditional_p?.map((condition, idx) => (
        <ConditionalProbabilityCard
          key={idx}
          condition={condition}
          onEdit={() => setEditingCondition(condition)}
          onRemove={() => removeCondition(idx)}
        />
      ))}
      
      {/* Add new condition */}
      <button onClick={() => setEditingCondition({})}>
        Add Conditional Probability
      </button>
      
      {/* Edit dialog */}
      {editingCondition && (
        <ConditionalProbabilityDialog
          condition={editingCondition}
          availableNodes={availableNodes}
          contexts={contexts}
          onSave={(updated) => saveCondition(updated)}
          onCancel={() => setEditingCondition(null)}
        />
      )}
    </div>
  );
};
```

### Condition Card

```typescript
interface ConditionalProbabilityCardProps {
  condition: ConditionalProbability;
  onEdit: () => void;
  onRemove: () => void;
}

export const ConditionalProbabilityCard: React.FC<ConditionalProbabilityCardProps> = ({
  condition,
  onEdit,
  onRemove,
}) => {
  return (
    <div className="condition-card">
      {/* Visited nodes section */}
      {condition.visited_nodes && condition.visited_nodes.length > 0 && (
        <div className="visited-nodes">
          <strong>Visited:</strong> {condition.visited_nodes.join(', ')}
        </div>
      )}
      
      {/* Context filters section */}
      {condition.context_filter && Object.keys(condition.context_filter).length > 0 && (
        <div className="context-filters">
          <strong>Context:</strong>{' '}
          {Object.entries(condition.context_filter).map(([key, val]) => 
            `${key}=${val}`
          ).join(', ')}
        </div>
      )}
      
      {/* Probability value */}
      <div className="probability">
        <strong>Probability:</strong> {condition.p.mean} ± {condition.p.stdev}
      </div>
      
      {/* Parameter source */}
      {condition.p.parameter_id && (
        <div className="parameter-source">
          <strong>From:</strong> {condition.p.parameter_id}
        </div>
      )}
      
      {/* Actions */}
      <div className="actions">
        <button onClick={onEdit}>Edit</button>
        <button onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
};
```

### Edit Dialog

```typescript
interface ConditionalProbabilityDialogProps {
  condition: Partial<ConditionalProbability>;
  availableNodes: NodeData[];
  contexts: ContextDefinition[];
  onSave: (condition: ConditionalProbability) => void;
  onCancel: () => void;
}

export const ConditionalProbabilityDialog: React.FC<ConditionalProbabilityDialogProps> = ({
  condition,
  availableNodes,
  contexts,
  onSave,
  onCancel,
}) => {
  const [visitedNodes, setVisitedNodes] = useState<string[]>(condition.visited_nodes || []);
  const [contextFilter, setContextFilter] = useState<ContextFilter>(condition.context_filter || {});
  const [mean, setMean] = useState(condition.p?.mean || 0.5);
  const [stdev, setStdev] = useState(condition.p?.stdev || 0.05);
  const [useRegistry, setUseRegistry] = useState(false);
  const [selectedParameterId, setSelectedParameterId] = useState<string | null>(null);
  
  const handleSave = () => {
    const updated: ConditionalProbability = {
      visited_nodes: visitedNodes.length > 0 ? visitedNodes : undefined,
      context_filter: Object.keys(contextFilter).length > 0 ? contextFilter : undefined,
      p: {
        mean,
        stdev,
        parameter_id: selectedParameterId || undefined,
      },
    };
    onSave(updated);
  };
  
  return (
    <Modal onClose={onCancel}>
      <h3>Add Conditional Probability</h3>
      
      {/* Visited nodes selector */}
      <section>
        <h4>Visited Nodes (optional)</h4>
        <VisitedNodesSelector
          availableNodes={availableNodes}
          selectedNodes={visitedNodes}
          onChange={setVisitedNodes}
        />
      </section>
      
      {/* Context filter selector */}
      <section>
        <h4>Context Filters (optional)</h4>
        <ContextFilterSelector
          contexts={contexts}
          filters={contextFilter}
          onChange={setContextFilter}
        />
      </section>
      
      {/* Value input */}
      <section>
        <h4>Probability Value</h4>
        <label>
          <input
            type="radio"
            checked={!useRegistry}
            onChange={() => setUseRegistry(false)}
          />
          Enter manually
        </label>
        {!useRegistry && (
          <div>
            <label>
              Mean: <input type="number" value={mean} onChange={e => setMean(+e.target.value)} />
            </label>
            <label>
              StDev: <input type="number" value={stdev} onChange={e => setStdev(+e.target.value)} />
            </label>
          </div>
        )}
        
        <label>
          <input
            type="radio"
            checked={useRegistry}
            onChange={() => setUseRegistry(true)}
          />
          Link to registry parameter
        </label>
        {useRegistry && (
          <ParameterBrowser
            visitedFilter={visitedNodes}
            contextFilter={contextFilter}
            onSelect={setSelectedParameterId}
          />
        )}
      </section>
      
      {/* Actions */}
      <div className="dialog-actions">
        <button onClick={onCancel}>Cancel</button>
        <button onClick={handleSave}>Add Condition</button>
      </div>
    </Modal>
  );
};
```

---

## Data Structure Updates

### Edge Type Extension

```typescript
interface ConditionalProbability {
  // Structural condition (which nodes visited)
  visited_nodes?: string[];  // Node slugs
  
  // External condition (context filters)
  context_filter?: ContextFilter;  // e.g., { channel: 'google', device: 'mobile' }
  
  // The probability when conditions match
  p: {
    mean?: number;
    stdev?: number;
    parameter_id?: string;  // Link to registry
    locked?: boolean;
  };
}

interface EdgeData {
  // ... existing fields ...
  
  // Base probability (no conditions)
  p: {
    mean?: number;
    stdev?: number;
    parameter_id?: string;
    locked?: boolean;
  };
  
  // Conditional probabilities (NEW: supports context)
  conditional_p?: ConditionalProbability[];
}
```

---

## Resolution Logic with Context

```typescript
/**
 * Resolve probability for edge given current state
 */
function resolveEdgeProbability(
  edge: EdgeData,
  visitedNodes: string[],
  activeContexts: ActiveContexts
): { mean: number; stdev: number; source: string } {
  
  // Try conditional probabilities first (most specific to least)
  if (edge.conditional_p) {
    for (const condition of sortBySpecificity(edge.conditional_p)) {
      // Check if condition matches current state
      const visitedMatch = !condition.visited_nodes || 
        arraysEqual(condition.visited_nodes.sort(), visitedNodes.sort());
      
      const contextMatch = !condition.context_filter || 
        matchesActiveContexts(condition.context_filter, activeContexts);
      
      if (visitedMatch && contextMatch) {
        // Resolve parameter if linked to registry
        if (condition.p.parameter_id) {
          const param = loadParameter(condition.p.parameter_id);
          return {
            mean: param.value.mean,
            stdev: param.value.stdev,
            source: `conditional (${condition.p.parameter_id})`,
          };
        }
        
        // Use inline values
        return {
          mean: condition.p.mean!,
          stdev: condition.p.stdev!,
          source: 'conditional (inline)',
        };
      }
    }
  }
  
  // Fall back to base probability
  if (edge.p.parameter_id) {
    const param = loadParameter(edge.p.parameter_id);
    return {
      mean: param.value.mean,
      stdev: param.value.stdev,
      source: `base (${edge.p.parameter_id})`,
    };
  }
  
  return {
    mean: edge.p.mean!,
    stdev: edge.p.stdev!,
    source: 'base (inline)',
  };
}

function sortBySpecificity(conditions: ConditionalProbability[]): ConditionalProbability[] {
  return [...conditions].sort((a, b) => {
    const aScore = (a.visited_nodes?.length || 0) + Object.keys(a.context_filter || {}).length;
    const bScore = (b.visited_nodes?.length || 0) + Object.keys(b.context_filter || {}).length;
    return bScore - aScore; // Most specific first
  });
}
```

---

## Summary

### UI Enhancements Needed

1. **ConditionalProbabilityEditor** (extend existing)
   - Add context filter section
   - Support both visited + context

2. **VisitedNodesSelector** (exists, may need polish)
   - Multi-select checkbox list
   - Search/filter

3. **ContextFilterSelector** (NEW)
   - Add/remove context filters
   - Context dropdown from registry
   - Value dropdown from context definition

4. **ParameterBrowser** (NEW)
   - Browse registry parameters
   - Filter by conditions
   - Show matching parameters

5. **ConditionalProbabilityCard** (extend existing)
   - Show both visited and context
   - Show parameter source

### Data Model Extensions

- ✅ `ConditionalProbability` supports `context_filter`
- ✅ `EdgeData` remains backward compatible
- ✅ Resolution logic handles both visited and context

### Implementation Priority

1. **Phase 3** (Week 3) - Build UI components
2. **Phase 4** (Week 4) - Integrate with parameter browser

This design maintains backward compatibility while enabling powerful context-aware conditional probabilities!



