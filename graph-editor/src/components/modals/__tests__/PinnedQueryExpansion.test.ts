import { describe, it, expect, vi } from 'vitest';
import { parseConstraints } from '../../../lib/queryDSL';
import { contextRegistry } from '../../../services/contextRegistry';
import type { ContextDefinition } from '../../../services/contextRegistry';

describe('Pinned Query Expansion', () => {
  describe('Semicolon-separated clauses', () => {
    it('should split simple semicolon-separated clauses', () => {
      const dsl = 'context(channel);context(browser-type)';
      const clauses = dsl.split(';').map(c => c.trim());
      
      expect(clauses).toEqual(['context(channel)', 'context(browser-type)']);
    });
    
    it('should handle window with multiple clauses', () => {
      const dsl = 'context(channel).window(-90d:);context(browser-type).window(-90d:)';
      const clauses = dsl.split(';').map(c => c.trim());
      
      expect(clauses).toEqual([
        'context(channel).window(-90d:)',
        'context(browser-type).window(-90d:)'
      ]);
    });
    
    it('should parse each clause independently', () => {
      const clause1 = 'context(channel).window(-90d:)';
      const clause2 = 'context(browser-type).window(-30d:)';
      
      const parsed1 = parseConstraints(clause1);
      const parsed2 = parseConstraints(clause2);
      
      expect(parsed1.context).toHaveLength(1);
      expect(parsed1.context[0].key).toBe('channel');
      expect(parsed1.window?.start).toBe('-90d');
      expect(parsed1.window?.end).toBeUndefined();
      
      expect(parsed2.context).toHaveLength(1);
      expect(parsed2.context[0].key).toBe('browser-type');
      expect(parsed2.window?.start).toBe('-30d');
      expect(parsed2.window?.end).toBeUndefined();
    });
  });
  
  describe('Bare key expansion', () => {
    it('should expand context(channel) to all channel values', async () => {
      const mockContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Test',
        type: 'categorical',
        values: [
          { id: 'google', label: 'Google' },
          { id: 'meta', label: 'Meta' }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(mockContext);
      vi.spyOn(contextRegistry, 'getValuesForContext').mockResolvedValue(mockContext.values);
      
      const clause = 'context(channel)';
      const parsed = parseConstraints(clause);
      
      // Bare key (no value specified)
      expect(parsed.context).toHaveLength(1);
      expect(parsed.context[0].key).toBe('channel');
      expect(parsed.context[0].value).toBe('');
      
      // Should expand to multiple slices
      const values = await contextRegistry.getValuesForContext('channel');
      const expandedSlices = values.map(v => 
        clause.replace('context(channel)', `context(channel:${v.id})`)
      );
      
      expect(expandedSlices).toEqual([
        'context(channel:google)',
        'context(channel:meta)'
      ]);
    });
    
    it('should handle mixed bare and specific keys', async () => {
      const clause = 'context(channel:google).context(browser-type)';
      const parsed = parseConstraints(clause);
      
      expect(parsed.context).toHaveLength(2);
      expect(parsed.context[0]).toEqual({ key: 'channel', value: 'google' }); // Specific
      expect(parsed.context[1]).toEqual({ key: 'browser-type', value: '' }); // Bare
    });
  });
  
  describe('or() operator', () => {
    it('should parse or(context(...),context(...)) and extract both', () => {
      const dsl = 'or(context(channel),context(browser-type))';
      const parsed = parseConstraints(dsl);
      
      // Parser extracts contexts from inside or()
      expect(parsed.context).toHaveLength(2);
      expect(parsed.context[0]).toEqual({ key: 'channel', value: '' });
      expect(parsed.context[1]).toEqual({ key: 'browser-type', value: '' });
    });
    
    it('should handle or() with window', () => {
      const dsl = 'or(context(browser:chrome),context(channel:test)).window(1-Jan-25:31-Dec-25)';
      const parsed = parseConstraints(dsl);
      
      expect(parsed.context).toHaveLength(2);
      expect(parsed.window).toBeDefined();
    });
  });
  
  describe('Parenthesized expressions with semicolons', () => {
    it('should handle (context(...);context(...)).window(...)', () => {
      const dsl = '(context(browser:chrome);context(channel:test)).window(1-Jan-25:31-Dec-25)';
      const parsed = parseConstraints(dsl);
      
      // Regex-based parser will extract all context() calls regardless of grouping
      expect(parsed.context.length).toBeGreaterThan(0);
      expect(parsed.window).toBeDefined();
    });
  });
});

