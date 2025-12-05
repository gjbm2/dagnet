/**
 * Unit Tests: Composite Query Parser
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPRECATED: 4-Dec-25
 * 
 * These tests cover the minus()/plus() parser which was used for inclusion-
 * exclusion queries when Amplitude didn't support native excludes.
 * 
 * As of 4-Dec-25, Amplitude supports native exclude via segment filters.
 * The parser remains functional for non-Amplitude providers, but this code
 * path will NOT be triggered for Amplitude queries.
 * 
 * Tests remain valid to ensure parser works for fallback scenarios.
 * Target deletion: After 2 weeks of production validation.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests the composite query parser that handles minus()/plus() operators
 * for inclusion-exclusion principle.
 * 
 * Bug fixed: Parser now accepts uppercase letters in node IDs
 */

import { describe, test, expect } from 'vitest';
import { parseCompositeQuery, isCompositeQuery } from '../../src/lib/das/compositeQueryParser';

describe('Composite Query Parser', () => {
  describe('Simple Queries (No minus/plus)', () => {
    test('basic from().to() query', () => {
      const result = parseCompositeQuery('from(a).to(b)');
      
      expect(isCompositeQuery('from(a).to(b)')).toBe(false);
      expect(result.base.from).toBe('a');
      expect(result.base.to).toBe('b');
      expect(result.minusTerms).toHaveLength(0);
      expect(result.plusTerms).toHaveLength(0);
    });

    test('query with visited()', () => {
      const result = parseCompositeQuery('from(a).to(b).visited(c)');
      
      expect(isCompositeQuery('from(a).to(b).visited(c)')).toBe(false);
      expect(result.base.from).toBe('a');
      expect(result.base.to).toBe('b');
      expect(result.base.visited).toEqual(['c']);
    });
  });

  describe('Composite Queries (With minus/plus)', () => {
    test('single minus() term', () => {
      const queryString = 'from(a).to(b).minus(c)';
      const result = parseCompositeQuery(queryString);
      
      expect(isCompositeQuery(queryString)).toBe(true);
      expect(result.base.from).toBe('a');
      expect(result.base.to).toBe('b');
      expect(result.minusTerms).toHaveLength(1);
      expect(result.minusTerms[0]).toEqual(['c']);
      expect(result.plusTerms).toHaveLength(0);
    });

    test('multiple minus() terms', () => {
      const queryString = 'from(a).to(b).minus(c).minus(d)';
      const result = parseCompositeQuery(queryString);
      
      expect(isCompositeQuery(queryString)).toBe(true);
      expect(result.minusTerms).toHaveLength(2);
      expect(result.minusTerms[0]).toEqual(['c']);
      expect(result.minusTerms[1]).toEqual(['d']);
    });

    test('single plus() term', () => {
      const queryString = 'from(a).to(b).plus(c)';
      const result = parseCompositeQuery(queryString);
      
      expect(isCompositeQuery(queryString)).toBe(true);
      expect(result.plusTerms).toHaveLength(1);
      expect(result.plusTerms[0]).toEqual(['c']);
      expect(result.minusTerms).toHaveLength(0);
    });

    test('mixed minus() and plus() terms', () => {
      const queryString = 'from(a).to(b).minus(c).plus(d)';
      const result = parseCompositeQuery(queryString);
      
      expect(isCompositeQuery(queryString)).toBe(true);
      expect(result.minusTerms).toHaveLength(1);
      expect(result.minusTerms[0]).toEqual(['c']);
      expect(result.plusTerms).toHaveLength(1);
      expect(result.plusTerms[0]).toEqual(['d']);
    });
  });

  describe('Real-World Queries', () => {
    test('BUG FIX: query with uppercase and hyphens', () => {
      // This was the actual failing query!
      const query = 'from(saw-WA-details-page).to(straight-to-dashboard).minus(viewed-coffee-screen)';
      const result = parseCompositeQuery(query);
      
      expect(isCompositeQuery(query)).toBe(true);
      expect(result.base.from).toBe('saw-WA-details-page');
      expect(result.base.to).toBe('straight-to-dashboard');
      expect(result.minusTerms).toHaveLength(1);
      expect(result.minusTerms[0]).toEqual(['viewed-coffee-screen']);
    });

    test('query with visited() before minus()', () => {
      const result = parseCompositeQuery('from(a).to(b).visited(c).minus(d)');
      
      expect(result.base.from).toBe('a');
      expect(result.base.to).toBe('b');
      expect(result.base.visited).toEqual(['c']);
      expect(result.minusTerms[0]).toEqual(['d']);
    });
  });

  describe('Node IDs with Special Characters', () => {
    test('BUG FIX: uppercase in node IDs', () => {
      const result = parseCompositeQuery('from(ABC).to(XYZ).minus(DEF)');
      
      expect(result.base.from).toBe('ABC');
      expect(result.base.to).toBe('XYZ');
      expect(result.minusTerms[0]).toEqual(['DEF']);
    });

    test('mixed case in node IDs', () => {
      const result = parseCompositeQuery('from(MyNode).to(YourNode).minus(TheirNode)');
      
      expect(result.minusTerms[0]).toEqual(['TheirNode']);
    });

    test('numbers in node IDs', () => {
      const result = parseCompositeQuery('from(node1).to(node2).minus(node3)');
      
      expect(result.minusTerms[0]).toEqual(['node3']);
    });
  });

  describe('isCompositeQuery Helper', () => {
    test('identifies composite queries correctly', () => {
      expect(isCompositeQuery('from(a).to(b)')).toBe(false);
      expect(isCompositeQuery('from(a).to(b).visited(c)')).toBe(false);
      expect(isCompositeQuery('from(a).to(b).minus(c)')).toBe(true);
      expect(isCompositeQuery('from(a).to(b).plus(c)')).toBe(true);
      expect(isCompositeQuery('from(a).to(b).minus(c).plus(d)')).toBe(true);
    });

    test('works with uppercase letters', () => {
      expect(isCompositeQuery('from(ABC).to(XYZ).minus(DEF)')).toBe(true);
    });
  });

  describe('Parser Structure', () => {
    test('base is a ParsedFunnel object', () => {
      const result = parseCompositeQuery('from(a).to(b)');
      
      expect(result.base).toHaveProperty('from');
      expect(result.base).toHaveProperty('to');
      expect(typeof result.base).toBe('object');
    });

    test('minusTerms are arrays of node lists', () => {
      const result = parseCompositeQuery('from(a).to(b).minus(c)');
      
      expect(Array.isArray(result.minusTerms)).toBe(true);
      expect(Array.isArray(result.minusTerms[0])).toBe(true);
    });

    test('supports comma-separated nodes in minus/plus', () => {
      const result = parseCompositeQuery('from(a).to(b).minus(c,d,e)');
      
      expect(result.minusTerms).toHaveLength(1);
      expect(result.minusTerms[0]).toEqual(['c', 'd', 'e']);
    });
  });

  describe('Edge Cases', () => {
    test('handles multiple visited() clauses', () => {
      const result = parseCompositeQuery('from(a).to(b).visited(c).visited(d)');
      
      expect(result.base.visited).toEqual(['c', 'd']);
    });

    test('preserves base visited when adding minus', () => {
      const result = parseCompositeQuery('from(a).to(b).visited(c).minus(d)');
      
      expect(result.base.visited).toEqual(['c']);
      expect(result.minusTerms[0]).toEqual(['d']);
    });
  });
});

describe('Composite Query Parser: Inclusion-Exclusion Semantics', () => {
  test('minus() represents visited node exclusion', () => {
    // from(a).to(b).minus(c) means:
    // "Paths from a to b, MINUS paths that visited c"
    const result = parseCompositeQuery('from(a).to(b).minus(c)');
    
    expect(result.base.from).toBe('a');
    expect(result.base.to).toBe('b');
    expect(result.minusTerms).toHaveLength(1);
    expect(result.minusTerms[0]).toContain('c');
  });

  test('multiple minus() terms for complex exclusion', () => {
    const result = parseCompositeQuery('from(a).to(b).minus(c).minus(d)');
    
    expect(result.minusTerms).toHaveLength(2);
    expect(result.minusTerms[0]).toEqual(['c']);
    expect(result.minusTerms[1]).toEqual(['d']);
  });

  test('plus() represents intersection correction', () => {
    // Used to correct for double-subtraction in inclusion-exclusion
    const result = parseCompositeQuery('from(a).to(b).minus(c).minus(d).plus(e)');
    
    expect(result.minusTerms).toHaveLength(2);
    expect(result.plusTerms).toHaveLength(1);
  });
});

describe('Composite Query Parser: Performance', () => {
  test('parses simple queries quickly', () => {
    const iterations = 1000;
    const query = 'from(a).to(b).minus(c)';
    
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      parseCompositeQuery(query);
    }
    const elapsed = performance.now() - start;
    
    const perParse = elapsed / iterations;
    expect(perParse).toBeLessThan(1); // <1ms per parse
  });

  test('parses complex queries quickly', () => {
    const query = 'from(a).to(b).visited(c).visited(d).minus(e).minus(f).plus(g)';
    
    const start = performance.now();
    const result = parseCompositeQuery(query);
    const elapsed = performance.now() - start;
    
    expect(elapsed).toBeLessThan(50); // Should be fast (no I/O)
    expect(result.base.visited).toEqual(['c', 'd']);
    expect(result.minusTerms).toHaveLength(2);
    expect(result.plusTerms).toHaveLength(1);
  });
});
