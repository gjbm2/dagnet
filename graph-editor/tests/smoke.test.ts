/**
 * Smoke Tests
 * 
 * Quick sanity checks to verify test infrastructure is working.
 * These should ALWAYS pass if the environment is set up correctly.
 */

import { describe, test, expect } from 'vitest';
import { createTestGraph, createLinearGraph, createCompositeQueryGraph } from './helpers/test-graph-builder';
import { MockFileRegistry } from './helpers/mock-file-registry';
import { MockDASRunner } from './helpers/mock-das-runner';

describe('Smoke Tests: Test Infrastructure', () => {
  test('test helpers load correctly', () => {
    expect(createTestGraph).toBeDefined();
    expect(createLinearGraph).toBeDefined();
    expect(MockFileRegistry).toBeDefined();
    expect(MockDASRunner).toBeDefined();
  });

  test('createTestGraph: builds valid graph', () => {
    const graph = createTestGraph({
      nodes: [{ id: 'a', name: 'Node A' }],
      edges: [{ from: 'a', to: 'b', p: { mean: 0.5 } }]
    });

    expect(graph).toBeDefined();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].p?.mean).toBe(0.5);
  });

  test('createLinearGraph: builds A→B→C', () => {
    const graph = createLinearGraph();

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].from).toBe('a');
    expect(graph.edges[0].to).toBe('b');
  });

  test('createCompositeQueryGraph: has minus() query', () => {
    const graph = createCompositeQueryGraph();

    expect(graph.edges[0].query).toContain('.minus(');
  });

  test('MockFileRegistry: file operations work', async () => {
    const registry = new MockFileRegistry();

    // Create file
    await registry.updateFile('test-file', { data: 'test' });

    // Read file
    const file = registry.getFile('test-file');
    expect(file).toBeDefined();
    expect(file!.data).toEqual({ data: 'test' });

    // Verify operation recorded
    const ops = registry.getOperations();
    expect(ops.length).toBeGreaterThan(0);
  });

  test('MockDASRunner: executes and records', async () => {
    const runner = new MockDASRunner();

    const result = await runner.execute('amplitude-prod', {
      from: 'a',
      to: 'b'
    }, {});

    expect(result.success).toBe(true);
    expect(result.raw).toBeDefined();

    const executions = runner.getExecutions();
    expect(executions).toHaveLength(1);
  });

  test('crypto.randomUUID: available', () => {
    const uuid = crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('custom matchers: toBeCloseTo', () => {
    expect(0.5001).toBeCloseTo(0.5, 2);
    expect(0.6).not.toBeCloseTo(0.5, 1);
  });

  test('custom matchers: toHaveRequiredFields', () => {
    const obj = { id: '123', name: 'test', value: 42 };
    expect(obj).toHaveRequiredFields(['id', 'name']);
    expect(() => expect(obj).toHaveRequiredFields(['id', 'missing']))
      .toThrow();
  });
});

describe('Smoke Tests: Real Module Imports', () => {
  test('can import types', async () => {
    const types = await import('../src/types');
    expect(types).toBeDefined();
  });

  test('can import UpdateManager', async () => {
    const { UpdateManager } = await import('../src/services/UpdateManager');
    expect(UpdateManager).toBeDefined();
    
    const manager = new UpdateManager();
    expect(manager).toBeDefined();
  });

  test('can import queryDSL', async () => {
    const queryDSL = await import('../src/lib/queryDSL');
    expect(queryDSL).toBeDefined();
    expect(queryDSL.QUERY_PATTERN).toBeDefined();
  });

  test('queryDSL: validates simple query', async () => {
    const { QUERY_PATTERN } = await import('../src/lib/queryDSL');
    
    const validQuery = 'from(a).to(b)';
    expect(QUERY_PATTERN.test(validQuery)).toBe(true);
  });

  test('queryDSL: accepts uppercase', async () => {
    const { QUERY_PATTERN } = await import('../src/lib/queryDSL');
    
    const queryWithUppercase = 'from(ABC).to(XYZ)';
    expect(QUERY_PATTERN.test(queryWithUppercase)).toBe(true);
  });

  test('queryDSL: accepts minus/plus', async () => {
    const { QUERY_PATTERN } = await import('../src/lib/queryDSL');
    
    expect(QUERY_PATTERN.test('from(a).to(b).minus(c)')).toBe(true);
    expect(QUERY_PATTERN.test('from(a).to(b).plus(c)')).toBe(true);
  });
});

describe('Smoke Tests: Test Graph Builders', () => {
  test('all graph builders produce valid graphs', () => {
    const builders = [
      createLinearGraph,
      createCompositeQueryGraph,
      () => createTestGraph({ nodes: [], edges: [] })
    ];

    for (const builder of builders) {
      const graph = builder();
      
      expect(graph).toBeDefined();
      expect(graph).toHaveProperty('nodes');
      expect(graph).toHaveProperty('edges');
      expect(Array.isArray(graph.nodes)).toBe(true);
      expect(Array.isArray(graph.edges)).toBe(true);
    }
  });

  test('edges have required fields', () => {
    const graph = createLinearGraph();
    
    for (const edge of graph.edges) {
      expect(edge).toHaveProperty('uuid');
      expect(edge).toHaveProperty('id');
      expect(edge).toHaveProperty('from');
      expect(edge).toHaveProperty('to');
      expect(edge).toHaveProperty('query');
    }
  });

  test('nodes have required fields', () => {
    const graph = createLinearGraph();
    
    for (const node of graph.nodes) {
      expect(node).toHaveProperty('uuid');
      expect(node).toHaveProperty('id');
      expect(node).toHaveProperty('name');
      expect(node).toHaveProperty('type');
    }
  });
});

