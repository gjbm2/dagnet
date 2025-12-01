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
 * @param constraints - Optional parsed constraints (context filters, window)
 * @returns DSL object with resolved provider-specific event names
 * @throws Error if nodes not found or missing event_ids
 */
import { parseDSL, type ParsedConstraints } from '../queryDSL';
import { contextRegistry } from '../../services/contextRegistry';
import { querySignatureService } from '../../services/querySignatureService';
import { parseUKDate, formatDateUK } from '../dateFormat';

export interface EventFilter {
  property: string;
  operator: string;
  values: string[];
}

/**
 * Context filter object for structured passing to adapters.
 * This allows adapters to build provider-specific filter syntax.
 */
export interface ContextFilterObject {
  field: string;           // Property name (e.g., "utm_medium")
  op: 'is' | 'is not' | 'matches';  // Operator
  values: string[];        // Values to match
  pattern?: string;        // Regex pattern (if op is 'matches')
  patternFlags?: string;   // Regex flags (e.g., 'i' for case-insensitive)
}

/**
 * QueryPayload - Structured query data passed to the DAS adapter.
 * NOT a DSL string - this is the resolved, graph-aware payload.
 * 
 * - from/to: event_ids from node references
 * - visited/visited_upstream: categorized by graph topology
 * - visitedAny/visitedAny_upstream: groups categorized by graph topology
 */
export interface QueryPayload {
  from: string;                    // event_id of the 'from' node
  to: string;                      // event_id of the 'to' node
  visited?: string[];              // Visited nodes BETWEEN from and to
  visited_upstream?: string[];     // Visited nodes BEFORE from (for super-funnel construction)
  visitedAny?: string[][];         // Groups of visited nodes BETWEEN from and to (OR within group)
  visitedAny_upstream?: string[][]; // Groups of visited nodes BEFORE from (OR within group)
  exclude?: string[];
  context?: Array<{ key: string; value: string }>;
  case?: Array<{ key: string; value: string }>;
  context_filters?: ContextFilterObject[]; // Structured context filters for this query
  start?: string; // Start date (ISO format)
  end?: string; // End date (ISO format)
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

export interface BuildQueryPayloadResult {
  queryPayload: QueryPayload;
  eventDefinitions: Record<string, EventDefinition>;
}


export async function buildDslFromEdge(
  edge: any,
  graph: any,
  connectionProvider?: string,
  eventLoader?: EventLoader,
  constraints?: ParsedConstraints
): Promise<BuildQueryPayloadResult> {
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
  
  // Collect event definitions for all referenced events
  // These will be passed separately to the adapter (NOT embedded in DSL)
  const eventDefinitions: Record<string, EventDefinition> = {};
  
  // Helper to load event definition and collect it
  // Returns the event_id unchanged - provider translation happens in the adapter
  const loadEventDefinition = async (eventId: string): Promise<string> => {
    if (!eventLoader) {
      return eventId;
    }
    
    try {
      const eventDef = await eventLoader(eventId);
      eventDefinitions[eventId] = eventDef;
      console.log(`Loaded event definition for "${eventId}"`);
      return eventId;
    } catch (error) {
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
  
  // Load event definitions for from/to (for passing to adapter)
  await loadEventDefinition(from_event_id);
  await loadEventDefinition(to_event_id);
  
  // Look up visited nodes and extract their event_ids
  // CRITICAL: Categorize visited nodes as upstream vs between
  // - visited_upstream: nodes that must be visited BEFORE 'from' (for super-funnel construction)
  // - visited: nodes that must be visited BETWEEN 'from' and 'to' (standard funnel)
  const visited_ids: string[] = [];
  const visited_upstream_ids: string[] = [];
  
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
      
      // Load event definition for this visited node
      await loadEventDefinition(node.event_id);
      
      // Determine if visited node is upstream of 'from' node
      const isUpstreamOfFrom = isNodeUpstream(node.id, query.from, graph);
      
      if (isUpstreamOfFrom) {
        console.log(`[buildDslFromEdge] Visited node "${ref}" is UPSTREAM of from node "${query.from}"`);
        visited_upstream_ids.push(node.event_id);
      } else {
        console.log(`[buildDslFromEdge] Visited node "${ref}" is BETWEEN from/to nodes`);
        visited_ids.push(node.event_id);
      }
    }
  }
  
  // Look up exclude nodes and extract their event_ids
  const exclude_ids: string[] = [];
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
      await loadEventDefinition(node.event_id);
      exclude_ids.push(node.event_id);
    }
  }
  
  // Look up visitedAny nodes (groups of OR conditions)
  // IMPORTANT: Each group needs to be categorized by topology too
  // A group is "upstream" if ALL nodes in it are upstream of 'from'
  // Otherwise it's "between" (mixed groups go to between for safety)
  const visitedAny_between: string[][] = [];
  const visitedAny_upstream: string[][] = [];
  
  if (query.visitedAny && Array.isArray(query.visitedAny)) {
    for (const group of query.visitedAny) {
      if (!Array.isArray(group)) continue;
      
      const groupIds: string[] = [];
      let allUpstream = true;
      
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
        await loadEventDefinition(node.event_id);
        groupIds.push(node.event_id);
        
        // Check if this node is upstream of 'from'
        const isUpstreamOfFrom = isNodeUpstream(node.id, query.from, graph);
        if (!isUpstreamOfFrom) {
          allUpstream = false;
        }
      }
      
      // Categorize the entire group
      if (allUpstream && groupIds.length > 0) {
        visitedAny_upstream.push(groupIds);
        console.log(`[buildDslFromEdge] VisitedAny group [${groupIds.join(', ')}] is UPSTREAM`);
      } else if (groupIds.length > 0) {
        visitedAny_between.push(groupIds);
        console.log(`[buildDslFromEdge] VisitedAny group [${groupIds.join(', ')}] is BETWEEN (or mixed)`);
      }
    }
  }
  
  // Build query payload with event_ids (adapter will translate to provider names)
  const queryPayload: QueryPayload = {
    from: from_event_id,
    to: to_event_id
  };
  
  // Add optional constraints (all using event_ids)
  if (visited_ids.length > 0) {
    queryPayload.visited = visited_ids;
  }
  
  // Add upstream visited nodes (for super-funnel construction)
  if (visited_upstream_ids.length > 0) {
    queryPayload.visited_upstream = visited_upstream_ids;
    console.log(`[buildQueryPayload] Added ${visited_upstream_ids.length} upstream visited node(s) for super-funnel`);
  }
  
  if (exclude_ids.length > 0) {
    queryPayload.exclude = exclude_ids;
  }
  
  if (visitedAny_between.length > 0) {
    queryPayload.visitedAny = visitedAny_between;
  }
  
  if (visitedAny_upstream.length > 0) {
    queryPayload.visitedAny_upstream = visitedAny_upstream;
    console.log(`[buildQueryPayload] Added ${visitedAny_upstream.length} upstream visitedAny group(s) for super-funnel`);
  }
  
  // Pass through context and case filters (no node lookup needed)
  if (query.context) {
    queryPayload.context = query.context;
  }
  
  if (query.case) {
    queryPayload.case = query.case;
  }
  
  // Event definitions are returned separately (not embedded in query payload)
  
  // Add context filters if constraints provided
  if (constraints && (constraints.context.length > 0 || constraints.contextAny.length > 0)) {
    try {
      const contextFilters = await buildContextFilters(constraints, connectionProvider || 'amplitude');
      if (contextFilters && contextFilters.length > 0) {
        queryPayload.context_filters = contextFilters;
        console.log('[buildQueryPayload] Added context filters:', queryPayload.context_filters);
      }
    } catch (error) {
      console.error('[buildQueryPayload] Failed to build context filters:', error);
      throw error;
    }
  }
  
  // Add window/date range if constraints provided
  if (constraints && constraints.window) {
    try {
      // DEBUG: Log input to resolveWindowDates
      console.log('[buildQueryPayload] Input window strings:', constraints.window);
      
      const { startDate, endDate } = resolveWindowDates(constraints.window);
      
      // DEBUG: Log the Date objects before toISOString
      console.log('[buildQueryPayload] Resolved Date objects:', {
        startDate: startDate ? startDate.toString() : null,
        startDateUTC: startDate ? startDate.toUTCString() : null,
        startDateISO: startDate ? startDate.toISOString() : null,
        endDate: endDate ? endDate.toString() : null,
        endDateUTC: endDate ? endDate.toUTCString() : null,
        endDateISO: endDate ? endDate.toISOString() : null
      });
      
      if (startDate) {
        queryPayload.start = startDate.toISOString();
      }
      if (endDate) {
        queryPayload.end = endDate.toISOString();
      }
      console.log('[buildQueryPayload] Added window:', { start: queryPayload.start, end: queryPayload.end });
    } catch (error) {
      console.error('[buildQueryPayload] Failed to resolve window dates:', error);
      throw error;
    }
  }
  
  // ===== DIAGNOSTIC: Show final query payload and what was NOT preserved =====
  console.log('[buildQueryPayload] Final payload:', queryPayload);
  console.log('[buildQueryPayload] Original query string had minus():', edge.query?.includes('.minus('));
  console.log('[buildQueryPayload] Original query string had plus():', edge.query?.includes('.plus('));
  console.log('[buildQueryPayload] WARNING: minus()/plus() terms are NOT preserved in query payload');
  console.log('[buildQueryPayload] Composite query execution must check edge.query BEFORE calling buildQueryPayload');
  // ================================================================
  
  return { queryPayload, eventDefinitions };
}

/**
 * Build context filters from parsed constraints.
 * Returns structured filter objects that adapters can convert to provider-specific syntax.
 * 
 * @param constraints - Parsed constraints with context and contextAny
 * @param source - Source name (e.g., "amplitude")
 * @returns Array of structured filter objects
 */
async function buildContextFilters(
  constraints: ParsedConstraints,
  source: string
): Promise<ContextFilterObject[] | undefined> {
  const filters: ContextFilterObject[] = [];
  
  // Process context(...) constraints (single value per key)
  for (const ctx of constraints.context) {
    const filter = await buildFilterObjectForContextValue(ctx.key, ctx.value, source);
    if (filter === null) {
      // otherPolicy: null means query all data (no filtering)
      return undefined;
    }
    filters.push(filter);
  }
  
  // Process contextAny(...) constraints (OR within key, AND across keys)
  // contextAny(channel:X,channel:Y) means "channel is X OR channel is Y"
  // This should produce ONE filter with multiple values, not multiple filters
  for (const ctxAny of constraints.contextAny) {
    // Group pairs by key
    const byKey = new Map<string, string[]>();
    for (const pair of ctxAny.pairs) {
      if (!byKey.has(pair.key)) {
        byKey.set(pair.key, []);
      }
      byKey.get(pair.key)!.push(pair.value);
    }
    
    // For each key, collect all values/patterns into one filter object
    for (const [key, values] of byKey.entries()) {
      // Check if "other" is in the list
      const hasOther = values.includes('other');
      const explicitValues = values.filter(v => v !== 'other');
      
      // If ONLY "other" is selected, use computed NOT filter
      if (hasOther && explicitValues.length === 0) {
        const filterObj = await buildFilterObjectForContextValue(key, 'other', source);
        if (filterObj === null) {
          return undefined;
        }
        filters.push(filterObj);
        continue;
      }
      
      // If "other" + explicit values: this is "everything except some values"
      // We need to compute which values are NOT selected
      // For now, collect the explicit values' filters
      const allValues: string[] = [];
      const allPatterns: string[] = [];
      let field: string = key;
      let patternFlags: string | undefined;
      
      for (const value of explicitValues) {
        const filterObj = await buildFilterObjectForContextValue(key, value, source);
        if (filterObj === null) {
          return undefined;
        }
        
        field = filterObj.field;
        
        if (filterObj.pattern) {
          allPatterns.push(filterObj.pattern);
          patternFlags = filterObj.patternFlags;
        } else {
          allValues.push(...filterObj.values);
        }
      }
      
      // If "other" is also selected, we need to include "everything else"
      // This means: NOT(values NOT in our selection)
      // Which is equivalent to: just don't filter at all, OR filter for the opposite
      if (hasOther) {
        // Get the context definition to find what values are NOT selected
        const contextDef = await contextRegistry.getContext(key);
        if (contextDef) {
          const allContextValues = contextDef.values
            .filter((v: any) => v.id !== 'other')
            .map((v: any) => v.id);
          const notSelected = allContextValues.filter((v: string) => !explicitValues.includes(v));
          
          if (notSelected.length === 0) {
            // All values selected + other = no filter needed
            continue;
          }
          
          // Build a NOT filter for the values that are NOT selected
          const notSelectedFilters: string[] = [];
          const notSelectedPatterns: string[] = [];
          let notField: string = key;
          let notPatternFlags: string | undefined;
          
          for (const value of notSelected) {
            const filterObj = await buildFilterObjectForContextValue(key, value, source);
            if (filterObj === null) continue;
            
            notField = filterObj.field;
            
            if (filterObj.pattern) {
              notSelectedPatterns.push(filterObj.pattern);
              notPatternFlags = filterObj.patternFlags;
            } else {
              notSelectedFilters.push(...filterObj.values);
            }
          }
          
          // Build "is not" filter for values NOT selected
          if (notSelectedPatterns.length > 0 && notSelectedFilters.length > 0) {
            const combinedPattern = [...notSelectedPatterns, ...notSelectedFilters.map(v => escapeRegex(v))].join('|');
            filters.push({
              field: notField,
              op: 'is not',
              values: [],
              pattern: combinedPattern,
              patternFlags: notPatternFlags || 'i'
            });
          } else if (notSelectedPatterns.length > 0) {
            filters.push({
              field: notField,
              op: 'is not',
              values: [],
              pattern: notSelectedPatterns.join('|'),
              patternFlags: notPatternFlags || 'i'
            });
          } else if (notSelectedFilters.length > 0) {
            filters.push({
              field: notField,
              op: 'is not',
              values: notSelectedFilters
            });
          }
          continue;
        }
      }
      
      // Build combined filter object for explicit values only (no "other")
      if (allPatterns.length > 0 && allValues.length > 0) {
        // Mix of patterns and values - combine into regex
        const combinedPattern = [...allPatterns, ...allValues.map(v => escapeRegex(v))].join('|');
        filters.push({
          field,
          op: 'is',
          values: [],
          pattern: combinedPattern,
          patternFlags: patternFlags || 'i'
        });
      } else if (allPatterns.length > 0) {
        // All patterns - combine into single regex
        filters.push({
          field,
          op: 'is',
          values: [],
          pattern: allPatterns.join('|'),
          patternFlags: patternFlags || 'i'
        });
      } else {
        // All values - use "is" with array
        filters.push({
          field,
          op: 'is',
          values: allValues
        });
      }
    }
  }
  
  return filters;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build structured filter object for a specific (key, value) pair.
 * Handles otherPolicy and regex patterns.
 * 
 * @param key - Context key (e.g., "channel")
 * @param value - Context value (e.g., "google")
 * @param source - Source name (e.g., "amplitude")
 * @returns Structured filter object, or null if no filter needed
 */
async function buildFilterObjectForContextValue(
  key: string,
  value: string,
  source: string
): Promise<ContextFilterObject | null> {
  const contextDef = await contextRegistry.getContext(key);
  if (!contextDef) {
    throw new Error(`Context definition not found: ${key}`);
  }
  
  // Handle "other" value with special policies BEFORE getting mapping
  if (value === 'other') {
    const valueDef = contextDef.values.find((v: any) => v.id === 'other');
    // otherPolicy can be on the value's source mapping or on the context definition
    const otherPolicy = (valueDef?.sources?.[source] as any)?.otherPolicy || contextDef.otherPolicy;
    
    if (otherPolicy === 'null') {
      // No filter needed - query all data
      return null;
    }
    
    if (otherPolicy === 'undefined') {
      throw new Error(`Cannot query ${key}:other with otherPolicy=undefined (value not defined)`);
    }
    
    if (otherPolicy === 'computed') {
      return await buildComputedOtherFilterObject(key, source, contextDef);
    }
    
    if (otherPolicy === 'explicit') {
      const mapping = await contextRegistry.getSourceMapping(key, value, source);
      if (!mapping || (!mapping.filter && !mapping.pattern)) {
        throw new Error(`otherPolicy='explicit' but no filter/pattern defined for ${key}:other`);
      }
      // Fall through to use the mapping
    }
  }
  
  // Get mapping for regular values or explicit "other"
  const mapping = await contextRegistry.getSourceMapping(key, value, source);
  
  // Regular value: use mapping
  if (!mapping) {
    throw new Error(`No ${source} mapping for ${key}:${value}`);
  }
  
  const field = mapping.field || key;
  
  // If pattern provided, return regex filter
  if (mapping.pattern) {
    return {
      field,
      op: 'matches',
      values: [],
      pattern: mapping.pattern,
      patternFlags: mapping.patternFlags || ''
    };
  }
  
  // If explicit filter string provided, parse it to extract value
  if (mapping.filter) {
    // Parse simple filter: "field == 'value'" or "field = 'value'"
    // Field name can contain spaces (e.g., "Device family == 'iOS'")
    const eqMatch = mapping.filter.match(/(.+?)\s*==?\s*'([^']+)'/);
    if (eqMatch) {
      return {
        field: eqMatch[1].trim(),
        op: 'is',
        values: [eqMatch[2]]
      };
    }
    // Parse IN filter: "field in ['val1', 'val2']"
    // Field name can contain spaces
    const inMatch = mapping.filter.match(/(.+?)\s+in\s+\[([^\]]+)\]/);
    if (inMatch) {
      const values = inMatch[2].split(',').map(v => v.trim().replace(/'/g, ''));
      return {
        field: inMatch[1].trim(),
        op: 'is',
        values
      };
    }
    // Fallback: treat filter as single value
    return {
      field,
      op: 'is',
      values: [mapping.filter]
    };
  }
  
  throw new Error(`Mapping for ${key}:${value} has neither filter nor pattern`);
}

/**
 * Build filter for a specific (key, value) pair, handling otherPolicy and regex patterns.
 * @deprecated Use buildFilterObjectForContextValue instead
 * 
 * @param key - Context key (e.g., "channel")
 * @param value - Context value (e.g., "google")
 * @param source - Source name (e.g., "amplitude")
 * @returns Filter string for this source
 */
async function buildFilterForContextValue(
  key: string,
  value: string,
  source: string
): Promise<string | null> {
  const filterObj = await buildFilterObjectForContextValue(key, value, source);
  if (filterObj === null) return null;
  
  // Convert to string representation
  if (filterObj.pattern) {
    const caseFlag = filterObj.patternFlags?.includes('i') ? ' (case-insensitive)' : '';
    return `${filterObj.field} matches '${filterObj.pattern}'${caseFlag}`;
  }
  
  if (filterObj.values.length === 1) {
    return `${filterObj.field} == '${filterObj.values[0]}'`;
  }
  
  return `${filterObj.field} in [${filterObj.values.map(v => `'${v}'`).join(', ')}]`;
}

/**
 * Build computed "other" filter object (NOT of all explicit values).
 * 
 * @param key - Context key
 * @param source - Source name
 * @param contextDef - Context definition
 * @returns Structured filter object for "other"
 */
async function buildComputedOtherFilterObject(
  key: string,
  source: string,
  contextDef: any
): Promise<ContextFilterObject> {
  const explicitValues = contextDef.values.filter((v: any) => v.id !== 'other');
  
  const allValues: string[] = [];
  const allPatterns: string[] = [];
  let field: string = key;
  let patternFlags: string | undefined;
  
  for (const v of explicitValues) {
    const mapping = await contextRegistry.getSourceMapping(key, v.id, source);
    
    if (mapping?.pattern) {
      allPatterns.push(mapping.pattern);
      field = mapping.field || key;
      patternFlags = mapping.patternFlags;
    } else if (mapping?.filter) {
      // Parse filter to extract value
      const eqMatch = mapping.filter.match(/(\S+)\s*==?\s*'([^']+)'/);
      if (eqMatch) {
        field = eqMatch[1];
        allValues.push(eqMatch[2]);
      }
    }
  }
  
  // Build "is not" filter with all values/patterns
  if (allPatterns.length > 0 && allValues.length > 0) {
    // Mix of patterns and values - combine into regex
    const combinedPattern = [...allPatterns, ...allValues.map(v => escapeRegex(v))].join('|');
    return {
      field,
      op: 'is not',
      values: [],
      pattern: combinedPattern,
      patternFlags: patternFlags || 'i'
    };
  } else if (allPatterns.length > 0) {
    // All patterns - combine into single regex
    return {
      field,
      op: 'is not',
      values: [],
      pattern: allPatterns.join('|'),
      patternFlags: patternFlags || 'i'
    };
  } else {
    // All values - use "is not" with array
    return {
      field,
      op: 'is not',
      values: allValues
    };
  }
}

/**
 * Build computed "other" filter (NOT of all explicit values).
 * @deprecated Use buildComputedOtherFilterObject instead
 * 
 * @param key - Context key
 * @param source - Source name
 * @param contextDef - Context definition
 * @returns Filter string for "other"
 */
async function buildComputedOtherFilter(
  key: string,
  source: string,
  contextDef: any
): Promise<string> {
  const filterObj = await buildComputedOtherFilterObject(key, source, contextDef);
  
  if (filterObj.pattern) {
    const caseFlag = filterObj.patternFlags?.includes('i') ? ' (case-insensitive)' : '';
    return `NOT (${filterObj.field} matches '${filterObj.pattern}'${caseFlag})`;
  }
  
  const valueClauses = filterObj.values.map(v => `${filterObj.field} == '${v}'`);
  return `NOT (${valueClauses.join(' OR ')})`;
}

/**
 * Resolve window dates to absolute Date objects.
 * Handles relative dates (e.g., "-30d") and absolute dates (e.g., "1-Jan-25").
 * 
 * @param window - Window constraint with start/end
 * @returns Resolved start and end dates (end may be undefined for open-ended windows)
 */
function resolveWindowDates(window: { start?: string; end?: string }): { startDate?: Date; endDate?: Date } {
  // Normalize 'now' to current local date at UTC midnight
  // This ensures relative offsets align to date boundaries and prevents timezone drifts
  // Example: Local "Dec 8 14:00" -> "8-Dec-25" -> "2025-12-08T00:00:00.000Z"
  const now = parseUKDate(formatDateUK(new Date()));
  
  // DEBUG: Log input
  console.log('[resolveWindowDates] Input:', window);
  
  let startDate: Date | undefined;
  if (!window.start) {
    // No start specified - beginning of time (or undefined for fully open)
    console.log('[resolveWindowDates] No start specified');
    startDate = undefined;
  } else if (window.start.match(/^-?\d+[dwmy]$/)) {
    // Relative offset
    console.log('[resolveWindowDates] Start is relative offset:', window.start);
    startDate = applyRelativeOffset(now, window.start);
  } else {
    // Absolute date in d-MMM-yy format
    console.log('[resolveWindowDates] Start is absolute date:', window.start);
    startDate = parseUKDate(window.start);
    console.log('[resolveWindowDates] parseUKDate returned:', startDate?.toISOString());
  }
  
  let endDate: Date | undefined;
  if (window.end === undefined) {
    // Explicitly undefined - truly open-ended window (e.g., from parseConstraints("-30d:"))
    // Leave undefined to preserve open-ended semantics
    endDate = undefined;
  } else if (window.end === '') {
    // Empty string - means "default to now" (e.g., from UI with empty end field)
    endDate = now;
  } else if (window.end.match(/^-?\d+[dwmy]$/)) {
    endDate = applyRelativeOffset(now, window.end);
  } else {
    endDate = parseUKDate(window.end);
  }
  
  return { startDate, endDate };
}

/**
 * Apply relative offset to a base date.
 * 
 * @param base - Base date
 * @param offset - Offset string (e.g., "-30d", "+7w")
 * @returns New date with offset applied
 */
function applyRelativeOffset(base: Date, offset: string): Date {
  const match = offset.match(/^(-?\d+)([dwmy])$/);
  if (!match) {
    throw new Error(`Invalid relative offset: ${offset}`);
  }
  
  const amount = parseInt(match[1]);
  const unit = match[2];
  
  const result = new Date(base);
  switch (unit) {
    case 'd':
      result.setDate(result.getDate() + amount);
      break;
    case 'w':
      result.setDate(result.getDate() + amount * 7);
      break;
    case 'm':
      result.setMonth(result.getMonth() + amount);
      break;
    case 'y':
      result.setFullYear(result.getFullYear() + amount);
      break;
  }
  
  return result;
}

// parseUKDate is imported from ../dateFormat (uses Date.UTC for timezone safety)

/**
 * Check if targetNodeId is upstream of sourceNodeId in the graph.
 * "Upstream" means there's a path FROM targetNode TO sourceNode (target comes before source).
 * 
 * Uses BFS to check reachability by traversing incoming edges.
 * 
 * @param targetNodeId - The node to check (is it upstream?)
 * @param sourceNodeId - The reference node (is target upstream of this?)
 * @param graph - Graph with nodes and edges
 * @returns true if targetNode is upstream of sourceNode
 */
export function isNodeUpstream(targetNodeId: string, sourceNodeId: string, graph: any): boolean {
  if (targetNodeId === sourceNodeId) return false;
  
  const visited = new Set<string>();
  const queue: string[] = [sourceNodeId];
  
  // Helper to get node ID (handle both id and uuid references)
  const getNodeId = (ref: string): string | undefined => {
    const node = graph.nodes.find((n: any) => n.id === ref || n.uuid === ref);
    return node?.id;
  };
  
  // Normalize target to node.id
  const normalizedTarget = getNodeId(targetNodeId);
  if (!normalizedTarget) return false;
  
  while (queue.length > 0) {
    const currentRef = queue.shift()!;
    const currentId = getNodeId(currentRef);
    
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    
    // Find incoming edges to current node (edges where 'to' matches current)
    const incomingEdges = graph.edges.filter((e: any) => {
      const toId = getNodeId(e.to);
      return toId === currentId;
    });
    
    for (const edge of incomingEdges) {
      const fromId = getNodeId(edge.from);
      if (!fromId) continue;
      
      if (fromId === normalizedTarget) {
        return true; // Found path from target to source (target is upstream)
      }
      queue.push(fromId);
    }
  }
  
  return false;
}

