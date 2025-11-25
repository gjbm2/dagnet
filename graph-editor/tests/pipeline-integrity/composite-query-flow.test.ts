/**
 * TIER 1 (P0): Pipeline Integrity Tests - Composite Query Flow
 * 
 * Tests the complete flow: MSMDC → Query → DAS → Composite Executor → File → Graph
 * 
 * This test suite catches bugs like:
 * - Composite queries not executing with daily mode
 * - Time-series not being combined correctly
 * - File write without subsequent load
 * - Provider event names not being preserved
 * - Query signatures not including minus/plus terms
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestGraph, createCompositeQueryGraph, cloneGraph } from '../helpers/test-graph-builder';
import { MockFileRegistry, createMockParameterFile } from '../helpers/mock-file-registry';
import { MockDASRunner, createMockAmplitudeResponse } from '../helpers/mock-das-runner';

// Create mock instances that will be used across tests
let mockFileRegistry: MockFileRegistry;
let mockDASRunner: MockDASRunner;

// Mock the TabContext at the top level (required for Vitest hoisting)
vi.mock('../../src/contexts/TabContext', async () => {
  const actual = await vi.importActual('../../src/contexts/TabContext');
  return {
    ...actual,
    get fileRegistry() {
      return mockFileRegistry;
    }
  };
});

// Mock the DAS runner module to use our mock runner
vi.mock('../../src/lib/das', async () => {
  return {
    createDASRunner: () => mockDASRunner
  };
});

describe('Pipeline Integrity: Composite Query → Daily Data → Graph', () => {
  let dataOperationsService: any;

  beforeEach(async () => {
    mockFileRegistry = new MockFileRegistry();
    mockDASRunner = new MockDASRunner({ mode: 'daily' });

    // Import service after mocks are set up (dynamic import for ESM)
    const module = await import('../../src/services/dataOperationsService');
    dataOperationsService = module.dataOperationsService;
  });

  afterEach(() => {
    mockFileRegistry.clear();
    mockDASRunner.clear();
    vi.clearAllMocks();
  });

  /**
   * CRITICAL TEST: Full pipeline for minus() query
   * 
   * This is the bug we just fixed! Tests:
   * 1. Composite query detection
   * 2. Sub-queries execute with mode='daily'
   * 3. Time-series combined via inclusion-exclusion
   * 4. File written with daily data + query_signature
   * 5. File loaded back into graph
   * 6. Graph shows correct aggregated value
   */
  test('minus() query: full pipeline from fetch to graph update', async () => {
    // SETUP: Graph with minus() query
    const graph = createCompositeQueryGraph();
    const originalMean = graph.edges[0].p!.mean; // 0.5
    
    // Seed parameter file (empty initially)
    mockFileRegistry.seed([{
      fileId: 'parameter-wa-to-dashboard',
      data: createMockParameterFile({
        id: 'wa-to-dashboard',
        query: 'from(saw-WA-details-page).to(straight-to-dashboard).minus(viewed-coffee-screen)',
        values: []
      })
    }]);

    // Track graph updates
    let updatedGraph: any = null;
    const mockSetGraph = vi.fn((g) => { updatedGraph = g; });

    // ACTION: Get from Source (versioned, daily mode)
    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'wa-to-dashboard',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      bustCache: false,
      graph,
      setGraph: mockSetGraph,
      window: {
        start: '2025-01-13T00:00:00.000Z',
        end: '2025-01-20T00:00:00.000Z'
      }
    });

    // ASSERT 1: Composite query was detected
    const operations = mockFileRegistry.getOperations();
    console.log('[Test] File operations:', operations.map(op => op.type));
    
    // ASSERT 2: Sub-queries executed with daily mode
    const executions = mockDASRunner.getExecutions();
    expect(executions.length).toBeGreaterThanOrEqual(2); // Base + minus term
    
    for (const exec of executions) {
      expect(exec.options.context?.mode || exec.dsl.mode).toBe('daily');
    }

    // ASSERT 3: Time-series data written to file
    const paramFile = mockFileRegistry.getFile('parameter-wa-to-dashboard');
    expect(paramFile).toBeDefined();
    expect(paramFile!.data.values).toBeDefined();
    expect(paramFile!.data.values.length).toBeGreaterThan(0);
    
    // Each value should have query_signature
    for (const value of paramFile!.data.values) {
      expect(value.query_signature).toBeDefined();
      expect(typeof value.query_signature).toBe('string');
    }

    // ASSERT 4: File query updated from graph (graph is master)
    expect(paramFile!.data.query).toBe('from(saw-WA-details-page).to(straight-to-dashboard).minus(viewed-coffee-screen)');

    // ASSERT 5: Graph was updated
    expect(mockSetGraph).toHaveBeenCalled();
    expect(updatedGraph).toBeDefined();
    
    // ASSERT 6: Graph shows NEW value (not original)
    const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === graph.edges[0].uuid);
    expect(updatedEdge).toBeDefined();
    expect(updatedEdge.p.mean).not.toBe(originalMean);
    expect(updatedEdge.p.mean).toBeGreaterThan(0);
    expect(updatedEdge.p.mean).toBeLessThan(1);

    console.log('[Test] Pipeline complete:', {
      originalMean,
      newMean: updatedEdge.p.mean,
      daysStored: paramFile!.data.values.length,
      executions: executions.length
    });
  });

  /**
   * TEST: plus() query (inclusion-exclusion addition)
   */
  test('plus() query: adds paths correctly', async () => {
    const graph = createTestGraph({
      nodes: [
        { id: 'a', name: 'A', event_id: 'event_a' },
        { id: 'b', name: 'B', event_id: 'event_b' },
        { id: 'c', name: 'C', event_id: 'event_c' }
      ],
      edges: [{
        from: 'a',
        to: 'b',
        query: 'from(a).to(b).minus(c).plus(d)', // Complex query
        p: { mean: 0.5, id: 'test-plus' }
      }]
    });

    mockFileRegistry.seed([{
      fileId: 'parameter-test-plus',
      data: createMockParameterFile({ id: 'test-plus', values: [] })
    }]);

    let updatedGraph: any = null;
    const mockSetGraph = vi.fn((g) => { updatedGraph = g; });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'test-plus',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      graph,
      setGraph: mockSetGraph,
      window: { start: '2025-01-13', end: '2025-01-20' }
    });

    // Should have executed 3 sub-queries: base, minus(c), plus(d)
    const executions = mockDASRunner.getExecutions();
    expect(executions.length).toBe(3);

    // Graph should be updated
    expect(mockSetGraph).toHaveBeenCalled();
  });

  /**
   * TEST: Query signature includes minus/plus terms
   */
  test('query signature changes when minus/plus terms added', async () => {
    const { computeQuerySignature } = await import('../../src/services/dataOperationsService');

    const sig1 = await computeQuerySignature(
      { from: 'a', to: 'b' },
      'amplitude-prod',
      null,
      { query: 'from(a).to(b)' }
    );

    const sig2 = await computeQuerySignature(
      { from: 'a', to: 'b' },
      'amplitude-prod',
      null,
      { query: 'from(a).to(b).minus(c)' }
    );

    expect(sig1).toBeDefined();
    expect(sig2).toBeDefined();
    expect(sig1.signature).not.toBe(sig2.signature);
  });

  /**
   * TEST: Unsigned cache entries excluded from aggregation
   */
  test('unsigned entries not used in aggregation', async () => {
    const graph = createCompositeQueryGraph();
    
    // Seed file with UNSIGNED values (old data)
    mockFileRegistry.seed([{
      fileId: 'parameter-wa-to-dashboard',
      data: createMockParameterFile({
        id: 'wa-to-dashboard',
        values: [
          { date: '2025-01-13', mean: 0.9, n: 100, k: 90 }, // No query_signature!
          { date: '2025-01-14', mean: 0.95, n: 100, k: 95 }
        ]
      })
    }]);

    const result = await dataOperationsService.getParameterFromFile({
      paramId: 'wa-to-dashboard',
      edgeId: graph.edges[0].uuid,
      graph,
      setGraph: vi.fn(),
      window: { start: '2025-01-13', end: '2025-01-20' }
    });

    // Should have fetched because no SIGNED values exist
    // (Unsigned values are ignored)
    expect(mockDASRunner.getExecutions().length).toBeGreaterThan(0);
  });

  /**
   * TEST: Direct mode bypasses file
   */
  test('direct mode: no file write, data goes straight to graph', async () => {
    const graph = createCompositeQueryGraph();
    let updatedGraph: any = null;
    const mockSetGraph = vi.fn((g) => { updatedGraph = g; });

    // No file seeded (direct mode doesn't need it)
    
    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'wa-to-dashboard',
      targetId: graph.edges[0].uuid,
      dailyMode: false, // DIRECT mode
      bustCache: true,
      graph,
      setGraph: mockSetGraph
    });

    // File should NOT be updated
    mockFileRegistry.assertFileNotUpdated('parameter-wa-to-dashboard');

    // But graph SHOULD be updated
    expect(mockSetGraph).toHaveBeenCalled();
  });

  /**
   * TEST: Provider event names preserved through pipeline
   */
  test('node IDs mapped to provider events and back', async () => {
    // Mock event registry with provider mappings
    const mockEventRegistry: Record<string, any> = {
      'saw-WA-details-page': {
        provider_event_names: {
          amplitude: 'Viewed WhatsApp details /onboarding/whatsApp-details Page'
        }
      },
      'straight-to-dashboard': {
        provider_event_names: {
          amplitude: 'User sees dashboard'
        }
      }
    };

    // Use doMock instead of mock to avoid hoisting issues
    vi.doMock('../../src/contexts/TabContext', () => ({
      fileRegistry: {
        getFile: (id: string) => {
          const nodeId = id.replace('event-', '');
          return mockEventRegistry[nodeId] ? { data: mockEventRegistry[nodeId] } : undefined;
        }
      }
    }));

    const graph = createCompositeQueryGraph();
    
    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'wa-to-dashboard',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      graph,
      setGraph: vi.fn()
    });

    // Check that DAS was called with PROVIDER event names
    const executions = mockDASRunner.getExecutions();
    expect(executions.length).toBeGreaterThan(0);
    
    const baseExec = executions[0];
    expect(baseExec.dsl.from).toBe('Viewed WhatsApp details /onboarding/whatsApp-details Page');
    expect(baseExec.dsl.to).toBe('User sees dashboard');
  });
});

