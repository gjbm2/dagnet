# Case Node & Variant Architecture

## Overview

Case nodes represent **A/B tests or experiments** in DagNet. They model branching paths where traffic is split between multiple variants (e.g., control vs treatment). Each variant has a **weight** (allocation percentage) that must sum to 1.0 across all variants.

## Data Model

### Type Definitions (`types/index.ts`)

```typescript
// Node type discriminator
type NodeType = 'normal' | 'case';

// Variant definition
interface CaseVariant {
  name: string;
  name_overridden?: boolean;       // If true, name was manually edited
  weight: number;                  // [0,1], must sum to 1.0 for all variants
  weight_overridden?: boolean;     // If true, weight was manually edited
  description?: string;
  description_overridden?: boolean;
  edges?: string[];                // Graph-only: edges that use this variant
}

// Evidence from external fetch
interface CaseEvidence {
  source?: string;           // Connection name (e.g., 'statsig-prod')
  fetched_at?: string;       // ISO timestamp
  path?: 'direct' | 'file';  // How data was retrieved
  full_query?: string;       // Query used for fetch
  variants?: Array<{
    variant_id?: string;
    name?: string;
    allocation?: number;
  }>;
  debug_trace?: string;
}

// Inline graph case data (on GraphNode)
interface GraphNode {
  uuid: UUID;
  id: HumanId;
  type?: NodeType;  // 'case' for case nodes
  case?: {
    id: string;     // Reference to case file (FK to case-{id}.yaml)
    status: CaseStatus;  // 'active' | 'paused' | 'completed'
    status_overridden?: boolean;
    connection?: string;         // Connection name (e.g., 'statsig-prod')
    connection_string?: string;  // JSON config
    evidence?: CaseEvidence;
    variants: CaseVariant[];
  };
}

// Edge-to-variant assignment
interface GraphEdge {
  case_variant?: string;  // Variant name this edge belongs to
  case_id?: string;       // Case node reference (FK)
}
```

### Registry File Format (`case-{id}.yaml`)

```yaml
id: checkout-experiment-2025
parameter_type: case
name: Checkout Experiment 2025
description: Testing new checkout flow
case:
  status: active
  variants:
    - name: control
      weight: 0.5
    - name: treatment
      weight: 0.5
  schedules:
    - window_from: '2025-01-01T00:00:00Z'
      variants:
        - { name: control, weight: 0.5 }
        - { name: treatment, weight: 0.5 }
      source: statsig
metadata:
  created_at: '2025-01-01T00:00:00Z'
  updated_at: '2025-01-15T10:30:00Z'
```

## Key Concepts

### 1. Case Node vs Case File

| Aspect | Case Node (Graph) | Case File (Registry) |
|--------|-------------------|----------------------|
| Location | `node.case` | `case-{id}.yaml` |
| Purpose | Runtime state | Versioned history |
| Variants | Current weights | All historical schedules |
| Connection | Reference to source | Query config |

### 2. Edge-to-Variant Assignment

Edges downstream of a case node are assigned to specific variants:

```
[Case Node: checkout-test]
    │
    ├──[variant=control]──► [Target A]
    │
    └──[variant=treatment]──► [Target B]
```

- `edge.case_variant` = variant name (e.g., "control")
- `edge.case_id` = case reference (auto-inferred from source node if missing)

### 3. Variant Weight Constraints

- All variant weights must sum to **exactly 1.0** (PMF constraint)
- Weights are [0, 1] individually
- **Rebalancing**: When one variant changes, others are auto-adjusted

### 4. Schedules (Time-Series History)

Case files store **schedules** - historical snapshots of variant allocations:

```yaml
case:
  schedules:
    - window_from: '1-Jan-25'
      variants: [{ name: control, weight: 0.5 }, { name: treatment, weight: 0.5 }]
      source: manual
    - window_from: '15-Jan-25'
      variants: [{ name: control, weight: 0.3 }, { name: treatment, weight: 0.7 }]
      source: statsig
```

**Resolution**: Uses `schedules[latest]` by `window_from` timestamp.

## Data Flows

### Flow 1: External → Graph (Direct)
**Get from Source (Direct)** - Fetch current allocations from Statsig/etc.

```
Statsig API
    │
    ▼
fetchDataService.fetchData()
    │
    ▼
dataOperationsService.getFromSourceDirect({ objectType: 'case' })
    │
    ▼
UpdateManager.handleExternalToGraph()
    │
    ▼
node.case.variants updated + auto-rebalance
```

### Flow 2: External → File → Graph (Versioned)
**Get from Source (Versioned)** - Fetch and persist to schedule history.

```
Statsig API
    │
    ▼
fetchDataService.fetchData()
    │
    ▼
dataOperationsService.getFromSourceDirect({ writeToFile: true, versionedCase: true })
    │
    ▼
UpdateManager.handleExternalToFile() → APPEND to case.schedules[]
    │
    ▼
getCaseFromFile() → schedules[latest] → node.case.variants
```

### Flow 3: File → Graph
**Get from File** - Load variant weights from case file.

```
case-{id}.yaml
    │
    ▼
dataOperationsService.getCaseFromFile()
    │
    ▼
UpdateManager.handleFileToGraph(caseFile, graphNode, 'UPDATE', 'case')
    │
    ▼
Variant merge: file variants + graph-only variants (with edges)
    │
    ▼
Auto-rebalance if needed
```

### Flow 4: Graph → File
**Put to File** - Save current variants to case file schedule.

```
node.case.variants
    │
    ▼
dataOperationsService.putCaseToFile()
    │
    ▼
UpdateManager.handleGraphToFile() → APPEND to case.schedules[]
    │
    ▼
case-{id}.yaml updated with new schedule entry
```

## Variant Synchronisation

### Merge Rules (File → Graph)

When syncing from file to graph:

1. **Match by name**: Variants are matched by their `name` field
2. **Add new**: File variants not in graph are added
3. **Preserve graph-only**: Graph variants with `edges[]` or `weight_overridden` are preserved
4. **Remove disposable**: Graph variants not in file AND no edges AND no overrides are removed

### Override Flags

| Flag | Effect |
|------|--------|
| `weight_overridden` | Don't update weight from file/external |
| `name_overridden` | Don't update name from file/external |
| `description_overridden` | Don't update description from file/external |

### Rebalancing

**`UpdateManager.rebalanceVariantWeights(graph, nodeId, variantIndex, forceRebalance)`**

When a variant weight changes:
1. **Origin variant** is preserved at its new value
2. **Other variants** are redistributed proportionally
3. **Override handling**: 
   - `forceRebalance=false`: Skip variants with `weight_overridden`
   - `forceRebalance=true`: Clear override flags and rebalance all

Example:
```
Before: [control: 0.5, treatment-a: 0.3, treatment-b: 0.2]
Change control → 0.6
After:  [control: 0.6, treatment-a: 0.24, treatment-b: 0.16]
```

## Runtime Behaviour

### Probability Calculation

Case edges multiply edge probability by variant weight:

```typescript
// In lib/whatIf.ts and lib/runner.ts
effectiveProbability = edge.p.mean × variant.weight
```

### What-If Analysis

**DSL Format**: `case(case_id:variant_name)`

Example: `case(checkout-test:treatment)` sets treatment to 100%, others to 0%.

```typescript
// Override application
if (whatIfOverride.caseId === 'checkout-test') {
  variantWeight = (edge.case_variant === 'treatment') ? 1.0 : 0.0;
}
```

### Scenario Composition

Case variants can be frozen in scenarios via param packs:
- `n.case-node.case.variants` in HRN format
- `computeEffectiveParams()` merges base graph with scenario overrides

## External Data Sources

### Statsig Adapter

- Fetches gate/experiment allocations
- Returns `variants_update` array with weights
- Connection: `statsig-prod` or custom

### Sheets Adapter

- Reads variant weights from param pack sheets
- HRN: `n.case-node.case.variants[0].weight`
- Supports contextual overrides

## UI Components

### PropertiesPanel (`PropertiesPanel.tsx`)

- Displays/edits variant list for selected case node
- Per-variant weight slider with rebalance button
- Override flag indicators

### EdgeContextMenu (`EdgeContextMenu.tsx`)

- Shows variant weight for case edges
- Edit variant weight with auto-rebalance
- Clear override / force rebalance actions

### GraphCanvas (`GraphCanvas.tsx`)

- Variant selection modal when creating edges from case nodes
- Assigns `case_variant` and `case_id` on new edges

### Beads (`edgeBeadHelpers.tsx`)

- Case variant bead type: `'variant'`
- Shows variant name and weight on edge

## Key Differences from Parameters

| Aspect | Parameters (`edge.p`) | Case Variants |
|--------|----------------------|---------------|
| Location | Edge | Node |
| Array structure | Single value | Multiple variants |
| Constraint | Individual mean | Sum to 1.0 |
| History | `values[]` array | `schedules[]` array |
| Override granularity | Per-field | Per-variant per-field |
| Rebalance scope | Sibling edges | Sibling variants |

## Test Coverage Summary

### Existing Test Files

| File | Coverage |
|------|----------|
| `variantSync.test.ts` | File→graph sync, override handling, variant merge |
| `getCaseFromFile.test.ts` | Case fetch with windowing, schedule aggregation |
| `valuesLatest.test.ts` | `schedules[latest]` resolution |
| `dataOperations.integration.test.ts` | Case roundtrips |
| `UpdateManager.rebalance.test.ts` | `rebalanceVariantWeights()` |
| `provenance.test.ts` | Case provenance tracking |
| `idPreservation.test.ts` | `case.id` preservation |
| `sheets.e2e.integration.test.ts` | Case variants from Sheets |

### Test Suites

1. **Variant Synchronisation** - `variantSync.test.ts`
   - File → Graph sync (add, preserve, remove)
   - Graph → File sync
   - Override flag handling
   - Description syncing

2. **Rebalancing** - `UpdateManager.rebalance.test.ts`
   - Basic rebalancing
   - Force vs non-force
   - PMF constraint

3. **File Operations** - `getCaseFromFile.test.ts`
   - Basic fetch
   - Windowed aggregation
   - Schedule merging

4. **Roundtrips** - `dataOperations.integration.test.ts`
   - Graph → File → Graph preservation

## API Reference

### DataOperationsService

```typescript
// Fetch case from file
getCaseFromFile(options: {
  caseId: string;
  nodeId: string;
  graph: Graph;
  setGraph: (g: Graph) => void;
  window?: { start: string; end: string };
}): Promise<void>

// Save case to file
putCaseToFile(options: {
  caseId: string;
  nodeId: string;
  graph: Graph;
}): Promise<void>

// Fetch from external source
getFromSourceDirect(options: {
  objectType: 'case';
  objectId: string;
  targetId?: string;
  graph?: Graph;
  setGraph?: (g: Graph) => void;
  writeToFile?: boolean;
  versionedCase?: boolean;
}): Promise<void>
```

### UpdateManager

```typescript
// File → Graph
handleFileToGraph(
  source: CaseFile,
  target: GraphNode,
  operation: 'UPDATE',
  subDest: 'case',
  options?: UpdateOptions
): Promise<UpdateResult>

// External → Graph
handleExternalToGraph(
  source: ExternalData,
  target: GraphNode,
  operation: 'UPDATE',
  subDest: 'case',
  options?: UpdateOptions
): Promise<UpdateResult>

// Rebalance variants
rebalanceVariantWeights(
  graph: Graph,
  nodeId: string,
  variantIndex: number,
  forceRebalance: boolean
): { graph: Graph; overriddenCount: number }

// Update edge case assignment
updateEdgeProperty(
  graph: Graph,
  edgeId: string,
  properties: { case_variant?: string; case_id?: string }
): Graph
```

## File Inventory

| Category | Files |
|----------|-------|
| Types | `types/index.ts` |
| Data Ops | `dataOperationsService.ts` |
| Update Manager | `UpdateManager.ts` |
| Window Aggregation | `windowAggregationService.ts` |
| What-If | `lib/whatIf.ts` |
| Runtime | `lib/runner.ts` |
| UI | `PropertiesPanel.tsx`, `EdgeContextMenu.tsx`, `GraphCanvas.tsx` |
| Visualisation | `edgeBeadHelpers.tsx`, `edgeLabelHelpers.tsx` |
| Tests | `variantSync.test.ts`, `getCaseFromFile.test.ts`, `UpdateManager.rebalance.test.ts` |

