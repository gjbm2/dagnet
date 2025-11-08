# Data Retrieval Query Construction

**Status**: NOT YET IMPLEMENTED - This document describes future work

---

## Problem Statement

Query DSL strings serve **three distinct purposes**:

### 1. Topology Filtering (✅ IMPLEMENTED in `graph_query.py`)
Prune graph to return subgraph matching path constraints.
```python
graph_query.apply_query_to_graph(graph, "from(a).to(d).exclude(e)")
# Returns: {nodes: [...], edges: [...]} - pruned graph structure
```

### 2. Conditional Metadata (✅ SCHEMA DEFINED)
Semantic constraint for when an edge's probability applies.
```json
{
  "from": "c",
  "to": "d",
  "conditional_p": [{
    "condition": "visited(b)",  // SEMANTIC: when this applies
    "query": "...",              // DATA RETRIEVAL: how to fetch n/k
    "p": {"mean": 0.25}
  }]
}
```

### 3. Data Retrieval Query Construction (❌ NOT IMPLEMENTED)
Build queries for external data sources (Amplitude, etc.) to fetch n/k.

---

## Critical Cases Requiring Logic

### Case 1: Edge C→D with Condition "visited(b)"
**Graph**: A>B, B>C, C>D, A>E, E>C

**Edge Definition**:
```json
{
  "from": "c",
  "to": "d",
  "conditional_p": [{
    "condition": "visited(b)",
    "query": "from(b).to(d).visited(c)",  // ← Must be auto-generated
    "p": {"mean": 0.25}
  }]
}
```

**Logic**:
- `condition: "visited(b)"` = semantic constraint
- `query: "from(b).to(d).visited(c)"` = data retrieval path
- Send to Amplitude: count users who went B→C→D
- Return: n=1000, k=250
- Apply: P(D|C, came-through-B) = 0.25 to edge C→D

**Key Insight**: The query includes the full path from condition source (B) through the edge endpoints (C→D), but we're measuring just the C→D segment.

---

### Case 2: Multi-Parent Direct Edge (CRITICAL!)
**Graph**: A>B, B>C, A>C (two paths from A to C)

**Problem**: How to measure P(A→C) for the **DIRECT** edge (not through B)?

**Edge Definition**:
```json
{
  "from": "a",
  "to": "c",
  "query": "from(a).to(c).exclude(b)",  // ← Must exclude alternate path!
  "p": {"mean": 0.15}
}
```

**Logic**:
- Direct edge A→C exists alongside indirect path A→B→C
- To measure P(A→C direct), we must **exclude B** from the data query
- Send to Amplitude: `from(a).to(c).exclude(b)`
- This counts users who went A→C **without** passing through B
- Return: n=1000, k=150 → P(C|A, direct) = 0.15

**Key Insight**: `exclude()` in data retrieval is NOT about pruning graph structure - it's about filtering data to isolate specific paths when multiple routes exist.

---

### Case 3: Implicit Upstream Conditions
**Graph**: A (case node) → B → C → D

If A is a case node (A/B test), ALL downstream edges have implicit case context.

**Edge C→D Definition**:
```json
{
  "from": "c",
  "to": "d",
  "query": "from(c).to(d).case(test-id:treatment)",  // ← Implicit case context
  "p": {"mean": 0.3}
}
```

**Logic**:
- Even if edge C→D doesn't explicitly mention the case
- If there's a case node upstream, the query must include case context
- This ensures we're measuring P(D|C) for the specific variant

**Key Insight**: Must walk upstream to detect implicit conditions (case, context, etc.) and include them in data retrieval queries.

---

## Implementation Requirements (Future Work)

### Function Signature:
```python
def build_data_retrieval_query(
    graph: Graph,
    edge: Edge,
    conditional: Optional[ConditionalProbability] = None
) -> str:
    """
    Auto-generate data retrieval query for an edge's probability.
    
    Args:
        graph: Full graph structure
        edge: Edge to measure
        conditional: Optional conditional probability (if measuring conditional)
    
    Returns:
        Query string suitable for external data source (Amplitude, etc.)
    
    Examples:
        # Simple edge
        >>> build_data_retrieval_query(graph, edge_c_to_d)
        "from(c).to(d)"
        
        # Edge with explicit condition
        >>> build_data_retrieval_query(graph, edge_c_to_d, cond_visited_b)
        "from(b).to(d).visited(c)"
        
        # Multi-parent direct edge
        >>> build_data_retrieval_query(graph, edge_a_to_c_direct)
        "from(a).to(c).exclude(b)"  # Exclude alternate path
        
        # Edge with implicit case context
        >>> build_data_retrieval_query(graph, edge_c_to_d)
        "from(c).to(d).case(test-id:treatment)"  # Auto-detected case node upstream
    """
    pass
```

### Key Logic:
1. **Start from condition source** (if conditional) or edge source (if base)
2. **End at edge target**
3. **Detect alternate paths** - if multiple routes exist, use `exclude()` to isolate
4. **Walk upstream** to find implicit conditions (case, context)
5. **Preserve all constraints** in final query string

### Test Cases Needed:
- [ ] Simple edge (no conditions)
- [ ] Edge with explicit `visited()` condition
- [ ] Multi-parent with direct edge (must exclude alternate)
- [ ] Implicit case context upstream
- [ ] Implicit context constraints
- [ ] Multiple conditions combined
- [ ] Diamond graph with multiple convergence points

---

## Related Files
- `lib/graph_query.py` - Topology filtering (implemented)
- `lib/query_dsl.py` - DSL parser (implemented)
- `lib/graph_types.py` - Schema types (implemented)
- `graph-editor/public/schemas/schema/conversion-graph-1.0.0.json` - Schema authority

---

**Next Steps**: Implement `lib/data_retrieval_query.py` module with logic described above.

