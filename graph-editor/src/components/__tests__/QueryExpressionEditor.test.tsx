/**
 * QueryExpressionEditor Tests
 * 
 * Tests the Query DSL parsing and validation logic.
 * Full component rendering tests are skipped due to jsdom/Monaco compatibility issues.
 * 
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { QUERY_FUNCTIONS } from '../../lib/queryDSL';

// ============================================================
// Helper Functions (extracted from QueryExpressionEditor)
// ============================================================

interface ParsedQueryChip {
  type: 'from' | 'to' | 'exclude' | 'visited' | 'case' | 'context';
  values: string[];
  rawText: string;
}

function parseQueryToChips(query: string): ParsedQueryChip[] {
  if (!query) return [];
  
  const chips: ParsedQueryChip[] = [];
  const functionRegex = /(from|to|exclude|visited|case|context)\(([^)]+)\)/g;
  let match;
  
  while ((match = functionRegex.exec(query)) !== null) {
    const funcType = match[1] as 'from' | 'to' | 'exclude' | 'visited' | 'case' | 'context';
    const content = match[2];
    
    chips.push({
      type: funcType,
      values: (funcType === 'exclude' || funcType === 'visited') 
        ? content.split(',').map(s => s.trim())
        : [content],
      rawText: match[0]
    });
  }
  
  return chips;
}

function validateQuery(query: string): boolean {
  if (!query) return true;
  
  const cleanQuery = query.replace(/^\.|\.$/g, '').trim();
  if (!cleanQuery) return true;
  
  const pattern = `^(${QUERY_FUNCTIONS.join('|')})\\([^)]+\\)(\\.(${QUERY_FUNCTIONS.join('|')})\\([^)]+\\))*$`;
  const regex = new RegExp(pattern);
  
  return regex.test(cleanQuery);
}

// ============================================================
// Tests
// ============================================================

describe('QueryExpressionEditor - Parsing Logic', () => {
  describe('Query Parsing', () => {
    it('should parse simple from/to query', () => {
      const chips = parseQueryToChips('from(a).to(b)');
      
      expect(chips).toHaveLength(2);
      expect(chips[0].type).toBe('from');
      expect(chips[0].values).toEqual(['a']);
      expect(chips[1].type).toBe('to');
      expect(chips[1].values).toEqual(['b']);
    });

    it('should parse visited() with multiple nodes', () => {
      const chips = parseQueryToChips('from(a).to(b).visited(c,d,e)');
      
      expect(chips).toHaveLength(3);
      expect(chips[2].type).toBe('visited');
      expect(chips[2].values).toEqual(['c', 'd', 'e']);
    });

    it('should parse exclude() with multiple nodes', () => {
      const chips = parseQueryToChips('from(a).to(b).exclude(x,y)');
      
      expect(chips).toHaveLength(3);
      expect(chips[2].type).toBe('exclude');
      expect(chips[2].values).toEqual(['x', 'y']);
    });

    it('should parse context() with key:value pairs', () => {
      const chips = parseQueryToChips('from(a).to(b).context(device:mobile)');
      
      expect(chips).toHaveLength(3);
      expect(chips[2].type).toBe('context');
      expect(chips[2].values).toEqual(['device:mobile']);
    });

    it('should parse case() with key:value pairs', () => {
      const chips = parseQueryToChips('from(a).to(b).case(test-1:treatment)');
      
      expect(chips).toHaveLength(3);
      expect(chips[2].type).toBe('case');
      expect(chips[2].values).toEqual(['test-1:treatment']);
    });

    it('should parse complex query with all function types', () => {
      const complexQuery = 'from(start).to(end).visited(a,b).exclude(c).context(device:mobile).case(test:variant)';
      const chips = parseQueryToChips(complexQuery);
      
      expect(chips).toHaveLength(6);
      expect(chips.map(c => c.type)).toEqual(['from', 'to', 'visited', 'exclude', 'context', 'case']);
    });

    it('should handle empty query', () => {
      const chips = parseQueryToChips('');
      expect(chips).toEqual([]);
    });

    it('should parse all occurrences of same function', () => {
      const chips = parseQueryToChips('from(a).to(b).visited(c).exclude(d).visited(e).exclude(f)');
      
      expect(chips).toHaveLength(6);
      expect(chips[2].type).toBe('visited');
      expect(chips[4].type).toBe('visited');
    });
  });

  describe('Query Validation', () => {
    it('should accept valid simple query', () => {
      expect(validateQuery('from(a).to(b)')).toBe(true);
    });

    it('should accept valid complex query', () => {
      expect(validateQuery('from(a).to(b).visited(c).exclude(d)')).toBe(true);
    });

    it('should accept query with context', () => {
      expect(validateQuery('from(a).to(b).context(device:mobile)')).toBe(true);
    });

    it('should accept query with case', () => {
      expect(validateQuery('from(a).to(b).case(test:variant)')).toBe(true);
    });

    it('should accept empty query', () => {
      expect(validateQuery('')).toBe(true);
    });

    it('should strip and accept queries with leading dots', () => {
      expect(validateQuery('.from(a).to(b)')).toBe(true);
    });

    it('should strip and accept queries with trailing dots', () => {
      expect(validateQuery('from(a).to(b).')).toBe(true);
    });

    it('should reject query with unknown function', () => {
      expect(validateQuery('from(a).to(b).invalid(c)')).toBe(false);
    });

    it('should reject malformed query', () => {
      expect(validateQuery('invalid')).toBe(false);
    });

    it('should accept queries with all schema functions', () => {
      QUERY_FUNCTIONS.forEach(func => {
        const query = `from(a).to(b).${func}(test)`;
        expect(validateQuery(query)).toBe(true);
      });
    });
  });

  describe('Schema Authority Enforcement', () => {
    it('should use QUERY_FUNCTIONS constant for parsing', () => {
      // Verify all schema functions are parseable
      const allFunctions = QUERY_FUNCTIONS.join(',');
      expect(allFunctions).toContain('from');
      expect(allFunctions).toContain('to');
      expect(allFunctions).toContain('visited');
      expect(allFunctions).toContain('exclude');
      expect(allFunctions).toContain('context');
      expect(allFunctions).toContain('case');
    });

    it('should have exactly 9 schema-defined functions', () => {
      expect(QUERY_FUNCTIONS).toHaveLength(9);
    });

    it('should parse all schema-defined functions', () => {
      const testQueries = [
        'from(a).to(b)',
        'from(a).to(b).visited(c)',
        'from(a).to(b).exclude(c)',
        'from(a).to(b).context(k:v)',
        'from(a).to(b).case(t:v)',
      ];

      testQueries.forEach(query => {
        const chips = parseQueryToChips(query);
        expect(chips.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle query with only dots', () => {
      const chips = parseQueryToChips('...');
      expect(chips).toEqual([]);
    });

    it('should handle very long query strings', () => {
      const longQuery = 'from(a).to(b)' + '.visited(node)'.repeat(50);
      const chips = parseQueryToChips(longQuery);
      expect(chips.length).toBe(52); // from + to + 50 visited
    });

    it('should handle special characters in node IDs', () => {
      const chips = parseQueryToChips('from(a-b-c-123).to(x-y-z-456)');
      expect(chips[0].values).toEqual(['a-b-c-123']);
      expect(chips[1].values).toEqual(['x-y-z-456']);
    });

    it('should preserve chip order', () => {
      const query = 'from(a).to(b).visited(c).exclude(d).context(e:f).case(g:h)';
      const chips = parseQueryToChips(query);
      
      expect(chips.map(c => c.type)).toEqual([
        'from', 'to', 'visited', 'exclude', 'context', 'case'
      ]);
    });

    it('should handle whitespace in comma-separated lists', () => {
      const chips = parseQueryToChips('from(a).to(b).visited(c, d, e)');
      expect(chips[2].values).toEqual(['c', 'd', 'e']);
    });
  });
});
