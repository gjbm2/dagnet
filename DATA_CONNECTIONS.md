# Data Connections Specification

**Version:** 0.2 (Revised)  
**Status:** Draft for Review  
**Date:** 2025-11-03 (Updated)

---

## Executive Summary

This specification outlines a comprehensive data connection system for DagNet that enables bidirectional data synchronization between:
- Graph elements (nodes/edges) ↔ Parameter files
- Parameter files ↔ External data sources (Google Sheets, Amplitude)

**Key Design Decisions:**
- **Phased Implementation:** Synchronous (Phase 1) → Asynchronous batch (Phase 2) → API routes (Phase 3+)
- **Events as First-Class Objects:** Following the exact same pattern as Cases (Phase 0)
- **Unified Credentials:** Leverage existing credentials.json architecture in IndexedDB
- **Enhanced Parameter Schema:** Support for n, k, window_to for Bayesian analysis
- **User Oversight:** Interactive operations with human review before Git commits

**MVP Timeline:** Phases 0-2 (12-17 days) deliver full synchronous and asynchronous data connection capabilities.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [User Interface](#user-interface)
3. [Core Operations](#core-operations)
4. [Field Mapping System](#field-mapping-system)
5. [Data Source Connectors](#data-source-connectors)
6. [Parameter Schema Enhancements](#parameter-schema-enhancements)
7. [Event Registry (Following Cases Pattern)](#event-registry-following-cases-pattern)
8. [Implementation Phases](#implementation-phases)
9. [Open Questions & Decisions](#open-questions--decisions)

---

## 1. Architecture Overview

### 1.1 System Components

```
┌─────────────────────────────────────────────────────────────┐
│                        UI Layer                              │
│  ┌──────────────────┐         ┌──────────────────────┐     │
│  │ EnhancedSelector │         │  Data Menu (Top)     │     │
│  │  (⚡ Lightning)  │         │  - Update All        │     │
│  └──────────────────┘         └──────────────────────┘     │
└───────────────────────┬─────────────────┬───────────────────┘
                        │                 │
                        ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│                  Data Connection Service                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Core Operations:                                    │   │
│  │  • pullFromParamFile()    (A: Param → Graph)       │   │
│  │  • pushToParamFile()      (B: Graph → Param)       │   │
│  │  • retrieveLatestData()   (C: Source → Param → G)  │   │
│  │                                                      │   │
│  │  Batch Operations:                                   │   │
│  │  • updateAllFromParams()                            │   │
│  │  • updateAllParamsFromGraph()                       │   │
│  │  • retrieveLatestForAll()                           │   │
│  └─────────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────┬───────────────────┘
                        │                 │
        ┌───────────────┴─────────┐       │
        ▼                         ▼       ▼
┌──────────────────┐    ┌──────────────────────────────────┐
│  Field Mapper    │    │   Data Source Connectors         │
│  • Graph Schema  │    │   ┌──────────────────────────┐  │
│  • Param Schema  │    │   │ GoogleSheetsConnector    │  │
│  • Mapping Rules │    │   │ • authenticate()         │  │
│  • Validation    │    │   │ • retrieve()             │  │
│                  │    │   │ • close()                │  │
│                  │    │   └──────────────────────────┘  │
│                  │    │   ┌──────────────────────────┐  │
│                  │    │   │ AmplitudeConnector       │  │
│                  │    │   │ • authenticate()         │  │
│                  │    │   │ • queryFunnel()          │  │
│                  │    │   │ • batchQuery()           │  │
│                  │    │   └──────────────────────────┘  │
└──────────────────┘    └──────────────────────────────────┘
```

### 1.2 Data Flow Principles

1. **Single Source of Truth**: Parameter files are the canonical source for parameter metadata and values
2. **Graph as View**: The graph displays parameter values but doesn't own them
3. **External Sources as Input**: Data sources feed into parameter files, not directly to graph
4. **Atomic Operations**: Each operation is atomic per-parameter; batch operations aggregate atomics
5. **Audit Trail**: All data movements are logged with timestamps and source information

---

## 2. User Interface

### 2.1 EnhancedSelector Lightning Menu

**Location:** Existing `EnhancedSelector` component (node props, edge props)  
**Trigger:** Lightning bolt (⚡) icon next to parameter selector

**Menu Structure:**
```
┌─────────────────────────────────────────────────┐
│ ⚡ Data Connection                               │
├─────────────────────────────────────────────────┤
│ ↓  Pull from Parameter File                     │
│    Updates graph from current param file values │
│                                                  │
│ ↑  Push to Parameter File                       │
│    Updates param file from current graph values │
│                                                  │
│ ⟳  Retrieve Latest Data                         │
│    Fetches from external source → param → graph│
│    (Disabled if no data source configured)      │
└─────────────────────────────────────────────────┘
```

**Visual States:**
  - Lightning icon **grey**: No data source configured
  - Lightning icon **amber**: Data source configured, not recently synced
  - Lightning icon **green**: Recently synced (< 1 day)
  - Lightning icon **red** (pulsing): Sync error
  - Lightning icon **disabled**: Parameter has no data source (manual only)

### 2.2 Top Menu: Data

**Location:** New top-level menu item between "View" and "Help"

```
Data
├── Update All from Parameter Files    (Ctrl+Shift+P)
├── Update All Parameter Files from Graph (Ctrl+Shift+U)
├── Get Latest Live Data for All       (Ctrl+Shift+L)
├── ──────────────
├── Configure Data Sources...
└── View Sync History...
```

### 2.3 Status Indicators

**Parameter File State Indicators** (in Navigator):
- 🟢 Green dot: Parameter file synced with graph
- 🟡 Amber dot: Graph values differ from param file
- 🔴 Red dot: Parameter referenced but file not found
- 🔵 Blue dot: Data source configured, fresh data available
- ⭕ Unfilled circle: No data source defined (manual only)

### 2.4 Icon System & Visual Language

**Design Decision:** Consistent icon language throughout data connection features to indicate entities, states, actions, and data flow pathways.

#### Entity Icons
- **Graph:** `TrendingUpDown` or `Waypoints` (use throughout app!)
- **Param Files:** `Folders`
- **External Data:** `DatabaseZap`

#### State Icons
- **Connection States:** 
  - `Unplug` - No connection (manual values only)
  - `Plug` - Connected to parameter file
  - `HousePlug` - Connected to parameter file with live data source
- **Data Source Status:**
  - `Zap` - Live data source configured
  - `ZapOff` - Manual data only
- **Sync Status:**
  - `Check` - Synced (graph matches param file)
  - `AlertCircle` - Out of sync (values differ)
  - `Clock` - Stale (last retrieve > refresh frequency)

#### Action Icons
- **Retrieve Live Data:** `Zap`
- **Pull from Param:** `ArrowDown` (param file → graph)
- **Push to Param:** `ArrowUp` (graph → param file)

#### Pathway Visualization (Compound Icons)
Show data flow direction using compound icon sequences:
- **Via Parameter File (Default):** `DatabaseZap → Folders → TrendingUpDown`
  - External source updates param file, then graph displays it
  - Versioned, history preserved
- **Direct to Graph (Override):** `DatabaseZap → TrendingUpDown`
  - External source updates graph directly
  - Not versioned, for casual analysis
- **Sync Operations:** `TrendingUpDown ↔ Folders`
  - Bidirectional sync between graph and param files

#### Registry Icons (Updates)
- **Cases:** `Option` (update from current icon)
- **Events:** `FileExclamation` (new registry type)
- **Parameters:** Keep current
- **Nodes:** Keep current
- **Contexts:** Keep current
- **Graphs:** `TrendingUpDown` or `Waypoints` (update from current icon)

**Implementation Note:** Define icon constants in `src/config/dataConnectionIcons.ts` for consistent usage across components.

---

## 3. Core Operations

### 3.1 Operation A: Pull from Parameter File

**Purpose:** Update graph fields with values from parameter file

**Process:**
1. Identify parameter file path from parameter ID
2. Read and parse parameter YAML file
3. Extract relevant values based on field mappings
4. Apply context/time window filtering if applicable
5. Update corresponding graph elements (edge.p, edge.costs, etc.)
6. Mark graph as modified
7. Log operation with timestamp

**Edge Cases:**
- Parameter file not found → Show error, offer to create
- Multiple values in param (windowed/context) → Use most recent/applicable
- Distribution parameters (mean, stdev) → Map both values
- Locked fields in graph → Skip with warning

**Example:**
```typescript
async pullFromParamFile(
  paramId: string,
  graphElement: 'node' | 'edge',
  elementId: string,
  fieldPath: string // e.g., 'p.mean', 'costs.cost_gbp.mean'
): Promise<void>
```

### 3.2 Operation B: Push to Parameter File

**Purpose:** Update parameter file with values from graph

**Process:**
1. Identify parameter file path from parameter ID
2. Read existing parameter file (or create from template)
3. Extract current values from graph element
4. Determine update strategy:
   - If no windows/contexts: Update base value
   - If windowed: Create new time window with current timestamp
   - If contexted: Update value for current context
5. Update parameter file metadata (updated_at, version bump)
6. Write parameter file
7. Log operation with timestamp

**Edge Cases:**
- Parameter file doesn't exist → Create from template with metadata
- Value out of bounds per param constraints → Validate & warn
- Concurrent edits → Use file locking mechanism
- Graph value is null/undefined → Skip with warning

**Example:**
```typescript
async pushToParamFile(
  paramId: string,
  graphElement: 'node' | 'edge',
  elementId: string,
  fieldPath: string,
  value: number | { mean: number; stdev?: number }
): Promise<void>
```

### 3.3 Operation C: Retrieve Latest Data

**Purpose:** Pull fresh data from external source into param file, then into graph

**Process:**
1. Read parameter file to identify data_source configuration
2. If no data_source → Error: "No data source configured"
3. Instantiate appropriate connector (Sheets/Amplitude/etc.)
4. Authenticate using credentials from config
5. Retrieve data from external source
6. Transform data to parameter format
7. Update parameter file with new values (Operation B logic)
8. Update graph from parameter file (Operation A logic)
9. Close connection
10. Log operation with timestamp and data source

**Edge Cases:**
- Data source unavailable → Retry with exponential backoff
- Authentication failure → Clear invalid credentials, prompt user
- Data format mismatch → Log error, use last known good value
- Partial data retrieval → Update what succeeded, report failures
- Rate limiting → Respect source limits, queue for later

**Example:**
```typescript
async retrieveLatestData(
  paramId: string,
  graphElement: 'node' | 'edge',
  elementId: string,
  fieldPath: string
): Promise<{
  success: boolean;
  source: string;
  timestamp: string;
  value: any;
  error?: string;
}>
```

### 3.4 Batch Operations

**Implementation Pattern:**
```typescript
async updateAllFromParams(): Promise<BatchResult> {
  // 1. Collect all parameter references in graph
  const paramRefs = this.collectAllParamReferences();
  
  // 2. Execute pullFromParamFile() for each
  const results = await Promise.allSettled(
    paramRefs.map(ref => this.pullFromParamFile(...ref))
  );
  
  // 3. Aggregate results
  return this.aggregateResults(results);
}
```

**For Retrieve Latest (Batch):**
```typescript
async retrieveLatestForAll(): Promise<BatchResult> {
  // 1. Collect all parameter references with data sources
  const paramRefs = this.collectParamRefsWithDataSources();
  
  // 2. Group by data source type
  const bySource = this.groupByDataSource(paramRefs);
  
  // 3. Process each data source sequentially (to respect rate limits)
  const results = [];
  for (const [sourceType, refs] of Object.entries(bySource)) {
    const connector = this.getConnector(sourceType);
    await connector.authenticate();
    
    // 4. Batch retrieve within each source
    const batchResults = await connector.batchRetrieve(refs);
    results.push(...batchResults);
    
    await connector.close();
  }
  
  // 5. Update param files & graph with retrieved data
  await this.applyRetrievedData(results);
  
  return this.aggregateResults(results);
}
```

**Batch Result Structure:**
```typescript
interface BatchResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  details: Array<{
    paramId: string;
    status: 'success' | 'failure' | 'skipped';
    error?: string;
  }>;
  duration: number; // milliseconds
}
```

---

## 4. Field Mapping System

### 4.1 The Mapping Challenge

**Problem:** Graph schema and parameter schema have different structures but represent the same conceptual data.

**Example:**
- **Graph Edge:** `edge.p.mean` (number)
- **Parameter File:** `values[0].mean` (number within array)

### 4.2 Proposed Solution: Declarative Mapping Configuration

**Location:** `graph-editor/src/config/fieldMappings.ts`

**Structure:**
```typescript
interface FieldMapping {
  // Parameter field path (JSONPath-like)
  paramPath: string;
  
  // Graph field path
  graphPath: string;
  
  // Type of graph element this applies to
  appliesTo: 'node' | 'edge';
  
  // Parameter type filter
  paramType?: 'probability' | 'cost_gbp' | 'cost_time';
  
  // Value transformer functions
  paramToGraph?: (paramValue: any, context: MappingContext) => any;
  graphToParam?: (graphValue: any, context: MappingContext) => any;
  
  // Validation rules
  validate?: (value: any) => boolean;
  
  // Auto-populate on connect?
  autoPopulate?: boolean;
}

const FIELD_MAPPINGS: FieldMapping[] = [
  // Edge probability mappings
  {
    paramPath: 'values[].mean',
    graphPath: 'p.mean',
    appliesTo: 'edge',
    paramType: 'probability',
    paramToGraph: (val, ctx) => {
      // Find most applicable value (by time window/context)
      return ctx.selectApplicableValue(val);
    },
    graphToParam: (val, ctx) => {
      // Add new windowed value or update base value
      return ctx.appendOrUpdateValue(val);
    },
    validate: (val) => val >= 0 && val <= 1,
    autoPopulate: true
  },
  
  {
    paramPath: 'values[].stdev',
    graphPath: 'p.stdev',
    appliesTo: 'edge',
    paramType: 'probability',
    autoPopulate: true
  },
  
  {
    paramPath: 'values[].distribution',
    graphPath: 'p.distribution',
    appliesTo: 'edge',
    paramType: 'probability',
    autoPopulate: true
  },
  
  // Edge cost mappings
  {
    paramPath: 'values[].mean',
    graphPath: 'costs.cost_gbp.mean',
    appliesTo: 'edge',
    paramType: 'cost_gbp',
    autoPopulate: true
  },
  
  {
    paramPath: 'values[].mean',
    graphPath: 'costs.cost_time.mean',
    appliesTo: 'edge',
    paramType: 'cost_time',
    autoPopulate: true
  },
  
  // Node mappings (future: if we add node-level parameters)
  // ...
];
```

### 4.3 Mapping Context Selection

**Challenge:** Parameters can have multiple values (time-windowed, context-filtered)

**Selection Strategy:**
1. **Active Context Match:** If graph has active contexts, prefer values matching those contexts
2. **Time Window Match:** Prefer most recent time window that applies to current analysis date
3. **Visited Filter Match:** For conditional parameters, match visited node history
4. **Fallback to Base:** If no specific match, use base value (no window/context)

**Implementation:**
```typescript
interface MappingContext {
  activeContexts?: Record<string, string>; // e.g., { device: 'mobile' }
  analysisDate?: Date;
  visitedNodes?: string[];
  
  selectApplicableValue(paramValues: ParameterValue[]): any;
  appendOrUpdateValue(newValue: any): ParameterValue[];
}
```

### 4.4 Auto-Populate on Connect

**Behavior:** When user selects a parameter ID in EnhancedSelector, automatically populate any empty graph fields with param file values.

**Example:**
```
User action: Selects "checkout-conversion-baseline" in edge probability selector
System response:
  1. Read param file: parameters/probability/checkout-conversion-baseline.yaml
  2. Extract: { mean: 0.23, stdev: 0.04, distribution: 'beta' }
  3. Auto-populate empty fields:
     - edge.p.mean = 0.23 (if empty)
     - edge.p.stdev = 0.04 (if empty)
     - edge.p.distribution = 'beta' (if empty)
  4. Show notification: "Auto-populated 3 fields from parameter file"
```

---

## 5. Data Source Connectors

### 5.1 Connector Interface

**Base Interface:**
```typescript
interface DataSourceConnector {
  type: 'sheets' | 'amplitude' | 'api' | 'file';
  
  /**
   * Authenticate with data source
   * @throws if authentication fails
   */
  authenticate(credentials: any): Promise<void>;
  
  /**
   * Retrieve data for a single parameter
   */
  retrieve(config: DataSourceConfig): Promise<any>;
  
  /**
   * Batch retrieve for multiple parameters (optimized)
   */
  batchRetrieve(configs: DataSourceConfig[]): Promise<any[]>;
  
  /**
   * Close connection and cleanup
   */
  close(): Promise<void>;
  
  /**
   * Test connection
   */
  testConnection(): Promise<boolean>;
}

interface DataSourceConfig {
  paramId: string;
  sourceType: string;
  url?: string;
  range?: string; // For sheets
  query?: any; // For APIs/Amplitude
  transform?: string; // JSONPath or transformation expression
}
```

### 5.2 Google Sheets Connector

**Authentication Method:** Google Service Account

**Setup Process:**
1. Create Google Cloud Project
2. Enable Google Sheets API
3. Create Service Account → Download JSON key file
4. Store credentials in `~/.dagnet/credentials/google-service-account.json` <-- this breaks our creds model
5. Share target sheets with service account email (grants read access)

**Implementation:**
```typescript
class GoogleSheetsConnector implements DataSourceConnector {
  private sheets: any; // googleapis sheets client
  private auth: any;
  
  async authenticate(credentials: any): Promise<void> {
    const { google } = require('googleapis');
    
    this.auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    
    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
  }
  
  async retrieve(config: DataSourceConfig): Promise<any> {
    // Parse spreadsheet ID and range from URL
    const { spreadsheetId, range } = this.parseSheetUrl(config.url);
    
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });
    
    // Transform response to parameter value format
    return this.transformSheetData(response.data.values, config.transform);
  }
  
  async batchRetrieve(configs: DataSourceConfig[]): Promise<any[]> {
    // Group by spreadsheet ID for efficient batch fetching
    const bySpreadsheet = this.groupBySpreadsheet(configs);
    
    const results = [];
    for (const [spreadsheetId, configGroup] of Object.entries(bySpreadsheet)) {
      // Use batchGet API for multiple ranges in same sheet
      const ranges = configGroup.map(c => this.parseSheetUrl(c.url).range);
      
      const response = await this.sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges
      });
      
      // Transform each range result
      for (let i = 0; i < configGroup.length; i++) {
        results.push({
          paramId: configGroup[i].paramId,
          value: this.transformSheetData(
            response.data.valueRanges[i].values,
            configGroup[i].transform
          )
        });
      }
    }
    
    return results;
  }
  
  private parseSheetUrl(url: string): { spreadsheetId: string; range: string } {
    // Extract spreadsheet ID from Google Sheets URL
    // e.g., https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0
    // → { spreadsheetId: 'ABC123', range: 'Sheet1!A1:B2' }
    // ...
  }
  
  private transformSheetData(values: any[][], transform?: string): any {
    // Default: assume first row is headers, second row is values
    // Support JSONPath transforms for complex mappings
    // e.g., "$.values[1][2]" → third column of second row
    // ...
  }
}
```

**Parameter File Configuration Example:**
```yaml
id: checkout-conversion-mobile
name: "Checkout Conversion - Mobile"
type: probability
values:
  - mean: 0.0 # Will be updated from sheets
    data_source:
      type: sheets
      url: "https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0"
      range: "Parameters!B2:C2"
      transform: "{ mean: $[0][0], stdev: $[0][1] }"
      notes: "Updated daily from analytics dashboard"

metadata:
  data_source:
    type: sheets
    url: "https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0"
    refresh_frequency: "1d"
  # ...
```

### 5.3 Amplitude Connector

**Authentication Method:** API Key + Secret Key

**Initial Implementation Scope:**
- Markov chain order 0 (node pair transitions only)
- Simple funnel queries based on event sequences
- No conditional probability queries initially

**Future Enhancement Scope (from AMPLITUDE_INTEGRATION.MD):**
- Markov chain order n (for conditional probabilities with visited node history)
- Segment-based queries (UTM parameters, device types, etc.)
- Optimal query batching to minimize API calls
- Daily batch runs to populate parameter files

**Implementation:**
```typescript
class AmplitudeConnector implements DataSourceConnector {
  private apiKey: string;
  private secretKey: string;
  private baseUrl = 'https://amplitude.com/api/2/';
  
  async authenticate(credentials: any): Promise<void> {
    this.apiKey = credentials.apiKey;
    this.secretKey = credentials.secretKey;
    
    // Test authentication
    await this.testConnection();
  }
  
  async retrieve(config: DataSourceConfig): Promise<any> {
    // Extract event sequence from config
    const { fromEventId, toEventId } = this.parseAmplitudeQuery(config.query);
    
    // Query funnel conversion rate
    const funnelData = await this.queryFunnel([fromEventId, toEventId]);
    
    // Transform to parameter value
    return {
      mean: funnelData.conversionRate,
      stdev: this.calculateStdDev(funnelData), // From sample size
      metadata: {
        sample_size: funnelData.totalEvents,
        query_date: new Date().toISOString()
      }
    };
  }
  
  async batchRetrieve(configs: DataSourceConfig[]): Promise<any[]> {
    // Amplitude has rate limits, so we need to be careful
    // Process in chunks with delays
    const chunkSize = 10; // Max concurrent requests
    const results = [];
    
    for (let i = 0; i < configs.length; i += chunkSize) {
      const chunk = configs.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(config => this.retrieve(config))
      );
      results.push(...chunkResults);
      
      // Respect rate limits
      if (i + chunkSize < configs.length) {
        await this.delay(1000); // 1 second between chunks
      }
    }
    
    return results;
  }
  
  private async queryFunnel(eventSequence: string[]): Promise<any> {
    // Use Amplitude Funnel API
    const response = await fetch(`${this.baseUrl}funnels`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${this.apiKey}:${this.secretKey}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        e: eventSequence.map(eventId => ({ event_type: eventId })),
        // ... other funnel parameters
      })
    });
    
    return response.json();
  }
}
```

**Graph Schema Extensions for Amplitude:**
```typescript
// Add to Node schema
interface GraphNode {
  // ... existing fields ...
  event_id?: string; // Amplitude event ID for this node
}

// Add to Edge schema (for event-based transitions)
interface GraphEdge {
  // ... existing fields ...
  event_transition?: {
    from_event_id?: string;
    to_event_id?: string;
  };
}
```

**Parameter File Configuration Example:**
```yaml
id: signup-to-checkout-conversion
name: "Signup → Checkout Conversion"
type: probability
values:
  - mean: 0.0 # Will be updated from Amplitude
    data_source:
      type: amplitude
      query:
        from_event: "user_signup"
        to_event: "checkout_started"
        time_window: "30d"
      notes: "Updated daily from Amplitude funnel analysis"

metadata:
  data_source:
    type: amplitude
    refresh_frequency: "1d"
  # ...
```

### 5.4 Credentials Management

**Architecture:** Unified credentials system via `credentials.json` in IndexedDB (see `CREDENTIALS_UNIFIED_IMPLEMENTATION.md`)

**Storage Strategy:**
- **User credentials**: Stored in IndexedDB via `credentials.yaml` file (managed like other files)
- **System credentials**: Loaded from environment variables (serverless/API routes)
- **Precedence**: URL params → System secrets → IndexedDB → Public access

**Credentials Schema Structure:**
```json
{
  "version": "1.0.0",
  "git": [...],
  "googleSheets": {
    "serviceAccount": "<base64-encoded-service-account-json>",
    "token": "optional-oauth-token"
  },
  "amplitude": {
    "apiKey": "your-api-key",
    "secretKey": "your-secret-key"
  }
}
```

**Google Service Account Integration:**
- Service account JSON downloaded from Google Cloud Console
- Encode as base64 string: `btoa(JSON.stringify(serviceAccountJson))`
- Store in `credentials.yaml` under `googleSheets.serviceAccount`
- Decode at runtime when instantiating connector

**Amplitude Integration:**
- API key and secret key from Amplitude settings
- Store in `credentials.yaml` under `amplitude.apiKey` and `amplitude.secretKey`

**UI Flow:**
1. User opens **File → Credentials**
2. FormEditor opens `credentials.yaml` with schema validation
3. User pastes service account JSON or API keys
4. System validates and stores in IndexedDB
5. Connectors retrieve credentials from unified store at runtime

**Security:**
- Credentials never committed to Git (IndexedDB only)
- System-level credentials use environment variables with secrets
- URL-based credentials are temporary (not persisted)

---

## 6. Parameter Schema Enhancements

### 6.1 Required Fields for Bayesian Analysis

**Current Parameter Value Schema:**
```yaml
values:
  - mean: 0.23
    stdev: 0.04
    distribution: beta
    window_from: "2025-01-01T00:00:00Z"
    context_id: "device-mobile"
```

**Required Additions:**
- `n` (sample size): Total observations
- `k` (successes): Number of successful outcomes (for probability params)
- `window_to` (end date): Explicit end of time window

**Updated Schema:**
```yaml
values:
  - mean: 0.23
    stdev: 0.04
    distribution: beta
    n: 10000              # NEW: Sample size
    k: 2300               # NEW: Successes (for probabilities)
    window_from: "2025-01-01T00:00:00Z"
    window_to: "2025-01-31T23:59:59Z"  # NEW: Explicit end date
    context_id: "device-mobile"
```

### 6.2 Time Window Semantics

**Challenge:** Historical data may exist for different context dimensions at different time ranges.

**Solution:** Use both `window_from` and `window_to` for explicit ranges:
- If only `window_from`: Value applies from that date forward (until next window or present)
- If both: Value applies only within that specific date range
- Convention: When retrieving data, use **latest value** if multiple windows match

**Example:**
```yaml
values:
  # Historical data (Jan 2025)
  - mean: 0.23
    n: 5000
    k: 1150
    window_from: "2025-01-01T00:00:00Z"
    window_to: "2025-01-31T23:59:59Z"
    context_id: "device-mobile"
  
  # Current data (Feb 2025 onwards)
  - mean: 0.27
    n: 8000
    k: 2160
    window_from: "2025-02-01T00:00:00Z"
    # No window_to = applies forward
    context_id: "device-mobile"
  
  # Different context, older data
  - mean: 0.31
    n: 3000
    k: 930
    window_from: "2025-01-15T00:00:00Z"
    window_to: "2025-02-15T23:59:59Z"
    context_id: "device-desktop"
```

### 6.3 Context/Segment Filtering (Coming Soon)

**Preparation:** Schema already supports `context_id` for segment filtering.

**Future Enhancement:** Support multiple context dimensions:
```yaml
values:
  - mean: 0.23
    context_filters:      # Multiple dimensions
      device: mobile
      utm_source: google
      user_segment: premium
```

**Current Approach:** Use single `context_id` that references context registry. Complex filtering comes later.

### 6.4 Data Retrieval from External Sources

**When retrieving from Amplitude/Sheets:**
1. Query returns: conversion rate, sample size, success count
2. Transform to parameter format:
   - `mean` = conversion rate
   - `n` = total events in funnel step 1
   - `k` = total events in funnel step 2
   - `stdev` = calculated from n and k (binomial: `sqrt(p*(1-p)/n)`)
3. Create new time window entry with `window_from` = query timestamp
4. Append to `values[]` array (preserves historical data)

**Example Amplitude Query → Parameter:**
```typescript
// Amplitude API response
{
  funnel: {
    step1: { total: 10000 },  // checkout_started
    step2: { total: 2700 }     // purchase_completed
  }
}

// Transform to parameter value
{
  mean: 0.27,                  // 2700 / 10000
  stdev: 0.0044,               // sqrt(0.27 * 0.73 / 10000)
  n: 10000,
  k: 2700,
  distribution: "beta",
  window_from: "2025-11-03T14:30:00Z",
  data_source: {
    type: "amplitude",
    query: { ... }
  }
}
```

---

## 7. Event Registry (Following Cases Pattern)

### 7.1 Design Decision: First-Class Registry Objects

**Approach:** Events are first-class registry objects, following the exact same pattern as Cases.

**Rationale:**
1. **Consistency:** Events are canonical, reusable entities like parameters, nodes, contexts, and cases
2. **Analytics Integration:** Events are the bridge between DagNet and external analytics platforms
3. **Immutability:** Event definitions are stable and shared across teams
4. **Validation:** Prevents typos and ensures correct event references
5. **Metadata:** Centralized place for event properties, descriptions, platform mappings

### 7.2 Event Schema (Following Cases Pattern)

**File Structure:**
```
param-registry/
├── events/
│   ├── events-index.yaml          # Registry index (like cases-index.yaml)
│   └── user-signup.yaml           # Individual event definitions
│   └── checkout-started.yaml
│   └── purchase-completed.yaml
```

**Event Definition Schema** (`event-schema.yaml`):
```yaml
$schema: http://json-schema.org/draft-07/schema#
title: Event Definition Schema
description: Schema for analytics event definitions

type: object
required: [id, name, metadata]

properties:
  id:
    type: string
    pattern: ^[a-z0-9-]+$
    description: Unique event identifier
    
  name:
    type: string
    minLength: 1
    description: Human-readable event name
    
  description:
    type: string
    description: Detailed description of the event
    
  # Platform-specific mappings
  amplitude:
    type: object
    properties:
      event_type:
        type: string
        description: Amplitude event type string
      event_properties:
        type: array
        description: Expected event properties
        items:
          type: object
          properties:
            name:
              type: string
            type:
              type: string
              enum: [string, number, boolean, date]
            required:
              type: boolean
              default: false
  
  # Usage tracking
  applies_to:
    type: array
    description: Which nodes use this event
    items:
      type: object
      properties:
        graph:
          type: string
        node_id:
          type: string
        node_slug:
          type: string
  
  tags:
    type: array
    items:
      type: string
    description: Tags for categorization
  
  metadata:
    type: object
    required: [created_at, version]
    properties:
      category:
        type: string
        description: Event category (e.g., conversion, engagement)
      funnel_stage:
        type: string
        enum: [acquisition, activation, retention, revenue, referral]
      created_at:
        type: string
        format: date-time
      updated_at:
        type: string
        format: date-time
      author:
        type: string
      version:
        type: string
        pattern: ^\d+\.\d+\.\d+$
      status:
        type: string
        enum: [active, deprecated, draft, archived]
        default: active
```

**Events Index Schema** (`events-index-schema.yaml`):
```yaml
type: object
required: [version, created_at, events]

properties:
  version:
    type: string
    pattern: '^\d+\.\d+\.\d+$'
  
  created_at:
    type: string
    format: date-time
  
  updated_at:
    type: string
    format: date-time
  
  events:
    type: array
    items:
      type: object
      required: [id, file_path, status]
      properties:
        id:
          type: string
          pattern: ^[a-z0-9-]+$
        file_path:
          type: string
          pattern: ^events/[^/]+\.yaml$
        status:
          type: string
          enum: [active, deprecated, draft, archived]
        created_at:
          type: string
          format: date-time
        version:
          type: string
```

### 7.3 Graph Schema Integration

**Add to Node Schema** (`node-schema.yaml`):
```yaml
properties:
  event_id:
    type: string
    pattern: ^[a-z0-9-]+$
    description: "Reference to event in events registry"
```

**Add to Graph Schema** (`conversion-graph-1.0.0.json`):
```json
{
  "Node": {
    "properties": {
      "event_id": {
        "type": "string",
        "description": "Event reference (from events registry)"
      }
    }
  }
}
```

**Cascading Reference:**
- Node in graph references `node_id` → pulls from nodes registry
- Node registry entry has `event_id` → pulls from events registry
- Double cascade: `graph.node.id → node.event_id → event.amplitude.event_type`

### 7.4 Implementation Pattern (100% Same as Cases)

**Registry Service Extension:**
```typescript
// Add to registryService.ts
export async function loadEventRegistry(): Promise<RegistryItem[]> {
  // Exactly like loadCaseRegistry()
}

export async function getEventById(id: string): Promise<EventData | null> {
  // Exactly like getCaseById()
}
```

**Navigator Integration:**
- Events section in Navigator (like Cases, Parameters, Nodes)
- Event icons in file tree
- Click to open with FormEditor

**EnhancedSelector Integration:**
```typescript
<EnhancedSelector
  type="event"
  value={node.event_id}
  onChange={handleEventChange}
  placeholder="Select event..."
/>
```

**No New Code Required:**
- FormEditor already handles YAML files with schemas
- EnhancedSelector already handles registry references
- File state management already works
- Navigator already shows registry items

### 7.5 Example Event Definition

**File:** `events/user-signup.yaml`
```yaml
id: user-signup
name: "User Signup"
description: "User completes the signup form and creates an account"

amplitude:
  event_type: "user_signup"
  event_properties:
    - name: signup_method
      type: string
      required: true
    - name: referral_source
      type: string
      required: false

applies_to:
  - graph: onboarding-flow
    node_id: signup-node-uuid
    node_slug: signup-complete

tags:
  - acquisition
  - conversion
  - signup

metadata:
  category: conversion
  funnel_stage: acquisition
  created_at: "2025-11-03T10:00:00Z"
  author: "analytics-team"
  version: "1.0.0"
  status: active
```

---

---

## 8. Implementation Phases

### Architecture Progression: Sync → Async → API

**Phase 1:** Synchronous, single-parameter, in-app, immediate feedback  
**Phase 2:** Asynchronous, batched, background process, log file results  
**Phase 3:** API routes for system-to-system (cron jobs) — **OUT OF SCOPE FOR NOW**

**Rationale:**
- Start simple with synchronous UI operations to validate data schemas and auth
- Progress to async batching once patterns are proven
- Only build API routes once everything works smoothly in-app

---

### Phase 0: Preparation & Schemas (2-3 days)

**Goal:** Set up schemas, credentials, and events registry

**Deliverables:**
- [ ] **Parameter schema updates:**
  - Add `n` (sample size) and `k` (successes) fields to `values[]`
  - Add `window_to` (end date) alongside `window_from`
  - Support context/segment filtering (preparation for future)
- [ ] **Event registry implementation** (following cases pattern):
  - `event-schema.yaml` (lightweight, like case-schema)
  - `events-index-schema.yaml`
  - Add `event_id` to node schema and graph schema
  - Registry service extension (loadEventRegistry, getEventById)
  - Navigator integration (Events section)
  - EnhancedSelector support for event type
- [ ] **Credentials schema updates:**
  - Add `googleSheets` section (with `serviceAccount` base64 field)
  - Add `amplitude` section (with `apiKey` and `secretKey`)
  - Update credentials-schema.json
- [ ] **Field mapping documentation:**
  - Document all graph ↔ param field mappings
  - Define context selection strategy

**Success Criteria:**
- Parameter schema supports n, k, time windows (from/to)
- Events are first-class registry objects (like cases)
- Credentials system ready for Sheets + Amplitude
- Field mappings documented

---

### Phase 1: Synchronous Single-Parameter Operations (5-7 days)

**Goal:** User-triggered, immediate feedback, single parameter at a time

**Scope:** Operations A, B, C for individual parameters only (no batching)

**Deliverables:**

#### Core Service
- [ ] `DataConnectionService` class
  - `pullFromParamFile(paramId)` - Read param file → update graph
  - `pushToParamFile(paramId)` - Read graph → update param file
  - `retrieveLatestData(paramId)` - External source → param → graph
- [ ] `FieldMapper` utility
  - Map graph fields ↔ param fields
  - Handle context/time window selection
  - Validation rules

#### Data Source Connectors
- [ ] Base `DataSourceConnector` interface
- [ ] `GoogleSheetsConnector` implementation
  - Authenticate with service account (from credentials.yaml)
  - Retrieve data from spreadsheet range
  - Transform sheet data to param format
- [ ] `AmplitudeConnector` implementation (basic)
  - Authenticate with API key (from credentials.yaml)
  - Query simple funnels (node pair → event pair)
  - Transform funnel data to param format (mean, stdev, n, k)

#### UI Components
- [ ] Lightning menu in `EnhancedSelector`
  - ↓ Pull from Parameter File (Operation A)
  - ↑ Push to Parameter File (Operation B)
  - ⟳ Retrieve Latest Data (Operation C) — disabled if no data source
- [ ] Status indicators:
  - Lightning icon states (grey/amber/green/red)
  - Parameter file state dots in Navigator
- [ ] Inline feedback:
  - Success notifications
  - Error messages
  - Loading spinners during sync
- [ ] Auto-populate on parameter connect
  - When user selects param ID, auto-fill empty graph fields

#### Event-Node Mapping UI
- [ ] Event selector in Node Properties panel
- [ ] Display event metadata (from events registry)
- [ ] Validation that event exists in registry

**User Flow (Example):**
```
1. User opens edge properties
2. User selects probability parameter "checkout-conversion"
3. System auto-populates: mean=0.23, stdev=0.04 (from param file)
4. User clicks lightning icon ⚡
5. User clicks "Retrieve Latest Data"
6. System:
   - Reads param file data_source config
   - Authenticates with Amplitude
   - Queries funnel: checkout_started → purchase_completed
   - Gets: conversion_rate=0.27, n=10000, k=2700
   - Updates param file with new time window
   - Updates graph: mean=0.27
   - Shows notification: "Updated from Amplitude: 0.23 → 0.27"
7. Done (synchronous, < 5 seconds)
```

**Success Criteria:**
- User can pull/push individual parameters (synchronous, immediate feedback)
- User can retrieve latest data from Sheets or Amplitude (one param at a time)
- All operations complete in < 10 seconds
- Clear error messages if auth fails or API errors occur
- Graph and param files stay in sync

**Out of Scope (Phase 1):**
- ❌ Batch operations (all parameters at once)
- ❌ Background processing
- ❌ Top menu "Data" operations
- ❌ Advanced Amplitude queries (conditional probabilities)
- ❌ Segment-based queries

---

### Phase 2: Asynchronous Batch Operations (5-7 days)

**Goal:** Background processing for multiple parameters with log file results

**Scope:** Batch operations for all parameters, async processing

**Deliverables:**

#### Batch Service
- [ ] `BatchDataConnectionService` class
  - `updateAllFromParams()` - Batch Operation A
  - `updateAllParamsFromGraph()` - Batch Operation B
  - `retrieveLatestForAll()` - Batch Operation C
  - Group by data source for efficient batching
  - Progress tracking
- [ ] Background worker implementation
  - Run batch operations in background
  - Don't block UI during long operations
  - Cancel/pause support
- [ ] Batch optimization:
  - Google Sheets: Use `batchGet` API for multiple ranges
  - Amplitude: Respect rate limits, process in chunks
  - Parallel processing where possible

#### UI Components
- [ ] Top menu "Data"
  - Update All from Parameter Files
  - Update All Parameter Files from Graph
  - Get Latest Live Data for All
- [ ] Progress modal during batch operations:
  - Progress bar (e.g., "15 / 47 parameters processed")
  - Live status updates
  - Cancel button
- [ ] Results log file:
  - Create `batch-results-TIMESTAMP.log` in local file system
  - Auto-open in editor when batch completes
  - User can review, then discard
- [ ] Batch results summary:
  - ✓ 42 succeeded
  - ✗ 5 failed (with details)
  - ⏭ 0 skipped
  - Duration: 2m 34s
  - "Retry Failed" button

#### Error Handling
- [ ] Partial completion handling:
  - Keep successful updates
  - Report failures with details
  - Offer retry for failures only
- [ ] Rate limiting:
  - Exponential backoff for API errors
  - Respect source-specific rate limits
  - Queue for later if rate limited

**User Flow (Example):**
```
1. User clicks: Data → Get Latest Live Data for All
2. System shows modal: "Analyzing parameters... found 47 with data sources"
3. Modal updates: "Retrieving from Google Sheets... 5 / 5"
4. Modal updates: "Retrieving from Amplitude... 15 / 42"
5. Progress bar: 67% complete
6. User continues working (non-blocking)
7. After 2 minutes: "Batch complete! View results?"
8. System creates batch-results-2025-11-03-14-30.log
9. Log opens in editor:
   ✓ 42 succeeded
   ✗ 5 failed:
     - checkout-conversion: Amplitude rate limit exceeded
     - signup-rate: Sheets auth failed
     ...
10. User reviews, clicks "Retry Failed" or closes
11. User decides whether to commit changes to Git
```

**Success Criteria:**
- User can batch update all parameters without blocking UI
- Progress feedback during long operations
- Results logged to file for review
- Failed operations can be retried individually
- User has oversight before committing to Git (important!)

**Out of Scope (Phase 2):**
- ❌ API routes (serverless functions)
- ❌ Cron job scheduling
- ❌ Automated daily updates
- ❌ Advanced query optimization

---

### Phase 3: API Routes & Automation (FUTURE — OUT OF SCOPE)

**Goal:** System-to-system calls, cron jobs, automated updates

**Scope:** Build API routes for external triggers (cron, webhooks, etc.)

**Deliverables (Future):**
- [ ] API route: `/api/data/update-all`
- [ ] API route: `/api/data/retrieve-latest`
- [ ] Cron job integration (daily updates)
- [ ] Webhook endpoints for Amplitude/Sheets changes
- [ ] System credential handling (environment variables)
- [ ] Audit logging for automated operations
- [ ] Slack/email notifications for batch results

**Why Out of Scope:**
- Need to validate data schemas first (Phase 1)
- Need to validate auth flows first (Phase 1)
- Need to validate batch processing first (Phase 2)
- API routes require infrastructure setup
- Cron jobs require monitoring and alerting

**Will revisit once Phases 1-2 are stable and proven.**

---

### Phase 4: Advanced Amplitude Features (FUTURE)

**Goal:** Support conditional probabilities and complex queries

**Scope:** Markov chain order n, segment queries, query optimization

**Deliverables (Future):**
- [ ] Conditional probability support (visited node history)
- [ ] Segment-based queries (UTM, device, etc.)
- [ ] Query optimization algorithm:
  - Analyze graph for conditional_p requirements
  - Generate minimal query set with maximal coverage
- [ ] Historical data tracking
- [ ] Parameter versioning and rollback

**Why Future:**
- Requires stable Phase 1-2 foundation
- Complex query logic needs thorough testing
- Amplitude integration patterns need validation first

---

### Summary: Phased Approach

| Phase | Scope | Duration | User Interaction | Output |
|-------|-------|----------|-----------------|---------|
| **0** | Schemas, Events, Credentials | 2-3 days | Setup | Schemas ready |
| **1** | Sync single params | 5-7 days | Interactive, immediate | Success/error feedback |
| **2** | Async batch | 5-7 days | Background, review log | Log file with results |
| **3** | API routes | Future | None (automated) | System logs |
| **4** | Advanced Amplitude | Future | Interactive | Enhanced data |

**Total for MVP (Phases 0-2): 12-17 days**

---

## 9. Open Questions & Decisions

### 9.1 Field Mapping Maintenance

**Q:** How do we keep field mappings synchronized as schemas evolve?

**Options:**
- **Option A:** Manual maintenance of `fieldMappings.ts`
- **Option B:** Generate mappings from schema annotations
- **Option C:** Runtime mapping discovery via naming conventions

**Decision:** Start with Option A (manual), consider Option B for Phase 2+

### 9.2 Concurrent Edits

**Q:** What happens if user edits param file externally while graph is open?

**Options:**
- **Option A:** File watching with automatic reload
- **Option B:** Manual refresh required
- **Option C:** Lock files during editing (Git LFS-style)

**Decision:** Start with Option B (manual), add file watching in Phase 2

### 9.3 Partial Parameter References

**Q:** What if graph references parameter ID but not all fields are mapped?

**Example:** Edge references parameter for `p.mean` but not `p.stdev`

**Options:**
- **Option A:** Only sync mapped fields, leave others as-is
- **Option B:** Always sync all available fields
- **Option C:** User-configurable per parameter

**Decision:** Option A (only mapped fields) for predictability

### 9.4 Data Source Priority & Time Windows

**Q:** When retrieving from external source, how do we handle multiple existing values?

**Decision:** Option B — Create new time window with current timestamp
- Preserves historical data
- Each retrieval adds a new `values[]` entry
- Use `window_from` = query timestamp
- Optionally use `window_to` if data source specifies range

### 9.5 Error Recovery Strategy ✅

**Q:** If batch operation fails midway, how do we handle partial completion?

**Decision:** Option B — Keep successful updates, report failures, offer manual retry

**Rationale (from user):**
- Phase 1-2 are **interactive** with human oversight
- If an update fails, user can choose not to persist to Git
- Active human review **before** any commits happen
- Async/cron flows come later (Phase 3), so we have time to refine error handling
- This gives users control and prevents committing bad data

### 9.6 Amplitude Query Complexity

**Q:** How do we determine which edges need Markov order > 0 queries vs simple pair queries?

**Logic:**
- If edge has `conditional_p` with visited node filters → Needs order n query
- If edge only has base `p` → Simple pair query suffices

**Implementation:** Analyze graph structure before generating Amplitude queries (Phase 4)

### 9.7 Rate Limiting Strategy ✅

**Q:** How do we handle API rate limits for Amplitude and other sources?

**Decision:** User-triggered operations with basic rate limiting

**Rationale (from user):**
- All operations are **user-triggered** (Phases 1-2)
- Not on free tier, so rate limits less restrictive
- Implement exponential backoff for failures
- Batch operations process sequentially by source
- Cache results with TTL if needed

**Phase 3 Consideration:** When adding API routes, implement proper queueing and rate limit management

### 9.8 Credential Sharing in Teams ✅

**Q:** How do teams share credentials without committing them to Git?

**Decision:** Already solved by unified credentials architecture

**Implementation:**
- **User credentials:** Stored in IndexedDB via `credentials.yaml` (never committed)
- **System credentials:** Environment variables with secrets (serverless/API routes)
- **Precedence:** URL params → System secrets → IndexedDB → Public
- Each team member maintains own credentials locally
- System-level credentials used for automated operations (Phase 3)

**No changes needed** — existing creds architecture handles this perfectly.

### 9.9 Parameter Schema: n, k, and Time Windows ✅

**Q:** Do we need both `window_from` and `window_to`, or is `window_from` sufficient?

**Decision:** Support both `window_from` and `window_to`

**Rationale (from user):**
- Historic data may exist for different context dimensions at different times
- Some data sources provide explicit date ranges
- Convention: Use latest value if multiple windows match
- If only `window_from`: applies forward (until next window or present)
- If both: applies only within that specific range

**Schema Updates Required:**
- Add `n` (sample size) to `values[]`
- Add `k` (successes) to `values[]` for probability parameters
- Add `window_to` (end date) to `values[]`
- Update parameter-schema.yaml accordingly

---

## Appendix A: Example User Flows

### Flow 1: Pull Data from Parameter File

```
1. User opens graph, selects edge
2. User opens Edge Properties panel
3. In Probability section, user clicks parameter selector
4. User types/selects "checkout-conversion-baseline"
5. System auto-populates: mean=0.23, stdev=0.04, dist=beta
6. User sees lightning icon (⚡) next to selector (grey - no data source)
7. User manually changes mean to 0.25 in graph
8. Lightning icon turns amber (out of sync)
9. User clicks lightning icon → menu appears
10. User clicks "Pull from Parameter File"
11. System updates: mean=0.23 (reverts to param file value)
12. Lightning icon returns to grey
13. Notification: "Updated from parameter file: checkout-conversion-baseline"
```

### Flow 2: Push Data to Parameter File

```
1. User has edge with probability mean=0.28 (manually adjusted)
2. User wants to save this as new canonical value
3. User clicks lightning icon (⚡)
4. User clicks "Push to Parameter File"
5. System:
   - Opens param file: parameters/probability/checkout-conversion-baseline.yaml
   - Creates new time window with current timestamp
   - Adds: values[1] = { mean: 0.28, window_from: "2025-11-03T14:30:00Z" }
   - Updates metadata.updated_at
   - Bumps version: 1.0.0 → 1.1.0
   - Writes file
6. Notification: "Parameter file updated: checkout-conversion-baseline (v1.1.0)"
7. Lightning icon turns green (synced)
```

### Flow 3: Retrieve Latest from Google Sheets

```
1. User has param file configured with Sheets data source:
   data_source:
     type: sheets
     url: "https://docs.google.com/spreadsheets/d/ABC123"
     range: "Parameters!B2:C2"

2. User clicks lightning icon (⚡) on parameter selector
3. User clicks "Retrieve Latest Data"
4. System:
   - Reads param file, finds Sheets config
   - Authenticates with Google Service Account
   - Fetches data from range B2:C2 → [[0.31, 0.06]]
   - Transforms: { mean: 0.31, stdev: 0.06 }
   - Updates param file with new time window
   - Updates graph edge: mean=0.31, stdev=0.06
   - Closes connection
5. Notification: "Retrieved latest data from Google Sheets: mean=0.31 (was 0.28)"
6. Lightning icon turns green (fresh sync)
```

### Flow 4: Batch Update All from Amplitude

```
1. User has 20 edges in graph, each with event mappings
2. User wants to refresh all conversion rates from Amplitude
3. User clicks: Data → Get Latest Live Data for All
4. System shows modal: "Retrieving data from 2 sources (Sheets: 5, Amplitude: 15)..."
5. System:
   - Groups parameters by data source
   - Authenticates with Google Sheets
   - Batch retrieves 5 Sheets parameters
   - Closes Sheets connection
   - Authenticates with Amplitude
   - Batch retrieves 15 Amplitude funnels (with rate limiting)
   - Closes Amplitude connection
   - Updates 20 param files
   - Updates graph with new values
6. Results modal:
   ✓ 18 succeeded
   ✗ 2 failed (Amplitude rate limit exceeded)
   ⏭ 0 skipped
   Duration: 45 seconds
7. User can click "Details" to see per-parameter results
8. User can click "Retry Failed" to retry the 2 failures
```

---

## Appendix B: File Structure Summary

```
dagnet/
├── graph-editor/
│   ├── src/
│   │   ├── services/
│   │   │   ├── dataConnectionService.ts    # Core operations
│   │   │   ├── connectors/
│   │   │   │   ├── base.ts                 # DataSourceConnector interface
│   │   │   │   ├── googleSheets.ts         # GoogleSheetsConnector
│   │   │   │   └── amplitude.ts            # AmplitudeConnector
│   │   │   └── fieldMapper.ts              # Field mapping logic
│   │   ├── config/
│   │   │   └── fieldMappings.ts            # Declarative mappings
│   │   └── components/
│   │       └── EnhancedSelector.tsx        # (Enhanced with lightning menu)
│   └── public/
│       ├── schemas/
│       │   └── schema/
│       │       └── conversion-graph-1.0.0.json  # (Extended with event_id)
│       └── param-schemas/
│           ├── parameter-schema.yaml       # (Already has data_source!)
│           ├── node-schema.yaml            # (Extended with event_id - Phase 0)
│           └── event-schema.yaml           # (New - Phase 0)
│
├── param-registry/
│   ├── parameters/
│   │   ├── probability/
│   │   │   └── *.yaml                      # (Extended with data_source config)
│   │   ├── cost_gbp/
│   │   └── cost_time/
│   └── events/                             # (New)
│       ├── events-index.yaml
│       └── event-definitions/
│           └── *.yaml
│
└── ~/.dagnet/
    ├── credentials/
    │   ├── google-service-account.json
    │   └── amplitude.json
    └── config.yaml
```

---

## Appendix C: API Examples

### DataConnectionService API

```typescript
import { DataConnectionService } from './services/dataConnectionService';

const service = new DataConnectionService();

// Single parameter operations
await service.pullFromParamFile('checkout-conversion', 'edge', 'edge-uuid', 'p.mean');
await service.pushToParamFile('checkout-conversion', 'edge', 'edge-uuid', 'p.mean', 0.28);
await service.retrieveLatestData('checkout-conversion', 'edge', 'edge-uuid', 'p.mean');

// Batch operations
const result = await service.updateAllFromParams();
console.log(`Updated ${result.succeeded}/${result.total} parameters`);

// Advanced: Custom data source
service.registerConnector('custom-api', new CustomApiConnector());
```

### Field Mapper API

```typescript
import { FieldMapper } from './services/fieldMapper';

const mapper = new FieldMapper();

// Get mapping for a field
const mapping = mapper.getMapping('edge', 'p.mean', 'probability');

// Transform param → graph
const graphValue = mapper.paramToGraph(paramValue, mapping, context);

// Transform graph → param
const paramValue = mapper.graphToParam(graphValue, mapping, context);

// Get all mappings for an element type
const allMappings = mapper.getAllMappings('edge', 'probability');
```

---

## Appendix D: Schema Changes Required

### Node Schema (node-schema.yaml)

```yaml
# Add to properties:
event_id:
  type: string
  pattern: ^[a-z0-9-]+$
  description: "Event ID from events registry (for Amplitude integration)"
```

### Graph Schema (conversion-graph-1.0.0.json)

```json
{
  "Node": {
    "properties": {
      "event_id": {
        "type": "string",
        "description": "Event ID for analytics integration"
      }
    }
  }
}
```

### Parameter Schema (parameter-schema.yaml)

**Already supports data_source!** ✅ (Line 72-86)

Just need to document the extended configurations for Amplitude:

```yaml
values:
  - mean: 0.0
    data_source:
      type: amplitude
      query:
        from_event: "event-id-1"
        to_event: "event-id-2"
        time_window: "30d"
        segments: # Optional
          - device: mobile
          - utm_source: google
```

---

## Next Steps

1. **Review & Approve:** Stakeholders review this spec and provide feedback
2. **Finalize Mappings:** Document all field mappings between graph and param schemas
3. **Phase 1 Implementation:** Start with core operations (no external sources)
4. **Iterate:** Build, test, refine based on user feedback

---

**Document History:**
- 2025-11-03 (v0.1): Initial draft - Preliminary spec for review
- 2025-11-03 (v0.2): Major revisions based on user feedback:
  - Fixed credentials architecture (unified credentials.json in IndexedDB)
  - Added parameter schema enhancements (n, k, window_to)
  - Moved Events to Phase 0 (following cases pattern exactly)
  - Restructured implementation phases: Sync (Phase 1) → Async (Phase 2) → API (Phase 3)
  - Updated Open Questions with decisions and rationale
  - Clarified user oversight and error recovery strategies

