# Conditional Probability (`conditional_p`) Architecture

## Overview

Conditional probabilities (`conditional_p`) are **first-class citizens** in DagNet, semantically identical to base edge probabilities (`edge.p`) but with additional complexity due to:

1. **Array indexing** - `conditional_p[idx]` vs `edge.p`
2. **DSL-based condition strings** - `visited(promo)`, `context(device:mobile)`, etc.
3. **Sibling synchronisation** - All sibling edges must have matching conditions
4. **Colour propagation** - Conditions share colours across siblings

## Data Model

### Type Definition (`types/index.ts`)

```typescript
interface ConditionalProbability {
  // WHEN this conditional applies (runtime evaluation)
  condition: string;  // "visited(promo)" or "context(device:mobile)"
  
  // HOW to fetch data from external sources
  query?: string;  // "from(checkout).to(purchase).visited(promo)"
  query_overridden?: boolean;
  
  // The probability parameter (SAME structure as edge.p)
  p: ProbabilityParam;  // { mean, stdev, n, k, distribution, connection, etc. }
  
  // Display colour
  colour?: string;
}

interface GraphEdge {
  // ...
  p?: ProbabilityParam;           // Base probability
  conditional_p?: ConditionalProbability[];  // Array of conditionals
  query?: string;                 // Base query
  // ...
}
```

### Key Principle: `conditional_p[idx].p` mirrors `edge.p`

The `p` object inside a conditional has the **same schema** as `edge.p`:
- `mean`, `stdev`, `n`, `k`
- `distribution`
- `mean_overridden`, `stdev_overridden`, etc.
- `connection`, `connection_string`
- `id` (parameter file reference)
- `data_source` (provenance)

## Reference Systems

### Two Referencing Modes

1. **Array Index** (`conditionalIndex: number`)
   - Used in data operations, UI callbacks
   - Example: `getFromSourceDirect({ conditionalIndex: 0 })`

2. **DSL Condition String** (`condition: string`)
   - Used in scenarios, param packs, what-if analysis
   - Example: `e.edge-id.visited(promo).p.mean`
   - Normalised via `normalizeConstraintString()` for stable comparison

### Synthetic Parameter IDs

For conditionals without separate parameter files:
```typescript
`synthetic:${edge.uuid}:conditional_p[${idx}]`
```

Used by MSMDC query regeneration to identify graph locations.

## Functional Areas

### 1. Data Operations

**Files:**
- `dataOperationsService.ts`
- `fetchDataService.ts`

**Operations (ALL must support `conditionalIndex`):**
- `getFromSourceDirect` - Fetch from API → graph
- `getFromSource` - Fetch from API → file → graph (versioned)
- `getParameterFromFile` - File → graph
- `putParameterToFile` - Graph → file

**Current Implementation:**
- Query selection ✅ - Uses `conditional_p[idx].query`
- Connection resolution ✅ - Falls back to `edge.p.connection`
- Result application ✅ (after fix) - Updates `conditional_p[idx].p`

### 2. Query Regeneration (MSMDC)

**Files:**
- `queryRegenerationService.ts`
- `lib/graphComputeClient.ts`

**Behaviour:**
- Generates `query` for each `conditional_p` entry based on `condition`
- Example: `condition: "visited(promo)"` → `query: "from(A).to(B).visited(promo)"`
- Respects `query_overridden` flag

**Synthetic ID parsing:**
```typescript
// synthetic:uuid:conditional_p[0] → { uuid, field: 'conditional_p[0]' }
parseSyntheticId(paramId)
```

### 3. Scenarios & Param Packs

**Files:**
- `ParamPackDSLService.ts`
- `CompositionService.ts`
- `GraphParamExtractor.ts`

**HRN (Human-Readable Name) Format:**
```
e.<edgeId>.<condition>.p.<field>
e.checkout-to-purchase.visited(promo).p.mean
```

**Note:** Uses condition string (not array index) for stable references.

**Extraction:**
```typescript
// GraphParamExtractor converts array to Record
edge.conditional_p = [{ condition: 'visited(promo)', p: { mean: 0.7 } }]
→
params.conditional_p = { 'visited(promo)': { mean: 0.7 } }
```

### 4. What-If Analysis

**Files:**
- `lib/whatIf.ts`
- `WhatIfAnalysisControl.tsx`

**DSL Format:**
```
case(case_id:treatment).visited(nodea)
```

**Override Storage:**
```typescript
conditionalOverrides: Record<string, string>  // edgeId → condition string
```

### 5. Runtime Evaluation

**Files:**
- `lib/runner.ts`
- `lib/conditionalValidation.ts`

**Probability Resolution:**
1. Check `conditionalOverrides` (what-if)
2. Check `visitedNodes` against `conditional_p` conditions
3. Fall back to `edge.p.mean`

**Constraint Evaluation:**
```typescript
evaluateConstraint(condition, visitedNodes, context, caseVariants)
```

### 6. Validation

**Files:**
- `lib/conditionalValidation.ts`
- `utils/rebalanceUtils.ts`

**Checks:**
- Probability mass sums to 1.0 per condition group
- Condition nodes are upstream (visited must precede edge)
- No circular dependencies
- Sibling edges have matching conditions

### 7. UI Components

**Files:**
- `ConditionalProbabilityEditor.tsx`
- `PropertiesPanel.tsx`
- `ParameterSection.tsx`
- `DataOperationsSections.tsx`
- `DataOperationsMenu.tsx`

**Features:**
- Add/remove conditional entries
- Edit condition string (Monaco editor)
- Edit query (with override flag)
- Parameter values (mean, stdev)
- Rebalance across siblings
- Colour assignment

### 8. Visualisation

**Files:**
- `components/edges/edgeBeadHelpers.tsx`
- `components/edges/EdgeBeads.tsx`
- `lib/conditionalColours.ts`

**Bead Types:**
```typescript
type: 'probability' | 'cost_gbp' | 'cost_time' | 'variant' | 'conditional_p'
```

Each `conditional_p` entry gets its own bead, coloured by condition.

## Key Differences from `edge.p`

| Aspect | `edge.p` | `conditional_p[idx].p` |
|--------|----------|------------------------|
| Location | `edge.p.mean` | `edge.conditional_p[idx].p.mean` |
| Query location | `edge.query` | `conditional_p[idx].query` |
| Param file | `parameter-{edge.p.id}` | `parameter-{conditional_p[idx].p.id}` (rare) |
| Reference (HRN) | `e.edge-id.p.mean` | `e.edge-id.visited(x).p.mean` |
| Synthetic ID | `synthetic:uuid:p` | `synthetic:uuid:conditional_p[0]` |
| Sibling sync | All siblings share source node | Same condition must exist on all siblings |
| Connection | `edge.p.connection` | Falls back to `edge.p.connection` |

## Parity Principle

**`conditional_p[idx].p` MUST have identical operational scope to `edge.p`.**

There is NO reduced scope for conditional probabilities. Every operation that works for `edge.p` must work identically for `conditional_p[idx].p`:

- Data operations (get/put, direct/versioned)
- Override handling
- Provenance tracking
- Parameter file support
- Connection resolution
- Sheets extraction
- Rebalancing

## Currently NOT Implemented (Future Work)

1. **`n_query`** - No explicit n-query for conditionals (edge.n_query equivalent)

## Test Coverage Requirements

Every test that exercises `edge.p` should have a parallel test for `conditional_p[idx]`:

1. **Data operations**
   - `getFromSourceDirect` with `conditionalIndex`
   - `getParameterFromFile` with `conditionalIndex`
   - `putParameterToFile` with `conditionalIndex`
   - Result applies to correct location
   - No cross-contamination with base `p`

2. **Override handling**
   - `mean_overridden`, `stdev_overridden` respected
   - Provenance (`data_source`) applied

3. **Scenarios**
   - HRN resolution: `e.edge.visited(x).p.mean`
   - Composition merges correctly
   - Beads reflect scenario values

4. **Rebalancing**
   - Conditional siblings rebalance together
   - Different conditions rebalance independently

5. **Validation**
   - Probability sum per condition group
   - Upstream node requirement

6. **Query regeneration**
   - MSMDC generates correct queries
   - `query_overridden` respected
   - Applies to correct `conditional_p` entry

## File Inventory

| Category | Files |
|----------|-------|
| Types | `types/index.ts`, `types/scenarios.ts` |
| Data Ops | `dataOperationsService.ts`, `fetchDataService.ts` |
| Query Regen | `queryRegenerationService.ts` |
| Scenarios | `ParamPackDSLService.ts`, `CompositionService.ts`, `GraphParamExtractor.ts` |
| What-If | `lib/whatIf.ts` |
| Runtime | `lib/runner.ts` |
| Validation | `lib/conditionalValidation.ts`, `utils/rebalanceUtils.ts` |
| References | `lib/conditionalReferences.ts` |
| Colours | `lib/conditionalColours.ts` |
| UI | `ConditionalProbabilityEditor.tsx`, `PropertiesPanel.tsx`, `DataOperationsSections.tsx` |
| Visualisation | `edgeBeadHelpers.tsx`, `EdgeBeads.tsx` |
| Integrity | `integrityCheckService.ts` |

