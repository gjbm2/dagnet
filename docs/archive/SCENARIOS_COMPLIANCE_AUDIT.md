# Scenarios Manager - Spec Compliance Audit

**Reviewing against**: `/docs/current/SCENARIOS_MANAGER_SPEC.md` (Option B: Additive Layering)

---

## Terminology (Lines 12-15)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 1 | Base: Session baseline; bottom layer; default hidden | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:399` Base row at bottom |
| 2 | Current: Live working state; top layer; receives edits | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:278` Current row at top |
| 3 | Scenario: Named, coloured, editable overlay stored as diff | ✅ Implemented | 🟢 | `types/scenarios.ts:103` |

---

## UX - Scenario List Items (Lines 19-26)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 4 | Drag handles for reorder | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:323-325` |
| 5 | Colour swatch (click to change colour - manual override) | ✅ DESCOPED | ⚫ | Not needed for v1
| 6 | Name (inline editable; default: timestamp) | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:143,359` Timestamp + pencil edit |
| 7 | View toggle (eye icon) — per tab | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:352-358` |
| 8 | Open (launches Monaco modal) | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:366-372` FileText icon |
| 9 | Delete (trash) | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:373-379` |
| 10 | Tooltip on hover: Shows Scenario.meta | ✅ Fixed | 🟢 | `ScenariosPanel.tsx:46-77` Full metadata tooltip |

---

## UX - Footer Actions (Lines 27-30)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 11 | "+ Create Snapshot" (from current state) | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:438-441` |
| 12 | Snapshot uses timestamp name | ✅ Auto-generated | 🟢 | `ScenariosPanel.tsx:143-150` |
| 13 | "New" (creates blank, opens Monaco) | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:452-456` |
| 14 | "Flatten" (Base := Current, clear overlays) | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:473-477` |

---

## UX - Monaco Modal (Lines 31-45)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 15 | Displays full scenario YAML/JSON | ✅ Implemented | 🟢 | `ScenarioEditorModal.tsx:350-365` |
| 16 | Live validation with inline diagnostics | ❌ No visible indicators | 🔴 | `ScenarioEditorModal.tsx:320-346` Need visual validation feedback
| 17 | Actions: Apply, Cancel | ✅ Implemented | 🟢 | `ScenarioEditorModal.tsx:386-400` |
| 18 | Syntax toggle: YAML \| JSON | ✅ Implemented | 🟢 | `ScenarioEditorModal.tsx:278-290` |
| 19 | Structure toggle: Nested \| Flat | ✅ Implemented | 🟢 | `ScenarioEditorModal.tsx:292-306` |
| 20 | Default: YAML + Nested | ✅ Correct | 🟢 | `ScenarioEditorModal.tsx:35` |
| 21 | Lossless round-trip between representations | ✅ Implemented | 🟢 | `ParamPackDSLService.ts` |
| 22 | Export: "Copy as CSV" (Flat) | ✅ Implemented | 🟢 | `ScenarioEditorModal.tsx:312-315` |
| 23 | Metadata panel - readonly fields | ✅ Implemented | 🟢 | `ScenarioEditorModal.tsx:230-258` |
| 24 | Metadata panel - editable Note | ✅ Implemented | 🟢 | `ScenarioEditorModal.tsx:261-271` |
| 25 | Monaco modal size | ✅ Fixed | 🟢 | 1200px width, 500px height |

---

## UX - Base Layer (Lines 47-53)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 26 | Always present; pinned at bottom | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:400` |
| 27 | Non-draggable, not deletable | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:402` Drag handle disabled |
| 28 | Default: not visible | ✅ Reads from state | 🟢 | `ScenariosPanel.tsx:63` |
| 29 | Colour swatch, name "Base", Open button | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:405-427` |
| 30 | Open Base: Apply edits should mutate Base directly | ✅ Fixed | 🟢 | `ScenarioEditorModal.tsx:177-185` Updates baseParams |
| 31 | Base modal also needs "Save as Snapshot" button | ❌ Not implemented | 🔴 | Button to create overlay from Base edits
| 32 | "Save as Snapshot" creates overlay from editor | ❌ Not implemented | 🔴 | Missing button in modal

---

## UX - Current Layer (Lines 55-59)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 33 | Pinned at top of stack | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:278` |
| 34 | Live working state (graph + What-If) | ✅ Extracts from graph | 🟢 | `ScenariosContext.tsx:89-101` useEffect |
| 35 | Can be hidden | ✅ Toggle works | 🟢 | `ScenariosPanel.tsx:294-299` |
| 36 | Auto-unhide Current on edit/What-If change | ❌ Not implemented | 🔴 | Missing listener | *** ADD ***
| 37 | Toast: "Current shown to reflect your change" | ❌ Not implemented | 🔴 | Missing | *** ADD ***
| 38 | Snapshot operations reference Current as "from" | ✅ Implemented | 🟢 | `ScenariosContext.tsx:127` |

---

## Data Model (Lines 61-104)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 39 | Scenario: id, name, colour, createdAt, updatedAt, version, params, meta | ✅ All fields | 🟢 | `types/scenarios.ts:103-127` |
| 40 | ScenarioMeta: window, context, whatIfDSL, whatIfSummary, source, note | ✅ All fields | 🟢 | `types/scenarios.ts:71-98` |
| 41 | source.type: 'all' \| 'differences' | ✅ Implemented | 🟢 | `types/scenarios.ts:85` |
| 42 | source.from: 'visible' \| 'base' | ✅ Implemented | 🟢 | `types/scenarios.ts:87` |
| 43 | source.visibleExcludingCurrent | ⚠️ Field exists but not populated | 🟡 | `types/scenarios.ts:88` |
| 44 | TabScenarioState: visibleScenarioIds, visibleColourOrderIds, selectedScenarioId | ✅ Implemented | 🟢 | `types/scenarios.ts:132-141` |

---

## Persistence (Lines 106-116)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 45 | Scenarios in graph runtime, shared across tabs | ✅ ScenariosContext | 🟢 | `ScenariosContext.tsx:82-92` |
| 46 | NOT saved to .json files | ✅ Runtime only | 🟢 | Correct |
| 47 | Per-tab visibility state persists | ✅ TabContext | 🟢 | `TabContext.tsx:1383-1511` |

---

## Colour Strategy (Lines 118-136)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 48 | Colours only on visible scenarios | ✅ Conditional render | 🟢 | `ScenariosPanel.tsx:283,330,405` |
| 49 | Toggle on: append to visibleColourOrderIds | ✅ Implemented | 🟢 | `TabContext.tsx:1433-1437` |
| 50 | Toggle off: remove from visibleColourOrderIds | ✅ Implemented | 🟢 | `TabContext.tsx:1438-1441` |
| 51 | 1 visible → grey | ✅ ColourAssigner | 🟢 | `ColourAssigner.ts:35-38` |
| 52 | 2 visible → complementary (≈180° apart) | ✅ Blue/Pink | 🟢 | `ColourAssigner.ts:42-45` |
| 53 | N > 2 → evenly distributed hues | ✅ Implemented | 🟢 | `ColourAssigner.ts:49-55` |
| 54 | Base participates in palette if visible | ✅ Treated same as scenarios | 🟢 | ColourAssigner doesn't special-case |
| 55 | Manual colour override (TBD) | ❌ Not implemented | 🔴 | Spec says TBD, not implemented | *** NOT YET ***
| 56 | mix-blend-mode: multiply | ✅ Implemented | 🟢 | `ScenarioOverlayRenderer.tsx:112` |
| 57 | strokeOpacity 0.25-0.40 | ✅ 0.3 | 🟢 | `ScenarioOverlayRenderer.tsx:110` |

---

## Rendering Pipeline - Option B (Lines 138-168)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 58 | Base is background layer (always present, default hidden) | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:400,405` |
| 59 | Layers applied bottom to top: Base → S1 → S2 → Sn | ✅ Implemented | 🟢 | `ScenarioRenderer.ts:69-77` |
| 60 | Each overlay deep-merges into composition | ✅ composeParams | 🟢 | `CompositionService.ts:17-30` |
| 61 | Use current graph geometry for all layers | ✅ Reuses paths | 🟢 | `ScenarioOverlayRenderer.tsx:72` |
| 62 | Compute widths per composed params | ✅ Implemented | 🟢 | `ScenarioRenderer.ts:116-135` |
| 63 | Render with S.colour, multiply, butt/miter | ✅ All correct | 🟢 | `ScenarioOverlayRenderer.tsx:105-113` |
| 64 | CI bands render on all layers | ✅ CLARIFIED | 🟢 | CI should render on all edge layers, not just base
| 65 | Fail gracefully if edge missing | ⚠️ Basic check | 🟡 | `ScenarioRenderer.ts:210` shouldRenderEdge |
| 66 | Compositing order (not render order) | ✅ CLARIFIED | 🟢 | Base default hidden; compositing order matters, not render order
| 67 | Overlays render in palette order | ✅ Iterates visibleScenarioIds | 🟢 | `ScenarioRenderer.ts:58` |
| 68 | Reordering updates visibleScenarioIds | ✅ Implemented | 🟢 | `TabContext.tsx:1473-1488` |

---

## Operations API (Lines 170-203)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 69 | list(): Scenario[] | ✅ listScenarios() | 🟢 | `ScenariosContext.tsx:223-225` |
| 70 | get(id): Scenario \| undefined | ✅ getScenario() | 🟢 | `ScenariosContext.tsx:217-219` |
| 71 | createSnapshot(options) | ✅ Implemented | 🟢 | `ScenariosContext.tsx:103-181` |
| 72 | createBlank(name) | ✅ Implemented | 🟢 | `ScenariosContext.tsx:186-212` |
| 73 | openInEditor(id) | ✅ Implemented | 🟢 | `ScenariosContext.tsx:345-347` |
| 74 | applyContent(id, content, format) | ✅ Implemented | 🟢 | `ScenariosContext.tsx:255-292` |
| 75 | rename(id, name) | ✅ renameScenario() | 🟢 | `ScenariosContext.tsx:230-238` |
| 76 | setColour(id, colour) | ✅ DESCOPED | ⚫ | Not needed for v1
| 77 | reorder(scenarioIds) | ✅ Via TabContext | 🟢 | `TabContext.tsx:1473` reorderScenarios |
| 78 | delete(id) | ✅ deleteScenario() | 🟢 | `ScenariosContext.tsx:243-251` |
| 79 | getVisible(tabId) | ✅ Via TabContext | 🟢 | `TabContext.tsx:1383` getScenarioState |
| 80 | setVisible(tabId, ids) | ✅ setVisibleScenarios | 🟢 | `TabContext.tsx:1397` |
| 81 | toggleVisible(tabId, id) | ✅ Implemented | 🟢 | `TabContext.tsx:1417` |
| 82 | setSelected(tabId, id) | ✅ selectScenario | 🟢 | `TabContext.tsx:1451` |
| 83 | assignColour(scenarioId, existingIds) | ✅ Implemented differently | 🟢 | `ColourAssigner.ts:18` assignColours works correctly
| 84 | getBaseParams() | ✅ baseParams state | 🟢 | `ScenariosContext.tsx:90` |
| 85 | openBaseInEditor() | ⚠️ Opens but needs special handling | 🟡 | Opens same as scenario, needs "base" id handling |

---

## Validation (Lines 205-208)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 86 | Validate on Apply | ✅ validateContent() | 🟢 | `ScenariosContext.tsx:297-339` |
| 87 | Warn inline with diagnostics | ⚠️ Shows warnings, Monaco markers unclear | 🟡 | `ScenarioEditorModal.tsx:334-346` |
| 88 | Don't block Apply with errors | ✅ Fixed | 🟢 | `ScenariosContext.tsx:293-301` Warns but proceeds |
| 89 | Mark scenario with validation errors | ❌ Not implemented | 🔴 | No visual indicator in list |

---

## Snapshot Scope Semantics (Lines 262-282)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 90 | "All" (complete diff that overrides source) | ✅ Implemented | 🟢 | `DiffService.ts:25-28` |
| 91 | "Differences" (sparse diff with epsilon) | ✅ Implemented | 🟢 | `DiffService.ts:31-67` |
| 92 | source='visible': compose all visible EXCLUDING Current | ✅ Fixed | 🟢 | `ScenariosContext.tsx:138-142` Filters to visible |
| 93 | source='base': Base only | ✅ Implemented | 🟢 | `ScenariosContext.tsx:115-117` |
| 94 | Partial overlays are first-class | ✅ Diff-based | 🟢 | DiffService supports sparse |
| 95 | What-If included in "visible" captures | ✅ Captured in metadata | 🟢 | `ScenariosContext.tsx:169-172` |

---

## Default Labels (Lines 288-295)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 96 | Default name: Timestamp "2025-11-12 14:30" | ✅ Implemented | 🟢 | `ScenariosPanel.tsx:143-150` |
| 97 | Tooltip: Window dates | ❌ Not showing | 🔴 | Only shows note |
| 98 | Tooltip: Context values | ❌ Not showing | 🔴 | Only shows note |
| 99 | Tooltip: What-If summary | ❌ Not showing | 🔴 | Only shows note |
| 100 | Tooltip: Source info | ❌ Not showing | 🔴 | Only shows note |
| 101 | Tooltip: Created timestamp | ❌ Not showing | 🔴 | Only shows note |

---

## Base and Current Visibility (Lines 297-299)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 102 | Base: default hidden | ✅ Reads from state | 🟢 | `ScenariosPanel.tsx:63` |
| 103 | Base: can be shown/hidden | ✅ Toggle works | 🟢 | `ScenariosPanel.tsx:414-420` |
| 104 | Base: used as reference even when hidden | ✅ Always in composition | 🟢 | `ScenarioRenderer.ts:76` |
| 105 | Current: can be hidden | ✅ Toggle works | 🟢 | `ScenariosPanel.tsx:294-299` |
| 106 | Auto-unhide Current on param edit | ❌ Not implemented | 🔴 | Missing graph edit listener |
| 107 | Auto-unhide Current on What-If change | ❌ Not implemented | 🔴 | Missing What-If listener |
| 108 | Toast when auto-unhiding | ❌ Not implemented | 🔴 | Missing |

---

## Snapshot Insertion Rules (Lines 301-304)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 109 | Insert new overlay at position 2 (just beneath Current) | ✅ Prepends to array | 🟢 | `ScenariosContext.tsx:179` |
| 110 | Stored as diffs, composed via deep-merge | ✅ Implemented | 🟢 | `CompositionService.ts` |

---

## What-If Interplay (Lines 306-309)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 111 | What-If applies only to Current | ✅ Via graph system | 🟢 | Existing What-If unchanged |
| 112 | Current hidden → What-If muted from preview | ⚠️ Rendering logic unclear | 🟡 | Needs verification |
| 113 | Auto-unhide on What-If change | ❌ Not implemented | 🔴 | Missing |
| 114 | Toast on auto-unhide | ❌ Not implemented | 🔴 | Missing |
| 115 | Overlays unaffected by What-If after capture | ✅ Stored params only | 🟢 | Correct by design |

---

## Acceptance Criteria (Lines 311-321)

| # | Requirement | Implementation | RAG | Code Reference |
|---|-------------|----------------|-----|----------------|
| 116 | Create snapshot: appears in list, invisible by default | ✅ Created, not auto-visible | 🟢 | `ScenariosContext.tsx:179` |
| 117 | Rename scenarios | ✅ Pencil icon | 🟢 | `ScenariosPanel.tsx:359-365` |
| 118 | Recolour scenarios | ✅ DESCOPED | ⚫ | Not needed for v1
| 119 | Toggle visibility per tab | ✅ Eye icon | 🟢 | Works |
| 120 | Open JSON modal, apply edits, delete | ✅ All work | 🟢 | Implemented |
| 121 | Overlays render additively Base → up | ⚠️ Overlay renderer exists but unclear if working | 🟡 | `ScenarioOverlayRenderer.tsx` |
| 122 | Identical scenarios → neutral appearance | ⚠️ Blend mode set, untested | 🟡 | Needs visual verification |
| 123 | Different widths → coloured fringes | ⚠️ Untested | 🟡 | Needs visual verification |
| 124 | Scenarios persist in runtime (shared) | ✅ Correct | 🟢 | ScenariosContext |
| 125 | Current hidden → auto-unhide on edit | ❌ Not implemented | 🔴 | Missing |
| 126 | Monaco: YAML/JSON toggle | ✅ Works | 🟢 | Implemented |
| 127 | Monaco: Nested/Flat toggle | ✅ Works | 🟢 | Implemented |
| 128 | Monaco: CSV export | ✅ Implemented | 🟢 | Download button |
| 129 | Snapshot captures meta (window, context, what-if, source) | ✅ Captured | 🟢 | `ScenariosContext.tsx:163-172` |
| 130 | Modal allows editing meta.note | ✅ Textarea | 🟢 | `ScenarioEditorModal.tsx:265-270` |

---

## RAG Summary (Latest)

| Status | Count | Percentage |
|--------|-------|------------|
| 🟢 Green (Implemented & Working) | 96 | 74% |
| 🟡 Amber (Partial/Unclear) | 6 | 5% |
| 🔴 Red (Missing/Wrong) | 22 | 17% |
| ⚫ Descoped (Not needed v1) | 6 | 5% |

---

## Critical Missing Features

### 🔴 HIGH PRIORITY (Blocking Core Functionality)

1. **Auto-unhide Current on edit/What-If change** (Items 106, 107, 113, 125)
   - Need listener on graph mutations
   - Need listener on What-If state changes
   - Show toast when auto-unhiding

3. **Tooltip showing full metadata** (Items 10, 97-101)
   - Current only shows note
   - Should show: window, context, what-if, source, created

4. **Base/Current special handling in modal** (Items 30-32, 85)
   - Opening Base should allow editing Base
   - "Save as Snapshot" button in modal for Base edits
   - Opening Current and Apply should create NEW scenario

5. **Validation doesn't block Apply** (Item 88)
   - Currently throws error on validation failure
   - Should warn but persist anyway

6. **Visual indicator for validation errors** (Item 89)
   - Mark scenarios with errors in list
   - Add warning icon

### 🟡 MEDIUM PRIORITY (Polish/Testing)

7. **Source filtering to only visible scenarios** (Item 92)
   - Currently composes ALL scenarios
   - Should filter to visible only when source='visible'

8. **Monaco inline diagnostics** (Items 16, 87)
   - Show validation messages
   - Unclear if Monaco markers are set

9. **Rendering verification** (Items 121-123)
   - Need to verify overlays actually render
   - Need to verify blend mode works
   - Need to verify coloured fringes appear

10. **CI/Scenario interaction** (Item 64)
    - CI should only render on base layer *** FALSE ***

---

## Files Needing Changes

### Critical
- `ScenariosPanel.tsx` - Add tooltip with full metadata, make swatch clickable
- `ScenariosContext.tsx` - Add setColour(), don't throw on validation error
- `ScenarioEditorModal.tsx` - Add "Save as Snapshot" for Base, handle Current→New
- `GraphEditor.tsx` or `GraphCanvas.tsx` - Add auto-unhide listeners

### Polish
- `ScenariosContext.tsx` - Filter to visible scenarios when source='visible'
- `ScenarioOverlayRenderer.tsx` - Verify rendering works
- `ScenariosPanel.tsx` - Add validation error indicator

---

## Next Steps

1. Implement auto-unhide Current (critical UX)
2. Make swatches clickable for colour override
3. Add full metadata tooltip
4. Handle Base/Current editing specially in modal
5. Fix validation to warn-not-block
6. Test rendering actually works


