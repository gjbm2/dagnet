# Data Connections: Implementation Plan

**Status:** Phase 1 In Progress  
**Last Updated:** 2025-11-06  
**Current Focus:** Phase 1B - UI Integration (wiring services)

---

## 🎯 Quick Status

### ✅ Phase 0: Foundation (COMPLETE)
- Schemas updated & validated
- UpdateManager built & tested
- Sample files created
- Events infrastructure added

### 🟡 Phase 1: Synchronous Operations (70% COMPLETE)
- **1A:** Events Implementation ✅
- **1B:** Lightning Menu + Context Menus (UI done, wiring pending) 🟡
- **1C:** Top Menu "Data" 🔲
- **1D:** Properties Panel Updates 🔲
- **1E:** Wire Services to UpdateManager 🔲

### 🔲 Phase 2: External Connectors (NOT STARTED)
### 🔲 Phase 3: Batch Operations (NOT STARTED)
### 🔲 Phase 4: API Routes & Async Processing (FUTURE)

---

## 📋 Phase 1: Remaining Work

### **1B: Wire Services (CRITICAL - 3-4 hours)**

**Current State:** All UI calls `DataOperationsService`, but methods are stubbed with toast notifications.

**What Needs Building:**
1. Wire `DataOperationsService` to `UpdateManager`
2. Implement Get operations:
   - Read from `FileRegistry`
   - Call `UpdateManager.handleFileToGraph()`
   - Apply changes to graph
   - Handle conflicts (show modal if interactive)
3. Implement Put operations:
   - Read from graph
   - Call `UpdateManager.handleGraphToFile()`  
   - Append to file via `FileRegistry`
   - Update index files
4. Test end-to-end flow for one operation type

**Files to Update:**
- `/graph-editor/src/services/dataOperationsService.ts` (replace stubs)
- Possibly create `/graph-editor/src/components/ConflictResolutionModal.tsx`

---

### **1C: Top Menu "Data" (1-2 hours)**

**Requirements:**
- Add "Data" menu to menu bar (next to File, Edit, View, etc.)
- Menu items:
  - Get all from files...
  - Get all from source...
  - Put all to files...
  - ---
  - Sync status...
  - ---
  - [If node selected] Node operations submenu
  - [If edge selected] Edge operations submenu

**Batch Operations Modal:**
- Show all parameters/cases/nodes with checkboxes
- Default: all selected
- Allow user to uncheck items
- Pattern similar to "Commit All" modal
- Call `DataOperationsService` methods for each selected item

**Files to Create/Update:**
- `/graph-editor/src/components/MenuBar/DataMenu.tsx` (new)
- `/graph-editor/src/components/BatchOperationsModal.tsx` (new)

---

### **1D: Properties Panel Updates (3-4 hours)**

**Node Properties:**
1. Add `event_id` selector
   - New card after "Node Behaviour"
   - Uses `EnhancedSelector` with type='event'
   - Shows yellow Calendar icon when connected

**Edge Properties:**
2. Replace `locked` with `mean_overridden`
   - Remove old "Lock probability" checkbox
   - Add `<ZapOff>` icon when `mean_overridden=true`

3. Add override indicators to all auto-calculated fields:
   - Create `<OverrideIndicator>` component (small ZapOff icon, tooltip)
   - Add to: label, description, query, mean, stdev
   - Only show when `*_overridden === true`

4. Display `edge.p.evidence` in tooltip/expandable section:
   ```
   Evidence: n=1000, k=342 (retrieved 2024-11-05)
   Source: Amplitude
   Window: 2024-10-01 to 2024-10-31
   ```

5. Build `QueryStringBuilder` component (CRITICAL):
   - Interactive builder for conditional probability queries
   - Chips + Monaco editor pattern (like existing prototype)
   - Auto-population from MSMDC when user adds conditional
   - Validate query syntax
   - Show parsed query structure

6. Fix cost structure:
   - Ensure displays `edge.cost_gbp.mean` and `edge.cost_time.mean`
   - Add override indicators
   - Display evidence if present

**Files to Update:**
- `/graph-editor/src/components/PropertiesPanel.tsx` (many updates)
- `/graph-editor/src/components/OverrideIndicator.tsx` (new)
- `/graph-editor/src/components/QueryStringBuilder.tsx` (enhance prototype)

---

### **1E: Connection Settings UI (2-3 hours)**

**NOT YET DESIGNED** - Placeholder for future work

**Requirements:**
- Modal to edit `data_source` object:
  - `source_type` dropdown (sheets, api, amplitude, manual)
  - `connection_settings` JSON editor (opaque blob)
  - `connection_overridden` checkbox
- Called from Lightning Menu "Connection settings..." option
- Needs design spec before implementation

**Defer to:** After Phase 1D complete, requires design discussion

---

## 🌐 Phase 2: External Connectors (5-7 days)

**Goals:**
- Implement "Get data from source" operations
- Build connector infrastructure
- Handle credentials from `credentials.yaml`
- Parse connection settings JSON blobs
- Fetch data from external sources

**Connectors to Build:**
1. **Amplitude API** (priority)
   - Read event data
   - Parse into n/k evidence
   - Apply to parameters
   
2. **Google Sheets** (priority)
   - Read/write operations
   - Handle authentication
   - Parse into parameter values
   
3. **Statsig** (future)
   - Case variant assignment
   - A/B test configuration
   
4. **Generic REST API** (future)
   - Configurable endpoints
   - Custom parsing

**Estimated:** 5-7 days

**Details:** TBD (design when Phase 1 complete)

---

## 📦 Phase 3: Batch Operations (4-6 days)

**Goals:**
- Queue multiple operations
- Show progress UI
- Process items sequentially
- Aggregate conflicts
- Bulk conflict resolution modal

**Features:**
- "Get all from files" processes 10+ parameters
- Progress bar shows 3/10 complete
- Collects all conflicts, shows summary at end
- User can review and resolve in one modal
- Retry failed operations

**Estimated:** 4-6 days

**Details:** TBD (design when Phase 2 complete)

---

## 🔌 Phase 4: API Routes & Async Processing (FUTURE)

**Out of MVP Scope**

**Goals:**
- Background job processing
- API endpoints for external triggers
- Scheduled updates
- Webhook support
- Long-running operations

**Use Cases:**
- Nightly data refresh from Amplitude
- Scheduled batch updates
- CI/CD integration
- External system triggers

**Estimated:** 2-3 weeks

**Details:** Separate project phase, design separately

---

## 🐛 Known Technical Debt

### **Critical (Fix After Phase 1)**

**1. UUID vs Human-Readable ID Inconsistency** (~2-3 hours)
- Problem: `hiddenNodes`, edge refs, operations mix UUID and human ID
- Risk: Duplicate human IDs break hide/delete operations
- Solution: See `/PROJECT_CONNECT/CURRENT/UUID_PRIMARY_KEY_REFACTOR.md`
- Priority: HIGH (before Phase 2)

**2. Duplicate ID Validation** (~1 hour)
- Problem: Users can create duplicate human-readable IDs
- Risk: Ambiguous references, broken operations
- Solution: Add validation on ID edit, auto-suffix on import
- Priority: MEDIUM

**3. Unified Delete Code Path** (~30 min)
- Problem: Context menu delete vs keyboard delete use different logic
- Risk: Inconsistent behavior, maintenance burden
- Solution: Consolidate into single method
- Priority: LOW (works correctly now, just not DRY)

---

## 📁 Key Documents

**Specifications:**
- `/PROJECT_CONNECT/CURRENT/DATA_CONNECTIONS.md` - Main specification
- `/PROJECT_CONNECT/CURRENT/QUERY_EXPRESSION_SYSTEM.md` - Query DSL
- `/PROJECT_CONNECT/CURRENT/PHASE_1B_LIGHTNING_MENU.md` - UI design
- `/PROJECT_CONNECT/CURRENT/CONNECTION_SETTINGS_WORKFLOW.md` - Bidirectional override pattern

**Schemas:**
- `/graph-editor/public/schemas/schema/conversion-graph-1.0.0.json`
- `/graph-editor/public/param-schemas/*.yaml`

**Implementation:**
- `/graph-editor/src/services/UpdateManager.ts` (960 lines, tested)
- `/graph-editor/src/services/dataOperationsService.ts` (stubbed, needs wiring)

**Technical Debt:**
- `/PROJECT_CONNECT/CURRENT/UUID_PRIMARY_KEY_REFACTOR.md`

---

## 🎯 Recommended Next Steps

**Option A: Complete UI First (Recommended)**
1. Top Menu "Data" (1-2 hrs)
2. Properties Panel updates (3-4 hrs)
3. Wire services to UpdateManager (3-4 hrs)
4. Fix UUID issues (2-3 hrs)
5. Test end-to-end
6. Document Phase 1 completion

**Total: ~12-15 hours focused work**

**Option B: Wire One Operation End-to-End**
1. Wire "Get parameter from file" fully (3-4 hrs)
2. Test & validate architecture
3. Complete remaining UI (4-6 hrs)
4. Wire remaining operations (2-3 hrs)
5. Fix UUID issues (2-3 hrs)

**Total: ~11-16 hours**

---

## ✅ Acceptance Criteria (Phase 1 Complete)

- [ ] User can click Lightning Menu → "Get data from file" → Edge updates
- [ ] User can right-click edge → Parameter → "Put data to file" → File updates
- [ ] User can use Top Menu "Data" → "Get all from files" → Batch modal → Multiple updates
- [ ] Override indicators show on manually edited fields
- [ ] Query string builder works for conditional probabilities
- [ ] Evidence displays in tooltips
- [ ] All operations respect `*_overridden` flags
- [ ] Index files auto-update when files change
- [ ] Toast notifications show success/error
- [ ] Conflict modal appears when needed (interactive mode)
- [ ] All TypeScript compilation: 0 errors
- [ ] 0 console errors during normal operation

---

## 📊 Time Estimates

| Phase | Status | Time Estimate |
|-------|--------|---------------|
| **Phase 0: Foundation** | ✅ Complete | - |
| **Phase 1: Synchronous Ops** | 🟡 70% | 12-15 hrs remaining |
| **Phase 2: External Connectors** | 🔲 Not Started | 5-7 days |
| **Phase 3: Batch Operations** | 🔲 Not Started | 4-6 days |
| **Phase 4: API/Async** | 🔲 Future | 2-3 weeks |
| **Technical Debt (UUID)** | 🔲 Post-Phase 1 | 2-3 hrs |

### Phase 1 Breakdown
| Task | Status | Time |
|------|--------|------|
| 1A: Events | ✅ Complete | - |
| 1B: Lightning/Context UI | ✅ Complete | - |
| 1B: Wire Services | 🔲 Not Started | 3-4 hrs |
| 1C: Top Menu | 🔲 Not Started | 1-2 hrs |
| 1D: Properties Panel | 🔲 Not Started | 3-4 hrs |
| 1E: Connection Settings | 🔲 Needs Design | TBD |
| **Total Remaining** | | **~12-15 hrs** |


