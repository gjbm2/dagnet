# Graph-Parameter Versioning Strategy

**Problem:** When graph structure changes, parameter meanings can drift or become invalid

---

## The Problem Statement

### Scenario: Checkout Flow Restructure

**Before:**
```
[Cart] ──signup──> [Checkout] ──purchase──> [Complete]
```

**Parameter:**
```yaml
id: checkout-conversion
edge_reference: e.checkout.p.mean
visited_filter: [cart]
value: {mean: 0.55}
# Meaning: "55% of users who reach checkout (from cart) complete purchase"
```

**After:** Add new "Review" step
```
[Cart] ──signup──> [Review] ──checkout──> [Checkout] ──purchase──> [Complete]
```

**Problem:**
- Edge slug "checkout" now means something different!
- `visited_filter: [cart]` is incomplete (should include review?)
- The parameter's semantic meaning has changed
- Historical data no longer comparable

---

## The Core Issue: Parameter-Graph Coupling

Parameters are **tightly coupled** to graph structure:

| Parameter Type | Couples To | Breakage Risk |
|---------------|------------|---------------|
| **Edge parameters** | Edge slug | High - slug change breaks reference |
| **Conditional (visited)** | Node slugs | High - node rename/remove breaks |
| **Context-only** | None | Low - independent of graph structure |
| **Node parameters** | Node slug | High - node rename/remove breaks |

---

## Solution 1: Graph Versioning (RECOMMENDED)

### Every graph has a semantic version

```json
{
  "id": "checkout-flow",
  "name": "Checkout Flow",
  "version": "2.1.0",  // Semantic versioning
  "schema_version": "1.0.0",
  "nodes": [...],
  "edges": [...]
}
```

### Parameters reference graph version

```yaml
id: checkout-conversion
name: "Checkout Conversion Rate"
edge_reference: e.checkout.p.mean

# NEW: Graph version compatibility
graph_compatibility:
  graph_id: "checkout-flow"
  min_version: "2.0.0"
  max_version: "2.9.9"
  deprecated_in: "3.0.0"  # Will be removed in v3

visited_filter: [cart, review]  # Updated for v2.x

value: {mean: 0.55}

metadata:
  description: "Checkout conversion for v2.x (with review step)"
  created_at: "2025-01-15T00:00:00Z"
  graph_version_at_creation: "2.1.0"
```

### Versioning Scheme (Semantic)

```
MAJOR.MINOR.PATCH

MAJOR: Breaking changes (node/edge removed, flow restructured)
MINOR: Additive changes (new node/edge added)
PATCH: Non-structural changes (labels, metadata)
```

**Examples:**
- Add new node → `2.0.0` → `2.1.0` (minor bump)
- Remove node → `2.1.0` → `3.0.0` (major bump)
- Rename edge → `2.1.0` → `3.0.0` (major bump)
- Change node label → `2.1.0` → `2.1.1` (patch)

---

## Solution 2: Parameter Migration System

### When graph structure changes, migrate affected parameters

```typescript
interface GraphMigration {
  from_version: string;
  to_version: string;
  changes: StructuralChange[];
  parameter_migrations: ParameterMigration[];
}

interface StructuralChange {
  type: 'node_added' | 'node_removed' | 'node_renamed' | 
        'edge_added' | 'edge_removed' | 'edge_renamed' | 
        'flow_restructured';
  details: any;
}

interface ParameterMigration {
  parameter_pattern: string;  // e.g., "e.checkout.*"
  action: 'update' | 'deprecate' | 'clone' | 'alert';
  transformation?: (param: Parameter) => Parameter;
}
```

### Migration Example

```yaml
# migrations/checkout-flow-v1-to-v2.yaml
migration:
  graph_id: "checkout-flow"
  from_version: "1.0.0"
  to_version: "2.0.0"
  date: "2025-03-01T00:00:00Z"
  
  changes:
    - type: node_added
      node_slug: review
      inserted_before: checkout
      description: "Added review step before checkout"
    
    - type: edge_renamed
      old_slug: signup
      new_slug: proceed-to-review
      description: "Edge from cart now goes to review"
  
  parameter_migrations:
    # Update visited filters to include new review step
    - pattern: "*.visited_filter contains 'cart'"
      action: update
      transformation: |
        if (param.visited_filter.includes('cart') && 
            param.edge_reference.includes('checkout')) {
          param.visited_filter.push('review');
          param.metadata.updated_at = NOW();
          param.metadata.update_reason = "Added review step to visited filter (v2 migration)";
        }
    
    # Deprecate old edge parameters
    - pattern: "e.signup.*"
      action: deprecate
      message: "Edge 'signup' renamed to 'proceed-to-review' in v2.0.0"
      replacement: "e.proceed-to-review.*"
```

### Migration Runner

```typescript
export async function migrateParameters(
  graphId: string,
  fromVersion: string,
  toVersion: string
): Promise<MigrationReport> {
  
  // 1. Load migration definition
  const migration = await loadMigration(graphId, fromVersion, toVersion);
  
  // 2. Find affected parameters
  const params = await loadParametersForGraph(graphId, fromVersion);
  
  const report: MigrationReport = {
    affected: [],
    updated: [],
    deprecated: [],
    errors: []
  };
  
  // 3. Apply migrations
  for (const param of params) {
    for (const migration of migration.parameter_migrations) {
      if (matchesPattern(param, migration.pattern)) {
        try {
          switch (migration.action) {
            case 'update':
              const updated = migration.transformation(param);
              await saveParameter(updated);
              report.updated.push(param.id);
              break;
            
            case 'deprecate':
              param.metadata.status = 'deprecated';
              param.metadata.deprecation_notice = migration.message;
              param.metadata.replacement = migration.replacement;
              await saveParameter(param);
              report.deprecated.push(param.id);
              break;
            
            case 'clone':
              const newParam = cloneParameter(param, migration);
              await saveParameter(newParam);
              param.metadata.status = 'deprecated';
              await saveParameter(param);
              report.updated.push(newParam.id);
              report.deprecated.push(param.id);
              break;
            
            case 'alert':
              report.affected.push({
                param_id: param.id,
                message: migration.message
              });
              break;
          }
        } catch (err) {
          report.errors.push({
            param_id: param.id,
            error: err.message
          });
        }
      }
    }
  }
  
  return report;
}
```

---

## Solution 3: Compatibility Checking

### Detect incompatible parameters at runtime

```typescript
export function checkParameterCompatibility(
  param: Parameter,
  graph: Graph
): CompatibilityIssue[] {
  
  const issues: CompatibilityIssue[] = [];
  
  // Check graph version compatibility
  if (param.graph_compatibility) {
    if (!versionInRange(
      graph.version,
      param.graph_compatibility.min_version,
      param.graph_compatibility.max_version
    )) {
      issues.push({
        severity: 'error',
        param_id: param.id,
        message: `Parameter requires graph v${param.graph_compatibility.min_version}-${param.graph_compatibility.max_version}, but graph is v${graph.version}`
      });
    }
  }
  
  // Check visited nodes exist
  if (param.visited_filter) {
    const nodeIds = graph.nodes.map(n => n.slug);
    for (const nodeSlug of param.visited_filter) {
      if (!nodeIds.includes(nodeSlug)) {
        issues.push({
          severity: 'error',
          param_id: param.id,
          message: `Parameter references missing node: ${nodeSlug}`
        });
      }
    }
  }
  
  // Check edge reference exists
  if (param.edge_reference) {
    const ref = parseConditionalReference(param.edge_reference);
    const edgeExists = graph.edges.some(e => e.slug === ref.edgeSlug);
    if (!edgeExists) {
      issues.push({
        severity: 'error',
        param_id: param.id,
        message: `Parameter references missing edge: ${ref.edgeSlug}`
      });
    }
  }
  
  return issues;
}
```

### UI Alert

```
┌─ Parameter Compatibility Issues ──────────────────────────────┐
│                                                                │
│  ⚠️ 3 parameters incompatible with graph v2.1.0               │
│                                                                │
│  🔴 checkout-conversion                                        │
│      References missing node: "review"                         │
│      [Update Parameter] [View Details]                         │
│                                                                │
│  🔴 signup-rate                                                │
│      Edge "signup" no longer exists (renamed to "proceed")     │
│      [Migrate to New Edge] [View Details]                      │
│                                                                │
│  🟡 abandoned-cart                                             │
│      Parameter created for v1.x, may be inaccurate for v2.x   │
│      [Review Parameter] [Dismiss]                              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Solution 4: Parameter Namespaces (Per Graph Version)

### Organize parameters by graph version

```
param-registry/
├── parameters/
│   ├── checkout-flow-v1/
│   │   ├── checkout-conversion.yaml
│   │   └── signup-rate.yaml
│   │
│   ├── checkout-flow-v2/
│   │   ├── checkout-conversion.yaml  # Different meaning!
│   │   ├── review-completion.yaml    # New parameter
│   │   └── proceed-rate.yaml         # Replaces signup-rate
│   │
│   └── shared/  # Context-only parameters (work across versions)
│       ├── mobile-conversion.yaml
│       └── google-channel-rate.yaml
```

**Pros:**
- ✅ Clear separation
- ✅ Old parameters preserved for historical analysis
- ✅ No migration needed

**Cons:**
- ❌ Parameter duplication
- ❌ More complex organization
- ❌ Need to switch namespace when graph version changes

---

## Recommended Approach: Hybrid

### Combine graph versioning + compatibility checking + migrations

```yaml
# Parameter definition
id: checkout-conversion
name: "Checkout Conversion Rate"
type: probability
edge_reference: e.checkout.p.mean

# Graph compatibility (required for structural parameters)
graph_compatibility:
  graph_id: "checkout-flow"
  min_version: "2.0.0"
  max_version: "2.9.9"
  
visited_filter: [cart, review]

value: {mean: 0.55}

metadata:
  description: "Checkout conversion for v2.x (with review step)"
  graph_version_at_creation: "2.1.0"
  last_verified_with_graph_version: "2.1.0"
  
  # Migration history
  migration_history:
    - version: "2.0.0"
      date: "2025-03-01"
      change: "Added 'review' to visited_filter"
      migrated_from: "checkout-conversion-v1"
```

### Workflow

```
1. Developer changes graph structure
   ↓
2. Bump graph version (major/minor/patch)
   ↓
3. System detects affected parameters
   ↓
4. Migration tool suggests updates
   ↓
5. Data team reviews and approves
   ↓
6. Parameters migrated automatically
   ↓
7. Old parameters deprecated (not deleted)
   ↓
8. Historical analysis still works (old params + old graph version)
```

---

## Implementation in Graph Editor

### 1. Version Bump Dialog

```
┌─ Update Graph Version ────────────────────────────────────────┐
│                                                                │
│  You've made structural changes to the graph.                 │
│  Current version: 2.0.0                                        │
│                                                                │
│  Changes detected:                                             │
│  • Added node: "review"                                        │
│  • Renamed edge: "signup" → "proceed-to-review"               │
│                                                                │
│  Recommended version: 2.1.0 (minor - additive change)         │
│  [ ] Force major version (3.0.0) - breaking change            │
│                                                                │
│  Affected parameters: 8                                        │
│  [View Affected Parameters]                                    │
│                                                                │
│  [Cancel]  [Update Version & Check Parameters]                │
└────────────────────────────────────────────────────────────────┘
```

### 2. Parameter Impact Analysis

```
┌─ Parameter Impact Analysis ───────────────────────────────────┐
│                                                                │
│  Graph: checkout-flow v2.0.0 → v2.1.0                         │
│                                                                │
│  ✅ Compatible (5)                                             │
│  • mobile-conversion (context-only, no graph dependency)       │
│  • google-rate (context-only)                                  │
│  ...                                                           │
│                                                                │
│  ⚠️ Needs Update (3)                                           │
│  • checkout-conversion                                         │
│    Issue: Missing "review" in visited_filter                   │
│    Suggested: Add "review" to visited_filter                   │
│    [Apply Fix]                                                 │
│                                                                │
│  • signup-rate                                                 │
│    Issue: Edge "signup" renamed to "proceed-to-review"        │
│    Suggested: Update edge_reference                            │
│    [Apply Fix]                                                 │
│                                                                │
│  🔴 Broken (0)                                                 │
│                                                                │
│  [Apply All Fixes]  [Review Individually]  [Cancel]           │
└────────────────────────────────────────────────────────────────┘
```

---

## Historical Analysis Consideration

### Keep old parameters for historical data analysis

```yaml
# Old parameter (deprecated but not deleted)
id: checkout-conversion-v1
status: deprecated
graph_compatibility:
  graph_id: "checkout-flow"
  max_version: "1.9.9"
  deprecated_in: "2.0.0"
  
edge_reference: e.checkout.p.mean
visited_filter: [cart]  # Old structure
value: {mean: 0.60}

metadata:
  description: "Checkout conversion for v1.x (no review step)"
  deprecated_notice: "Graph restructured in v2.0.0. Use checkout-conversion-v2 instead."
```

**Why keep?**
- Historical data from v1.x still valid
- Can analyze "before review step" vs "after review step"
- Posteriors calculated with v1 params still meaningful

---

## Schema Extensions

### Graph Schema

```json
{
  "version": {
    "type": "string",
    "pattern": "^\\d+\\.\\d+\\.\\d+$",
    "description": "Semantic version of this graph"
  },
  "schema_version": {
    "type": "string",
    "description": "Schema version for compatibility"
  },
  "changelog": {
    "type": "array",
    "items": {
      "version": "string",
      "date": "string",
      "changes": ["string"],
      "breaking": "boolean"
    }
  }
}
```

### Parameter Schema Extension

```yaml
graph_compatibility:
  type: object
  properties:
    graph_id:
      type: string
      description: "ID of the graph this parameter is for"
    
    min_version:
      type: string
      pattern: '^\\d+\\.\\d+\\.\\d+$'
      description: "Minimum compatible graph version"
    
    max_version:
      type: string
      pattern: '^\\d+\\.\\d+\\.\\d+$'
      description: "Maximum compatible graph version"
    
    deprecated_in:
      type: string
      pattern: '^\\d+\\.\\d+\\.\\d+$'
      description: "Graph version in which this parameter was deprecated"

migration_history:
  type: array
  items:
    type: object
    properties:
      version:
        type: string
        description: "Graph version when migration occurred"
      date:
        type: string
        format: date-time
      change:
        type: string
        description: "What was changed"
      migrated_from:
        type: string
        description: "Original parameter ID (if cloned)"
```

---

## Summary

### YES, parameters ARE logically associated with graph structure

**The problem:**
- Parameters reference nodes/edges by slug
- Graph structure changes → parameter meaning drifts
- Need versioning to maintain semantic consistency

**The solution (recommended):**

1. **Graph versioning** - Every graph has semantic version
2. **Parameter compatibility** - Parameters declare compatible graph versions
3. **Migration system** - Semi-automated parameter updates when graph changes
4. **Compatibility checking** - Runtime validation of param-graph consistency
5. **Deprecation (not deletion)** - Old parameters kept for historical analysis

### Implementation Priority

**v1 (Now):**
- ✅ Add `version` field to graphs
- ✅ Add `graph_compatibility` to parameters
- ✅ Basic compatibility checking (warn on mismatch)

**v2 (Later):**
- ✅ Migration system
- ✅ Automated parameter updates
- ✅ Migration history tracking
- ✅ Parameter impact analysis UI

This ensures parameters stay semantically meaningful as graphs evolve!



