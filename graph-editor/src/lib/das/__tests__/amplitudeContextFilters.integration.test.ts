/**
 * Amplitude Context Filters Integration Tests
 * 
 * Tests that context_filters are correctly:
 * 1. Passed to the DAS runner
 * 2. Processed by the Amplitude adapter's pre_request script
 * 3. Converted to segment parameters in the API URL
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DASRunner } from '../DASRunner';
import { CredentialsManager } from '../../credentials';
import type { HttpExecutor, HttpRequest, HttpResponse } from '../HttpExecutor';
import type { ConnectionProvider } from '../ConnectionProvider';
import type { ConnectionDefinition } from '../types';
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';

// Mock HttpExecutor that captures the request
class MockHttpExecutor implements HttpExecutor {
  public lastRequest: HttpRequest | null = null;
  
  async execute(request: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = request;
    
    // Return mock funnel response
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        data: [[
          { timestamp: 20251122, cumulativeRaw: [1000, 800] },
          { timestamp: 20251123, cumulativeRaw: [1200, 900] }
        ]]
      },
      rawBody: JSON.stringify({
        data: [[
          { timestamp: 20251122, cumulativeRaw: [1000, 800] },
          { timestamp: 20251123, cumulativeRaw: [1200, 900] }
        ]]
      })
    };
  }
}

// Mock ConnectionProvider that loads the actual connections.yaml
class RealConnectionProvider implements ConnectionProvider {
  private connections: Map<string, ConnectionDefinition> = new Map();
  
  constructor() {
    // Load the actual connections.yaml file
    const connectionsPath = path.join(__dirname, '../../../../public/defaults/connections.yaml');
    if (fs.existsSync(connectionsPath)) {
      const content = fs.readFileSync(connectionsPath, 'utf8');
      const parsed = yaml.parse(content);
      if (parsed.connections) {
        for (const conn of parsed.connections) {
          this.connections.set(conn.name, conn);
        }
      }
    }
  }
  
  async getConnection(name: string): Promise<ConnectionDefinition> {
    const conn = this.connections.get(name);
    if (!conn) {
      throw new Error(`Connection "${name}" not found`);
    }
    return conn;
  }
  
  async getAllConnections(): Promise<ConnectionDefinition[]> {
    return Array.from(this.connections.values());
  }
  
  async getConnectionFile() {
    return { version: '1.0.0', connections: [] };
  }
}

describe('Amplitude Adapter Context Filter Processing', () => {
  let runner: DASRunner;
  let mockHttpExecutor: MockHttpExecutor;
  let connectionProvider: RealConnectionProvider;
  let credentialsManager: CredentialsManager;

  beforeEach(() => {
    mockHttpExecutor = new MockHttpExecutor();
    connectionProvider = new RealConnectionProvider();
    credentialsManager = CredentialsManager.getInstance();
    
    // Mock credentials
    vi.spyOn(credentialsManager, 'loadCredentials').mockResolvedValue({
      success: true,
      source: 'mock' as any
    });
    vi.spyOn(credentialsManager, 'getProviderCredentials').mockReturnValue({
      api_key: 'test-api-key',
      secret_key: 'test-secret-key'
    });
    
    runner = new DASRunner(
      mockHttpExecutor,
      credentialsManager,
      connectionProvider
    );
  });

  it('should process regex pattern context_filter into segment parameter', async () => {
    const queryPayload = {
      from: 'household-created',
      to: 'household-delegated',
      context_filters: [
        {
          field: 'utm_medium',
          op: 'matches',
          values: [],
          pattern: '^(Paid Social|paidsocial)$',
          patternFlags: 'i'
        }
      ]
    };
    
    const result = await runner.execute('amplitude-prod', queryPayload, {
      window: { start: '2025-11-22T00:00:00Z', end: '2025-11-28T23:59:59Z' },
      edgeId: 'test-edge',
      eventDefinitions: {}
    });
    
    expect(result.success).toBe(true);
    expect(mockHttpExecutor.lastRequest).not.toBeNull();
    
    const url = mockHttpExecutor.lastRequest!.url;
    console.log('Request URL:', url);
    
    // URL should contain the segment parameter
    expect(url).toContain('s=');
    
    // Decode and parse the segment parameter
    const urlObj = new URL(url);
    const segmentParam = urlObj.searchParams.get('s');
    expect(segmentParam).not.toBeNull();
    
    const segments = JSON.parse(segmentParam!);
    console.log('Parsed segments:', JSON.stringify(segments, null, 2));
    
    // Should have at least one segment for the context filter
    expect(segments.length).toBeGreaterThan(0);
    
    // Find the utm_medium filter
    const utmFilter = segments.find((s: any) => s.prop === 'gp:utm_medium');
    expect(utmFilter).toBeDefined();
    expect(utmFilter.op).toBe('is');
    expect(utmFilter.values).toContain('Paid Social');
    expect(utmFilter.values).toContain('paidsocial');
  });

  it('should process simple values context_filter into segment parameter', async () => {
    const queryPayload = {
      from: 'household-created',
      to: 'household-delegated',
      context_filters: [
        {
          field: 'channel',
          op: 'is',
          values: ['google', 'facebook']
        }
      ]
    };
    
    const result = await runner.execute('amplitude-prod', queryPayload, {
      window: { start: '2025-11-22T00:00:00Z', end: '2025-11-28T23:59:59Z' },
      edgeId: 'test-edge',
      eventDefinitions: {}
    });
    
    expect(result.success).toBe(true);
    
    const url = mockHttpExecutor.lastRequest!.url;
    const urlObj = new URL(url);
    const segmentParam = urlObj.searchParams.get('s');
    expect(segmentParam).not.toBeNull();
    
    const segments = JSON.parse(segmentParam!);
    
    const channelFilter = segments.find((s: any) => s.prop === 'gp:channel');
    expect(channelFilter).toBeDefined();
    expect(channelFilter.op).toBe('is');
    expect(channelFilter.values).toContain('google');
    expect(channelFilter.values).toContain('facebook');
  });

  it('should handle context_filter with "is not" operator', async () => {
    const queryPayload = {
      from: 'household-created',
      to: 'household-delegated',
      context_filters: [
        {
          field: 'platform',
          op: 'is not',
          values: ['bot', 'test']
        }
      ]
    };
    
    const result = await runner.execute('amplitude-prod', queryPayload, {
      window: { start: '2025-11-22T00:00:00Z', end: '2025-11-28T23:59:59Z' },
      edgeId: 'test-edge',
      eventDefinitions: {}
    });
    
    expect(result.success).toBe(true);
    
    const url = mockHttpExecutor.lastRequest!.url;
    const urlObj = new URL(url);
    const segmentParam = urlObj.searchParams.get('s');
    expect(segmentParam).not.toBeNull();
    
    const segments = JSON.parse(segmentParam!);
    
    // Platform is a built-in property, so no gp: prefix
    const platformFilter = segments.find((s: any) => s.prop === 'platform');
    expect(platformFilter).toBeDefined();
    expect(platformFilter.op).toBe('is not');
    expect(platformFilter.values).toContain('bot');
    expect(platformFilter.values).toContain('test');
  });

  it('should NOT add segment parameter when no context_filters', async () => {
    const queryPayload = {
      from: 'household-created',
      to: 'household-delegated'
      // No context_filters
    };
    
    const result = await runner.execute('amplitude-prod', queryPayload, {
      window: { start: '2025-11-22T00:00:00Z', end: '2025-11-28T23:59:59Z' },
      edgeId: 'test-edge',
      eventDefinitions: {}
    });
    
    expect(result.success).toBe(true);
    
    const url = mockHttpExecutor.lastRequest!.url;
    console.log('URL without context_filters:', url);
    
    // URL should either not contain 's=' or have an empty segment array
    const urlObj = new URL(url);
    const segmentParam = urlObj.searchParams.get('s');
    
    // Segments might only contain cohort exclusions, not context filters
    if (segmentParam) {
      const segments = JSON.parse(segmentParam);
      // Should NOT have any gp: prefixed segments (those are context filters)
      const contextFilters = segments.filter((s: any) => s.prop?.startsWith('gp:'));
      expect(contextFilters.length).toBe(0);
    }
  });

  it('should preserve built-in user property names without gp: prefix', async () => {
    const queryPayload = {
      from: 'household-created',
      to: 'household-delegated',
      context_filters: [
        {
          field: 'platform',  // Built-in property
          op: 'is',
          values: ['iOS']
        }
      ]
    };
    
    const result = await runner.execute('amplitude-prod', queryPayload, {
      window: { start: '2025-11-22T00:00:00Z', end: '2025-11-28T23:59:59Z' },
      edgeId: 'test-edge',
      eventDefinitions: {}
    });
    
    expect(result.success).toBe(true);
    
    const url = mockHttpExecutor.lastRequest!.url;
    const urlObj = new URL(url);
    const segmentParam = urlObj.searchParams.get('s');
    expect(segmentParam).not.toBeNull();
    
    const segments = JSON.parse(segmentParam!);
    
    // Platform is a built-in, should NOT have gp: prefix
    const platformFilter = segments.find((s: any) => s.prop === 'platform');
    expect(platformFilter).toBeDefined();
    expect(platformFilter.op).toBe('is');
    expect(platformFilter.values).toContain('iOS');
  });

  it('should handle multiple context_filters (AND logic)', async () => {
    const queryPayload = {
      from: 'household-created',
      to: 'household-delegated',
      context_filters: [
        {
          field: 'utm_medium',
          op: 'is',
          values: ['cpc']
        },
        {
          field: 'platform',
          op: 'is',
          values: ['iOS']
        }
      ]
    };
    
    const result = await runner.execute('amplitude-prod', queryPayload, {
      window: { start: '2025-11-22T00:00:00Z', end: '2025-11-28T23:59:59Z' },
      edgeId: 'test-edge',
      eventDefinitions: {}
    });
    
    expect(result.success).toBe(true);
    
    const url = mockHttpExecutor.lastRequest!.url;
    const urlObj = new URL(url);
    const segmentParam = urlObj.searchParams.get('s');
    expect(segmentParam).not.toBeNull();
    
    const segments = JSON.parse(segmentParam!);
    console.log('Multiple filters segments:', JSON.stringify(segments, null, 2));
    
    // Should have segments for both filters
    const utmFilter = segments.find((s: any) => s.prop === 'gp:utm_medium');
    const platformFilter = segments.find((s: any) => s.prop === 'platform');
    
    expect(utmFilter).toBeDefined();
    expect(platformFilter).toBeDefined();
  });
});

