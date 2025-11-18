# Menu Logic Pattern: Parameters vs Cases

## Problem

Cases do not follow the same menu logic pattern as parameters across all three menus:
1. **Zap Menu** (LightningMenu → DataOperationsMenu)
2. **Context Menu** (NodeContextMenu)  
3. **Top Data Menu** (MenuBar/DataMenu)

## Correct Pattern for Parameters (Template)

### Flags Computed:
```typescript
// 1. DIRECT CONNECTION: Connection field exists on graph element (edge.p.connection)
hasDirectConnection = !!param?.connection;

// 2. FILE EXISTS: File actually exists in fileRegistry
const file = fileRegistry.getFile(`parameter-${paramId}`);
hasAnyFile = !!file;

// 3. FILE CONNECTION: File exists AND file has connection field
hasFileConnection = !!file && !!file.data?.connection;

// 4. ANY CONNECTION: Direct OR File connection
hasAnyConnection = hasDirectConnection || hasFileConnection;

// 5. CAN PUT TO FILE: File exists OR paramId exists (can create)
canPutToFile = !!file || !!paramId;
```

### Menu Items Shown:
```typescript
"Get from Source (direct)"  → shows if hasAnyConnection
"Get from Source"           → shows if hasFileConnection  
"Get from File"             → shows if hasAnyFile
"Put to File"               → shows if canPutToFile
```

## Current Bug in Cases

### DataMenu (line 565):
```typescript
// WRONG: Only checks direct connection if NO file
if (node.case?.connection && !caseId) {
  hasDirectConnection = true;
  hasAnyConnection = true;
}
```

Should be:
```typescript
// CORRECT: Check direct connection regardless of file
if (node.case?.connection) {
  hasDirectConnection = true;
  hasAnyConnection = true;
}
```

### NodeContextMenu (line 114):
```typescript
// WRONG: Only checks direct connection if NO file  
const hasDirectConnection = !!nodeData?.case?.connection && !nodeData?.case?.id;
```

Should be:
```typescript
// CORRECT: Check direct connection regardless of file
const hasDirectConnection = !!nodeData?.case?.connection;
```

### DataOperationsMenu (line 152):
```typescript
// WRONG: Only checks direct connection if NO file
hasDirectConnection = !!node?.case?.connection && !node?.case?.id;
```

Should be:
```typescript
// CORRECT: Check direct connection regardless of file
hasDirectConnection = !!node?.case?.connection;
```

## Corrected Pattern for Cases (Must Match Parameters)

```typescript
// Case node selected
const caseId = node.case?.id;

// 1. DIRECT CONNECTION: Connection field exists on node (node.case.connection)
const hasDirectConnection = !!node.case?.connection;

// 2. FILE EXISTS: Case file actually exists in fileRegistry
const file = caseId ? fileRegistry.getFile(`case-${caseId}`) : null;
const hasAnyFile = !!file;

// 3. FILE CONNECTION: File exists AND file has connection field
const hasFileConnection = !!file && !!file.data?.connection;

// 4. ANY CONNECTION: Direct OR File connection
const hasAnyConnection = hasDirectConnection || hasFileConnection;

// 5. CAN PUT TO FILE: File exists OR caseId exists (can create)
const canPutToFile = !!file || !!caseId;
```

## Implementation Status

### ✅ DataOperationsMenu (Already Fixed)
- Line 152: Removed `&& !node?.case?.id` check
- Now matches parameter pattern

### ✅ NodeContextMenu (Already Fixed)
- Line 114: Removed `&& !nodeData?.case?.id` check
- Now matches parameter pattern

### ❌ DataMenu (Still Broken)
- Line 565: Still has `&& !caseId` check
- **NEEDS FIX**

## Fix Required

**File**: `graph-editor/src/components/MenuBar/DataMenu.tsx`
**Line**: 565

**Change**:
```typescript
// BEFORE (WRONG):
if (node.case?.connection && !caseId) {
  hasDirectConnection = true;
  hasAnyConnection = true;
}

// AFTER (CORRECT):
if (node.case?.connection) {
  hasDirectConnection = true;
  hasAnyConnection = true;
}
```

## Testing Checklist

### Test Case 1: Direct Connection Only (No File)
- Node has `case.connection = "statsig-prod"`
- Node has NO `case.id` (no file)
- **Expected**:
  - ✅ "Get from Source (direct)" shown (hasAnyConnection)
  - ❌ "Get from Source" NOT shown (no file connection)
  - ❌ "Get from File" NOT shown (no file)
  - ❌ "Put to File" NOT shown (no caseId, can't create)

### Test Case 2: File Connection Only (No Direct)
- Node has `case.id = "coffee-promotion"`
- Case file exists with `connection = "statsig-prod"`
- Node has NO `case.connection`
- **Expected**:
  - ✅ "Get from Source (direct)" shown (hasAnyConnection via file)
  - ✅ "Get from Source" shown (hasFileConnection)
  - ✅ "Get from File" shown (hasAnyFile)
  - ✅ "Put to File" shown (canPutToFile)

### Test Case 3: Both Direct AND File Connection
- Node has `case.connection = "statsig-prod"` (direct)
- Node has `case.id = "coffee-promotion"`
- Case file exists with `connection = "amplitude-prod"` (file)
- **Expected**:
  - ✅ "Get from Source (direct)" shown (hasAnyConnection - both!)
  - ✅ "Get from Source" shown (hasFileConnection)
  - ✅ "Get from File" shown (hasAnyFile)
  - ✅ "Put to File" shown (canPutToFile)
  - **Note**: Direct connection takes precedence in execution

### Test Case 4: No Connections, File Exists
- Node has `case.id = "coffee-promotion"`
- Case file exists with NO `connection` field
- Node has NO `case.connection`
- **Expected**:
  - ❌ "Get from Source (direct)" NOT shown (no connections)
  - ❌ "Get from Source" NOT shown (file has no connection)
  - ✅ "Get from File" shown (hasAnyFile)
  - ✅ "Put to File" shown (canPutToFile)

### Test Case 5: No File, No Connections
- Node has NO `case.id`
- Node has NO `case.connection`
- **Expected**:
  - ❌ "Get from Source (direct)" NOT shown
  - ❌ "Get from Source" NOT shown
  - ❌ "Get from File" NOT shown
  - ❌ "Put to File" NOT shown
  - **No submenu shown at all**

## Verification Commands

After fix, verify all three menus show identical logic:

```bash
# Check NodeContextMenu
grep -A 5 "hasDirectConnection = !!" graph-editor/src/components/NodeContextMenu.tsx

# Check DataOperationsMenu
grep -A 5 "hasDirectConnection = !!" graph-editor/src/components/DataOperationsMenu.tsx

# Check DataMenu
grep -A 5 "hasDirectConnection = true" graph-editor/src/components/MenuBar/DataMenu.tsx
```

All three should have:
```typescript
hasDirectConnection = !!node.case?.connection;  // NO "&& !caseId" check
```

## Summary

**The Rule**: Check for direct connection **regardless** of whether a file exists. This matches parameter behavior and supports the use case where user has BOTH a direct connection on the node AND a file connection (direct takes precedence for execution, but both should be visible).

**Current Bug**: Three menus incorrectly restrict direct connection detection to "no file" scenarios only.

**Fix**: Remove `&& !caseId` / `&& !node?.case?.id` checks from all three menus.

**Status**: 2/3 fixed, DataMenu still needs fix.

