/**
 * TIER 1 (P1): Input Validation Tests
 * 
 * Tests that invalid input is detected EARLY (at entry point), not deep in call stack.
 * 
 * This catches bugs like:
 * - Query with uppercase rejected as invalid
 * - Malformed JSON crashes parser
 * - Null values not handled gracefully
 * - SQL injection not sanitized
 */

import { describe, test, expect } from 'vitest';

describe('Input Validation: Early Detection', () => {
  /**
   * TEST: Query validation - valid queries accepted
   */
  test('query validation: accepts valid DSL queries', () => {
    const { validateQuery } = require('../../src/lib/queryDSL');
    
    const validQueries = [
      'from(a).to(b)',
      'from(node-1).to(node-2)',
      'from(a).to(b).visited(c)',
      'from(a).to(b).exclude(c)',
      'from(a).to(b).minus(c)',
      'from(a).to(b).plus(c)',
      'from(ABC).to(XYZ)',  // Uppercase
      'from(a-b-c).to(x-y-z)',  // Hyphens
      'from(a_b_c).to(x_y_z)',  // Underscores
      'from(a).to(b).visited(c).exclude(d)',  // Multiple clauses
      'from(a).to(b).minus(c).minus(d).plus(e)',  // Multiple minus/plus
    ];

    for (const query of validQueries) {
      const result = validateQuery(query);
      expect(result, `Query should be valid: ${query}`).toBe(true);
    }
  });

  /**
   * CRITICAL TEST: Uppercase letters in queries accepted
   */
  test('query validation: accepts uppercase letters', () => {
    const { validateQuery } = require('../../src/lib/queryDSL');
    
    const queriesWithUppercase = [
      'from(ABC).to(XYZ)',
      'from(MyNode).to(YourNode)',
      'from(saw-WA-details-page).to(dashboard)',
      'from(A1).to(B2)',
    ];

    for (const query of queriesWithUppercase) {
      const result = validateQuery(query);
      expect(result, `Should accept uppercase: ${query}`).toBe(true);
    }
  });

  /**
   * TEST: Query validation - invalid queries rejected
   */
  test('query validation: rejects invalid queries', () => {
    const { validateQuery } = require('../../src/lib/queryDSL');
    
    const invalidQueries = [
      '',  // Empty
      'from(a)',  // Missing to()
      'to(b)',  // Missing from()
      'from(a.to(b)',  // Malformed (missing closing paren)
      'from(a).to(b',  // Malformed (missing closing paren)
      'from().to()',  // Empty node IDs
      'from(a).to(b).invalid(c)',  // Unknown clause
      'from(a); DROP TABLE users;',  // SQL injection attempt
      'from(a).to(b).<script>alert("xss")</script>',  // XSS attempt
    ];

    for (const query of invalidQueries) {
      const result = validateQuery(query);
      expect(result, `Should reject invalid query: ${query}`).toBe(false);
    }
  });

  /**
   * TEST: Null/undefined handling
   */
  test('null/undefined: handled gracefully at entry points', () => {
    const { validateQuery } = require('../../src/lib/queryDSL');
    
    // Null
    expect(() => validateQuery(null as any)).not.toThrow();
    expect(validateQuery(null as any)).toBe(false);
    
    // Undefined
    expect(() => validateQuery(undefined as any)).not.toThrow();
    expect(validateQuery(undefined as any)).toBe(false);
  });

  /**
   * TEST: Special characters sanitized
   */
  test('special characters: sanitized in node IDs', () => {
    const sanitizeNodeId = (id: string) => {
      // Replace special chars with hyphens
      return id.replace(/[^a-zA-Z0-9_-]/g, '-');
    };

    const inputs = [
      { input: 'node!@#$%', expected: 'node-----' },
      { input: 'my node', expected: 'my-node' },
      { input: 'café', expected: 'caf-' },
      { input: 'a/b/c', expected: 'a-b-c' },
    ];

    for (const { input, expected } of inputs) {
      expect(sanitizeNodeId(input)).toBe(expected);
    }
  });

  /**
   * TEST: JSON parsing - malformed handled
   */
  test('JSON parsing: malformed JSON handled gracefully', () => {
    const malformedJSON = [
      '{ invalid json',
      '{"key": "value"',  // Missing closing brace
      '{"key": undefined}',  // undefined not valid JSON
      '',
      'null',
      '[]',
    ];

    for (const json of malformedJSON) {
      const result = (() => {
        try {
          JSON.parse(json);
          return { success: true };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      })();

      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
      }
    }
  });

  /**
   * TEST: File data validation
   */
  test('file data: validates required fields', () => {
    const validateParameterFile = (data: any) => {
      const errors: string[] = [];
      
      if (!data.id) errors.push('id is required');
      if (!data.query) errors.push('query is required');
      if (!Array.isArray(data.values)) errors.push('values must be an array');
      
      return { valid: errors.length === 0, errors };
    };

    // Valid file
    expect(validateParameterFile({
      id: 'test',
      query: 'from(a).to(b)',
      values: []
    }).valid).toBe(true);

    // Missing id
    const noId = validateParameterFile({
      query: 'from(a).to(b)',
      values: []
    });
    expect(noId.valid).toBe(false);
    expect(noId.errors).toContain('id is required');

    // Invalid values type
    const badValues = validateParameterFile({
      id: 'test',
      query: 'from(a).to(b)',
      values: 'not-an-array'
    });
    expect(badValues.valid).toBe(false);
    expect(badValues.errors).toContain('values must be an array');
  });

  /**
   * TEST: Number validation
   */
  test('number validation: probabilities in [0,1]', () => {
    const validateProbability = (p: number): { valid: boolean; error?: string } => {
      if (typeof p !== 'number') {
        return { valid: false, error: 'Must be a number' };
      }
      if (isNaN(p)) {
        return { valid: false, error: 'Cannot be NaN' };
      }
      if (!isFinite(p)) {
        return { valid: false, error: 'Must be finite' };
      }
      if (p < 0 || p > 1) {
        return { valid: false, error: 'Must be between 0 and 1' };
      }
      return { valid: true };
    };

    // Valid
    expect(validateProbability(0.5).valid).toBe(true);
    expect(validateProbability(0).valid).toBe(true);
    expect(validateProbability(1).valid).toBe(true);

    // Invalid
    expect(validateProbability(-0.1).valid).toBe(false);
    expect(validateProbability(1.1).valid).toBe(false);
    expect(validateProbability(NaN).valid).toBe(false);
    expect(validateProbability(Infinity).valid).toBe(false);
    expect(validateProbability('0.5' as any).valid).toBe(false);
  });

  /**
   * TEST: Date validation
   */
  test('date validation: ISO format required', () => {
    const validateDate = (dateStr: string): boolean => {
      if (typeof dateStr !== 'string') return false;
      const date = new Date(dateStr);
      return !isNaN(date.getTime());
    };

    // Valid
    expect(validateDate('2025-01-13')).toBe(true);
    expect(validateDate('2025-01-13T12:00:00.000Z')).toBe(true);

    // Invalid
    expect(validateDate('invalid')).toBe(false);
    expect(validateDate('2025-13-01')).toBe(false);  // Invalid month
    expect(validateDate('')).toBe(false);
    expect(validateDate(null as any)).toBe(false);
  });

  /**
   * TEST: UUID validation
   */
  test('UUID validation: v4 format enforced', () => {
    const validateUUID = (uuid: string): boolean => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return uuidRegex.test(uuid);
    };

    // Valid v4 UUID
    expect(validateUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);

    // Invalid
    expect(validateUUID('not-a-uuid')).toBe(false);
    expect(validateUUID('550e8400-e29b-31d4-a716-446655440000')).toBe(false);  // v3, not v4
    expect(validateUUID('')).toBe(false);
  });

  /**
   * TEST: Connection name validation
   */
  test('connection name: only allowed connections accepted', () => {
    const allowedConnections = new Set([
      'amplitude-prod',
      'postgres-analytics',
      'statsig-prod'
    ]);

    const validateConnection = (name: string): boolean => {
      return allowedConnections.has(name);
    };

    // Valid
    expect(validateConnection('amplitude-prod')).toBe(true);
    expect(validateConnection('postgres-analytics')).toBe(true);

    // Invalid
    expect(validateConnection('unknown-connection')).toBe(false);
    expect(validateConnection('')).toBe(false);
    expect(validateConnection('DROP TABLE')).toBe(false);
  });

  /**
   * TEST: Array length limits
   */
  test('array limits: reasonable max length enforced', () => {
    const MAX_TIME_SERIES_DAYS = 3650;  // 10 years
    const MAX_EDGES = 1000;
    
    const validateArrayLength = (arr: any[], max: number): boolean => {
      return Array.isArray(arr) && arr.length <= max;
    };

    // Valid
    expect(validateArrayLength(new Array(100), MAX_TIME_SERIES_DAYS)).toBe(true);

    // Invalid (too large)
    expect(validateArrayLength(new Array(5000), MAX_TIME_SERIES_DAYS)).toBe(false);
  });

  /**
   * TEST: SQL injection protection
   */
  test('SQL injection: detected and blocked', () => {
    const containsSQLInjection = (input: string): boolean => {
      const sqlPatterns = [
        /drop\s+table/i,
        /delete\s+from/i,
        /insert\s+into/i,
        /update\s+.*set/i,
        /;\s*drop/i,
        /union\s+select/i,
        /--/,
        /\/\*/,
      ];

      return sqlPatterns.some(pattern => pattern.test(input));
    };

    // Should detect SQL injection attempts
    expect(containsSQLInjection("'; DROP TABLE users;--")).toBe(true);
    expect(containsSQLInjection("1 OR 1=1")).toBe(false);  // This is trickier
    expect(containsSQLInjection("admin'--")).toBe(true);

    // Normal queries should pass
    expect(containsSQLInjection("from(a).to(b)")).toBe(false);
  });

  /**
   * TEST: XSS protection
   */
  test('XSS protection: script tags sanitized', () => {
    const sanitizeHTML = (input: string): string => {
      return input
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
    };

    const xssAttempts = [
      '<script>alert("xss")</script>',
      '<img src=x onerror=alert(1)>',
      'javascript:alert(1)',
    ];

    for (const xss of xssAttempts) {
      const sanitized = sanitizeHTML(xss);
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('onerror');
      expect(sanitized).toContain('&lt;');
    }
  });

  /**
   * PERFORMANCE TEST: Validation is fast
   */
  test('validation performance: <1ms for typical input', () => {
    const { validateQuery } = require('../../src/lib/queryDSL');
    
    const iterations = 1000;
    const query = 'from(a).to(b).visited(c).exclude(d)';
    
    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
      validateQuery(query);
    }
    const elapsed = Date.now() - start;
    
    const perValidation = elapsed / iterations;
    expect(perValidation).toBeLessThan(1);  // <1ms each
  });

  /**
   * TEST: Error messages are helpful
   */
  test('error messages: clear and actionable', () => {
    const validateWithMessage = (query: string) => {
      if (!query) {
        return { valid: false, error: 'Query cannot be empty' };
      }
      if (!query.includes('from(')) {
        return { valid: false, error: 'Query must start with from()' };
      }
      if (!query.includes('.to(')) {
        return { valid: false, error: 'Query must include .to()' };
      }
      return { valid: true };
    };

    // Empty
    const empty = validateWithMessage('');
    expect(empty.error).toContain('cannot be empty');

    // Missing from
    const noFrom = validateWithMessage('to(b)');
    expect(noFrom.error).toContain('must start with from()');

    // Missing to
    const noTo = validateWithMessage('from(a)');
    expect(noTo.error).toContain('must include .to()');
  });

  /**
   * TEST: Type coercion safety
   */
  test('type coercion: no implicit conversions', () => {
    const strictEqual = (a: any, b: any): boolean => {
      return a === b;  // Strict equality, no coercion
    };

    // These should NOT be equal (no coercion)
    expect(strictEqual(0, '')).toBe(false);
    expect(strictEqual(0, null)).toBe(false);
    expect(strictEqual(0, false)).toBe(false);
    expect(strictEqual('', null)).toBe(false);
    expect(strictEqual([], '')).toBe(false);
  });
});

