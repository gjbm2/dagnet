# DAS Subtraction Implementation Plan
## Design Delta and Implementation Roadmap for minus() Operator

### Executive Summary

This document specifies the implementation plan for adding the `minus()` operator to the DAS Query DSL, enabling provider-agnostic exclusion logic via subtractive funnel queries. This change allows us to compute edge probabilities on providers (like Amplitude GET) that lack native exclude support.

**Key Changes:**
- DSL grammar extension: add `minus(...)` operator (alongside existing `excludes()`)
- Schema updates: query field validation
- Parser: detect and decompose `minus()` composite queries
- Executor: parallel sub-query execution and result combination
- MSMDC: provider-aware query compilation
  - If provider supports native `excludes()`: use it directly
  - If provider lacks native support: prohibit `excludes()` and compile to `minus()` with separator detection

**Timeline:** 4 phases over ~3-4 weeks
**Risk:** Low (additive change; backward compatible)

### Files and Components Affected

**Schemas:**
- `graph-editor/public/schemas/query-dsl-1.0.0.json` - add "minus" to valid functions
- `graph-editor/public/defaults/connections.yaml` - add capabilities section
- `graph-editor/public/schemas/conversion-graph-1.0.0.json` - (optional) query field docs

**Python (MSMDC):**
- `lib/query_dsl.py` - add minus parsing and reconstruction
- `msmdc/config/provider_capabilities.py` - NEW: capability schema
- `msmdc/algorithms/graph_analysis.py` - NEW: separator detection algorithms
- `msmdc/compiler/query_compiler.py` - NEW: excludes→minus compilation
- `msmdc/planner/main.py` - integrate capability-aware planning

**TypeScript (Runtime):**
- `graph-editor/src/lib/queryDSL.ts` - add minus to constants/types/validation
- `graph-editor/src/lib/das/queryDslParser.ts` - NEW: composite query parser
- `graph-editor/src/services/dataOperationsService.ts` - composite execution & combination
- `graph-editor/src/lib/das/buildDslFromEdge.ts` - (no changes; already outputs query strings)

**Tests:**
- `lib/tests/test_query_dsl.py` - Python parser tests
- `msmdc/tests/test_graph_analysis.py` - NEW: separator detection tests
- `msmdc/tests/test_query_compiler.py` - NEW: compilation tests
- `graph-editor/src/lib/__tests__/queryDSL.test.ts` - TypeScript validation tests
- `graph-editor/src/lib/das/__tests__/queryDslParser.test.ts` - NEW: parser tests
- `graph-editor/src/services/__tests__/dataOperationsService.subtraction.test.ts` - NEW: execution tests

---

## 1. DSL Grammar Changes

### 1.1 Current Grammar (Actual - from query-dsl-1.0.0.json)

**Schema Authority:** `/graph-editor/public/schemas/query-dsl-1.0.0.json`  
**Valid Functions:** `["from", "to", "visited", "visitedAny", "exclude", "context", "case"]`

```ebnf
query          ::= from-clause to-clause constraint*

from-clause    ::= "from(" node-id ")"
to-clause      ::= "to(" node-id ")"

constraint     ::= exclude-clause | visited-clause | visitedAny-clause | context-clause | case-clause

exclude-clause    ::= ".exclude(" node-list ")"
visited-clause    ::= ".visited(" node-list ")"
visitedAny-clause ::= ".visitedAny(" node-list ")"
context-clause    ::= ".context(" key ":" value ")"
case-clause       ::= ".case(" key ":" value ")"

node-list      ::= node-id ("," node-id)*
node-id        ::= [a-z0-9_-]+
key            ::= [a-z0-9_-]+
value          ::= [a-z0-9_-]+
```

**Semantics:**
- `.visited(x,y)` → must visit **both** x AND y (all nodes in list)
- `.visitedAny(x,y)` → must visit **at least one** of x OR y
- `.exclude(x,y)` → must NOT visit x AND must NOT visit y (neither can appear)

**Properties:** Order-independent (`.from(a).to(b).exclude(c)` ≡ `.exclude(c).from(a).to(b)`)

### 1.2 Extended Grammar (Proposed)

**Add one new constraint type:**

```ebnf
query          ::= from-clause to-clause constraint*

constraint     ::= exclude-clause | visited-clause | visitedAny-clause | 
                   context-clause | case-clause | minus-clause

minus-clause   ::= ".minus(" query ")"
```

**New construct:** `.minus(...)` wraps a complete query expression (from...to...constraints) for subtractive funnel logic.

**Nested query:** The query inside `.minus(...)` follows the same grammar (recursive), allowing arbitrary nesting depth (though v1 will only support one level).

### 1.3 Examples

| Intent | DSL with exclude() | DSL with minus() (explicit subtraction) |
|--------|-------------------|----------------------------------------|
| Simple A→C | `from(a).to(c)` | (unchanged) |
| A→C, exclude B (native) | `from(a).to(c).exclude(b)` | N/A (use exclude when provider supports it) |
| A→C, exclude B (subtractive) | Prohibited when provider lacks support | `from(a).to(c).minus(from(a).to(c).visited(b))` |
| A→C, exclude B & D (subtractive) | Prohibited when provider lacks support | `from(a).to(c).minus(from(a).to(c).visited(b)).minus(from(a).to(c).visited(d))` |
| Interval exclusion | N/A | `from(a).to(c).minus(from(x).to(y).visited(b))` |

**Note:** All node IDs must be lowercase per schema: `[a-z0-9_-]+`

**Policy:**
- **`.exclude()`** (singular) is the preferred operator when the provider supports it natively (simpler, single query).
- **`.minus()`** is used when the provider lacks native exclude support (requires composite execution).
- **MSMDC compilation:**
  - If `supports_native_exclude=true`: author can use `.exclude()`, MSMDC passes it through.
  - If `supports_native_exclude=false`: MSMDC must prohibit `.exclude()` and compile queries to use `.minus()` instead.

---

## 2. Schema Changes

### 2.1 Query DSL Schema Update (query-dsl-1.0.0.json)

**Location:** `graph-editor/public/schemas/query-dsl-1.0.0.json`

**Current valid functions:**
```json
"enum": ["from", "to", "visited", "visitedAny", "exclude", "context", "case"]
```

**Change:** Add "minus" to the enum:
```json
"enum": ["from", "to", "visited", "visitedAny", "exclude", "context", "case", "minus"]
```

**Update pattern in raw query validation:**
```json
{
  "properties": {
    "raw": {
      "type": "string",
      "pattern": "^from\\([a-z0-9_-]+\\)\\.to\\([a-z0-9_-]+\\)(\\.(visited|visitedAny|exclude|case|context|minus)\\([^)]+\\))*$"
    }
  }
}
```

**Add example:**
```json
"examples": [
  "from(a).to(c).minus(from(a).to(c).visited(b))"
]
```

### 2.2 Conversion Graph Schema (Optional Enhancement)

**Location:** `graph-editor/public/schemas/conversion-graph-1.0.0.json`

**Current:** Edge `query` field is a free-form string with no validation.

**Optional:** Add reference to query-dsl schema for stricter validation:

```json
{
  "$defs": {
    "Edge": {
      "properties": {
        "query": {
          "type": "string",
          "description": "DSL query string for this edge (see query-dsl-1.0.0.json)",
          "$comment": "Format: from(node).to(node).visited(node).exclude(node).minus(...)",
          "maxLength": 2048
        }
      }
    }
  }
}
```

**Rationale:** Keep validation lenient in conversion-graph; strict validation happens in query-dsl schema.

### 2.3 Python Parser Updates (lib/query_dsl.py)

**Location:** `lib/query_dsl.py`

**Changes:**

1. Add "minus" to valid functions list:
```python
# Line 5
Valid Functions: ["from", "to", "visited", "visitedAny", "exclude", "context", "case", "minus"]
```

2. Update grammar documentation:
```python
# Lines 11-17
constraint     ::= exclude-clause | visited-clause | visitedAny-clause | 
                   context-clause | case-clause | minus-clause

minus-clause   ::= ".minus(" query ")"
```

3. Add minus field to ParsedQuery dataclass:
```python
@dataclass
class ParsedQuery:
    """
    Parsed query DSL expression per query-dsl-1.0.0.json schema.
    """
    from_node: str
    to_node: str
    exclude: List[str]
    visited: List[str]
    visited_any: List[List[str]]
    context: List[KeyValuePair]
    cases: List[KeyValuePair]
    minus: List['ParsedQuery']  # NEW: nested queries for subtraction
```

4. Add minus parsing logic to `parse_query()`:
```python
def parse_query(query: str) -> ParsedQuery:
    # ... existing parsing ...
    
    # Extract minus clauses (recursive)
    minus_queries = _extract_minus_queries(query)
    
    return ParsedQuery(
        from_node=from_node,
        to_node=to_node,
        exclude=exclude,
        visited=visited,
        visited_any=visited_any,
        context=context,
        cases=cases,
        minus=minus_queries  # NEW
    )

def _extract_minus_queries(query: str) -> List[ParsedQuery]:
    """Extract and parse all .minus(...) clauses."""
    minus_queries = []
    
    # Match .minus(from(...).to(...))
    # Need to handle nested parentheses carefully
    pattern = r'\.minus\(([^)]+(?:\([^)]*\))*)\)'
    matches = re.findall(pattern, query)
    
    for match in matches:
        # Recursively parse the inner query
        inner = parse_query(match)
        minus_queries.append(inner)
    
    return minus_queries
```

5. Update `raw` property to reconstruct minus clauses:
```python
@property
def raw(self) -> str:
    """Reconstruct query string from parsed components."""
    parts = [f"from({self.from_node})", f"to({self.to_node})"]
    
    # ... existing constraints ...
    
    # NEW: Add minus clauses
    for minus_query in self.minus:
        parts.append(f"minus({minus_query.raw})")
    
    return ".".join(parts)
```

### 2.4 TypeScript Types and Parser Updates

**Location:** `graph-editor/src/lib/queryDSL.ts`

**Changes:**

1. Add "minus" to QUERY_FUNCTIONS constant:
```typescript
export const QUERY_FUNCTIONS = [
  'from',
  'to', 
  'visited',
  'visitedAny',
  'exclude',
  'context',
  'case',
  'minus'  // NEW
] as const;
```

2. Update QUERY_PATTERN regex:
```typescript
export const QUERY_PATTERN = /^(from|to)\([a-z0-9-]+\)\.(from|to|visited|visitedAny|exclude|context|case|minus)\([^)]*\)(\.(visited|visitedAny|exclude|context|case|minus)\([^)]*\))*$/;
```

3. Extend ParsedQuery interface (if it exists with structured fields):
```typescript
export interface ParsedQueryStructured {
  from: string;
  to: string;
  visited?: string[];
  visitedAny?: string[][];
  exclude?: string[];
  context?: Array<{ key: string; value: string }>;
  cases?: Array<{ key: string; value: string }>;
  minus?: ParsedQueryStructured[];  // NEW: recursive for nested queries
}
```

4. Update parser function signatures in `validateQueryStructure()`:
```typescript
export function validateQueryStructure(query: string): boolean {
  // ... existing logic ...
  
  // Allow 'minus' as a valid function name
  const functionPattern = /\b([a-z_-]+)\s*\(/g;
  let match;
  while ((match = functionPattern.exec(cleanQuery)) !== null) {
    if (!isQueryFunction(match[1])) {
      return false;
    }
  }
  
  return true;
}
```

### 2.5 YAML Query Files (param-registry)

**No schema changes required.** Query strings in YAML files (e.g., `query: "from(a).to(c)"`) continue to work as-is. MSMDC-generated strings with `.minus(...)` will validate against the same format.

### 2.6 Connection Capability Schema (NEW)

**Location:** `graph-editor/public/defaults/connections.yaml` or a new `connection-capabilities.yaml`

Add a `capabilities` section to each connection:

```yaml
connections:
  - name: amplitude-prod
    provider: amplitude
    capabilities:
      supports_native_exclude: false
      supports_visited: true
      supports_ordered: true
      supports_unordered: false
      supports_sequential: false
      max_funnel_length: 10
    # ... rest of connection config
```

**Consumption:** MSMDC reads this at planning time to decide compilation strategy.

---

## 3. Code Changes: TypeScript (Runtime)

### 3.1 DSL Parser (NEW)

**File:** `graph-editor/src/lib/das/queryDslParser.ts`

```typescript
export interface ParsedFunnel {
  from: string;
  to: string;
  visited?: string[];
  visitedAny?: string[][];
  filters?: Record<string, any>;
}

export interface ParsedQuery {
  base: ParsedFunnel;
  minusTerms: ParsedFunnel[];
  mode: 'ordered' | 'unordered' | 'sequential';
  window?: { start: string; end: string };
}

export function parseQueryDSL(dslString: string): ParsedQuery {
  // 1. Extract mode (default: ordered)
  const mode = extractMode(dslString) || 'ordered';
  
  // 2. Extract window (if inline; often passed separately)
  const window = extractWindow(dslString);
  
  // 3. Split base funnel from minus terms
  const { base, minusStrings } = splitBaseAndMinus(dslString);
  
  // 4. Parse base funnel
  const baseFunnel = parseSingleFunnel(base);
  
  // 5. Parse each minus term
  const minusTerms = minusStrings.map(parseSingleFunnel);
  
  return { base: baseFunnel, minusTerms, mode, window };
}

function splitBaseAndMinus(dsl: string): { base: string; minusStrings: string[] } {
  // Regex to extract: .minus(from(...).to(...))
  const minusRegex = /\.minus\(([^)]+(?:\([^)]*\))*)\)/g;
  const minusStrings: string[] = [];
  let match;
  
  while ((match = minusRegex.exec(dsl)) !== null) {
    minusStrings.push(match[1]);
  }
  
  // Remove all minus(...) to get base
  const base = dsl.replace(minusRegex, '');
  
  return { base, minusStrings };
}

function parseSingleFunnel(funnelStr: string): ParsedFunnel {
  // Extract: from(X), to(Y), visited(Z), visitedAny([A,B])
  const fromMatch = funnelStr.match(/from\(([a-zA-Z0-9_-]+)\)/);
  const toMatch = funnelStr.match(/to\(([a-zA-Z0-9_-]+)\)/);
  const visitedMatches = [...funnelStr.matchAll(/visited\(([a-zA-Z0-9_-]+)\)/g)];
  const visitedAnyMatches = [...funnelStr.matchAll(/visitedAny\(\[([^\]]+)\]\)/g)];
  
  if (!fromMatch || !toMatch) {
    throw new Error(`Invalid funnel syntax: ${funnelStr}`);
  }
  
  return {
    from: fromMatch[1],
    to: toMatch[1],
    visited: visitedMatches.map(m => m[1]),
    visitedAny: visitedAnyMatches.map(m => m[1].split(',').map(s => s.trim()))
  };
}

function extractMode(dsl: string): 'ordered' | 'unordered' | 'sequential' | null {
  const match = dsl.match(/\.mode\((ordered|unordered|sequential)\)/);
  return match ? (match[1] as any) : null;
}

function extractWindow(dsl: string): { start: string; end: string } | undefined {
  const match = dsl.match(/\.window\((\d{8}),(\d{8})\)/);
  return match ? { start: match[1], end: match[2] } : undefined;
}
```

**Tests:** `queryDslParser.test.ts` with cases for:
- Simple funnel
- Single minus
- Multiple minus terms
- Order independence (base before/after minus)
- Invalid syntax errors

### 3.2 Runtime Policy Enforcement (NEW)

**File:** `graph-editor/src/services/dataOperationsService.ts`

**Add validation to prohibit excludes() when provider doesn't support it:**

```typescript
function validateQueryForProvider(
  queryString: string,
  connectionName: string,
  capabilities: ProviderCapabilities
): void {
  const hasExcludes = /\.excludes\(/.test(queryString);
  
  if (hasExcludes && !capabilities.supports_native_exclude) {
    throw new Error(
      `Query uses excludes() but provider "${connectionName}" does not support native excludes. ` +
      `Use minus() for subtractive queries, or MSMDC should compile excludes to minus.`
    );
  }
}
```

### 3.3 Composite Query Executor (NEW/ENHANCED)

**File:** `graph-editor/src/services/dataOperationsService.ts`

**Add:**

```typescript
interface SubQueryResult {
  id: string;
  from_count: number;
  to_count: number;
  raw_response: any;
}

async function executeCompositeQuery(
  parsed: ParsedQuery,
  baseDsl: any,
  connectionName: string,
  runner: DASRunner
): Promise<{
  base: SubQueryResult;
  minusResults: SubQueryResult[];
}> {
  // Build base DSL
  const baseDslFull = {
    ...baseDsl,
    from: parsed.base.from,
    to: parsed.base.to,
    visited: parsed.base.visited,
    mode: parsed.mode,
    window: parsed.window || baseDsl.window
  };
  
  // Build minus DSLs
  const minusDsls = parsed.minusTerms.map((term, idx) => ({
    ...baseDsl,
    from: term.from,
    to: term.to,
    visited: term.visited,
    mode: parsed.mode,
    window: parsed.window || baseDsl.window,
    _queryId: `minus_${idx}`
  }));
  
  // Execute all in parallel
  console.log(`[CompositeQuery] Executing base + ${minusDsls.length} minus terms`);
  
  const [baseResult, ...minusResults] = await Promise.all([
    executeSubQuery(baseDslFull, connectionName, runner, 'base'),
    ...minusDsls.map((dsl, idx) => 
      executeSubQuery(dsl, connectionName, runner, `minus_${idx}`)
    )
  ]);
  
  return { base: baseResult, minusResults };
}

async function executeSubQuery(
  dsl: any,
  connectionName: string,
  runner: DASRunner,
  queryId: string
): Promise<SubQueryResult> {
  // Execute via DASRunner
  console.log(`[SubQuery ${queryId}] Executing:`, dsl);
  const result = await runner.execute(dsl, connectionName);
  
  // Extract counts (provider-specific; Amplitude uses cumulativeRaw)
  const subResult: SubQueryResult = {
    id: queryId,
    from_count: result.extracted?.from_count || 0,
    to_count: result.extracted?.to_count || 0,
    raw_response: result.raw_response
  };
  
  console.log(`[SubQuery ${queryId}] Result: from=${subResult.from_count}, to=${subResult.to_count}`);
  
  return subResult;
}

function combineSubtractiveResults(results: {
  base: SubQueryResult;
  minusResults: SubQueryResult[];
}): {
  n: number;
  k: number;
  p_mean: number;
  evidence: { n: number; k: number };
} {
  const n = results.base.from_count;
  const k_base = results.base.to_count;
  
  // Sum all minus terms
  const k_subtract_sum = results.minusResults.reduce(
    (sum, mr) => sum + mr.to_count,
    0
  );
  
  // Clamp: k ∈ [0, k_base]
  const k = Math.max(0, Math.min(k_base, k_base - k_subtract_sum));
  
  // Guard divide-by-zero
  const p_mean = n > 0 ? k / n : 0;
  
  console.log(
    `[Combine] n=${n}, k_base=${k_base}, k_subtract=${k_subtract_sum}, k_final=${k}, p=${p_mean.toFixed(4)}`
  );
  
  return { n, k, p_mean, evidence: { n, k } };
}
```

**Note on Caching:** We're starting without sub-query caching. Only add if profiling shows >30% sub-query duplication across edges (see Future Work).

**Modify `getFromSourceDirect`:**

```typescript
async function getFromSourceDirect(...): Promise<void> {
  // ... existing edge/connection resolution ...
  
  // Build DSL
  const dsl = await buildDslFromEdge(...);
  
  // Get provider capabilities
  const capabilities = getProviderCapabilities(connectionName);
  
  // Parse query string for minus() terms
  const queryString = dsl.query || generateQueryStringFromDsl(dsl);
  
  // Validate: prohibit excludes() if provider doesn't support it
  validateQueryForProvider(queryString, connectionName, capabilities);
  
  const parsed = parseQueryDSL(queryString);
  
  if (parsed.minusTerms.length === 0) {
    // Simple case: single query (may include excludes if provider supports it)
    const result = await runner.execute(dsl, connectionName);
    applyResultToGraph(result, targetId);
    return;
  }
  
  // Composite case: execute base + minus terms
  const results = await executeCompositeQuery(parsed, dsl, connectionName, runner);
  
  // Combine counts
  const combined = combineSubtractiveResults(results);
  
  // Apply to graph
  applyResultToGraph(
    { ...combined, extracted: combined, transformed: combined },
    targetId
  );
}
```

### 3.4 Testing

**File:** `graph-editor/src/services/__tests__/dataOperationsService.subtraction.test.ts`

```typescript
describe('Subtractive Query Execution', () => {
  it('should execute single minus term and combine correctly', async () => {
    const dsl = 'from(A).to(C).minus(from(A).to(C).visited(B))';
    const parsed = parseQueryDSL(dsl);
    
    // Mock runner to return known counts
    const mockRunner = {
      execute: jest.fn()
        .mockResolvedValueOnce({ extracted: { from_count: 1000, to_count: 800 } }) // base
        .mockResolvedValueOnce({ extracted: { from_count: 1000, to_count: 300 } }) // minus
    };
    
    const results = await executeCompositeQuery(parsed, {}, 'amplitude-prod', mockRunner);
    const combined = combineSubtractiveResults(results);
    
    expect(combined.n).toBe(1000);
    expect(combined.k).toBe(500); // 800 - 300
    expect(combined.p_mean).toBeCloseTo(0.5);
  });
  
  it('should clamp k to [0, k_base]', async () => {
    // k_base=100, k_subtract=150 → k=0
    const results = {
      base: { id: 'base', from_count: 1000, to_count: 100, raw_response: {} },
      minusResults: [{ id: 'minus_0', from_count: 1000, to_count: 150, raw_response: {} }]
    };
    
    const combined = combineSubtractiveResults(results);
    
    expect(combined.k).toBe(0);
    expect(combined.p_mean).toBe(0);
  });
  
  it('should cache sub-queries', async () => {
    // Execute same DSL twice; second should hit cache
    // ... test cache hit/miss logic
  });
});
```

---

## 4. MSMDC Algorithmic Changes (Python)

### 4.1 Overview

MSMDC (the planner) must:
1. Ingest provider capabilities
2. Detect when a query requires exclusion logic
3. Generate a subtractive query string (`minus(...)` terms) when provider lacks native exclude
4. Use graph algorithms (dominance, separator detection) to find optimal minus anchors

### 4.2 Provider Capability Schema

**File:** `msmdc/config/provider_capabilities.py`

```python
from typing import TypedDict, Optional

class ProviderCapabilities(TypedDict):
    supports_native_exclude: bool
    supports_visited: bool
    supports_ordered: bool
    supports_unordered: bool
    supports_sequential: bool
    max_funnel_length: Optional[int]

PROVIDER_CAPABILITIES: dict[str, ProviderCapabilities] = {
    "amplitude": {
        "supports_native_exclude": False,
        "supports_visited": True,
        "supports_ordered": True,
        "supports_unordered": False,
        "supports_sequential": False,
        "max_funnel_length": 10,
    },
    "statsig": {
        "supports_native_exclude": False,
        "supports_visited": False,
        "supports_ordered": True,
        "supports_unordered": False,
        "supports_sequential": False,
        "max_funnel_length": 2,
    },
    "custom_sql": {
        "supports_native_exclude": True,
        "supports_visited": True,
        "supports_ordered": True,
        "supports_unordered": True,
        "supports_sequential": True,
        "max_funnel_length": None,
    },
}
```

### 4.3 Separator Detection Algorithm

**File:** `msmdc/algorithms/graph_analysis.py`

```python
import networkx as nx
from typing import List, Optional

def find_minimal_merge(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str
) -> str:
    """
    Find the minimal post-merge node M that fully resolves the decision at split_node.
    
    This is the earliest node that:
    - All paths from split_node (through any first hop) must eventually reach
    - Is reachable from kept_target
    
    Often this is just a direct successor of kept_target, or the next common
    ancestor of all branches.
    """
    # Simple heuristic: find the nearest common descendant of all first hops
    first_hops = list(graph.successors(split_node))
    
    if len(first_hops) == 1:
        # No branching; merge is just the target itself or its successor
        return kept_target
    
    # Compute all descendants for each first hop
    descendant_sets = [
        set(nx.descendants(graph, hop)) | {hop}
        for hop in first_hops
    ]
    
    # Common descendants
    common = set.intersection(*descendant_sets)
    
    if not common:
        raise ValueError(f"No common merge point found for branches from {split_node}")
    
    # Find the earliest (closest to split_node in topological order)
    topo_order = list(nx.topological_sort(graph))
    for node in topo_order:
        if node in common:
            return node
    
    raise ValueError("Could not determine merge node")


def find_separator_for_branch(
    graph: nx.DiGraph,
    split_node: str,
    branch_first_hop: str,
    merge_node: str,
    kept_path: List[str]
) -> str:
    """
    Find the separator node S for an alternate branch:
    - S is the earliest node that all paths from split_node through branch_first_hop to merge_node must cross
    - S is not on the kept_path (before reaching merge_node)
    
    Uses post-dominance analysis.
    
    Returns: separator node ID (defaults to merge_node if no better option)
    """
    # Compute all paths from branch_first_hop to merge_node
    try:
        all_paths = list(nx.all_simple_paths(graph, branch_first_hop, merge_node))
    except nx.NetworkXNoPath:
        # Branch doesn't reach merge; shouldn't happen in a valid DAG
        raise ValueError(f"No path from {branch_first_hop} to {merge_node}")
    
    if not all_paths:
        return merge_node
    
    # Find nodes that appear in ALL paths (post-dominators)
    path_sets = [set(path) for path in all_paths]
    post_dominators = set.intersection(*path_sets)
    
    # Remove nodes on kept_path (up to merge)
    try:
        merge_idx = kept_path.index(merge_node)
        kept_before_merge = set(kept_path[:merge_idx])
    except ValueError:
        kept_before_merge = set()
    
    candidates = post_dominators - kept_before_merge - {split_node}
    
    if not candidates:
        # No valid separator; default to merge_node
        return merge_node
    
    # Return the earliest candidate (closest to branch_first_hop)
    # Use topological order or path distance
    topo_order = list(nx.topological_sort(graph))
    for node in topo_order:
        if node in candidates:
            return node
    
    return merge_node


def get_competing_first_hops(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str
) -> List[str]:
    """
    Return all first hops from split_node except kept_target.
    """
    return [t for t in graph.successors(split_node) if t != kept_target]
```

**Algorithm Validation Tests:**

```python
def test_separator_detection():
    # Diamond graph: A → B → C, A → D → C
    G = nx.DiGraph()
    G.add_edges_from([('A', 'B'), ('B', 'C'), ('A', 'D'), ('D', 'C')])
    
    # Find separator for branch D when kept edge is A→B
    sep = find_separator_for_branch(
        G, split_node='A', branch_first_hop='D',
        merge_node='C', kept_path=['A', 'B', 'C']
    )
    
    # Should return 'D' or 'C' (both valid; D is better as it's earlier)
    assert sep in ('D', 'C')
    
    # More complex: A → B → X → C, A → D → E → C
    G2 = nx.DiGraph()
    G2.add_edges_from([
        ('A', 'B'), ('B', 'X'), ('X', 'C'),
        ('A', 'D'), ('D', 'E'), ('E', 'C')
    ])
    
    sep2 = find_separator_for_branch(
        G2, split_node='A', branch_first_hop='D',
        merge_node='C', kept_path=['A', 'B', 'X', 'C']
    )
    
    # Should return 'E' or 'C'; 'E' is better
    assert sep2 in ('E', 'C')
```

### 4.4 Query Compiler

**File:** `msmdc/compiler/query_compiler.py`

```python
from typing import Dict, List
from msmdc.config.provider_capabilities import ProviderCapabilities

def compile_query_for_edge(
    graph: nx.DiGraph,
    edge: tuple[str, str],
    provider: str,
    capabilities: ProviderCapabilities
) -> str:
    """
    Generate the optimal query DSL string for an edge, given provider capabilities.
    
    Policy:
    - If provider supports native excludes: use excludes() (single query)
    - If provider lacks native support: compile to minus() (composite query)
    """
    source, target = edge
    
    # Determine if this edge needs exclusion logic
    # (i.e., are there competing branches from source?)
    competing = get_competing_first_hops(graph, source, target)
    
    if not competing:
        # Simple edge; no exclusion needed
        return f"from({source}).to({target})"
    
    # Find minimal merge point
    merge_node = find_minimal_merge(graph, source, target)
    
    # Check if provider supports native excludes
    if capabilities["supports_native_exclude"]:
        # Use excludes() syntax (provider will handle it natively)
        excludes_list = ",".join(competing)
        return f"from({source}).to({merge_node}).excludes({excludes_list})"
    
    # Provider doesn't support native excludes; prohibit excludes() and compile to minus()
    return compile_to_subtractive_query(
        graph, source, target, merge_node, competing
    )


def compile_to_subtractive_query(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str,
    merge_node: str,
    competing_hops: List[str]
) -> str:
    """
    Build a subtractive query: base minus each alternate branch.
    """
    # Base funnel
    base = f"from({split_node}).to({merge_node})"
    
    # Kept path (for separator detection)
    try:
        kept_path = nx.shortest_path(graph, split_node, merge_node)
    except nx.NetworkXNoPath:
        kept_path = [split_node, kept_target, merge_node]
    
    # Build minus terms
    minus_terms = []
    for alt_hop in competing_hops:
        separator = find_separator_for_branch(
            graph, split_node, alt_hop, merge_node, kept_path
        )
        
        # minus(from(split).to(separator).visited(alt_hop))
        minus_terms.append(
            f"minus(from({split_node}).to({separator}).visited({alt_hop}))"
        )
    
    # Combine
    query = f"{base}.{'.'.join(minus_terms)}"
    
    return query
```

**Example Usage:**

```python
# Diamond graph: A → B → C, A → D → C
# Want to isolate edge A→B

G = nx.DiGraph()
G.add_edges_from([('A', 'B'), ('B', 'C'), ('A', 'D'), ('D', 'C')])

capabilities = PROVIDER_CAPABILITIES["amplitude"]

query = compile_query_for_edge(G, ('A', 'B'), 'amplitude', capabilities)

print(query)
# Output: "from(A).to(C).minus(from(A).to(C).visited(D))"
# or: "from(A).to(C).minus(from(A).to(D).visited(D))" depending on separator logic
```

### 4.5 Integration into MSMDC Planner

**File:** `msmdc/planner/main.py`

```python
def plan_queries_for_graph(
    graph: nx.DiGraph,
    target_edges: List[tuple[str, str]],
    available_providers: List[str],
    provider_capabilities: Dict[str, ProviderCapabilities]
) -> Dict[tuple[str, str], Dict]:
    """
    For each target edge, generate the optimal query DSL given available providers.
    
    Returns: { edge: { 'query': dsl_string, 'provider': name, 'connection': name } }
    """
    queries = {}
    
    for edge in target_edges:
        # Choose best provider (based on cost, freshness, capability, etc.)
        provider = select_best_provider(
            edge, graph, available_providers, provider_capabilities
        )
        
        # Compile query for that provider
        query_dsl = compile_query_for_edge(
            graph, edge, provider, provider_capabilities[provider]
        )
        
        queries[edge] = {
            "query": query_dsl,
            "provider": provider,
            "connection": f"{provider}-prod"  # or from connection registry
        }
    
    return queries


def select_best_provider(
    edge: tuple[str, str],
    graph: nx.DiGraph,
    available: List[str],
    capabilities: Dict[str, ProviderCapabilities]
) -> str:
    """
    Select the best provider for this edge based on:
    - Capability match (can it execute the required query?)
    - Cost (API rate limits, query complexity)
    - Data freshness
    - Historical reliability
    
    For now, simple heuristic: prefer providers with native exclude if needed.
    """
    source, target = edge
    competing = get_competing_first_hops(graph, source, target)
    needs_exclude = len(competing) > 0
    
    if needs_exclude:
        # Prefer providers with native exclude (fewer API calls)
        for prov in available:
            if capabilities[prov]["supports_native_exclude"]:
                return prov
    
    # Default to first available
    return available[0]
```

### 4.6 MSMDC Testing

**File:** `msmdc/tests/test_query_compiler.py`

```python
import pytest
import networkx as nx
from msmdc.compiler.query_compiler import compile_query_for_edge
from msmdc.config.provider_capabilities import PROVIDER_CAPABILITIES

def test_simple_edge_no_branches():
    G = nx.DiGraph()
    G.add_edges_from([('A', 'B'), ('B', 'C')])
    
    query = compile_query_for_edge(G, ('A', 'B'), 'amplitude', PROVIDER_CAPABILITIES['amplitude'])
    
    assert query == "from(A).to(B)"


def test_diamond_graph_subtractive():
    G = nx.DiGraph()
    G.add_edges_from([('A', 'B'), ('B', 'C'), ('A', 'D'), ('D', 'C')])
    
    # Edge A→B with Amplitude (no native exclude)
    query = compile_query_for_edge(G, ('A', 'B'), 'amplitude', PROVIDER_CAPABILITIES['amplitude'])
    
    # Should generate a subtractive query
    assert 'minus' in query
    assert 'from(A)' in query
    assert 'visited(D)' in query


def test_multi_branch_split():
    G = nx.DiGraph()
    G.add_edges_from([
        ('A', 'B'), ('B', 'M'),
        ('A', 'D'), ('D', 'M'),
        ('A', 'E'), ('E', 'M')
    ])
    
    # Edge A→B with 2 competing branches (D, E)
    query = compile_query_for_edge(G, ('A', 'B'), 'amplitude', PROVIDER_CAPABILITIES['amplitude'])
    
    # Should have 2 minus terms
    assert query.count('minus') == 2
    assert 'visited(D)' in query
    assert 'visited(E)' in query


def test_native_exclude_provider():
    G = nx.DiGraph()
    G.add_edges_from([('A', 'B'), ('B', 'C'), ('A', 'D'), ('D', 'C')])
    
    # Edge A→B with custom_sql (supports native exclude)
    query = compile_query_for_edge(G, ('A', 'B'), 'custom_sql', PROVIDER_CAPABILITIES['custom_sql'])
    
    # Should use excludes() syntax
    assert 'excludes' in query
    assert 'minus' not in query
```

---

## 5. Implementation Phases

### Phase 1: Foundation (Week 1)
**Goal:** Set up schemas, parser, and test infrastructure

**Schema Updates:**
- [ ] Update `query-dsl-1.0.0.json`: add "minus" to valid functions enum
- [ ] Update `query-dsl-1.0.0.json`: add "minus" to pattern regex
- [ ] Update `query-dsl-1.0.0.json`: add example with minus()
- [ ] Optional: Update `conversion-graph-1.0.0.json`: add query field documentation
- [ ] Add connection capabilities to `connections.yaml`

**Python Parser Updates (lib/query_dsl.py):**
- [ ] Add "minus" to valid functions list
- [ ] Update grammar documentation
- [ ] Add `minus: List[ParsedQuery]` field to ParsedQuery dataclass
- [ ] Implement `_extract_minus_queries()` function (recursive)
- [ ] Update `raw` property to reconstruct minus clauses
- [ ] Add unit tests for minus parsing

**TypeScript Parser Updates (graph-editor/src/lib/queryDSL.ts):**
- [ ] Add "minus" to QUERY_FUNCTIONS constant
- [ ] Update QUERY_PATTERN regex
- [ ] Add `minus?: ParsedQueryStructured[]` to interface
- [ ] Update `validateQueryStructure()` to allow minus
- [ ] Add unit tests for minus validation

**Monaco Editor Updates (graph-editor/src/components/QueryExpressionEditor.tsx):**
- [ ] Update chip parser regex (line 90): add `minus` to function pattern
- [ ] Add minus to chip visual config (icon, styling)
- [ ] Update autocomplete: suggest `minus` after `.` when from/to exist
- [ ] Add autocomplete inside `minus(...)`: suggest full query syntax
- [ ] Update syntax validation regex patterns to allow minus
- [ ] Test chip rendering for nested minus queries

**New TypeScript Parser (graph-editor/src/lib/das/queryDslParser.ts):**
- [ ] Implement composite query parser with `parseQueryDSL()`
- [ ] Implement `splitBaseAndMinus()` helper
- [ ] Implement `parseSingleFunnel()` helper
- [ ] Add unit tests (simple, single minus, multiple minus, order independence)

**Infrastructure:**
- [ ] Implement Python provider capabilities schema
- [ ] Set up MSMDC test fixtures (diamond graph, multi-branch)

**Deliverables:**
- All schemas updated and backward compatible
- Both Python and TypeScript parsers support minus()
- Capability schema in both TS and Python
- Test suite with >90% coverage

### Phase 2: MSMDC Algorithms (Week 2)
**Goal:** Implement graph analysis and query compilation in Python

- [ ] Implement `find_minimal_merge()`
- [ ] Implement `find_separator_for_branch()` with dominance analysis
- [ ] Implement `compile_to_subtractive_query()`
- [ ] Integrate into MSMDC planner
- [ ] Test with 5+ graph topologies (diamond, nested, multi-branch, etc.)

**Deliverables:**
- MSMDC can compile excludes→minus for Amplitude
- Algorithm validation tests pass
- Documentation of separator detection logic

### Phase 3: Runtime Execution (Week 3)
**Goal:** Implement composite query execution in TypeScript

- [ ] Implement `executeCompositeQuery()` in dataOperationsService
- [ ] Implement `executeSubQuery()` helper
- [ ] Implement `combineSubtractiveResults()`
- [ ] Integrate into `getFromSourceDirect()`
- [ ] Add provider capability loading (`getProviderCapabilities()`)
- [ ] Add `validateQueryForProvider()` (prohibit excludes when unsupported)
- [ ] Add logging and error handling
- [ ] Update Monaco editor: chip rendering for minus

**Deliverables:**
- End-to-end flow: UI → parser → executor → combiner → graph update
- Provider validation enforces excludes/minus policy
- Error handling for sub-query failures

### Phase 4: Integration & Validation (Week 4)
**Goal:** End-to-end testing and production readiness

- [ ] Integration test: diamond graph with Amplitude
- [ ] Integration test: 3-branch split
- [ ] Performance test: 10 edges with 2 minus terms each (measure total time)
- [ ] Documentation updates (DAS guide, troubleshooting)
- [ ] User testing: Monaco editor autocomplete for minus
- [ ] Production rollout to test environment

**Deliverables:**
- All integration tests pass
- Performance meets targets (<2s for composite query with 2 minus terms)
- Monaco editor UX validated
- Documentation complete
- Ready for production deployment

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Component | Test Cases |
|-----------|------------|
| DSL Parser | Simple funnel, single minus, multiple minus, order independence, invalid syntax |
| Result Combiner | Normal case, over-subtract (clamp to 0), zero n (divide-by-zero guard) |
| Cache | Hit/miss, eviction, key uniqueness |
| MSMDC Separator | Diamond, nested branches, multi-branch, no common merge |
| MSMDC Compiler | Simple edge, competing branches, native exclude vs minus |

### 6.2 Integration Tests

| Scenario | Setup | Expected Result |
|----------|-------|-----------------|
| Diamond (A→B vs A→D→C) | Amplitude, k_base=800, k_D=300 | k=500, p=0.5 |
| 3-branch split | Amplitude, k_base=1000, k_D=200, k_E=300 | k=500, p=0.5 |
| Nested branches | A→B→X→C vs A→D→E→C | Correct separator detection, k accurate |

### 6.3 Performance Tests

- **Latency:** Composite query (base + 2 minus) < 2 seconds (parallel execution)
- **Sub-query duplication:** Measure how often identical sub-queries occur across edges
- **Memory:** Baseline without caching; only add if duplication >30%

---

## 7. Rollout Plan

### 7.1 Feature Flag

Add a feature flag to enable/disable subtractive queries:

```typescript
// In config or environment
const ENABLE_SUBTRACTIVE_QUERIES = process.env.ENABLE_SUBTRACTIVE_QUERIES === 'true';

if (ENABLE_SUBTRACTIVE_QUERIES && parsed.minusTerms.length > 0) {
  // Use composite execution
} else {
  // Fall back to simple execution
}
```

### 7.2 Phased Rollout

1. **Internal testing** (Week 4): Deploy to test environment, validate with known graphs
2. **Beta users** (Week 5): Enable for select users, monitor errors and performance
3. **Full rollout** (Week 6): Enable for all users, remove feature flag

### 7.3 Monitoring

- **Metrics:**
  - Sub-query execution time (p50, p95, p99)
  - Composite query success rate
  - Error rate by sub-query type
  - Sub-query duplication rate (for future caching decision)
- **Alerts:**
  - Sub-query failure rate >5%
  - Average execution time >3s

---

## 8. Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| MSMDC separator detection fails for complex graphs | High | Extensive test suite; fallback to merge_node |
| Over-subtraction (k<0) due to measurement inconsistency | Medium | Clamp k to [0, k_base]; log warnings |
| Parallel execution timeout | Medium | Timeout per sub-query; fail fast |
| Provider rate limiting | Low | Monitor and add caching only if needed |
| Monaco editor breaks with nested minus syntax | Medium | Progressive enhancement; fallback to plain text |

---

## 9. Success Criteria

- [ ] MSMDC can compile excludes→minus for all tested graph topologies
- [ ] Composite queries execute in <2s (p95)
- [ ] Cache hit rate >70% in multi-edge scenarios
- [ ] Zero regressions in simple (non-composite) queries
- [ ] All integration tests pass
- [ ] Documentation complete and reviewed

---

## 10. Open Questions & Future Work

### Open Questions
1. **Partial failures?** If 1 of 3 minus terms fails, do we fail the entire query or use partial data?
   - **Initial answer:** Fail entire composite; partial data produces incorrect k
2. **Monaco nesting UX?** How to visually represent `minus(from(...).to(...))` in chip mode?
   - **Initial answer:** Nested chips or expand to editor mode for complex queries

### Future Work (v2+)

**Optimization (only if profiling shows need):**
- **Sub-query caching:** In-memory cache keyed by canonical DSL
  - Only add if measurements show >30% sub-query duplication across edges
  - Complexity: cache key generation, eviction, invalidation
  - Alternative: rely on provider-side caching (Amplitude already caches queries)
  - Implementation: see removed sections for example code

**Additional Features:**
- **Inclusion-exclusion for multiple overlapping excludes** (add `plus()` operator for add-back terms)
- **Query optimizer:** Minimize number of minus terms via graph rewriting and dominator analysis
- **Batch API:** If provider supports batch queries, bundle all sub-queries into one request
- **Distributed caching:** Redis/Memcached for multi-instance deployments (only if single-instance cache proves valuable)

---

## Appendix A: DSL Grammar (Full EBNF - Extended)

```ebnf
query          ::= from-clause to-clause constraint*

from-clause    ::= "from(" node-id ")"
to-clause      ::= "to(" node-id ")"

constraint     ::= exclude-clause | visited-clause | visitedAny-clause | 
                   context-clause | case-clause | minus-clause

exclude-clause    ::= ".exclude(" node-list ")"
visited-clause    ::= ".visited(" node-list ")"
visitedAny-clause ::= ".visitedAny(" node-list ")"
context-clause    ::= ".context(" key ":" value ")"
case-clause       ::= ".case(" key ":" value ")"
minus-clause      ::= ".minus(" query ")"

node-list      ::= node-id ("," node-id)*
node-id        ::= [a-z0-9_-]+
key            ::= [a-z0-9_-]+
value          ::= [a-z0-9_-]+
```

**Key Points:**
- Order-independent (commutative)
- `.minus(query)` is recursive (contains a full query)
- `.exclude(a,b)` means exclude **both** a AND b
- `.visited(a,b)` means visit **both** a AND b  
- `.visitedAny(a,b)` means visit **at least one** of a OR b

---

## Appendix B: Example MSMDC Output

**Input Graph (diamond):**
```
A → B → C
A → D → C
```

**Target edge:** A→B

**Provider:** amplitude (no native exclude)

**MSMDC Output:**
```json
{
  "edge": ["A", "B"],
  "query": "from(A).to(C).minus(from(A).to(C).visited(D))",
  "provider": "amplitude",
  "connection": "amplitude-prod"
}
```

**Execution Plan:**
1. Base: `from(A).to(C)` → {from: 1000, to: 800}
2. Minus: `from(A).to(C).visited(D)` → {from: 1000, to: 300}
3. Combine: k = 800 - 300 = 500, p = 0.5

---

*End of Implementation Plan*

