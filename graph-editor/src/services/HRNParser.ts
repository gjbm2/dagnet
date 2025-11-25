/**
 * HRNParser (Human-Readable Name Parser)
 * 
 * Parses HRN (Human-Readable Name) strings into structured components.
 * 
 * Supported formats:
 * - Edges: e.<edgeId>, e.from(<fromId>).to(<toId>), e.uuid(<uuid>)
 * - Nodes: n.<nodeId>, n.uuid(<uuid>)
 * - Params: e.<edgeId>.p.mean, n.<nodeId>.entry.entry_weight
 * - Conditionals: e.<edgeId>.visited(<nodeId>).p.mean
 */

export interface ParsedHRN {
  /** Entity type: 'edge' or 'node' */
  entityType: 'edge' | 'node';
  
  /** Selector type: 'id', 'endpoints', 'uuid' */
  selectorType: 'id' | 'endpoints' | 'uuid';
  
  /** ID for 'id' selector */
  id?: string;
  
  /** From/to IDs for 'endpoints' selector */
  from?: string;
  to?: string;
  
  /** UUID for 'uuid' selector */
  uuid?: string;
  
  /** Path to parameter (e.g., ['p', 'mean']) */
  paramPath?: string[];
  
  /** Conditional clauses (e.g., ['visited(node-a)']) */
  conditionals?: string[];
  
  /** Original HRN string */
  original: string;
}

/**
 * Parse an HRN string into structured components
 */
export function parseHRN(hrn: string): ParsedHRN | null {
  if (!hrn) {
    return null;
  }
  
  const trimmed = hrn.trim();
  
  // Determine entity type
  if (trimmed.startsWith('e.') || trimmed.startsWith('edges.')) {
    return parseEdgeHRN(trimmed);
  } else if (trimmed.startsWith('n.') || trimmed.startsWith('nodes.')) {
    return parseNodeHRN(trimmed);
  }
  
  return null;
}

/**
 * Parse edge HRN
 */
function parseEdgeHRN(hrn: string): ParsedHRN | null {
  // Remove 'e.' or 'edges.' prefix
  const withoutPrefix = hrn.replace(/^(e|edges)\./, '');
  
  // Check for uuid selector: uuid(<uuid>)...
  const uuidMatch = withoutPrefix.match(/^uuid\(([^)]+)\)(.*)$/);
  if (uuidMatch) {
    const [, uuid, rest] = uuidMatch;
    const { paramPath, conditionals } = parseRest(rest);
    
    return {
      entityType: 'edge',
      selectorType: 'uuid',
      uuid,
      paramPath,
      conditionals,
      original: hrn
    };
  }
  
  // Check for endpoints selector: from(<fromId>).to(<toId>)...
  const endpointsMatch = withoutPrefix.match(/^from\(([^)]+)\)\.to\(([^)]+)\)(.*)$/);
  if (endpointsMatch) {
    const [, from, to, rest] = endpointsMatch;
    const { paramPath, conditionals } = parseRest(rest);
    
    return {
      entityType: 'edge',
      selectorType: 'endpoints',
      from,
      to,
      paramPath,
      conditionals,
      original: hrn
    };
  }
  
  // Otherwise, it's an ID selector: <edgeId>...
  const parts = withoutPrefix.split('.');
  const id = parts[0];
  const rest = '.' + parts.slice(1).join('.');
  const { paramPath, conditionals } = parseRest(rest);
  
  return {
    entityType: 'edge',
    selectorType: 'id',
    id,
    paramPath,
    conditionals,
    original: hrn
  };
}

/**
 * Parse node HRN
 */
function parseNodeHRN(hrn: string): ParsedHRN | null {
  // Remove 'n.' or 'nodes.' prefix
  const withoutPrefix = hrn.replace(/^(n|nodes)\./, '');
  
  // Check for uuid selector: uuid(<uuid>)...
  const uuidMatch = withoutPrefix.match(/^uuid\(([^)]+)\)(.*)$/);
  if (uuidMatch) {
    const [, uuid, rest] = uuidMatch;
    const { paramPath, conditionals } = parseRest(rest);
    
    return {
      entityType: 'node',
      selectorType: 'uuid',
      uuid,
      paramPath,
      conditionals,
      original: hrn
    };
  }
  
  // Otherwise, it's an ID selector: <nodeId>...
  const parts = withoutPrefix.split('.');
  const id = parts[0];
  const rest = '.' + parts.slice(1).join('.');
  const { paramPath, conditionals } = parseRest(rest);
  
  return {
    entityType: 'node',
    selectorType: 'id',
    id,
    paramPath,
    conditionals,
    original: hrn
  };
}

/**
 * Parse the rest of the HRN (after entity selector)
 * Extracts param path and conditionals
 */
function parseRest(rest: string): { paramPath: string[]; conditionals: string[] } {
  if (!rest || rest === '.') {
    return { paramPath: [], conditionals: [] };
  }
  
  // Extract conditionals (visited(), !visited())
  const conditionals: string[] = [];
  let remaining = rest;
  
  const conditionalRegex = /\.(!?visited\([^)]+\))/g;
  let match;
  while ((match = conditionalRegex.exec(remaining)) !== null) {
    conditionals.push(match[1]);
    remaining = remaining.replace(match[0], '');
  }
  
  // What's left is the param path
  const paramPath = remaining
    .split('.')
    .filter(part => part.length > 0);
  
  return { paramPath, conditionals };
}

/**
 * Build HRN string from components
 */
export function buildHRN(parsed: ParsedHRN): string {
  let hrn = '';
  
  // Entity type prefix
  hrn += parsed.entityType === 'edge' ? 'e.' : 'n.';
  
  // Selector
  if (parsed.selectorType === 'uuid' && parsed.uuid) {
    hrn += `uuid(${parsed.uuid})`;
  } else if (parsed.selectorType === 'endpoints' && parsed.from && parsed.to) {
    hrn += `from(${parsed.from}).to(${parsed.to})`;
  } else if (parsed.selectorType === 'id' && parsed.id) {
    hrn += parsed.id;
  }
  
  // Conditionals
  if (parsed.conditionals && parsed.conditionals.length > 0) {
    hrn += '.' + parsed.conditionals.join('.');
  }
  
  // Param path
  if (parsed.paramPath && parsed.paramPath.length > 0) {
    hrn += '.' + parsed.paramPath.join('.');
  }
  
  return hrn;
}







