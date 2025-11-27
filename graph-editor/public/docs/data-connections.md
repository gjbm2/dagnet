# Data Connections & Adapters

## Overview

DagNet's **Data Adapter Service (DAS)** allows you to connect your graph parameters to external data sources like Amplitude, Google Sheets, PostgreSQL, and more. Instead of manually entering conversion rates and sample sizes, you can automatically fetch real data from your analytics platforms.

## Core Concepts

### Connections

A **connection** defines how to authenticate and communicate with an external data source. Connections are configured in `connections.yaml` and include:

- **Authentication**: API keys, OAuth tokens, or service account credentials
- **Base Configuration**: Default URLs, API versions, and provider-specific settings
- **Adapter Specification**: How to transform DagNet queries into API requests

### Adapters

An **adapter** is a transformation pipeline that converts:
1. **DagNet Query DSL** → External API request
2. **External API response** → DagNet parameter values

Each adapter has five stages:

1. **Pre-Request Script**: Transforms the DagNet query DSL into API-specific parameters
2. **Request**: Builds the HTTP request (URL, headers, body)
3. **Response Extraction**: Extracts data from the API response using JMESPath
4. **Transform**: Converts extracted data into DagNet format using JSONata
5. **Upsert**: Maps transformed values to graph edges/nodes

### Query DSL

DagNet uses a simple query language to specify conversion funnels:

```
from(homepage).to(checkout).visited(add-to-cart)
```

This means: "Find users who visited `homepage`, then `add-to-cart`, then `checkout`, and return the conversion rate from `homepage` to `checkout`."

## Configuration

### Connection File Location

Connections are defined in:
```
graph-editor/public/defaults/connections.yaml
```

### Connection Structure

```yaml
connections:
  - name: amplitude-prod
    provider: amplitude
    kind: http
    description: "Production Amplitude analytics"
    enabled: true
    credsRef: amplitude
    defaults:
      base_url: "https://amplitude.com/api/2"
    connection_string_schema:
      type: object
      properties:
        segment:
          type: array
    adapter:
      pre_request:
        script: |
          // Transform DagNet DSL to Amplitude funnel parameters
      request:
        url_template: "{{{connection.base_url}}}/funnels?{{{dsl.query_params}}}"
        method: GET
        headers:
          Authorization: "Basic {{{credentials.basic_auth_b64}}}"
      response:
        extract:
          - name: from_count
            jmes: "data[0].cumulativeRaw[{{from_step_index}}]"
      transform:
        - name: p_mean
          jsonata: "$number(from_count) > 0 ? $number(to_count) / $number(from_count) : 0"
      upsert:
        mode: replace
        writes:
          - target: "/edges/{{edgeId}}/p/mean"
            value: "{{p_mean}}"
```

### Connection Fields

- **`name`**: Unique identifier for the connection (e.g., `amplitude-prod`)
- **`provider`**: Provider type (e.g., `amplitude`, `google-sheets`, `postgres`)
- **`kind`**: Connection type (`http` or `sql`)
- **`description`**: Human-readable description
- **`enabled`**: Whether the connection is active (`true`/`false`)
- **`credsRef`**: Reference to credentials stored in the credentials manager
- **`defaults`**: Provider-specific default settings
- **`connection_string_schema`**: JSON Schema for connection-specific parameters
- **`adapter`**: The transformation pipeline specification

## Using Connections

### In the UI

1. **Select an Edge**: Click on an edge in your graph
2. **Open Parameter Section**: In the Properties panel, find the parameter (probability, cost, etc.)
3. **Set Connection**: Click the connection selector and choose a connection
4. **Configure Connection String**: If the connection requires additional parameters (like spreadsheet ID for Google Sheets), enter them
5. **Get Data**: Click the ⚡ (zap) icon or right-click menu → "Get data from source"

### Direct vs. Versioned

When fetching data, you have two options:

- **Direct**: Fetches data and applies it directly to the graph (no file storage)
- **Versioned**: Fetches data, stores it in the parameter file, then applies to graph

For time-series data (daily breakdowns), use **Versioned** mode. This stores daily `n` and `k` values in the parameter file, allowing you to:
- Aggregate across date ranges
- Track historical changes
- Perform incremental fetches (only get missing days)

## Adapter Stages Explained

### 1. Pre-Request Script

JavaScript code that transforms the DagNet query DSL into API-specific parameters. Runs in a sandboxed environment with access to:
- `dsl`: The DagNet query object (`{from, to, visited, exclude, ...}`)
- `connection`: The connection configuration object
- `connection_string`: Connection-specific parameters (from UI)
- `window`: Date range (`{start, end}`)
- `context`: Execution context (`{mode: 'daily' | 'aggregate'}`)

**Example (Amplitude)**:
```javascript
// Build funnel steps from DagNet query
const events = [];
if (dsl.visited && dsl.visited.length > 0) {
  events.push(...dsl.visited.map(name => ({ event_type: name })));
}
events.push({ event_type: dsl.from });
events.push({ event_type: dsl.to });

// Format dates for Amplitude (YYYYMMDD)
const formatDate = (iso) => iso.split('T')[0].replace(/-/g, '');
const startDate = formatDate(window.start);
const endDate = formatDate(window.end);

// Build query parameters
dsl.query_params = `e=${encodeURIComponent(JSON.stringify(events[0]))}&...`;
dsl.from_step_index = events.length - 2;
dsl.to_step_index = events.length - 1;

return dsl;
```

### 2. Request

Builds the HTTP request using Mustache templates. Available variables:
- `{{{connection.base_url}}}`: Base URL from connection defaults
- `{{{dsl.query_params}}}`: Parameters from pre-request script
- `{{{credentials.api_key}}}`: Credentials from credentials manager
- `{{{connection_string.spreadsheet_id}}}`: Connection-specific parameters

**Example**:
```yaml
request:
  url_template: "{{{connection.base_url}}}/funnels?{{{dsl.query_params}}}"
  method: GET
  headers:
    Authorization: "Basic {{{credentials.basic_auth_b64}}}"
```

### 3. Response Extraction

Extracts data from the API response using JMESPath expressions. Each extraction creates a named variable available to the transform stage.

**Example**:
```yaml
response:
  extract:
    - name: from_count
      jmes: "data[0].cumulativeRaw[{{from_step_index}}]"
    - name: to_count
      jmes: "data[0].cumulativeRaw[{{to_step_index}}]"
    - name: day_funnels
      jmes: "data[0].dayFunnels"
```

### 4. Transform

Converts extracted data into DagNet format using JSONata expressions. Can reference:
- Extracted variables (e.g., `$from_count`)
- DSL context (e.g., `$dsl.from_step_index`)
- Previous transform results (transforms run sequentially)

**Example**:
```yaml
transform:
  - name: p_mean
    jsonata: "$number(from_count) > 0 ? $number(to_count) / $number(from_count) : 0"
  - name: n
    jsonata: "$number(from_count)"
  - name: k
    jsonata: "$number(to_count)"
  - name: time_series
    jsonata: |
      $.day_funnels.series ~> $map(function($dayData, $i) {
        {
          "date": $.day_funnels.xValues[$i],
          "n": $dayData[$number($dsl.from_step_index)],
          "k": $dayData[$number($dsl.to_step_index)],
          "p": $dayData[$number($dsl.to_step_index)] / $dayData[$number($dsl.from_step_index)]
        }
      })
```

### 5. Upsert

Maps transformed values to graph edges or nodes using Mustache templates.

**Example**:
```yaml
upsert:
  mode: replace
  writes:
    - target: "/edges/{{edgeId}}/p/mean"
      value: "{{p_mean}}"
    - target: "/edges/{{edgeId}}/p/evidence/n"
      value: "{{n}}"
    - target: "/edges/{{edgeId}}/p/evidence/k"
      value: "{{k}}"
```

## Built-in Connections

### Amplitude

**Provider**: `amplitude`  
**Purpose**: Fetch conversion funnel data from Amplitude Analytics

**Configuration**:
- Requires API Key and Secret Key (stored in credentials)
- Supports cohort exclusions (e.g., internal test users)
- Automatically builds funnel queries from DagNet DSL
- Supports daily time-series data (`i=1` parameter)

**Connection String**: Optional segment filters (array of Amplitude segment objects)

**Example Query**:
```
from(homepage).to(checkout).visited(add-to-cart)
```

**Transforms to Amplitude Funnel**:
```
A: add-to-cart
B: homepage
C: checkout
```

Returns conversion rate from `homepage` → `checkout` for users who visited `add-to-cart`.

### Google Sheets

**Provider**: `google-sheets`  
**Purpose**: Read parameter data from Google Sheets

**Configuration**:
- Requires Google Service Account JSON (stored in credentials)
- Automatically generates OAuth access tokens
- Reads data from specified spreadsheet range

**Connection String**:
- `spreadsheet_id`: Google Sheets spreadsheet ID (from URL)
- `range`: A1 notation range (e.g., `Sheet1!A1:B10`)
- `expected_format`: Optional hint for data format

**Example**:
```yaml
connection_string:
  spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
  range: "Sheet1!A1:B10"
```

### Statsig

**Provider**: `statsig`  
**Purpose**: Fetch experiment variant allocations from Statsig

**Configuration**:
- Requires Statsig Console API Key
- Fetches gate/experiment configuration
- Maps variants to case node allocations

**Connection String**: Optional `project_id` override

### PostgreSQL (Example)

**Provider**: `postgres`  
**Purpose**: Query SQL databases for conversion data

**Configuration**:
- Requires database credentials (host, port, database, user, password)
- Executes SQL queries with DagNet query parameters
- Returns aggregated conversion rates

**Connection String**:
- `table`: Table name for query

## Credentials Management

Credentials are stored securely and referenced by `credsRef` in connections.

### Setting Up Credentials

1. Go to **Data > Credentials** in the menu
2. Select a provider (e.g., Amplitude, Google Sheets)
3. Enter your API keys, tokens, or service account JSON
4. Credentials are encrypted and stored locally

### Credential Types

- **API Keys**: Simple key-value pairs (e.g., Amplitude API Key + Secret Key)
- **OAuth Tokens**: Access tokens for OAuth-based APIs
- **Service Accounts**: Google Service Account JSON (automatically generates OAuth tokens)
- **Basic Auth**: Auto-generated from username:password for HTTP Basic Auth

## Time-Series Data

When fetching data in **daily mode**, the adapter stores time-series data in parameter files:

```yaml
values:
  - mean: 0.45
    stdev: 0.03
    n_daily: [100, 120, 110, ...]
    k_daily: [45, 54, 50, ...]
    dates: ["2025-01-01", "2025-01-02", "2025-01-03", ...]
    window_from: "2025-01-01T00:00:00Z"
    window_to: "2025-01-31T23:59:59Z"
    query_signature: "abc123..."
    data_source:
      type: "amplitude"
      retrieved_at: "2025-01-15T10:00:00Z"
```

This allows:
- **Window Aggregation**: Aggregate across date ranges (sum `n` and `k`, recalculate `p`)
- **Incremental Fetching**: Only fetch missing days when expanding the window
- **Query Consistency**: Detect when query parameters change (via `query_signature`)

## Creating Custom Adapters

To add a new data source:

1. **Add Connection** to `connections.yaml`:
   ```yaml
   - name: my-api
     provider: my-provider
     kind: http
     enabled: true
     credsRef: my-provider
     adapter:
       pre_request:
         script: |
           // Transform DSL to API parameters
       request:
         url_template: "https://api.example.com/endpoint"
         method: GET
       response:
         extract:
           - name: my_data
             jmes: "response.data"
       transform:
         - name: p_mean
           jsonata: "$number(my_data.conversion_rate)"
       upsert:
         writes:
           - target: "/edges/{{edgeId}}/p/mean"
             value: "{{p_mean}}"
   ```

2. **Configure Credentials**: Add credentials for your provider in the credentials manager

3. **Test**: Use the connection in the UI to fetch data

## Troubleshooting

### Connection Not Appearing

- Check that `enabled: true` in `connections.yaml`
- Verify credentials are configured for the connection's `credsRef`
- Check browser console for connection loading errors

### Data Fetch Fails

- **Check Credentials**: Verify API keys/tokens are correct and not expired
- **Check Pre-Request Script**: Look for JavaScript errors in console
- **Check Request URL**: Verify URL template is correct (check network tab)
- **Check Response Format**: Verify JMESPath expressions match actual API response structure
- **Check Transform**: Verify JSONata expressions are correct

### Wrong Data Returned

- **Verify Query DSL**: Check that `from`, `to`, `visited` events are correct
- **Check Pre-Request Transformation**: Verify the adapter correctly maps DagNet queries to API parameters
- **Check Response Extraction**: Verify JMESPath expressions extract the right fields
- **Check Transform**: Verify JSONata expressions calculate values correctly

### Time-Series Not Working

- Ensure `context.mode === 'daily'` is set when fetching
- Verify adapter supports daily breakdown (e.g., Amplitude uses `i=1`)
- Check that `time_series` transform returns array of `{date, n, k, p}` objects
- Verify parameter file has `n_daily`, `k_daily`, `dates` fields

## Advanced Query Processing

DagNet has sophisticated query processing logic to handle complex conversion funnels, especially when conditions involve nodes that are topologically upstream or when using exclusion logic.

### Super-Funnel Construction

When a query includes `visited()` nodes that are **upstream** of the `from` node (not between `from` and `to`), DagNet builds a "super-funnel" that includes the upstream nodes.

**Example:** For an edge B→C with `visited(A)` where A is upstream of B:

```
Graph:  A → B → C
Query:  from(B).to(C).visited(A)
```

**Problem:** Amplitude (and similar funnel APIs) require all steps in sequence. A simple 2-step funnel B→C can't express "users who visited A before B".

**Solution:** Build a 3-step "super-funnel" `A → B → C`:

```javascript
// Super-funnel construction
const events = [];
let fromStepIndex = 0;

// 1. Add upstream visited nodes FIRST
if (queryPayload.visited_upstream && queryPayload.visited_upstream.length > 0) {
  events.push(...queryPayload.visited_upstream.map(id => buildEventStep(id)));
  fromStepIndex = queryPayload.visited_upstream.length;  // 'from' is now at index 1
}

// 2. Add 'from' event
events.push(buildEventStep(queryPayload.from));

// 3. Add 'to' event
events.push(buildEventStep(queryPayload.to));

// Result: [A, B, C] with fromStepIndex=1, toStepIndex=2
```

The adapter then extracts:
- `n` = `cumulativeRaw[fromStepIndex]` = users who did A→B
- `k` = `cumulativeRaw[toStepIndex]` = users who did A→B→C

### Dual-Query n/k Separation

**Critical Insight:** For upstream-conditioned queries, using the super-funnel's `n` value gives the **wrong semantics**.

**Problem:**
- Super-funnel n = users who did A→B (users who came to B via A)
- But we want n = **all users at B** (regardless of how they got there)

**Why This Matters:**

Consider edge B→C with multiple conditional paths:
- `visited(A1)`: users who came via A1
- `visited(A2)`: users who came via A2
- Base (neither): users who came via other paths

All three should partition the **same n** (total users at B). Each has its own k (users via that path who converted).

**Solution:** Run two queries:

```
┌────────────────────────────────────────────────────────────────┐
│  1. BASE QUERY (for n)                                         │
│     Strip upstream conditions → from(B).to(C)                  │
│     Returns: n = all users at B                                │
│                                                                │
│  2. CONDITIONED QUERY (for k)                                  │
│     Full super-funnel → A→B→C                                  │
│     Returns: k = users who did A→B→C                           │
│                                                                │
│  3. COMBINE                                                    │
│     p = k / n = (users via A who converted) / (all users at B) │
└────────────────────────────────────────────────────────────────┘
```

**Code (simplified from dataOperationsService.ts):**

```typescript
// Detect upstream conditions
if (queryPayload.visited_upstream?.length > 0) {
  needsDualQuery = true;
  
  // Create base query: strip upstream conditions
  baseQueryPayload = {
    ...queryPayload,
    visited_upstream: undefined,
    visitedAny_upstream: undefined
    // Keep 'visited' (between from/to) if present
  };
}

// Later in execution:
if (needsDualQuery) {
  // Query 1: Base query for n
  const baseResult = await runner.execute(connectionName, baseQueryPayload, ...);
  const baseN = baseResult.raw.n;
  
  // Query 2: Conditioned query for k
  const condResult = await runner.execute(connectionName, queryPayload, ...);
  const condK = condResult.raw.k;
  
  // Combine
  const finalN = baseN;  // All users at 'from'
  const finalK = condK;  // Users via upstream path who converted
  const finalP = finalN > 0 ? finalK / finalN : 0;
}
```

**Daily Time-Series Combination:**

For daily breakdowns, the same logic applies per-day:

```typescript
const combinedTimeSeries = [];

for (const date of allDates) {
  const baseDay = baseTimeSeries.find(d => d.date === date);
  const condDay = condTimeSeries.find(d => d.date === date);
  
  combinedTimeSeries.push({
    date,
    n: baseDay?.n ?? 0,   // From base query (all users at 'from')
    k: condDay?.k ?? 0,   // From conditioned query (conversions via path)
    p: n > 0 ? k / n : 0
  });
}
```

### Composite Query Handling (Minus/Plus)

When a query uses `exclude()` on a provider that doesn't support native exclusion (like Amplitude), DagNet compiles the query to a **composite query** with `minus()` and `plus()` terms.

**Example:**

```
Original:  from(A).to(C).exclude(B)
Compiled:  from(A).to(C).minus(from(A).to(C).visited(B))
```

**Execution:**

The composite query executor runs multiple sub-queries in parallel:

```typescript
// Base query: from(A).to(C)
const baseResult = await executeSubQuery(baseTerm);

// Minus query: from(A).to(C).visited(B)  
const minusResult = await executeSubQuery(minusTerm);

// Combine with inclusion-exclusion
const finalK = baseK - minusK;  // Subtract users who visited B
const finalP = n > 0 ? finalK / n : 0;
```

**Integration with Dual-Query:**

Composite queries with upstream conditions ALSO need dual-query handling. The base n query runs ONCE, upstream of the composite executor:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. BASE QUERY (for n) - runs first if upstream conditions     │
│                                                                 │
│  2. COMPOSITE EXECUTOR                                          │
│     ├── Base term: from(A).to(C)                                │
│     ├── Minus term: from(A).to(C).visited(B)                    │
│     └── Combine: k = base_k - minus_k                           │
│                                                                 │
│  3. FINAL COMBINE                                               │
│     └── Override composite n with base n from step 1            │
└─────────────────────────────────────────────────────────────────┘
```

### Query Processing Summary

| Query Type | n Source | k Source |
|------------|----------|----------|
| Simple (no upstream) | Single query | Single query |
| Upstream visited | Base query (stripped) | Super-funnel query |
| Composite (minus/plus) | Base query (stripped) | Composite executor |

### Semantic Correctness

**Correct (dual-query):**
- n = 1000 (all users at B)
- k = 400 (users who came via A and converted)
- p = 40% → "40% of traffic at B came via A and converted"

**Wrong (single super-funnel):**
- n = 500 (users who came to B via A)
- k = 400 (users who came via A and converted)  
- p = 80% → "80% of users from A converted"

The first interpretation is correct for flow partitioning: it tells you what **fraction of total traffic** took a specific path. The second is a conditional probability (P(C|B, visited A)) which is different.

## Best Practices

1. **Use Versioned Mode for Production**: Store data in parameter files for version control and reproducibility
2. **Set Query Signatures**: Include `query_signature` in parameter files to detect query changes
3. **Handle Missing Data**: Adapters should gracefully handle missing or zero-count data
4. **Cache Credentials**: Use the credentials manager to avoid re-entering credentials
5. **Test Incrementally**: Start with simple queries, then add complexity (visited, exclude, etc.)
6. **Monitor API Limits**: Be aware of rate limits and quota restrictions for external APIs
7. **Document Custom Adapters**: Add comments in `connections.yaml` explaining adapter-specific logic
8. **Understand Flow Partitioning**: For upstream-conditioned queries, remember that n comes from the base query (all users at 'from'), not from the conditioned super-funnel

## Further Reading

- [Query Expressions Documentation](./query-expressions.md) - Learn about DagNet Query DSL
- [Credentials Setup](./CREDENTIALS_INIT_FLOW.md) - Detailed credentials configuration guide

