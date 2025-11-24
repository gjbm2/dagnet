# Contexts: Adapter Extensions & Nightly Runner

**Part of**: Contexts v1 implementation  
**See also**: 
- `CONTEXTS_ARCHITECTURE.md` — Data model and query signatures
- `CONTEXTS_REGISTRY.md` — Context definitions and source mappings
- `CONTEXTS_AGGREGATION.md` — How fetched data is aggregated

---

## Overview

This document defines:
- Amplitude adapter extensions (context filters, regex patterns)
- Sheets adapter extensions (context HRNs, fallback policy)
- Amplitude Dashboard REST API research summary
- Nightly runner integration (DSL explosion, scheduling)

---

## Amplitude Dashboard REST API Research

**Goal**: Understand how to express Dagnet context slices as Amplitude queries, and what we need to store back on var files.

### Relevant APIs

- **Dashboard REST API** (Analytics):  
  - Provides read access to the same aggregates you see in the Amplitude UI.  
  - Key endpoints (conceptual):  
    - **Funnels**: "from → to" conversion counts over a date range, with property filters and breakdowns.  
    - **Segmentation / Events**: counts for a single event type, optionally segmented by properties, over a date range.  
  - All of these:
    - Take **start/end date** parameters (YYYY-MM-DD or ISO timestamps).  
    - Allow **property filters** and **segmentation** by event or user properties.  
    - Can return **aggregates** (total counts) and, for some endpoints, **time-series** buckets (daily, weekly, etc.).

- **Export / HTTP Ingest APIs** are **not** directly relevant for contexts — we only care about query‑side filters, not ingestion.

### Property Filters ↔ Context Mapping

Amplitude's Dashboard REST API lets you filter by **event or user properties**, e.g.:
- `utm_source == 'google'`
- `browser == 'Chrome'`

For Dagnet contexts, this lines up cleanly with the design of `contexts.yaml`:

- Each context key (`channel`, `browser-type`, etc.) maps to:
  - a **source field** in Amplitude (e.g. `utm_source`, `browser`, custom event/user property), and  
  - a **filter expression** for each value (`google`, `meta`, `other`), expressed in Amplitude's property filter syntax.

Therefore, for contexts we need to store, per (key, value, source):

- `field`: the Amplitude property name (e.g. `"utm_source"`, `"browser"`).  
- `filter`: a filter expression that can be dropped into the Dashboard REST API's filter parameter for that value, e.g.:  
  - `"utm_source == 'google'"`  
  - `"utm_source in ['facebook', 'instagram']"`  
  - `"browser == 'Chrome'"`

This matches the `sources[amplitude].field` / `sources[amplitude].filter` design already sketched in the registry section.

### Time Windows & Response Shape

- **Request side**:  
  - All relevant endpoints accept a **start** and **end** time (date or timestamp).  
  - These map directly to Dagnet's `window(start:end)` DSL: we resolve relative windows to absolute dates and pass them through.

- **Response side** (conceptually):  
  - Funnels: counts like `from_count`, `to_count`, and derived rates over the requested window.  
  - Segmentation: counts per event/property bucket, with optional time-series buckets (e.g. per day).  

For contexts v1 we only need, per query:

- **Aggregate n, k** (e.g. `from_count`, `to_count`) over the requested window, and optionally  
- **daily time-series** (if we choose to keep using `n_daily`, `k_daily`, `dates` for fine‑grained windows).

We do **not** need to store any Amplitude‑specific IDs for dashboards or charts — only the numeric counts and the time axis.

### What We Need to Persist on Var Files

Given the above, the minimal additional fields we need on var files for Amplitude‑backed context slices are:

- `sliceDSL`: Canonical DSL string describing **which slice** this is (contexts + window).  
- Existing numeric data:
  - `n`, `k`, `mean`, `stdev` (as today).  
  - Optionally `n_daily`, `k_daily`, `dates` if we fetch time-series buckets instead of a single aggregate.

We **do not** need to persist:
- Raw Amplitude query JSON.  
- Dashboard IDs.  
- Property filter syntax, beyond what is already encoded in `sliceDSL` + `contexts.yaml`.

The Amplitude adapter can always reconstruct the query solely from:
- the edge/graph HRN (what we are measuring),  
- the **resolved context mapping** from `contexts.yaml`, and  
- the **resolved time window** from `window(...)` in the slice/query DSL.

### DAS Adapter Implications

When building a DAS query for Amplitude from a slice or `currentQueryDSL`:
1. Parse the DSL into constraints (visited, context, window).  
2. For each `context(key:value)` / `contextAny(key:...)`:  
   - Look up `sources[amplitude].field` + `filter` in the context registry.  
   - Combine all such filters into the Dashboard REST API's property filter parameter (AND across keys, OR within `contextAny`).  
3. Resolve `window(start:end)` to absolute dates and pass as `start`, `end` in the API call.  
4. Call the appropriate endpoint (funnel vs segmentation), then:
   - Extract `n`, `k` (and optionally daily buckets) from the response.  
   - Write/update the corresponding `sliceDSL` window on the var file.

---

## Amplitude Adapter Extensions

**File**: `graph-editor/src/lib/das/buildDslFromEdge.ts` (or equivalent)

**Current state** (from codebase review):
- `buildDslFromEdge.ts` builds DSL object with `from`, `to`, `visited`, etc.
- `DASRunner.ts` executes queries and returns `{ success: boolean; raw: {...} }`
- Response includes `from_count`, `to_count`, and optionally `time_series` array

### Extend Query Builder to Handle Contexts

```typescript
/**
 * Build Amplitude query DSL with context filters.
 * EXTENDS: existing buildDslFromEdge
 */
export async function buildDslFromEdge(
  edge: any,
  graph: any,
  connectionProvider?: string,
  eventLoader?: EventLoader,
  constraints?: ParsedConstraints  // NEW parameter
): Promise<DslObject> {
  
  // Existing logic to build base DSL with from/to/visited
  const baseDsl = await buildBaseDsl(edge, graph, connectionProvider, eventLoader);
  
  // NEW: Add context filters if constraints provided
  if (constraints && (constraints.contexts.length > 0 || constraints.contextAnys.length > 0)) {
    baseDsl.filters = buildContextFilters(constraints, connectionProvider || 'amplitude');
  }
  
  // NEW: Add window/date range if provided
  if (constraints && constraints.window) {
    const { startDate, endDate } = resolveWindowDates(constraints.window);
    baseDsl.start = startDate.toISOString();
    baseDsl.end = endDate.toISOString();
  }
  
  return baseDsl;
}

function buildContextFilters(
  constraints: ParsedConstraints,
  source: string
): string[] {
  const filters: string[] = [];
  
  // Process context(...) constraints
  for (const ctx of constraints.contexts) {
    const mapping = contextRegistry.getSourceMapping(ctx.key, ctx.value, source);
    if (!mapping || !mapping.filter) {
      throw new Error(`No ${source} mapping for context ${ctx.key}:${ctx.value}`);
    }
    filters.push(mapping.filter);
  }
  
  // Process contextAny(...) constraints
  for (const ctxAny of constraints.contextAnys) {
    // Group by key
    const byKey = new Map<string, string[]>();
    for (const pair of ctxAny.pairs) {
      if (!byKey.has(pair.key)) {
        byKey.set(pair.key, []);
      }
      byKey.get(pair.key)!.push(pair.value);
    }
    
    // For each key, build OR clause
    for (const [key, values] of byKey.entries()) {
      const orClauses = values.map(value => {
        const mapping = contextRegistry.getSourceMapping(key, value, source);
        if (!mapping || !mapping.filter) {
          throw new Error(`No ${source} mapping for context ${key}:${value}`);
        }
        return mapping.filter;
      });
      
      if (orClauses.length === 1) {
        filters.push(orClauses[0]);
      } else {
        filters.push(`(${orClauses.join(' or ')})`);
      }
    }
  }
  
  return filters;
}

function resolveWindowDates(window: WindowConstraint): { startDate: Date; endDate: Date } {
  const now = new Date();
  
  let startDate: Date;
  if (!window.start) {
    startDate = new Date(0);  // beginning of time
  } else if (window.start.match(/^-?\d+[dwmy]$/)) {
    // Relative offset
    startDate = applyRelativeOffset(now, window.start);
  } else {
    // Absolute date in d-MMM-yy format
    startDate = parseUKDate(window.start);
  }
  
  let endDate: Date;
  if (!window.end) {
    endDate = now;
  } else if (window.end.match(/^-?\d+[dwmy]$/)) {
    endDate = applyRelativeOffset(now, window.end);
  } else {
    endDate = parseUKDate(window.end);
  }
  
  return { startDate, endDate };
}

function applyRelativeOffset(base: Date, offset: string): Date {
  const match = offset.match(/^(-?\d+)([dwmy])$/);
  if (!match) throw new Error(`Invalid relative offset: ${offset}`);
  
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
```

**Integration point**: When calling `buildDslFromEdge` from data operations or nightly runner, pass the `constraints` parameter derived from the query/slice DSL.

**Backward compatibility**: If `constraints` is not provided, function behaves exactly as today.

### Regex Pattern Support in Adapter

When a context value uses a regex pattern instead of an explicit filter:

```typescript
function buildFilterFromMapping(
  mapping: SourceMapping,
  field: string
): string {
  
  // If pattern provided, build regex filter
  if (mapping.pattern) {
    const flags = mapping.patternFlags || '';
    
    // Amplitude syntax (example; verify with API docs)
    // Might be: field ~ 'pattern' or REGEXP_MATCH(field, 'pattern')
    return `REGEXP_MATCH(${field}, '${mapping.pattern}', '${flags}')`;
  }
  
  // Otherwise use explicit filter
  if (mapping.filter) {
    return mapping.filter;
  }
  
  throw new Error('Mapping must have either pattern or filter');
}
```

**Implementation note**: Exact regex syntax for Amplitude needs to be verified with API documentation during implementation.

### otherPolicy: computed in Adapter

When building filter for `context(channel:other)` with `otherPolicy: computed`:

```typescript
function buildFilterForContextValue(
  key: string,
  value: string,
  source: string
): string {
  
  const contextDef = contextRegistry.getContext(key);
  const mapping = contextRegistry.getSourceMapping(key, value, source);
  
  if (value === 'other' && contextDef.otherPolicy === 'computed') {
    // Generate NOT filter dynamically
    const explicitValues = contextDef.values.filter(v => v.id !== 'other');
    
    const explicitFilters = explicitValues.map(v => {
      const m = contextRegistry.getSourceMapping(key, v.id, source);
      if (m?.pattern) {
        const flags = m.patternFlags || '';
        return `REGEXP_MATCH(${contextDef.field}, '${m.pattern}', '${flags}')`;
      } else if (m?.filter) {
        return m.filter;
      }
      throw new Error(`No mapping for ${key}:${v.id}`);
    });
    
    // Return: NOT (value1 OR value2 OR ...)
    return `NOT (${explicitFilters.join(' OR ')})`;
  }
  
  // Regular value: use mapping
  if (mapping?.pattern) {
    return buildFilterFromMapping(mapping, contextDef.field);
  } else if (mapping?.filter) {
    return mapping.filter;
  }
  
  throw new Error(`No ${source} mapping for ${key}:${value}`);
}
```

### Query Signature Integration

When fetching data, generate signature using `querySignatureService`:

```typescript
// In Amplitude adapter fetch method
async function fetchAmplitudeData(
  edge: Edge,
  constraints: ParsedConstraints,
  connection: Connection
): Promise<ParameterValue> {
  
  // Build data query spec
  const spec: DataQuerySpec = {
    connectionId: connection.id,
    connectionType: 'amplitude',
    fromNode: edge.from,
    toNode: edge.to,
    visited: constraints.visited,
    excluded: constraints.exclude,
    cases: constraints.cases,
    contextFilters: constraints.contexts.map(c => {
      const mapping = contextRegistry.getSourceMapping(c.key, c.value, 'amplitude');
      return {
        key: c.key,
        value: c.value,
        sourceField: mapping.field,
        sourcePredicate: mapping.filter || mapping.pattern,
      };
    }),
    granularity: 'daily',
    // NO windowBounds for daily mode
    adapterOptions: {},
  };
  
  const signature = querySignatureService.buildDailySignature(spec);
  
  // Build Amplitude query
  const query = await buildDslFromEdge(edge, graph, connection.provider, eventLoader, constraints);
  
  // Execute
  const result = await DASRunner.execute(connection.id, query);
  
  if (!result.success) {
    throw new Error(`Amplitude query failed: ${result.error}`);
  }
  
  // Extract data
  const timeSeries = result.raw.time_series || [];
  const n_daily = timeSeries.map((p: any) => p.n || 0);
  const k_daily = timeSeries.map((p: any) => p.k || 0);
  const dates = timeSeries.map((p: any) => normalizeDate(p.date));
  
  // Build sliceDSL
  const sliceDSL = buildSliceDSL(constraints);
  
  return {
    n_daily,
    k_daily,
    dates,
    sliceDSL,
    query_signature: signature,
  };
}
```

---

## Sheets Adapter Extensions

**File**: `graph-editor/src/services/ParamPackDSLService.ts` (already handles Sheets param-pack ingestion)

**Current state**:
- Sheets adapter parses HRNs like `e.edge-id.visited(...).p.mean`
- Already has regex for conditional patterns (line 426)
- Stores conditions in `conditional_ps` array on edges

### Context Handling (Simple Extension)

Sheets users supply context-labeled parameters directly:

```yaml
e.landing-conversion.context(channel:google).p.mean: 0.15
e.landing-conversion.context(channel:meta).p.mean: 0.12
e.landing-conversion.p.mean: 0.10  # Uncontexted fallback
```

**Extension needed**: Already supported! The existing regex includes `context` pattern. Just ensure normalization happens.

**Update regex** (extend existing pattern):

```typescript
// UPDATE regex pattern to include contextAny and window
const conditionalMatch = key.match(/^e\.([^.]+)\.((?:visited|visitedAny|context|contextAny|case|exclude|window)\([^)]+\)(?:\.(?:visited|visitedAny|context|contextAny|case|exclude|window)\([^)]+\))*)\.p\.(.+)$/);

// Rest of logic remains the same — we store the full condition string as-is
// Normalization happens separately via normalizeConstraintString
```

### Fallback Policy (RESOLVED)

**Decision**: **Option B (Fallback with warning)**

**Scenario**: User queries `e.my-edge.context(source:google).p.mean` but Sheets only has `e.my-edge.p.mean`.

**Behavior**:
1. Try exact match first
2. If not found and policy is 'fallback', try uncontexted version
3. Show UI warning: "Using uncontexted fallback for source:google"
4. If neither found, return null with warning

**Rationale**:
- Sheets is often manually maintained, incomplete data is common
- Strict mode would break many existing Sheets-based graphs
- Warning in UI alerts user to data quality issue without blocking
- Can add strict mode as opt-in later

### Implementation

```typescript
function resolveSheetParameter(
  hrn: string,
  paramPack: Record<string, unknown>,
  fallbackPolicy: 'strict' | 'fallback' = 'fallback'
): { value: number | null; warning?: string } {
  
  // Try exact match first
  if (hrn in paramPack) {
    return { value: paramPack[hrn] as number };
  }
  
  if (fallbackPolicy === 'strict') {
    return { value: null, warning: `Exact match for ${hrn} not found` };
  }
  
  // Fallback: try uncontexted version
  const uncontextedHrn = removeContextFromHRN(hrn);
  if (uncontextedHrn !== hrn && uncontextedHrn in paramPack) {
    return {
      value: paramPack[uncontextedHrn] as number,
      warning: `Using uncontexted fallback for ${hrn}`,
    };
  }
  
  return { value: null, warning: `No data found for ${hrn}` };
}

function removeContextFromHRN(hrn: string): string {
  // Remove all context(...) and contextAny(...) clauses from HRN
  return hrn.replace(/\.context(?:Any)?\([^)]+\)/g, '');
}
```

**Where to surface warnings**:
- Store warnings in aggregation result
- Display as non-blocking toast in UI
- Log to console for debugging

---

## Nightly Runner Integration

### Runner Algorithm

**File**: `python-backend/nightly_runner.py` (or equivalent)

```python
def run_nightly_for_graph(graph_id: str):
    graph = load_graph(graph_id)
    pinned_dsl = graph.get('dataInterestsDSL', 'window(-90d:)')  # default
    
    # Split on ';' to get list of pinned clauses
    clauses = pinned_dsl.split(';')
    
    # For each clause, explode into atomic slice expressions
    atomic_slices = []
    for clause in clauses:
        expanded = expand_clause(clause)
        atomic_slices.extend(expanded)
    
    # For each atomic slice and each variable, fetch and store
    for var_id in graph.get('variables', []):
        variable = load_variable(var_id)
        
        for slice_expr in atomic_slices:
            # Parse slice expression
            constraints = parse_constraints(slice_expr)
            
            # Inject default window if missing
            if not constraints.get('window'):
                constraints['window'] = {'start': '-90d', 'end': ''}
            
            # Build and execute query
            query = build_amplitude_query(variable, constraints)
            result = execute_query(query)
            
            # Store as new window
            new_window = {
                'n': result['n'],
                'k': result['k'],
                'mean': result['mean'],
                'stdev': result['stdev'],
                'sliceDSL': normalize_constraint_string(slice_expr),
            }
            
            variable['windows'] = variable.get('windows', [])
            variable['windows'].append(new_window)
            
            save_variable(variable)

def expand_clause(clause: str) -> List[str]:
    """
    Expand a clause into atomic slice expressions.
    
    Examples:
      - "context(channel)" → ["context(channel:google)", "context(channel:meta)", ...]
      - "or(context(channel), context(browser-type))" → all channel slices + all browser slices
      - "context(channel).window(-30d:)" → ["context(channel:google).window(-30d:)", ...]
    """
    
    # Parse the clause
    constraints = parse_constraints(clause)
    
    # Check for context() with no value (enumerate mode)
    # Check for or(...) expressions
    # Generate Cartesian product if multiple context keys present
    # Return list of fully-specified slice expressions
    
    # Implementation TBD; pseudocode:
    atomic = []
    
    if has_enum_context(constraints):
        # e.g. "context(channel)" with no specific value
        # Look up all values from registry and generate one slice per value
        for value in context_registry.get_values('channel'):
            atomic.append(f"context(channel:{value.id})")
    else:
        atomic.append(clause)
    
    return atomic
```

### Explosion Cap and Warnings

**Problem**: `dataInterestsDSL` could expand to thousands of atomic slices.

**Solution**: Cap at 500 slices; warn if exceeded.

```python
def expand_pinned_dsl(pinned_dsl: str) -> List[str]:
    clauses = pinned_dsl.split(';')
    
    atomic_slices = []
    for clause in clauses:
        expanded = expand_clause(clause)
        atomic_slices.extend(expanded)
    
    if len(atomic_slices) > 500:
        log.warning(
            f"dataInterestsDSL expanded to {len(atomic_slices)} slices (exceeds 500 limit). "
            f"Consider narrowing scope or using explicit values."
        )
        # Option A: Truncate to first 500
        # Option B: Skip this graph entirely
        # For v1: log warning but proceed (non-blocking)
    
    return atomic_slices
```

**UI preview in Pinned Query Modal**:

When user edits `dataInterestsDSL` in settings modal:
1. Parse and expand on client-side (limited expansion for preview)
2. Show count: "This will generate 47 atomic slices"
3. Enumerate first 10-20 slices:
   - `context(channel:google).window(-90d:)`
   - `context(channel:meta).window(-90d:)`
   - `context(channel:organic).window(-90d:)`
   - ...
4. If count > 50, show warning: "Large slice count may impact nightly run performance"
5. If count > 500, show error: "Slice count exceeds recommended limit (500); consider narrowing scope"

**Error policy**: Warn but don't block Save (user may know what they're doing; can monitor in logs).

### Scheduling & Deduplication

- Run nightly for all graphs with `dataInterestsDSL` set
- Before writing a new window, check if an equivalent `sliceDSL` already exists (by timestamp and context)
- If exists and fresh (< 24 hours old), skip; otherwise overwrite/update
- Use incremental fetch logic to only fetch missing dates (per context)

### Error Handling

**Principle**: Never hard-fail; degrade gracefully.

```python
def run_nightly():
    graphs = get_all_graphs_with_pinned_dsl()
    
    for graph in graphs:
        try:
            run_nightly_for_graph(graph.id)
        except Exception as e:
            log.error(f"Nightly run failed for graph {graph.id}: {e}")
            # Continue to next graph; don't crash entire run
            continue
    
    log.info(f"Nightly run completed: {len(graphs)} graphs processed")
```

**Monitoring**:
- Log slice count per graph
- Log API call count to Amplitude
- Track failures and warnings
- Alert if failure rate exceeds threshold

---

## Summary: What Adapters Need to Implement

### Amplitude Adapter

1. **Extend `buildDslFromEdge`**:
   - Accept `ParsedConstraints` parameter
   - Call `buildContextFilters()` to generate property filters
   - Call `resolveWindowDates()` to set start/end dates

2. **Implement `buildContextFilters`**:
   - For each `context(key:value)`, look up `sources[amplitude].filter` from registry
   - For `contextAny(...)`, build OR clauses within each key
   - Handle regex patterns (`pattern` + `patternFlags`)
   - Handle `otherPolicy: computed` by dynamically building NOT filter

3. **Integrate Query Signature Service**:
   - Build `DataQuerySpec` from query parameters
   - Call `querySignatureService.buildDailySignature()`
   - Store signature on returned `ParameterValue`

4. **Verify API syntax**:
   - Confirm exact filter syntax for Amplitude Dashboard REST API
   - Test regex pattern syntax (`REGEXP_MATCH` or equivalent)
   - Validate time-series response parsing

### Sheets Adapter

1. **Extend HRN regex**:
   - Add `contextAny` and `window` to existing pattern
   - Test with complex HRNs containing multiple constraints

2. **Implement fallback logic**:
   - Try exact match first
   - Fall back to uncontexted version if missing
   - Return warning with result

3. **Integrate Query Signature Service**:
   - Build `DataQuerySpec` for Sheets queries
   - Use `querySignatureService.buildAggregateSignature()` (include window bounds)
   - Store signature on `ParameterValue`

### Nightly Runner

1. **Implement DSL explosion**:
   - Parse `dataInterestsDSL`
   - Expand bare `context(key)` into all registry values
   - Handle `or(...)` constructs
   - Cap at 500 slices with warning

2. **Schedule and execute**:
   - Run nightly for all graphs with `dataInterestsDSL`
   - Use incremental fetch per context (reuse existing dates)
   - Deduplicate by `sliceDSL` before writing

3. **Error handling**:
   - Log failures per graph
   - Continue to next graph on error
   - Monitor API usage and slice counts

---

## Next Steps

1. Review `CONTEXTS_TESTING_ROLLOUT.md` for comprehensive test coverage of adapters
2. Begin implementation with Amplitude adapter extensions (most critical path)
3. Verify Amplitude API syntax with actual API calls during implementation

