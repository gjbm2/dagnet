/**
 * Amplitude single-event segmentation integration test (no real HTTP)
 *
 * Validates that the Amplitude adapter can switch from /funnels to /events/segmentation
 * when queryPayload.query_kind === 'segmentation', and that the response is transformed
 * into the same raw shape the rest of the pipeline expects (n/k/time_series).
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

class MockHttpExecutor implements HttpExecutor {
  public lastRequest: HttpRequest | null = null;

  async execute(request: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = request;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        data: {
          xValues: ['2025-11-22', '2025-11-23', '2025-11-24'],
          series: [[10, 12, 8]],
          seriesCollapsed: [[{ value: 25 }]],
          seriesLabels: ['All Users'],
        },
      },
      rawBody: JSON.stringify({
        data: {
          xValues: ['2025-11-22', '2025-11-23', '2025-11-24'],
          series: [[10, 12, 8]],
          seriesCollapsed: [[{ value: 25 }]],
          seriesLabels: ['All Users'],
        },
      }),
    };
  }
}

class RealConnectionProvider implements ConnectionProvider {
  private connections: Map<string, ConnectionDefinition> = new Map();

  constructor() {
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
    if (!conn) throw new Error(`Connection "${name}" not found`);
    return conn;
  }

  async getAllConnections(): Promise<ConnectionDefinition[]> {
    return Array.from(this.connections.values());
  }

  async getConnectionFile() {
    return { version: '1.0.0', connections: [] };
  }
}

describe('Amplitude adapter: single-event segmentation endpoint', () => {
  let runner: DASRunner;
  let mockHttpExecutor: MockHttpExecutor;
  let connectionProvider: RealConnectionProvider;
  let credentialsManager: CredentialsManager;

  beforeEach(() => {
    mockHttpExecutor = new MockHttpExecutor();
    connectionProvider = new RealConnectionProvider();
    credentialsManager = CredentialsManager.getInstance();

    vi.spyOn(credentialsManager, 'loadCredentials').mockResolvedValue({
      success: true,
      source: 'mock' as any,
    });
    vi.spyOn(credentialsManager, 'getProviderCredentials').mockReturnValue({
      api_key: 'test-api-key',
      secret_key: 'test-secret-key',
    });

    runner = new DASRunner(mockHttpExecutor, credentialsManager, connectionProvider);
  });

  it('uses /events/segmentation and returns n + daily time_series for uniques', async () => {
    const queryPayload: any = {
      from: 'household-created',
      to: 'household-created',
      query_kind: 'segmentation',
      context_filters: [
        { field: 'channel', op: 'is', values: ['google'] },
      ],
    };

    const result = await runner.execute('amplitude-prod', queryPayload, {
      window: { start: '2025-11-22T00:00:00Z', end: '2025-11-24T23:59:59Z' },
      context: { mode: 'daily' },
      edgeId: 'test-edge',
      eventDefinitions: {
        'household-created': { id: 'household-created', provider_event_names: { amplitude: 'Household Created' } },
      },
    });

    expect(result.success).toBe(true);
    expect(mockHttpExecutor.lastRequest).not.toBeNull();

    const url = mockHttpExecutor.lastRequest!.url;
    expect(url).toContain('/events/segmentation?');
    expect(url).toContain('m=uniques');

    const raw: any = (result as any).raw;
    expect(raw.n).toBe(25);
    expect(raw.k).toBe(25);
    expect(Array.isArray(raw.time_series)).toBe(true);
    expect(raw.time_series).toHaveLength(3);
    expect(raw.time_series[0]).toMatchObject({ date: '2025-11-22', n: 10, k: 10, p: 1 });
  });
});


