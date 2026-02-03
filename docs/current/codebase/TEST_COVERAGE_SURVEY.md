# DagNet Test Coverage Survey

**Date**: 3-Feb-26  
**Status**: Comprehensive analysis of test coverage across the codebase

---

## Executive Summary

The DagNet application has **moderate to good test coverage** with significant variation across different layers:

- ✅ **Services Layer**: Strong coverage (~185 test files for 102 services)
- ⚠️ **Components Layer**: Very low coverage (4 test files for 137 components)
- ✅ **Hooks Layer**: Moderate coverage (17 test files for 51 hooks)
- ✅ **Contexts Layer**: Good coverage (5 test files for 11 contexts)
- ✅ **E2E Tests**: 8 Playwright tests covering critical user flows
- ✅ **Integration Tests**: Comprehensive suite in `tests/` directory

**Overall Assessment**: The core business logic (services) is well-tested, but UI components have minimal test coverage. The test infrastructure is solid and well-organized.

---

## Detailed Coverage Analysis

### 1. Services Layer (`src/services/`)

**Status**: 🟢 **Strong Coverage**

- **Service Files**: 102 TypeScript files
- **Test Files**: 185 test files in `src/services/__tests__/`
- **Coverage Ratio**: ~1.8 tests per service (many services have multiple focused test files)

#### Well-Tested Services

The following services have comprehensive test coverage:

- ✅ `dataOperationsService` - Full integration tests (78+ tests)
- ✅ `fetchDataService` - Multiple integration and E2E tests
- ✅ `windowAggregationService` - Query signature cache, aggregation logic
- ✅ `querySignatureService` - Signature consistency and cache tests
- ✅ `signatureMatchingService` - Matching algorithms
- ✅ `mergeService` - Merge conflict resolution
- ✅ `fileOperationsService` - CRUD operations integration tests
- ✅ `gitService` - Git operations integration tests
- ✅ `indexRebuildService` - Critical index operations
- ✅ `snapshotWriteService` - Snapshot path handling
- ✅ `healthCheckService` - Health check logic
- ✅ `shareLinkService` - Link generation and validation
- ✅ `stalenessNudgeService` - Staleness detection
- ✅ `UpdateManager` - Core update logic (separate test file)

#### Services with Partial Coverage

These services have some tests but may need more comprehensive coverage:

- ⚠️ `repositoryOperationsService` - Some integration tests exist
- ⚠️ `workspaceService` - Limited test coverage
- ⚠️ `scenarioRegenerationService` - Date range normalization tests
- ⚠️ `queryRegenerationService` - nQuery tests
- ⚠️ `liveScenarios` - Integration tests exist

#### Services with Minimal/No Coverage

Based on the comparison, these services appear to have minimal or no dedicated test files:

- ❌ `activeGraphTrackerService`
- ❌ `analysisEChartsService` (has one test: `analysisEChartsService.funnelBar.stepChange.test.ts`)
- ❌ `analysisExportService`
- ❌ `anchorRegenerationService`
- ❌ `autoUpdatePolicyService`
- ❌ `automationRunService`
- ❌ `bannerManagerService` (has one test: `bannerManagerService.test.ts`)
- ❌ `chartOperationsService`
- ❌ `chartRecomputeService`
- ❌ `chartRefreshService`
- ❌ `ColourAssigner`
- ❌ `CompositionService` (has one test: `CompositionService.test.ts`)
- ❌ `conflictResolutionService` (has one test: `conflictResolutionService.test.ts`)
- ❌ `consoleMirrorService`
- ❌ `contextAggregationService` (has one test: `contextAggregation.test.ts`)
- ❌ `contextRegistry` (has one test: `contextRegistry.idbFallback.test.ts`)
- ❌ `copyVarsService`
- ❌ `countdownService`
- ❌ `credentialsService`
- ❌ `credentialsShareLinkService`
- ❌ `dailyRetrieveAllAutomationService`
- ❌ `deleteOperationsService` (has one test: `deleteOperationsService.test.ts`)
- ❌ `DiffService` (has one test: `DiffService.test.ts`)
- ❌ `dimensionalReductionService` (has one test: `dimensionalReductionService.test.ts`)
- ❌ `downloadService`
- ❌ `efBasisResolver`
- ❌ `fetchOrchestratorService`
- ❌ `fetchPlanBuilderService`
- ❌ `fetchPlanTypes`
- ❌ `fetchRefetchPolicy`
- ❌ `fetchTargetEnumerationService`
- ❌ `forecastingSettingsService`
- ❌ `graphGitService`
- ❌ `graphHistoryService`
- ❌ `graphInputSignatureService`
- ❌ `graphIssuesClipboardExport`
- ❌ `graphIssuesService` (has tests: `graphIssuesService.categoryFilter.test.ts`, `graphIssuesService.exportIssuesForClipboard.test.ts`)
- ❌ `graphMutationService` (has one test: `graphMutationService.latencyEnablesMsmdcChangeDetection.test.ts`)
- ❌ `graphSnapshotService`
- ❌ `graphTopologySignatureService`
- ❌ `imageOperationsService`
- ❌ `imageService`
- ❌ `integrityCheckService` (has tests: `integrityCheckService.blankStringEqualsUndefined.test.ts`, `integrityCheckService.conditionalSiblingAlignment.test.ts`)
- ❌ `lagDistributionUtils`
- ❌ `lagHorizonsService`
- ❌ `lagMixtureAggregationService`
- ❌ `layoutService`
- ❌ `liveShareBootService`
- ❌ `liveShareHydrationService`
- ❌ `liveShareSyncService`
- ❌ `logFileService`
- ❌ `meceSliceService`
- ❌ `onsetDerivationService` (has tests: `onset_cohort_excluded.test.ts`, `onset_override_flow.test.ts`, `onset_shifted_completeness.test.ts`)
- ❌ `persistedCaseConfigService`
- ❌ `persistedParameterConfigService`
- ❌ `plannerQuerySignatureService`
- ❌ `propertiesPanelHeaderBadgeService` (has one test: `propertiesPanelHeaderBadgeService.test.ts`)
- ❌ `rateLimiter` (has one test: `rateLimitCooldown.test.ts`)
- ❌ `registryService`
- ❌ `retrieveAllSlicesPlannerService`
- ❌ `retrieveAllSlicesService`
- ❌ `scenarioParamPacksClipboardExport`
- ❌ `scenarioProvenanceService`
- ❌ `sessionLogMirrorService`
- ❌ `sessionLogService`
- ❌ `sheetsContextFallback` (has one test: `sheetsContextFallback.test.ts`)
- ❌ `signaturePolicyService`
- ❌ `sliceIsolation` (has one test: `sliceIsolation.test.ts`)
- ❌ `slicePlanValidationService`
- ❌ `statisticalEnhancementService` (has one test: `statisticalEnhancementService.test.ts`)
- ❌ `timeSeriesUtils`
- ❌ `ukDayBoundarySchedulerService`
- ❌ `ukReferenceDayService`
- ❌ `variableAggregationCache` (has one test: `variableAggregationCache.test.ts`)
- ❌ `whereUsedService`
- ❌ `windowFetchPlannerService` (has one test: `windowFetchPlannerService.test.ts`)

**Note**: Some services may be tested indirectly through integration tests or E2E tests, but lack dedicated unit tests.

---

### 2. Components Layer (`src/components/`)

**Status**: 🔴 **Very Low Coverage**

- **Component Files**: 137 TSX files
- **Test Files**: 4 test files in `src/components/__tests__/`
- **Coverage Ratio**: ~0.03 tests per component (3% coverage)

#### Tested Components

- ✅ `PropertiesPanel` - Latency toggle and hooks tests (`PropertiesPanel.latencyToggleTriggersGraphMutation.test.tsx`, `PropertiesPanel.hooks.test.tsx`)
- ✅ `QueryExpressionEditor` - Query DSL tests (`QueryExpressionEditor.test.tsx`)
- ✅ `ScenarioLegend` - Dashboard DSL tests (`ScenarioLegend.dashboardDsl.test.tsx`)
- ✅ `EnhancedSelector` - Auto-get tests (`EnhancedSelector.autoGet.test.ts`)
- ✅ `ConversionEdge` - Sankey parity tests (`ConversionEdge.sankeyParity.test.tsx`)
- ✅ `EdgeBeads` - Multiple tests (probability mode, derived brackets, scalar evidence)
- ✅ `NavigatorContent` - Registry sync tests (`NavigatorContent.registrySync.test.tsx`)

#### Untested Components (Major Gaps)

Critical UI components with no test coverage:

- ❌ `GraphEditor` - Main editor component (2258+ lines)
- ❌ `GraphCanvas` - Core graph visualization (5466+ lines)
- ❌ `PropertiesPanelWrapper` - Properties panel wrapper
- ❌ `MenuBar` / `FileMenu` / `EditMenu` / `ViewMenu` / `ObjectsMenu` / `DataMenu` / `RepositoryMenu` / `HelpMenu` - All menu components
- ❌ `Navigator` - File navigator
- ❌ `DashboardShell` - Dashboard UI
- ❌ `AnalyticsPanel` - Analytics display
- ❌ `ScenariosPanel` - Scenarios management (1882+ lines)
- ❌ `WhatIfPanel` - What-if analysis panel
- ❌ `ToolsPanel` - Tools sidebar
- ❌ `LightningMenu` - Context menu
- ❌ `DataSectionSubmenu` - Data operations menu
- ❌ All modal components (`MergeConflictModal` has one test)
- ❌ All form components
- ❌ All chart/viewer components

**Impact**: UI regressions are likely to go undetected. Component behavior changes are not automatically validated.

---

### 3. Hooks Layer (`src/hooks/`)

**Status**: 🟡 **Moderate Coverage**

- **Hook Files**: 51 TypeScript files
- **Test Files**: 17 test files in `src/hooks/__tests__/`
- **Coverage Ratio**: ~0.33 tests per hook (33% coverage)

#### Tested Hooks

- ✅ `useSnapshotsMenu` - Snapshot menu logic
- ✅ `useFetchData` - Data fetching hooks
- ✅ `useStalenessNudges` - Staleness detection (multiple test files)
- ✅ `useCopyPaste` - Copy/paste functionality
- ✅ `usePullAll` - Force replace countdown
- ✅ `useBulkScenarioCreation` - Graph store optional tests
- ✅ `useShareChartFromUrl` - Share chart URL handling

#### Untested Hooks

Many hooks lack dedicated tests, including:

- ❌ `useSidebarState` - Sidebar state management
- ❌ `useDashboardMode` - Dashboard mode switching
- ❌ `useURLScenarios` - URL scenario parsing
- ❌ `useActiveGraphTracking` - Active graph tracking
- ❌ `usePutToBaseRequestListener` - Put to base requests
- ❌ `useItemFiltering` - Item filtering logic
- ❌ Most context hooks (may be tested indirectly through context tests)

---

### 4. Contexts Layer (`src/contexts/`)

**Status**: 🟢 **Good Coverage**

- **Context Files**: 11 TSX files
- **Test Files**: 5 test files in `src/contexts/__tests__/`
- **Coverage Ratio**: ~0.45 tests per context (45% coverage)

#### Tested Contexts

- ✅ `DashboardModeContext` - Dashboard mode state
- ✅ `GraphStoreContext` - Cleanup and state management
- ✅ `NavigatorContext` - Read-only mode
- ✅ `ScenariosContext` - Live scenarios
- ✅ `TabContext` - Visibility mode persistence

#### Untested Contexts

- ❌ `CredentialsContext` - Credentials management
- ❌ `DialogContext` - Dialog state
- ❌ `ShareModeContext` - Share mode state
- ❌ `ValidationContext` - Validation state
- ❌ `ViewPreferencesContext` - View preferences
- ❌ `VisibleTabsContext` - Visible tabs management
- ❌ `WhatIfContext` - What-if analysis state

---

### 5. Integration Tests (`tests/`)

**Status**: 🟢 **Comprehensive Suite**

The `tests/` directory contains a well-organized integration test suite:

#### Test Categories

1. **Smoke Tests** (`smoke.test.ts`) - 18 tests
   - Infrastructure validation
   - Module imports
   - Critical bug prevention

2. **Unit Tests** (`unit/`)
   - `query-dsl.test.ts` - 31 tests
   - `composite-query-parser.test.ts` - 21 tests
   - `update-manager-uuids.test.ts` - 22 tests
   - `query-signature.test.ts` - 24 tests
   - **Total**: ~116 unit tests

3. **Integration Tests** (`integration/`)
   - `query-to-graph.test.ts` - Query execution flow

4. **Pipeline Integrity** (`pipeline-integrity/`)
   - `simple-query-flow.test.ts` - Basic query pipeline
   - `composite-query-flow.test.ts` - Composite query execution

5. **State Sync** (`state-sync/`)
   - `multi-source-truth.test.ts` - Graph ↔ File ↔ UI consistency

6. **Context Propagation** (`context-propagation/`)
   - `flag-threading.test.ts` - Flag propagation through call stack

7. **Identity** (`identity/`)
   - `signature-consistency.test.ts` - Query signature consistency

8. **Validation** (`validation/`)
   - `input-sanitization.test.ts` - Input validation

9. **Phase 4 E2E** (`phase4-e2e/`)
   - `amplitude-real-api.test.ts` - Real API integration
   - `channel-context-integration.test.ts` - Channel context

**Total Integration Tests**: ~150+ tests across multiple categories

---

### 6. E2E Tests (`e2e/`)

**Status**: 🟢 **Critical Flows Covered**

- **Test Files**: 8 Playwright spec files
- **Coverage**: Critical user-facing workflows

#### E2E Test Coverage

- ✅ `snapshotsEdgeBadgeMenuVisibility.spec.ts` - Snapshot menu visibility
- ✅ `snapshotsSubmenuVisibility.spec.ts` - Snapshot submenu
- ✅ `autoRebalanceOnManualEdit.spec.ts` - Auto-rebalance on edit
- ✅ `enhancedSelectorStaleGraph.spec.ts` - Stale graph handling
- ✅ `rateLimitCooldown.spec.ts` - Rate limiting UI
- ✅ `shareScenario.spec.ts` - Scenario sharing
- ✅ `autoUpdateCharts.spec.ts` - Chart auto-updates
- ✅ `shareLiveChart.spec.ts` - Live chart sharing

**Coverage**: Critical user workflows are tested, but many UI interactions remain untested.

---

## Test Infrastructure Quality

### ✅ Strengths

1. **Well-Organized Structure**
   - Clear separation: unit tests, integration tests, E2E tests
   - Test helpers and fixtures available
   - Mock utilities for FileRegistry, DAS runner

2. **Comprehensive Service Tests**
   - Many services have multiple focused test files
   - Integration tests cover critical data flows
   - E2E tests validate end-to-end workflows

3. **Good Documentation**
   - Test suite summaries (`TEST_SUITE_SUMMARY.md`, `COMPLETION_REPORT.md`)
   - README files explaining test patterns
   - Clear test naming conventions

4. **Fast Execution**
   - Unit tests run in <1 second
   - Integration tests are reasonably fast
   - E2E tests are focused and quick (~10-15s each)

5. **Bug Prevention Focus**
   - Tests explicitly prevent regressions
   - Historical bugs documented in test names
   - Critical paths well-covered

### ⚠️ Weaknesses

1. **Component Test Coverage**
   - Only 4 component test files for 137 components
   - Critical UI components untested
   - UI regressions likely to go undetected

2. **Service Coverage Gaps**
   - ~60+ services have minimal or no dedicated tests
   - Many services tested indirectly only
   - Some critical services lack unit tests

3. **Hook Coverage**
   - Only 33% of hooks have dedicated tests
   - Many hooks tested indirectly through components/contexts

4. **No Coverage Metrics**
   - No automated coverage reporting
   - Coverage thresholds set to 0%
   - No visibility into actual coverage percentages

---

## Coverage by Criticality

### 🔴 P0 (Critical) - Well Tested

- ✅ Data operations (`dataOperationsService`)
- ✅ Query execution (`fetchDataService`, `compositeQueryExecutor`)
- ✅ File operations (`fileOperationsService`)
- ✅ Git operations (`gitService`, `repositoryOperationsService`)
- ✅ Graph updates (`UpdateManager`)
- ✅ Merge conflicts (`mergeService`)
- ✅ Query signatures (`querySignatureService`)

### 🟡 P1 (High) - Partially Tested

- ⚠️ Workspace management (`workspaceService`)
- ⚠️ Index operations (`indexRebuildService` - has critical tests)
- ⚠️ Scenario management (`scenarioRegenerationService`)
- ⚠️ Chart operations (`chartOperationsService`, `chartRecomputeService` - untested)
- ⚠️ Analysis (`analysisEChartsService` - minimal tests)

### 🟢 P2 (Medium) - Minimal Testing

- ❌ UI components (most untested)
- ❌ Layout services (`layoutService`)
- ❌ Image operations (`imageOperationsService`, `imageService`)
- ❌ Export services (`analysisExportService`, `downloadService`)
- ❌ Automation (`automationRunService`, `dailyRetrieveAllAutomationService`)

---

## Recommendations

### Immediate Priorities

1. **Add Component Tests for Critical UI**
   - `GraphEditor` - Main editor component
   - `GraphCanvas` - Graph visualization
   - `PropertiesPanel` - Already has some tests, expand coverage
   - `MenuBar` components - Menu interactions
   - `Navigator` - File navigation

2. **Add Unit Tests for Untested Services**
   - Focus on services with complex logic:
     - `workspaceService` - Workspace management
     - `chartOperationsService` - Chart operations
     - `layoutService` - Layout algorithms
     - `imageOperationsService` - Image handling

3. **Enable Coverage Reporting**
   - Configure coverage thresholds
   - Add coverage reports to CI/CD
   - Track coverage trends over time

### Medium-Term Improvements

1. **Expand Hook Coverage**
   - Test hooks in isolation
   - Focus on hooks with complex state logic
   - Test hooks used by multiple components

2. **Add More E2E Tests**
   - Critical user workflows
   - Multi-step operations
   - Error scenarios

3. **Test Context Providers**
   - Test context state management
   - Test context value propagation
   - Test context cleanup

### Long-Term Goals

1. **Achieve 80%+ Coverage**
   - Set coverage thresholds
   - Require tests for new code
   - Regular coverage reviews

2. **Component Test Strategy**
   - Establish component testing patterns
   - Create component test helpers
   - Test component interactions

3. **Visual Regression Testing**
   - Consider adding visual regression tests
   - Test UI component rendering
   - Catch visual bugs automatically

---

## Test Execution Statistics

### Test Counts

- **Service Tests**: ~185 test files
- **Component Tests**: ~4 test files
- **Hook Tests**: ~17 test files
- **Context Tests**: ~5 test files
- **Integration Tests**: ~150+ tests
- **E2E Tests**: 8 Playwright specs
- **Total Test Files**: ~258 test files

### Test Execution Speed

- **Unit Tests**: <1 second (smoke tests)
- **Integration Tests**: Seconds to minutes (depending on scope)
- **E2E Tests**: ~10-15 seconds each (Playwright)

---

## Conclusion

The DagNet application has **strong test coverage in the services layer** (core business logic) but **very weak coverage in the UI layer** (components). The test infrastructure is solid and well-organized, with good integration and E2E test coverage for critical workflows.

**Overall Assessment**: 🟡 **Moderate Coverage** (strong in services, weak in UI)

**Key Strengths**:
- Comprehensive service layer tests
- Good integration test suite
- Well-organized test structure
- Fast test execution

**Key Weaknesses**:
- Minimal component test coverage
- Many services lack dedicated tests
- No automated coverage reporting
- UI regressions likely to go undetected

**Recommendation**: Prioritize adding component tests for critical UI components and unit tests for untested services, while maintaining the strong service test coverage that already exists.
