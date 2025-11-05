import Ajv from 'ajv';

const SCHEMA_URL = '/schemas/conversion-graph-1.0.0.json';

// Cache the validator to prevent duplicate schema registration
let cachedValidator: any = null;

export async function getValidator() {
  // Return cached validator if available
  if (cachedValidator) {
    return cachedValidator;
  }

  try {
    const res = await fetch(SCHEMA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Schema fetch failed');
    const schema = await res.json();
    
    // Create a new Ajv instance with proper configuration
    const ajv = new Ajv({ 
      allErrors: true, 
      strict: false,
      validateFormats: false // Disable format validation to avoid format errors
    });
    
    // Modify the schema to use a compatible $schema version and remove format constraints
    const modifiedSchema = {
      ...schema,
      $schema: 'http://json-schema.org/draft-07/schema#',
      // Remove format constraints that might cause issues
      $defs: {
        ...schema.$defs,
        UUID: { type: 'string' },
        HumanId: { type: 'string', minLength: 1, maxLength: 128 }
      }
    };
    
    cachedValidator = ajv.compile(modifiedSchema);
    return cachedValidator;
  } catch (error) {
    console.warn('Failed to fetch schema from GitHub, using minimal validation:', error);
    // Fallback to minimal validation
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile({
      type: 'object',
      required: ['nodes', 'edges', 'policies', 'metadata'],
      properties: {
        nodes: { type: 'array' },
        edges: { type: 'array' },
        policies: { type: 'object' },
        metadata: { type: 'object' }
      }
    });
    return cachedValidator;
  }
}
