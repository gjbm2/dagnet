/**
 * WindowSelector Preset Regression Tests
 *
 * Locks in the invariant: EVERY preset button must update BOTH
 *   1. graphStore.window  (UI date range)
 *   2. graphStore.currentDSL  (authoritative DSL used by all fetch operations)
 *
 * Regression: The "Today" preset previously only called setWindow() and
 * forgot to update currentDSL, so fetches still used the previous 7-day range.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowSelector } from '../WindowSelector';
import { GraphStoreContext, createGraphStore } from '../../contexts/GraphStoreContext';
import type { GraphStoreHook } from '../../contexts/GraphStoreContext';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn().mockReturnValue('toast-id'),
    dismiss: vi.fn(),
  }),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({
    tabs: [],
    operations: { openTab: vi.fn() },
  }),
  fileRegistry: {
    getFile: vi.fn(),
    updateFile: vi.fn(),
    setFile: vi.fn(),
    markDirty: vi.fn(),
  },
}));

vi.mock('../../contexts/ShareModeContext', () => ({
  useIsReadOnlyShare: () => false,
}));

vi.mock('../../hooks/useFetchData', () => ({
  useFetchData: () => ({
    fetchItem: vi.fn(),
    fetchItems: vi.fn(),
    getItemsNeedingFetch: vi.fn().mockReturnValue([]),
  }),
  createFetchItem: vi.fn(),
}));

vi.mock('../../hooks/useBulkScenarioCreation', () => ({
  useBulkScenarioCreation: () => ({
    createWindowScenario: vi.fn(),
    createMultipleWindowScenarios: vi.fn(),
    getWindowDSLForPreset: vi.fn(),
    openBulkCreateForContext: vi.fn(),
    bulkCreateModal: null,
    closeBulkCreateModal: vi.fn(),
    createScenariosForContext: vi.fn(),
  }),
}));

vi.mock('../../services/windowFetchPlannerService', () => ({
  windowFetchPlannerService: {
    analyse: vi.fn().mockResolvedValue({
      status: 'complete',
      outcome: 'covered_stable',
      summaries: { buttonTooltip: '', showToast: false },
      analysisContext: { trigger: 'dsl_change' },
      autoAggregationItems: [],
    }),
    executeFetchPlan: vi.fn(),
    invalidateCache: vi.fn(),
  },
}));

vi.mock('../../services/snapshotRetrievalsService', () => ({
  getSnapshotRetrievalsForEdge: vi.fn().mockResolvedValue({}),
  getSnapshotCoverageForEdges: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../hooks/useQuerySelectionUuids', () => ({
  querySelectionUuids: () => ({
    selectedNodeUuids: [],
    selectedEdgeUuids: [],
  }),
}));

vi.mock('../DateRangePicker', () => ({
  DateRangePicker: () => <div data-testid="date-range-picker" />,
}));

vi.mock('../CalendarGrid', () => ({
  CalendarGrid: () => <div data-testid="calendar-grid" />,
}));

vi.mock('../ContextValueSelector', () => ({
  ContextValueSelector: () => <div data-testid="context-value-selector" />,
}));

vi.mock('../QueryExpressionEditor', () => ({
  QueryExpressionEditor: () => <div data-testid="query-expression-editor" />,
}));

vi.mock('../modals/PinnedQueryModal', () => ({
  PinnedQueryModal: () => null,
}));

vi.mock('../modals/BulkScenarioCreationModal', () => ({
  BulkScenarioCreationModal: () => null,
}));

// ============================================================================
// HELPERS
// ============================================================================

/** Frozen time: 10-Feb-26 12:00 UTC */
const FROZEN_NOW = new Date('2026-02-10T12:00:00.000Z');

function renderWithStore(store: GraphStoreHook) {
  return render(
    <GraphStoreContext.Provider value={store}>
      <WindowSelector />
    </GraphStoreContext.Provider>
  );
}

/**
 * Create a store pre-loaded with a 7-day cohort DSL (the scenario that
 * triggered the original regression).
 */
function makeStoreWithPriorDSL(dsl: string, window: { start: string; end: string }) {
  const store = createGraphStore();
  store.setState({
    graph: { nodes: [], edges: [], currentQueryDSL: dsl } as any,
    window,
    currentDSL: dsl,
  } as any);
  return store;
}

// ============================================================================
// TESTS
// ============================================================================

describe('WindowSelector presets — authoritative DSL invariant', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // REGRESSION: Today preset must update currentDSL
  // --------------------------------------------------------------------------

  it('REGRESSION: Today preset updates currentDSL (not just window)', () => {
    const store = makeStoreWithPriorDSL(
      'cohort(3-Feb-26:9-Feb-26)',
      { start: '3-Feb-26', end: '9-Feb-26' },
    );

    renderWithStore(store);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    const state = store.getState();
    expect(state.window).toEqual({ start: '10-Feb-26', end: '10-Feb-26' });
    expect(state.currentDSL).toBe('cohort(10-Feb-26:10-Feb-26)');
    // graph.currentQueryDSL (historic record) must also match
    expect((state.graph as any)?.currentQueryDSL).toBe('cohort(10-Feb-26:10-Feb-26)');
  });

  // --------------------------------------------------------------------------
  // 7d preset — baseline (was already correct)
  // --------------------------------------------------------------------------

  it('7d preset updates both window and currentDSL', () => {
    const store = makeStoreWithPriorDSL(
      'cohort(10-Feb-26:10-Feb-26)',
      { start: '10-Feb-26', end: '10-Feb-26' },
    );

    renderWithStore(store);
    fireEvent.click(screen.getByText('7d'));

    const state = store.getState();
    // 7d = yesterday back 6 days → 3-Feb-26 to 9-Feb-26
    expect(state.window).toEqual({ start: '3-Feb-26', end: '9-Feb-26' });
    expect(state.currentDSL).toBe('cohort(3-Feb-26:9-Feb-26)');
    expect((state.graph as any)?.currentQueryDSL).toBe('cohort(3-Feb-26:9-Feb-26)');
  });

  // --------------------------------------------------------------------------
  // 30d preset
  // --------------------------------------------------------------------------

  it('30d preset updates both window and currentDSL', () => {
    const store = makeStoreWithPriorDSL(
      'cohort(10-Feb-26:10-Feb-26)',
      { start: '10-Feb-26', end: '10-Feb-26' },
    );

    renderWithStore(store);
    fireEvent.click(screen.getByText('30d'));

    const state = store.getState();
    // 30d = yesterday back 29 days → 11-Jan-26 to 9-Feb-26
    expect(state.window).toEqual({ start: '11-Jan-26', end: '9-Feb-26' });
    expect(state.currentDSL).toBe('cohort(11-Jan-26:9-Feb-26)');
  });

  // --------------------------------------------------------------------------
  // 90d preset
  // --------------------------------------------------------------------------

  it('90d preset updates both window and currentDSL', () => {
    const store = makeStoreWithPriorDSL(
      'cohort(10-Feb-26:10-Feb-26)',
      { start: '10-Feb-26', end: '10-Feb-26' },
    );

    renderWithStore(store);
    fireEvent.click(screen.getByText('90d'));

    const state = store.getState();
    // 90d = yesterday back 89 days → 12-Nov-25 to 9-Feb-26
    expect(state.window).toEqual({ start: '12-Nov-25', end: '9-Feb-26' });
    expect(state.currentDSL).toBe('cohort(12-Nov-25:9-Feb-26)');
  });

  // --------------------------------------------------------------------------
  // Context preservation: Today preset must keep context clauses
  // --------------------------------------------------------------------------

  it('Today preset preserves context clauses in DSL', () => {
    const store = makeStoreWithPriorDSL(
      'context(channel:google).cohort(3-Feb-26:9-Feb-26)',
      { start: '3-Feb-26', end: '9-Feb-26' },
    );

    renderWithStore(store);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    const state = store.getState();
    expect(state.currentDSL).toBe('context(channel:google).cohort(10-Feb-26:10-Feb-26)');
  });

  // --------------------------------------------------------------------------
  // Window mode: Today preset uses window() not cohort() when in window mode
  // --------------------------------------------------------------------------

  it('Today preset uses window() function when queryMode is window', () => {
    const store = makeStoreWithPriorDSL(
      'cohort(3-Feb-26:9-Feb-26)',
      { start: '3-Feb-26', end: '9-Feb-26' },
    );

    const { unmount } = renderWithStore(store);

    // Switch to window mode (toggle defaults to cohort → becomes window)
    const modeToggle = screen.getByTitle(/Cohort mode/);
    fireEvent.click(modeToggle);

    // The toggle click updates currentDSL to window(3-Feb-26:9-Feb-26) and
    // re-renders the component with queryMode='window'. Unmount and re-render
    // to ensure React state settles before the next interaction.
    unmount();
    renderWithStore(store);

    // Now click Today — should use window() mode
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    const state = store.getState();
    expect(state.window).toEqual({ start: '10-Feb-26', end: '10-Feb-26' });
    expect(state.currentDSL).toBe('window(10-Feb-26:10-Feb-26)');
  });

  // --------------------------------------------------------------------------
  // No-op: clicking Today when already on today should not re-emit DSL
  // --------------------------------------------------------------------------

  it('Today preset is a no-op when already showing today', () => {
    const todayDSL = 'cohort(10-Feb-26:10-Feb-26)';
    const store = makeStoreWithPriorDSL(
      todayDSL,
      { start: '10-Feb-26', end: '10-Feb-26' },
    );

    renderWithStore(store);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    // Should remain unchanged (the skip-if-unchanged guard)
    const state = store.getState();
    expect(state.currentDSL).toBe(todayDSL);
  });
});
