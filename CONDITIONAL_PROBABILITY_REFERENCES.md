# Conditional Probability Parameter References

## Overview

This document defines the **stable, unambiguous reference system** for conditional probability parameters in the graph. This enables:
- External parameter management systems
- Runner logic that evaluates conditional probabilities
- Integration with optimization/fitting tools
- Human-readable parameter identification

## Reference Format

### Base Probability (No Condition)
```
e.<edge-slug>.p.mean
e.<edge-slug>.p.stdev
```

**Example:**
```
e.gives-bd-to-stops-switch.p.mean = 0.5
e.gives-bd-to-stops-switch.p.stdev = 0.05
```

### Conditional Probability (Single Node)
```
e.<edge-slug>.visited(<node-slug>).p.mean
e.<edge-slug>.visited(<node-slug>).p.stdev
```

**Example:**
```
e.gives-bd-to-stops-switch.visited(coffee_promotion).p.mean = 0.8
e.gives-bd-to-stops-switch.visited(coffee_promotion).p.stdev = 0.03
```

### Conditional Probability (Multiple Nodes)
```
e.<edge-slug>.visited(<node-slug-1>,<node-slug-2>,...).p.mean
e.<edge-slug>.visited(<node-slug-1>,<node-slug-2>,...).p.stdev
```

**Important:** Node slugs are **alphabetically sorted** for determinism:
- `visited(B,A)` → normalizes to → `visited(A,B)`
- `visited(coffee_promotion,email_promo)` ✓
- `visited(email_promo,coffee_promotion)` → same as above

**Example:**
```
e.checkout.visited(coffee_promotion,saw_banner).p.mean = 0.9
```

## Key Design Principles

### 1. **Immutability**
- **Slugs must be immutable** once assigned
- Slugs uniquely identify nodes/edges throughout their lifetime
- IDs are used internally but slugs are the external interface

### 2. **Uniqueness**
- All node slugs must be unique within a graph
- All edge slugs must be unique within a graph
- Use `validateSlugUniqueness()` to check

### 3. **Human Readability**
- Uses slugs (e.g., `coffee_promotion`) not IDs (e.g., `0da63279-...`)
- Readable by analysts and stakeholders
- Can be used in external spreadsheets/configs

### 4. **Determinism**
- `visited(A,B)` always equals `visited(B,A)` (alphabetically sorted)
- Same condition → same reference → same parameter
- Critical for parameter management systems

## API Usage

### Generate References

```typescript
import { generateConditionalReference } from '@/lib/conditionalReferences';

// Base probability
const ref1 = generateConditionalReference('gives-bd', [], 'mean');
// → "e.gives-bd.p.mean"

// Single-node condition
const ref2 = generateConditionalReference('gives-bd', ['coffee_promotion'], 'mean');
// → "e.gives-bd.visited(coffee_promotion).p.mean"

// Multi-node condition (auto-sorted)
const ref3 = generateConditionalReference('gives-bd', ['email', 'coffee'], 'mean');
// → "e.gives-bd.visited(coffee,email).p.mean"
```

### Parse References

```typescript
import { parseConditionalReference } from '@/lib/conditionalReferences';

const parsed = parseConditionalReference('e.gives-bd.visited(coffee_promotion).p.mean');
// {
//   edgeSlug: 'gives-bd',
//   nodeSlugs: ['coffee_promotion'],
//   param: 'mean',
//   isConditional: true
// }
```

### Get All References for an Edge

```typescript
import { getEdgeConditionalReferences } from '@/lib/conditionalReferences';

const refs = getEdgeConditionalReferences(edge, graph);
// [
//   { reference: 'e.gives-bd.p.mean', value: 0.5, param: 'mean', ... },
//   { reference: 'e.gives-bd.visited(coffee_promotion).p.mean', value: 0.8, ... },
//   ...
// ]
```

### Get All References for Entire Graph

```typescript
import { getAllConditionalReferences } from '@/lib/conditionalReferences';

const allRefs = getAllConditionalReferences(graph);
// Returns array of ALL parameter references in the graph
// Useful for:
// - Exporting to parameter management system
// - Generating parameter tables
// - Integration with optimization tools
```

### Look Up Values by Reference

```typescript
import { findConditionalProbabilityByReference } from '@/lib/conditionalReferences';

const value = findConditionalProbabilityByReference(
  'e.gives-bd.visited(coffee_promotion).p.mean',
  graph
);
// → 0.8
```

### Validate Slug Uniqueness

```typescript
import { validateSlugUniqueness } from '@/lib/conditionalReferences';

const validation = validateSlugUniqueness(graph);
// {
//   isValid: true/false,
//   duplicateNodeSlugs: [...],
//   duplicateEdgeSlugs: [...],
//   nodesWithoutSlugs: [...],
//   edgesWithoutSlugs: [...]
// }
```

## Integration with Runner

The runner (Google Apps Script or local) should:

1. **Parse conditional probabilities** from the graph
2. **Track visited nodes** during traversal
3. **Match conditions** to apply appropriate probabilities
4. **Use references** for logging/debugging

### Example Runner Logic

```javascript
function getEffectiveEdgeProbability(edge, visitedNodes, graph) {
  // Check if edge has conditional probabilities
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    // Try to find a matching condition
    for (const conditionalProb of edge.conditional_p) {
      const conditionNodeIds = conditionalProb.condition.visited;
      
      // Check if all required nodes have been visited
      const allConditionsMet = conditionNodeIds.every(nodeId => 
        visitedNodes.has(nodeId)
      );
      
      if (allConditionsMet) {
        // Log which condition was applied (using reference for clarity)
        const nodeSlugs = conditionNodeIds.map(id => 
          graph.nodes.find(n => n.id === id)?.slug
        );
        console.log(`Applied: e.${edge.slug}.visited(${nodeSlugs.sort().join(',')}).p.mean = ${conditionalProb.p.mean}`);
        
        return conditionalProb.p.mean;
      }
    }
  }
  
  // No condition matched, use base probability
  console.log(`Applied: e.${edge.slug}.p.mean = ${edge.p.mean}`);
  return edge.p.mean;
}
```

## Requirements for Parameter Management

For external parameter management systems to work:

1. ✅ **Slugs must be unique** (enforced by validation)
2. ✅ **Slugs must be immutable** (enforced by convention)
3. ✅ **References must be deterministic** (alphabetical sorting)
4. ✅ **References must be parseable** (regex-based parsing)
5. ⚠️ **Slugs should be valid identifiers** (recommend: lowercase, hyphens/underscores only)

### Recommended Slug Format

```
lowercase-with-hyphens
or_underscores
no_spaces
no.dots
no-special-chars-beyond-hyphen-underscore
```

## Export Format for Parameter Management

Example JSON export of all parameters:

```json
{
  "parameters": [
    {
      "reference": "e.gives-bd-to-stops-switch.p.mean",
      "value": 0.5,
      "type": "base_probability",
      "edge_slug": "gives-bd-to-stops-switch"
    },
    {
      "reference": "e.gives-bd-to-stops-switch.visited(coffee_promotion).p.mean",
      "value": 0.8,
      "type": "conditional_probability",
      "edge_slug": "gives-bd-to-stops-switch",
      "condition_nodes": ["coffee_promotion"]
    },
    {
      "reference": "e.checkout.visited(coffee_promotion,saw_banner).p.mean",
      "value": 0.9,
      "type": "conditional_probability",
      "edge_slug": "checkout",
      "condition_nodes": ["coffee_promotion", "saw_banner"]
    }
  ]
}
```

## Future Extensions

### Possible Future Condition Types

While currently only `visited()` is supported, the format allows for future extensions:

```
e.<edge-slug>.not_visited(<node-slug>).p.mean
e.<edge-slug>.spent_more_than(<amount>).p.mean
e.<edge-slug>.time_since(<node-slug>,<duration>).p.mean
```

These would require:
- Schema updates to support new condition types
- Runner logic to evaluate new conditions
- Reference format extensions

### Integration with Bayesian Analysis

For hyperprior fitting:

```python
# Fit hyperpriors to observed data
prior_params = {
  'e.gives-bd.visited(coffee_promotion).p.mean': Beta(alpha=8, beta=2),
  'e.gives-bd.visited(coffee_promotion).p.stdev': Gamma(shape=2, scale=0.01)
}
```

## Testing & Validation

Run the test suite:

```bash
npm test conditionalReferences
```

Validate your graph:

```typescript
const validation = validateSlugUniqueness(graph);
if (!validation.isValid) {
  console.error('Graph validation failed:', validation);
}
```

## Summary

✅ **Stable References**: `e.<edge-slug>.visited(<node-slugs>).p.mean`  
✅ **Human Readable**: Uses slugs, not UUIDs  
✅ **Deterministic**: Alphabetically sorted node lists  
✅ **Parseable**: Regex-based bidirectional parsing  
✅ **Validated**: Uniqueness checks built-in  
✅ **Tested**: Comprehensive test suite included  

This reference system provides the stable, immutable foundation needed for external parameter management and integration with other systems.

