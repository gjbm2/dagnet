import { describe, it, expect, vi } from 'vitest';
import { 
  aggregateWindowsWithContexts, 
  tryMECEAggregationAcrossContexts,
  buildContextDSL,
  contextMatches,
  type ContextCombination 
} from '../contextAggregationService';
import { contextRegistry } from '../contextRegistry';
import type { ContextDefinition } from '../contextRegistry';
import type { ParameterValue } from '../paramRegistryService';

describe('Context Aggregation Service', () => {
  
  describe('buildContextDSL', () => {
    it('should build empty string for uncontexted', () => {
      expect(buildContextDSL({})).toBe('');
    });
    
    it('should build single context DSL', () => {
      expect(buildContextDSL({ channel: 'google' })).toBe('context(channel:google)');
    });
    
    it('should build multiple contexts in alphabetical order', () => {
      const result = buildContextDSL({ channel: 'google', 'browser-type': 'chrome' });
      expect(result).toBe('context(browser-type:chrome).context(channel:google)');
    });
  });
  
  describe('contextMatches', () => {
    it('should match identical contexts', () => {
      const windowContexts = [{ key: 'channel', value: 'google' }];
      const queryCombo = { channel: 'google' };
      
      expect(contextMatches(windowContexts, queryCombo)).toBe(true);
    });
    
    it('should not match different values', () => {
      const windowContexts = [{ key: 'channel', value: 'google' }];
      const queryCombo = { channel: 'meta' };
      
      expect(contextMatches(windowContexts, queryCombo)).toBe(false);
    });
    
    it('should not match different key count', () => {
      const windowContexts = [{ key: 'channel', value: 'google' }];
      const queryCombo = { channel: 'google', browser: 'chrome' };
      
      expect(contextMatches(windowContexts, queryCombo)).toBe(false);
    });
  });
  
  describe('aggregateWindowsWithContexts', () => {
    it('should aggregate specific context slice', async () => {
      const windows: ParameterValue[] = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15, mean: 0.15 },
        { sliceDSL: 'context(channel:meta)', n: 80, k: 12, mean: 0.15 }
      ];
      const variable = {
        id: 'test-var',
        windows
      };
      
      const { parseConstraints } = await import('../../lib/queryDSL');
      const constraints = parseConstraints('context(channel:google)');
      
      const result = await aggregateWindowsWithContexts({
        variable,
        constraints,
        sourceType: 'daily'
      });
      
      expect(result.status).toBe('complete');
      expect(result.data.n).toBe(100);
      expect(result.data.k).toBe(15);
      expect(result.data.mean).toBeCloseTo(0.15, 2);
    });
    
    it('should return partial_data for missing slice', async () => {
      const windows: ParameterValue[] = [
        { sliceDSL: 'context(channel:meta)', n: 80, k: 12, mean: 0.15 }
      ];
      const variable = {
        id: 'test-var',
        windows
      };
      
      const { parseConstraints } = await import('../../lib/queryDSL');
      const constraints = parseConstraints('context(channel:google)');
      
      const result = await aggregateWindowsWithContexts({
        variable,
        constraints,
        sourceType: 'daily'
      });
      
      expect(result.status).toBe('partial_data');
      expect(result.data.n).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
    
    it('should aggregate uncontexted data when available', async () => {
      const windows: ParameterValue[] = [
        { sliceDSL: '', n: 200, k: 30, mean: 0.15 },  // Uncontexted
        { sliceDSL: 'context(channel:google)', n: 100, k: 15, mean: 0.15 }
      ];
      const variable = {
        id: 'test-var',
        windows
      };
      
      const { parseConstraints } = await import('../../lib/queryDSL');
      const constraints = parseConstraints('');  // No context
      
      const result = await aggregateWindowsWithContexts({
        variable,
        constraints,
        sourceType: 'daily'
      });
      
      expect(result.status).toBe('complete');
      expect(result.data.n).toBe(200);
      expect(result.data.k).toBe(30);
    });
  });
  
  describe('tryMECEAggregationAcrossContexts - Mixed MECE Test Case', () => {
    it('should aggregate across MECE key only, ignore non-MECE key', async () => {
      // Mock registry with MECE and non-MECE keys
      const meceMockContext: ContextDefinition = {
        id: 'browser_type',
        name: 'Browser Type',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'null',  // MECE
        values: [
          { id: 'chrome', label: 'Chrome' },
          { id: 'safari', label: 'Safari' },
          { id: 'firefox', label: 'Firefox' }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      const nonMeceMockContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'undefined',  // NOT MECE
        values: [
          { id: 'google', label: 'Google' },
          { id: 'meta', label: 'Meta' }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockImplementation(async (id: string) => {
        if (id === 'browser_type') return meceMockContext;
        if (id === 'channel') return nonMeceMockContext;
        return undefined;
      });
      
      const perContextResults: Array<{ n: number; k: number; contextCombo: ContextCombination }> = [
        // MECE key (browser-type) - complete
        { n: 100, k: 20, contextCombo: { 'browser_type': 'chrome' } },
        { n: 80, k: 12, contextCombo: { 'browser_type': 'safari' } },
        { n: 20, k: 2, contextCombo: { 'browser_type': 'firefox' } },
        
        // NON-MECE key (channel) - incomplete
        { n: 50, k: 8, contextCombo: { channel: 'google' } },
        { n: 30, k: 4, contextCombo: { channel: 'meta' } }
      ];
      
      const variable = { id: 'test-var', windows: [] as ParameterValue[] };
      
      const result = await tryMECEAggregationAcrossContexts(perContextResults, variable);
      
      // Should aggregate browser-type (200 total) NOT channel (which would be 280)
      expect(result.status).toBe('mece_aggregation');
      expect(result.data.n).toBe(200);  // chrome + safari + firefox
      expect(result.data.k).toBe(34);   // 20 + 12 + 2
      expect(result.warnings[0]).toContain('browser_type');
    });
  });
});

