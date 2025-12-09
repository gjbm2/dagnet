/**
 * Window Fetch Planner Service Unit Tests
 * 
 * Tests the planner's analysis logic for coverage and staleness classification.
 * 
 * Key test areas:
 * 1. Single path verification (delegates to fetchDataService)
 * 2. Coverage classification
 * 3. Staleness classification (parameter and case)
 * 4. DSL extraction
 * 5. Outcome derivation
 * 6. Message generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { windowFetchPlannerService, type PlannerResult, type FetchOutcome } from '../windowFetchPlannerService';
import * as fetchDataService from '../fetchDataService';
import { fileRegistry } from '../../contexts/TabContext';
import { sessionLogService } from '../sessionLogService';
import type { Graph } from '../../types';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(),
  },
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn().mockReturnValue('mock-log-id'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
  },
}));

// =============================================================================
// Test Fixtures
// =============================================================================

const TODAY = new Date('2025-12-09T12:00:00Z');

function daysAgo(n: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() - n);
  const day = date.getDate();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear() % 100;
  return `${day}-${month}-${year}`;
}

function createMockGraph(options: {
  edges?: Array<{
    id: string;
    paramId?: string;
    hasConnection?: boolean;
    latencyConfig?: { maturity_days?: number; t95?: number; path_t95?: number };
  }>;
  nodes?: Array<{
    id: string;
    caseId?: string;
    hasConnection?: boolean;
  }>;
}): Graph {
  return {
    edges: (options.edges || []).map(e => ({
      id: e.id,
      uuid: e.id,
      from: 'node1',
      to: 'node2',
      p: e.paramId ? {
        id: e.paramId,
        connection: e.hasConnection ? { type: 'sheets' as const } : undefined,
        latency: e.latencyConfig,
      } : undefined,
    })),
    nodes: (options.nodes || []).map(n => ({
      id: n.id,
      uuid: n.id,
      label: n.id,
      case: n.caseId ? {
        id: n.caseId,
        connection: n.hasConnection ? { type: 'statsig' as const } : undefined,
      } : undefined,
    })),
  } as Graph;
}

function createMockParamFile(options: {
  hasConnection?: boolean;
  values?: Array<{
    sliceDSL?: string;
    window_from?: string;
    window_to?: string;
    cohort_from?: string;
    cohort_to?: string;
    data_source?: {
      retrieved_at?: string;
    };
  }>;
}) {
  return {
    data: {
      connection: options.hasConnection ? { type: 'sheets' } : undefined,
      values: options.values || [],
    },
  };
}

function createMockCaseFile(options: {
  hasConnection?: boolean;
  schedules?: Array<{
    retrieved_at?: string;
  }>;
}) {
  return {
    data: {
      connection: options.hasConnection ? { type: 'statsig' } : undefined,
      case: {
        schedules: options.schedules || [],
      },
    },
  };
}

// =============================================================================
// Test Setup
// =============================================================================

describe('WindowFetchPlannerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    windowFetchPlannerService.invalidateCache();
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });
  
  // ===========================================================================
  // 1. Single Path Verification
  // ===========================================================================
  
  describe('Single Path Verification', () => {
    it('uses getItemsNeedingFetch for coverage classification', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: true }],
      });
      
      // Mock file registry to return file with data
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: true,
        values: [{ sliceDSL: '', data_source: { retrieved_at: new Date().toISOString() } }],
      }));
      
      // Mock getItemsNeedingFetch to return empty (all covered)
      getItemsNeedingFetchSpy.mockReturnValue([]);
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      // Should have been called twice: once with checkCache=true, once with checkCache=false
      expect(getItemsNeedingFetchSpy).toHaveBeenCalledTimes(2);
      expect(getItemsNeedingFetchSpy).toHaveBeenCalledWith(
        expect.any(Object), // window
        graph,
        dsl,
        true // checkCache
      );
      expect(getItemsNeedingFetchSpy).toHaveBeenCalledWith(
        expect.any(Object), // window
        graph,
        dsl,
        false // checkCache
      );
    });
  });
  
  // ===========================================================================
  // 2. Coverage Classification
  // ===========================================================================
  
  describe('Coverage Classification', () => {
    it('classifies items returned by getItemsNeedingFetch as needs_fetch', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: true }],
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      // checkCache=true returns the item (needs fetch)
      // checkCache=false returns all connectable items
      getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
        return [mockFetchItem]; // Both calls return the item
      });
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: true,
        values: [],
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.fetchPlanItems).toHaveLength(1);
      expect(result.fetchPlanItems[0].classification).toBe('needs_fetch');
    });
    
    it('classifies file-only items without coverage as file_only_gap', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: false }], // No connection on edge
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      // checkCache=true returns nothing (can't fetch file-only)
      // checkCache=false returns all connectable items
      getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
        return checkCache ? [] : [mockFetchItem];
      });
      
      // File exists but has no connection and no values
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: false,
        values: [], // No values = gap
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.unfetchableGaps).toHaveLength(1);
      expect(result.unfetchableGaps[0].classification).toBe('file_only_gap');
    });
    
    it('classifies file-only items with coverage as covered_stable', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: false }],
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
        return checkCache ? [] : [mockFetchItem];
      });
      
      // File exists with data but no connection
      // NOTE: Must include window_from/window_to for hasFullSliceCoverageByHeader to detect coverage
      // NOTE: sliceDSL must include 'window(' to pass the typeFiltered check when query is window()
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: false,
        values: [{ sliceDSL: `window(${daysAgo(10)}:${daysAgo(0)})`, window_from: daysAgo(10), window_to: daysAgo(0) }],
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      const coveredItems = result.autoAggregationItems.filter(i => i.classification === 'covered_stable');
      expect(coveredItems).toHaveLength(1);
    });
  });
  
  // ===========================================================================
  // 3. Staleness Classification
  // ===========================================================================
  
  describe('Staleness Classification', () => {
    describe('Parameter Staleness', () => {
      it('classifies covered item retrieved >1 day ago within t95 as stale_candidate', async () => {
        const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
        
        const graph = createMockGraph({
          edges: [{
            id: 'edge1',
            paramId: 'param1',
            hasConnection: true,
            latencyConfig: { maturity_days: 14, t95: 10 },
          }],
        });
        
        const mockFetchItem: fetchDataService.FetchItem = {
          id: 'param-param1-p-edge1',
          type: 'parameter',
          name: 'p: param1',
          objectId: 'param1',
          targetId: 'edge1',
          paramSlot: 'p',
        };
        
        // Item is covered (not returned by checkCache=true)
        getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
          return checkCache ? [] : [mockFetchItem];
        });
        
        // Retrieved 3 days ago, query end is today (within t95 of 10)
        const threeDaysAgo = new Date(TODAY);
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        
        vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
          hasConnection: true,
          values: [{
            sliceDSL: '',
            data_source: { retrieved_at: threeDaysAgo.toISOString() },
          }],
        }));
        
        const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`; // Query ends today
        const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
        
        expect(result.staleCandidates).toHaveLength(1);
        expect(result.staleCandidates[0].classification).toBe('stale_candidate');
        // Staleness can be detected via shouldRefetch (partial/immature dates) or retrieval timestamp test
        expect(result.staleCandidates[0].stalenessReason).toBeDefined();
      });
      
      it('classifies covered item beyond t95 as covered_stable', async () => {
        const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
        
        const graph = createMockGraph({
          edges: [{
            id: 'edge1',
            paramId: 'param1',
            hasConnection: true,
            latencyConfig: { maturity_days: 7, t95: 5 },
          }],
        });
        
        const mockFetchItem: fetchDataService.FetchItem = {
          id: 'param-param1-p-edge1',
          type: 'parameter',
          name: 'p: param1',
          objectId: 'param1',
          targetId: 'edge1',
          paramSlot: 'p',
        };
        
        getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
          return checkCache ? [] : [mockFetchItem];
        });
        
        // Retrieved 10 days ago, query end is 10 days ago (beyond t95 of 5)
        const tenDaysAgo = new Date(TODAY);
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        
        vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
          hasConnection: true,
          values: [{
            sliceDSL: '',
            data_source: { retrieved_at: tenDaysAgo.toISOString() },
          }],
        }));
        
        // Query ends 10 days ago - well beyond t95 of 5
        const dsl = `window(${daysAgo(17)}:${daysAgo(10)})`;
        const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
        
        expect(result.staleCandidates).toHaveLength(0);
        const stableItems = result.autoAggregationItems.filter(i => i.classification === 'covered_stable');
        expect(stableItems).toHaveLength(1);
      });
    });
    
    describe('Case Staleness', () => {
      it('classifies case retrieved <1 day ago as covered_stable', async () => {
        const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
        
        const graph = createMockGraph({
          nodes: [{ id: 'node1', caseId: 'case1', hasConnection: true }],
        });
        
        const mockFetchItem: fetchDataService.FetchItem = {
          id: 'case-case1-node1',
          type: 'case',
          name: 'case: case1',
          objectId: 'case1',
          targetId: 'node1',
        };
        
        getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
          return checkCache ? [] : [mockFetchItem];
        });
        
        // Retrieved 6 hours ago
        const sixHoursAgo = new Date(TODAY);
        sixHoursAgo.setHours(sixHoursAgo.getHours() - 6);
        
        vi.mocked(fileRegistry.getFile).mockReturnValue(createMockCaseFile({
          hasConnection: true,
          schedules: [{ retrieved_at: sixHoursAgo.toISOString() }],
        }));
        
        const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
        const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
        
        expect(result.staleCandidates).toHaveLength(0);
        const stableItems = result.autoAggregationItems.filter(i => i.classification === 'covered_stable');
        expect(stableItems).toHaveLength(1);
      });
      
      it('classifies case retrieved >1 day ago as stale_candidate', async () => {
        const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
        
        const graph = createMockGraph({
          nodes: [{ id: 'node1', caseId: 'case1', hasConnection: true }],
        });
        
        const mockFetchItem: fetchDataService.FetchItem = {
          id: 'case-case1-node1',
          type: 'case',
          name: 'case: case1',
          objectId: 'case1',
          targetId: 'node1',
        };
        
        getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
          return checkCache ? [] : [mockFetchItem];
        });
        
        // Retrieved 2 days ago
        const twoDaysAgo = new Date(TODAY);
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        
        vi.mocked(fileRegistry.getFile).mockReturnValue(createMockCaseFile({
          hasConnection: true,
          schedules: [{ retrieved_at: twoDaysAgo.toISOString() }],
        }));
        
        const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
        const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
        
        expect(result.staleCandidates).toHaveLength(1);
        expect(result.staleCandidates[0].classification).toBe('stale_candidate');
        expect(result.staleCandidates[0].stalenessReason).toContain('2d ago');
      });
      
      it('classifies case with no retrieved_at as stale_candidate', async () => {
        const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
        
        const graph = createMockGraph({
          nodes: [{ id: 'node1', caseId: 'case1', hasConnection: true }],
        });
        
        const mockFetchItem: fetchDataService.FetchItem = {
          id: 'case-case1-node1',
          type: 'case',
          name: 'case: case1',
          objectId: 'case1',
          targetId: 'node1',
        };
        
        getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
          return checkCache ? [] : [mockFetchItem];
        });
        
        vi.mocked(fileRegistry.getFile).mockReturnValue(createMockCaseFile({
          hasConnection: true,
          schedules: [{}], // No retrieved_at
        }));
        
        const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
        const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
        
        expect(result.staleCandidates).toHaveLength(1);
        expect(result.staleCandidates[0].stalenessReason).toContain('No retrieval timestamp');
      });
    });
  });
  
  // ===========================================================================
  // 4. DSL Extraction
  // ===========================================================================
  
  describe('DSL Extraction', () => {
    it('extracts window from window() DSL', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      getItemsNeedingFetchSpy.mockReturnValue([]);
      
      const graph = createMockGraph({ edges: [] });
      const dsl = 'window(1-Dec-25:7-Dec-25)';
      
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.status).toBe('complete');
      // If window was extracted, analysis should proceed
      expect(result.analysisContext.dsl).toBe(dsl);
    });
    
    it('extracts window from cohort() DSL', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      getItemsNeedingFetchSpy.mockReturnValue([]);
      
      const graph = createMockGraph({ edges: [] });
      const dsl = 'cohort(1-Dec-25:7-Dec-25)';
      
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.status).toBe('complete');
      expect(result.analysisContext.dsl).toBe(dsl);
    });
    
    it('returns empty result for DSL without temporal clause', async () => {
      const graph = createMockGraph({ edges: [] });
      const dsl = 'context(channel:google)'; // No window or cohort
      
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.status).toBe('complete');
      expect(result.outcome).toBe('covered_stable');
      expect(result.summaries.buttonTooltip).toBe('No window in DSL');
    });
  });
  
  // ===========================================================================
  // 5. Outcome Derivation
  // ===========================================================================
  
  describe('Outcome Derivation', () => {
    it('returns covered_stable when all items are covered', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: true }],
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      // All covered (checkCache=true returns nothing)
      getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
        return checkCache ? [] : [mockFetchItem];
      });
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: true,
        values: [{ sliceDSL: '', data_source: { retrieved_at: new Date().toISOString() } }],
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.outcome).toBe('covered_stable');
    });
    
    it('returns not_covered when any item needs fetch', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: true }],
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      // Needs fetch (checkCache=true returns item)
      getItemsNeedingFetchSpy.mockReturnValue([mockFetchItem]);
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: true,
        values: [],
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.outcome).toBe('not_covered');
    });
    
    it('returns covered_stale when no needs_fetch but some stale', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{
          id: 'edge1',
          paramId: 'param1',
          hasConnection: true,
          latencyConfig: { maturity_days: 14, t95: 10 },
        }],
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      // Covered but will be stale
      getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
        return checkCache ? [] : [mockFetchItem];
      });
      
      // Retrieved 3 days ago (>1 day), query end today (within t95 of 10)
      const threeDaysAgo = new Date(TODAY);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: true,
        values: [{
          sliceDSL: '',
          data_source: { retrieved_at: threeDaysAgo.toISOString() },
        }],
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.outcome).toBe('covered_stale');
    });
    
    it('excludes file_only_gap from outcome (returns covered_stable)', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: false }],
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      // File-only item returned by checkCache=false, nothing by checkCache=true
      getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
        return checkCache ? [] : [mockFetchItem];
      });
      
      // File exists with no connection and no values (gap)
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: false,
        values: [],
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      // Despite having a gap, outcome is stable because it's file-only
      expect(result.outcome).toBe('covered_stable');
      expect(result.unfetchableGaps).toHaveLength(1);
    });
  });
  
  // ===========================================================================
  // 6. Message Generation
  // ===========================================================================
  
  describe('Message Generation', () => {
    it('generates correct tooltip for covered_stable', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      getItemsNeedingFetchSpy.mockReturnValue([]);
      
      const graph = createMockGraph({ edges: [] });
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.summaries.buttonTooltip).toBe('All data is up to date for this query.');
    });
    
    it('generates tooltip with missing dates for not_covered', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: true }],
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      getItemsNeedingFetchSpy.mockReturnValue([mockFetchItem]);
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: true,
        values: [],
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.summaries.buttonTooltip).toContain('missing date');
      expect(result.summaries.buttonTooltip).toContain('item');
    });
    
    it('generates toast for unfetchable gaps', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{ id: 'edge1', paramId: 'param1', hasConnection: false }],
      });
      
      const mockFetchItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
        return checkCache ? [] : [mockFetchItem];
      });
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(createMockParamFile({
        hasConnection: false,
        values: [],
      }));
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.summaries.showToast).toBe(true);
      expect(result.summaries.toastMessage).toContain('file-only');
    });
    
    it('distinguishes stale params from stale cases in tooltip', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      
      const graph = createMockGraph({
        edges: [{
          id: 'edge1',
          paramId: 'param1',
          hasConnection: true,
          latencyConfig: { maturity_days: 14, t95: 10 },
        }],
        nodes: [{ id: 'node1', caseId: 'case1', hasConnection: true }],
      });
      
      const mockParamItem: fetchDataService.FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
      };
      
      const mockCaseItem: fetchDataService.FetchItem = {
        id: 'case-case1-node1',
        type: 'case',
        name: 'case: case1',
        objectId: 'case1',
        targetId: 'node1',
      };
      
      getItemsNeedingFetchSpy.mockImplementation((_w, _g, _d, checkCache) => {
        return checkCache ? [] : [mockParamItem, mockCaseItem];
      });
      
      // Both stale
      const threeDaysAgo = new Date(TODAY);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      
      vi.mocked(fileRegistry.getFile).mockImplementation((id: string) => {
        if (id.startsWith('parameter-')) {
          return createMockParamFile({
            hasConnection: true,
            values: [{
              sliceDSL: '',
              data_source: { retrieved_at: threeDaysAgo.toISOString() },
            }],
          });
        }
        if (id.startsWith('case-')) {
          return createMockCaseFile({
            hasConnection: true,
            schedules: [{ retrieved_at: threeDaysAgo.toISOString() }],
          });
        }
        return null;
      });
      
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      const result = await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      
      expect(result.outcome).toBe('covered_stale');
      expect(result.summaries.buttonTooltip).toContain('maturing cohorts');
      expect(result.summaries.buttonTooltip).toContain('day old');
    });
  });
  
  // ===========================================================================
  // 7. Cache Behaviour
  // ===========================================================================
  
  describe('Cache Behaviour', () => {
    it('returns cached result for same DSL and graph', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      getItemsNeedingFetchSpy.mockReturnValue([]);
      
      const graph = createMockGraph({ edges: [] });
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      
      await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      const callCount1 = getItemsNeedingFetchSpy.mock.calls.length;
      
      await windowFetchPlannerService.analyse(graph, dsl, 'dsl_change');
      const callCount2 = getItemsNeedingFetchSpy.mock.calls.length;
      
      // Second call should use cache, no new fetchDataService calls
      expect(callCount2).toBe(callCount1);
    });
    
    it('invalidates cache on invalidateCache call', async () => {
      const getItemsNeedingFetchSpy = vi.spyOn(fetchDataService, 'getItemsNeedingFetch');
      getItemsNeedingFetchSpy.mockReturnValue([]);
      
      const graph = createMockGraph({ edges: [] });
      const dsl = `window(${daysAgo(7)}:${daysAgo(0)})`;
      
      await windowFetchPlannerService.analyse(graph, dsl, 'initial_load');
      const callCount1 = getItemsNeedingFetchSpy.mock.calls.length;
      
      windowFetchPlannerService.invalidateCache();
      
      await windowFetchPlannerService.analyse(graph, dsl, 'dsl_change');
      const callCount2 = getItemsNeedingFetchSpy.mock.calls.length;
      
      // After invalidation, should make new calls
      expect(callCount2).toBeGreaterThan(callCount1);
    });
  });

  // (No explicit executeFetchPlan tests yet – Planner analysis and fetch plumbing
  // are covered via fetchDataService and cohort horizon integration tests.)
});

