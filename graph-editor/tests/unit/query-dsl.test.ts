/**
 * Unit Tests: Query DSL Validation
 * 
 * Tests the bug fixes we made to query validation:
 * - Bug #19: Uppercase letters now accepted
 * - Bug #20: Minus/plus operators now accepted
 * - Malformed queries rejected
 */

import { describe, test, expect } from 'vitest';
import { QUERY_PATTERN } from '../../src/lib/queryDSL';

describe('Query DSL Validation', () => {
  describe('Valid Queries (Should Accept)', () => {
    test('basic from().to() query', () => {
      expect(QUERY_PATTERN.test('from(a).to(b)')).toBe(true);
    });

    test('query with hyphens in node IDs', () => {
      expect(QUERY_PATTERN.test('from(node-1).to(node-2)')).toBe(true);
      expect(QUERY_PATTERN.test('from(saw-WA-details-page).to(straight-to-dashboard)')).toBe(true);
    });

    test('query with underscores in node IDs', () => {
      expect(QUERY_PATTERN.test('from(node_1).to(node_2)')).toBe(true);
    });

    test('BUG #19 FIX: uppercase letters in node IDs', () => {
      // This used to fail before our fix!
      expect(QUERY_PATTERN.test('from(ABC).to(XYZ)')).toBe(true);
      expect(QUERY_PATTERN.test('from(MyNode).to(YourNode)')).toBe(true);
      expect(QUERY_PATTERN.test('from(saw-WA-details-page).to(dashboard)')).toBe(true);
      expect(QUERY_PATTERN.test('from(A1).to(B2)')).toBe(true);
    });

    test('query with visited() clause', () => {
      expect(QUERY_PATTERN.test('from(a).to(b).visited(c)')).toBe(true);
      expect(QUERY_PATTERN.test('from(a).to(b).visited(c).visited(d)')).toBe(true);
    });

    test('query with visitedAny() clause', () => {
      expect(QUERY_PATTERN.test('from(a).to(b).visitedAny(c)')).toBe(true);
    });

    test('query with exclude() clause', () => {
      expect(QUERY_PATTERN.test('from(a).to(b).exclude(c)')).toBe(true);
      expect(QUERY_PATTERN.test('from(a).to(b).visited(c).exclude(d)')).toBe(true);
    });

    test('BUG #20 FIX: minus() operator', () => {
      // This is for inclusion-exclusion queries
      expect(QUERY_PATTERN.test('from(a).to(b).minus(c)')).toBe(true);
      expect(QUERY_PATTERN.test('from(a).to(b).minus(c).minus(d)')).toBe(true);
    });

    test('BUG #20 FIX: plus() operator', () => {
      // This is for inclusion-exclusion queries
      expect(QUERY_PATTERN.test('from(a).to(b).plus(c)')).toBe(true);
      expect(QUERY_PATTERN.test('from(a).to(b).minus(c).plus(d)')).toBe(true);
    });

    test('query with context() clause', () => {
      expect(QUERY_PATTERN.test('from(a).to(b).context(cohort:test)')).toBe(true);
    });

    test('query with case() clause', () => {
      expect(QUERY_PATTERN.test('from(a).to(b).case(variant:A)')).toBe(true);
    });

    test('complex query with multiple clauses', () => {
      expect(QUERY_PATTERN.test('from(a).to(b).visited(c).visited(d).exclude(e)')).toBe(true);
      expect(QUERY_PATTERN.test('from(a).to(b).minus(c).minus(d).plus(e)')).toBe(true);
    });

    test('real-world query from our debugging', () => {
      // The actual query that was failing with uppercase!
      const query = 'from(saw-WA-details-page).to(straight-to-dashboard).minus(viewed-coffee-screen)';
      expect(QUERY_PATTERN.test(query)).toBe(true);
    });
  });

  describe('Invalid Queries (Should Reject)', () => {
    test('empty string', () => {
      expect(QUERY_PATTERN.test('')).toBe(false);
    });

    test('missing from()', () => {
      expect(QUERY_PATTERN.test('to(b)')).toBe(false);
    });

    test('missing to()', () => {
      expect(QUERY_PATTERN.test('from(a)')).toBe(false);
    });

    test('malformed - missing closing paren', () => {
      expect(QUERY_PATTERN.test('from(a).to(b')).toBe(false);
      expect(QUERY_PATTERN.test('from(a.to(b)')).toBe(false);
    });

    test('empty node IDs', () => {
      expect(QUERY_PATTERN.test('from().to()')).toBe(false);
    });

    test('unknown clause', () => {
      expect(QUERY_PATTERN.test('from(a).to(b).invalid(c)')).toBe(false);
    });

    test('wrong order (to before from) - regex accepts it', () => {
      // Note: The regex is permissive and doesn't enforce order
      // Semantic validation happens elsewhere
      expect(QUERY_PATTERN.test('to(b).from(a)')).toBe(true);
    });

    test('SQL injection attempt', () => {
      expect(QUERY_PATTERN.test("from(a); DROP TABLE users;")).toBe(false);
    });

    test('XSS attempt', () => {
      expect(QUERY_PATTERN.test('from(a).to(b).<script>alert("xss")</script>')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    test('numbers in node IDs', () => {
      expect(QUERY_PATTERN.test('from(node1).to(node2)')).toBe(true);
      expect(QUERY_PATTERN.test('from(123).to(456)')).toBe(true);
    });

    test('long node IDs', () => {
      const longId = 'a'.repeat(100);
      expect(QUERY_PATTERN.test(`from(${longId}).to(b)`)).toBe(true);
    });

    test('many clauses', () => {
      const manyVisited = Array.from({ length: 10 }, (_, i) => `.visited(node${i})`).join('');
      expect(QUERY_PATTERN.test(`from(a).to(b)${manyVisited}`)).toBe(true);
    });

    test('mixed case in node IDs', () => {
      expect(QUERY_PATTERN.test('from(AbCdEf).to(XyZ123)')).toBe(true);
    });
  });

  describe('Performance', () => {
    test('validation is fast (<1ms per query)', () => {
      const iterations = 1000;
      const query = 'from(a).to(b).visited(c).exclude(d)';
      
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        QUERY_PATTERN.test(query);
      }
      const elapsed = performance.now() - start;
      
      const perQuery = elapsed / iterations;
      expect(perQuery).toBeLessThan(1); // <1ms per validation
    });
  });
});

describe('Query DSL Pattern Coverage', () => {
  test('pattern matches actual production queries', () => {
    // These are real queries from our graph
    const productionQueries = [
      'from(household-created).to(household-delegated)',
      'from(household-delegated).to(saw-WA-details-page)',
      'from(saw-WA-details-page).to(viewed-coffee-screen)',
      'from(saw-WA-details-page).to(straight-to-dashboard).minus(viewed-coffee-screen)',
      'from(viewed-coffee-screen).to(gave-bds)',
    ];

    for (const query of productionQueries) {
      expect(QUERY_PATTERN.test(query), `Should accept: ${query}`).toBe(true);
    }
  });

  test('pattern has correct precedence', () => {
    // visited should come before exclude
    expect(QUERY_PATTERN.test('from(a).to(b).visited(c).exclude(d)')).toBe(true);
    
    // minus/plus should work in any order
    expect(QUERY_PATTERN.test('from(a).to(b).minus(c).plus(d)')).toBe(true);
    expect(QUERY_PATTERN.test('from(a).to(b).plus(c).minus(d)')).toBe(true);
  });
});

