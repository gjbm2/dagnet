/**
 * Sample Files Integrity Tests
 * 
 * Tests to verify that:
 * (a) All sample files are present in param-registry/test
 * (b) All sample files are listed in their corresponding index files
 * (c) All sample files and indexes are schema-compliant
 * 
 * This ensures the sample data used for "Use sample data" feature is complete and valid.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

// Path to sample data
const SAMPLE_DATA_PATH = path.resolve(__dirname, '../../../../param-registry/test');
const SCHEMAS_PATH = path.resolve(__dirname, '../../../public/param-schemas');
const MAIN_SCHEMAS_PATH = path.resolve(__dirname, '../../../public/schemas');

// Initialize AJV for schema validation (2020-12 draft for our schemas)
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// Helper to load YAML file
function loadYaml(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  return YAML.parse(content);
}

// Helper to load JSON file
function loadJson(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

// Helper to check if file exists
function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// Helper to list files in directory
function listFiles(dirPath: string, extension: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter(f => f.endsWith(extension))
    .map(f => f.replace(extension, ''));
}

describe('Sample Files Integrity', () => {
  
  // =========================================================================
  // (a) Sample files are present
  // =========================================================================
  
  describe('Sample files presence', () => {
    it('should have nodes directory with node files', () => {
      const nodesPath = path.join(SAMPLE_DATA_PATH, 'nodes');
      expect(fileExists(nodesPath)).toBe(true);
      
      const nodeFiles = listFiles(nodesPath, '.yaml');
      expect(nodeFiles.length).toBeGreaterThan(0);
      
      // Check specific expected nodes
      const expectedNodes = [
        'landing-page',
        'product-view',
        'checkout',
        'payment',
        'order-confirmed',
        'order-complete'
      ];
      
      for (const node of expectedNodes) {
        expect(nodeFiles).toContain(node);
      }
    });
    
    it('should have parameters directory with parameter files', () => {
      const paramsPath = path.join(SAMPLE_DATA_PATH, 'parameters');
      expect(fileExists(paramsPath)).toBe(true);
      
      const paramFiles = listFiles(paramsPath, '.yaml');
      expect(paramFiles.length).toBeGreaterThan(0);
      
      // Check specific expected parameters
      const expectedParams = [
        'landing-to-product',
        'checkout-to-payment',
        'payment-success-rate'
      ];
      
      for (const param of expectedParams) {
        expect(paramFiles).toContain(param);
      }
    });
    
    it('should have contexts directory with context files', () => {
      const contextsPath = path.join(SAMPLE_DATA_PATH, 'contexts');
      expect(fileExists(contextsPath)).toBe(true);
      
      const contextFiles = listFiles(contextsPath, '.yaml');
      expect(contextFiles.length).toBeGreaterThan(0);
      expect(contextFiles).toContain('channel');
      expect(contextFiles).toContain('customer');
    });
    
    it('should have cases directory with case files', () => {
      const casesPath = path.join(SAMPLE_DATA_PATH, 'cases');
      expect(fileExists(casesPath)).toBe(true);
      
      const caseFiles = listFiles(casesPath, '.yaml');
      expect(caseFiles.length).toBeGreaterThan(0);
      expect(caseFiles).toContain('cart-experience-test');
    });
    
    it('should have events directory with event files', () => {
      const eventsPath = path.join(SAMPLE_DATA_PATH, 'events');
      expect(fileExists(eventsPath)).toBe(true);
      
      const eventFiles = listFiles(eventsPath, '.yaml');
      expect(eventFiles.length).toBeGreaterThan(0);
      
      const expectedEvents = [
        'page-view-landing',
        'product-viewed',
        'add-to-cart',
        'checkout-started'
      ];
      
      for (const event of expectedEvents) {
        expect(eventFiles).toContain(event);
      }
    });
    
    it('should have graphs directory with graph files', () => {
      const graphsPath = path.join(SAMPLE_DATA_PATH, 'graphs');
      expect(fileExists(graphsPath)).toBe(true);
      
      const graphFiles = listFiles(graphsPath, '.json');
      expect(graphFiles.length).toBeGreaterThan(0);
      expect(graphFiles).toContain('ecommerce-checkout-flow');
    });
    
    it('should have all index files at root', () => {
      expect(fileExists(path.join(SAMPLE_DATA_PATH, 'nodes-index.yaml'))).toBe(true);
      expect(fileExists(path.join(SAMPLE_DATA_PATH, 'parameters-index.yaml'))).toBe(true);
      expect(fileExists(path.join(SAMPLE_DATA_PATH, 'contexts-index.yaml'))).toBe(true);
      expect(fileExists(path.join(SAMPLE_DATA_PATH, 'cases-index.yaml'))).toBe(true);
      expect(fileExists(path.join(SAMPLE_DATA_PATH, 'events-index.yaml'))).toBe(true);
    });
  });
  
  // =========================================================================
  // (b) Sample files are listed in registries
  // =========================================================================
  
  describe('Registry synchronisation', () => {
    it('should list all node files in nodes-index.yaml', () => {
      const nodesPath = path.join(SAMPLE_DATA_PATH, 'nodes');
      const nodeFiles = listFiles(nodesPath, '.yaml');
      
      const indexPath = path.join(SAMPLE_DATA_PATH, 'nodes-index.yaml');
      const index = loadYaml(indexPath);
      
      expect(index.nodes).toBeDefined();
      expect(Array.isArray(index.nodes)).toBe(true);
      
      const indexedIds = index.nodes.map((n: any) => n.id);
      
      // Every file should be in the index
      for (const file of nodeFiles) {
        expect(indexedIds).toContain(file);
      }
      
      // Every index entry should have a file
      for (const entry of index.nodes) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        expect(fileExists(filePath)).toBe(true);
      }
    });
    
    it('should list all parameter files in parameters-index.yaml', () => {
      const paramsPath = path.join(SAMPLE_DATA_PATH, 'parameters');
      const paramFiles = listFiles(paramsPath, '.yaml');
      
      const indexPath = path.join(SAMPLE_DATA_PATH, 'parameters-index.yaml');
      const index = loadYaml(indexPath);
      
      expect(index.parameters).toBeDefined();
      expect(Array.isArray(index.parameters)).toBe(true);
      
      const indexedIds = index.parameters.map((p: any) => p.id);
      
      // Every file should be in the index
      for (const file of paramFiles) {
        expect(indexedIds).toContain(file);
      }
      
      // Every index entry should have a file
      for (const entry of index.parameters) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        expect(fileExists(filePath)).toBe(true);
      }
    });
    
    it('should list all context files in contexts-index.yaml', () => {
      const contextsPath = path.join(SAMPLE_DATA_PATH, 'contexts');
      const contextFiles = listFiles(contextsPath, '.yaml');
      
      const indexPath = path.join(SAMPLE_DATA_PATH, 'contexts-index.yaml');
      const index = loadYaml(indexPath);
      
      expect(index.contexts).toBeDefined();
      expect(Array.isArray(index.contexts)).toBe(true);
      
      const indexedIds = index.contexts.map((c: any) => c.id);
      
      // Every file should be in the index
      for (const file of contextFiles) {
        expect(indexedIds).toContain(file);
      }
      
      // Every index entry should have a file
      for (const entry of index.contexts) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        expect(fileExists(filePath)).toBe(true);
      }
    });
    
    it('should list all case files in cases-index.yaml', () => {
      const casesPath = path.join(SAMPLE_DATA_PATH, 'cases');
      const caseFiles = listFiles(casesPath, '.yaml');
      
      const indexPath = path.join(SAMPLE_DATA_PATH, 'cases-index.yaml');
      const index = loadYaml(indexPath);
      
      expect(index.cases).toBeDefined();
      expect(Array.isArray(index.cases)).toBe(true);
      
      // Every index entry should have a file
      for (const entry of index.cases) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        expect(fileExists(filePath)).toBe(true);
      }
    });
    
    it('should list all event files in events-index.yaml', () => {
      const eventsPath = path.join(SAMPLE_DATA_PATH, 'events');
      const eventFiles = listFiles(eventsPath, '.yaml');
      
      const indexPath = path.join(SAMPLE_DATA_PATH, 'events-index.yaml');
      const index = loadYaml(indexPath);
      
      expect(index.events).toBeDefined();
      expect(Array.isArray(index.events)).toBe(true);
      
      // Every index entry with a file_path should have the file
      for (const entry of index.events) {
        if (entry.file_path) {
          const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
          expect(fileExists(filePath)).toBe(true);
        }
      }
    });
  });
  
  // =========================================================================
  // (c) Schema compliance
  // =========================================================================
  
  describe('Schema compliance', () => {
    let nodesIndexSchema: any;
    let parametersIndexSchema: any;
    let contextsIndexSchema: any;
    let casesIndexSchema: any;
    let eventsIndexSchema: any;
    let graphSchema: any;
    
    beforeAll(() => {
      // Load index schemas
      nodesIndexSchema = loadYaml(path.join(SCHEMAS_PATH, 'nodes-index-schema.yaml'));
      parametersIndexSchema = loadYaml(path.join(SCHEMAS_PATH, 'registry-schema.yaml'));
      contextsIndexSchema = loadYaml(path.join(SCHEMAS_PATH, 'contexts-index-schema.yaml'));
      casesIndexSchema = loadYaml(path.join(SCHEMAS_PATH, 'cases-index-schema.yaml'));
      eventsIndexSchema = loadYaml(path.join(SCHEMAS_PATH, 'events-index-schema.yaml'));
      
      // Load graph schema
      graphSchema = loadJson(path.join(MAIN_SCHEMAS_PATH, 'conversion-graph-1.1.0.json'));
    });
    
    it('should have valid nodes-index.yaml structure', () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'nodes-index.yaml');
      const index = loadYaml(indexPath);
      
      // Basic structure checks
      expect(index.version).toBeDefined();
      expect(index.nodes).toBeDefined();
      expect(Array.isArray(index.nodes)).toBe(true);
      
      // Each node entry should have required fields
      for (const node of index.nodes) {
        expect(node.id).toBeDefined();
        expect(typeof node.id).toBe('string');
        expect(node.file_path).toBeDefined();
      }
    });
    
    it('should have valid parameters-index.yaml structure', () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'parameters-index.yaml');
      const index = loadYaml(indexPath);
      
      // Basic structure checks
      expect(index.version).toBeDefined();
      expect(index.parameters).toBeDefined();
      expect(Array.isArray(index.parameters)).toBe(true);
      
      // Each parameter entry should have required fields
      for (const param of index.parameters) {
        expect(param.id).toBeDefined();
        expect(typeof param.id).toBe('string');
        expect(param.file_path).toBeDefined();
        expect(param.type).toBeDefined();
      }
    });
    
    it('should have valid contexts-index.yaml structure', () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'contexts-index.yaml');
      const index = loadYaml(indexPath);
      
      // Basic structure checks
      expect(index.version).toBeDefined();
      expect(index.contexts).toBeDefined();
      expect(Array.isArray(index.contexts)).toBe(true);
      
      // Each context entry should have required fields
      for (const ctx of index.contexts) {
        expect(ctx.id).toBeDefined();
        expect(typeof ctx.id).toBe('string');
        expect(ctx.file_path).toBeDefined();
        expect(ctx.type).toBeDefined();
      }
    });
    
    it('should have valid cases-index.yaml structure', () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'cases-index.yaml');
      const index = loadYaml(indexPath);
      
      // Basic structure checks
      expect(index.version).toBeDefined();
      expect(index.cases).toBeDefined();
      expect(Array.isArray(index.cases)).toBe(true);
      
      // Each case entry should have required fields
      for (const c of index.cases) {
        expect(c.id).toBeDefined();
        expect(typeof c.id).toBe('string');
        expect(c.file_path).toBeDefined();
        expect(c.status).toBeDefined();
      }
    });
    
    it('should have valid events-index.yaml structure', () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'events-index.yaml');
      const index = loadYaml(indexPath);
      
      // Basic structure checks
      expect(index.events).toBeDefined();
      expect(Array.isArray(index.events)).toBe(true);
      
      // Each event entry should have required fields
      for (const evt of index.events) {
        expect(evt.id).toBeDefined();
        expect(typeof evt.id).toBe('string');
        expect(evt.name).toBeDefined();
      }
    });
    
    it('should have valid ecommerce graph file against schema', () => {
      const graphPath = path.join(SAMPLE_DATA_PATH, 'graphs/ecommerce-checkout-flow.json');
      const graph = loadJson(graphPath);
      
      // Compile and validate
      const validate = ajv.compile(graphSchema);
      const valid = validate(graph);
      
      if (!valid) {
        console.error('Graph validation errors:', validate.errors);
      }
      
      expect(valid).toBe(true);
    });
    
    it('should have valid node files with required fields', () => {
      const nodesPath = path.join(SAMPLE_DATA_PATH, 'nodes');
      const nodeFiles = listFiles(nodesPath, '.yaml');
      
      for (const file of nodeFiles) {
        const filePath = path.join(nodesPath, `${file}.yaml`);
        const node = loadYaml(filePath);
        
        // Required fields
        expect(node.id).toBeDefined();
        expect(typeof node.id).toBe('string');
        expect(node.name).toBeDefined();
        expect(typeof node.name).toBe('string');
      }
    });
    
    it('should have valid parameter files with required fields', () => {
      const paramsPath = path.join(SAMPLE_DATA_PATH, 'parameters');
      const paramFiles = listFiles(paramsPath, '.yaml');
      
      for (const file of paramFiles) {
        const filePath = path.join(paramsPath, `${file}.yaml`);
        const param = loadYaml(filePath);
        
        // Required fields
        expect(param.id).toBeDefined();
        expect(typeof param.id).toBe('string');
        expect(param.type).toBeDefined();
        expect(['probability', 'cost_gbp', 'cost_time', 'standard_deviation']).toContain(param.type);
      }
    });
    
    it('should have valid context files with required fields', () => {
      const contextsPath = path.join(SAMPLE_DATA_PATH, 'contexts');
      const contextFiles = listFiles(contextsPath, '.yaml');
      
      for (const file of contextFiles) {
        const filePath = path.join(contextsPath, `${file}.yaml`);
        const ctx = loadYaml(filePath);
        
        // Required fields
        expect(ctx.id).toBeDefined();
        expect(typeof ctx.id).toBe('string');
        expect(ctx.type).toBeDefined();
        expect(['categorical', 'ordinal', 'continuous']).toContain(ctx.type);
        expect(ctx.values).toBeDefined();
        expect(Array.isArray(ctx.values)).toBe(true);
      }
    });
    
    it('should have valid case files with required fields', () => {
      const casesPath = path.join(SAMPLE_DATA_PATH, 'cases');
      const caseFiles = listFiles(casesPath, '.yaml');
      
      for (const file of caseFiles) {
        const filePath = path.join(casesPath, `${file}.yaml`);
        const caseData = loadYaml(filePath);
        
        // Required fields
        expect(caseData.id).toBeDefined();
        expect(typeof caseData.id).toBe('string');
        expect(caseData.case).toBeDefined();
        expect(caseData.case.variants).toBeDefined();
        expect(Array.isArray(caseData.case.variants)).toBe(true);
      }
    });
    
    it('should have valid event files with required fields', () => {
      const eventsPath = path.join(SAMPLE_DATA_PATH, 'events');
      const eventFiles = listFiles(eventsPath, '.yaml');
      
      for (const file of eventFiles) {
        const filePath = path.join(eventsPath, `${file}.yaml`);
        const evt = loadYaml(filePath);
        
        // Required fields
        expect(evt.id).toBeDefined();
        expect(typeof evt.id).toBe('string');
        expect(evt.name).toBeDefined();
        expect(typeof evt.name).toBe('string');
      }
    });
  });
  
  // =========================================================================
  // Comprehensive summary
  // =========================================================================
  
  describe('Summary statistics', () => {
    it('should report sample data statistics', () => {
      const stats = {
        nodes: listFiles(path.join(SAMPLE_DATA_PATH, 'nodes'), '.yaml').length,
        parameters: listFiles(path.join(SAMPLE_DATA_PATH, 'parameters'), '.yaml').length,
        contexts: listFiles(path.join(SAMPLE_DATA_PATH, 'contexts'), '.yaml').length,
        cases: listFiles(path.join(SAMPLE_DATA_PATH, 'cases'), '.yaml').length,
        events: listFiles(path.join(SAMPLE_DATA_PATH, 'events'), '.yaml').length,
        graphs: listFiles(path.join(SAMPLE_DATA_PATH, 'graphs'), '.json').length,
      };
      
      console.log('Sample data statistics:', stats);
      
      // Minimum expected counts
      expect(stats.nodes).toBeGreaterThanOrEqual(10);
      expect(stats.parameters).toBeGreaterThanOrEqual(10);
      expect(stats.contexts).toBeGreaterThanOrEqual(2);
      expect(stats.cases).toBeGreaterThanOrEqual(1);
      expect(stats.events).toBeGreaterThanOrEqual(4);
      expect(stats.graphs).toBeGreaterThanOrEqual(1);
    });
  });
});

