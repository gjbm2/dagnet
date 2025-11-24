# Menu Logic Fix Summary

## ✅ All Three Menus Now Fixed

### Pattern Applied: Cases Match Parameters Exactly

```typescript
// PARAMETER PATTERN (template):
hasDirectConnection = !!param?.connection;              // NO file check
hasFileConnection = !!file && !!file.data?.connection;  // File + connection
hasAnyConnection = hasDirectConnection || hasFileConnection;

// CASE PATTERN (now matches):
hasDirectConnection = !!node.case?.connection;          // NO file check  
hasFileConnection = !!file && !!file.data?.connection;  // File + connection
hasAnyConnection = hasDirectConnection || hasFileConnection;
```

---

## Fixed Files

### 1. ✅ DataOperationsMenu.tsx (Line 153)
**Before**:
```typescript
hasDirectConnection = !!node?.case?.connection && !node?.case?.id;  // WRONG
```

**After**:
```typescript
hasDirectConnection = !!node?.case?.connection;  // CORRECT
```

### 2. ✅ NodeContextMenu.tsx (Line 114)  
**Before**:
```typescript
const hasDirectConnection = !!nodeData?.case?.connection && !nodeData?.case?.id;  // WRONG
```

**After**:
```typescript
const hasDirectConnection = !!nodeData?.case?.connection;  // CORRECT
```

### 3. ✅ DataMenu.tsx (Line 565)
**Before**:
```typescript
if (node.case?.connection && !caseId) {  // WRONG
  hasDirectConnection = true;
  hasAnyConnection = true;
}
```

**After**:
```typescript
if (node.case?.connection) {  // CORRECT
  hasDirectConnection = true;
  hasAnyConnection = true;
}
```

---

## What This Fixes

### Bug Scenario (Before Fix):
1. User sets `node.case.connection = "statsig-prod"` (direct connection)
2. User also sets `node.case.id = "coffee-promotion"` (file connection)
3. **BUG**: Menu thinks there's NO direct connection (because file exists)
4. "Get from Source (direct)" not shown, even though direct connection exists

### Correct Behavior (After Fix):
1. User sets `node.case.connection = "statsig-prod"` (direct connection)
2. User also sets `node.case.id = "coffee-promotion"` (file connection)
3. **CORRECT**: Menu detects BOTH connections
4. "Get from Source (direct)" shown (uses direct connection)
5. "Get from Source" shown (uses file connection)
6. User can choose which pathway to use

---

## Menu Item Visibility Rules (All Three Menus)

| Menu Item | Condition | Explanation |
|-----------|-----------|-------------|
| **"Get from Source (direct)"** | `hasAnyConnection` | ANY connection (direct OR file) |
| **"Get from Source"** (versioned) | `hasFileConnection` | File EXISTS **AND** file has connection |
| **"Get from File"** | `hasAnyFile` | File exists |
| **"Put to File"** | `canPutToFile` | File exists OR ID exists (can create) |

---

## Test Results

### Test 1: Direct Connection Only ✅
- Setup: `node.case.connection = "statsig-prod"`, NO `case.id`
- Expected: "Get from Source (direct)" shown
- **PASS**: All three menus show it

### Test 2: File Connection Only ✅
- Setup: `case.id = "coffee-promotion"`, file has `connection = "statsig-prod"`, NO `node.case.connection`
- Expected: "Get from Source (direct)" and "Get from Source" shown
- **PASS**: All three menus show both

### Test 3: Both Connections ✅ (This was the bug)
- Setup: `node.case.connection = "statsig-prod"` AND `case.id = "coffee-promotion"` with file connection
- Expected: Both "Get from Source (direct)" and "Get from Source" shown
- **PASS**: All three menus now show both (was broken before)

### Test 4: No Connections ✅
- Setup: NO `node.case.connection`, NO file connection
- Expected: "Get from File" and "Put to File" shown (if file exists), but NO source options
- **PASS**: All three menus hide source options

---

## Code Verification

All three menus now have identical case connection logic:

```bash
# NodeContextMenu.tsx:114
const hasDirectConnection = !!nodeData?.case?.connection;

# DataOperationsMenu.tsx:153
hasDirectConnection = !!node?.case?.connection;

# DataMenu.tsx:565-568
if (node.case?.connection) {
  hasDirectConnection = true;
  hasAnyConnection = true;
}
```

**None have the `&& !caseId` check anymore** ✅

---

## Why This Matters

**Use Case**: User wants to:
1. Store case configuration in a file (`case.id`)
2. But sometimes test with a different connection directly on the node (`node.case.connection`)
3. Both should be available in the menu

**Before**: Menu would hide direct connection option if file existed  
**After**: Menu shows both options, user can choose

This matches parameter behavior where you can have BOTH:
- `edge.p.id = "conversion-rate"` (file)
- `edge.p.connection = "amplitude-prod"` (direct override)

Both connections visible, direct takes precedence in execution.

---

## Status: ✅ COMPLETE

All three menus now use **identical logic** for cases, matching the parameter pattern exactly.

**Files Changed**:
1. ✅ `graph-editor/src/components/DataOperationsMenu.tsx`
2. ✅ `graph-editor/src/components/NodeContextMenu.tsx`
3. ✅ `graph-editor/src/components/MenuBar/DataMenu.tsx`

**Documentation**:
- ✅ `/docs/current/MENU_LOGIC_FIX.md` (detailed pattern documentation)
- ✅ `/docs/current/MENU_LOGIC_FIX_SUMMARY.md` (this file)

