# Graph Schema Reference

**Source:** `/graph-editor/public/schemas/conversion-graph-1.0.0.json`
**Created:** 2025-11-25 (Phase 1 Schema Audit)

---

## Graph Structure

```json
{
  "nodes": [...],
  "edges": [...],
  "policies": {...},
  "metadata": {...}
}
```

All four fields are **required**.

---

## Node Structure

```typescript
interface Node {
  // Required
  uuid: string;                    // UUID format
  id: string;                      // Human-readable ID (1-128 chars)
  
  // Optional - Display
  label?: string;                  // Max 256 chars
  label_overridden?: boolean;      // If true, don't auto-update
  description?: string;
  description_overridden?: boolean;
  
  // Optional - Event reference
  event_id?: string;               // Direct event ID (pattern: ^[a-z0-9_-]+$)
  event?: {
    id: string;                    // Reference to events registry
    id_overridden?: boolean;
  };
  
  // Optional - Node type flags
  absorbing?: boolean;             // Default: false. If true, MUST have zero outgoing edges
  outcome_type?: 'success' | 'failure' | 'error' | 'neutral' | 'other';
  
  entry?: {
    is_start?: boolean;            // Default: false
    entry_weight?: number;         // >= 0
  };
  
  // Optional - Case node (A/B tests)
  case?: {
    uuid: string;
    id: string;
    status?: 'active' | 'paused' | 'completed';  // Default: 'active'
    connection?: string;           // Connection name from connections.yaml
    connection_string?: string;    // Provider-specific JSON
    evidence?: {...};              // Fetched variant data
    variants?: Array<{
      name: string;
      name_overridden?: boolean;
      weight: number;              // 0-1
      weight_overridden?: boolean;
    }>;
  };
  
  // Optional - Layout
  layout?: {
    x?: number;
    y?: number;
    rank?: number;                 // >= 0
    group?: string;                // Max 128 chars
    colour?: string;               // Hex color
  };
  
  // Optional - Other
  tags?: string[];
  url?: string;                    // URI format
  url_overridden?: boolean;
  images?: Array<{...}>;
  images_overridden?: boolean;
  residual_behavior?: {...};
  costs?: {...};                   // DEPRECATED - use edge costs
}
```

### Key Node Predicates for Analytics

| Field | How to detect |
|-------|---------------|
| Is entry node | `node.entry?.is_start === true` |
| Is absorbing node | `node.absorbing === true` |
| Is case node | `node.case !== undefined` |
| Is middle node | Not entry AND not absorbing |

---

## Edge Structure

```typescript
interface Edge {
  // Required
  uuid: string;                    // UUID format
  from: string;                    // Node uuid or id
  to: string;                      // Node uuid or id
  
  // Optional - Identity
  id?: string;                     // Human-readable ID (1-128 chars)
  
  // Optional - Display
  label?: string;
  label_overridden?: boolean;
  description?: string;
  description_overridden?: boolean;
  fromHandle?: 'left' | 'right' | 'top' | 'bottom' | 'left-out' | 'right-out' | 'top-out' | 'bottom-out';
  toHandle?: 'left' | 'right' | 'top' | 'bottom';
  display?: {
    conditional_colour?: string;   // Hex color
    conditional_group?: string;
  };
  
  // Optional - Query
  query?: string;                  // Pattern: ^from\([a-z0-9_-]+\)\.to\([a-z0-9_-]+\)
  query_overridden?: boolean;
  
  // Probability (optional but usually present)
  p?: ProbabilityParam;            // Base probability
  conditional_p?: ConditionalProbability[];  // Conditional probabilities
  weight_default?: number;         // For residual distribution
  
  // Cost (optional)
  cost_gbp?: CostParam;            // Monetary cost
  cost_time?: CostParam;           // Time cost
  
  // Case edge (optional)
  case_variant?: string;           // Variant name (max 128 chars)
  case_id?: string;                // Reference to parent case node ID
}
```

---

## Probability Parameter

```typescript
interface ProbabilityParam {
  mean?: number;                   // 0-1, the primary probability value
  mean_overridden?: boolean;
  stdev?: number;                  // >= 0
  stdev_overridden?: boolean;
  distribution?: 'normal' | 'beta' | 'uniform';  // Default: 'beta'
  distribution_overridden?: boolean;
  connection?: string;             // Data source connection
  connection_string?: string;      // Provider-specific JSON
  evidence?: {
    n?: number;                    // Sample size
    k?: number;                    // Success count
    window_from?: string;          // ISO date-time
    window_to?: string;
    retrieved_at: string;          // Required
    source: string;                // Required - connection name
    path?: 'direct' | 'file';
    full_query?: string;
    debug_trace?: string;
  };
  id?: string;                     // Reference to parameter file
}
```

### Getting Probability Value

```python
def get_edge_probability(edge: dict) -> float | None:
    """Extract probability from edge."""
    p = edge.get('p')
    if p is None:
        return None
    return p.get('mean')  # May be None if edge is "free"
```

---

## Conditional Probability

```typescript
interface ConditionalProbability {
  condition: string;               // DSL constraint syntax
  query?: string;                  // Full retrieval query
  query_overridden?: boolean;
  p: ProbabilityParam;             // Probability when condition matches
}
```

### Condition Syntax

Pattern: `^(visited|exclude|context|case)\(`

Examples:
- `visited(promo-viewed,feature-demo)` - visited these nodes
- `exclude(cart-abandoned)` - did NOT visit
- `context(device:mobile)` - context matches
- `case(test-2025:treatment)` - in this variant
- `visited(promo-viewed).context(device:mobile)` - combined

### Evaluating Conditional Probability

```python
def get_effective_probability(edge: dict, context: dict) -> float:
    """
    Get effective probability considering conditionals.
    
    Args:
        edge: Edge dict
        context: Current evaluation context (visited nodes, context vars, etc.)
    
    Returns:
        Effective probability value
    """
    conditional_p = edge.get('conditional_p', [])
    
    # Evaluate conditions in order, first match wins
    for cp in conditional_p:
        if evaluate_condition(cp['condition'], context):
            return cp['p'].get('mean', 0)
    
    # Fallback to base probability
    p = edge.get('p', {})
    return p.get('mean', 0)
```

---

## Cost Parameter

```typescript
interface CostParam {
  mean: number;                    // Required, >= 0
  mean_overridden?: boolean;
  stdev?: number;                  // >= 0
  stdev_overridden?: boolean;
  distribution?: 'normal' | 'lognormal' | 'gamma' | 'uniform' | 'beta';
  distribution_overridden?: boolean;
  connection?: string;
  connection_string?: string;
  evidence?: {...};                // Same structure as ProbabilityParam
  id?: string;
}
```

### Getting Cost Values

```python
def get_edge_costs(edge: dict) -> tuple[float, float]:
    """Extract monetary and time costs from edge."""
    cost_gbp = edge.get('cost_gbp', {}).get('mean', 0)
    cost_time = edge.get('cost_time', {}).get('mean', 0)
    return cost_gbp, cost_time
```

---

## Case Nodes and Edges

### Case Node Structure

```python
case_node = {
    "uuid": "...",
    "id": "checkout-experiment",
    "case": {
        "uuid": "...",
        "id": "checkout-test",
        "status": "active",
        "variants": [
            {"name": "control", "weight": 0.5},
            {"name": "treatment", "weight": 0.5}
        ]
    }
}
```

### Case Edge Structure

Edges from case nodes have `case_id` and `case_variant`:

```python
case_edge = {
    "uuid": "...",
    "from": "checkout-experiment",  # Case node
    "to": "checkout-v1",            # Variant destination
    "case_id": "checkout-test",     # Reference to case.id
    "case_variant": "control",      # Which variant
    # p is typically NOT set - weight comes from case.variants
}
```

### Getting Case Edge Probability

```python
def get_case_edge_probability(edge: dict, graph: dict) -> float:
    """Get probability for a case edge from variant weights."""
    case_id = edge.get('case_id')
    variant_name = edge.get('case_variant')
    
    if not case_id or not variant_name:
        # Not a case edge, use regular probability
        return edge.get('p', {}).get('mean', 0)
    
    # Find parent case node
    case_node = find_case_node(graph, case_id)
    if not case_node:
        return 0
    
    # Find variant weight
    variants = case_node.get('case', {}).get('variants', [])
    for v in variants:
        if v['name'] == variant_name:
            return v['weight']
    
    return 0
```

---

## Policies

```typescript
interface Policies {
  default_outcome: string;         // Required - node ID for residual
  overflow_policy?: 'error' | 'normalize' | 'cap';  // Default: 'error'
  free_edge_policy?: 'complement' | 'uniform' | 'weighted';  // Default: 'complement'
}
```

---

## Summary: Key Fields for Analytics

### Node Fields (Analytics-Relevant)

| Field | Type | Required | Analytics Use |
|-------|------|----------|---------------|
| `uuid` | string | ✓ | Node identity |
| `id` | string | ✓ | Human-readable ID |
| `absorbing` | boolean | | Detect end nodes |
| `entry.is_start` | boolean | | Detect start nodes |
| `case` | object | | Detect case/experiment nodes |

### Edge Fields (Analytics-Relevant)

| Field | Type | Required | Analytics Use |
|-------|------|----------|---------------|
| `uuid` | string | ✓ | Edge identity |
| `from` | string | ✓ | Source node |
| `to` | string | ✓ | Target node |
| `p.mean` | number | | Base probability (0-1) |
| `conditional_p` | array | | Conditional probabilities |
| `cost_gbp.mean` | number | | Monetary cost |
| `cost_time.mean` | number | | Time cost |
| `case_id` | string | | Parent case node (for case edges) |
| `case_variant` | string | | Variant name (for case edges) |

---

## Building NetworkX Graph

```python
import networkx as nx

def build_networkx_graph(graph_data: dict) -> nx.DiGraph:
    G = nx.DiGraph()
    
    # Add nodes
    for node in graph_data['nodes']:
        node_id = node['uuid']
        G.add_node(node_id,
            id=node['id'],
            absorbing=node.get('absorbing', False),
            is_entry=node.get('entry', {}).get('is_start', False),
            is_case=node.get('case') is not None,
            case_data=node.get('case'),
            **node  # Keep all original data
        )
    
    # Add edges
    for edge in graph_data['edges']:
        source = edge['from']
        target = edge['to']
        
        # Extract probability
        p_mean = edge.get('p', {}).get('mean')
        
        # Handle case edges
        if edge.get('case_id'):
            p_mean = get_case_edge_probability(edge, graph_data)
        
        G.add_edge(source, target,
            uuid=edge['uuid'],
            id=edge.get('id'),
            p=p_mean,
            conditional_p=edge.get('conditional_p', []),
            cost_gbp=edge.get('cost_gbp', {}).get('mean', 0),
            cost_time=edge.get('cost_time', {}).get('mean', 0),
            case_id=edge.get('case_id'),
            case_variant=edge.get('case_variant'),
            **edge  # Keep all original data
        )
    
    return G
```

---

*Schema Reference - Phase 1*
*Created: 2025-11-25*

