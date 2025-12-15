import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadYamlOrJson(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(content);
  }
  return YAML.parse(content);
}

describe('Repo root test.json schema validation', () => {
  it('should validate /test.json against conversion-graph-1.1.0 schema', () => {
    const schemaPath = path.resolve(__dirname, '../../../public/schemas/conversion-graph-1.1.0.json');
    // __dirname is: graph-editor/src/services/__tests__
    // Up 4 => repo root
    const testGraphPath = path.resolve(__dirname, '../../../../test.json');

    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(fs.existsSync(testGraphPath)).toBe(true);

    const schema = loadJson(schemaPath);
    const graph = loadYamlOrJson(testGraphPath);

    const validate = ajv.compile(schema);
    const valid = validate(graph);

    if (!valid) {
      // eslint-disable-next-line no-console
      console.error('Schema validation errors for /test.json:', validate.errors);
    }

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });
});


