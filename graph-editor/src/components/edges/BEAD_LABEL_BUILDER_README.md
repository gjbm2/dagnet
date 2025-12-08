# Bead Construction Architecture - Standardized Pattern

## Overview

The bead system uses a **two-layer architecture** to ensure consistency:

1. **`buildParameterBead()`** - Generic function that handles parameter extraction and bead construction
2. **`BeadLabelBuilder`** - Class that handles formatting and display logic

This eliminates duplicate code and ensures all parameters (probability, cost_gbp, labour_cost) follow identical patterns.

## Layer 1: BeadLabelBuilder (Formatting)

`BeadLabelBuilder` is responsible for:

- **Checking if values are identical across scenarios** (including both mean AND stdev)
- **Formatting display text** with proper colour coding
- **Handling hidden current values**
- **Applying formatters uniformly**

## Layer 2: buildParameterBead() (Extraction & Construction)

The generic `buildParameterBead()` function handles:

- **Checking if parameter exists in ANY layer** (not just current/base)
- **Extracting values from all visible layers** (using proper compositing)
- **Delegating to BeadLabelBuilder** for formatting
- **Constructing BeadDefinition** objects

## Problems Solved

### Problem 1: Inconsistent stdev comparison

Previously, the logic for "exploding out" parameters that vary by layer was inconsistent. For example:

```typescript
// OLD (WRONG): Only checks mean values
const allIdentical = values.every(v => v.value === values[0].value);
```

This would incorrectly deduplicate these scenarios:
- Scenario 1: `50% ± 5%`
- Scenario 2: `50% ± 10%`

Even though the standard deviations differ, they would show as just `50%`, losing critical information.

## The Solution

`BeadLabelBuilder` properly checks **both value AND stdev**:

```typescript
// NEW (CORRECT): Checks both value and stdev
areAllValuesIdentical(): boolean {
  if (this.values.length === 0) return false;
  
  const first = this.values[0];
  return this.values.every(v => 
    v.value === first.value && v.stdev === first.stdev
  );
}
```

Now the same scenarios correctly show: `50% ± 5%` (blue) `50% ± 10%` (orange)

### Problem 2: Missing beads for scenario-only parameters

Previously, if a cost existed ONLY in a scenario layer (not in current or base), we would never create the bead:

```typescript
// OLD (WRONG): Only checks current and base
if (edge.cost_gbp || baseParams.edges[key]?.cost_gbp) {
  // Create bead
}
```

This meant costs added in Scenario 1 wouldn't show at all!

Now `buildParameterBead()` checks ALL layers:

```typescript
checkExists: () => {
  if (edge.cost_gbp) return true;  // Check current
  if (baseParams.edges[key]?.cost_gbp) return true;  // Check base
  // Check ALL visible scenarios
  for (const scenarioId of orderedVisibleIds) {
    const cost = getEdgeCostGBPForLayer(scenarioId, edge, graph, ctx);
    if (cost?.mean !== undefined) return true;
  }
  return false;
}
```

### Problem 3: Duplicate logic everywhere

Each parameter (probability, cost_gbp, labour_cost) had its own copy-pasted loop with slight variations and bugs.

Now there's ONE generic function used by all parameters.

## Usage

### Standard Pattern (Recommended)

Use `buildParameterBead()` which handles everything:

```typescript
// Probability bead
const probBead = buildParameterBead({
  beadType: 'probability',
  checkExists: () => true, // Every edge has probability
  extractFromLayer: (layerId) => {
    const { probability, stdev } = getEdgeProbabilityForLayer(layerId, edge, graph, ctx, whatIfDSL);
    return { value: probability, stdev };
  },
  buildLabel: BeadLabelBuilder.buildProbabilityLabel,
  backgroundColor: '#000000',
  hasParameterConnection: !!edge.p?.id,
  baseDistance,
  beadIndex: beadIndex,
  orderedVisibleIds,
  currentVisible,
  getScenarioColour
});

if (probBead) {
  beads.push(probBead);
  beadIndex++;
}

// Cost GBP bead - SAME PATTERN
const costGBPBead = buildParameterBead({
  beadType: 'cost_gbp',
  checkExists: () => {
    // Check current, base, and ALL visible scenarios
    if (edge.cost_gbp) return true;
    if (baseParams.edges?.[edgeKey]?.cost_gbp) return true;
    for (const scenarioId of orderedVisibleIds) {
      if (scenarioId === 'current' || scenarioId === 'base') continue;
      const cost = getEdgeCostGBPForLayer(scenarioId, edge, graph, ctx);
      if (cost?.mean !== undefined) return true;
    }
    return false;
  },
  extractFromLayer: (layerId) => getEdgeCostGBPForLayer(layerId, edge, graph, ctx),
  buildLabel: BeadLabelBuilder.buildCostGBPLabel,
  backgroundColor: '#000000',
  hasParameterConnection: !!edge.cost_gbp?.id,
  baseDistance,
  beadIndex: beadIndex,
  orderedVisibleIds,
  currentVisible,
  getScenarioColour
});

if (costGBPBead) {
  beads.push(costGBPBead);
  beadIndex++;
}
```

**Key points:**
- `checkExists()` checks ALL layers (not just current/base)
- `extractFromLayer()` uses existing `getXForLayer()` functions (which handle compositing correctly)
- `buildLabel` uses BeadLabelBuilder static methods
- Returns `null` if parameter doesn't exist anywhere

### For Custom Formatters

```typescript
const customFormatter = (value: number | string, stdev?: number) => {
  return `${value}${stdev ? ` ± ${stdev}` : ''}`;
};

const label = BeadLabelBuilder.buildCustomLabel(
  values, 
  hiddenCurrent, 
  customFormatter
);
```

### Checking If Hidden Current Differs

When you need to determine whether to include hidden current:

```typescript
const tempBuilder = new BeadLabelBuilder(
  probValues, 
  { value: probability, stdev }, 
  formatProbability as (v: number | string, stdev?: number) => string
);

if (!tempBuilder.doesHiddenCurrentMatch()) {
  hiddenCurrentProb = { value: probability, stdev };
}
```

## Key Methods

### `areAllValuesIdentical(): boolean`
Checks if all values are identical (both value AND stdev). This is the **correct** way to check for deduplication.

### `doesHiddenCurrentMatch(): boolean`
Checks if hidden current matches all visible values (both value AND stdev).

### `shouldFullyDeduplicate(): boolean`
Returns true only if all visible values are identical AND hidden current matches. Use this for the `allIdentical` flag.

### `buildDisplayText(): React.ReactNode`
Builds the display text with proper colour coding:
- White text for deduplicated values
- Scenario colours for differing values
- Grey text in brackets for hidden current (when it differs)

## Static Formatters

Pre-built formatters are available as static methods:

- `BeadLabelBuilder.formatProbability(value, stdev)` - Converts 0-1 to percentage with optional ± stdev
- `BeadLabelBuilder.formatCostGBP(value, stdev)` - Formats as £X.XX with optional ± stdev
- `BeadLabelBuilder.formatCostTime(value, stdev)` - Formats as X.Xd with optional ± stdev

## Examples

### Example 1: All Identical (No Stdev)
```typescript
const values = [
  { scenarioId: 's1', value: 0.5, color: '#3b82f6' },
  { scenarioId: 's2', value: 0.5, color: '#f97316' },
];

const label = BeadLabelBuilder.buildProbabilityLabel(values, undefined);
// Result: "50%" (white text)
// allIdentical: true
```

### Example 2: Different Stdev (Correctly Exploded)
```typescript
const values = [
  { scenarioId: 's1', value: 0.5, stdev: 0.05, color: '#3b82f6' },
  { scenarioId: 's2', value: 0.5, stdev: 0.10, color: '#f97316' },
];

const label = BeadLabelBuilder.buildProbabilityLabel(values, undefined);
// Result: "50% ± 5%" (blue) "50% ± 10%" (orange)
// allIdentical: false
```

### Example 3: Hidden Current Differs
```typescript
const values = [
  { scenarioId: 's1', value: 0.5, stdev: 0.05, color: '#3b82f6' },
];
const hiddenCurrent = { value: 0.6, stdev: 0.05 };

const label = BeadLabelBuilder.buildProbabilityLabel(values, hiddenCurrent);
// Result: "50% ± 5%" (white) " (60% ± 5%)" (grey)
// allIdentical: false (because hidden differs)
```

### Example 4: Hidden Current Stdev Differs
```typescript
const values = [
  { scenarioId: 's1', value: 0.5, stdev: 0.05, color: '#3b82f6' },
];
const hiddenCurrent = { value: 0.5, stdev: 0.10 };

const label = BeadLabelBuilder.buildProbabilityLabel(values, hiddenCurrent);
// Result: "50% ± 5%" (white) " (50% ± 10%)" (grey)
// allIdentical: false (because stdev differs)
```

## Architecture Benefits

### 1. Compositing is Correct
The `extractFromLayer()` functions already handle compositing properly:

```typescript
function getEdgeCostGBPForLayer(layerId, edge, graph, ctx) {
  if (layerId === 'current') return edge?.cost_gbp;
  if (layerId === 'base') return ctx.baseParams.edges[key]?.cost_gbp;
  
  // For scenarios: use centralized composition
  const composedParams = getComposedParamsForLayer(
    layerId,
    ctx.baseParams,
    ctx.currentParams,
    ctx.scenarios
  );
  return composedParams.edges[key]?.cost_gbp;
}
```

`buildParameterBead()` just calls these functions - it doesn't reimplement compositing.

### 2. Single Source of Truth
- **Parameter extraction**: `getXForLayer()` functions
- **Formatting logic**: `BeadLabelBuilder` class  
- **Construction pattern**: `buildParameterBead()` function

### 3. Easy to Add New Parameters
To add a new parameter type:

1. Write `getEdgeXForLayer()` function (following existing pattern)
2. Add formatter to `BeadLabelBuilder` if needed
3. Call `buildParameterBead()` in `buildBeadDefinitions()`

No duplicate code to maintain!

## Important Notes

1. **Always use BeadLabelBuilder** for any new bead label construction
2. **Never manually check `allIdentical`** - use `shouldFullyDeduplicate()` instead
3. **Both value AND stdev must match** for values to be considered identical
4. The `formatBeadText()` function is now deprecated and delegates to BeadLabelBuilder
5. All standard formatters are available as static methods

## Testing

When testing bead labels, verify:
- [ ] Values with same mean but different stdev show both
- [ ] Values with same mean AND stdev are deduplicated
- [ ] Hidden current with different stdev is shown in brackets
- [ ] White text for deduplicated values
- [ ] Coloured text for differing values
- [ ] Grey text in brackets for hidden current

## Related Files

- `BeadLabelBuilder.tsx` - The main class
- `edgeBeadHelpers.tsx` - Uses BeadLabelBuilder for all bead construction
- `EdgeBeads.tsx` - Renders the beads (uses definitions from edgeBeadHelpers)

