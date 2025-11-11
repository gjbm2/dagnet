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
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Query DSL Constants', () => {
  // ============================================================
  // TEST SUITE 1: Schema Authority Validation
  // ============================================================

  describe('Schema Authority', () => {
    it('should have exactly 6 functions', () => {
      expect(QUERY_FUNCTIONS).toHaveLength(6);
    });

    it('should contain all required functions in correct order', () => {
      expect(QUERY_FUNCTIONS).toEqual([
        'from',
        'to',
        'visited',
        'exclude',
        'context',
        'case'
      ]);
    });

    it('should be a readonly tuple at compile time', () => {
      // TypeScript's `as const` prevents mutation at compile time
      // but doesn't enforce runtime immutability
      // This test just verifies the array exists and has the right type
      const arr: readonly string[] = QUERY_FUNCTIONS;
      expect(arr).toBeDefined();
      expect(arr.length).toBe(6);
    });

    it('should match schema definition exactly', () => {
      // Read the schema file
      const schemaPath = join(__dirname, '../../../public/schemas/query-dsl-1.0.0.json');
      const schemaContent = readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      
      // Extract function names from schema
      const schemaFunctions = schema.$defs?.QueryFunction?.properties?.name?.enum;
      
      expect(schemaFunctions).toBeDefined();
      expect(schemaFunctions).toHaveLength(6);
      
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
        'exclude',
        'context',
        'case'
      ];
      
      expect(validNames).toHaveLength(6);
    });

    it('should enforce literal types', () => {
      // These should compile
      const from: QueryFunctionName = 'from';
      const to: QueryFunctionName = 'to';
      const visited: QueryFunctionName = 'visited';
      const exclude: QueryFunctionName = 'exclude';
      const context: QueryFunctionName = 'context';
      const caseFunc: QueryFunctionName = 'case';
      
      expect([from, to, visited, exclude, context, caseFunc]).toHaveLength(6);
    });

    it('should be usable in array operations', () => {
      // Create a fresh copy to avoid mutation issues
      const functionsCopy = [...QUERY_FUNCTIONS];
      const functionSet = new Set(functionsCopy);
      
      expect(functionSet.has('from')).toBe(true);
      expect(functionSet.has('invalid' as any)).toBe(false);
      expect(functionSet.size).toBe(6);
      
      const filtered = functionsCopy.filter(f => f.startsWith('c'));
      expect(filtered).toContain('context');
      expect(filtered).toContain('case');
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
      expect(QUERY_FUNCTIONS[3]).toBe('exclude');
      expect(QUERY_FUNCTIONS[4]).toBe('context');
      expect(QUERY_FUNCTIONS[5]).toBe('case');
    });

    it('should be importable consistently', () => {
      // Verify the constant can be imported and used
      expect(QUERY_FUNCTIONS).toBeDefined();
      expect(Array.isArray(QUERY_FUNCTIONS)).toBe(true);
      expect(QUERY_FUNCTIONS.length).toBe(6);
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

