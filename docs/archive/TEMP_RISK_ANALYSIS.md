# TEMP Branch Risk Analysis: What Should We Keep?

## Goal
Identify risky/unnecessary changes in TEMP that should be reverted to MAIN's state.

## Changes in TEMP vs MAIN

### CATEGORY A: Core Refactor (Keep - Purpose of Branch)

1. **Unified selection model** (SelectedObject type)
   - **Keep:** This is the intended refactor
   - Risk: Low (fundamental design change)

2. **Post-it node support**
   - **Keep:** New feature
   - Risk: Low (isolated feature)

3. **Local callback wrappers in GraphCanvas** (onSelectedNodeChange, etc.)
   - **Keep:** Required for unified selection
   - Risk: Low (not in sync effect deps)

4. **Tab state persistence of selectedObject**
   - **Keep:** Part of refactor
   - Risk: Low (not in loop path)

---

### CATEGORY B: The Actual Fix (Keep - Prevents Loop)

5. **Minimal sync effect dependencies** - `[graph]` only
   - **Keep:** This prevents the loop
   - Risk: None - this is the fix

6. **Callback ref pattern** (handleUpdateNodeRef, etc.)
   - **Keep:** Stabilizes callbacks for sync effect
   - Risk: None - standard React pattern

7. **GraphEditor handleSelectObject uses ref** (selectedObjectRef)
   - **Keep:** Prevents callback recreation cascade
   - Risk: None - breaks potential loop

8. **Variable naming fix** (activeTabIdProp vs activeTabId)
   - **Keep:** Prevents shadowing bugs
   - Risk: None - just better naming

---

### CATEGORY C: Diagnostic Code (REMOVE - Debug Only)

9. **globalRenderCounter** emergency brake
   - **Remove:** Debug infrastructure
   - Risk: None (disabled anyway with `if (false)`)

10. **Render count logging**
    - **Remove:** Debug noise
    - Risk: None

11. **setNodes/setEdges stack trace wrappers**
    - **Remove:** Performance overhead, noise
    - Risk: None

12. **Kill switch refs** (rerouteKillSwitchRef, etc.)
    - **Remove:** Debug utilities
    - Risk: None (never actually used)

13. **Diagnostic logging in sync effect**
    - **Remove:** Debug noise
    - Risk: None

14. **Dependency tracking diagnostic** (syncEffectDepsRef)
    - **Remove:** Debug code
    - Risk: None

15. **Edge scaling/what-if diagnostics** (trace, freeze, stats)
    - **Remove:** Debug infrastructure
    - Risk: None

16. **Gate removal warnings**
    - **Remove:** Debug logging
    - Risk: None

---

### CATEGORY D: Behavior Changes (Review Needed)

17. **Removed isSyncingRef checks from edge scaling effect**
    - **Risk: MODERATE** - Could allow edge scaling during sync
    - Behavior: Edge scaling now runs during Graph→ReactFlow sync
    - Recommendation: **Monitor for issues**, might cause unnecessary recomputation

18. **Removed isSyncingRef checks from what-if effect**  
    - **Risk: MODERATE** - Could allow what-if recompute during sync
    - Behavior: What-if now runs during Graph→ReactFlow sync
    - Recommendation: **Monitor for issues**, might cause race conditions

19. **Removed initialSyncDoneRef gate**
    - **Risk: LOW** - Was preventing operations before first sync
    - Behavior: Operations now allowed immediately
    - Recommendation: **Safe if sync is fast**, watch for init race conditions

20. **Removed rerouteKillSwitchRef checks**
    - **Risk: NONE** - Was debug-only anyway
    - Recommendation: Keep removed

21. **SidebarHoverPreview logic change** (removed postit case)
    - **Risk: LOW** - Might break postit preview
    - Recommendation: **Verify postit preview still works**

---

### CATEGORY E: Minor Changes (Keep)

22. **else-if vs else** in reroute logic
    - **Risk: NONE** - Equivalent logic
    - Keep: Either is fine

23. **Comment changes**
    - **Risk: NONE**
    - Keep: Better documentation

---

## Cleanup Recommendations

### REMOVE (Debug Code):
- Items 9-16: All diagnostic infrastructure

### MONITOR (Behavior Changes):
- Item 17: Edge scaling during sync
- Item 18: What-if during sync  
- Item 19: No initialSyncDone gate

### TEST:
- Item 21: Postit preview functionality

### KEEP AS-IS:
- Items 1-8: Core refactor + loop fix
- Items 20, 22-23: Safe minor changes

---

## Specific Risk: isSyncingRef Gate Removal

**In MAIN/BROKEN:** Edge scaling and what-if effects checked `isSyncingRef`:
```typescript
if (isSyncingRef.current) {
  console.log('Skipping...');
  return;
}
```

**In TEMP:** These checks are removed

**Potential Issue:**
- During Graph→ReactFlow sync, `setNodes()` and `setEdges()` are called
- This triggers edge scaling and what-if effects
- Which call `setEdges()` again
- Could cause:
  - Extra recomputations (performance)
  - Race conditions (unlikely but possible)
  - Incorrect intermediate states

**Recommendation:**
- **Re-add isSyncingRef checks to edge scaling and what-if effects**
- These were likely removed during debugging and should be restored
- They're a safety mechanism, not part of the loop problem

---

## Action Plan

1. **Keep:** All Category A, B, E changes
2. **Remove:** All Category C (diagnostic code)
3. **Re-add:** isSyncingRef checks in edge scaling/what-if (Items 17-18)
4. **Test:** Postit preview (Item 21)
5. **Monitor:** Initial sync behavior (Item 19)

This gives us a clean TEMP with only the necessary fixes, no debug cruft, and safety mechanisms restored.

