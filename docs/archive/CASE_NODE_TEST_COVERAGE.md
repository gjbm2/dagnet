# Case Node & Variant Test Coverage Analysis

## Summary

| Area | Coverage | Status |
|------|----------|--------|
| Variant Synchronisation (file↔graph) | ✅ **Comprehensive** | Good |
| Rebalancing | ⚠️ **Minimal** | Needs work |
| File Operations | ✅ **Good** | OK |
| Roundtrips | ⚠️ **Basic** | Needs expansion |
| External Data (Statsig) | ❌ **None** | Critical gap |
| Runtime (probability calculation) | ❌ **None** | Critical gap |
| What-If Case Overrides | ❌ **None** | Critical gap |
| Edge-Variant Assignment | ⚠️ **Minimal** | Needs work |
| Provenance | ✅ **Good** | OK |
| Sheets Integration | ✅ **Good** | OK |

## Existing Test Coverage

### 1. `variantSync.test.ts` - ✅ Comprehensive

**File → Graph Sync**
- ✅ Add new variants from file to graph
- ✅ Preserve graph-only variants (with edges or overrides)
- ✅ Remove disposable graph-only variants
- ✅ Respect `weight_overridden` flags
- ✅ Respect `description_overridden` flags
- ✅ Initialise empty graph with file variants
- ✅ Initialise missing case structure
- ✅ Prefer `schedules[latest].variants` over `case.variants`

**Graph → File Sync**
- ✅ Update existing file variants with graph data
- ✅ Add new graph variants to file
- ✅ Respect override flags when updating file
- ✅ Preserve other file variant properties

**Edge Cases**
- ✅ Empty variants in both graph and file
- ✅ Variant name changes via `name_overridden`
- ✅ Variants with undefined/null descriptions
- ✅ Weight normalisation errors

**Round-Trip Consistency**
- ✅ GET → edit → PUT cycle

**Real-World Scenarios**
- ✅ 3-variant A/B/C test
- ✅ User removing variant from graph

### 2. `getCaseFromFile.test.ts` - ✅ Good

**Error Handling**
- ✅ No graph provided
- ✅ No nodeId provided
- ✅ Case file not found
- ✅ Node not found in graph

**Basic Functionality**
- ✅ Call UpdateManager.handleFileToGraph for files without schedules
- ✅ Process window aggregation when window and schedules provided

**Edge Cases**
- ✅ Case file with empty variants array
- ✅ Graph with node but no case property

### 3. `UpdateManager.rebalance.test.ts` - ⚠️ Minimal

**rebalanceVariantWeights**
- ✅ Basic rebalance with force (1 test only)

**MISSING**:
- ❌ Rebalance without force (respect `weight_overridden`)
- ❌ Rebalance with only 2 variants
- ❌ Rebalance with origin at 0% or 100%
- ❌ Rebalance with all others overridden
- ❌ Edge case: weight already sums to 1.0
- ❌ Edge case: PMF precision issues

### 4. `dataOperations.integration.test.ts` - ⚠️ Basic

**Case Roundtrips**
- ✅ Graph → file → graph preserves variants
- ✅ Put to file includes provenance
- ✅ `case.id` preserved after get
- ✅ Missing case file doesn't crash

**MISSING**:
- ❌ Multiple sequential updates preserve state
- ❌ Override flags preserved through roundtrip
- ❌ Schedules array grows correctly

### 5. `valuesLatest.test.ts` - ✅ Good

**Case schedules[latest] Resolution**
- ✅ Finds most recent schedule by `window_from`

### 6. `provenance.test.ts` - ✅ Good

**Case Provenance**
- ✅ Schedule includes `source: manual`
- ✅ Schedule includes all variants
- ✅ Schedule only includes name and weight for variants

### 7. `idPreservation.test.ts` - ✅ Good

**Case ID Preservation**
- ✅ `node.case.id` preserved after file→graph update
- ✅ Both `node.id` and `case.id` preserved together
- ✅ `case.id` survives multiple updates

### 8. `sheets.e2e.integration.test.ts` - ✅ Good

**Case Variants from Sheets**
- ✅ Case variant HRN keys → updates `case.variants`

### 9. `dataOperationsService.test.ts` - ⚠️ Basic

**Case Operations**
- ✅ Get case from file and update graph node
- ✅ Put case to file from graph node
- ✅ Handle missing case file gracefully

## Critical Test Gaps

### Gap 1: External → Graph (Direct) - Statsig Fetch
**Zero coverage** for `getFromSourceDirect({ objectType: 'case' })`.

**Required tests:**
- [ ] Statsig/external data applies to `node.case.variants`
- [ ] Auto-rebalance triggers after external update
- [ ] Evidence (`node.case.evidence`) populated correctly
- [ ] `weight_overridden` variants not overwritten
- [ ] Multiple variants updated from API
- [ ] API returns new variant not in graph

### Gap 2: External → File → Graph (Versioned Path)
**Zero coverage** for `versionedCase: true` path.

**Required tests:**
- [ ] Schedule appended to `case.schedules[]`
- [ ] `schedules[latest]` used for graph update
- [ ] Provenance (`source`) set correctly
- [ ] Multiple fetches create multiple schedule entries
- [ ] Window aggregation for versioned case

### Gap 3: Runtime Probability Calculation
**Zero coverage** for case variant effect on edge probability.

**Required tests:**
- [ ] Edge probability = `edge.p.mean × variant.weight`
- [ ] Edge with no `case_variant` ignores variant weight
- [ ] Variant weight = 0 results in edge probability = 0
- [ ] Case node variants sum to 1.0 in runner

### Gap 4: What-If Case Overrides
**Zero coverage** for `case(id:variant)` DSL in what-if analysis.

**Required tests:**
- [ ] `case(test:treatment)` sets treatment to 100%
- [ ] Other variants set to 0% when override active
- [ ] Multiple case overrides in same DSL
- [ ] Case override combined with visited override
- [ ] Case override resolution in `computeEffectiveEdgeProbability`

### Gap 5: Rebalancing Edge Cases
**Only 1 test** for variant rebalancing.

**Required tests:**
- [ ] forceRebalance=false respects `weight_overridden`
- [ ] Rebalance with 2 variants
- [ ] Origin variant at 0% or 100%
- [ ] All other variants overridden (skip rebalance)
- [ ] PMF precision (sum to 1.0 within tolerance)
- [ ] Rebalance after multiple edits

### Gap 6: Edge-Variant Assignment
**Minimal coverage** for edge-case-variant linking.

**Required tests:**
- [ ] `updateEdgeProperty({ case_variant, case_id })` sets correctly
- [ ] `case_id` auto-inferred from source node
- [ ] Clearing `case_variant` also clears `case_id`
- [ ] Edge reconnection preserves `case_variant` (partial coverage exists)
- [ ] Creating edge from case node shows variant modal
- [ ] Variant assignment validates against node's variants

### Gap 7: UI Integration
**Zero test coverage** for UI case operations.

**Required tests (if adding component tests):**
- [ ] PropertiesPanel displays case variants
- [ ] Variant weight slider triggers rebalance
- [ ] Clear override button works
- [ ] EdgeContextMenu shows variant weight

## Test Files to Create/Extend

### Priority 1: Critical Gaps

**1. Create `caseExternalFetch.integration.test.ts`**
- External → Graph direct path (Statsig-like)
- External → File → Graph versioned path
- Auto-rebalance after fetch
- Evidence population

**2. Create `caseRuntime.test.ts`**
- Edge probability with variant weights
- Variant weight = 0 case
- Runner integration with case edges

**3. Extend `UpdateManager.rebalance.test.ts`**
- Add 10+ tests for `rebalanceVariantWeights`
- Cover all edge cases in rebalancing

### Priority 2: Expand Existing

**4. Extend `dataOperations.integration.test.ts`**
- Multiple sequential case updates
- Override preservation through roundtrip

**5. Create `caseWhatIf.test.ts`**
- `case(id:variant)` DSL parsing
- Override application in probability calculation
- Combined case + visited overrides

### Priority 3: Edge Cases

**6. Extend `variantSync.test.ts`**
- More edge cases for variant merge
- Conflict resolution scenarios

**7. Create `edgeVariantAssignment.test.ts`**
- Full edge-case-variant linking tests
- Auto-inference of `case_id`

## Comparison: Case vs Parameter Test Parity

| Test Type | Parameter (`edge.p`) | Case Variant |
|-----------|---------------------|--------------|
| File → Graph | ✅ Comprehensive | ✅ Good |
| Graph → File | ✅ Comprehensive | ✅ Good |
| External → Graph | ✅ Has tests | ❌ **None** |
| External → File → Graph | ✅ Has tests | ❌ **None** |
| Roundtrips | ✅ Multiple tests | ⚠️ Basic |
| Override handling | ✅ Comprehensive | ✅ Good |
| ID preservation | ✅ Comprehensive | ✅ Good |
| Provenance | ✅ Comprehensive | ✅ Good |
| Rebalancing | ✅ Edge probability | ⚠️ Minimal |
| Runtime evaluation | ✅ Has tests | ❌ **None** |
| What-If | ✅ Has tests | ❌ **None** |
| Sheets | ✅ Has tests | ✅ Good |

## Recommendations

### Immediate Actions (Critical)
1. **Add external fetch tests** - Statsig/API → graph variant update
2. **Add runtime tests** - Variant weight effect on edge probability
3. **Expand rebalancing tests** - Cover all edge cases

### Short-Term Actions
4. Add what-if case override tests
5. Add versioned case path tests (schedule history)
6. Add edge-variant assignment tests

### Long-Term
7. Add E2E UI tests for case operations
8. Add stress tests for many-variant scenarios









