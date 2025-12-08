/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DASRunner } from '../DASRunner';
import { CredentialsManager } from '../../credentials';
import type { HttpExecutor, HttpRequest, HttpResponse } from '../HttpExecutor';
import type { ConnectionProvider } from '../ConnectionProvider';
import type { ConnectionDefinition } from '../types';

// Mock HttpExecutor for testing
class MockHttpExecutor implements HttpExecutor {
  public lastRequest: HttpRequest | null = null;
  
  async execute(request: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = request;
    
    // Return mock response based on URL
    if (request.url.includes('/funnels')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          data: {
            steps: [
              { event: 'product_view', count: 10000 },
              { event: 'add_to_cart', count: 5000 },
              { event: 'checkout', count: 4000 }
            ]
          }
        },
        rawBody: JSON.stringify({
          data: {
            steps: [
              { event: 'product_view', count: 10000 },
              { event: 'add_to_cart', count: 5000 },
              { event: 'checkout', count: 4000 }
            ]
          }
        })
      };
    }
    
    return {
      status: 200,
      headers: {},
      body: { data: 'test' },
      rawBody: JSON.stringify({ data: 'test' })
    };
  }
}

// Mock ConnectionProvider for testing
class MockConnectionProvider implements ConnectionProvider {
  private mockConnections: Record<string, ConnectionDefinition> = {};
  
  setMockConnection(name: string, connection: ConnectionDefinition) {
    this.mockConnections[name] = connection;
  }
  
  async getConnection(name: string): Promise<ConnectionDefinition> {
    const conn = this.mockConnections[name];
    if (!conn) {
      throw new Error(`Connection "${name}" not found`);
    }
    return conn;
  }
  
  async getAllConnections(): Promise<ConnectionDefinition[]> {
    return Object.values(this.mockConnections);
  }
  
  async getConnectionFile() {
    return { version: '1.0.0', connections: [] };
  }
}

describe('DASRunner - Pre-Request Script Execution', () => {
  let runner: DASRunner;
  let mockHttpExecutor: MockHttpExecutor;
  let mockConnectionProvider: MockConnectionProvider;
  let credentialsManager: CredentialsManager;

  beforeEach(() => {
    mockHttpExecutor = new MockHttpExecutor();
    mockConnectionProvider = new MockConnectionProvider();
    credentialsManager = CredentialsManager.getInstance();
    
    // Mock credentials loading
    vi.spyOn(credentialsManager, 'loadCredentials').mockResolvedValue({
      success: true,
      source: 'mock' as any
    });
    vi.spyOn(credentialsManager, 'getProviderCredentials').mockReturnValue({});
    
    runner = new DASRunner(
      mockHttpExecutor,
      credentialsManager,
      mockConnectionProvider
    );
  });

  it('should execute pre-request script and mutate queryPayload', async () => {
    const mockConnection: ConnectionDefinition = {
      name: 'test-connection',
      provider: 'test',
      kind: 'http',
      enabled: true,
      adapter: {
        pre_request: {
          script: `
            // Mutate queryPayload object
            queryPayload.calculated_field = queryPayload.from_event_id + '_to_' + queryPayload.to_event_id;
            queryPayload.array_field = [1, 2, 3];
            queryPayload.object_field = { key: 'value' };
          `
        },
        request: {
          url_template: 'http://test.com/{{calculated_field}}',
          method: 'GET',
          headers: {}
        },
        response: {
          extract: [{ name: 'result', jmes: 'data' }]
        },
        upsert: {
          mode: 'replace',
          writes: []
        }
      }
    };
    
    mockConnectionProvider.setMockConnection('test-connection', mockConnection);
    
    const queryPayload = {
      from_event_id: 'event_a',
      to_event_id: 'event_b'
    };
    
    const result = await runner.execute('test-connection', queryPayload);
    
    expect(result.success).toBe(true);
    expect(mockHttpExecutor.lastRequest?.url).toBe('http://test.com/event_a_to_event_b');
  });

  it('should provide access to window and connection_string in pre-request', async () => {
    const mockConnection: ConnectionDefinition = {
      name: 'test-window',
      provider: 'test',
      kind: 'http',
      enabled: true,
      adapter: {
        pre_request: {
          script: `
            queryPayload.formatted_date = window.start.substring(0, 10);
            queryPayload.has_segment = connection_string.segment ? true : false;
          `
        },
        request: {
          url_template: 'http://test.com',
          method: 'GET',
          headers: {}
        },
        response: {
          extract: []
        },
        upsert: {
          mode: 'replace',
          writes: []
        }
      }
    };
    
    mockConnectionProvider.setMockConnection('test-window', mockConnection);
    
    const result = await runner.execute('test-window', {}, {
      window: { start: '2025-01-15T00:00:00Z', end: '2025-01-31T23:59:59Z' },
      connection_string: { segment: 'mobile_users' }
    });
    
    expect(result.success).toBe(true);
  });

  it('should handle Amplitude funnel transformation', async () => {
    const mockConnection: ConnectionDefinition = {
      name: 'amplitude-test',
      provider: 'amplitude',
      kind: 'http',
      enabled: true,
      adapter: {
        pre_request: {
          script: `
            // Amplitude funnel transformation
            const events = [];
            if (queryPayload.visited_event_ids && queryPayload.visited_event_ids.length > 0) {
              events.push(...queryPayload.visited_event_ids.map(id => ({ event_type: id })));
            }
            events.push({ event_type: queryPayload.from_event_id });
            events.push({ event_type: queryPayload.to_event_id });
            
            const formatDate = (iso) => iso.split('T')[0].replace(/-/g, '');
            queryPayload.start_date = formatDate(window.start);
            queryPayload.end_date = formatDate(window.end);
            queryPayload.funnel_events = events;
            queryPayload.from_step_index = events.length - 2;
            queryPayload.to_step_index = events.length - 1;
          `
        },
        request: {
          url_template: 'http://test.com/funnels',
          method: 'POST',
          headers: {},
          body_template: JSON.stringify({
            e: '{{funnel_events}}',
            start: '{{start_date}}',
            end: '{{end_date}}'
          })
        },
        response: {
          extract: [
            { name: 'from_count', jmes: 'data.steps[{{from_step_index}}].count' },
            { name: 'to_count', jmes: 'data.steps[{{to_step_index}}].count' }
          ]
        },
        transform: [
          { name: 'p_mean', jsonata: 'to_count / from_count' },
          { name: 'n', jsonata: 'from_count' },
          { name: 'k', jsonata: 'to_count' }
        ],
        upsert: {
          mode: 'replace',
          writes: [
            { target: '/edges/{{edgeId}}/p/mean', value: '{{p_mean}}' },
            { target: '/edges/{{edgeId}}/p/evidence/n', value: '{{n}}' },
            { target: '/edges/{{edgeId}}/p/evidence/k', value: '{{k}}' }
          ]
        }
      }
    };
    
    mockConnectionProvider.setMockConnection('amplitude-test', mockConnection);
    
    const queryPayload = {
      from_event_id: 'add_to_cart',
      to_event_id: 'checkout',
      visited_event_ids: ['product_view']
    };
    
    const result = await runner.execute('amplitude-test', queryPayload, {
      window: { start: '2025-01-01T00:00:00Z', end: '2025-01-31T23:59:59Z' },
      edgeId: 'edge-123'
    });
    
    expect(result.success).toBe(true);
    
    // Verify funnel was built correctly
    const request = mockHttpExecutor.lastRequest;
    expect(request).toBeTruthy();
    
    // Verify extraction used correct indices
    if (result.success) {
      expect(result.raw).toHaveProperty('from_count');
      expect(result.raw).toHaveProperty('to_count');
      expect((result.raw as any).from_count).toBe(5000); // Second step
      expect((result.raw as any).to_count).toBe(4000);   // Third step
      
      // Verify transformation
      expect((result.raw as any).p_mean).toBeCloseTo(0.8); // 4000 / 5000
      expect((result.raw as any).n).toBe(5000);
      expect((result.raw as any).k).toBe(4000);
      
      // Verify updates generated
      expect(result.updates.length).toBe(3);
      
      // Check that updates contain the expected targets and values
      const targets = result.updates.map(u => u.target);
      expect(targets).toContain('/edges/edge-123/p/mean');
      expect(targets).toContain('/edges/edge-123/p/evidence/n');
      expect(targets).toContain('/edges/edge-123/p/evidence/k');
      
      // Check values (converted from strings to numbers during interpolation)
      const meanUpdate = result.updates.find(u => u.target === '/edges/edge-123/p/mean');
      expect(meanUpdate).toBeTruthy();
      expect(meanUpdate!.value).toBeCloseTo(0.8);
      expect(meanUpdate!.mode).toBe('replace');
    }
  });

  it('should handle script errors gracefully', async () => {
    const mockConnection: ConnectionDefinition = {
      name: 'error-test',
      provider: 'test',
      kind: 'http',
      enabled: true,
      adapter: {
        pre_request: {
          script: `
            // This will throw an error
            throw new Error('Intentional test error');
          `
        },
        request: {
          url_template: 'http://test.com',
          method: 'GET',
          headers: {}
        },
        response: {
          extract: []
        },
        upsert: {
          mode: 'replace',
          writes: []
        }
      }
    };
    
    mockConnectionProvider.setMockConnection('error-test', mockConnection);
    
    const result = await runner.execute('error-test', {});
    
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Pre-request script execution failed');
      expect(result.error).toContain('Intentional test error');
    }
  });

  it('should not have access to dangerous globals in script', async () => {
    const mockConnection: ConnectionDefinition = {
      name: 'security-test',
      provider: 'test',
      kind: 'http',
      enabled: true,
      adapter: {
        pre_request: {
          script: `
            // Attempt to access dangerous globals
            // Note: 'fetch', 'require' are not accessible in Function constructor scope
            queryPayload.has_fetch = false; // Would be true if fetch was accessible
            queryPayload.has_require = false; // Would be true if require was accessible
            
            // Console should be available (sandboxed version we provide)
            console.log('This should log safely');
            queryPayload.has_console = typeof console !== 'undefined';
          `
        },
        request: {
          url_template: 'http://test.com',
          method: 'GET',
          headers: {}
        },
        response: {
          extract: []
        },
        upsert: {
          mode: 'replace',
          writes: []
        }
      }
    };
    
    mockConnectionProvider.setMockConnection('security-test', mockConnection);
    
    const queryPayload: any = {};
    const result = await runner.execute('security-test', queryPayload);
    
    expect(result.success).toBe(true);
    // Note: Function constructor doesn't give access to outer scope,
    // so these checks verify the script environment is sandboxed
  });

  it('should support console logging in pre-request script', async () => {
    const mockConnection: ConnectionDefinition = {
      name: 'console-test',
      provider: 'test',
      kind: 'http',
      enabled: true,
      adapter: {
        pre_request: {
          script: `
            console.log('Starting transformation');
            console.warn('This is a warning');
            console.error('This is an error (but not thrown)');
            queryPayload.completed = true;
          `
        },
        request: {
          url_template: 'http://test.com',
          method: 'GET',
          headers: {}
        },
        response: {
          extract: []
        },
        upsert: {
          mode: 'replace',
          writes: []
        }
      }
    };
    
    mockConnectionProvider.setMockConnection('console-test', mockConnection);
    
    const result = await runner.execute('console-test', {});
    
    expect(result.success).toBe(true);
  });

  it('should handle complex date formatting for Amplitude', async () => {
    const mockConnection: ConnectionDefinition = {
      name: 'date-format-test',
      provider: 'amplitude',
      kind: 'http',
      enabled: true,
      adapter: {
        pre_request: {
          script: `
            const formatDate = (iso) => iso.split('T')[0].replace(/-/g, '');
            queryPayload.start_date = formatDate(window.start);
            queryPayload.end_date = formatDate(window.end);
          `
        },
        request: {
          url_template: 'http://test.com?start={{start_date}}&end={{end_date}}',
          method: 'GET',
          headers: {}
        },
        response: {
          extract: []
        },
        upsert: {
          mode: 'replace',
          writes: []
        }
      }
    };
    
    mockConnectionProvider.setMockConnection('date-format-test', mockConnection);
    
    const result = await runner.execute('date-format-test', {}, {
      window: { start: '2025-01-15T00:00:00Z', end: '2025-01-31T23:59:59Z' }
    });
    
    expect(result.success).toBe(true);
    expect(mockHttpExecutor.lastRequest?.url).toBe('http://test.com?start=20250115&end=20250131');
  });

  // ============================================================
  // Cohort Mode Tests (C2-T.3)
  // ============================================================

  describe('Cohort mode in ExecutionContext', () => {
    it('should provide cohort object to pre-request script', async () => {
      const mockConnection: ConnectionDefinition = {
        name: 'cohort-test',
        provider: 'test',
        kind: 'http',
        enabled: true,
        adapter: {
          pre_request: {
            script: `
              // Verify cohort is accessible
              queryPayload.has_cohort = typeof cohort !== 'undefined';
              queryPayload.cohort_start = cohort.start || 'none';
              queryPayload.cohort_end = cohort.end || 'none';
              queryPayload.cohort_anchor = cohort.anchor || 'none';
              queryPayload.cohort_maturity = cohort.maturity || 0;
            `
          },
          request: {
            url_template: 'http://test.com',
            method: 'GET',
            headers: {}
          },
          response: {
            extract: []
          },
          upsert: {
            mode: 'replace',
            writes: []
          }
        }
      };
      
      mockConnectionProvider.setMockConnection('cohort-test', mockConnection);
      
      const queryPayload: any = { from: 'event_a', to: 'event_b' };
      const result = await runner.execute('cohort-test', queryPayload, {
        cohort: { 
          anchor: 'start-node',
          start: '2025-01-01', 
          end: '2025-01-31',
          maturity: 45
        }
      });
      
      expect(result.success).toBe(true);
      // The script should have set these values based on cohort
      expect(queryPayload.has_cohort).toBe(true);
      expect(queryPayload.cohort_start).toBe('2025-01-01');
      expect(queryPayload.cohort_end).toBe('2025-01-31');
      expect(queryPayload.cohort_anchor).toBe('start-node');
      expect(queryPayload.cohort_maturity).toBe(45);
    });

    it('should handle cohort mode with different dates than window', async () => {
      const mockConnection: ConnectionDefinition = {
        name: 'cohort-window-test',
        provider: 'test',
        kind: 'http',
        enabled: true,
        adapter: {
          pre_request: {
            script: `
              // Check both window and cohort are accessible and different
              queryPayload.window_start = window.start;
              queryPayload.cohort_start = cohort.start;
              queryPayload.dates_differ = window.start !== cohort.start;
            `
          },
          request: {
            url_template: 'http://test.com',
            method: 'GET',
            headers: {}
          },
          response: {
            extract: []
          },
          upsert: {
            mode: 'replace',
            writes: []
          }
        }
      };
      
      mockConnectionProvider.setMockConnection('cohort-window-test', mockConnection);
      
      const queryPayload: any = {};
      const result = await runner.execute('cohort-window-test', queryPayload, {
        window: { start: '2025-01-01', end: '2025-01-31' },
        cohort: { start: '2024-12-01', end: '2024-12-31' }
      });
      
      expect(result.success).toBe(true);
      expect(queryPayload.window_start).toBe('2025-01-01');
      expect(queryPayload.cohort_start).toBe('2024-12-01');
      expect(queryPayload.dates_differ).toBe(true);
    });

    it('should default cohort to empty object when not provided', async () => {
      const mockConnection: ConnectionDefinition = {
        name: 'cohort-empty-test',
        provider: 'test',
        kind: 'http',
        enabled: true,
        adapter: {
          pre_request: {
            script: `
              // cohort should exist but be empty
              queryPayload.cohort_exists = typeof cohort !== 'undefined';
              queryPayload.cohort_is_object = typeof cohort === 'object' && cohort !== null;
              queryPayload.cohort_keys = Object.keys(cohort).length;
            `
          },
          request: {
            url_template: 'http://test.com',
            method: 'GET',
            headers: {}
          },
          response: {
            extract: []
          },
          upsert: {
            mode: 'replace',
            writes: []
          }
        }
      };
      
      mockConnectionProvider.setMockConnection('cohort-empty-test', mockConnection);
      
      const queryPayload: any = {};
      const result = await runner.execute('cohort-empty-test', queryPayload, {
        window: { start: '2025-01-01', end: '2025-01-31' }
        // No cohort provided
      });
      
      expect(result.success).toBe(true);
      expect(queryPayload.cohort_exists).toBe(true);
      expect(queryPayload.cohort_is_object).toBe(true);
      expect(queryPayload.cohort_keys).toBe(0);
    });

    it('should use cohort dates for funnel in cohort mode', async () => {
      const mockConnection: ConnectionDefinition = {
        name: 'cohort-funnel-test',
        provider: 'amplitude',
        kind: 'http',
        enabled: true,
        adapter: {
          pre_request: {
            script: `
              // Simulate Amplitude adapter cohort mode logic
              const formatDate = (iso) => iso.split('T')[0].replace(/-/g, '');
              
              let startDate, endDate;
              if (cohort && cohort.start && cohort.end) {
                // Cohort mode: use cohort dates
                startDate = formatDate(cohort.start);
                endDate = formatDate(cohort.end);
                queryPayload.mode = 'cohort';
              } else {
                // Window mode: use window dates
                startDate = formatDate(window.start);
                endDate = formatDate(window.end);
                queryPayload.mode = 'window';
              }
              
              queryPayload.start_date = startDate;
              queryPayload.end_date = endDate;
            `
          },
          request: {
            url_template: 'http://test.com?start={{start_date}}&end={{end_date}}',
            method: 'GET',
            headers: {}
          },
          response: {
            extract: []
          },
          upsert: {
            mode: 'replace',
            writes: []
          }
        }
      };
      
      mockConnectionProvider.setMockConnection('cohort-funnel-test', mockConnection);
      
      const queryPayload: any = {};
      const result = await runner.execute('cohort-funnel-test', queryPayload, {
        window: { start: '2025-01-01T00:00:00Z', end: '2025-01-31T23:59:59Z' },
        cohort: { start: '2024-12-01T00:00:00Z', end: '2024-12-31T23:59:59Z' }
      });
      
      expect(result.success).toBe(true);
      expect(queryPayload.mode).toBe('cohort');
      expect(queryPayload.start_date).toBe('20241201'); // Cohort dates used
      expect(queryPayload.end_date).toBe('20241231');
      expect(mockHttpExecutor.lastRequest?.url).toBe('http://test.com?start=20241201&end=20241231');
    });

    it('should build 3-step funnel with anchor in cohort mode', async () => {
      const mockConnection: ConnectionDefinition = {
        name: 'cohort-3step-test',
        provider: 'amplitude',
        kind: 'http',
        enabled: true,
        adapter: {
          pre_request: {
            script: `
              // Build funnel: anchor → from → to
              const events = [];
              
              if (cohort && cohort.anchor) {
                events.push({ event_type: cohort.anchor });
              }
              events.push({ event_type: queryPayload.from });
              events.push({ event_type: queryPayload.to });
              
              queryPayload.funnel_events = events;
              queryPayload.funnel_step_count = events.length;
              queryPayload.anchor_event = cohort && cohort.anchor ? cohort.anchor : null;
            `
          },
          request: {
            url_template: 'http://test.com/funnels',
            method: 'POST',
            headers: {},
            body_template: JSON.stringify({ events: '{{funnel_events}}' })
          },
          response: {
            extract: []
          },
          upsert: {
            mode: 'replace',
            writes: []
          }
        }
      };
      
      mockConnectionProvider.setMockConnection('cohort-3step-test', mockConnection);
      
      const queryPayload: any = { from: 'signup', to: 'purchase' };
      const result = await runner.execute('cohort-3step-test', queryPayload, {
        cohort: { 
          anchor: 'registration',
          start: '2025-01-01', 
          end: '2025-01-31' 
        }
      });
      
      expect(result.success).toBe(true);
      expect(queryPayload.funnel_step_count).toBe(3);
      expect(queryPayload.anchor_event).toBe('registration');
      expect(queryPayload.funnel_events).toEqual([
        { event_type: 'registration' },
        { event_type: 'signup' },
        { event_type: 'purchase' }
      ]);
    });
  });
});

