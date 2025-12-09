# Copy-Paste Feature Implementation Plan

## Overview

This document describes the implementation of copy-paste functionality for nodes and parameters, enabling rapid graph construction by copying file references from the Navigator and pasting them onto graph elements.

## User Workflow

The typical workflow enabled by this feature:

1. Right-click on a graph in the Navigator → 'Create new graph' (or File > New > Graph)
2. Right-click 'Copy' on a node file in the Navigator
3. Right-click 'Paste node' on the canvas (repeat to add multiple nodes)
4. Drag edges between nodes
5. Right-click 'Copy' on a parameter file in the Navigator
6. Right-click 'Paste parameter' on an edge to attach the parameter

This makes building new graphs from existing node and parameter files very fast.

## Clipboard Strategy

### Dual Storage: Memory Cache + System Clipboard

We use a **hybrid approach** with different sources for different operations:

| Action | Target | Why |
|--------|--------|-----|
| **Copy** (our menu) | System clipboard + Memory cache | Clipboard for external paste (Ctrl+V elsewhere), memory for our menus |
| **Paste** (our menu) | Read from memory cache only | Synchronous, no permission issues, reliable |
| **Ctrl+V** (manual) | System clipboard (browser native) | Not handled by us - pastes raw JSON text |

### Why Memory Cache for Paste?

Browser clipboard reading (`navigator.clipboard.readText()`) has security restrictions:
- Requires user gesture (click handler)
- May show permission prompts in some browsers
- Async operation complicates menu rendering

By using memory cache for our paste operations:
- ✅ **Synchronous** - No loading states, instant menu rendering
- ✅ **No permission prompts** - We never call `readText()`
- ✅ **Reliable** - Always works within session
- ✅ **Simple** - No async error handling needed

### Trade-offs Accepted

- ❌ Can't paste across browser tabs/windows (acceptable - rare use case)
- ❌ Lost on page refresh (acceptable - just copy again)
- ✅ Ctrl+V still works for pasting raw JSON elsewhere if needed

## Data Format

The copied data structure:

```typescript
interface DagNetClipboardData {
  type: 'dagnet-copy';
  objectType: 'node' | 'parameter' | 'case';
  objectId: string;  // The file ID (e.g., 'household-created', 'p-completion-rate')
  timestamp: number; // When copied
}
```

This format:
- Has a unique `type` field to distinguish from other clipboard content
- Contains enough information to identify the file to attach
- Includes a timestamp for potential staleness detection

## Feature Specification

### 1. Copy from Navigator (nodes, parameters, cases)

**Location**: `NavigatorItemContextMenu.tsx`

**Menu item**: "Copy" (appears for node, parameter, and case items)

**Behaviour**:
1. Build `DagNetClipboardData` object
2. Write JSON to system clipboard (for external use)
3. Store in memory cache (for our paste menus)
4. Show toast: "Copied {type}: {id}"

### 2. Paste Node on Canvas

**Location**: Canvas context menu in `GraphCanvas.tsx`

**Menu item**: "Paste node" (only visible when memory cache contains a node)

**Behaviour**:
1. Check memory cache for node reference (synchronous)
2. Create a new graph node at the click position with:
   - New UUID
   - Empty label (to be populated from file)
   - `id` field set to the copied node ID
3. Trigger "Get from file" via existing `dataOperationsService.getNodeFromFile()` codepath
4. This populates the node with label, description, etc. from the file
5. Select the new node

### 3. Paste Node on Existing Node

**Location**: `NodeContextMenu.tsx`

**Menu item**: "Paste node" (only visible when memory cache contains a node)

**Behaviour**:
1. Check memory cache for node reference (synchronous)
2. Update the selected node's `id` field to the copied node ID
3. Trigger "Get from file" via existing codepath
4. This replaces the node's label, description, etc. from the file

### 4. Paste Parameter on Edge

**Location**: `EdgeContextMenu.tsx`

**Menu item**: "Paste parameter" (only visible when memory cache contains a parameter)

**Behaviour**:
1. Check memory cache for parameter reference (synchronous)
2. Detect which parameter slot to use based on parameter type:
   - `probability` → `edge.p`
   - `cost_gbp` → `edge.cost_gbp`
   - `labour_cost` → `edge.labour_cost`
3. Set the appropriate slot's `id` field to the copied parameter ID
4. Trigger "Get from file" via existing `dataOperationsService.getParameterFromFile()` codepath
5. This populates the parameter with mean, stdev, connection, etc. from the file

## Implementation Plan

### Phase 1: Copy-Paste Context and Hook

Create a React context for the memory cache and a hook for access:

**File**: `graph-editor/src/contexts/CopyPasteContext.tsx`

```
CopyPasteContext:

State:
  copiedItem: DagNetClipboardData | null

Provider wraps app (or graph editor area)
```

**File**: `graph-editor/src/hooks/useCopyPaste.ts`

```
useCopyPaste Hook:

copyToClipboard(objectType, objectId):
  1. Build DagNetClipboardData object
  2. navigator.clipboard.writeText(JSON.stringify(data))  // For external paste
  3. setCopiedItem(data)  // Memory cache
  4. Show success toast
  5. Return success/failure

getCopiedItem():
  return copiedItem  // Synchronous read from memory cache

getCopiedNode():
  return copiedItem if objectType === 'node', else null

getCopiedParameter():
  return copiedItem if objectType === 'parameter', else null

getCopiedCase():
  return copiedItem if objectType === 'case', else null

clearCopied():
  setCopiedItem(null)
```

**Exports**:
- `CopyPasteProvider` - Context provider component
- `useCopyPaste()` - Hook returning copy/paste functions
- `DagNetClipboardData` - Type export

### Phase 2: Copy Action in Navigator

**File**: `graph-editor/src/components/NavigatorItemContextMenu.tsx`

**Changes**:
- Import `useCopyPaste` hook
- Add "Copy" menu item for node, parameter, and case items
- Wire up to `copyToClipboard()` from hook

### Phase 3: Paste Node on Canvas

**File**: `graph-editor/src/components/GraphCanvas.tsx`

**Changes**:
- Import `useCopyPaste` hook
- Check `getCopiedNode()` when rendering context menu
- Show "Paste node" item when a node is copied
- Implement paste handler that:
  1. Creates new node with copied ID
  2. Calls `dataOperationsService.getNodeFromFile()` via `useFetchData`

### Phase 4: Paste Node on Existing Node

**File**: `graph-editor/src/components/NodeContextMenu.tsx`

**Changes**:
- Import `useCopyPaste` hook
- Check `getCopiedNode()` when rendering
- Show "Paste node" item when a node is copied
- Implement paste handler that:
  1. Updates node's `id` field
  2. Calls `dataOperationsService.getNodeFromFile()` via existing `useFetchData`

### Phase 5: Paste Parameter on Edge

**File**: `graph-editor/src/components/EdgeContextMenu.tsx`

**Changes**:
- Import `useCopyPaste` hook
- Check `getCopiedParameter()` when rendering
- Show "Paste parameter" item when a parameter is copied
- Implement paste handler that:
  1. Determines correct parameter slot from file's `parameter_type`
  2. Updates edge's parameter `id` field
  3. Calls `dataOperationsService.getParameterFromFile()` via existing `useFetchData`

## Detailed Hook Design

### `useCopyPaste.ts`

```typescript
// Types
interface DagNetClipboardData {
  type: 'dagnet-copy';
  objectType: 'node' | 'parameter' | 'case';
  objectId: string;
  timestamp: number;
}

// Context (internal)
const CopyPasteContext = createContext<{
  copiedItem: DagNetClipboardData | null;
  setCopiedItem: (item: DagNetClipboardData | null) => void;
} | null>(null);

// Provider component
export function CopyPasteProvider({ children }) {
  const [copiedItem, setCopiedItem] = useState<DagNetClipboardData | null>(null);
  return (
    <CopyPasteContext.Provider value={{ copiedItem, setCopiedItem }}>
      {children}
    </CopyPasteContext.Provider>
  );
}

// Hook
export function useCopyPaste() {
  const context = useContext(CopyPasteContext);
  if (!context) throw new Error('useCopyPaste must be used within CopyPasteProvider');
  
  const { copiedItem, setCopiedItem } = context;
  
  const copyToClipboard = async (objectType: 'node' | 'parameter' | 'case', objectId: string) => {
    const data: DagNetClipboardData = {
      type: 'dagnet-copy',
      objectType,
      objectId,
      timestamp: Date.now(),
    };
    
    // Write to system clipboard (best effort - for external paste)
    try {
      await navigator.clipboard.writeText(JSON.stringify(data));
    } catch (e) {
      // Clipboard write failed - not critical, memory cache still works
      console.warn('Clipboard write failed:', e);
    }
    
    // Store in memory cache (this is what our paste menus use)
    setCopiedItem(data);
    
    toast.success(`Copied ${objectType}: ${objectId}`);
  };
  
  const getCopiedItem = () => copiedItem;
  const getCopiedNode = () => copiedItem?.objectType === 'node' ? copiedItem : null;
  const getCopiedParameter = () => copiedItem?.objectType === 'parameter' ? copiedItem : null;
  const getCopiedCase = () => copiedItem?.objectType === 'case' ? copiedItem : null;
  const clearCopied = () => setCopiedItem(null);
  
  return {
    copyToClipboard,
    getCopiedItem,
    getCopiedNode,
    getCopiedParameter,
    getCopiedCase,
    clearCopied,
  };
}
```

### Parameter Type Detection

When pasting a parameter, we need to determine which slot (`p`, `cost_gbp`, `labour_cost`) to use.

Strategy:
1. Load the parameter file from FileRegistry
2. Check `file.data.parameter_type` field
3. Map: `'probability'` → `p`, `'cost_gbp'` → `cost_gbp`, `'labour_cost'` → `labour_cost`
4. Default to `p` if type is missing or unrecognised

## Edge Cases

### File Not Found

If copied file no longer exists when pasting:
- Show error toast: "Node file not found: {id}"
- Don't modify the graph

### Node File Has No Data

If node file exists but has no data (empty file):
- Still attach the file ID
- "Get from file" will handle gracefully (no-op or warning)

### Parameter Type Mismatch

If pasting a probability parameter and user might want it in cost slot:
- Initially: Use automatic detection from file
- Future: Could add submenu "Paste as probability / Paste as cost" if needed

### Overwriting Existing Attachment

When pasting onto a node/edge that already has a file attached:
- Replace the existing file reference
- Run "Get from file" to update data
- No confirmation dialog (consistent with current selector behaviour)

### Page Refresh

Memory cache is lost on refresh:
- User simply copies again
- This is acceptable for the expected workflow

## Testing Strategy

### Manual Testing Scenarios

1. Copy node from Navigator → Paste on empty canvas → Node created with file data
2. Copy node → Paste on existing node → Node file replaced and data updated
3. Copy parameter → Paste on edge → Parameter attached and data loaded
4. Copy node → Close menu without pasting → No side effects
5. Nothing copied → Paste option not visible
6. Copy node → Refresh page → Paste option not visible (expected)
7. Copy node → Paste multiple times → Works (same node can be pasted repeatedly)

### Unit Tests

Add tests in `graph-editor/src/hooks/__tests__/useCopyPaste.test.ts`:
- `copyToClipboard` stores in memory cache
- `getCopiedNode` returns null when parameter is copied
- `getCopiedParameter` returns null when node is copied
- `clearCopied` clears the cache
- Type guards work correctly

## Dependencies

### Existing Services Used

- `dataOperationsService.getNodeFromFile()` - Fetching node data
- `dataOperationsService.getParameterFromFile()` - Fetching parameter data
- `useFetchData` hook - Wrapper for fetch operations
- `fileRegistry` - Check if files exist
- `toast` - User feedback

### New Components

- `CopyPasteProvider` - Context provider (wrap in App or graph editor)
- `useCopyPaste` - Hook for copy/paste operations

### No External Dependencies Required

All functionality uses existing browser APIs and React patterns.

## UI Considerations

### Menu Item Icons

- Copy: Use existing `Copy` icon from lucide-react
- Paste node: Could use `ClipboardPaste` or `Plus` icon
- Paste parameter: Same as Paste node

### Menu Item Labels

- "Copy" - Simple, clear
- "Paste node" - Distinguishes from generic paste
- "Paste parameter" - Clear about what's being pasted

### Menu Item Placement

- Copy: Near top of Navigator context menu (with other file actions)
- Paste node (canvas): Below "Add node"
- Paste node (node menu): Below "Properties" or in logical grouping
- Paste parameter: In the parameters section of edge menu

### Visibility

When nothing appropriate is copied:
- Hide the paste option entirely (don't show disabled)
- This keeps menus clean and avoids confusion

## Future Enhancements

Not in scope for initial implementation, but could be added later:

1. **Copy multiple items** - Select multiple Navigator items and copy as array
2. **Paste multiple nodes** - Create multiple nodes from array clipboard
3. **Copy node from graph** - Right-click node on canvas → Copy (copies file ref)
4. **Copy edge configuration** - Copy parameter setup from one edge to another
5. **Keyboard shortcuts** - Ctrl+C / Ctrl+V in Navigator and canvas
6. **Cross-tab paste** - Read from system clipboard for cross-tab support (requires permission handling)

## Summary

This feature adds copy-paste functionality via:

1. **Memory cache** for reliable, synchronous paste operations within a session
2. **System clipboard write** for external paste (Ctrl+V elsewhere)
3. **Centralised hook** (`useCopyPaste`) encapsulating all logic
4. **Existing codepaths** for data loading (`getNodeFromFile`, `getParameterFromFile`)

The implementation follows DagNet's architecture principles:
- Business logic in hook/context, not UI components
- Single codepath for similar operations
- Reuse of existing services
- Simple, reliable behaviour over complex edge case handling
