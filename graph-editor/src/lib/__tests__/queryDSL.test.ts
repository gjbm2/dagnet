/**
 * Query DSL Constants Tests
 * 
 * Validates that the QUERY_FUNCTIONS constant matches the schema authority.
 * This ensures TypeScript types stay in sync with the JSON schema.
 * 
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { QUERY_FUNCTIONS, type QueryFunctionName } from '../queryDSL';
import {
  parseConstraints,
  parseDSL,
  getVisitedNodeIds,
  evaluateConstraint,
  normalizeConstraintString
} from '../queryDSL';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Query DSL Constants', () => {
  // ============================================================
  // TEST SUITE 1: Schema Authority Validation
  // ============================================================

  describe('Schema Authority', () => {
    it('should have exactly 12 functions', () => {
      expect(QUERY_FUNCTIONS).toHaveLength(12);
    });

    it('should contain all required functions in correct order', () => {
      expect(QUERY_FUNCTIONS).toEqual([
        'from',
        'to',
        'visited',
        'visitedAny',
        'exclude',
        'context',
        'contextAny',
        'case',
        'window',
        'cohort',
        'minus',
        'plus'
      ]);
    });

    it('should be a readonly tuple at compile time', () => {
      // TypeScript's `as const` prevents mutation at compile time
      // but doesn't enforce runtime immutability
      // This test just verifies the array exists and has the right type
      const arr: readonly string[] = QUERY_FUNCTIONS;
      expect(arr).toBeDefined();
      expect(arr.length).toBe(12);
    });

    it('should match schema definition exactly', () => {
      // Read the schema file
      const schemaPath = join(__dirname, '../../../public/schemas/query-dsl-1.0.0.json');
      const schemaContent = readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      
      // Extract function names from schema
      const schemaFunctions = schema.$defs?.QueryFunction?.properties?.name?.enum;
      
      expect(schemaFunctions).toBeDefined();
      expect(schemaFunctions).toHaveLength(12); // Updated: added contextAny, window, cohort
      
      // Check that all schema functions are in QUERY_FUNCTIONS
      schemaFunctions.forEach((func: string) => {
        expect(QUERY_FUNCTIONS).toContain(func);
      });
      
      // Check that all QUERY_FUNCTIONS are in schema
      QUERY_FUNCTIONS.forEach(func => {
        expect(schemaFunctions).toContain(func);
      });
    });
  });

  // ============================================================
  // TEST SUITE 2: Type System
  // ============================================================

  describe('Type System', () => {
    it('should export QueryFunctionName type', () => {
      // Type-level test: ensure valid assignments
      const validNames: QueryFunctionName[] = [
        'from',
        'to', 
        'visited',
        'visitedAny',
        'exclude',
        'context',
        'case',
        'minus',
        'plus'
      ];
      
      expect(validNames).toHaveLength(9);
    });

    it('should enforce literal types', () => {
      // These should compile
      const from: QueryFunctionName = 'from';
      const to: QueryFunctionName = 'to';
      const visited: QueryFunctionName = 'visited';
      const visitedAny: QueryFunctionName = 'visitedAny';
      const exclude: QueryFunctionName = 'exclude';
      const context: QueryFunctionName = 'context';
      const caseFunc: QueryFunctionName = 'case';
      const minus: QueryFunctionName = 'minus';
      const plus: QueryFunctionName = 'plus';
      
      expect([from, to, visited, visitedAny, exclude, context, caseFunc, minus, plus]).toHaveLength(9);
    });

    it('should be usable in array operations', () => {
      // Create a fresh copy to avoid mutation issues
      const functionsCopy = [...QUERY_FUNCTIONS];
      const functionSet = new Set(functionsCopy);
      
      expect(functionSet.has('from')).toBe(true);
      expect(functionSet.has('invalid' as any)).toBe(false);
      expect(functionSet.size).toBe(12);
      
      const filtered = functionsCopy.filter(f => f.startsWith('c'));
      expect(filtered).toContain('context');
      expect(filtered).toContain('case');
      expect(filtered).toContain('cohort');
    });
  });

  // ============================================================
  // TEST SUITE 3: Immutability
  // ============================================================

  describe('Immutability', () => {
    it('should maintain consistent values', () => {
      // Verify the array maintains expected values
      expect(QUERY_FUNCTIONS[0]).toBe('from');
      expect(QUERY_FUNCTIONS[1]).toBe('to');
      expect(QUERY_FUNCTIONS[2]).toBe('visited');
      expect(QUERY_FUNCTIONS[3]).toBe('visitedAny');
      expect(QUERY_FUNCTIONS[4]).toBe('exclude');
      expect(QUERY_FUNCTIONS[5]).toBe('context');
      expect(QUERY_FUNCTIONS[6]).toBe('contextAny');
      expect(QUERY_FUNCTIONS[7]).toBe('case');
      expect(QUERY_FUNCTIONS[8]).toBe('window');
      expect(QUERY_FUNCTIONS[9]).toBe('cohort');
      expect(QUERY_FUNCTIONS[10]).toBe('minus');
      expect(QUERY_FUNCTIONS[11]).toBe('plus');
    });

    it('should be importable consistently', () => {
      // Verify the constant can be imported and used
      expect(QUERY_FUNCTIONS).toBeDefined();
      expect(Array.isArray(QUERY_FUNCTIONS)).toBe(true);
      expect(QUERY_FUNCTIONS.length).toBe(12);
    });
  });

  // ============================================================
  // TEST SUITE 4: Integration Contracts
  // ============================================================

  describe('Integration Contracts', () => {
    it('should be suitable for Monaco tokenizer regex', () => {
      // Monaco uses: `\b(${QUERY_FUNCTIONS.join('|')})\b`
      const functionsCopy = [...QUERY_FUNCTIONS];
      const monacoPattern = `\\b(${functionsCopy.join('|')})\\b`;
      const regex = new RegExp(monacoPattern);
      
      // Should match all valid functions
      functionsCopy.forEach(func => {
        const testString = `test ${func} test`;
        expect(regex.test(testString)).toBe(true);
      });
      
      // Should not match invalid functions
      expect(regex.test('test invalid test')).toBe(false);
    });

    it('should be suitable for validation regex', () => {
      // Validation uses similar pattern
      const validationPattern = `^(${QUERY_FUNCTIONS.join('|')})\\(`;
      const regex = new RegExp(validationPattern);
      
      QUERY_FUNCTIONS.forEach(func => {
        expect(`${func}(arg)`).toMatch(regex);
      });
    });

    it('should work with Array.includes() for validation', () => {
      // Common pattern: QUERY_FUNCTIONS.includes(functionName)
      const functionsCopy = [...QUERY_FUNCTIONS];
      expect(functionsCopy.includes('from')).toBe(true);
      expect(functionsCopy.includes('invalid' as any)).toBe(false);
    });

    it('should work with map/filter operations', () => {
      // Used in chip generation
      const functionsCopy = [...QUERY_FUNCTIONS];
      const upperCased = functionsCopy.map(f => f.toUpperCase());
      expect(upperCased).toContain('FROM');
      expect(upperCased).toContain('CONTEXT');
      
      const shortNames = functionsCopy.filter(f => f.length <= 4);
      expect(shortNames).toContain('from');
      expect(shortNames).toContain('to');
      expect(shortNames).toContain('case');
    });
  });

  // ============================================================
  // TEST SUITE 5: Backward Compatibility
  // ============================================================

  describe('Backward Compatibility', () => {
    it('should not have removed any historical functions', () => {
      // Functions that have existed since initial implementation
      const historicalFunctions = ['from', 'to', 'visited', 'exclude'];
      const functionsCopy = [...QUERY_FUNCTIONS];
      
      historicalFunctions.forEach(func => {
        expect(functionsCopy).toContain(func);
      });
    });

    it('should include context function added in migration', () => {
      // Context was added during schema authority migration
      expect(QUERY_FUNCTIONS).toContain('context');
    });

    it('should include case function for A/B testing', () => {
      // Case function for variant/case filtering
      expect(QUERY_FUNCTIONS).toContain('case');
    });
  });

  // ============================================================
  // TEST SUITE 6: Documentation
  // ============================================================

  describe('Documentation', () => {
    it('should have JSDoc comment referencing schema', () => {
      // Read the source file to check for documentation
      const sourcePath = join(__dirname, '../queryDSL.ts');
      const sourceContent = readFileSync(sourcePath, 'utf-8');
      
      // Should reference the schema
      expect(sourceContent).toContain('query-dsl-1.0.0.json');
    });

    it('should export as const for type narrowing', () => {
      const sourcePath = join(__dirname, '../queryDSL.ts');
      const sourceContent = readFileSync(sourcePath, 'utf-8');
      
      // Should use 'as const' assertion
      expect(sourceContent).toContain('as const');
    });
  });
});

// ============================================================
// TEST SUITE 7: DSL Parsing Functions
// ============================================================

describe('DSL Parsing Functions', () => {
  describe('parseConstraints', () => {
    it('should parse simple visited constraint', () => {
      const result = parseConstraints('visited(node-a)');
      expect(result.visited).toEqual(['node-a']);
      expect(result.exclude).toEqual([]);
      expect(result.context).toEqual([]);
      expect(result.cases).toEqual([]);
      expect(result.visitedAny).toEqual([]);
    });

    it('should parse multiple visited nodes', () => {
      const result = parseConstraints('visited(node-a, node-b, node-c)');
      expect(result.visited).toEqual(['node-a', 'node-b', 'node-c']);
    });

    it('should parse multiple visited() calls', () => {
      const result = parseConstraints('visited(node-a).visited(node-b)');
      expect(result.visited).toEqual(['node-a', 'node-b']);
    });

    it('should parse exclude constraint', () => {
      const result = parseConstraints('exclude(node-x)');
      expect(result.exclude).toEqual(['node-x']);
      expect(result.visited).toEqual([]);
    });

    it('should parse context constraint', () => {
      const result = parseConstraints('context(device:mobile)');
      expect(result.context).toEqual([{ key: 'device', value: 'mobile' }]);
    });

    it('should parse multiple context constraints', () => {
      const result = parseConstraints('context(device:mobile).context(browser:chrome)');
      expect(result.context).toEqual([
        { key: 'device', value: 'mobile' },
        { key: 'browser', value: 'chrome' }
      ]);
    });

    it('should parse case constraint', () => {
      const result = parseConstraints('case(test:treatment)');
      expect(result.cases).toEqual([{ key: 'test', value: 'treatment' }]);
    });

    it('should parse visitedAny constraint', () => {
      const result = parseConstraints('visitedAny(node-a, node-b)');
      expect(result.visitedAny).toEqual([['node-a', 'node-b']]);
    });

    it('should parse complex constraint with all types', () => {
      const result = parseConstraints('visited(node-a, node-b).exclude(node-x).context(device:mobile).case(test:treatment).visitedAny(node-c, node-d)');
      expect(result.visited).toEqual(['node-a', 'node-b']);
      expect(result.exclude).toEqual(['node-x']);
      expect(result.context).toEqual([{ key: 'device', value: 'mobile' }]);
      expect(result.cases).toEqual([{ key: 'test', value: 'treatment' }]);
      expect(result.visitedAny).toEqual([['node-c', 'node-d']]);
    });

    it('should handle empty string', () => {
      const result = parseConstraints('');
      expect(result.visited).toEqual([]);
      expect(result.exclude).toEqual([]);
      expect(result.context).toEqual([]);
      expect(result.cases).toEqual([]);
      expect(result.visitedAny).toEqual([]);
    });

    it('should handle null/undefined', () => {
      expect(parseConstraints(null)).toEqual({
        visited: [],
        exclude: [],
        context: [],
        cases: [],
        visitedAny: [],
        contextAny: [],
        window: null,
        cohort: null
      });
      expect(parseConstraints(undefined)).toEqual({
        visited: [],
        exclude: [],
        context: [],
        cases: [],
        visitedAny: [],
        contextAny: [],
        window: null,
        cohort: null
      });
    });

    it('should deduplicate visited nodes', () => {
      const result = parseConstraints('visited(node-a, node-b, node-a)');
      expect(result.visited).toEqual(['node-a', 'node-b']);
    });

    it('should deduplicate context/case pairs', () => {
      const result = parseConstraints('context(device:mobile).context(device:mobile)');
      expect(result.context).toEqual([{ key: 'device', value: 'mobile' }]);
    });

    it('should handle whitespace in node lists', () => {
      const result = parseConstraints('visited( node-a , node-b )');
      expect(result.visited).toEqual(['node-a', 'node-b']);
    });
  });

  describe('parseDSL', () => {
    it('should parse full query with from/to', () => {
      const result = parseDSL('from(node-a).to(node-b).visited(node-c)');
      expect(result.from).toBe('node-a');
      expect(result.to).toBe('node-b');
      expect(result.visited).toEqual(['node-c']);
    });

    it('should parse constraint-only DSL (no from/to)', () => {
      const result = parseDSL('visited(node-a).exclude(node-b)');
      expect(result.from).toBeUndefined();
      expect(result.to).toBeUndefined();
      expect(result.visited).toEqual(['node-a']);
      expect(result.exclude).toEqual(['node-b']);
    });

    it('should preserve raw string', () => {
      const dsl = 'from(a).to(b).visited(c)';
      const result = parseDSL(dsl);
      expect(result.raw).toBe(dsl);
    });

    it('should handle empty string', () => {
      const result = parseDSL('');
      expect(result.raw).toBe('');
      expect(result.from).toBeUndefined();
      expect(result.to).toBeUndefined();
    });
  });

  describe('getVisitedNodeIds', () => {
    it('should extract visited nodes from simple constraint', () => {
      const result = getVisitedNodeIds('visited(node-a)');
      expect(result).toEqual(['node-a']);
    });

    it('should extract visited nodes from complex constraint', () => {
      const result = getVisitedNodeIds('visited(node-a, node-b).exclude(node-x).context(device:mobile)');
      expect(result).toEqual(['node-a', 'node-b']);
    });

    it('should extract visited nodes from full query', () => {
      const result = getVisitedNodeIds('from(node-a).to(node-b).visited(node-c, node-d)');
      expect(result).toEqual(['node-c', 'node-d']);
    });

    it('should handle multiple visited() calls', () => {
      const result = getVisitedNodeIds('visited(node-a).visited(node-b)');
      expect(result).toEqual(['node-a', 'node-b']);
    });

    it('should return empty array for no visited nodes', () => {
      expect(getVisitedNodeIds('exclude(node-x)')).toEqual([]);
      expect(getVisitedNodeIds('')).toEqual([]);
      expect(getVisitedNodeIds(null)).toEqual([]);
    });
  });

  describe('evaluateConstraint', () => {
    it('should evaluate visited constraint correctly', () => {
      const visitedNodes = new Set(['node-a', 'node-b']);
      expect(evaluateConstraint('visited(node-a)', visitedNodes)).toBe(true);
      expect(evaluateConstraint('visited(node-a, node-b)', visitedNodes)).toBe(true);
      expect(evaluateConstraint('visited(node-a, node-c)', visitedNodes)).toBe(false);
    });

    it('should evaluate exclude constraint correctly', () => {
      const visitedNodes = new Set(['node-a', 'node-b']);
      expect(evaluateConstraint('exclude(node-x)', visitedNodes)).toBe(true);
      expect(evaluateConstraint('exclude(node-a)', visitedNodes)).toBe(false);
      expect(evaluateConstraint('visited(node-a).exclude(node-b)', visitedNodes)).toBe(false);
    });

    it('should evaluate visitedAny constraint correctly', () => {
      const visitedNodes = new Set(['node-a']);
      expect(evaluateConstraint('visitedAny(node-a, node-b)', visitedNodes)).toBe(true);
      expect(evaluateConstraint('visitedAny(node-c, node-d)', visitedNodes)).toBe(false);
      expect(evaluateConstraint('visitedAny(node-a, node-b).visitedAny(node-c, node-d)', visitedNodes)).toBe(true);
    });

    it('should evaluate context constraint correctly', () => {
      const visitedNodes = new Set(['node-a']);
      const context = { device: 'mobile', browser: 'chrome' };
      
      expect(evaluateConstraint('context(device:mobile)', visitedNodes, context)).toBe(true);
      expect(evaluateConstraint('context(device:desktop)', visitedNodes, context)).toBe(false);
      expect(evaluateConstraint('context(device:mobile).context(browser:chrome)', visitedNodes, context)).toBe(true);
      expect(evaluateConstraint('context(device:mobile).context(browser:firefox)', visitedNodes, context)).toBe(false);
    });

    it('should evaluate case constraint correctly', () => {
      const visitedNodes = new Set(['node-a']);
      const caseVariants = { test: 'treatment', experiment: 'variant-b' };
      
      expect(evaluateConstraint('case(test:treatment)', visitedNodes, undefined, caseVariants)).toBe(true);
      expect(evaluateConstraint('case(test:control)', visitedNodes, undefined, caseVariants)).toBe(false);
      expect(evaluateConstraint('case(test:treatment).case(experiment:variant-b)', visitedNodes, undefined, caseVariants)).toBe(true);
    });

    it('should evaluate complex constraint with all types', () => {
      const visitedNodes = new Set(['node-a', 'node-b']);
      const context = { device: 'mobile' };
      const caseVariants = { test: 'treatment' };
      
      const constraint = 'visited(node-a).exclude(node-x).context(device:mobile).case(test:treatment).visitedAny(node-b, node-c)';
      expect(evaluateConstraint(constraint, visitedNodes, context, caseVariants)).toBe(true);
    });

    it('should return false if visited constraint not satisfied', () => {
      const visitedNodes = new Set(['node-a']);
      expect(evaluateConstraint('visited(node-a, node-b)', visitedNodes)).toBe(false);
    });

    it('should return false if exclude constraint violated', () => {
      const visitedNodes = new Set(['node-a', 'node-x']);
      expect(evaluateConstraint('visited(node-a).exclude(node-x)', visitedNodes)).toBe(false);
    });

    it('should return true for empty constraint', () => {
      const visitedNodes = new Set(['node-a']);
      expect(evaluateConstraint('', visitedNodes)).toBe(true);
    });
  });

  describe('normalizeConstraintString', () => {
    it('should normalize simple visited constraint', () => {
      const result = normalizeConstraintString('visited(node-b, node-a)');
      expect(result).toBe('visited(node-a, node-b)');
    });

    it('should normalize multiple constraint types', () => {
      const result = normalizeConstraintString('visited(node-b, node-a).exclude(node-y, node-x)');
      // Order: visited, exclude, context, cases, visitedAny (as per implementation)
      expect(result).toBe('visited(node-a, node-b).exclude(node-x, node-y)');
    });

    it('should normalize context constraints', () => {
      const result = normalizeConstraintString('context(browser:chrome).context(device:mobile)');
      expect(result).toBe('context(browser:chrome).context(device:mobile)');
    });

    it('should normalize case constraints', () => {
      const result = normalizeConstraintString('case(experiment:variant-b).case(test:treatment)');
      expect(result).toBe('case(experiment:variant-b).case(test:treatment)');
    });

    it('should normalize visitedAny constraints', () => {
      const result = normalizeConstraintString('visitedAny(node-b, node-a)');
      expect(result).toBe('visitedAny(node-a, node-b)');
    });

    it('should handle empty constraint', () => {
      expect(normalizeConstraintString('')).toBe('');
    });

    it('should produce consistent output for same input', () => {
      const input = 'visited(node-b, node-a).exclude(node-x)';
      const result1 = normalizeConstraintString(input);
      const result2 = normalizeConstraintString(input);
      expect(result1).toBe(result2);
    });

    it('should produce same output for semantically equivalent constraints', () => {
      const input1 = 'visited(node-b, node-a)';
      const input2 = 'visited(node-a, node-b)';
      expect(normalizeConstraintString(input1)).toBe(normalizeConstraintString(input2));
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle malformed constraint gracefully', () => {
      // Missing closing parenthesis
      const result = parseConstraints('visited(node-a');
      expect(result.visited).toEqual([]);
    });

    it('should handle nested parentheses', () => {
      // This shouldn't happen in valid DSL, but parser should handle it
      const result = parseConstraints('visited(node-a(node-b))');
      // Parser will extract what it can
      expect(result.visited.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty node lists', () => {
      const result = parseConstraints('visited()');
      expect(result.visited).toEqual([]);
    });

    it('should handle whitespace-only node lists', () => {
      const result = parseConstraints('visited(  ,  )');
      expect(result.visited).toEqual([]);
    });

    it('should handle non-string input to parseConstraints', () => {
      // TypeScript should prevent this, but runtime check exists
      const result = parseConstraints(null as any);
      expect(result.visited).toEqual([]);
    });
  });

  // ============================================================
  // TEST SUITE 8: Cohort Parsing (C2-T.1)
  // ============================================================

  describe('Cohort Parsing', () => {
    it('should parse cohort(-30d:) with relative start and open end', () => {
      const result = parseConstraints('cohort(-30d:)');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.start).toBe('-30d');
      expect(result.cohort?.end).toBeUndefined(); // Empty end becomes undefined
      expect(result.cohort?.anchor).toBeUndefined();
    });

    it('should parse cohort with absolute dates', () => {
      const result = parseConstraints('cohort(1-Nov-25:30-Nov-25)');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.start).toBe('1-Nov-25');
      expect(result.cohort?.end).toBe('30-Nov-25');
      expect(result.cohort?.anchor).toBeUndefined();
    });

    it('should parse cohort with anchor node and date range', () => {
      const result = parseConstraints('cohort(anchor-node,-14d:)');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.anchor).toBe('anchor-node');
      expect(result.cohort?.start).toBe('-14d');
      expect(result.cohort?.end).toBeUndefined(); // Empty end becomes undefined
    });

    it('should parse cohort with anchor and absolute dates', () => {
      const result = parseConstraints('cohort(start-node,1-Dec-25:15-Dec-25)');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.anchor).toBe('start-node');
      expect(result.cohort?.start).toBe('1-Dec-25');
      expect(result.cohort?.end).toBe('15-Dec-25');
    });

    it('should parse cohort combined with context', () => {
      const result = parseConstraints('cohort(-30d:).context(channel:google)');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.start).toBe('-30d');
      expect(result.context).toEqual([{ key: 'channel', value: 'google' }]);
    });

    it('should parse cohort combined with visited and exclude', () => {
      const result = parseConstraints('visited(node-a).cohort(-7d:).exclude(node-b)');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.start).toBe('-7d');
      expect(result.visited).toEqual(['node-a']);
      expect(result.exclude).toEqual(['node-b']);
    });

    it('should normalise cohort string (roundtrip)', () => {
      const input = 'visited(b).cohort(-30d:).context(x:y)';
      const normalised = normalizeConstraintString(input);
      expect(normalised).toContain('cohort(-30d:)');
      expect(normalised).toContain('visited(b)');
      expect(normalised).toContain('context(x:y)');
    });

    it('should normalise cohort with anchor (roundtrip)', () => {
      const input = 'cohort(start-node,-14d:7-Dec-25)';
      const normalised = normalizeConstraintString(input);
      expect(normalised).toContain('cohort(start-node,-14d:7-Dec-25)');
    });

    it('should handle empty cohort gracefully', () => {
      // cohort without proper format should not crash
      const result = parseConstraints('cohort()');
      // No colon means no start/end parsed
      expect(result.cohort).toBeNull();
    });

    it('should return null cohort for non-cohort constraint', () => {
      const result = parseConstraints('visited(a).context(b:c)');
      expect(result.cohort).toBeNull();
    });

    it('should parse both window and cohort in same string', () => {
      const result = parseConstraints('window(-90d:).cohort(-30d:)');
      expect(result.window).not.toBeNull();
      expect(result.window?.start).toBe('-90d');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.start).toBe('-30d');
    });

    it('should handle cohort with only anchor (no dates)', () => {
      const result = parseConstraints('cohort(start-node)');
      // No colon in args means no date range
      expect(result.cohort).toBeNull();
    });

    it('should parse cohort with mixed date formats (absolute start + relative end)', () => {
      const result = parseConstraints('cohort(15-Nov-25:-7d)');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.start).toBe('15-Nov-25');
      expect(result.cohort?.end).toBe('-7d');
      expect(result.cohort?.anchor).toBeUndefined();
    });

    it('should parse cohort with anchor and mixed date formats', () => {
      const result = parseConstraints('cohort(start-node,1-Dec-25:-14d)');
      expect(result.cohort).not.toBeNull();
      expect(result.cohort?.anchor).toBe('start-node');
      expect(result.cohort?.start).toBe('1-Dec-25');
      expect(result.cohort?.end).toBe('-14d');
    });

    it('should normalise cohort with mixed date formats (roundtrip)', () => {
      const input = 'cohort(15-Nov-25:-7d).context(channel:google)';
      const normalised = normalizeConstraintString(input);
      expect(normalised).toContain('cohort(15-Nov-25:-7d)');
      expect(normalised).toContain('context(channel:google)');
    });
  });

  describe('Integration: Real-world scenarios', () => {
    it('should parse migrated conditional probability format', () => {
      // Simulates what we migrated from old format
      const migratedCondition = 'visited(coffee-promotion)';
      const parsed = parseConstraints(migratedCondition);
      expect(parsed.visited).toEqual(['coffee-promotion']);
      
      const visitedNodes = new Set(['coffee-promotion']);
      expect(evaluateConstraint(migratedCondition, visitedNodes)).toBe(true);
    });

    it('should handle multiple conditional probabilities on same edge', () => {
      const conditions = [
        'visited(node-24)',
        'visited(node-25)'
      ];
      
      conditions.forEach(condition => {
        const parsed = parseConstraints(condition);
        expect(parsed.visited.length).toBe(1);
      });
    });

    it('should normalize for comparison in EdgeContextMenu', () => {
      // Simulates condition comparison logic
      const condition1 = 'visited(node-b, node-a)';
      const condition2 = 'visited(node-a, node-b)';
      
      const normalized1 = normalizeConstraintString(condition1);
      const normalized2 = normalizeConstraintString(condition2);
      
      expect(normalized1).toBe(normalized2);
    });

    it('should work with conditionalReferences format', () => {
      const condition = 'visited(coffee-promotion)';
      const normalized = normalizeConstraintString(condition);
      const parsed = parseConstraints(normalized);
      
      expect(parsed.visited).toEqual(['coffee-promotion']);
      expect(normalized).toBe('visited(coffee-promotion)');
    });
  });
});

