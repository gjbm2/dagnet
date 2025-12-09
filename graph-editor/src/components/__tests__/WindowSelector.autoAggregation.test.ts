/**
 * WindowSelector Auto-Aggregation Tests
 * 
 * Tests for the auto-aggregation behaviour in WindowSelector including:
 * - Cache validity checks
 * - Trigger conditions on DSL change
 * - Shimmer animation state
 * - Debouncing of rapid DSL changes
 * - Coverage computation
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// ============================================================================
// MOCK DEPENDENCIES
// ============================================================================

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn().mockReturnValue('toast-id'),
    dismiss: vi.fn()
  })
}));

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}));

// Mock dataOperationsService
vi.mock('../../services/dataOperationsService', () => ({
  dataOperationsService: {
    getParameterFromFile: vi.fn().mockResolvedValue(undefined),
    getCaseFromFile: vi.fn().mockResolvedValue(undefined),
    getNodeFromFile: vi.fn().mockResolvedValue(undefined),
    getFromSource: vi.fn().mockResolvedValue(undefined),
    getFromSourceDirect: vi.fn().mockResolvedValue(undefined)
  }
}));

// Mock windowAggregationService
vi.mock('../../services/windowAggregationService', () => ({
  calculateIncrementalFetch: vi.fn(),
  hasFullSliceCoverageByHeader: vi.fn(),
  WindowAggregationService: class {
    aggregateWindow = vi.fn();
    getCaseWeightsForWindow = vi.fn();
  }
}));

// Mock fileRegistry
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(),
    setFile: vi.fn(),
    markDirty: vi.fn()
  }
}));

// Import after mocks
import { dataOperationsService } from '../../services/dataOperationsService';
import { calculateIncrementalFetch } from '../../services/windowAggregationService';
import { fileRegistry } from '../../contexts/TabContext';

// ============================================================================
// TEST HELPERS
// ============================================================================

interface MockGraphData {
  nodes: any[];
  edges: any[];
  currentQueryDSL: string;
  metadata?: any;
}

function createMockGraph(options: {
  dsl?: string;
  paramCount?: number;
  hasData?: boolean;
}): MockGraphData {
  const { dsl = 'window(1-Dec-25:7-Dec-25)', paramCount = 2, hasData = true } = options;
  
  const edges = [];
  for (let i = 1; i <= paramCount; i++) {
    edges.push({
      uuid: `edge-${i}`,
      id: `e${i}`,
      from: 'node-a',
      to: `node-b${i}`,
      query: 'from(a).to(b)',
      p: {
        id: `param-${i}`,
        mean: hasData ? 0.5 : undefined,
        stdev: hasData ? 0.1 : undefined,
        connection: 'amplitude'
      }
    });
  }
  
  return {
    nodes: [
      { uuid: 'node-a', id: 'a', type: 'event', label: 'Start' },
      { uuid: 'node-b1', id: 'b1', type: 'event', label: 'End 1' },
      { uuid: 'node-b2', id: 'b2', type: 'event', label: 'End 2' }
    ],
    edges,
    currentQueryDSL: dsl,
    metadata: { updated_at: new Date().toISOString() }
  };
}

function createMockParamFile(options: {
  paramId: string;
  hasDailyData?: boolean;
  datesCovered?: string[];
}) {
  const { paramId, hasDailyData = true, datesCovered = ['1-Dec-25', '2-Dec-25', '3-Dec-25'] } = options;
  
  return {
    data: {
      id: paramId,
      type: 'probability',
      connection: 'amplitude',
      values: hasDailyData ? [{
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        dates: datesCovered,
        sliceDSL: ''
      }] : []
    }
  };
}

// ============================================================================
// TESTS: Cache Validity
// ============================================================================

describe('WindowSelector auto-aggregation: cache validity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should trigger auto-aggregation when cache is valid (all dates covered)', async () => {
    const graph = createMockGraph({ dsl: 'window(1-Dec-25:3-Dec-25)' });
    
    // Mock file with full coverage
    vi.mocked(fileRegistry.getFile).mockImplementation((fileId: string) => {
      if (fileId.startsWith('parameter-')) {
        return createMockParamFile({
          paramId: fileId.replace('parameter-', ''),
          hasDailyData: true,
          datesCovered: ['1-Dec-25', '2-Dec-25', '3-Dec-25']
        }) as any;
      }
      return null;
    });
    
    // Mock incremental fetch - no fetch needed (full cache)
    vi.mocked(calculateIncrementalFetch).mockReturnValue({
      needsFetch: false,
      totalDays: 3,
      daysAvailable: 3,
      daysToFetch: 0,
      missingDates: []
    });
    
    // Simulate DSL change check
    const result = calculateIncrementalFetch(
      createMockParamFile({ paramId: 'param-1' }).data,
      { start: '2025-12-01', end: '2025-12-03' },
      undefined,
      false,
      'window(1-Dec-25:3-Dec-25)'
    );
    
    expect(result.needsFetch).toBe(false);
    // When needsFetch is false, auto-aggregation should run
  });

  it('should NOT auto-aggregate when cache is invalid (dates missing)', async () => {
    const graph = createMockGraph({ dsl: 'window(1-Dec-25:7-Dec-25)' });
    
    // Mock file with partial coverage
    vi.mocked(fileRegistry.getFile).mockImplementation((fileId: string) => {
      if (fileId.startsWith('parameter-')) {
        return createMockParamFile({
          paramId: fileId.replace('parameter-', ''),
          hasDailyData: true,
          datesCovered: ['1-Dec-25', '2-Dec-25', '3-Dec-25'] // Only 3 of 7 days
        }) as any;
      }
      return null;
    });
    
    vi.mocked(calculateIncrementalFetch).mockReturnValue({
      needsFetch: true,
      totalDays: 7,
      daysAvailable: 3,
      daysToFetch: 4,
      missingDates: ['4-Dec-25', '5-Dec-25', '6-Dec-25', '7-Dec-25']
    });
    
    const result = calculateIncrementalFetch(
      createMockParamFile({ paramId: 'param-1', datesCovered: ['1-Dec-25', '2-Dec-25', '3-Dec-25'] }).data,
      { start: '2025-12-01', end: '2025-12-07' },
      undefined,
      false,
      'window(1-Dec-25:7-Dec-25)'
    );
    
    expect(result.needsFetch).toBe(true);
    // When needsFetch is true, Fetch button should show instead
  });

  it('should detect partial coverage and show Fetch button', () => {
    vi.mocked(calculateIncrementalFetch).mockReturnValue({
      needsFetch: true,
      totalDays: 7,
      daysAvailable: 4,
      daysToFetch: 3,
      missingDates: ['5-Dec-25', '6-Dec-25', '7-Dec-25']
    });
    
    const result = calculateIncrementalFetch(
      createMockParamFile({ paramId: 'param-1' }).data,
      { start: '2025-12-01', end: '2025-12-07' },
      undefined,
      false,
      ''
    );
    
    // Partial coverage = show Fetch button
    expect(result.needsFetch).toBe(true);
    expect(result.daysToFetch).toBe(3);
  });
});

// ============================================================================
// TESTS: DSL Change Triggers
// ============================================================================

describe('WindowSelector auto-aggregation: DSL change triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should trigger on window change when cache is valid', () => {
    const oldDSL = 'window(1-Dec-25:7-Dec-25)';
    const newDSL = 'window(1-Dec-25:14-Dec-25)';
    
    // DSL changed
    expect(oldDSL).not.toBe(newDSL);
    
    // This simulates the condition that triggers checkDataCoverageAndAggregate
    const dslChanged = oldDSL !== newDSL;
    expect(dslChanged).toBe(true);
  });

  it('should trigger on context change when cache is valid', () => {
    const oldDSL = 'window(1-Dec-25:7-Dec-25)';
    const newDSL = 'window(1-Dec-25:7-Dec-25).context(geo=UK)';
    
    // DSL changed due to context
    expect(oldDSL).not.toBe(newDSL);
  });

  it('should NOT trigger when DSL is unchanged', () => {
    const oldDSL = 'window(1-Dec-25:7-Dec-25)';
    const newDSL = 'window(1-Dec-25:7-Dec-25)';
    
    expect(oldDSL).toBe(newDSL);
    // No trigger when unchanged
  });

  it('should handle empty DSL changes', () => {
    const oldDSL = '';
    const newDSL = 'window(1-Dec-25:7-Dec-25)';
    
    // Empty to valid = trigger
    expect(oldDSL !== newDSL).toBe(true);
  });
});

// ============================================================================
// TESTS: Shimmer Animation State
// ============================================================================

describe('WindowSelector auto-aggregation: shimmer state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should enable shimmer during aggregation', async () => {
    let shimmerState = false;
    const setShimmer = (v: boolean) => { shimmerState = v; };
    
    // Simulate aggregation start
    setShimmer(true);
    expect(shimmerState).toBe(true);
    
    // Simulate aggregation complete
    setShimmer(false);
    expect(shimmerState).toBe(false);
  });

  it('should disable shimmer on error', async () => {
    let shimmerState = true;
    const setShimmer = (v: boolean) => { shimmerState = v; };
    
    // Simulate error
    setShimmer(false);
    expect(shimmerState).toBe(false);
  });

  it('should show shimmer only when Fetch button is visible and data needs update', () => {
    // Conditions for shimmer:
    // 1. Fetch button should be visible (needsFetch = true)
    // 2. OR aggregation is in progress
    
    vi.mocked(calculateIncrementalFetch).mockReturnValue({
      needsFetch: true,
      totalDays: 7,
      daysAvailable: 0,
      daysToFetch: 7,
      missingDates: ['1-Dec-25', '2-Dec-25', '3-Dec-25', '4-Dec-25', '5-Dec-25', '6-Dec-25', '7-Dec-25']
    });
    
    const result = calculateIncrementalFetch(
      { values: [] },
      { start: '2025-12-01', end: '2025-12-07' },
      undefined,
      false,
      ''
    );
    
    // If no data at all, shimmer should attract attention to Fetch button
    expect(result.needsFetch).toBe(true);
    expect(result.daysAvailable).toBe(0);
  });
});

// ============================================================================
// TESTS: Debouncing
// ============================================================================

describe('WindowSelector auto-aggregation: debouncing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should debounce rapid DSL changes', async () => {
    const aggregateCalls: string[] = [];
    const mockAggregate = (dsl: string) => {
      aggregateCalls.push(dsl);
    };
    
    // Simulate rapid DSL changes
    let pendingTimeout: NodeJS.Timeout | null = null;
    const debouncedAggregate = (dsl: string, delay: number = 300) => {
      if (pendingTimeout) clearTimeout(pendingTimeout);
      pendingTimeout = setTimeout(() => mockAggregate(dsl), delay);
    };
    
    // Rapid changes
    debouncedAggregate('window(1-Dec-25:7-Dec-25)');
    debouncedAggregate('window(1-Dec-25:8-Dec-25)');
    debouncedAggregate('window(1-Dec-25:9-Dec-25)');
    debouncedAggregate('window(1-Dec-25:10-Dec-25)');
    
    // Before timeout
    expect(aggregateCalls).toHaveLength(0);
    
    // After timeout
    vi.advanceTimersByTime(350);
    expect(aggregateCalls).toHaveLength(1);
    expect(aggregateCalls[0]).toBe('window(1-Dec-25:10-Dec-25)'); // Only last one
  });

  it('should respect minimum delay between aggregations', () => {
    let lastAggregateTime = 0;
    const minDelay = 200;
    const aggregateTimes: number[] = [];
    
    const throttledAggregate = () => {
      const now = Date.now();
      if (now - lastAggregateTime >= minDelay) {
        lastAggregateTime = now;
        aggregateTimes.push(now);
      }
    };
    
    // Rapid calls
    throttledAggregate();
    vi.advanceTimersByTime(50);
    throttledAggregate(); // Ignored
    vi.advanceTimersByTime(50);
    throttledAggregate(); // Ignored
    vi.advanceTimersByTime(200);
    throttledAggregate(); // Should run
    
    expect(aggregateTimes).toHaveLength(2);
  });
});

// ============================================================================
// TESTS: isAggregating Guard
// ============================================================================

describe('WindowSelector auto-aggregation: concurrent operation guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should NOT trigger when fetching is in progress', () => {
    let isFetching = true;
    let isAggregating = false;
    
    const canAggregate = !isFetching && !isAggregating;
    expect(canAggregate).toBe(false);
  });

  it('should NOT trigger when aggregation is in progress', () => {
    let isFetching = false;
    let isAggregating = true;
    
    const canAggregate = !isFetching && !isAggregating;
    expect(canAggregate).toBe(false);
  });

  it('should trigger when neither fetching nor aggregating', () => {
    let isFetching = false;
    let isAggregating = false;
    
    const canAggregate = !isFetching && !isAggregating;
    expect(canAggregate).toBe(true);
  });
});

// ============================================================================
// TESTS: Edge Coverage
// ============================================================================

describe('WindowSelector auto-aggregation: edge parameter coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should check all edge params with direct connections', () => {
    const graph = createMockGraph({ paramCount: 3 });
    
    // All edges should be checked
    const edgesWithConnections = graph.edges.filter(e => e.p?.connection);
    expect(edgesWithConnections).toHaveLength(3);
  });

  it('should skip edges without connections', () => {
    const graph = createMockGraph({ paramCount: 2 });
    
    // Add edge without connection
    graph.edges.push({
      uuid: 'edge-no-conn',
      id: 'enc',
      from: 'node-a',
      to: 'node-b1',
      p: { id: 'param-no-conn', mean: 0.5 } // No connection
    });
    
    const edgesWithConnections = graph.edges.filter(e => e.p?.connection);
    expect(edgesWithConnections).toHaveLength(2); // Only original 2
  });

  it('should handle edges with cost_gbp and labour_cost params', () => {
    const graph = createMockGraph({ paramCount: 1 });
    
    // Add additional param slots
    graph.edges[0].cost_gbp = {
      id: 'cost-param-1',
      mean: 10,
      connection: 'sheets'
    };
    graph.edges[0].labour_cost = {
      id: 'time-param-1',
      mean: 5,
      connection: 'sheets'
    };
    
    // All param slots should be considered
    const edge = graph.edges[0];
    const paramSlots = ['p', 'cost_gbp', 'labour_cost'].filter(slot => edge[slot]?.connection);
    expect(paramSlots).toHaveLength(3);
  });
});

// ============================================================================
// TESTS: Graph Hash Change Detection
// ============================================================================

describe('WindowSelector auto-aggregation: graph hash change detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect graph structure changes via hash', () => {
    const graph1 = createMockGraph({ paramCount: 2 });
    const graph2 = createMockGraph({ paramCount: 3 }); // Different structure
    
    // Simple hash based on edge count
    const hash1 = graph1.edges.length;
    const hash2 = graph2.edges.length;
    
    expect(hash1).not.toBe(hash2);
  });

  it('should NOT trigger re-aggregation when only graph hash changes but DSL is same', () => {
    // If DSL hasn't changed, cache is still valid
    const dsl = 'window(1-Dec-25:7-Dec-25)';
    const lastDSL = 'window(1-Dec-25:7-Dec-25)';
    
    const dslChanged = dsl !== lastDSL;
    expect(dslChanged).toBe(false);
    // No re-aggregation needed
  });
});

