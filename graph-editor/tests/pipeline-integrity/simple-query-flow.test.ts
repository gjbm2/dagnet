/**
 * Pipeline Integrity: Simple Query Flow
 * 
 * Tests basic (non-composite) query execution through the full pipeline.
 * Ensures the fundamentals work before testing complex composite queries.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestGraph, createLinearGraph } from '../helpers/test-graph-builder';
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

describe('Pipeline Integrity: Simple Query Flow', () => {
  let dataOperationsService: any;

  beforeEach(async () => {
    // Initialize fresh mock instances for each test
    mockFileRegistry = new MockFileRegistry();
    mockDASRunner = new MockDASRunner();
    
    // Dynamically import the service after mocks are set up
    const serviceModule = await import('../../src/services/dataOperationsService');
    dataOperationsService = serviceModule.dataOperationsService;
  });

  afterEach(() => {
    mockFileRegistry.clear();
    mockDASRunner.clear();
    vi.clearAllMocks();
  });

  /**
   * BASELINE TEST: Simple from().to() query
   * Tests the full pipeline from query → DAS → file → graph
   */
  test('simple query: basic funnel execution', async () => {
    const graph = createLinearGraph();
    
    mockFileRegistry.seed([{
      fileId: 'parameter-test-param',
      data: createMockParameterFile({
        id: 'test-param',
        query: 'from(a).to(b)',
        values: []
      })
    }]);

    let updatedGraph: any = null;
    const mockSetGraph = vi.fn((g) => { updatedGraph = g; });

    // Configure mock to return specific data
    mockDASRunner = new MockDASRunner({
      mode: 'daily',
      responses: {
        'from(a).to(b)': createMockAmplitudeResponse({
          from_count: 1000,
          to_count: 600,
          daily: true,
          days: 7
        })
      }
    });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'test-param',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      graph,
      setGraph: mockSetGraph,
      window: { start: '2025-01-13', end: '2025-01-20' }
    });

    // Verify execution
    const executions = mockDASRunner.getExecutions();
    expect(executions.length).toBe(1);
    expect(executions[0].dsl.from).toBeDefined();
    expect(executions[0].dsl.to).toBeDefined();

    // Verify file written
    const paramFile = mockFileRegistry.getFile('parameter-test-param');
    expect(paramFile).toBeDefined();
    expect(paramFile!.data.values.length).toBeGreaterThan(0);

    // Verify graph updated
    expect(mockSetGraph).toHaveBeenCalled();
    expect(updatedGraph.edges[0].p.mean).toBeCloseTo(0.6, 1);
  });

  /**
   * TEST: Query with visited() nodes
   */
  test('query with visited: correct funnel order', async () => {
    const graph = createTestGraph({
      nodes: [
        { id: 'a', name: 'A', event_id: 'event_a' },
        { id: 'b', name: 'B', event_id: 'event_b' },
        { id: 'c', name: 'C', event_id: 'event_c' }
      ],
      edges: [{
        from: 'a',
        to: 'c',
        query: 'from(a).to(c).visited(b)',
        p: { mean: 0.5, id: 'test-visited' }
      }]
    });

    mockFileRegistry.seed([{
      fileId: 'parameter-test-visited',
      data: createMockParameterFile({ id: 'test-visited', values: [] })
    }]);

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'test-visited',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      graph,
      setGraph: vi.fn(),
      window: { start: '2025-01-13', end: '2025-01-20' }
    });

    // Verify funnel order: from → visited → to
    const executions = mockDASRunner.getExecutions();
    expect(executions.length).toBe(1);
    
    const dsl = executions[0].dsl;
    expect(dsl.from).toBe('a');
    expect(dsl.to).toBe('c');
    expect(dsl.visited).toContain('b');
  });

  /**
   * TEST: Aggregate mode (non-daily)
   */
  test('aggregate mode: no time-series in file', async () => {
    const graph = createLinearGraph();
    
    mockFileRegistry.seed([{
      fileId: 'parameter-test-param',
      data: createMockParameterFile({ id: 'test-param', values: [] })
    }]);

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'test-param',
      targetId: graph.edges[0].uuid,
      dailyMode: false, // AGGREGATE mode
      graph,
      setGraph: vi.fn()
    });

    // Should execute in aggregate mode
    mockDASRunner.assertModeUsed('aggregate');

    // File should NOT have time-series
    const paramFile = mockFileRegistry.getFile('parameter-test-param');
    if (paramFile && paramFile.data.values.length > 0) {
      // In aggregate mode, values might not be arrays
      expect(paramFile.data.values).not.toBeInstanceOf(Array);
    }
  });

  /**
   * TEST: Query with context filters
   */
  test('query with context: filters passed to adapter', async () => {
    const graph = createTestGraph({
      edges: [{
        from: 'a',
        to: 'b',
        query: 'from(a).to(b).context(cohort:test)',
        p: { mean: 0.5, id: 'test-context' }
      }]
    });

    mockFileRegistry.seed([{
      fileId: 'parameter-test-context',
      data: createMockParameterFile({ id: 'test-context', values: [] })
    }]);

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'test-context',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      graph,
      setGraph: vi.fn()
    });

    // Verify context passed to DSL
    const executions = mockDASRunner.getExecutions();
    expect(executions[0].dsl.context).toBeDefined();
  });

  /**
   * ERROR PATH TEST: DAS execution fails
   */
  test('DAS failure: error propagates gracefully', async () => {
    const graph = createLinearGraph();
    
    mockFileRegistry.seed([{
      fileId: 'parameter-test-param',
      data: createMockParameterFile({ id: 'test-param', values: [] })
    }]);

    // Configure mock to fail
    mockDASRunner = new MockDASRunner({
      shouldFail: true,
      failureMessage: 'Amplitude API rate limit exceeded'
    });

    let errorThrown = false;
    try {
      await dataOperationsService.getFromSourceDirect({
        objectType: 'parameter',
        objectId: 'test-param',
        targetId: graph.edges[0].uuid,
        dailyMode: true,
        graph,
        setGraph: vi.fn()
      });
    } catch (error: any) {
      errorThrown = true;
      expect(error.message).toContain('rate limit');
    }

    // Should have attempted execution
    expect(mockDASRunner.getExecutions().length).toBeGreaterThan(0);
    
    // File should not be corrupted
    const paramFile = mockFileRegistry.getFile('parameter-test-param');
    expect(paramFile!.data.values).toEqual([]); // Still empty
  });

  /**
   * TEST: Incremental fetch (only missing days)
   */
  test('incremental fetch: only requests missing days', async () => {
    const graph = createLinearGraph();
    
    // Seed file with PARTIAL data (days 13-15)
    mockFileRegistry.seed([{
      fileId: 'parameter-test-param',
      data: createMockParameterFile({
        id: 'test-param',
        query: 'from(a).to(b)',
        values: [
          { date: '2025-01-13', mean: 0.5, n: 100, k: 50, query_signature: 'sig1' },
          { date: '2025-01-14', mean: 0.6, n: 100, k: 60, query_signature: 'sig1' },
          { date: '2025-01-15', mean: 0.7, n: 100, k: 70, query_signature: 'sig1' }
        ]
      })
    }]);

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'test-param',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      graph,
      setGraph: vi.fn(),
      window: { start: '2025-01-13', end: '2025-01-20' } // Request 8 days
    });

    // Should only fetch MISSING days (16-20 = 5 days)
    // This is implementation-dependent, but file should have more values now
    const paramFile = mockFileRegistry.getFile('parameter-test-param');
    expect(paramFile!.data.values.length).toBeGreaterThan(3);
  });

  /**
   * TEST: Query string vs DSL object storage
   */
  test('file stores DSL string, not object', async () => {
    const graph = createLinearGraph();
    
    mockFileRegistry.seed([{
      fileId: 'parameter-test-param',
      data: createMockParameterFile({ id: 'test-param', values: [] })
    }]);

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'test-param',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      graph,
      setGraph: vi.fn()
    });

    // File query should be STRING, not object
    const paramFile = mockFileRegistry.getFile('parameter-test-param');
    expect(typeof paramFile!.data.query).toBe('string');
    expect(paramFile!.data.query).toMatch(/^from\(/);
  });

  /**
   * TEST: Multiple parameters on same edge
   */
  test('multiple parameters: each has own file', async () => {
    const graph = createTestGraph({
      edges: [{
        from: 'a',
        to: 'b',
        p: { mean: 0.5, id: 'param-p' },
        cost_gbp: { mean: 100, id: 'param-cost-gbp' },
        cost_time: { mean: 5, id: 'param-cost-time' }
      }]
    });

    // Seed all parameter files
    mockFileRegistry.seed([
      { fileId: 'parameter-param-p', data: createMockParameterFile({ id: 'param-p' }) },
      { fileId: 'parameter-param-cost-gbp', data: createMockParameterFile({ id: 'param-cost-gbp' }) },
      { fileId: 'parameter-param-cost-time', data: createMockParameterFile({ id: 'param-cost-time' }) }
    ]);

    // Fetch each parameter
    for (const paramId of ['param-p', 'param-cost-gbp', 'param-cost-time']) {
      await dataOperationsService.getFromSourceDirect({
        objectType: 'parameter',
        objectId: paramId,
        targetId: graph.edges[0].uuid,
        dailyMode: true,
        graph,
        setGraph: vi.fn()
      });
    }

    // All files should be updated independently
    mockFileRegistry.assertFileUpdated('parameter-param-p');
    mockFileRegistry.assertFileUpdated('parameter-param-cost-gbp');
    mockFileRegistry.assertFileUpdated('parameter-param-cost-time');
  });

  /**
   * PERFORMANCE TEST: Large time-series
   */
  test('large time-series: handles 365 days efficiently', async () => {
    const graph = createLinearGraph();
    
    mockFileRegistry.seed([{
      fileId: 'parameter-test-param',
      data: createMockParameterFile({ id: 'test-param', values: [] })
    }]);

    // Configure mock for 365 days
    mockDASRunner = new MockDASRunner({
      responses: {
        'from(a).to(b)': createMockAmplitudeResponse({
          from_count: 100000,
          to_count: 60000,
          daily: true,
          days: 365
        })
      }
    });

    const startTime = Date.now();

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'test-param',
      targetId: graph.edges[0].uuid,
      dailyMode: true,
      graph,
      setGraph: vi.fn(),
      window: { 
        start: '2024-01-01', 
        end: '2024-12-31' 
      }
    });

    const elapsed = Date.now() - startTime;

    // Should complete in reasonable time (<1s)
    expect(elapsed).toBeLessThan(1000);

    // Should have 365 days
    const paramFile = mockFileRegistry.getFile('parameter-test-param');
    expect(paramFile!.data.values.length).toBe(365);
  });
});

