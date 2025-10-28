# State Management Analysis Summary

## Current Architecture Overview

The application has moved from a **global graph store** to a **per-file graph store** architecture, but there are significant implementation inconsistencies causing the massive linter errors.

## Data Flow Architecture

### 1. File-Level Data Storage (TabContext)
- **FileRegistry**: Single source of truth for file data
- **FileState**: Stores raw file data (JSON/YAML content)
- **useFileState**: Hook to access file data from FileRegistry
- **Data Location**: `FileState.data` contains the raw graph JSON

### 2. Graph-Level Data Storage (GraphStoreContext)  
- **GraphStore**: Per-file Zustand store for interactive graph operations
- **GraphStoreProvider**: Creates one store instance per file (not per tab)
- **useGraphStore**: Hook to access the graph store
- **Data Location**: `GraphStore.graph` contains the processed graph data

### 3. ReactFlow Data Storage
- **useNodesState/useEdgesState**: ReactFlow's internal state management
- **Data Location**: ReactFlow's internal state (transformed from GraphStore)

## Current Data Flow

```
FileState.data (raw JSON) 
    ↓ (GraphEditor syncs via useEffect)
GraphStore.graph (processed data)
    ↓ (GraphCanvas transforms via toFlow)
ReactFlow nodes/edges (ReactFlow format)
```

## The Problem: Type Mismatch

### Issue 1: GraphData Interface Mismatch
- **Current**: `GraphData` interface defined as ReactFlow format
- **Should Be**: Raw graph data format matching schema
- **Impact**: TypeScript errors when accessing `from`, `to`, `p`, etc. properties

### Issue 2: Mixed Data Sources in GraphCanvas
- **GraphCanvas** receives data from **GraphStore** (via `useGraphStore()`)
- **GraphStore.graph** should contain raw graph data
- **But**: Code expects ReactFlow format in some places

### Issue 3: Transform Function Confusion
- **toFlow()**: Converts raw graph → ReactFlow format
- **fromFlow()**: Converts ReactFlow format → raw graph
- **Problem**: GraphCanvas works with raw data but TypeScript thinks it's ReactFlow data

## Root Cause Analysis

The issue is that **GraphCanvas.tsx** is designed to work with **raw graph data** (from GraphStore), but:

1. **TypeScript types** are defined as ReactFlow format
2. **Some code paths** expect ReactFlow format
3. **Data transformation** is inconsistent

## Current State Verification

### ✅ Correctly Implemented:
- FileRegistry stores raw file data per file
- GraphStoreProvider creates per-file stores
- GraphEditor syncs FileState → GraphStore
- Multiple tabs share same GraphStore per file

### ❌ Implementation Issues:
- GraphData interface is wrong format
- GraphCanvas type expectations are wrong
- Mixed data format handling
- 188 TypeScript errors due to type mismatches

## Required Fixes

### 1. Fix GraphData Interface
- Update `GraphData` to match raw graph schema format
- Ensure `from`, `to`, `p`, `case`, etc. properties are available

### 2. Fix GraphCanvas Data Handling
- Ensure GraphCanvas works with raw graph data from GraphStore
- Fix type annotations to match actual data structure
- Remove ReactFlow type assumptions where inappropriate

### 3. Verify Data Flow Consistency
- Ensure GraphStore.graph contains raw graph data
- Ensure toFlow/fromFlow transformations work correctly
- Ensure ReactFlow state is properly managed

## Next Steps

1. **Fix GraphData interface** to match raw schema
2. **Update GraphCanvas type annotations** to match actual data
3. **Verify GraphStore data format** is correct
4. **Test data flow** from FileState → GraphStore → ReactFlow
5. **Resolve remaining TypeScript errors**

## Impact Assessment

- **Critical**: 188 TypeScript errors preventing build
- **Functional**: Graph editing may work but with type safety issues
- **Maintenance**: Code is difficult to maintain due to type confusion
- **Performance**: No performance impact, just type safety

## Conclusion

The per-file graph store architecture is correctly implemented, but the TypeScript types and some code paths are still expecting the old global/ReactFlow format. This is a **type system issue**, not a fundamental architecture problem.

The fix requires updating the type definitions to match the actual data flow and ensuring consistent data format handling throughout the GraphCanvas component.
