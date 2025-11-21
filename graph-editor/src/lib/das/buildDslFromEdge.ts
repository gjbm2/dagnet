/**
 * Build DSL execution object from edge.p.query + graph nodes
 * 
 * CRITICAL: 
 * - Query stores NODE references (node.id), must look up nodes to get event_ids
 * - Event IDs are then mapped to provider-specific event names if available
 * 
 * @param edge - The edge with p.query object
 * @param graph - The full graph (needed to resolve node IDs)
 * @param connectionProvider - Provider name from connection (e.g., "amplitude")
 * @param eventLoader - Function to load event definitions (optional)
 * @returns DSL object with resolved provider-specific event names
 * @throws Error if nodes not found or missing event_ids
 */
import { parseDSL } from '../queryDSL';

export interface EventFilter {
  property: string;
  operator: string;
  values: string[];
}

export interface DslObject {
  from: string;
  to: string;
  visited?: string[];
  exclude?: string[];
  visitedAny?: string[][];
  context?: Array<{ key: string; value: string }>;
  case?: Array<{ key: string; value: string }>;
  event_filters?: Record<string, EventFilter[]>; // Map of event_name -> filters
}

export interface EventDefinition {
  id: string;
  name: string;
  provider_event_names?: Record<string, string>;
  amplitude_filters?: EventFilter[];
  [key: string]: any;
}

export type EventLoader = (eventId: string) => Promise<EventDefinition>;

/**
 * Parse query string like "from(a).to(b).visited(c)" into object
 * @deprecated Use parseDSL() from queryDSL.ts instead
 */
function parseQueryString(queryString: string): any {
  const parsed = parseDSL(queryString);
  
  // Convert to legacy format for backward compatibility
  const query: any = {
    from: parsed.from,
    to: parsed.to,
    visited: parsed.visited,
    exclude: parsed.exclude,
    context: parsed.context.map(({key, value}) => ({ key, value })),
    case: parsed.cases.map(({key, value}) => ({ key, value }))
  };
  
  return query;
}

export async function buildDslFromEdge(
  edge: any,
  graph: any,
  connectionProvider?: string,
  eventLoader?: EventLoader
): Promise<DslObject> {
  // Edge.query is a string: "from(nodeA).to(nodeB).visited(nodeC)"
  // We need to parse it, look up nodes to get event_ids,
  // then map event_ids to provider-specific event names
  
  const queryString = edge.query;
  if (!queryString || typeof queryString !== 'string') {
    throw new Error(
      `Edge missing query string: ${edge.from} → ${edge.to}\n\n` +
      `To fix:\n` +
      `1. Ensure edge.query is defined\n` +
      `2. Query should be string like: "from(nodeA).to(nodeB)"`
    );
  }
  
  // Parse query string to extract node references
  const query = parseQueryString(queryString);
  if (!query.from || !query.to) {
    throw new Error(
      `Invalid query format: "${queryString}"\n\n` +
      `Expected format: "from(nodeA).to(nodeB)"\n` +
      `Got: from="${query.from || 'missing'}", to="${query.to || 'missing'}"`
    );
  }
  
  // Helper to find node by ID or UUID
  // NOTE: Queries primarily use node.id (human-readable), not node.uuid
  const findNode = (ref: string): any | undefined => {
    // Try by id first (most common)
    let node = graph.nodes.find((n: any) => n.id === ref);
    
    // Fallback to uuid (edge case)
    if (!node) {
      node = graph.nodes.find((n: any) => n.uuid === ref);
    }
    
    return node;
  };
  
  // Track event filters
  const eventFilters: Record<string, EventFilter[]> = {};
  
  // Helper to resolve event_id to provider-specific event name and collect filters
  const resolveEventName = async (eventId: string): Promise<string> => {
    // If no event loader or no provider specified, return event_id as-is
    if (!eventLoader || !connectionProvider) {
      return eventId;
    }
    
    try {
      // Load event definition
      const eventDef = await eventLoader(eventId);
      
      // Check for provider-specific mapping
      const providerEventName = eventDef.provider_event_names?.[connectionProvider];
      
      if (providerEventName) {
        console.log(`Mapped event_id "${eventId}" → "${providerEventName}" for provider "${connectionProvider}"`);
        
        // Collect Amplitude filters if this is Amplitude provider
        if (connectionProvider === 'amplitude' && eventDef.amplitude_filters) {
          eventFilters[providerEventName] = eventDef.amplitude_filters;
          console.log(`Added filters for "${providerEventName}":`, eventDef.amplitude_filters);
        }
        
        return providerEventName;
      }
      
      // No mapping found, use event_id as fallback
      console.log(`No provider mapping for "${eventId}" on "${connectionProvider}", using event_id as-is`);
      return eventId;
    } catch (error) {
      // Event file doesn't exist or can't be loaded - use event_id as fallback
      console.warn(`Could not load event definition for "${eventId}":`, error);
      return eventId;
    }
  };
  
  // Look up from/to nodes using query references
  const fromNode = findNode(query.from);
  const toNode = findNode(query.to);
  
  // Validate nodes exist
  if (!fromNode || !toNode) {
    const availableNodes = graph.nodes.map((n: any) => n.id).join(', ');
    throw new Error(
      `Query nodes not found:\n` +
      `  from: "${query.from}" → ${fromNode ? '✓ found' : '✗ NOT FOUND'}\n` +
      `  to: "${query.to}" → ${toNode ? '✓ found' : '✗ NOT FOUND'}\n\n` +
      `Available nodes: ${availableNodes}\n\n` +
      `To fix:\n` +
      `1. Check that query.from and query.to reference valid node IDs\n` +
      `2. Node IDs are case-sensitive`
    );
  }

  // Extract event_ids from nodes
  const from_event_id = fromNode.event_id;
  const to_event_id = toNode.event_id;
  
  // Validate event_ids exist (graceful failure with clear guidance)
  if (!from_event_id || !to_event_id) {
    throw new Error(
      `Nodes must have event_id field to fetch external data:\n` +
      `  "${fromNode.label || fromNode.id}": event_id = ${from_event_id || 'MISSING'}\n` +
      `  "${toNode.label || toNode.id}": event_id = ${to_event_id || 'MISSING'}\n\n` +
      `To fix:\n` +
      `1. Open node properties in the graph editor\n` +
      `2. Set event_id to the external system event name\n` +
      `   - For Amplitude: the event_type (e.g., "checkout_page_viewed")\n` +
      `   - For SQL: the event name in your events table\n` +
      `3. Try "Get from source" again`
    );
  }
  
  // Resolve provider-specific event names
  const from_event_name = await resolveEventName(from_event_id);
  const to_event_name = await resolveEventName(to_event_id);
  
  // Look up visited nodes and extract their event_ids
  const visited_event_names: string[] = [];
  if (query.visited && Array.isArray(query.visited)) {
    for (const ref of query.visited) {
      const node = findNode(ref);
      if (!node) {
        throw new Error(
          `Visited node not found: "${ref}"\n\n` +
          `Available nodes: ${graph.nodes.map((n: any) => n.id).join(', ')}`
        );
      }
      if (!node.event_id) {
        throw new Error(
          `Visited node "${node.label || node.id}" missing event_id field`
        );
      }
      const eventName = await resolveEventName(node.event_id);
      visited_event_names.push(eventName);
    }
  }
  
  // Look up exclude nodes and extract their event_ids
  const exclude_event_names: string[] = [];
  if (query.exclude && Array.isArray(query.exclude)) {
    for (const ref of query.exclude) {
      const node = findNode(ref);
      if (!node) {
        throw new Error(
          `Exclude node not found: "${ref}"\n\n` +
          `Available nodes: ${graph.nodes.map((n: any) => n.id).join(', ')}`
        );
      }
      if (!node.event_id) {
        throw new Error(
          `Exclude node "${node.label || node.id}" missing event_id field`
        );
      }
      const eventName = await resolveEventName(node.event_id);
      exclude_event_names.push(eventName);
    }
  }
  
  // Look up visitedAny nodes (groups of OR conditions)
  const visitedAny_event_names: string[][] = [];
  if (query.visitedAny && Array.isArray(query.visitedAny)) {
    for (const group of query.visitedAny) {
      if (!Array.isArray(group)) continue;
      
      const groupEventNames: string[] = [];
      for (const ref of group) {
        const node = findNode(ref);
        if (!node) {
          throw new Error(
            `VisitedAny node not found: "${ref}"\n\n` +
            `Available nodes: ${graph.nodes.map((n: any) => n.id).join(', ')}`
          );
        }
        if (!node.event_id) {
          throw new Error(
            `VisitedAny node "${node.label || node.id}" missing event_id field`
          );
        }
        const eventName = await resolveEventName(node.event_id);
        groupEventNames.push(eventName);
      }
      visitedAny_event_names.push(groupEventNames);
    }
  }
  
  // Build DSL object with provider-specific event names
  const dsl: DslObject = {
    from: from_event_name,
    to: to_event_name
  };
  
  // Add optional constraints
  if (visited_event_names.length > 0) {
    dsl.visited = visited_event_names;
  }
  
  if (exclude_event_names.length > 0) {
    dsl.exclude = exclude_event_names;
  }
  
  if (visitedAny_event_names.length > 0) {
    dsl.visitedAny = visitedAny_event_names;
  }
  
  // Pass through context and case filters (no node lookup needed)
  if (query.context) {
    dsl.context = query.context;
  }
  
  if (query.case) {
    dsl.case = query.case;
  }
  
  // Add event filters if any were collected
  if (Object.keys(eventFilters).length > 0) {
    dsl.event_filters = eventFilters;
    console.log('DSL with event filters:', dsl.event_filters);
  }
  
  // ===== DIAGNOSTIC: Show final DSL and what was NOT preserved =====
  console.log('[buildDslFromEdge] Final DSL:', dsl);
  console.log('[buildDslFromEdge] Original query had minus():', edge.query?.includes('.minus('));
  console.log('[buildDslFromEdge] Original query had plus():', edge.query?.includes('.plus('));
  console.log('[buildDslFromEdge] WARNING: minus()/plus() terms are NOT preserved in DSL object');
  console.log('[buildDslFromEdge] Composite query execution must check edge.query BEFORE calling buildDslFromEdge');
  // ================================================================
  
  return dsl;
}

