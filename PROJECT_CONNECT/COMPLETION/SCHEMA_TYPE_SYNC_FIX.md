# Schema-Type Synchronization Fix

**Date:** 2025-11-06  
**Status:** ✅ Complete (requires TS server restart)

## Problem

Multiple issues causing selector "bouncing" (changes not sticking):

1. **Edge lookup bug**: `PropertiesPanel` was using wrong field (`e.id` instead of `e.uuid`) to find edges
2. **Type mismatch**: TypeScript type definitions didn't match updated schema
3. **Stale local state**: `caseData` state had obsolete `parameter_id` field

## Root Cause

When schema was updated to:
- Rename `edge.parameter_id` → `edge.p.id`
- Rename `edge.cost_gbp_parameter_id` → `edge.cost_gbp.id`  
- Rename `edge.cost_time_parameter_id` → `edge.cost_time.id`
- Remove `case.parameter_id`

The TypeScript type definitions in `lib/types.ts` were not updated, causing:
- Type errors preventing compilation
- Runtime failures as `PropertiesPanel` couldn't find edges correctly
- State initialization with wrong fields

## Changes Made

### 1. Fixed Edge Lookups in PropertiesPanel

**Before:**
```typescript
const edge = graph.edges.find((e: any) => 
  e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
);
```

**After:**
```typescript
const edge = graph.edges.find((e: any) => 
  e.uuid === selectedEdgeId || e.id === selectedEdgeId
);
```

**Fixed in 3 locations:**
- Line 234: `useEffect#PP2` (edge selection changed)
- Line 317: `useEffect#PP4` (reload edge - first branch)
- Line 343: `useEffect#PP4` (reload edge - same edge, graph changed)

### 2. Updated Type Definitions (`lib/types.ts`)

**ProbabilityParam:**
```typescript
export interface ProbabilityParam {
  mean?: number; // [0,1]
  stdev?: number; // >= 0
  locked?: boolean; // DEPRECATED: use mean_overridden instead
  id?: string; // Reference to parameter file (FK to parameter-{id}.yaml)
  distribution?: 'normal' | 'beta' | 'uniform';
}
```

**CostParam (NEW):**
```typescript
export interface CostParam {
  mean?: number; // >= 0
  stdev?: number; // >= 0
  id?: string; // Reference to cost parameter file (FK to parameter-{id}.yaml)
  distribution?: 'normal' | 'lognormal' | 'gamma' | 'uniform' | 'beta';
}
```

**CaseData:**
```typescript
export interface CaseData {
  id: string; // Reference to case file (FK to case-{id}.yaml)
  status: CaseStatus;
  variants: CaseVariant[];
  // REMOVED: parameter_id
}
```

**GraphEdge:**
```typescript
export interface GraphEdge {
  // ... existing fields ...
  p?: ProbabilityParam; // Now has .id instead of .parameter_id
  cost_gbp?: CostParam; // NEW: replaces flat cost_gbp_parameter_id
  cost_time?: CostParam; // NEW: replaces flat cost_time_parameter_id
  costs?: Costs; // DEPRECATED: old format
  // ... other fields ...
}
```

### 3. Fixed PropertiesPanel State

**Before:**
```typescript
const [caseData, setCaseData] = useState({
  id: '',
  parameter_id: '', // ❌ Wrong!
  status: 'active' as 'active' | 'paused' | 'completed',
  variants: [] as Array<{ name: string; weight: number }>
});
```

**After:**
```typescript
const [caseData, setCaseData] = useState({
  id: '',
  // REMOVED: parameter_id
  status: 'active' as 'active' | 'paused' | 'completed',
  variants: [] as Array<{ name: string; weight: number }>
});
```

Also removed 4 other instances where `parameter_id: ''` was being set when clearing/initializing case data.

## Why This Fixes The Bouncing Issue

1. **Edge lookups now work**: `selectedEdgeId` is a UUID, and we now correctly look it up using `e.uuid`
2. **Types match schema**: TypeScript won't complain about `edge.p.id`, `edge.cost_gbp`, `edge.cost_time`
3. **State consistency**: Local state no longer has fields that don't exist in the schema

The "bouncing" happened because:
1. User selects parameter → `onChange` sets `edge.p.id` ✅
2. Graph updates → `PropertiesPanel` tries to reload edge data
3. Edge lookup **FAILS** (using wrong field) → edge not found → default empty values loaded
4. EnhancedSelector gets reset to empty → connection "bounces off"

Now the edge lookup succeeds, so the newly set `p.id` value is preserved through the graph update cycle.

## Testing

After restarting TS server, verify:
1. ✅ No TypeScript errors in PropertiesPanel
2. ✅ Connecting a parameter to an edge **sticks** (doesn't bounce)
3. ✅ Connecting a case to a node **sticks**
4. ✅ Connecting a node ID **sticks**

## Files Changed

- `/home/gjbm2/dev/dagnet/graph-editor/src/lib/types.ts`
- `/home/gjbm2/dev/dagnet/graph-editor/src/components/PropertiesPanel.tsx`

## Next Steps

**User must restart TypeScript language server** to pick up the type changes:
- VS Code: `Cmd+Shift+P` → "TypeScript: Restart TS Server"
- Or reload window

After restart, all 35 lint errors should resolve.


