# Phase 0 Hygiene Check: Large File Refactoring Assessment

**Date:** 2025-11-05  
**Purpose:** Identify large files that will be touched by Phase 0 and assess refactoring needs

---

## Files That Will Be Touched in Phase 0

### 🚨 CRITICAL - id/slug refactor will touch extensively:

| File | Lines | Impact | Refactor Priority |
|------|-------|--------|-------------------|
| **types/index.ts** | 419 | HIGH - GraphData interface | ✅ Manageable - no refactor needed |
| **lib/transform.ts** | 114 | HIGH - toFlow/fromFlow conversions | ✅ Small, clean - no refactor needed |
| **components/PropertiesPanel.tsx** | 2,920 | HIGH - Property editing | ⚠️ **MONOLITHIC** - see below |
| **components/GraphCanvas.tsx** | 4,666 | MEDIUM - Graph rendering | 🚨 **MASSIVE MONOLITH** - see below |
| **components/edges/ConversionEdge.tsx** | 1,508 | MEDIUM - Edge display | ⚠️ Large but contained |
| **components/nodes/ConversionNode.tsx** | 639 | LOW - Node display | ✅ Manageable |
| **lib/runner.ts** | 458 | LOW - Path analysis | ✅ Manageable |

---

## 🚨 Problem Files Identified

### 1. **GraphCanvas.tsx** - 4,666 lines 🚨 CRITICAL

**Structure:**
- Tiny wrapper function (~50 lines)
- ONE MASSIVE `CanvasInner` function (~4,600 lines)
- Single monolithic component with hundreds of state variables, effects, and handlers

**Phase 0 Changes Needed:**
- id/slug refactor (~20-30 references)
- Relatively few changes compared to file size

**Assessment:**
- ✅ **Do NOT refactor before Phase 0**
- Reason: Changes are localized, refactoring is high-risk, low-reward
- File is functional (if ugly)
- Refactoring could introduce subtle bugs in graph behavior
- Better to tackle as separate "Tech Debt" task after Phase 0

**Recommendation:** 
- Make surgical id/slug changes only
- Add to tech debt backlog for "Phase 0.5: GraphCanvas Refactor"

---

### 2. **PropertiesPanel.tsx** - 2,920 lines ⚠️ HIGH RISK

**Structure:**
- ONE MASSIVE function component (~2,900 lines)
- Handles nodes, edges, and all property types in single monolith
- Extensive local state management
- Many useEffect hooks interacting

**Phase 0 Changes Needed:**
- id/slug refactor (~50-70 references throughout)
- Add override UI indicators (ZapOff/Zap icons)
- Add new fields (event_id, query, description_overridden, etc.)
- Connect to UpdateManager

**Assessment:**
- ⚠️ **BORDERLINE** - could go either way
- Many changes needed across entire file
- High risk of breaking existing functionality
- But refactoring is also risky given complexity

**Recommendation:**
- **Option A (Conservative):** Make surgical changes, accept ugliness, refactor in Phase 0.5
- **Option B (Proactive):** Extract 3-4 sub-components first (2-3 hours), then make Phase 0 changes

**If Option B, extract:**
1. `NodePropertiesSection.tsx` (~800 lines)
2. `EdgePropertiesSection.tsx` (~1,200 lines)  
3. `ParameterConnectionSection.tsx` (~400 lines)
4. Leave shared state/logic in PropertiesPanel (~500 lines)

**My Recommendation:** **Option A** (Conservative)
- We're already taking on substantial risk with schema changes
- PropertiesPanel works, even if ugly
- Better to have stable foundation before refactoring

---

### 3. **ConversionEdge.tsx** - 1,508 lines ⚠️ MODERATE

**Structure:**
- Single component rendering edge
- Many conditional rendering paths
- Handles normal edges, case edges, conditional probabilities

**Phase 0 Changes Needed:**
- Display edge.id (renamed from slug)
- Show override indicators
- Relatively few changes

**Assessment:**
- ✅ **Do NOT refactor before Phase 0**
- File is complex but functional
- Changes are minor relative to size

**Recommendation:** Surgical changes only

---

## Summary & Recommendations

### ✅ PROCEED WITHOUT REFACTORING

**Rationale:**
1. **Risk Management:** Schema changes are already high-risk; adding major refactors multiplies risk
2. **Scope Creep:** Refactoring could delay Phase 0 by 1-2 days
3. **Functional Code:** All files work correctly despite size
4. **Localized Changes:** Most id/slug changes are find-replace patterns
5. **Test Coverage:** Refactoring without tests is dangerous

**Phase 0 Strategy:**
- Make surgical id/slug changes using automated refactoring
- Add new fields incrementally
- Keep existing structure intact
- **Defer refactoring to Phase 0.5** (after schemas stabilize)

---

## Phase 0.5: Technical Debt Cleanup (FUTURE)

**After Phase 0 schemas stabilize, consider:**

### Task 0.5.1: Refactor PropertiesPanel (1-2 days)
Break into:
- `NodePropertiesSection.tsx`
- `EdgePropertiesSection.tsx`  
- `ParameterConnectionSection.tsx`
- Shared hooks: `useNodePropertySync.ts`, `useEdgePropertySync.ts`

### Task 0.5.2: Refactor GraphCanvas (2-3 days)
Break `CanvasInner` into:
- `useGraphCallbacks.ts` hook (handle callbacks)
- `useGraphKeyboard.ts` hook (keyboard handlers)
- `useGraphLayout.ts` hook (layout logic)
- `useGraphSelection.ts` hook (selection state)
- Slim down CanvasInner to ~500 lines

### Task 0.5.3: Refactor ConversionEdge (0.5 days)
Extract:
- `NormalEdgeRenderer.tsx`
- `CaseEdgeRenderer.tsx`
- `ConditionalEdgeRenderer.tsx`
- Main component as router (~200 lines)

**Estimated Tech Debt Cleanup:** 4-6 days
**When:** After Phase 0 complete and validated

---

## Decision

**✅ PROCEED WITH PHASE 0 WITHOUT PRE-REFACTORING**

- Use automated find/replace for id/slug changes
- Make surgical additions for new fields
- Accept temporary ugliness in large files
- Schedule tech debt cleanup for Phase 0.5

**Why:** 
- Lower risk
- Faster to Phase 0 complete
- Schemas stabilize first
- Can write tests against stable schemas before refactoring

---

## Automated Refactoring Safety

**For id/slug changes, we CAN use automated tools safely because:**

1. **Clear Pattern:** `node.id` → `node.uuid`, `node.slug` → `node.id`
2. **TypeScript Safety:** Compiler will catch 80% of errors
3. **Limited Scope:** Only nodes/edges affected, not broader application state
4. **Reversible:** Changes in version control, easy to rollback
5. **Testable:** Existing tests will catch regressions

**Strategy:**
1. Update types first (compiler becomes guide)
2. Use VS Code multi-cursor + TypeScript errors
3. Regex for bulk patterns
4. Manual review of complex cases
5. Test after each file

**Time Estimate:** 3-4 hours (as planned)

---

## Conclusion

**No pre-refactoring needed.** The large files are functional monoliths, and Phase 0 changes are relatively localized. The risk of breaking functionality during a major refactor outweighs the benefits of cleaner code. 

**Proceed with Phase 0 as planned, add tech debt to Phase 0.5.**

