# Probability Sliders Audit Report - COMPLETE

## Summary Table with Rebalance State Tracking

| Location | Component | Param Type | Override Flag | Rebalance RECEIVES State | Rebalance SETS State (UpdateManager) | Status |
|----------|-----------|------------|---------------|-------------------------|--------------------------------------|--------|
| **EDGE CONTEXT MENU** |
| EdgeContextMenu.tsx:270 | AutomatableField + ProbabilityInput | `p` (regular) | ✅ YES (line 273) | ✅ YES (line 290: `isProbabilityUnbalanced`) | ✅ YES (line 323: `updateManager.rebalanceEdgeProbabilities`) | ✅ READY |
| EdgeContextMenu.tsx:361 | AutomatableField + ProbabilityInput | `conditional_p` | ✅ YES (line 364) | ✅ YES (line 376: `isConditionalUnbalanced`) | ✅ YES (line 435: `updateManager.rebalanceConditionalProbabilities`) | ✅ **FIXED** |
| EdgeContextMenu.tsx:437 | AutomatableField + VariantWeightInput | `case.variants[].weight` | ✅ YES (line 419) | ✅ YES (internal calc in VariantWeightInput) | ✅ YES (line 519: `updateManager.rebalanceVariantWeights`) | ✅ READY |
| **SIDEBAR (PropertiesPanel)** |
| PropertiesPanel.tsx:1844 | ParameterSection | `p` (regular) | ✅ YES (via ParameterSection) | ✅ YES (line 1856: `isEdgeProbabilityUnbalanced`) | ✅ YES (line 1851: `handleRebalanceEdgeProbability` → UpdateManager line 744) | ✅ READY |
| PropertiesPanel.tsx:1952 | ConditionalProbabilityEditor → ParameterSection | `conditional_p` | ✅ YES (via ParameterSection) | ✅ YES (line 1978: `isConditionalProbabilityUnbalanced`) | ✅ YES (line 1977: `rebalanceConditionalP` → UpdateManager line 764) | ✅ READY |
| PropertiesPanel.tsx:1617 | AutomatableField + VariantWeightInput | `case.variants[].weight` (node edit) | ✅ YES (line 1605) | ✅ YES (internal calc in VariantWeightInput) | ✅ YES (line 1647: `updateManager.rebalanceVariantWeights`) | ✅ READY |
| PropertiesPanel.tsx:2101 | AutomatableField + VariantWeightInput | `case.variants[].weight` (edge edit) | ✅ YES (line 2104) | ✅ YES (internal calc in VariantWeightInput) | ✅ YES (line 2144: `updateManager.rebalanceVariantWeights`) | ✅ READY |
| **NODE CONTEXT MENU** |
| NodeContextMenu.tsx:263 | AutomatableField + VariantWeightInput | `case.variants[].weight` | ✅ YES (line 272) | ✅ YES (internal calc in VariantWeightInput) | ✅ YES (line 327: `updateManager.rebalanceVariantWeights`) | ✅ **NEW** |

## Rebalance State Tracking Details

### Column Definitions

**Rebalance RECEIVES State**: Whether the rebalance button receives `isUnbalanced` prop to highlight when probabilities don't sum to 1.0
- ✅ YES = `isUnbalanced` prop passed to ProbabilityInput/VariantWeightInput (or calculated internally)
- ❌ NO = Missing `isUnbalanced` prop (button won't highlight)

**Rebalance SETS State (UpdateManager)**: Whether clicking rebalance calls UpdateManager to rebalance siblings
- ✅ YES = Calls UpdateManager method (preserves origin value, updates siblings)
- ❌ NO = Direct graph manipulation or missing handler

### Implementation Details

**How RECEIVES works:**
- Regular `p`: Calculated via `isProbabilityMassUnbalanced(siblings, (e) => e.p?.mean)`
- Conditional `p`: Calculated per condition group via `isProbabilityMassUnbalanced(conditionalProbsForCondition, (item) => item.p?.mean)`
- Variant weights: Calculated internally in `VariantWeightInput` component

**How SETS works:**
- All handlers call UpdateManager methods:
  - `updateManager.rebalanceEdgeProbabilities(graph, edgeId, forceRebalance)`
  - `updateManager.rebalanceConditionalProbabilities(graph, edgeId, condIndex, forceRebalance)`
  - `updateManager.rebalanceVariantWeights(graph, nodeId, variantIndex, forceRebalance)`
- All use `forceRebalance: true` when called from rebalance button
- All preserve origin value (edge/condition/variant being edited)

## All Issues Fixed ✅

### ✅ Fixed Issues

1. **EdgeContextMenu conditional probabilities** (line 361)
   - ✅ Added `isUnbalanced` calculation per condition group
   - ✅ Passes `isUnbalanced` prop to ProbabilityInput
   - ✅ UpdateManager integrated
   - ✅ Override flag displays correctly

2. **NodeContextMenu variant weights** (line 263)
   - ✅ **NEW**: Added variant weight sliders for case nodes
   - ✅ AutomatableField wrapper for override flags
   - ✅ UpdateManager integration
   - ✅ Rebalance button highlights correctly

## Testing Readiness

### ✅ ALL READY FOR TESTING (8/8 instances)

All probability sliders now have:
- ✅ Override flag display (AutomatableField wrapper)
- ✅ Rebalance button receives unbalanced state (`isUnbalanced` prop)
- ✅ Rebalance button sets state via UpdateManager
- ✅ Preserves origin values when rebalancing
- ✅ Proper handling of `_overridden` flags

**Test Cases**: See `PROBABILITY_SLIDERS_TEST_CASES.md` for comprehensive test coverage (20 test cases covering all interaction paths).
