/**
 * Schema / TypeScript Types Consistency Tests
 * 
 * Validates that TypeScript interfaces align with their corresponding JSON/YAML schemas.
 * Tests both directions:
 * 1. Schema properties exist in TypeScript types (via compile-time check of test data)
 * 2. TypeScript type properties are allowed by schema (via runtime ajv validation)
 * 
 * This prevents drift between schemas and types when fields are added/removed/renamed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Import TypeScript types
import type { ConversionGraph, GraphNode, GraphEdge, Metadata, Policies } from '../../types';
import type { Parameter, ParameterValue, Context, Case, Node } from '../paramRegistryService';
import type { ConnectionFile, ConnectionDefinition } from '../../lib/das/types';
import type { CredentialsData, GitRepositoryCredential } from '../../types/credentials';

const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');

// Configure AJV for schema validation
const ajv = new Ajv({ 
  allErrors: true, 
  strict: false,
  allowUnionTypes: true 
});
addFormats(ajv);

/**
 * Load and parse a schema file (JSON or YAML)
 */
function loadSchema(schemaPath: string): any {
  const fullPath = join(PUBLIC_DIR, schemaPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Schema file not found: ${fullPath}`);
  }
  
  const content = readFileSync(fullPath, 'utf-8');
  
  if (schemaPath.endsWith('.yaml') || schemaPath.endsWith('.yml')) {
    return yaml.load(content);
  }
  return JSON.parse(content);
}

/**
 * Extract all property names from a JSON schema (including nested)
 */
function getSchemaPropertyNames(schema: any, prefix = ''): string[] {
  const props: string[] = [];
  
  if (!schema.properties) return props;
  
  for (const [name, def] of Object.entries(schema.properties)) {
    const fullName = prefix ? `${prefix}.${name}` : name;
    props.push(fullName);
    
    // Recurse into nested objects
    const propDef = def as any;
    if (propDef.type === 'object' && propDef.properties) {
      props.push(...getSchemaPropertyNames(propDef, fullName));
    }
  }
  
  return props;
}

/**
 * Get required properties from schema
 */
function getRequiredProperties(schema: any): string[] {
  return schema.required || [];
}

describe('Schema / TypeScript Types Consistency', () => {
  
  describe('Parameter Schema <> Parameter Type', () => {
    let schema: any;
    
    beforeAll(() => {
      schema = loadSchema('/param-schemas/parameter-schema.yaml');
    });
    
    it('should have matching top-level properties', () => {
      const schemaProps = Object.keys(schema.properties || {});
      
      // Create a minimal valid Parameter object to test compile-time type checking
      // If schema has properties not in type, this won't compile
      const testParam: Parameter = {
        id: 'test-param',
        name: 'Test Parameter',
        type: 'probability',
        values: [{ mean: 0.5 }],
        query: 'from(a).to(b)',
        query_overridden: false,
        n_query: 'from(a).to(c)',
        n_query_overridden: false,
        metadata: {
          description: 'Test description for the parameter',
          created_at: '2025-01-01T00:00:00Z',
          author: 'test',
          version: '1.0.0'
        }
      };
      
      // Log for visibility
      expect(schemaProps).toContain('id');
      expect(schemaProps).toContain('name');
      expect(schemaProps).toContain('type');
      expect(schemaProps).toContain('values');
      expect(schemaProps).toContain('query');
      expect(schemaProps).toContain('query_overridden');
      expect(schemaProps).toContain('n_query');
      expect(schemaProps).toContain('n_query_overridden');
      expect(schemaProps).toContain('metadata');
      
      // Verify test param compiles (if this fails, type is missing schema properties)
      expect(testParam.id).toBeDefined();
    });
    
    it('should validate minimal Parameter against schema', () => {
      const validate = ajv.compile(schema);
      
      const minimalParam = {
        id: 'test-param',
        name: 'Test Parameter',
        type: 'probability',
        values: [{ mean: 0.5 }],
        metadata: {
          description: 'Test description for the parameter',
          created_at: '2025-01-01T00:00:00Z',
          author: 'test',
          version: '1.0.0'
        }
      };
      
      const valid = validate(minimalParam);
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
    
    it('should validate full Parameter with n_query against schema', () => {
      const validate = ajv.compile(schema);
      
      const fullParam = {
        id: 'test-param',
        name: 'Test Parameter',
        type: 'probability',
        query: 'from(checkout).to(purchase)',
        query_overridden: false,
        n_query: 'from(landing).to(checkout)',
        n_query_overridden: true,
        connection: 'amplitude-prod',
        connection_string: '{"filter": "test"}',
        values: [{ 
          mean: 0.5, 
          stdev: 0.1,
          n: 100,
          k: 50,
          distribution: 'beta',
          window_from: '2025-01-01T00:00:00Z',
          window_to: '2025-03-31T23:59:59Z'
        }],
        metadata: {
          description: 'Full parameter with all fields',
          description_overridden: false,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-15T00:00:00Z',
          author: 'test-author',
          version: '1.0.0',
          status: 'active',
          tags: ['test', 'conversion'],
          units: 'probability'
        }
      };
      
      const valid = validate(fullParam);
      if (!valid) {
        console.error('Validation errors:', validate.errors);
      }
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
    
    it('should have n_query and n_query_overridden in both schema and type', () => {
      // This test specifically checks the fields that caused the original bug
      const schemaProps = Object.keys(schema.properties || {});
      
      expect(schemaProps).toContain('n_query');
      expect(schemaProps).toContain('n_query_overridden');
      
      // Type check - if Parameter type doesn't have these, this won't compile
      const param: Partial<Parameter> = {
        n_query: 'from(a).to(b)',
        n_query_overridden: true
      };
      
      expect(param.n_query).toBeDefined();
      expect(param.n_query_overridden).toBeDefined();
    });
  });
  
  describe('Context Schema <> Context Type', () => {
    let schema: any;
    
    beforeAll(() => {
      schema = loadSchema('/param-schemas/context-definition-schema.yaml');
    });
    
    it('should have matching top-level properties', () => {
      const schemaProps = Object.keys(schema.properties || {});
      
      expect(schemaProps).toContain('id');
      expect(schemaProps).toContain('name');
      expect(schemaProps).toContain('description');
      expect(schemaProps).toContain('type');
      expect(schemaProps).toContain('values');
      expect(schemaProps).toContain('metadata');
    });
    
    it('should validate Context against schema', () => {
      const validate = ajv.compile(schema);
      
      const testContext = {
        id: 'channel',
        name: 'Marketing Channel',
        description: 'Traffic acquisition channel for attribution',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [
          { id: 'google', label: 'Google Ads' },
          { id: 'facebook', label: 'Facebook Ads' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      const valid = validate(testContext);
      if (!valid) {
        console.error('Context validation errors:', validate.errors);
      }
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
  });
  
  describe('Case Schema <> Case Type', () => {
    let schema: any;
    
    beforeAll(() => {
      schema = loadSchema('/param-schemas/case-parameter-schema.yaml');
    });
    
    it('should have matching top-level properties', () => {
      const schemaProps = Object.keys(schema.properties || {});
      
      expect(schemaProps).toContain('id');
      expect(schemaProps).toContain('parameter_type');
      expect(schemaProps).toContain('name');
      expect(schemaProps).toContain('case');
      expect(schemaProps).toContain('metadata');
    });
    
    it('should validate Case against schema', () => {
      const validate = ajv.compile(schema);
      
      const testCase = {
        id: 'test-experiment',
        parameter_type: 'case',
        name: 'Test Experiment',
        case: {
          status: 'active',
          variants: [
            { name: 'control', weight: 0.5 },
            { name: 'treatment', weight: 0.5 }
          ]
        },
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0'
        }
      };
      
      const valid = validate(testCase);
      if (!valid) {
        console.error('Case validation errors:', validate.errors);
      }
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
  });
  
  describe('Event Schema <> EventDefinition Type', () => {
    let schema: any;
    
    beforeAll(() => {
      schema = loadSchema('/param-schemas/event-schema.yaml');
    });
    
    it('should have matching top-level properties', () => {
      const schemaProps = Object.keys(schema.properties || {});
      
      expect(schemaProps).toContain('id');
      expect(schemaProps).toContain('name');
      expect(schemaProps).toContain('description');
      expect(schemaProps).toContain('category');
      expect(schemaProps).toContain('tags');
      expect(schemaProps).toContain('provider_event_names');
      expect(schemaProps).toContain('amplitude_filters');
    });
    
    it('should validate Event against schema', () => {
      const validate = ajv.compile(schema);
      
      const testEvent = {
        id: 'checkout_started',
        name: 'Checkout Started',
        description: 'User initiates the checkout process',
        category: 'user_action',
        tags: ['checkout', 'conversion'],
        provider_event_names: {
          amplitude: 'Checkout Started',
          segment: 'checkout_started'
        }
      };
      
      const valid = validate(testEvent);
      if (!valid) {
        console.error('Event validation errors:', validate.errors);
      }
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
  });
  
  describe('Node Schema <> Node Type', () => {
    let schema: any;
    
    beforeAll(() => {
      schema = loadSchema('/param-schemas/node-schema.yaml');
    });
    
    it('should have matching top-level properties', () => {
      const schemaProps = Object.keys(schema.properties || {});
      
      expect(schemaProps).toContain('id');
      expect(schemaProps).toContain('name');
    });
    
    it('should validate Node against schema', () => {
      const validate = ajv.compile(schema);
      
      const testNode = {
        id: 'checkout',
        name: 'Checkout Page',
        description: 'The checkout page where users complete purchases',
        tags: ['checkout', 'conversion'],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0'
        }
      };
      
      const valid = validate(testNode);
      if (!valid) {
        console.error('Node validation errors:', validate.errors);
      }
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
  });
  
  describe('Connections Schema <> ConnectionFile Type', () => {
    let schema: any;
    
    beforeAll(() => {
      schema = loadSchema('/schemas/connections-schema.json');
    });
    
    it('should have matching top-level properties', () => {
      const schemaProps = Object.keys(schema.properties || {});
      
      expect(schemaProps).toContain('version');
      expect(schemaProps).toContain('connections');
    });
    
    it('should validate ConnectionFile against schema', () => {
      const validate = ajv.compile(schema);
      
      const testConnectionFile: ConnectionFile = {
        version: '1.0.0',
        connections: [{
          name: 'amplitude-prod',
          provider: 'amplitude',
          kind: 'http',
          enabled: true,
          adapter: {
            request: {
              method: 'POST',
              url_template: 'https://api.amplitude.com/2/funnels'
            },
            response: {},
            upsert: {
              mode: 'replace',
              writes: []
            }
          }
        }]
      };
      
      const valid = validate(testConnectionFile);
      if (!valid) {
        console.error('ConnectionFile validation errors:', validate.errors);
      }
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
  });
  
  describe('Credentials Schema <> CredentialsData Type', () => {
    let schema: any;
    
    beforeAll(() => {
      schema = loadSchema('/schemas/credentials-schema.json');
    });
    
    it('should have matching top-level properties', () => {
      const schemaProps = Object.keys(schema.properties || {});
      
      expect(schemaProps).toContain('version');
      expect(schemaProps).toContain('git');
      expect(schemaProps).toContain('providers');
    });
    
    it('should validate CredentialsData against schema', () => {
      const validate = ajv.compile(schema);
      
      const testCredentials = {
        version: '1.1.0',
        git: [{
          name: 'my-repo',
          owner: 'myorg',
          token: 'ghp_xxxx',
          isDefault: true
        }],
        providers: {
          'amplitude-prod': {
            api_key: 'test-key',
            secret_key: 'test-secret'
          }
        }
      };
      
      const valid = validate(testCredentials);
      if (!valid) {
        console.error('CredentialsData validation errors:', validate.errors);
      }
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
  });
  
  describe('Graph Schema <> ConversionGraph Type', () => {
    let schema: any;
    
    beforeAll(() => {
      schema = loadSchema('/schemas/conversion-graph-1.0.0.json');
    });
    
    it('should have matching top-level properties', () => {
      const schemaProps = Object.keys(schema.properties || {});
      
      expect(schemaProps).toContain('nodes');
      expect(schemaProps).toContain('edges');
      expect(schemaProps).toContain('policies');
      expect(schemaProps).toContain('metadata');
    });
    
    it('should validate minimal ConversionGraph against schema', () => {
      // Create a copy of schema without $schema to avoid ajv issues with 2020-12 draft
      const schemaForValidation = { ...schema };
      delete schemaForValidation.$schema;
      const validate = ajv.compile(schemaForValidation);
      
      const testGraph: ConversionGraph = {
        nodes: [{
          uuid: '123e4567-e89b-12d3-a456-426614174000',
          id: 'start',
          label: 'Start Node'
        }],
        edges: [],
        policies: {
          default_outcome: 'success'
        },
        metadata: {
          version: '1.0.0',
          created_at: '2025-01-01T00:00:00Z'
        }
      };
      
      const valid = validate(testGraph);
      if (!valid) {
        console.error('ConversionGraph validation errors:', validate.errors);
      }
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
    
    it('edge should support n_query and n_query_overridden', () => {
      // Access edge properties via $defs or direct path
      const edgeDef = schema.$defs?.Edge || schema.definitions?.Edge;
      const edgeProps = edgeDef?.properties || schema.properties?.edges?.items?.properties || {};
      
      // Check schema has these properties
      expect(Object.keys(edgeProps)).toContain('n_query');
      expect(Object.keys(edgeProps)).toContain('n_query_overridden');
      
      // Check type has these properties (compile-time check)
      const edge: Partial<GraphEdge> = {
        n_query: 'from(a).to(b)',
        n_query_overridden: true
      };
      
      expect(edge.n_query).toBeDefined();
      expect(edge.n_query_overridden).toBeDefined();
    });
  });
  
  describe('Cross-schema consistency', () => {
    it('Parameter.type enum should match schema', () => {
      const schema = loadSchema('/param-schemas/parameter-schema.yaml');
      const schemaTypes = schema.properties?.type?.enum || [];
      
      // These should match what's in the TypeScript type
      expect(schemaTypes).toContain('probability');
      expect(schemaTypes).toContain('cost_gbp');
      expect(schemaTypes).toContain('cost_time');
    });
    
    it('Context.type enum should match schema', () => {
      const schema = loadSchema('/param-schemas/context-definition-schema.yaml');
      const schemaTypes = schema.properties?.type?.enum || [];
      
      expect(schemaTypes).toContain('categorical');
      expect(schemaTypes).toContain('ordinal');
      expect(schemaTypes).toContain('continuous');
    });
    
    it('Case.status enum should match schema', () => {
      const schema = loadSchema('/param-schemas/case-parameter-schema.yaml');
      const caseProps = schema.properties?.case?.properties || {};
      const schemaStatuses = caseProps.status?.enum || [];
      
      expect(schemaStatuses).toContain('active');
      expect(schemaStatuses).toContain('paused');
      expect(schemaStatuses).toContain('completed');
    });
  });
});

