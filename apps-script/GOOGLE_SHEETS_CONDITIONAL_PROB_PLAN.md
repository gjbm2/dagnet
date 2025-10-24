# Google Sheets Conditional Probability & Cases Integration Plan

**Date:** October 24, 2025  
**Status:** Ready for Implementation  
**Updated:** After design discussion

## Overview

This document outlines the plan to enhance Google Sheets integration with conditional probabilities and case what-if functionality. The approach uses existing functions with minimal additions, leveraging the established parameter reference naming system.

---

## Core Design Principles

1. **Extend existing functions** - Don't create new ones unnecessarily
2. **Use existing parameter reference syntax** - `e.<edge-slug>.p.mean`, `visited(node-slugs)`
3. **Simple flat structure** - No nested "whatIf" objects
4. **Unambiguous syntax** - Use brackets to distinguish case IDs from visited conditions
5. **Stateless** - All what-if scenarios specified per-call

---

## Function Specifications

### 1. dagGetGraph (NEW)

Retrieve graph JSON from repository or URL.

**Signature:**
```javascript
/**
 * Retrieves a graph from a URL or by name from default repo
 * @param {string} urlOrName - Full URL or graph name (uses DAGNET_GRAPH_API_BASE if name)
 * @param {string} [branch="main"] - Branch (only used if urlOrName is a name)
 * @returns {string} Graph JSON
 * @customfunction
 */
function dagGetGraph(urlOrName, branch)
```

**Examples:**
```javascript
// By name (uses default repo)
=dagGetGraph("bsse-conversion-4")
=dagGetGraph("bsse-conversion-4", "develop")

// By URL (direct)
=dagGetGraph("https://raw.githubusercontent.com/user/repo/main/graphs/my-graph.json")
=dagGetGraph("https://dagnet-nine.vercel.app/api/graph?name=my-graph&branch=main&raw=true")
```

**Constants:**
```javascript
const DAGNET_GRAPH_API_BASE = 'https://dagnet-nine.vercel.app/api/graph';
```

---

### 2. dagParams (EXTENDED)

Create parameter/case/visited overrides for dagCalc. Already exists but needs extension for visited conditions.

**Signature:**
```javascript
/**
 * Creates parameter overrides for dagCalc
 * Supports:
 * - Parameter refs: dagParams("e.checkout.p.mean", 0.9, ...)
 * - Case overrides: dagParams("checkout-experiment", "treatment", ...)
 * - Visited conditions: dagParams("visited(promo)", true, ...)
 * - Visited exclusions: dagParams("visited(promo)", false, ...)
 * Can chain multiple of each type
 * @param {...} arguments - Alternating key-value pairs
 * @returns {string} JSON string for dagCalc
 * @customfunction
 */
function dagParams(...args)
```

**Key Detection Logic:**
- Starts with `e.` → Parameter override (apply to edge)
- Starts with `visited(` and ends with `)` → Visited condition
- Otherwise → Case override (case-id → variant-name)

**Visited Condition Syntax:**
```javascript
dagParams("visited(promo)", true)                    // Include promo in visited set
dagParams("visited(promo)", false)                   // Exclude promo (override hyperprior)
dagParams("visited(promo)", "visited(landing)")      // Include both promo AND landing
dagParams("visited(promo,landing)", true)            // Include both (alternate syntax)
```

**Output Structure:**
```json
{
  "parameters": {
    "e.checkout.p.mean": 0.7
  },
  "cases": {
    "checkout-experiment": "treatment",
    "pricing-test": "control"
  },
  "assumeVisited": [
    ["promo"],
    ["landing", "email"]
  ],
  "excludeVisited": [
    ["banner"]
  ]
}
```

**Examples:**
```javascript
// Simple parameter override
=dagParams("e.checkout.p.mean", 0.7)

// Case override
=dagParams("checkout-experiment", "treatment")

// Visited condition
=dagParams("visited(promo)", true)

// Multiple visited conditions
=dagParams("visited(promo)", true, "visited(landing)", true)
=dagParams("visited(promo)", "visited(landing)")  // Shorthand

// Complex combination
=dagParams(
  "e.checkout.p.mean", 0.7,
  "checkout-experiment", "treatment",
  "visited(promo)", true,
  "visited(banner)", false
)

// Multiple cases and visited
=dagParams(
  "checkout-experiment", "treatment",
  "pricing-test", "control",
  "visited(promo)", "visited(landing)"
)
```

---

### 3. dagCalc (EXTENDED)

Add 6th parameter for what-if scenarios.

**Current Signature:**
```javascript
function dagCalc(input, operation, startNode, endNode, customParams)
```

**New Signature:**
```javascript
/**
 * Calculate graph analytics with conditional probability and what-if support
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [operation] - Operation: DG_PROBABILITY, DG_COST, DG_TIME
 * @param {string} [startNode] - Start node slug/ID
 * @param {string} [endNode] - End node: DG_ANY_SUCCESS, DG_ANY_FAILURE, or node slug
 * @param {string} [customParams] - JSON from dagParams() for parameter overrides
 * @param {string} [whatIf] - JSON from dagParams() for case/visited what-if scenarios
 * @returns {number} Calculated result
 * @customfunction
 */
function dagCalc(input, operation, startNode, endNode, customParams, whatIf)
```

**Examples:**
```javascript
// Basic (unchanged)
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS)

// With parameter override only
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, 
  dagParams("e.checkout.p.mean", 0.7))

// With case what-if
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, "",
  dagParams("checkout-experiment", "treatment"))

// With visited condition
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, "",
  dagParams("visited(promo)", true))

// Combined
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS,
  dagParams("e.checkout.p.mean", 0.7),
  dagParams("checkout-experiment", "treatment", "visited(promo)", true))
```

---

### 4. dagGetParamTable (EXTENDED)

Extend existing function to include conditional probabilities and case parameters.

**Signature:**
```javascript
/**
 * Extract all parameters from a graph using standard naming conventions
 * Returns 2D array with columns: Reference, Value, Type
 * @param {string} graphJson - Graph JSON string
 * @returns {Array<Array<string>>} Parameter table
 * @customfunction
 */
function dagGetParamTable(graphJson)
```

**Output Columns:**
1. Reference (e.g., `e.checkout.p.mean`, `case.exp-1.treatment.weight`)
2. Value (number)
3. Type (`base_probability`, `conditional_probability`, `case_variant`)

**Example Output:**
```
| Reference                                          | Value | Type                    |
|----------------------------------------------------|-------|-------------------------|
| e.checkout.p.mean                                  | 0.5   | base_probability        |
| e.checkout.p.stdev                                 | 0.05  | base_probability        |
| e.checkout.visited(promo).p.mean                   | 0.8   | conditional_probability |
| e.checkout.visited(promo,email).p.mean             | 0.9   | conditional_probability |
| case.checkout-experiment.control.weight            | 0.5   | case_variant            |
| case.checkout-experiment.treatment.weight          | 0.5   | case_variant            |
```

---

## Parameter Naming Conventions

### Standard Reference Format

**Base Probabilities:**
```
e.<edge-slug>.p.mean
e.<edge-slug>.p.stdev
```

**Conditional Probabilities:**
```
e.<edge-slug>.visited(<node-slug-1>,<node-slug-2>,...).p.mean
e.<edge-slug>.visited(<node-slug-1>,<node-slug-2>,...).p.stdev
```

**Case Variants:**
```
case.<case-id>.<variant-name>.weight
```

### Rules

1. **Alphabetical Sorting:** Node slugs in conditions are always sorted alphabetically
2. **Immutability:** Slugs must not change once assigned
3. **Uniqueness:** All slugs must be unique within their scope
4. **Format:** Lowercase with hyphens or underscores, no spaces or special characters
5. **No Brackets in IDs:** Case IDs cannot contain `(` or `)` - this disambiguates them from visited conditions

---

## Runner Logic Changes

### Conditional Probability Evaluation

When evaluating an edge, the runner must:

1. **Build the effective visited set:**
```javascript
   effectiveVisited = (hyperprior ∪ assumeVisited) \ excludeVisited
   ```
   
   Where:
   - `hyperprior` = nodes implicitly visited based on active case overrides
   - `assumeVisited` = nodes explicitly marked as visited in whatIf
   - `excludeVisited` = nodes explicitly excluded in whatIf

2. **Find matching conditional probability:**
   ```javascript
   for (conditionalProb in edge.conditional_p) {
     conditionNodes = conditionalProb.condition.visited
     if (conditionNodes ⊆ effectiveVisited) {
       // All required nodes are visited
       return conditionalProb.p.mean
     }
   }
   // No match - use base probability
   return edge.p.mean
   ```

3. **Apply case overrides:**
   ```javascript
   if (edge.case_id && whatIf.cases[caseNode.id]) {
     selectedVariant = whatIf.cases[caseNode.id]
     variantWeight = (edge.case_variant === selectedVariant) ? 1.0 : 0.0
     probability *= variantWeight
   }
   ```

### Hyperprior Logic

When a case override is active, determine which nodes would be visited:

```javascript
function getHyperpriorVisited(graph, caseOverrides) {
  const visited = new Set()
  
  for (const [caseNodeId, selectedVariant] of Object.entries(caseOverrides)) {
    // Find case node
    const caseNode = graph.nodes.find(n => n.id === caseNodeId)
    
    // Find edges with matching case_id and case_variant
    for (const edge of graph.edges) {
      if (edge.case_id === caseNode.case.id && 
          edge.case_variant === selectedVariant) {
        // Add the target node to visited set
        visited.add(edge.to)
      }
    }
  }
  
  return visited
}
```

---

## Implementation Details

### dagParams Implementation

```javascript
function dagParams() {
  try {
    const result = {
      parameters: {},
      cases: {},
      assumeVisited: [],
      excludeVisited: []
    };
    
    const args = Array.prototype.slice.call(arguments);
    
    for (let i = 0; i < args.length; i += 2) {
      if (i + 1 >= args.length) break;
      
      const key = args[i];
      const value = args[i + 1];
      
      // Normalize boolean values
      const normalizedValue = 
        (value === "true" || value === true) ? true :
        (value === "false" || value === false) ? false : 
        value;
      
      // Check if key is a visited condition
      const keyVisitedMatch = key.match(/^visited\(([^)]+)\)$/);
      const valueVisitedMatch = typeof value === 'string' ? 
        value.match(/^visited\(([^)]+)\)$/) : null;
      
      if (keyVisitedMatch) {
        // Key is visited(...)
        const nodes = keyVisitedMatch[1].split(',').map(n => n.trim()).sort();
        
        if (normalizedValue === true) {
          // Add to assumeVisited
          result.assumeVisited.push(nodes);
        } else if (normalizedValue === false) {
          // Add to excludeVisited
          result.excludeVisited.push(nodes);
        }
        
        // If value is ALSO visited(...), add it too
        if (valueVisitedMatch) {
          const valueNodes = valueVisitedMatch[1].split(',').map(n => n.trim()).sort();
          result.assumeVisited.push(valueNodes);
        }
      } else if (key.startsWith('e.')) {
        // Parameter override
        result.parameters[key] = normalizedValue;
      } else {
        // Case override
        result.cases[key] = normalizedValue;
      }
    }
    
    return JSON.stringify(result);
  } catch (e) {
    return "Error: " + e.message;
  }
}
```

### dagCalc Extension

```javascript
function dagCalc(input, operation, startNode, endNode, customParams, whatIf) {
  try {
    // ... existing input parsing ...
    
    var graph = parseGraphInput(input);
    
    // Apply customParams (parameter overrides)
    if (customParams) {
      const params = JSON.parse(customParams);
      if (params.parameters) {
        graph = applyParameterOverrides(graph, params.parameters);
      }
    }
    
    // Parse whatIf scenarios
    var whatIfData = null;
    if (whatIf) {
      whatIfData = JSON.parse(whatIf);
    }
    
    // Run calculation with what-if context
    const result = runGraphAnalysis(
      graph, 
      operation, 
      startNode, 
      endNode,
      whatIfData
    );
    
    return result;
  } catch (e) {
    return "Error: " + e.message;
  }
}
```

### Helper: applyParameterOverrides

```javascript
function applyParameterOverrides(graph, parameters) {
  const modifiedGraph = JSON.parse(JSON.stringify(graph)); // Deep clone
  
  for (const [reference, value] of Object.entries(parameters)) {
    const parsed = parseConditionalReference(reference);
    if (!parsed) continue;
    
    // Find the edge
    const edgeIndex = modifiedGraph.edges.findIndex(e => 
      e.slug === parsed.edgeSlug || e.id === parsed.edgeSlug
    );
    if (edgeIndex < 0) continue;
    
    const edge = modifiedGraph.edges[edgeIndex];
    
    if (parsed.isConditional) {
      // Apply to conditional_p
      if (!edge.conditional_p) edge.conditional_p = [];
      
      // Find or create matching conditional
      let conditionalProb = edge.conditional_p.find(cp => {
        const conditionNodes = cp.condition.visited.map(id => 
          resolveNodeSlug(modifiedGraph, id)
        ).sort();
        return arraysEqual(conditionNodes, parsed.nodeSlugs);
      });
      
      if (!conditionalProb) {
        // Create new conditional
        const nodeIds = parsed.nodeSlugs.map(slug => 
          resolveNodeId(modifiedGraph, slug)
        );
        conditionalProb = {
          condition: { visited: nodeIds },
          p: {}
        };
        edge.conditional_p.push(conditionalProb);
      }
      
      // Update parameter
      conditionalProb.p[parsed.param] = value;
    } else {
      // Apply to base probability
      if (!edge.p) edge.p = {};
      edge.p[parsed.param] = value;
    }
  }
  
  return modifiedGraph;
}
```

### Helper: parseConditionalReference

```javascript
function parseConditionalReference(reference) {
  // Base pattern: e.<edge-slug>.p.<param>
  const basePattern = /^e\.([^.]+)\.p\.(mean|stdev)$/;
  
  // Conditional pattern: e.<edge-slug>.visited(<slugs>).p.<param>
  const conditionalPattern = /^e\.([^.]+)\.visited\(([^)]+)\)\.p\.(mean|stdev)$/;
  
  // Try conditional first
  let match = reference.match(conditionalPattern);
  if (match) {
    const nodeSlugs = match[2].split(',').map(s => s.trim()).sort();
    return {
      edgeSlug: match[1],
      nodeSlugs: nodeSlugs,
      param: match[3],
      isConditional: true
    };
  }
  
  // Try base
  match = reference.match(basePattern);
  if (match) {
    return {
      edgeSlug: match[1],
      nodeSlugs: [],
      param: match[2],
      isConditional: false
    };
  }
  
  return null;
}
```

### Helper: computeEffectiveVisited

```javascript
function computeEffectiveVisited(graph, whatIfData) {
  const visited = new Set();
  
  // 1. Add hyperprior (from case overrides)
  if (whatIfData && whatIfData.cases) {
    for (const [caseNodeId, selectedVariant] of Object.entries(whatIfData.cases)) {
      const caseNode = graph.nodes.find(n => n.id === caseNodeId);
      if (!caseNode || !caseNode.case) continue;
      
      // Find edges with this case and variant
      for (const edge of graph.edges) {
        if (edge.case_id === caseNode.case.id && 
            edge.case_variant === selectedVariant) {
          visited.add(edge.to);
        }
      }
    }
  }
  
  // 2. Add assumeVisited
  if (whatIfData && whatIfData.assumeVisited) {
    for (const nodeList of whatIfData.assumeVisited) {
      for (const nodeSlug of nodeList) {
        const node = graph.nodes.find(n => n.slug === nodeSlug || n.id === nodeSlug);
        if (node) visited.add(node.id);
      }
    }
  }
  
  // 3. Remove excludeVisited
  if (whatIfData && whatIfData.excludeVisited) {
    for (const nodeList of whatIfData.excludeVisited) {
      for (const nodeSlug of nodeList) {
        const node = graph.nodes.find(n => n.slug === nodeSlug || n.id === nodeSlug);
        if (node) visited.delete(node.id);
      }
    }
  }
  
  return visited;
}
```

---

## API Endpoint

### GET /api/graph

**Location:** `graph-editor/api/graph.ts`

**Query Parameters:**
- `name` (required): Graph name
- `branch` (optional, default "main"): Git branch
- `raw` (optional, default false): Return raw JSON string vs structured response
- `format` (optional, default "json"): "json" or "pretty"

**Response (raw=false):**
```json
{
  "success": true,
  "data": {
    "name": "bsse-conversion-4",
    "branch": "main",
    "lastModified": "2025-10-24T12:00:00Z",
    "graph": { /* graph JSON */ }
  }
}
```

**Response (raw=true):**
```json
{ "nodes": [...], "edges": [...], ... }
```

---

## Examples

### Example 1: Basic What-If Case Analysis

```javascript
// Get graph
A1: =dagGetGraph("checkout-flow")

// Normal calculation
B1: =dagCalc(A1, DG_PROBABILITY, "start", "success")
// Result: 0.45 (50/50 case split)

// Force treatment variant
C1: =dagCalc(A1, DG_PROBABILITY, "start", "success", "",
  dagParams("checkout-experiment", "treatment"))
// Result: 0.52 (treatment only)
```

### Example 2: Conditional Probability Override

```javascript
// Get graph
A1: =dagGetGraph("bsse-conversion-4")

// Normal with promo visited
B1: =dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, "",
  dagParams("visited(promo)", true))
// Applies conditional probabilities for edges that depend on promo

// Exclude promo (override hyperprior)
C1: =dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, "",
  dagParams("checkout-experiment", "treatment", "visited(promo)", false))
// Treatment variant but WITHOUT promo conditional probabilities
```

### Example 3: Combined Analysis

```javascript
// Complex scenario
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS,
  dagParams("e.checkout.p.mean", 0.7),
  dagParams(
    "checkout-experiment", "treatment",
    "pricing-test", "control",
    "visited(promo)", "visited(landing)"
  ))
```

### Example 4: Sensitivity Analysis

```javascript
A1: =dagGetGraph("my-graph")
A2: =dagGetParamTable(A1)

// Create sensitivity table
B1: 0.5
B2: 0.6
B3: 0.7
B4: 0.8

C1: =dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS,
      dagParams("e.checkout.visited(promo).p.mean", B1))
C2: =dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS,
      dagParams("e.checkout.visited(promo).p.mean", B2))
// ... etc
```

---

## Testing Strategy

### Unit Tests

1. **dagParams parsing**
   - Test parameter override detection
   - Test case override detection
   - Test visited condition parsing
   - Test multiple visited conditions
   - Test visited exclusions

2. **Reference parsing**
   - Test base probability references
   - Test conditional probability references
   - Test multi-node conditions
- Test alphabetical sorting

3. **Effective visited computation**
   - Test hyperprior from cases
   - Test assumeVisited merging
   - Test excludeVisited filtering

### Integration Tests

1. **End-to-end what-if**
   - Test case override changes probability
   - Test visited condition activates conditional_p
   - Test visited exclusion blocks hyperprior
   - Test combined scenarios

2. **dagGetGraph**
   - Test by name
   - Test by URL
   - Test error handling

---

## Migration & Backward Compatibility

**All existing calls work unchanged:**
```javascript
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS)
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, dagParams("e.edge1.p.mean", 0.6))
```

**New features are purely additive:**
- 6th parameter is optional
- dagParams extended but backward compatible
- dagGetParamTable extended with new parameter types

---

## Summary

✅ **Simple** - Extends existing functions, minimal new code  
✅ **Unambiguous** - Brackets distinguish visited from cases  
✅ **Powerful** - Full control over hyperpriors and conditionals  
✅ **Backward Compatible** - All existing code works unchanged  
✅ **Intuitive** - Uses existing reference syntax  

**Ready for implementation!**
