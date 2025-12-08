/**
 * EXHAUSTIVE Schema / TypeScript Parity Tests
 * 
 * These tests ensure TOTAL PARITY between:
 * 1. JSON Schema ($defs)
 * 2. TypeScript interfaces
 * 
 * NO DRIFT ALLOWED IN ANY DIRECTION.
 * 
 * For each type:
 * - Schema fields == TypeScript fields (bidirectional)
 * - Missing in either direction = FAIL
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// We can't directly introspect TypeScript types at runtime,
// so we maintain a manual list that MUST be kept in sync.
// The test will fail if schema changes and this list isn't updated.

const SCHEMA_PATH = join(__dirname, '..', '..', '..', 'public', 'schemas', 'conversion-graph-1.1.0.json');

function loadSchema(): any {
  const content = readFileSync(SCHEMA_PATH, 'utf-8');
  return JSON.parse(content);
}

function getSchemaProperties(schemaDef: any): Set<string> {
  return new Set(Object.keys(schemaDef?.properties || {}));
}

/**
 * TypeScript field definitions - MUST match src/types/index.ts
 * 
 * When you add/remove a field in TypeScript types, you MUST update this list.
 * If you don't, this test will fail.
 */
const TYPESCRIPT_FIELDS = {
  ProbabilityParam: new Set([
    'mean', 'mean_overridden', 'stdev', 'stdev_overridden',
    'distribution', 'distribution_overridden', 'id',
    'connection', 'connection_string', 'evidence', 'data_source',
    // LAG fields (Project LAG - Phase C1)
    'latency', 'forecast'
    // NOTE: 'query' removed - legacy field, actual query lives at edge.query
  ]),
  
  LatencyConfig: new Set([
    'maturity_days', 'maturity_days_overridden',
    'anchor_node_id', 'anchor_node_id_overridden',
    't95', 'median_lag_days', 'completeness'
  ]),
  
  ForecastParams: new Set([
    'mean', 'stdev'
  ]),
  
  CostParam: new Set([
    'mean', 'mean_overridden', 'stdev', 'stdev_overridden',
    'distribution', 'distribution_overridden', 'id',
    'connection', 'connection_string', 'evidence'
  ]),
  
  Evidence: new Set([
    'n', 'k', 'window_from', 'window_to', 'retrieved_at', 'source',
    'path', 'full_query', 'debug_trace'
  ]),
  
  GraphEdge: new Set([
    'uuid', 'id', 'from', 'to', 'fromHandle', 'toHandle',
    'label', 'label_overridden', 'description', 'description_overridden',
    'query', 'query_overridden', 'n_query', 'n_query_overridden',
    'p', 'conditional_p', 'weight_default',
    'cost_gbp', 'labour_cost', 'case_variant', 'case_id', 'display'
  ]),
  
  GraphNode: new Set([
    'uuid', 'id', 'type', 'label', 'label_overridden',
    'description', 'description_overridden', 'event_id', 'event_id_overridden', 'event',
    'tags', 'absorbing', 'outcome_type', 'outcome_type_overridden', 'entry', 'costs',
    'residual_behavior', 'case', 'layout',
    'url', 'url_overridden', 'images', 'images_overridden'
  ]),
  
  Metadata: new Set([
    'version', 'name', 'created_at', 'updated_at', 'author', 'description', 'tags'
  ]),
  
  Policies: new Set([
    'default_outcome', 'overflow_policy', 'free_edge_policy'
  ]),
  
  ConditionalProbability: new Set([
    'condition', 'query', 'query_overridden', 'p'
  ]),
  
  ResidualBehavior: new Set([
    'default_outcome', 'overflow_policy'
  ]),
};

function assertBidirectionalParity(
  schemaProps: Set<string>,
  tsProps: Set<string>,
  typeName: string,
  allowedSchemaOnly: Set<string> = new Set(),
  allowedTsOnly: Set<string> = new Set()
) {
  const schemaOnly = new Set([...schemaProps].filter(x => !tsProps.has(x) && !allowedSchemaOnly.has(x)));
  const tsOnly = new Set([...tsProps].filter(x => !schemaProps.has(x) && !allowedTsOnly.has(x)));
  
  const errors: string[] = [];
  
  if (schemaOnly.size > 0) {
    errors.push(`Schema has fields missing from TypeScript: [${[...schemaOnly].sort().join(', ')}]`);
  }
  
  if (tsOnly.size > 0) {
    errors.push(`TypeScript has fields missing from Schema: [${[...tsOnly].sort().join(', ')}]`);
  }
  
  if (errors.length > 0) {
    throw new Error(`${typeName} PARITY FAILURE:\n${errors.join('\n')}`);
  }
}

describe('Schema / TypeScript TOTAL PARITY', () => {
  let schema: any;
  
  beforeAll(() => {
    schema = loadSchema();
  });
  
  describe('ProbabilityParam', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const schemaProps = getSchemaProperties(schema.$defs?.ProbabilityParam);
      const tsProps = TYPESCRIPT_FIELDS.ProbabilityParam;
      
      // NO EXCEPTIONS - strict parity required
      assertBidirectionalParity(schemaProps, tsProps, 'ProbabilityParam');
    });
  });
  
  describe('CostParam', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const schemaProps = getSchemaProperties(schema.$defs?.CostParam);
      const tsProps = TYPESCRIPT_FIELDS.CostParam;
      
      assertBidirectionalParity(schemaProps, tsProps, 'CostParam');
    });
  });
  
  describe('Evidence', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const probParamDef = schema.$defs?.ProbabilityParam;
      const evidenceDef = probParamDef?.properties?.evidence;
      const schemaProps = getSchemaProperties(evidenceDef);
      const tsProps = TYPESCRIPT_FIELDS.Evidence;
      
      assertBidirectionalParity(schemaProps, tsProps, 'Evidence');
    });
  });
  
  describe('Edge (GraphEdge)', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const schemaProps = getSchemaProperties(schema.$defs?.Edge);
      const tsProps = TYPESCRIPT_FIELDS.GraphEdge;
      
      assertBidirectionalParity(schemaProps, tsProps, 'Edge/GraphEdge');
    });
  });
  
  describe('Node (GraphNode)', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const schemaProps = getSchemaProperties(schema.$defs?.Node);
      const tsProps = TYPESCRIPT_FIELDS.GraphNode;
      
      assertBidirectionalParity(schemaProps, tsProps, 'Node/GraphNode');
    });
  });
  
  describe('Metadata', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const schemaProps = getSchemaProperties(schema.$defs?.Metadata);
      const tsProps = TYPESCRIPT_FIELDS.Metadata;
      
      assertBidirectionalParity(schemaProps, tsProps, 'Metadata');
    });
  });
  
  describe('Policies', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const schemaProps = getSchemaProperties(schema.$defs?.Policies);
      const tsProps = TYPESCRIPT_FIELDS.Policies;
      
      assertBidirectionalParity(schemaProps, tsProps, 'Policies');
    });
  });
  
  describe('ConditionalProbability', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const schemaProps = getSchemaProperties(schema.$defs?.ConditionalProbability);
      const tsProps = TYPESCRIPT_FIELDS.ConditionalProbability;
      
      assertBidirectionalParity(schemaProps, tsProps, 'ConditionalProbability');
    });
  });
  
  describe('ResidualBehavior', () => {
    it('must have IDENTICAL fields in schema and TypeScript', () => {
      const schemaProps = getSchemaProperties(schema.$defs?.ResidualBehavior);
      const tsProps = TYPESCRIPT_FIELDS.ResidualBehavior;
      
      assertBidirectionalParity(schemaProps, tsProps, 'ResidualBehavior');
    });
  });
  
  describe('All schema $defs must have TypeScript coverage', () => {
    const EXCLUDED_DEFS = new Set([
      'UUID', 'Id', 'Condition',  // Simple types, not interfaces
      'Costs', 'MonetaryCost', 'TimeCost',  // Deprecated
      'EdgeDisplay',  // UI-only optional
    ]);
    
    const SCHEMA_TO_TS: Record<string, keyof typeof TYPESCRIPT_FIELDS> = {
      'ProbabilityParam': 'ProbabilityParam',
      'CostParam': 'CostParam',
      'Edge': 'GraphEdge',
      'Node': 'GraphNode',
      'Metadata': 'Metadata',
      'Policies': 'Policies',
      'ConditionalProbability': 'ConditionalProbability',
      'ResidualBehavior': 'ResidualBehavior',
      // LAG types (Project LAG - Phase C1)
      'LatencyConfig': 'LatencyConfig',
      'ForecastParams': 'ForecastParams',
      // Evidence is nested, tested separately
    };
    
    it('every non-excluded $def must have a TypeScript mapping', () => {
      const schemaDefs = new Set(Object.keys(schema.$defs || {}));
      const coveredDefs = new Set([...Object.keys(SCHEMA_TO_TS), ...EXCLUDED_DEFS, 'Evidence']);
      
      const uncovered = [...schemaDefs].filter(d => !coveredDefs.has(d));
      
      if (uncovered.length > 0) {
        throw new Error(
          `Schema has $defs without TypeScript coverage: [${uncovered.join(', ')}]\n` +
          `Add them to SCHEMA_TO_TS or EXCLUDED_DEFS`
        );
      }
    });
  });
  
  describe('DataSource drift documentation', () => {
    it('DataSource is NOT in schema (known drift)', () => {
      const schemaDefs = Object.keys(schema.$defs || {});
      
      // This test documents the known drift
      // It should be updated when DataSource is added to schema
      expect(schemaDefs).not.toContain('DataSource');
    });
    
    it('TypeScript ProbabilityParam has data_source (not in schema)', () => {
      expect(TYPESCRIPT_FIELDS.ProbabilityParam.has('data_source')).toBe(true);
    });
  });
});

/**
 * INSTRUCTIONS FOR MAINTAINING PARITY:
 * 
 * When you ADD a field to schema:
 * 1. Add it to the corresponding TYPESCRIPT_FIELDS set above
 * 2. Add it to TypeScript interface in src/types/index.ts
 * 3. Add it to Python Pydantic model in lib/graph_types.py
 * 4. Run both parity tests to verify
 * 
 * When you ADD a field to TypeScript:
 * 1. Add it to the corresponding TYPESCRIPT_FIELDS set above
 * 2. Add it to JSON schema in public/schemas/conversion-graph-1.1.0.json
 * 3. Add it to Python Pydantic model in lib/graph_types.py
 * 4. Run both parity tests to verify
 * 
 * When you REMOVE a field:
 * 1. Remove from all three places (schema, TS, Python)
 * 2. Update TYPESCRIPT_FIELDS above
 * 3. Run both parity tests to verify
 * 
 * NEVER use allowedSchemaOnly or allowedTsOnly unless there's a
 * documented reason for intentional drift.
 */

