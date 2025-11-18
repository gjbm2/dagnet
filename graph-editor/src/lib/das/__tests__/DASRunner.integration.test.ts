/**
 * DAS Runner Integration Tests with External APIs
 * 
 * Tests DAS runner with mocked external API calls:
 * - Google Sheets integration
 * - Amplitude integration
 * - Mixpanel integration
 * - Custom REST APIs
 * - Error handling and retries
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DASRunner } from '../DASRunner';
import {
  setupGoogleSheetsMocks,
  mockSheetData,
} from '../../../test/mocks/googleSheets';
import {
  setupExternalAPIMocks,
  mockAmplitudeResponse,
  mockMixpanelResponse,
  mockAPIAuthFailure,
  mockAPINotFound,
  mockAPIServerError,
  mockAPITimeout,
} from '../../../test/mocks/externalAPIs';

describe('DAS Runner - External API Integration', () => {
  let runner: DASRunner;
  
  beforeEach(() => {
    runner = new DASRunner();
  });
  
  // ============================================================
  // TEST SUITE 1: Google Sheets Integration
  // ============================================================
  
  describe('Google Sheets Data Retrieval', () => {
    let mocks: ReturnType<typeof setupGoogleSheetsMocks>;
    
    beforeEach(() => {
      mocks = setupGoogleSheetsMocks();
    });
    
    afterEach(() => {
      mocks.restore();
    });
    
    it('should retrieve data from Google Sheets', async () => {
      const dsl = {
        source: 'google-sheets',
        spreadsheet_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        range: 'Sheet1!A1:B10',
      };
      
      const result = await runner.execute('test-sheets-connection', dsl, {
        credentials: {
          service_account_json_b64: Buffer.from(
            JSON.stringify(require('../../../test/mocks/googleSheets').mockServiceAccount)
          ).toString('base64'),
        },
      });
      
      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(mocks.mockFetch).toHaveBeenCalled();
    });
    
    it('should handle Google Sheets authentication errors', async () => {
      mocks.restore();
      global.fetch = require('../../../test/mocks/googleSheets').mockGoogleAuthFailure() as any;
      
      const dsl = {
        source: 'google-sheets',
        spreadsheet_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        range: 'Sheet1!A1:B10',
      };
      
      await expect(
        runner.execute('test-sheets-connection', dsl, {
          credentials: {
            service_account_json_b64: Buffer.from('invalid').toString('base64'),
          },
        })
      ).rejects.toThrow();
    });
    
    it('should cache Google OAuth tokens', async () => {
      const dsl = {
        source: 'google-sheets',
        spreadsheet_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        range: 'Sheet1!A1:B10',
      };
      
      await runner.execute('test-sheets-connection', dsl, {
        credentials: {
          service_account_json_b64: Buffer.from(
            JSON.stringify(require('../../../test/mocks/googleSheets').mockServiceAccount)
          ).toString('base64'),
        },
      });
      
      // Second call should use cached token
      await runner.execute('test-sheets-connection', dsl, {
        credentials: {
          service_account_json_b64: Buffer.from(
            JSON.stringify(require('../../../test/mocks/googleSheets').mockServiceAccount)
          ).toString('base64'),
        },
      });
      
      // Should have called token endpoint only once
      const tokenCalls = mocks.mockFetch.mock.calls.filter((call: any) =>
        call[0].includes('oauth2.googleapis.com/token')
      );
      expect(tokenCalls.length).toBeLessThanOrEqual(1);
    });
    
    it('should transform Google Sheets data according to schema', async () => {
      const dsl = {
        source: 'google-sheets',
        spreadsheet_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        range: 'Sheet1!A1:B10',
        transform: {
          type: 'row_to_object',
          key_column: 0,
          value_column: 1,
        },
      };
      
      const result = await runner.execute('test-sheets-connection', dsl, {
        credentials: {
          service_account_json_b64: Buffer.from(
            JSON.stringify(require('../../../test/mocks/googleSheets').mockServiceAccount)
          ).toString('base64'),
        },
      });
      
      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
    });
  });
  
  // ============================================================
  // TEST SUITE 2: Amplitude Integration
  // ============================================================
  
  describe('Amplitude API Integration', () => {
    let mocks: ReturnType<typeof setupExternalAPIMocks>;
    
    beforeEach(() => {
      mocks = setupExternalAPIMocks({ amplitude: mockAmplitudeResponse });
    });
    
    afterEach(() => {
      mocks.restore();
    });
    
    it('should retrieve data from Amplitude', async () => {
      const dsl = {
        source: 'amplitude',
        event_type: 'page_view',
        start_date: '2025-01-01',
        end_date: '2025-01-05',
      };
      
      const result = await runner.execute('test-amplitude-connection', dsl, {
        credentials: {
          api_key: 'test-api-key',
          secret_key: 'test-secret-key',
        },
      });
      
      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(mocks.mockFetch).toHaveBeenCalled();
    });
    
    it('should generate Basic Auth for Amplitude', async () => {
      const dsl = {
        source: 'amplitude',
        event_type: 'conversion',
      };
      
      await runner.execute('test-amplitude-connection', dsl, {
        credentials: {
          api_key: 'test-api-key',
          secret_key: 'test-secret-key',
        },
      });
      
      // Check that fetch was called with Authorization header
      const fetchCall = mocks.mockFetch.mock.calls[0];
      expect(fetchCall[1]?.headers?.Authorization || fetchCall[1]?.headers?.authorization).toBeDefined();
    });
    
    it('should handle Amplitude authentication errors', async () => {
      mocks.restore();
      global.fetch = mockAPIAuthFailure() as any;
      
      const dsl = {
        source: 'amplitude',
        event_type: 'page_view',
      };
      
      await expect(
        runner.execute('test-amplitude-connection', dsl, {
          credentials: {
            api_key: 'invalid-key',
            secret_key: 'invalid-secret',
          },
        })
      ).rejects.toThrow();
    });
  });
  
  // ============================================================
  // TEST SUITE 3: Mixpanel Integration
  // ============================================================
  
  describe('Mixpanel API Integration', () => {
    let mocks: ReturnType<typeof setupExternalAPIMocks>;
    
    beforeEach(() => {
      mocks = setupExternalAPIMocks({ mixpanel: mockMixpanelResponse });
    });
    
    afterEach(() => {
      mocks.restore();
    });
    
    it('should retrieve data from Mixpanel', async () => {
      const dsl = {
        source: 'mixpanel',
        event: 'Purchase',
        from_date: '2025-01-01',
        to_date: '2025-01-05',
      };
      
      const result = await runner.execute('test-mixpanel-connection', dsl, {
        credentials: {
          api_secret: 'test-mixpanel-secret',
        },
      });
      
      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
    });
    
    it('should handle Mixpanel rate limiting', async () => {
      mocks.restore();
      const { mockAPIRateLimited } = await import('../../../test/mocks/externalAPIs');
      global.fetch = mockAPIRateLimited() as any;
      
      const dsl = {
        source: 'mixpanel',
        event: 'Purchase',
      };
      
      await expect(
        runner.execute('test-mixpanel-connection', dsl, {
          credentials: {
            api_secret: 'test-secret',
          },
        })
      ).rejects.toThrow();
    });
  });
  
  // ============================================================
  // TEST SUITE 4: Custom REST API Integration
  // ============================================================
  
  describe('Custom REST API Integration', () => {
    let mocks: ReturnType<typeof setupExternalAPIMocks>;
    
    beforeEach(() => {
      mocks = setupExternalAPIMocks();
    });
    
    afterEach(() => {
      mocks.restore();
    });
    
    it('should retrieve data from custom REST API', async () => {
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/metrics/bounce_rate',
        method: 'GET',
      };
      
      const result = await runner.execute('test-custom-api', dsl, {
        credentials: {
          api_key: 'test-api-key',
        },
      });
      
      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
    });
    
    it('should support POST requests with body', async () => {
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/query',
        method: 'POST',
        body: {
          query: 'SELECT * FROM metrics WHERE date > "2025-01-01"',
        },
      };
      
      await runner.execute('test-custom-api', dsl, {
        credentials: {
          api_key: 'test-api-key',
        },
      });
      
      const fetchCall = mocks.mockFetch.mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].body).toBeDefined();
    });
    
    it('should handle custom headers', async () => {
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/data',
        headers: {
          'X-Custom-Header': 'custom-value',
          'X-API-Version': '2.0',
        },
      };
      
      await runner.execute('test-custom-api', dsl, {
        credentials: {
          api_key: 'test-api-key',
        },
      });
      
      const fetchCall = mocks.mockFetch.mock.calls[0];
      expect(fetchCall[1].headers['X-Custom-Header']).toBe('custom-value');
    });
  });
  
  // ============================================================
  // TEST SUITE 5: Error Handling
  // ============================================================
  
  describe('Error Handling and Retries', () => {
    it('should handle 404 Not Found errors', async () => {
      const mocks = setupExternalAPIMocks();
      mocks.restore();
      global.fetch = mockAPINotFound() as any;
      
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/nonexistent',
      };
      
      await expect(
        runner.execute('test-api', dsl, {
          credentials: { api_key: 'test' },
        })
      ).rejects.toThrow();
      
      mocks.restore();
    });
    
    it('should handle 500 Server errors', async () => {
      const mocks = setupExternalAPIMocks();
      mocks.restore();
      global.fetch = mockAPIServerError() as any;
      
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/data',
      };
      
      await expect(
        runner.execute('test-api', dsl, {
          credentials: { api_key: 'test' },
        })
      ).rejects.toThrow();
      
      mocks.restore();
    });
    
    it('should handle network timeouts', async () => {
      const mocks = setupExternalAPIMocks();
      mocks.restore();
      global.fetch = mockAPITimeout() as any;
      
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/slow',
      };
      
      await expect(
        runner.execute('test-api', dsl, {
          credentials: { api_key: 'test' },
          timeout: 50, // Very short timeout
        })
      ).rejects.toThrow();
      
      mocks.restore();
    });
    
    it('should log errors for debugging', async () => {
      const mocks = setupExternalAPIMocks();
      mocks.restore();
      global.fetch = mockAPIAuthFailure() as any;
      
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/data',
      };
      
      try {
        await runner.execute('test-api', dsl, {
          credentials: { api_key: 'invalid' },
        });
      } catch (error) {
        // Should have logged the error
        const logs = runner.getLogs();
        expect(logs.some((log: any) => log.level === 'error')).toBe(true);
      }
      
      mocks.restore();
    });
  });
  
  // ============================================================
  // TEST SUITE 6: Connection String Parsing
  // ============================================================
  
  describe('Connection String Parsing', () => {
    let mocks: ReturnType<typeof setupExternalAPIMocks>;
    
    beforeEach(() => {
      mocks = setupExternalAPIMocks();
    });
    
    afterEach(() => {
      mocks.restore();
    });
    
    it('should parse HRN connection strings', async () => {
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/data',
      };
      
      const result = await runner.execute('test-api', dsl, {
        connection_string: 'hrn:dagnet:connection:prod/analytics-api',
        credentials: { api_key: 'test' },
      });
      
      expect(result.status).toBe('success');
    });
    
    it('should handle JSON connection strings', async () => {
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/data',
      };
      
      const connectionString = JSON.stringify({
        provider: 'custom',
        base_url: 'https://api.example.com',
      });
      
      const result = await runner.execute('test-api', dsl, {
        connection_string: connectionString,
        credentials: { api_key: 'test' },
      });
      
      expect(result.status).toBe('success');
    });
  });
  
  // ============================================================
  // TEST SUITE 7: Data Transformation
  // ============================================================
  
  describe('Data Transformation', () => {
    let mocks: ReturnType<typeof setupExternalAPIMocks>;
    
    beforeEach(() => {
      mocks = setupExternalAPIMocks({
        custom: {
          items: [
            { date: '2025-01-01', value: 100 },
            { date: '2025-01-02', value: 150 },
            { date: '2025-01-03', value: 200 },
          ],
        },
      });
    });
    
    afterEach(() => {
      mocks.restore();
    });
    
    it('should apply JSONPath transformations', async () => {
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/data',
        transform: {
          type: 'jsonpath',
          expression: '$.items[*].value',
        },
      };
      
      const result = await runner.execute('test-api', dsl, {
        credentials: { api_key: 'test' },
      });
      
      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
    });
    
    it('should apply aggregation transformations', async () => {
      const dsl = {
        source: 'custom',
        url: 'https://api.example.com/data',
        transform: {
          type: 'aggregate',
          operation: 'mean',
          field: 'value',
        },
      };
      
      const result = await runner.execute('test-api', dsl, {
        credentials: { api_key: 'test' },
      });
      
      expect(result.status).toBe('success');
    });
  });
});

