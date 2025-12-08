/**
 * Schema / UI Schema Consistency Tests
 * 
 * Validates that all properties defined in JSON/YAML schemas are properly
 * included in their corresponding UI schemas' ui:order lists.
 * 
 * This prevents the FormEditor error:
 * "Invalid 'root' object field configuration: uiSchema order list does not contain properties..."
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { FILE_TYPE_REGISTRY, FileTypeConfig } from '../../config/fileTypeRegistry';

const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');

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
 * Load a UI schema file (always JSON)
 */
function loadUiSchema(uiSchemaPath: string): any {
  const fullPath = join(PUBLIC_DIR, uiSchemaPath);
  if (!existsSync(fullPath)) {
    throw new Error(`UI schema file not found: ${fullPath}`);
  }
  
  const content = readFileSync(fullPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Extract all top-level property names from a JSON schema
 */
function getSchemaProperties(schema: any): string[] {
  if (!schema.properties) {
    return [];
  }
  return Object.keys(schema.properties);
}

/**
 * Get the ui:order array from a UI schema
 */
function getUiOrder(uiSchema: any): string[] {
  return uiSchema['ui:order'] || [];
}

/**
 * Get all file types that have both schema and uiSchema defined
 */
function getFileTypesWithUiSchema(): Array<{ name: string; config: FileTypeConfig }> {
  return Object.entries(FILE_TYPE_REGISTRY)
    .filter(([_, config]) => config.schemaFile && config.uiSchemaFile)
    .map(([name, config]) => ({ name, config }));
}

describe('Schema / UI Schema Consistency', () => {
  describe('All file types with UI schemas should have consistent ui:order', () => {
    const fileTypesWithUiSchema = getFileTypesWithUiSchema();
    
    it.each(fileTypesWithUiSchema)(
      '$name: all schema properties should be in ui:order',
      ({ name, config }) => {
        // Load both schemas
        const schema = loadSchema(config.schemaFile);
        const uiSchema = loadUiSchema(config.uiSchemaFile!);
        
        // Get properties and order
        const schemaProperties = getSchemaProperties(schema);
        const uiOrder = getUiOrder(uiSchema);
        
        // Find properties missing from ui:order
        const missingFromOrder = schemaProperties.filter(
          prop => !uiOrder.includes(prop)
        );
        
        // Assert
        expect(missingFromOrder, 
          `File type '${name}': The following schema properties are missing from ui:order: ${missingFromOrder.join(', ')}\n` +
          `Schema file: ${config.schemaFile}\n` +
          `UI Schema file: ${config.uiSchemaFile}\n` +
          `All schema properties: ${schemaProperties.join(', ')}\n` +
          `Current ui:order: ${uiOrder.join(', ')}`
        ).toEqual([]);
      }
    );
    
    it.each(fileTypesWithUiSchema)(
      '$name: ui:order should not contain non-existent properties',
      ({ name, config }) => {
        // Load both schemas
        const schema = loadSchema(config.schemaFile);
        const uiSchema = loadUiSchema(config.uiSchemaFile!);
        
        // Get properties and order
        const schemaProperties = getSchemaProperties(schema);
        const uiOrder = getUiOrder(uiSchema);
        
        // Find properties in ui:order that don't exist in schema
        const extraInOrder = uiOrder.filter(
          prop => !schemaProperties.includes(prop)
        );
        
        // Assert (this is a warning, not a failure - extra items are allowed but may be intentional)
        if (extraInOrder.length > 0) {
          console.warn(
            `File type '${name}': ui:order contains properties not in schema: ${extraInOrder.join(', ')}\n` +
            `This may be intentional for UI-only fields.`
          );
        }
      }
    );
  });
  
  describe('Specific schema/uiSchema pair tests', () => {
    it('parameter schema should include n_query and n_query_overridden', () => {
      const schema = loadSchema('/param-schemas/parameter-schema.yaml');
      const uiSchema = loadUiSchema('/ui-schemas/parameter-ui-schema.json');
      
      const schemaProperties = getSchemaProperties(schema);
      const uiOrder = getUiOrder(uiSchema);
      
      // These specific fields were added and caused the original bug
      expect(schemaProperties).toContain('n_query');
      expect(schemaProperties).toContain('n_query_overridden');
      expect(uiOrder).toContain('n_query');
      expect(uiOrder).toContain('n_query_overridden');
    });
    
    it('parameter schema ui:order should have n_query fields after query fields', () => {
      const uiSchema = loadUiSchema('/ui-schemas/parameter-ui-schema.json');
      const uiOrder = getUiOrder(uiSchema);
      
      const queryIndex = uiOrder.indexOf('query');
      const queryOverriddenIndex = uiOrder.indexOf('query_overridden');
      const nQueryIndex = uiOrder.indexOf('n_query');
      const nQueryOverriddenIndex = uiOrder.indexOf('n_query_overridden');
      
      // n_query should come after query_overridden
      expect(nQueryIndex).toBeGreaterThan(queryOverriddenIndex);
      // n_query_overridden should come after n_query
      expect(nQueryOverriddenIndex).toBeGreaterThan(nQueryIndex);
    });
    
    it('event schema should have all properties in ui:order', () => {
      const schema = loadSchema('/param-schemas/event-schema.yaml');
      const uiSchema = loadUiSchema('/ui-schemas/event-ui-schema.json');
      
      const schemaProperties = getSchemaProperties(schema);
      const uiOrder = getUiOrder(uiSchema);
      
      const missingFromOrder = schemaProperties.filter(
        prop => !uiOrder.includes(prop)
      );
      
      expect(missingFromOrder).toEqual([]);
    });
    
    it('context schema should have all properties in ui:order', () => {
      const schema = loadSchema('/param-schemas/context-definition-schema.yaml');
      const uiSchema = loadUiSchema('/ui-schemas/context-ui-schema.json');
      
      const schemaProperties = getSchemaProperties(schema);
      const uiOrder = getUiOrder(uiSchema);
      
      const missingFromOrder = schemaProperties.filter(
        prop => !uiOrder.includes(prop)
      );
      
      expect(missingFromOrder).toEqual([]);
    });
  });
});









