/**
 * FetchDataService Unit Tests
 * 
 * Tests the core fetch and cache-checking logic extracted from useFetchData hook.
 * This is CRITICAL test coverage as this service is the single code path for
 * all fetch operations (both hook-based and context-based).
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchDataService,
  itemNeedsFetch,
  getItemsNeedingFetch,
  checkDSLNeedsFetch,
  checkMultipleDSLsNeedFetch,
  normalizeWindow,
  getDefaultDSL,
  extractWindowFromDSL,
  createFetchItem,
  computeAndApplyInboundN,
  type FetchItem,
} from '../fetchDataService';
import type { Graph, DateRange } from '../../types';
import { dataOperationsService } from '../dataOperationsService';

// Mock dependencies
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(),
  },
}));

vi.mock('../windowAggregationService', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    calculateIncrementalFetch: vi.fn(),
    parseDate: vi.fn((dateStr: string) => new Date(dateStr)),
  };
});

vi.mock('../lib/whatIf', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // For inbound-n unit tests, use base p.mean as effective probability
    computeEffectiveEdgeProbability: vi.fn((graph: Graph, edgeId: string) => {
      const edge = graph.edges?.find(
        (e: any) => (e.uuid || e.id || `${e.from}->${e.to}`) === edgeId
      );
      return edge?.p?.mean ?? 0;
    }),
  };
});

vi.mock('../../lib/queryDSL', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseConstraints: vi.fn(),
  };
});

vi.mock('../../components/ProgressToast', () => ({
  showProgressToast: vi.fn(),
  completeProgressToast: vi.fn(),
}));

import { fileRegistry } from '../../contexts/TabContext';
import { calculateIncrementalFetch, parseDate } from '../windowAggregationService';
import { parseConstraints } from '../../lib/queryDSL';

// Helper to create mock graph
function createMockGraph(options: {
  edges?: Array<{
    uuid?: string;
    id?: string;
    p?: { id?: string; connection?: any };
    cost_gbp?: { id?: string; connection?: any };
    labour_cost?: { id?: string; connection?: any };
  }>;
  nodes?: Array<{
    uuid?: string;
    id?: string;
    case?: { id?: string; connection?: any };
  }>;
} = {}): Graph {
  return {
    nodes: options.nodes || [],
    edges: options.edges || [],
  } as Graph;
}

describe('FetchDataService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mock for parseDate to handle UK dates
    (parseDate as ReturnType<typeof vi.fn>).mockImplementation((dateStr: string) => {
      // Handle UK date format (d-MMM-yy)
      const ukMatch = dateStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
      if (ukMatch) {
        const day = parseInt(ukMatch[1], 10);
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = monthNames.indexOf(ukMatch[2]);
        const year = 2000 + parseInt(ukMatch[3], 10);
        return new Date(year, month, day);
      }
      // Fallback to ISO parse
      return new Date(dateStr);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // normalizeWindow tests
  // ==========================================================================

  describe('normalizeWindow', () => {
    it('should normalize UK dates to ISO format with time suffix', () => {
      const window: DateRange = { start: '1-Nov-25', end: '7-Nov-25' };
      const result = normalizeWindow(window);
      
      expect(result.start).toBe('2025-11-01T00:00:00Z');
      expect(result.end).toBe('2025-11-07T23:59:59Z');
    });

    it('should preserve ISO dates with existing time suffix', () => {
      const window: DateRange = { 
        start: '2025-11-01T00:00:00Z', 
        end: '2025-11-07T23:59:59Z' 
      };
      const result = normalizeWindow(window);
      
      expect(result.start).toBe('2025-11-01T00:00:00Z');
      expect(result.end).toBe('2025-11-07T23:59:59Z');
    });
  });

  // ==========================================================================
  // getDefaultDSL tests
  // ==========================================================================

  describe('getDefaultDSL', () => {
    it('should return a DSL with 7-day window ending yesterday', () => {
      const dsl = getDefaultDSL();
      
      expect(dsl).toMatch(/^window\(\d{1,2}-[A-Za-z]{3}-\d{2}:\d{1,2}-[A-Za-z]{3}-\d{2}\)$/);
    });
  });

  // ==========================================================================
  // extractWindowFromDSL tests
  // ==========================================================================

  describe('extractWindowFromDSL', () => {
    it('should extract window from DSL with window constraint', () => {
      (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
        window: { start: '1-Nov-25', end: '7-Nov-25' },
        visited: [],
        exclude: [],
        context: [],
        cases: [],
        visitedAny: [],
        contextAny: [],
      });

      const result = extractWindowFromDSL('window(1-Nov-25:7-Nov-25)');
      
      expect(result).toEqual({ start: '1-Nov-25', end: '7-Nov-25' });
    });

    it('should return null for DSL without window', () => {
      (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
        window: null,
        visited: [],
        exclude: [],
        context: [],
        cases: [],
        visitedAny: [],
        contextAny: [],
      });

      const result = extractWindowFromDSL('context(channel:google)');
      
      expect(result).toBeNull();
    });

    it('should return null for malformed DSL', () => {
      (parseConstraints as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Parse error');
      });

      const result = extractWindowFromDSL('malformed(');
      
      expect(result).toBeNull();
    });

    it('should return null if window has no start', () => {
      (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
        window: { start: undefined, end: undefined },
        visited: [],
        exclude: [],
        context: [],
        cases: [],
        visitedAny: [],
        contextAny: [],
      });

      const result = extractWindowFromDSL('window(:)');
      
      expect(result).toBeNull();
    });

    // ========================================================================
    // Open-ended window tests (e.g., window(-10d:) or window(:7-Nov-25))
    // ========================================================================
    
    describe('open-ended windows', () => {
      it('should handle window(-10d:) with empty end - defaults end to today', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-10d', end: undefined },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-10d:)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/); // UK date format
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/); // UK date format (today)
      });

      it('should handle window(-30d:) with empty end', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-30d', end: undefined },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-30d:)');
        
        expect(result).not.toBeNull();
        // Start should be resolved to an actual date (30 days ago)
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
        // End should default to today
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
      });

      it('should handle window(-7d:) with empty string end', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-7d', end: '' },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-7d:)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
      });

      it('should handle relative start with absolute end', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-14d', end: '7-Nov-25' },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-14d:7-Nov-25)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/); // Resolved relative date
        expect(result!.end).toBe('7-Nov-25'); // Absolute date preserved
      });

      it('should handle absolute start with relative end', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '1-Nov-25', end: '-1d' },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(1-Nov-25:-1d)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toBe('1-Nov-25');
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/); // Resolved to yesterday
      });

      it('should handle both relative dates', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-30d', end: '-1d' },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-30d:-1d)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
      });

      it('should handle week-based relative dates', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-2w', end: undefined },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-2w:)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
      });

      it('should handle month-based relative dates', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-3m', end: '-1m' },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-3m:-1m)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
      });

      it('should handle year-based relative dates', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-1y', end: undefined },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-1y:)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
      });

      it('should return null for window with no start (only end)', () => {
        // This is a degenerate case - window(:7-Nov-25) has no start
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: undefined, end: '7-Nov-25' },
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(:7-Nov-25)');
        
        // We require a start date - open-ended on the left is not supported
        expect(result).toBeNull();
      });

      it('should handle window with context in same DSL', () => {
        (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
          window: { start: '-7d', end: undefined },
          visited: [],
          exclude: [],
          context: [{ key: 'channel', value: 'google' }],
          cases: [],
          visitedAny: [],
          contextAny: [],
        });

        const result = extractWindowFromDSL('window(-7d:).context(channel:google)');
        
        expect(result).not.toBeNull();
        expect(result!.start).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
        expect(result!.end).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{2}$/);
      });
    });
  });

  // ==========================================================================
  // computeAndApplyInboundN tests
  // ==========================================================================

  describe('computeAndApplyInboundN', () => {
    it('should persist p.n and p.forecast.k on edges after inbound-n computation', () => {
      // Simple A(start) → X → Y graph
      const graph: Graph = {
        nodes: [
          { id: 'start', uuid: 'start-uuid', type: 'normal', entry: { is_start: true } } as any,
          { id: 'x', uuid: 'x-uuid', type: 'normal' } as any,
          { id: 'y', uuid: 'y-uuid', type: 'normal' } as any,
        ],
        edges: [
          {
            id: 'start-to-x',
            uuid: 'start-to-x',
            from: 'start',
            to: 'x',
            p: {
              mean: 0.5,
              evidence: { n: 1000, k: 500 },
              latency: { latency_parameter: true, t95: 30 },
            },
          },
          {
            id: 'x-to-y',
            uuid: 'x-to-y',
            from: 'x',
            to: 'y',
            p: {
              mean: 0.8,
              evidence: { n: 400, k: 320 },
              latency: { latency_parameter: true, t95: 30 },
            },
          },
        ],
        policies: {} as any,
        metadata: { version: '1.1.0', created_at: '1-Jan-25' },
      } as Graph;

      const setGraph = vi.fn();

      // Act
      computeAndApplyInboundN(graph, setGraph, null, 'TEST_LOG_ID');

      // Assert: setGraph called with updated graph
      expect(setGraph).toHaveBeenCalledTimes(1);
      const updatedGraph = (setGraph as ReturnType<typeof vi.fn>).mock.calls[0][0] as Graph;

      const edgeAX = updatedGraph.edges!.find(e => e.id === 'start-to-x') as any;
      const edgeXY = updatedGraph.edges!.find(e => e.id === 'x-to-y') as any;

      // A→X: p.n should equal evidence.n, forecast.k = n * mean
      expect(edgeAX.p.n).toBeCloseTo(1000);
      expect(edgeAX.p.forecast?.k).toBeCloseTo(1000 * 0.5);

      // X→Y: p.n should equal inbound forecast.k from A→X, forecast.k = n * mean
      expect(edgeXY.p.n).toBeCloseTo(1000 * 0.5);
      expect(edgeXY.p.forecast?.k).toBeCloseTo((1000 * 0.5) * 0.8);
    });
  });

  // ==========================================================================
  // Bounded cohort window plumbing tests
  // ==========================================================================

  describe('boundedCohortWindow plumbing', () => {
    it('passes boundedCohortWindow from FetchItem to dataOperationsService.getFromSource (versioned)', async () => {
      const graph: Graph = { nodes: [], edges: [] } as any;
      const setGraph = vi.fn();
      const boundedWindow: DateRange = { start: '1-Nov-25', end: '9-Dec-25' };

      const item: FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
        boundedCohortWindow: boundedWindow,
      };

      const getFromSourceSpy = vi
        .spyOn(dataOperationsService, 'getFromSource')
        .mockResolvedValue(Promise.resolve());

      await fetchDataService.fetchItem(
        item,
        { mode: 'versioned' },
        graph,
        setGraph,
        'cohort(1-Nov-25:9-Dec-25)'
      );

      expect(getFromSourceSpy).toHaveBeenCalledTimes(1);
      const args = getFromSourceSpy.mock.calls[0][0];
      expect(args.boundedCohortWindow).toEqual(boundedWindow);
    });

    it('passes boundedCohortWindow from FetchItem to dataOperationsService.getFromSourceDirect (direct)', async () => {
      const graph: Graph = { nodes: [], edges: [] } as any;
      const setGraph = vi.fn();
      const boundedWindow: DateRange = { start: '1-Nov-25', end: '9-Dec-25' };

      const item: FetchItem = {
        id: 'param-param1-p-edge1',
        type: 'parameter',
        name: 'p: param1',
        objectId: 'param1',
        targetId: 'edge1',
        paramSlot: 'p',
        boundedCohortWindow: boundedWindow,
      };

      const getFromSourceDirectSpy = vi
        .spyOn(dataOperationsService, 'getFromSourceDirect')
        .mockResolvedValue(Promise.resolve());

      await fetchDataService.fetchItem(
        item,
        { mode: 'direct' },
        graph,
        setGraph,
        'cohort(1-Nov-25:9-Dec-25)'
      );

      expect(getFromSourceDirectSpy).toHaveBeenCalledTimes(1);
      const args = getFromSourceDirectSpy.mock.calls[0][0];
      expect(args.boundedCohortWindow).toEqual(boundedWindow);
    });
  });

  // ==========================================================================
  // createFetchItem tests
  // ==========================================================================

  describe('createFetchItem', () => {
    it('should create parameter fetch item with default slot', () => {
      const item = createFetchItem('parameter', 'param-123', 'edge-456');
      
      expect(item).toEqual({
        id: 'parameter-param-123-p-edge-456',
        type: 'parameter',
        name: 'parameter: param-123',
        objectId: 'param-123',
        targetId: 'edge-456',
        paramSlot: undefined,
        conditionalIndex: undefined,
      });
    });

    it('should create parameter fetch item with specific slot', () => {
      const item = createFetchItem('parameter', 'param-123', 'edge-456', {
        paramSlot: 'cost_gbp',
        name: 'Cost param',
      });
      
      expect(item.id).toBe('parameter-param-123-cost_gbp-edge-456');
      expect(item.paramSlot).toBe('cost_gbp');
      expect(item.name).toBe('Cost param');
    });

    it('should create case fetch item', () => {
      const item = createFetchItem('case', 'case-123', 'node-456');
      
      expect(item.type).toBe('case');
      expect(item.objectId).toBe('case-123');
      expect(item.targetId).toBe('node-456');
    });

    it('should handle empty objectId (direct connection)', () => {
      const item = createFetchItem('parameter', '', 'edge-456');
      
      expect(item.id).toBe('parameter-direct-p-edge-456');
    });
  });

  // ==========================================================================
  // itemNeedsFetch - window coverage tests
  // ==========================================================================

  describe('itemNeedsFetch - window coverage', () => {
    const mockWindow: DateRange = { start: '2025-11-01', end: '2025-11-07' };
    const mockDSL = 'window(1-Nov-25:7-Nov-25)';

    it('should return needsFetch=false when param file slice header fully covers requested window', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: {
          connection: {},
          values: [
            {
              sliceDSL: 'window(1-Nov-25:7-Nov-25)',
              window_from: '1-Nov-25',
              window_to: '7-Nov-25',
            },
          ],
        },
      });

      const item: FetchItem = {
        id: 'param-1',
        type: 'parameter',
        name: 'param-1',
        objectId: 'param-1',
        targetId: 'edge-1',
        paramSlot: 'p',
      };

      const result = itemNeedsFetch(item, mockWindow, graph, mockDSL);
      
      expect(result).toBe(false);
    });

    it('should return needsFetch=true when requested window extends beyond slice header range', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: {
          connection: {},
          values: [
            {
              sliceDSL: 'window(1-Nov-25:3-Nov-25)',
              window_from: '1-Nov-25',
              window_to: '3-Nov-25',
            },
          ],
        },
      });

      const item: FetchItem = {
        id: 'param-1',
        type: 'parameter',
        name: 'param-1',
        objectId: 'param-1',
        targetId: 'edge-1',
        paramSlot: 'p',
      };

      const result = itemNeedsFetch(item, mockWindow, graph, mockDSL);
      
      expect(result).toBe(true);
    });

    it('should return needsFetch=false when param file does not exist (param files are optional; missing means skip)', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const item: FetchItem = {
        id: 'param-1',
        type: 'parameter',
        name: 'param-1',
        objectId: 'param-1',
        targetId: 'edge-1',
        paramSlot: 'p',
      };

      const result = itemNeedsFetch(item, mockWindow, graph, mockDSL);
      
      expect(result).toBe(false);
    });

    it('should return needsFetch=false for parameter without connection', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1' } }], // No connection
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: {}, // No connection in file either
      });

      const item: FetchItem = {
        id: 'param-1',
        type: 'parameter',
        name: 'param-1',
        objectId: 'param-1',
        targetId: 'edge-1',
        paramSlot: 'p',
      };

      const result = itemNeedsFetch(item, mockWindow, graph, mockDSL);
      
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // itemNeedsFetch - case coverage tests
  // ==========================================================================

  describe('itemNeedsFetch - case coverage', () => {
    const mockWindow: DateRange = { start: '2025-11-01', end: '2025-11-07' };
    const mockDSL = 'window(1-Nov-25:7-Nov-25)';

    it('should return needsFetch=true when case file does not exist', () => {
      const graph = createMockGraph({
        nodes: [{ uuid: 'node-1', case: { id: 'case-1', connection: {} } }],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const item: FetchItem = {
        id: 'case-1',
        type: 'case',
        name: 'case-1',
        objectId: 'case-1',
        targetId: 'node-1',
      };

      const result = itemNeedsFetch(item, mockWindow, graph, mockDSL);
      
      expect(result).toBe(true);
    });

    it('should return needsFetch=false when case file exists with data', () => {
      const graph = createMockGraph({
        nodes: [{ uuid: 'node-1', case: { id: 'case-1', connection: {} } }],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: { connection: {}, variants: [] },
      });

      const item: FetchItem = {
        id: 'case-1',
        type: 'case',
        name: 'case-1',
        objectId: 'case-1',
        targetId: 'node-1',
      };

      const result = itemNeedsFetch(item, mockWindow, graph, mockDSL);
      
      expect(result).toBe(false);
    });

    it('should return needsFetch=false for case without connection', () => {
      const graph = createMockGraph({
        nodes: [{ uuid: 'node-1', case: { id: 'case-1' } }], // No connection
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const item: FetchItem = {
        id: 'case-1',
        type: 'case',
        name: 'case-1',
        objectId: 'case-1',
        targetId: 'node-1',
      };

      const result = itemNeedsFetch(item, mockWindow, graph, mockDSL);
      
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // getItemsNeedingFetch tests
  // ==========================================================================

  describe('getItemsNeedingFetch', () => {
    const mockWindow: DateRange = { start: '2025-11-01', end: '2025-11-07' };
    const mockDSL = 'window(1-Nov-25:7-Nov-25)';

    it('should return empty array for graph with no edges or nodes', () => {
      const graph = createMockGraph();
      
      const result = getItemsNeedingFetch(mockWindow, graph, mockDSL);
      
      expect(result).toEqual([]);
    });

    it('should return items for edges with connected parameters that need fetch', () => {
      const graph = createMockGraph({
        edges: [
          { uuid: 'edge-1', p: { id: 'param-1', connection: {} } },
          { uuid: 'edge-2', p: { id: 'param-2', connection: {} } },
        ],
      });
      
      // First param needs fetch, second doesn't
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        if (id === 'parameter-param-1') return null; // No file = skip (out of scope)
        if (id === 'parameter-param-2') {
          // File exists but has no slices for this DSL -> not previously fetched
          return { data: { connection: {}, values: [] } };
        }
        return null;
      });

      const result = getItemsNeedingFetch(mockWindow, graph, mockDSL);
      
      expect(result.length).toBe(1);
      expect(result.map(r => r.objectId).sort()).toEqual(['param-2']);
    });

    it('should include all param slots (p, cost_gbp, labour_cost) that need fetch', () => {
      const graph = createMockGraph({
        edges: [{
          uuid: 'edge-1',
          p: { id: 'param-p', connection: {} },
          cost_gbp: { id: 'param-cost', connection: {} },
          labour_cost: { id: 'param-time', connection: {} },
        }],
      });
      
      // Param files are optional; missing files are skipped. To test slot inclusion, simulate file presence.
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        if (id === 'parameter-param-p') return { data: { connection: {}, values: [] } };
        if (id === 'parameter-param-cost') return { data: { connection: {}, values: [] } };
        if (id === 'parameter-param-time') return { data: { connection: {}, values: [] } };
        return null;
      });

      const result = getItemsNeedingFetch(mockWindow, graph, mockDSL);
      
      expect(result.length).toBe(3);
      expect(result.map(r => r.paramSlot).sort()).toEqual(['cost_gbp', 'labour_cost', 'p']);
    });

    it('should include case nodes that need fetch', () => {
      const graph = createMockGraph({
        nodes: [
          { uuid: 'node-1', case: { id: 'case-1', connection: {} } },
          { uuid: 'node-2' }, // No case
        ],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const result = getItemsNeedingFetch(mockWindow, graph, mockDSL);
      
      expect(result.length).toBe(1);
      expect(result[0].type).toBe('case');
      expect(result[0].objectId).toBe('case-1');
    });

    it('cohort mode: should override target slice to window() for simple edges (path_t95 = 0)', () => {
      // cohort-mode tab selecting cohorts by entry date
      const cohortDSL = 'cohort(1-Nov-25:7-Nov-25)';
      (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
        cohort: { start: '1-Nov-25', end: '7-Nov-25' },
        window: null,
        visited: [],
        exclude: [],
        context: [],
        cases: [],
        visitedAny: [],
        contextAny: [],
      });

      // Param files are optional; missing files are skipped. Simulate file presence for the parameters under test.
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        if (id === 'parameter-p-simple') return { data: { connection: {}, values: [] } };
        if (id === 'parameter-p-lag') return { data: { connection: {}, values: [] } };
        return null;
      });

      const graph: Graph = {
        nodes: [
          { id: 'A', type: 'start', entry: { is_start: true, entry_weight: 1 } } as any,
          { id: 'B' } as any,
          { id: 'C' } as any,
        ],
        edges: [
          // Latency edge branch (path_t95 > 0)
          {
            uuid: 'e-lag',
            id: 'e-lag',
            from: 'A',
            to: 'B',
            p: { id: 'p-lag', connection: {}, latency: { latency_parameter: true, t95: 5 } },
          } as any,
          // Simple edge branch (no local latency, not behind lagged path => path_t95 = 0)
          {
            uuid: 'e-simple',
            id: 'e-simple',
            from: 'A',
            to: 'C',
            p: { id: 'p-simple', connection: {} },
          } as any,
        ],
      };

      const items = getItemsNeedingFetch(mockWindow, graph, cohortDSL, false);

      const simple = items.find(i => i.objectId === 'p-simple');
      const lagged = items.find(i => i.objectId === 'p-lag');

      expect(simple).toBeDefined();
      expect(lagged).toBeDefined();

      expect(simple?.targetSliceOverride).toBe('window(1-Nov-25:7-Nov-25)');
      expect(lagged?.targetSliceOverride).toBeUndefined();
    });
  });

  // ==========================================================================
  // checkDSLNeedsFetch tests
  // ==========================================================================

  describe('checkDSLNeedsFetch', () => {
    beforeEach(() => {
      // Set up parseConstraints mock for window extraction
      (parseConstraints as ReturnType<typeof vi.fn>).mockImplementation((dsl: string) => {
        const windowMatch = dsl.match(/window\(([^:]*):([^)]*)\)/);
        return {
          window: windowMatch ? { start: windowMatch[1], end: windowMatch[2] } : null,
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        };
      });
    });

    it('should return needsFetch=false for graph with no connections', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1' } }], // No connection
      });

      const result = checkDSLNeedsFetch('window(1-Nov-25:7-Nov-25)', graph);
      
      expect(result.needsFetch).toBe(false);
      expect(result.items).toEqual([]);
    });

    it('should return needsFetch=true when items need fetching', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      // Param files are optional; missing files are skipped (out of scope).
      // To produce a real "needs fetch" result, the file must exist but not cover the requested window.
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: { connection: {}, values: [] }, // no slice headers => not previously fetched => needs fetch
      });

      const result = checkDSLNeedsFetch('window(1-Nov-25:7-Nov-25)', graph);
      
      expect(result.needsFetch).toBe(true);
      expect(result.items.length).toBe(1);
    });

    it('should return needsFetch=false for DSL without window (what-if only)', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });

      const result = checkDSLNeedsFetch('case(my-case:treatment)', graph);
      
      expect(result.needsFetch).toBe(false);
      expect(result.items).toEqual([]);
    });

    it('should return needsFetch=false for null graph', () => {
      const result = checkDSLNeedsFetch('window(1-Nov-25:7-Nov-25)', null as any);
      
      expect(result.needsFetch).toBe(false);
      expect(result.items).toEqual([]);
    });
  });

  // ==========================================================================
  // checkMultipleDSLsNeedFetch tests
  // ==========================================================================

  describe('checkMultipleDSLsNeedFetch', () => {
    beforeEach(() => {
      (parseConstraints as ReturnType<typeof vi.fn>).mockImplementation((dsl: string) => {
        const windowMatch = dsl.match(/window\(([^:]*):([^)]*)\)/);
        return {
          window: windowMatch ? { start: windowMatch[1], end: windowMatch[2] } : null,
          visited: [],
          exclude: [],
          context: [],
          cases: [],
          visitedAny: [],
          contextAny: [],
        };
      });
    });

    it('should return results in same order as input DSLs', () => {
      const graph = createMockGraph();
      const dsls = [
        'window(1-Nov-25:7-Nov-25)',
        'window(8-Nov-25:14-Nov-25)',
        'window(15-Nov-25:21-Nov-25)',
      ];

      const results = checkMultipleDSLsNeedFetch(dsls, graph);
      
      expect(results.length).toBe(3);
      expect(results[0].dsl).toBe(dsls[0]);
      expect(results[1].dsl).toBe(dsls[1]);
      expect(results[2].dsl).toBe(dsls[2]);
    });

    it('should correctly identify mix of cached/uncached DSLs', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      // Mock param file with a single slice covering only 1–7 Nov
      // - First DSL (1–7 Nov) is fully covered → no fetch needed
      // - Second DSL (8–14 Nov) is outside header range → needs fetch
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: {
          connection: {},
          values: [
            {
              sliceDSL: 'window(1-Nov-25:7-Nov-25)',
              window_from: '1-Nov-25',
              window_to: '7-Nov-25',
            },
          ],
        },
      });

      const results = checkMultipleDSLsNeedFetch([
        'window(1-Nov-25:7-Nov-25)',
        'window(8-Nov-25:14-Nov-25)',
      ], graph);
      
      expect(results[0].needsFetch).toBe(false);
      expect(results[1].needsFetch).toBe(true);
    });

    it('should return empty results for empty input array', () => {
      const graph = createMockGraph();

      const results = checkMultipleDSLsNeedFetch([], graph);
      
      expect(results).toEqual([]);
    });

    it('should handle all-cached scenario', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: {
          connection: {},
          values: [
            {
              sliceDSL: 'window(1-Nov-25:7-Nov-25)',
              window_from: '1-Nov-25',
              window_to: '7-Nov-25',
            },
            {
              sliceDSL: 'window(8-Nov-25:14-Nov-25)',
              window_from: '8-Nov-25',
              window_to: '14-Nov-25',
            },
          ],
        },
      });

      const results = checkMultipleDSLsNeedFetch([
        'window(1-Nov-25:7-Nov-25)',
        'window(8-Nov-25:14-Nov-25)',
      ], graph);
      
      expect(results.every(r => !r.needsFetch)).toBe(true);
    });

    it('should handle all-uncached scenario', () => {
      const graph = createMockGraph({
        edges: [{ uuid: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      // Param files are optional; missing files are skipped, so "all-uncached" must mean:
      // files exist but have no coverage for these windows.
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: { connection: {}, values: [] },
      });

      const results = checkMultipleDSLsNeedFetch([
        'window(1-Nov-25:7-Nov-25)',
        'window(8-Nov-25:14-Nov-25)',
      ], graph);
      
      expect(results.every(r => r.needsFetch)).toBe(true);
    });

    it('should include items needing fetch in each result', () => {
      const graph = createMockGraph({
        edges: [
          { uuid: 'edge-1', p: { id: 'param-1', connection: {} } },
          { uuid: 'edge-2', p: { id: 'param-2', connection: {} } },
        ],
      });
      
      // Files exist but have no slice coverage => both items need fetch.
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        if (id === 'parameter-param-1') return { data: { connection: {}, values: [] } };
        if (id === 'parameter-param-2') return { data: { connection: {}, values: [] } };
        return null;
      });

      const results = checkMultipleDSLsNeedFetch([
        'window(1-Nov-25:7-Nov-25)',
      ], graph);
      
      expect(results[0].items.length).toBe(2);
      expect(results[0].items.map(i => i.objectId).sort()).toEqual(['param-1', 'param-2']);
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle edge with id instead of uuid', () => {
      const graph = createMockGraph({
        edges: [{ id: 'edge-1', p: { id: 'param-1', connection: {} } }],
      });
      
      // File exists but has no slice headers for this DSL => needs fetch.
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue({
        data: { connection: {}, values: [] },
      });

      const item: FetchItem = {
        id: 'param-1',
        type: 'parameter',
        name: 'param-1',
        objectId: 'param-1',
        targetId: 'edge-1',
        paramSlot: 'p',
      };

      const result = itemNeedsFetch(item, { start: '2025-11-01', end: '2025-11-07' }, graph, '');
      
      expect(result).toBe(true);
    });

    it('should handle node with id instead of uuid', () => {
      const graph = createMockGraph({
        nodes: [{ id: 'node-1', case: { id: 'case-1', connection: {} } }],
      });
      
      (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const item: FetchItem = {
        id: 'case-1',
        type: 'case',
        name: 'case-1',
        objectId: 'case-1',
        targetId: 'node-1',
      };

      const result = itemNeedsFetch(item, { start: '2025-11-01', end: '2025-11-07' }, graph, '');
      
      expect(result).toBe(true);
    });

    it('should return false for unknown item type', () => {
      const graph = createMockGraph();
      
      const item: FetchItem = {
        id: 'unknown-1',
        type: 'node' as any, // Unsupported type
        name: 'unknown-1',
        objectId: 'unknown-1',
        targetId: 'unknown-1',
      };

      const result = itemNeedsFetch(item, { start: '2025-11-01', end: '2025-11-07' }, graph, '');
      
      expect(result).toBe(false);
    });

    it('should handle null graph gracefully', () => {
      const item: FetchItem = {
        id: 'param-1',
        type: 'parameter',
        name: 'param-1',
        objectId: 'param-1',
        targetId: 'edge-1',
        paramSlot: 'p',
      };

      const result = itemNeedsFetch(item, { start: '2025-11-01', end: '2025-11-07' }, null as any, '');
      
      expect(result).toBe(false);
    });
  });
});

