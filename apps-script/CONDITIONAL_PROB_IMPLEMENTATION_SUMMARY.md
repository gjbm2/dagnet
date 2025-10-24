# Conditional Probability & Cases - Apps Script Implementation Summary

## ✅ Completed Implementation (October 24, 2025)

### **1. New Functions**

#### `dagGetGraph(urlOrName, branch)` 
Fetches graphs from GitHub repository via Vercel API.

**Usage:**
```javascript
=dagGetGraph("bsse-conversion-4", "main")
=dagGetGraph("https://example.com/graph.json")
```

**Backend:** `/graph-editor/api/graph.ts` (Vercel serverless function)

---

### **2. Extended Functions**

#### `dagParams(...args)` 
Now handles conditional probabilities, case overrides, and visited node conditions.

**New Capabilities:**
```javascript
// Parameter overrides
dagParams("e.checkout.p.mean", 0.7)

// Conditional probability overrides
dagParams("e.checkout.visited(promo).p.mean", 0.95)
dagParams("e.checkout.visited(promo,email).p.mean", 0.98)

// Case overrides (what-if scenarios)
dagParams("checkout-experiment", "treatment")

// Assumed visited nodes
dagParams("visited(promo)", true)
dagParams("visited(promo,landing)", true)

// Excluded visited nodes (override hyperpriors)
dagParams("visited(banner)", false)

// Combined
dagParams(
  "e.checkout.p.mean", 0.7,
  "checkout-experiment", "treatment",
  "visited(promo)", true,
  "visited(banner)", false
)
```

**Output Structure:**
```json
{
  "parameters": {
    "e.checkout.p.mean": 0.7,
    "e.checkout.visited(promo).p.mean": 0.95
  },
  "cases": {
    "checkout-experiment": "treatment"
  },
  "assumeVisited": [
    ["promo"],
    ["promo", "landing"]
  ],
  "excludeVisited": [
    ["banner"]
  ]
}
```

---

#### `dagCalc(input, operation, startNode, endNode, customParams, whatIf)`
Now accepts 6th parameter for what-if scenarios.

**New Usage:**
```javascript
// Run what-if case scenario
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, "", 
  dagParams("checkout-experiment", "treatment"))

// Run with conditional probability assumption
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, "", 
  dagParams("visited(promo)", true))

// Combined what-if scenario
=dagCalc(A1, DG_PROBABILITY, "start", DG_ANY_SUCCESS, "", 
  dagParams(
    "checkout-experiment", "treatment",
    "visited(promo)", true,
    "e.checkout.visited(promo).p.mean", 0.95
  ))
```

**What It Does:**
1. Parses `whatIf` JSON
2. Applies parameter overrides
3. Computes effective visited set (hyperpriors + assumeVisited - excludeVisited)
4. Passes context to calculation functions
5. Uses `getEffectiveEdgeProbability()` to apply conditional probabilities

---

#### `dagGetParamTable(input, filter, includeAll)`
Now extracts conditional probability parameters with canonical naming.

**New Parameters Extracted:**
```javascript
// Base probability
e.checkout.p.mean = 0.7
e.checkout.p.stdev = 0.05

// Conditional probabilities
e.checkout.visited(promo).p.mean = 0.9
e.checkout.visited(promo).p.stdev = 0.03
e.checkout.visited(email,promo).p.mean = 0.95

// Case information
e.landing-a.case_id = "landing-experiment"
e.landing-a.case_variant = "control"

// Case node information
n.landing-page.case.id = "landing-experiment"
n.landing-page.case.variants = "control,treatment"
```

**Usage:**
```javascript
=dagGetParamTable(A1)                    // All parameters
=dagGetParamTable(A1, "edges")           // Edge parameters (including conditional)
=dagGetParamTable(A1, "conditional")     // Search for "conditional"
=dagGetParamTable(A1, "", true)          // All parameters including defaults
```

---

#### `dagGetNodes(input, match)`
Now shows case node information.

**New Columns:**
- Case ID
- Case Variants (comma-separated)

**Output Example:**
```
| Node          | Label          | Type   | Outgoing | Incoming | Case ID           | Case Variants     |
|---------------|----------------|--------|----------|----------|-------------------|-------------------|
| start         | Start          | inter  | 1        | 0        |                   |                   |
| landing-page  | Landing Page   | case   | 2        | 1        | landing-exp       | control,treatment |
| promo         | Promo Page     | inter  | 1        | 1        |                   |                   |
| checkout      | Checkout       | inter  | 2        | 2        |                   |                   |
| success       | Success        | term   | 0        | 1        |                   |                   |
```

---

#### `dagGetEdges(input, match)`
Now shows conditional probability and case information.

**New Columns:**
- Case ID
- Case Variant
- Conditional P Count

**Output Example:**
```
| Edge       | From     | To       | Prob | Costs | Desc        | Case ID    | Variant | Cond P |
|------------|----------|----------|------|-------|-------------|------------|---------|--------|
| start-land | start    | landing  | 1.0  | None  | Entry       |            |         | 0      |
| land-a     | landing  | promo    | 0.5  | None  | Variant A   | landing-exp| control | 0      |
| land-b     | landing  | checkout | 0.5  | None  | Variant B   | landing-exp| treat   | 0      |
| promo-check| promo    | checkout | 0.8  | None  | After promo |            |         | 1      |
| check-succ | checkout | success  | 0.7  | None  | Conversion  |            |         | 2      |
```

---

### **3. Updated Internal Functions**

#### `flattenEdgeParameters(edge, graph)`
- Now accepts `graph` parameter to resolve node IDs to slugs
- Extracts conditional probability parameters: `e.<edge>.visited(<nodes>).p.mean`
- Extracts case variant info: `e.<edge>.case_id`, `e.<edge>.case_variant`

#### `flattenAllEdgeParameters(edge, graph)`
- Same as above, but includes ALL parameters (no smart filtering)

#### `flattenNodeParameters(node)`
- Extracts case node information: `n.<node>.case.id`, `n.<node>.case.variants`

#### `flattenAllNodeParameters(node)`
- Same as above, but includes ALL parameters

---

### **4. New Helper Functions**

#### `parseConditionalReference(reference)`
Parses parameter references like:
- `e.checkout.p.mean` → base probability
- `e.checkout.visited(promo).p.mean` → conditional probability
- `e.checkout.visited(email,promo).p.stdev` → conditional stdev

#### `computeEffectiveVisited(graph, whatIfData)`
Computes the effective visited set:
1. Adds hyperpriors (from case overrides)
2. Adds `assumeVisited` nodes
3. Removes `excludeVisited` nodes

Returns object (used as Set) of node IDs.

#### `getEffectiveEdgeProbability(edge, graph, effectiveVisited, whatIfData)`
Returns the effective probability for an edge considering:
1. Conditional probabilities (checks if condition matches `effectiveVisited`)
2. Case variant weights (applies 1.0 or 0.0 based on case override)
3. Falls back to base probability if no conditions match

#### `applyParameterOverrides(graph, parameters)`
Applies parameter overrides to graph, creating or updating:
- Base probabilities: `e.checkout.p.mean`
- Conditional probabilities: `e.checkout.visited(promo).p.mean`

#### `resolveNodeSlug(graph, nodeId)`, `resolveNodeId(graph, slug)`
Helper functions to convert between node IDs and slugs.

#### `arraysEqual(arr1, arr2)`
Helper to compare arrays.

---

### **5. Updated Calculation Functions**

All three calculation functions now accept additional parameters:

#### `calculateProbability(graph, startNode, endNodes, effectiveVisited, whatIfData)`
#### `calculateCost(graph, startNode, endNodes, effectiveVisited, whatIfData)`
#### `calculateTime(graph, startNode, endNodes, effectiveVisited, whatIfData)`

Each uses `getEffectiveEdgeProbability()` to apply:
- Conditional probabilities based on `effectiveVisited`
- Case variant weights based on `whatIfData.cases`

---

## **Parameter Naming Conventions**

### **Node Parameters**
```
n.<node-slug>.<property>
n.<node-slug>.costs.<cost-type>
n.<node-slug>.case.id
n.<node-slug>.case.variants
```

### **Edge Parameters**
```
e.<edge-slug>.p.mean
e.<edge-slug>.p.stdev
e.<edge-slug>.costs.monetary.value
e.<edge-slug>.costs.time.value
e.<edge-slug>.case_id
e.<edge-slug>.case_variant
```

### **Conditional Probability Parameters**
```
e.<edge-slug>.visited(<node-slugs>).p.mean
e.<edge-slug>.visited(<node-slugs>).p.stdev
```

**Rules:**
- Node slugs are sorted alphabetically and comma-separated
- Example: `e.checkout.visited(email,promo).p.mean`

---

## **Vercel API Endpoint**

### `/api/graph` (NEW)
**Location:** `/graph-editor/api/graph.ts`

**Query Parameters:**
- `name` (required): Graph name
- `branch` (optional): Git branch (default: main)
- `raw` (optional): Return raw JSON string (default: false)
- `format` (optional): Pretty-print JSON when raw=true

**Environment Variables:**
- `VITE_GIT_REPO_OWNER`
- `VITE_GIT_REPO_NAME`
- `VITE_GIT_GRAPHS_PATH`
- `VITE_GITHUB_TOKEN`

**Example:**
```
GET https://dagnet-nine.vercel.app/api/graph?name=bsse-conversion-4&branch=main&raw=true&format=pretty
```

---

## **Testing Checklist**

- [ ] `dagGetGraph` fetches graphs from Vercel API
- [ ] `dagParams` constructs correct JSON for all parameter types
- [ ] `dagCalc` applies case overrides correctly
- [ ] `dagCalc` applies conditional probabilities correctly
- [ ] `dagCalc` computes hyperpriors from case overrides
- [ ] `dagCalc` handles `assumeVisited` correctly
- [ ] `dagCalc` handles `excludeVisited` correctly (overrides hyperpriors)
- [ ] `dagGetParamTable` extracts conditional probability parameters
- [ ] `dagGetParamTable` extracts case node parameters
- [ ] `dagGetNodes` shows case information
- [ ] `dagGetEdges` shows case and conditional probability information
- [ ] Parameter naming follows canonical format (sorted node slugs)

---

## **Known Limitations**

1. **Node slug resolution:** If node IDs are used in conditional probabilities but nodes don't have slugs, the parameter names will use IDs instead
2. **Graph pruning:** `visited(node), false` doesn't prune graph paths, only affects conditional probability application
3. **Hyperprior tracking:** Hyperpriors are derived from case overrides at analytics time, not stored explicitly

---

## **Files Modified**

1. `/apps-script/dagnet-apps-script.js` - Main implementation (2441 lines)
2. `/graph-editor/api/graph.ts` - Vercel API endpoint (NEW)
3. `/graph-editor/package.json` - Added `@vercel/node` dependency
4. `/graph-editor/api/README.md` - API documentation

---

## **Next Steps**

1. Run `npm install` in `/graph-editor`
2. Deploy to Vercel
3. Set environment variables in Vercel dashboard
4. Test in Google Sheets
5. Update Google Sheets examples/templates

