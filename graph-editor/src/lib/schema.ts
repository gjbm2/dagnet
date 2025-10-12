import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

const SCHEMA_URL = 'https://raw.githubusercontent.com/gjbm2/dagnet/main/schema/conversion-graph-1.0.0.json';

export async function getValidator() {
  try {
    const res = await fetch(SCHEMA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Schema fetch failed');
    const schema = await res.json();
    return ajv.compile(schema);
  } catch (error) {
    console.warn('Failed to fetch schema from GitHub, using minimal validation:', error);
    // Fallback to minimal validation
    return ajv.compile({
      type: 'object',
      required: ['nodes', 'edges', 'policies', 'metadata'],
      properties: {
        nodes: { type: 'array' },
        edges: { type: 'array' },
        policies: { type: 'object' },
        metadata: { type: 'object' }
      }
    });
  }
}
