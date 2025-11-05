# Systematic Loop Analysis: MAIN → BROKEN → TEMP

## Key Finding: MAIN ALSO HAD FULL DEPENDENCY ARRAY

Main's sync effect dependency array:
```typescript
}, [graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, activeTabId, tabs]);
```

## Candidates for Loop Cause

### CANDIDATE 1: Tab State Persistence (GraphEditor)

**MAIN:**
- No tab state persistence of selection

**BROKEN:**
```typescript
useEffect(() => {
  if (tabId) {
    tabOps.updateTabState(tabId, { selectedObject });
  }
}, [selectedObject, tabId, tabOps]);
```

**TEMP:**
- Same as BROKEN (still enabled)

**VERDICT:** Not the cause (present in both BROKEN and TEMP)

---

### CANDIDATE 2: Locally Created Callback Wrappers (GraphCanvas)

**MAIN:**
- `onSelectedNodeChange` and `onSelectedEdgeChange` received as **props** from parent
- Stable references (don't recreate on every render of GraphCanvas)

**BROKEN:**
```typescript
const onSelectedNodeChange = useCallback((id: string | null) => {
  onSelectObject(id ? { type: 'node', id } : { type: 'graph', id: null });
}, [onSelectObject]);

const onSelectedEdgeChange = useCallback((id: string | null) => {
  onSelectObject(id ? { type: 'edge', id } : { type: 'graph', id: null });
}, [onSelectObject]);

const onSelectedPostitChange = useCallback((id: string | null) => {
  onSelectObject(id ? { type: 'postit', id } : { type: 'graph', id: null });
}, [onSelectObject]);
```
These are used in toFlow() but **NOT** in sync effect deps

**TEMP:**
- Same wrappers exist (but doesn't matter since not in deps)

**VERDICT:** Possible indirect cause via parent re-render chain

---

### CANDIDATE 3: GraphEditor handleSelectObject Dependencies

**MAIN:**
```typescript
const handleNodeSelection = React.useCallback((nodeId: string | null) => {
  setSelectedNodeId(nodeId);
  // ...
}, [sidebarOps]);
```
- Simple, doesn't depend on state

**BROKEN:**
```typescript
const handleSelectObject = React.useCallback((obj: SelectedObject | null) => {
  const prevObj = selectedObject;  // <-- READS selectedObject
  const changed = JSON.stringify(prevObj) !== JSON.stringify(obj);
  setSelectedObject(obj);
  // ...
}, [selectedObject, sidebarOps]);  // <-- DEPENDS on selectedObject
```

**TEMP:**
```typescript
const selectedObjectRef = useRef<SelectedObject | null>(selectedObject);
useEffect(() => {
  selectedObjectRef.current = selectedObject;
});

const handleSelectObject = React.useCallback((obj: SelectedObject | null) => {
  const prevObj = selectedObjectRef.current;  // <-- Uses ref
  // ...
}, [sidebarOps]);  // <-- Does NOT depend on selectedObject
```

**VERDICT:** 🔴 **PRIMARY SUSPECT**

---

### CANDIDATE 4: Sync Effect Dependency Array

**MAIN:**
- Full deps: `[graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, activeTabId, tabs]`

**BROKEN:**
- Same full deps

**TEMP:**
- Minimal: `[graph]`
- Uses refs for callbacks

**VERDICT:** 🔴 **THE FIX** (but not necessarily the root cause)

---

## The Loop Mechanism

### Hypothesis A: GraphEditor Callback Recreation Loop

1. **GraphCanvas renders**, calls `onSelectedNodeChange()`
2. **GraphEditor's `handleSelectObject`** runs
3. Sets `selectedObject` state
4. **`handleSelectObject` RECREATES** (has `selectedObject` in deps)
5. **GraphEditor re-renders** (state changed)
6. Passes new `onSelectObject` reference to GraphCanvas
7. **GraphCanvas's `onSelectedNodeChange` RECREATES** (depends on `onSelectObject`)
8. **GraphCanvas re-renders**
9. ??? Somehow triggers selection change again
10. Back to step 1

**Problem:** Steps 8→9 unclear. Why would GraphCanvas re-render trigger selection?

---

### Hypothesis B: Sync Effect + Callback Recreation Loop

1. **Sync effect runs** (graph changed)
2. Calls `toFlow()` with callbacks including `handleUpdateNode`
3. `handleUpdateNode` callback depends on `[graph, ...]`
4. **Graph updates** (even if same content, new reference from `structuredClone`)
5. **`handleUpdateNode` RECREATES** (graph is in its deps)
6. **Sync effect triggers again** (handleUpdateNode is in its deps in MAIN/BROKEN)
7. Back to step 1

**Problem:** This would affect MAIN too, but MAIN works!

---

### Hypothesis C: Cross-Component Cascade

**The chain:**

1. GraphCanvas sync effect runs, updates graph
2. Graph change triggers callback recreations (handleUpdateNode, etc.)
3. In BROKEN: GraphCanvas also has wrappers depending on `onSelectObject`
4. When toFlow calls `onSelectNode()`, it goes to `onSelectedNodeChange`
5. Which calls `onSelectObject` (from GraphEditor)
6. **In BROKEN:** `handleSelectObject` depends on `selectedObject`, so it recreates frequently
7. This causes `onSelectObject` reference to change
8. Which causes `onSelectedNodeChange` to recreate
9. Which... doesn't directly trigger sync effect (not in deps)
10. **BUT:** The re-renders might cause other effects to fire
11. **OR:** The graph updates in parent context trigger re-mounts

**Problem:** Still speculative about steps 10-11

---

## What TEMP Does Differently

**TEMP's fixes:**

1. **Minimal sync deps:** Only `[graph]`
   - Prevents sync effect from running when callbacks recreate

2. **Ref pattern for callbacks:**
   - `handleUpdateNodeRef.current = handleUpdateNode`
   - Sync effect uses refs, not direct callbacks
   - Refs don't change reference, so effect doesn't re-trigger

3. **GraphEditor uses ref pattern:**
   - `handleSelectObject` doesn't depend on `selectedObject`
   - Prevents callback recreation cascade

---

## Systematic Elimination

| Change | Present in MAIN? | Present in BROKEN? | Present in TEMP? | Can Cause Loop? |
|--------|------------------|-------------------|------------------|-----------------|
| Full sync deps | ✅ YES | ✅ YES | ❌ NO (only `[graph]`) | ✅ Possible if callbacks unstable |
| Wrapper callbacks in GraphCanvas | ❌ NO (props) | ✅ YES (local) | ✅ YES (local) | ✅ If cause parent re-renders |
| handleSelectObject depends on selectedObject | ❌ NO | ✅ YES | ❌ NO (uses ref) | ✅ Creates recreation cascade |
| Tab persistence | ❌ NO | ✅ YES | ✅ YES | ❌ Unlikely |
| Callback refs in sync | ❌ NO | ❌ NO | ✅ YES | N/A (is the fix) |

---

## Most Likely Root Cause

**🎯 The combination of:**

1. **Local wrapper callbacks** (BROKEN adds these)
   - Depend on `onSelectObject` from parent
   
2. **handleSelectObject depends on selectedObject** (BROKEN adds this)
   - Recreates on every selection change

3. **Full sync effect deps** (inherited from MAIN, but worked in MAIN)
   - In MAIN: callbacks were stable props
   - In BROKEN: callbacks recreate, triggering sync effect repeatedly

**Why MAIN worked:** Props from parent were stable (didn't recreate on every render of parent)

**Why BROKEN loops:** Local wrappers recreate whenever parent's `onSelectObject` recreates, which happens when `selectedObject` changes

**Why TEMP works:** Either:
- Minimal deps prevent sync effect re-triggering, OR
- Ref pattern stabilizes callbacks, OR
- **BOTH** (belt and suspenders)

---

## The ONE Bug (Best Guess)

**GraphEditor's `handleSelectObject` depending on `selectedObject`** combined with **the refactor to local wrappers in GraphCanvas**.

- This creates unstable callback references
- Which interact poorly with the full dependency array in sync effect
- Creating a render/effect loop

**The fix:** Use refs to stabilize either:
- The sync effect callbacks (TEMP's approach), OR
- The GraphEditor's handleSelectObject (TEMP's approach), OR  
- Both (TEMP does both)

