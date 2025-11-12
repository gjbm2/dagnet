# Probability Sliders Test Cases

## Test Coverage Matrix

### Test Categories

1. **Get from File** - Pull data from parameter file → graph
2. **Put to File** - Push graph data → parameter file  
3. **Get from Source** - Pull data from external source → file → graph
4. **Get from Source (Direct)** - Pull data from external source → graph (no file)
5. **Graph-to-Graph UI Changes** - User edits via sliders/inputs

### Probability Types

- **Regular Edge Probability** (`p`)
- **Conditional Probability** (`conditional_p`)
- **Case Variant Weight** (`case.variants[].weight`)

### UI Locations

- **Edge Context Menu** - Right-click on edge
- **Sidebar (PropertiesPanel)** - Select edge/node in sidebar

---

## Test Cases

### TC-001: Regular Edge Probability - Get from File (Context Menu)

**Setup:**
- Edge A→B has `p.id = "param-123"`
- Parameter file `param-123.yaml` has `mean: 0.3`
- Edge A→B currently has `p.mean = 0.5`

**Steps:**
1. Right-click edge A→B
2. Click "Get data from file" in context menu

**Expected:**
- ✅ Edge A→B `p.mean` updates to `0.3`
- ✅ `p.mean_overridden` is NOT set (file is source of truth)
- ✅ Sibling edges (A→C, A→D) are rebalanced proportionally
- ✅ Override flags on siblings are respected (if set)
- ✅ Rebalance button lights up if probabilities don't sum to 1.0

**Verify:**
- UpdateManager `rebalanceSiblingParameters` called
- Graph mutation service updates graph
- History state saved

---

### TC-002: Regular Edge Probability - Get from File (Sidebar)

**Setup:**
- Edge A→B selected in sidebar
- Edge has `p.id = "param-123"`
- Parameter file has `mean: 0.4`

**Steps:**
1. Select edge A→B in sidebar
2. Click "Get from File" button in ParameterSection

**Expected:**
- ✅ Same as TC-001
- ✅ Sidebar updates to show new value
- ✅ Unbalanced indicator updates if needed

---

### TC-003: Regular Edge Probability - Put to File (Context Menu)

**Setup:**
- Edge A→B has `p.mean = 0.6`, `p.mean_overridden = true`
- Edge has `p.id = "param-123"`
- Parameter file currently has `mean: 0.3`

**Steps:**
1. Right-click edge A→B
2. Click "Put data to file"

**Expected:**
- ✅ Parameter file `param-123.yaml` updated with `mean: 0.6`
- ✅ File metadata updated (`updated_at` timestamp)
- ✅ Graph unchanged (file write doesn't affect graph)

**Verify:**
- UpdateManager `handleGraphToFile` called
- File registry updated
- Toast notification shown

---

### TC-004: Regular Edge Probability - Get from Source (Context Menu)

**Setup:**
- Edge A→B has `p.connection = "amplitude"`
- Edge has `p.id = "param-123"`
- External source returns `mean: 0.35` for date range

**Steps:**
1. Right-click edge A→B
2. Click "Get from Source" → "Get from Source (direct)"

**Expected:**
- ✅ Data fetched from external source
- ✅ Parameter file updated with new data
- ✅ Graph updated with `p.mean = 0.35`
- ✅ Siblings rebalanced
- ✅ Query signature computed and stored

**Verify:**
- `dataOperationsService.getFromSourceDirect` called
- `calculateIncrementalFetch` used
- UpdateManager rebalancing applied

---

### TC-005: Regular Edge Probability - Get from Source with Cache Bust

**Setup:**
- Edge A→B has existing data in file for date range
- User wants to force re-fetch

**Steps:**
1. Open BatchOperationsModal
2. Check "Bust cache" toggle
3. Click "Get from Sources"

**Expected:**
- ✅ All dates re-fetched (ignores existing dates)
- ✅ File updated with fresh data
- ✅ Graph updated

**Verify:**
- `bustCache: true` passed to `calculateIncrementalFetch`
- Existing dates ignored in fetch calculation

---

### TC-006: Regular Edge Probability - UI Slider Change (Context Menu)

**Setup:**
- Edge A→B selected
- Current `p.mean = 0.4`
- Siblings: A→C (0.3), A→D (0.3)

**Steps:**
1. Right-click edge A→B
2. Drag slider to `0.5`

**Expected:**
- ✅ Only A→B updates to `0.5` (no rebalance yet)
- ✅ `p.mean_overridden = true` set
- ✅ Rebalance button lights up (unbalanced: 0.5 + 0.3 + 0.3 = 1.1)
- ✅ Click rebalance button → siblings update to 0.25 each
- ✅ Origin edge (A→B) stays at 0.5

**Verify:**
- `onChange` updates graph immediately
- `onCommit` sets override flag
- `onRebalance` uses UpdateManager with `forceRebalance: true`
- Origin value preserved

---

### TC-007: Regular Edge Probability - UI Slider Change (Sidebar)

**Setup:**
- Edge A→B selected in sidebar
- Current `p.mean = 0.4`

**Steps:**
1. Select edge in sidebar
2. Drag slider in ParameterSection to `0.6`
3. Click rebalance button

**Expected:**
- ✅ Same as TC-006
- ✅ Sidebar updates reflectively
- ✅ Unbalanced indicator shows correctly

---

### TC-008: Regular Edge Probability - CTRL+Click Slider (Auto-Rebalance)

**Setup:**
- Edge A→B selected
- Current `p.mean = 0.4`

**Steps:**
1. Hold CTRL key
2. Drag slider to `0.5`
3. Release mouse

**Expected:**
- ✅ Edge updates to `0.5`
- ✅ Siblings automatically rebalanced (no button click needed)
- ✅ Override flags cleared on siblings (forceRebalance)
- ✅ Origin edge value preserved

**Verify:**
- `useSnapToSlider` detects CTRL key
- `scheduleRebalance` called
- UpdateManager `rebalanceEdgeProbabilities` with `forceRebalance: true`

---

### TC-009: Conditional Probability - Get from File (Context Menu)

**Setup:**
- Edge A→B has conditional_p[0] with `p.id = "param-456"`
- Parameter file has `mean: 0.7` for condition `visited(promo)`

**Steps:**
1. Right-click edge A→B
2. Click "Get data from file" for conditional probability

**Expected:**
- ✅ Conditional probability `p.mean` updates to `0.7`
- ✅ Siblings with same condition rebalanced
- ✅ Override flags respected

**Verify:**
- UpdateManager `rebalanceConditionalProbabilities` called
- Condition matching works correctly

---

### TC-010: Conditional Probability - UI Slider Change (Context Menu)

**Setup:**
- Edge A→B has conditional_p[0] with `p.mean = 0.5`
- Condition: `visited(promo)`
- Sibling edge A→C has same condition with `p.mean = 0.5`

**Steps:**
1. Right-click edge A→B
2. Change conditional probability slider to `0.6`
3. Click rebalance button

**Expected:**
- ✅ Only A→B conditional_p[0] updates to `0.6`
- ✅ `p.mean_overridden = true` set
- ✅ Rebalance button lights up
- ✅ Click rebalance → A→C's matching condition updates to `0.4`
- ✅ Origin condition value (0.6) preserved

**Verify:**
- AutomatableField wrapper shows override flag
- UpdateManager preserves origin value
- Only siblings with matching condition updated

---

### TC-011: Conditional Probability - UI Slider Change (Sidebar)

**Setup:**
- Edge A→B selected in sidebar
- Has conditional probabilities

**Steps:**
1. Select edge in sidebar
2. Expand Conditional Probabilities section
3. Change slider for condition[0]
4. Click rebalance button

**Expected:**
- ✅ Same as TC-010
- ✅ ConditionalProbabilityEditor updates correctly
- ✅ Unbalanced indicator shows per condition

---

### TC-012: Case Variant Weight - Get from File (Context Menu)

**Setup:**
- Case node "TestNode" has variants: ["control", "treatment"]
- Edge A→B has `case_id = "test-case"`, `case_variant = "control"`
- Case file has `variants[0].weight = 0.4`

**Steps:**
1. Right-click edge A→B
2. Click "Get data from file" for case

**Expected:**
- ✅ Case node variants updated
- ✅ Variant weights rebalanced if needed
- ✅ Override flags respected

**Verify:**
- UpdateManager `rebalanceVariantWeights` called if needed

---

### TC-013: Case Variant Weight - UI Slider Change (Context Menu)

**Setup:**
- Edge A→B is case edge with variant "control"
- Case node has variants: control (0.5), treatment (0.5)

**Steps:**
1. Right-click edge A→B
2. Change variant weight slider to `0.6`
3. Click rebalance button

**Expected:**
- ✅ Only "control" variant updates to `0.6`
- ✅ `weight_overridden = true` set
- ✅ Rebalance button lights up
- ✅ Click rebalance → "treatment" updates to `0.4`
- ✅ Origin variant value (0.6) preserved

**Verify:**
- AutomatableField wrapper shows override flag
- UpdateManager `rebalanceVariantWeights` called
- Origin variant value preserved

---

### TC-014: Case Variant Weight - UI Slider Change (Sidebar - Node Edit)

**Setup:**
- Case node selected in sidebar
- Has 3 variants: ["A", "B", "C"] with weights [0.33, 0.33, 0.34]

**Steps:**
1. Select case node in sidebar
2. Change variant[0] weight to `0.5`
3. Click rebalance button

**Expected:**
- ✅ Variant[0] updates to `0.5`
- ✅ Variants[1] and [2] rebalanced to `0.25` each
- ✅ Origin variant value preserved

---

### TC-015: Case Variant Weight - UI Slider Change (Sidebar - Edge Edit)

**Setup:**
- Edge A→B selected (case edge)
- Case node has variants

**Steps:**
1. Select edge in sidebar
2. Scroll to variant weight section
3. Change weight slider
4. Click rebalance button

**Expected:**
- ✅ Same as TC-013
- ✅ Sidebar updates correctly

---

### TC-016: Override Flag Display - All Locations

**Test each slider location:**
1. Edge Context Menu - Regular `p` ✅
2. Edge Context Menu - Conditional `p` ✅ (FIXED)
3. Edge Context Menu - Variant weight ✅
4. Sidebar - Regular `p` ✅
5. Sidebar - Conditional `p` ✅
6. Sidebar - Variant weight (node) ✅
7. Sidebar - Variant weight (edge) ✅ (FIXED)

**Expected:**
- ✅ All show AutomatableField wrapper
- ✅ Override flag icon displays when `_overridden = true`
- ✅ Clicking override icon clears flag
- ✅ Changing value sets `_overridden = true`

---

### TC-017: Rebalance Button Behavior - All Locations

**Test rebalance button:**
1. Change value via slider (don't rebalance)
2. Verify button lights up (yellow/orange) when unbalanced
3. Click rebalance button
4. Verify origin value preserved
5. Verify siblings updated

**Expected:**
- ✅ Button highlights when `isUnbalanced = true`
- ✅ Clicking preserves origin value
- ✅ Only siblings updated
- ✅ Override flags cleared on siblings (forceRebalance)

---

### TC-018: Query Signature Invalidation

**Setup:**
- Edge has conditional probability with `query_signature = "abc123"`
- Event definition changes (event_id changes)
- File has data with old signature

**Steps:**
1. Get from file
2. System detects signature mismatch

**Expected:**
- ✅ Only data matching latest signature used
- ✅ Missing dates identified
- ✅ Toast suggests "get from source"
- ✅ Get from source fetches missing data

---

### TC-019: Incremental Fetch with Signature Filtering

**Setup:**
- Edge has data for dates 2024-01-01 to 2024-01-10
- Some dates have signature "abc123", others "abc456"
- Latest signature is "abc123"
- User requests range 2024-01-01 to 2024-01-15

**Steps:**
1. Click "Get from Source"
2. System filters to latest signature first

**Expected:**
- ✅ Only "abc123" data considered for existing dates
- ✅ Missing dates (2024-01-11 to 2024-01-15) fetched
- ✅ New data gets latest signature

---

### TC-020: Cache Bust Behavior

**Setup:**
- Edge has data in file for all requested dates
- User wants to force re-fetch

**Steps:**
1. Enable "Bust cache" toggle
2. Click "Get from Sources"

**Expected:**
- ✅ All dates treated as missing
- ✅ Full re-fetch performed
- ✅ File updated with fresh data

---

## Implementation Checklist

### ✅ Completed
- [x] UpdateManager.rebalanceEdgeProbabilities (preserves origin)
- [x] UpdateManager.rebalanceConditionalProbabilities (preserves origin)
- [x] UpdateManager.rebalanceVariantWeights (preserves origin)
- [x] EdgeContextMenu conditional_p AutomatableField wrapper
- [x] PropertiesPanel variant weight AutomatableField wrapper (edge edit)
- [x] All rebalance handlers use UpdateManager
- [x] Override flags display correctly
- [x] Rebalance button highlights when unbalanced

### Testing Required
- [ ] Run TC-001 through TC-020
- [ ] Verify all override flags display
- [ ] Verify all rebalance buttons work
- [ ] Verify UpdateManager integration
- [ ] Verify origin values preserved
- [ ] Verify file operations work
- [ ] Verify external source operations work

