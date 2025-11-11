# Rebalance Button Flow Trace

## Complete Flow Analysis

### 1. Display Logic

**ProbabilityInput** (line 270):
- Shows button when: `showBalanceButton={true}` AND `onRebalance` is provided
- Highlights when: `isUnbalanced={true}` (yellow background #FEF3C7, border #F59E0B)

**ParameterEditor**:
- Regular probability: `showBalanceButton={paramType === 'probability'}` ✅
- Conditional probability: `showBalanceButton={paramType === 'conditional_p'}` ✅
- Variant weight: `showBalanceButton={true}` ✅

**EdgeContextMenu**:
- Regular probability: `isUnbalanced={isProbabilityUnbalanced}` ✅
- Conditional probability: `isUnbalanced={conditionalUnbalancedMap.get(cpIndex) || false}` ✅
- Variant weight: `isUnbalanced={isVariantWeightUnbalanced}` ✅

### 2. Click Handler Flow

**ProbabilityInput button click** (line 275):
```typescript
onClick={(e) => {
  e.stopPropagation();
  onRebalance(value);  // Passes current value
}}
```

**ParameterEditor wrapper**:
- Regular/conditional: `(ignoredValue: number) => onRebalance()` - ignores value ✅
- Variant weight: `(ignoredValue, ignoredIdx, ignoredVars) => onRebalance()` - ignores all args ✅

**EdgeContextMenu handlers**:
- `handleProbabilityRebalance()` - async, calls UpdateManager ✅
- `handleConditionalRebalance(cpIndex)` - async, calls UpdateManager ✅
- `handleVariantRebalance()` - async, calls UpdateManager ✅

### 3. UpdateManager Calls

All handlers call:
1. `updateManager.rebalance*()` with `forceRebalance: true`
2. `graphMutationService.updateGraph()` with callback
3. Callback calls `onUpdateGraph()` with history label

### 4. Potential Issues

1. ✅ **Signature mismatch fixed**: VariantWeightInput wrapper now accepts all 3 args
2. ✅ **isUnbalanced prop passed**: All three types receive `isUnbalanced` prop
3. ✅ **showBalanceButton set**: All three types have `showBalanceButton={true}`
4. ✅ **onRebalance provided**: All handlers are passed to ParameterEditor

### 5. Verification Checklist

- [x] Button displays when `showBalanceButton={true}` AND `onRebalance` provided
- [x] Button highlights when `isUnbalanced={true}`
- [x] Click calls `onRebalance(value)` in ProbabilityInput
- [x] ParameterEditor wrapper ignores value and calls handler
- [x] EdgeContextMenu handlers are async and call UpdateManager
- [x] UpdateManager called with `forceRebalance: true`
- [x] Graph updated via `graphMutationService.updateGraph()`
- [x] History saved with appropriate label

## Expected Behavior

1. **Display**: Button shows for all parameter types, highlights yellow when unbalanced
2. **Click**: Calls handler → UpdateManager → graphMutationService → onUpdateGraph
3. **Result**: Graph updated, button turns off (no longer unbalanced), values rebalanced

## Debugging Steps

If buttons still don't work:
1. Check browser console for errors
2. Verify `onRebalance` is not `undefined` in ParameterEditor
3. Verify `showBalanceButton` is `true`
4. Verify `isUnbalanced` is calculated correctly
5. Add console.log in handlers to verify they're called

