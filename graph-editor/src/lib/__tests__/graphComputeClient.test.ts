/**
 * GraphComputeClient Integration Tests
 * 
 * Tests TypeScript → Python API roundtrip:
 * - Health check
 * - Query parsing
 * - Error handling
 * - Mock mode
 * - Environment detection
 * 
 * These tests require the Python dev server running on localhost:9000
 * Run: python dev-server.py
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GraphComputeClient } from '../graphComputeClient';

// Check if Python server is available
let pythonServerAvailable = false;

beforeAll(async () => {
  // Use AbortController to prevent hanging connections
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  
  try {
    const response = await fetch('http://localhost:9000/', { 
      signal: controller.signal 
    });
    pythonServerAvailable = response.ok;
  } catch (e) {
    pythonServerAvailable = false;
  } finally {
    clearTimeout(timeoutId);
  }
}, 5000);

describe('GraphComputeClient - Mock Mode', () => {
  const mockClient = new GraphComputeClient('http://localhost:9000', true);

  it('should return mock health status', async () => {
    const result = await mockClient.health();
    
    expect(result.status).toBe('ok');
    expect(result.env).toBe('mock');
  });

  it('should return mock query parse response', async () => {
    const result = await mockClient.parseQuery('from(a).to(b)');
    
    expect(result.from_node).toBeDefined();
    expect(result.to_node).toBeDefined();
    expect(result.exclude).toBeInstanceOf(Array);
    expect(result.visited).toBeInstanceOf(Array);
    expect(result.context).toBeInstanceOf(Array);
    expect(result.cases).toBeInstanceOf(Array);
  });

});

describe('GraphComputeClient - Real Python Backend', () => {
  const realClient = new GraphComputeClient('http://localhost:9000', false);

  it('should connect to Python server', async () => {
    if (!pythonServerAvailable) {
      console.log('⏭️  Skipping: Python server not available');
      return;
    }
    
    const result = await realClient.health();
    
    expect(result.status).toBe('ok');
    expect(result.service).toBe('dagnet-graph-compute');
  });

  it('should parse simple query', async () => {
    if (!pythonServerAvailable) return;
    
    const result = await realClient.parseQuery('from(a).to(b)');
    
    expect(result.from_node).toBe('a');
    expect(result.to_node).toBe('b');
    expect(result.exclude).toEqual([]);
    expect(result.visited).toEqual([]);
  });

  it('should parse complex query', async () => {
    if (!pythonServerAvailable) return;
    
    const queryString = 'from(start).to(end).visited(checkpoint).exclude(detour)';
    const result = await realClient.parseQuery(queryString);
    
    expect(result.from_node).toBe('start');
    expect(result.to_node).toBe('end');
    expect(result.visited).toContain('checkpoint');
    expect(result.exclude).toContain('detour');
  });

  it('should parse query with context', async () => {
    if (!pythonServerAvailable) return;
    
    const queryString = 'from(a).to(b).context(device:mobile)';
    const result = await realClient.parseQuery(queryString);
    
    expect(result.context).toHaveLength(1);
    expect(result.context[0].key).toBe('device');
    expect(result.context[0].value).toBe('mobile');
  });

  it('should parse query with case', async () => {
    if (!pythonServerAvailable) return;
    
    const queryString = 'from(a).to(b).case(test-1:treatment)';
    const result = await realClient.parseQuery(queryString);
    
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].key).toBe('test-1');
    expect(result.cases[0].value).toBe('treatment');
  });

  it('should handle invalid query syntax', async () => {
    if (!pythonServerAvailable) return;
    
    await expect(
      realClient.parseQuery('invalid query')
    ).rejects.toThrow();
  });

  it('should handle missing from clause', async () => {
    if (!pythonServerAvailable) return;
    
    await expect(
      realClient.parseQuery('to(b)')
    ).rejects.toThrow();
  });

  it('should handle missing to clause', async () => {
    if (!pythonServerAvailable) return;
    
    await expect(
      realClient.parseQuery('from(a)')
    ).rejects.toThrow();
  });
});

describe('GraphComputeClient - Error Handling', () => {
  const client = new GraphComputeClient('http://localhost:9000', false);

  it('should handle network errors gracefully', async () => {
    const offlineClient = new GraphComputeClient('http://localhost:9999', false);
    
    await expect(
      offlineClient.health()
    ).rejects.toThrow();
  });

  it('should provide meaningful error messages', async () => {
    if (!pythonServerAvailable) return;
    
    try {
      await client.parseQuery('invalid');
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toBeDefined();
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('GraphComputeClient - Schema Compliance', () => {
  const mockClient = new GraphComputeClient('http://localhost:9000', true);

  it('should return response matching QueryParseResponse interface', async () => {
    const result = await mockClient.parseQuery('from(a).to(b)');
    
    // All required fields present
    expect(result).toHaveProperty('from_node');
    expect(result).toHaveProperty('to_node');
    expect(result).toHaveProperty('exclude');
    expect(result).toHaveProperty('visited');
    expect(result).toHaveProperty('context');
    expect(result).toHaveProperty('cases');
    
    // Correct types
    expect(typeof result.from_node).toBe('string');
    expect(typeof result.to_node).toBe('string');
    expect(Array.isArray(result.exclude)).toBe(true);
    expect(Array.isArray(result.visited)).toBe(true);
    expect(Array.isArray(result.context)).toBe(true);
    expect(Array.isArray(result.cases)).toBe(true);
  });

  it('should handle all 6 schema-defined functions', async () => {
    if (!pythonServerAvailable) return;
    
    const queries = [
      'from(a).to(b)',
      'from(a).to(b).visited(c)',
      'from(a).to(b).exclude(c)',
      'from(a).to(b).context(k:v)',
      'from(a).to(b).case(t:v)',
      'from(a).to(b).visited(c).exclude(d).context(k:v).case(t:v)',
    ];

    const client = new GraphComputeClient('http://localhost:9000', false);

    for (const query of queries) {
      const result = await client.parseQuery(query);
      expect(result.from_node).toBe('a');
      expect(result.to_node).toBe('b');
    }
  });
});

describe('GraphComputeClient - Environment Detection', () => {
  it('should use correct base URL for dev environment', () => {
    const devClient = new GraphComputeClient();
    expect(devClient['baseUrl']).toBeDefined();
  });

  it('should respect custom base URL', () => {
    const customClient = new GraphComputeClient('http://custom:8888', false);
    expect(customClient['baseUrl']).toBe('http://custom:8888');
  });

  it('should respect mock mode flag', () => {
    const mockClient = new GraphComputeClient('http://localhost:9000', true);
    expect(mockClient['useMock']).toBe(true);
  });

  it('should default to non-mock mode', () => {
    const realClient = new GraphComputeClient('http://localhost:9000', false);
    expect(realClient['useMock']).toBe(false);
  });
});

describe('GraphComputeClient - Performance', () => {
  const client = new GraphComputeClient('http://localhost:9000', true);

  it('should respond quickly in mock mode', async () => {
    const start = Date.now();
    await client.parseQuery('from(a).to(b)');
    const duration = Date.now() - start;
    
    // Mock should be < 10ms
    expect(duration).toBeLessThan(10);
  });

  it('should respond within reasonable time', async () => {
    if (!pythonServerAvailable) return;
    
    const realClient = new GraphComputeClient('http://localhost:9000', false);
    
    const start = Date.now();
    await realClient.health();
    const duration = Date.now() - start;
    
    // Real backend should be < 500ms (warm)
    // Could be higher on cold start
    expect(duration).toBeLessThan(500);
  });
});

