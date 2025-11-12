# UUID as Primary Key Refactor

## Problem Statement

The codebase currently has inconsistent ID usage:
- **React Flow** uses `node.uuid` as the node ID
- **Graph schema** uses `node.id` (human-readable, user-editable) in many places
- **Hidden nodes**, **edge references** (`e.from`, `e.to`), and other internal structures store human-readable IDs
- **User can create duplicate human-readable IDs**, breaking assumptions

This creates bugs when:
- Deleting nodes (can't find by ID if duplicate exists)
- Hiding nodes (wrong node gets hidden)
- Referencing edges (ambiguous source/target)
- Any operation that assumes ID uniqueness

## Current State

### What Uses UUIDs (Correct ✅)
- React Flow node IDs (`node.id` in React Flow = `node.uuid` in graph)
- `handleUpdateNode` - finds by UUID (line 1044)
- `handleUpdateEdge` - finds by UUID (line 1118)
- `handleDeleteNode` - uses UUID from keyboard (line 71 in ConversionNode)

### What Uses Human-Readable IDs (Problem ❌)
- `hiddenNodes` Set in tab state
- Edge references: `edge.from`, `edge.to` in graph schema
- `hideUnselectedNodes` - gets IDs from `node.id` (line 1272 in TabContext)
- Context menu delete - was passing UUID but comparing against human ID
- All graph edge filtering operations

## Proposed Solution

### Phase 1: Internal State (Immediate Fix)
**Use UUIDs for all internal runtime state**

1. **Tab State**: Change `hiddenNodes: Set<string>` to store UUIDs
   - Update `hideNode`, `unhideNode`, `hideUnselectedNodes`, `isNodeHidden` in TabContext
   - Update GraphCanvas hidden state effect (lines 1525-1554)

2. **Context Menu Operations**: Always pass/use UUIDs
   - ✅ Already fixed for delete
   - Update hide/unhide in NodeContextMenu to use React Flow IDs (UUIDs)

3. **Selection State**: Verify all selection operations use UUIDs

### Phase 2: Schema (Breaking Change)
**Change edge references to use UUIDs**

Current schema:
```json
{
  "edge": {
    "from": "homepage",  // ❌ Human-readable ID
    "to": "checkout"     // ❌ Human-readable ID
  }
}
```

Proposed schema:
```json
{
  "edge": {
    "from": "550e8400-e29b-41d4-a716-446655440000",  // ✅ UUID
    "to": "660e9500-f39c-52e5-b827-557766551111"     // ✅ UUID
  }
}
```

**Migration Strategy**:
- Add schema version check
- On load, if old schema, convert `from`/`to` from human IDs to UUIDs
- Save in new format
- Update all graph operations to use UUID references

### Phase 3: Validation (Safety Net)
**Enforce uniqueness at schema level**

1. **On Graph Load**: Validate all human-readable IDs are unique
2. **On ID Update**: Prevent duplicate IDs (already exists at line 1035, but enhance)
3. **JSON Editor**: Add uniqueness validation (currently missing)
4. **File Import**: Check for duplicate IDs and auto-suffix

## Implementation Priority

### Critical (Do Now) 🔴
- [x] Fix context menu delete to use UUID lookup
- [ ] Fix `hiddenNodes` to use UUIDs instead of human-readable IDs
- [ ] Fix hide/unhide operations in NodeContextMenu
- [ ] Update GraphCanvas hidden state effect to use UUIDs

### High Priority (Next Sprint) 🟡
- [ ] Change edge schema to use UUID references
- [ ] Migration helper for old graphs
- [ ] Update all edge filtering to use UUIDs
- [ ] Add JSON editor validation for duplicate IDs

### Medium Priority (Future) 🟢
- [ ] Add schema-level uniqueness validation
- [ ] Auto-suffix duplicate IDs on import
- [ ] Add UI warning when user tries to create duplicate ID

## Affected Files

### Immediate (Phase 1)
- `/graph-editor/src/contexts/TabContext.tsx` - hiddenNodes Set
- `/graph-editor/src/components/GraphCanvas.tsx` - hidden state effect
- `/graph-editor/src/components/NodeContextMenu.tsx` - hide/unhide operations

### Future (Phase 2-3)
- `/graph-editor/public/schemas/schema/conversion-graph-1.0.0.json` - edge schema
- `/graph-editor/src/lib/transform.ts` - edge transformation
- `/graph-editor/src/lib/runner.ts` - edge traversal
- `/graph-editor/src/components/JsonSection.tsx` - validation
- `/graph-editor/src/components/JsonSectionHeader.tsx` - validation

## Testing Checklist

- [ ] Create node with duplicate ID
- [ ] Hide node with duplicate ID - verify correct one hidden
- [ ] Delete node with duplicate ID - verify correct one deleted
- [ ] Create edge between nodes with duplicate IDs - verify correct connection
- [ ] Load old graph file - verify migration works
- [ ] Export/import graph - verify IDs preserved

## Notes

- UUIDs are immutable system identifiers (never change)
- Human-readable IDs are mutable user-friendly labels (can change, can duplicate)
- **Never use human-readable IDs as primary keys for internal operations**
- **Always use UUIDs for references in state/operations**
- Only display human-readable IDs in UI for user convenience

