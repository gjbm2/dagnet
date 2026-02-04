# DagNet API Reference

## Overview

DagNet provides a comprehensive API for programmatic access to graphs, parameters, and analysis features. The API is designed for integration with external tools, automation, and custom applications.

## Authentication

### Credentials
All API operations require proper authentication credentials:

```typescript
interface CredentialsData {
  version?: string;
  git: GitRepositoryCredential[];
  statsig?: StatsigCredential;
  googleSheets?: GoogleSheetsCredential;
}

interface GitRepositoryCredential {
  name: string;              // Unique identifier and repository name
  owner: string;             // GitHub organization or user
  token: string;             // GitHub personal access token
  basePath?: string;         // Base path within repository
  branch?: string;           // Default branch (defaults to 'main')
  isDefault?: boolean;       // Mark as default repository
  userName?: string;         // Display name for file authorship
  graphsPath?: string;       // Custom path for graphs
  paramsPath?: string;       // Custom path for parameters
  contextsPath?: string;     // Custom path for contexts
  casesPath?: string;        // Custom path for cases
  nodesPath?: string;        // Custom path for nodes
}

interface StatsigCredential {
  token: string;
}

interface GoogleSheetsCredential {
  token: string;
}
```

### Token Management
- **GitHub Tokens**: Required for repository access (read/write permissions)
- **Statsig API Keys**: For experiment management integration
- **Google Sheets Tokens**: OAuth tokens for spreadsheet access

### Credential Sources
Credentials can be loaded from multiple sources:
- **User Storage**: Stored in browser IndexedDB
- **URL Parameters**: Passed via `?secret` or `?creds`
- **System Environment**: Server-side environment variables
- **Public Repositories**: Read-only access without authentication

```typescript
type CredentialSource = 'user' | 'system' | 'url' | 'none' | 'public';
```

## Graph Operations

### Loading Graphs
```typescript
// Load a graph from repository
const graph = await graphGitService.getGraph('conversion-funnel', 'main');

// Load with specific credentials
const graph = await graphGitService.getGraph('conversion-funnel', 'main', credentials);
```

### Graph Data Structure
```typescript
interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    name: string;
    description?: string;
    version: string;
    created_at: string;
    updated_at: string;
  };
}

interface GraphNode {
  id: string;
  type: 'conversion' | 'decision' | 'start' | 'end';
  name: string;
  position: { x: number; y: number };
  data: {
    conversion_rate?: number;
    cost?: number;
    description?: string;
    parameter?: string;  // Link to parameter file
  };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  label?: string;
  costs?: {
    monetary?: {
      value: number;
      stdev?: number;
      distribution?: 'normal' | 'lognormal' | 'gamma' | 'uniform';
      currency?: 'GBP' | 'USD' | 'EUR' | string;
    };
    time?: {
      value: number;
      stdev?: number;
      distribution?: 'normal' | 'lognormal' | 'gamma' | 'uniform';
      units?: 'days' | 'hours' | 'weeks';
    };
  };
}
```

### Creating and Updating Graphs
```typescript
// Create new graph
const newGraph = {
  nodes: [
    { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 } },
    { id: 'step1', type: 'conversion', name: 'Landing Page', position: { x: 100, y: 0 } }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'step1', weight: 1.0 }
  ],
  metadata: {
    name: 'New Conversion Funnel',
    version: '1.0.0',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
};

// Save graph
await graphGitService.saveGraph('new-funnel', newGraph, 'main');
```

## Parameter Operations

### Loading Parameters
```typescript
// Load parameter registry
const registry = await paramRegistryService.loadRegistry();

// Load specific parameter
const parameter = await paramRegistryService.loadParameter('conversion-rate');

// Load with Git configuration
paramRegistryService.setConfig({
  source: 'git',
  gitRepoOwner: 'your-org',
  gitRepoName: 'your-repo',
  gitToken: 'your-token',
  gitBranch: 'main'
});
```

### Parameter Data Structure
```typescript
interface Parameter {
  id: string;
  name: string;
  description?: string;
  type: 'number' | 'string' | 'boolean' | 'object';
  default_value: any;
  
  // Enhanced value specification
  value?: any;  // Current value (overrides default_value)
  
  // Bayesian analysis parameters
  n?: number;                    // Sample size
  k?: number;                    // Number of successes
  window_to?: string;            // Time window (e.g., "2025-01-01")
  
  // Data source connection
  data_source?: {
    type: 'google_sheets' | 'amplitude' | 'manual';
    config: {
      spreadsheet_id?: string;   // For Google Sheets
      range?: string;            // For Google Sheets
      query?: any;               // For Amplitude
      refresh_interval?: string;  // e.g., "1h", "1d"
    };
  };
  
  constraints?: {
    min?: number;
    max?: number;
    options?: string[];
  };
  
  metadata: {
    created_at: string;
    updated_at: string;
    tags?: string[];
    author?: string;
    version?: string;
    last_synced?: string;       // When data was last synced
  };
}
```

## What-If Analysis API

### Setting Overrides
```typescript
// Set parameter overrides
const overrides = {
  'conversion-rate': 0.25,
  'cost-per-click': 0.15
};

// Apply overrides to analysis
const analysis = await whatIfService.analyze(graph, overrides);
```

### Path Analysis
```typescript
// Analyze conversion paths
const pathAnalysis = await pathAnalysisService.analyzePaths(
  graph,
  startNodes: ['landing-page'],
  endNodes: ['conversion']
);

// Get detailed path information
const paths = pathAnalysis.paths;
const bottlenecks = pathAnalysis.bottlenecks;
const recommendations = pathAnalysis.recommendations;
```

## Context and Case Management

### Context Operations
```typescript
// Load context definitions
const contexts = await paramRegistryService.loadContexts();

// Create new context
const newContext = {
  id: 'mobile-users',
  name: 'Mobile Users',
  description: 'Context for mobile device users',
  parameters: {
    'conversion-rate': 0.20,
    'bounce-rate': 0.60
  }
};

await paramRegistryService.saveContext('mobile-users', newContext);
```

### Case Operations
```typescript
// Load experiment cases
const cases = await paramRegistryService.loadCases();

// Create experiment case
const experimentCase = {
  id: 'test-variant-a',
  name: 'Variant A Test',
  description: 'Testing new landing page design',
  parameters: {
    'conversion-rate': 0.28,
    'cost-per-click': 0.12
  },
  metadata: {
    experiment_id: 'exp-001',
    variant: 'A',
    traffic_allocation: 0.5
  }
};

await paramRegistryService.saveCase('test-variant-a', experimentCase);
```

## Node Management

### Node Operations
```typescript
// Load node definitions
const nodes = await nodeService.loadNodes();

// Get specific node
const node = await nodeService.loadNode('landing-page');

// Create new node
const newNode = {
  id: 'landing-page',
  name: 'Landing Page',
  description: 'Main landing page for campaign',
  type: 'conversion',
  parameters: {
    'conversion-rate': 'landing-conversion-rate',
    'cost-per-visit': 'landing-cost'
  },
  metadata: {
    created_at: new Date().toISOString(),
    author: 'user@example.com'
  }
};

await nodeService.saveNode('landing-page', newNode);
```

## Data Connections API

### Connecting Parameters to Data Sources

#### Google Sheets Connection
```typescript
// Configure Google Sheets data source
const parameter = {
  id: 'conversion-rate',
  name: 'Conversion Rate',
  type: 'number',
  data_source: {
    type: 'google_sheets',
    config: {
      spreadsheet_id: '1abc123def456',
      range: 'Sheet1!A2:B2',
      refresh_interval: '1h'
    }
  }
};

// Retrieve latest data from source
const updatedParameter = await dataConnectionService.retrieveLatestData(parameter);
```

#### Amplitude Connection
```typescript
// Configure Amplitude data source
const parameter = {
  id: 'signup-conversion',
  name: 'Signup Conversion Rate',
  type: 'number',
  data_source: {
    type: 'amplitude',
    config: {
      query: {
        event_type: 'signup',
        group_by: ['date'],
        metrics: ['conversion_rate']
      },
      refresh_interval: '6h'
    }
  },
  n: 1000,  // Sample size for Bayesian analysis
  k: 250    // Number of conversions
};
```

### Data Synchronization Operations

#### Pull from Parameter File
```typescript
// Update graph element with value from parameter file
await dataConnectionService.pullFromParamFile(
  graphElement,
  parameterName
);
```

#### Push to Parameter File
```typescript
// Update parameter file with value from graph element
await dataConnectionService.pushToParamFile(
  graphElement,
  parameterName
);
```

#### Retrieve Latest from Data Source
```typescript
// Fetch latest data from external source, update parameter, then graph
await dataConnectionService.retrieveLatestData(
  parameterName,
  updateGraph = true
);
```

#### Batch Operations
```typescript
// Update all graph elements from their linked parameters
await dataConnectionService.updateAllFromParams(graphId);

// Update all parameters from graph element values
await dataConnectionService.updateAllParamsFromGraph(graphId);

// Retrieve latest data for all parameters with data sources
await dataConnectionService.retrieveLatestForAll(graphId);
```

## Snapshot Database API

The Snapshot API provides endpoints for storing and querying historical conversion data.

### Append Snapshots

Store time-series data for a parameter.

**Endpoint:** `POST /api/snapshots/append`

```typescript
interface AppendSnapshotsRequest {
  param_id: string;         // Workspace-prefixed parameter ID
  core_hash: string;        // Query signature hash
  slice_key: string;        // Context slice ('' for uncontexted)
  retrieved_at: string;     // ISO timestamp
  rows: SnapshotRow[];      // Daily data rows
}

interface SnapshotRow {
  anchor_day: string;       // ISO date (cohort entry date)
  A?: number;               // Anchor count (cohort mode)
  X: number;                // Denominator (users who could convert)
  Y: number;                // Numerator (users who converted)
  median_lag_days?: number; // Median conversion lag
  mean_lag_days?: number;   // Mean conversion lag
  anchor_median_lag_days?: number;
  anchor_mean_lag_days?: number;
  onset_delta_days?: number;
}

// Response
interface AppendSnapshotsResponse {
  success: boolean;
  inserted: number;         // Rows inserted (excludes duplicates)
  diagnostic?: {
    has_anchor: boolean;
    has_latency: boolean;
    date_range: string;
  };
}
```

### Query Snapshots Inventory

Get snapshot availability for multiple parameters.

**Endpoint:** `POST /api/snapshots/inventory`

```typescript
interface InventoryRequest {
  param_ids: string[];      // List of workspace-prefixed param IDs
}

interface InventoryResponse {
  success: boolean;
  inventory: SnapshotInventory[];
}

interface SnapshotInventory {
  param_id: string;
  row_count: number;
  earliest_anchor: string | null;  // ISO date
  latest_anchor: string | null;    // ISO date
  total_days: number;              // Days with data
  expected_days: number;           // Days in range
}
```

### Delete Snapshots

Remove all snapshots for a parameter.

**Endpoint:** `POST /api/snapshots/delete`

```typescript
interface DeleteRequest {
  param_id: string;         // Exact param_id to delete
}

interface DeleteResponse {
  success: boolean;
  deleted: number;          // Rows deleted
}
```

### Query Virtual Snapshot (as-at)

Retrieve the **virtual snapshot** for a parameter “as of” a point-in-time. This is used by the query DSL `asat(...)` / `at(...)` historical query mode.

The virtual snapshot returns **at most one row per** `(anchor_day, slice_key)` — selecting the latest available snapshot row with `retrieved_at <= as_at` — and includes metadata for UI warnings.

**Endpoint:** `POST /api/snapshots/query-virtual`

```typescript
interface QueryVirtualRequest {
  param_id: string;         // Workspace-prefixed parameter ID
  as_at: string;            // ISO datetime (e.g. "2026-02-04T23:59:59.999Z")
  anchor_from: string;      // ISO date (YYYY-MM-DD)
  anchor_to: string;        // ISO date (YYYY-MM-DD)
  core_hash: string;        // Query signature (required for semantic integrity)
  slice_keys?: string[];    // Optional slice keys ('' for uncontexted)
  limit?: number;           // Optional max rows (default backend: 10000)
}

interface QueryVirtualResponse {
  success: boolean;
  rows: Array<{
    anchor_day: string;     // ISO date
    slice_key: string;
    core_hash: string;
    retrieved_at: string;   // ISO datetime
    a?: number | null;
    x?: number | null;
    y?: number | null;
    median_lag_days?: number | null;
    mean_lag_days?: number | null;
    anchor_median_lag_days?: number | null;
    anchor_mean_lag_days?: number | null;
    onset_delta_days?: number | null;
  }>;
  count: number;
  latest_retrieved_at_used: string | null;
  has_anchor_to: boolean;
  has_any_rows?: boolean;
  has_matching_core_hash?: boolean;
  error?: string;
}
```

### Snapshot Analysis

Run analytics on stored snapshot data.

**Endpoint:** `POST /api/runner/analyze` (with `snapshot_query`)

```typescript
interface SnapshotAnalysisRequest {
  snapshot_query: {
    param_id: string;
    core_hash?: string;
    anchor_from: string;    // ISO date
    anchor_to: string;      // ISO date
    slice_keys?: string[];
  };
  analysis_type: 'lag_histogram' | 'daily_conversions';
}

// Lag Histogram Response
interface LagHistogramResult {
  analysis_type: 'lag_histogram';
  data: Array<{
    lag_days: number;
    conversions: number;
    pct: number;
  }>;
  total_conversions: number;
  cohorts_analysed: number;
}

// Daily Conversions Response
interface DailyConversionsResult {
  analysis_type: 'daily_conversions';
  data: Array<{
    date: string;
    conversions: number;
  }>;
  total_conversions: number;
  date_range: { from: string; to: string };
}
```

### Health Check

Check database connectivity.

**Endpoint:** `GET /api/snapshots/health`

```typescript
interface HealthResponse {
  status: 'ok' | 'error';
  database: 'connected' | 'unavailable';
  message?: string;
}
```

## Credentials Management API

### Loading Credentials
```typescript
// Initialize credentials manager
const credentialsManager = CredentialsManager.getInstance();

// Load from multiple sources (in priority order)
const result = await credentialsManager.initialize();
// Sources checked: URL → User Storage → System → Public

// Load from specific source
const urlResult = await credentialsManager.loadFromURL();
const userResult = await credentialsManager.loadFromUserStorage();
const systemResult = await credentialsManager.loadFromSystem();
```

### Managing Credentials
```typescript
// Save credentials to user storage
await credentialsManager.saveCredentials({
  version: '1.0.0',
  git: [{
    name: 'my-repo',
    owner: 'my-org',
    token: 'ghp_xxx',
    branch: 'main',
    isDefault: true
  }]
});

// Get default Git credentials
const defaultCreds = credentialsManager.getDefaultGitCredentials();

// Clear credentials
await credentialsManager.clearCredentials();
```

## Settings Management API

### Application Settings
```typescript
interface SettingsData {
  ui?: {
    theme?: 'light' | 'dark' | 'auto';
    defaultViewMode?: 'interactive' | 'raw-json' | 'raw-yaml';
    autoSave?: boolean;
    showLineNumbers?: boolean;
    fontSize?: number;
  };
  development?: {
    devMode?: boolean;
    debugGitOperations?: boolean;
  };
  repositories?: Array<{
    name: string;
    repoOwner: string;
    repoName: string;
  }>;
}

// Load settings
const settings = await db.settings.get('app');

// Save settings
await db.settings.put({
  id: 'app',
  ...settingsData
});

// Merge URL settings with existing settings
import { parseURLSettings, mergeSettings } from './lib/urlSettings';

const urlSettings = parseURLSettings(new URLSearchParams(window.location.search));
const merged = mergeSettings(existingSettings, urlSettings);
```

## File Operations

### File Management
```typescript
// List files in repository
const files = await gitService.getDirectoryContents('graphs', 'main');

// Get file content
const content = await gitService.getFileContent('graphs/conversion-funnel.json', 'main');

// Save file changes
await gitService.saveFile('graphs/conversion-funnel.json', content, 'main');
```

### Branch Operations
```typescript
// List branches
const branches = await gitService.getBranches();

// Create new branch
await gitService.createBranch('feature/new-analysis', 'main');

// Switch branch
await gitService.switchBranch('feature/new-analysis');
```

## Integration APIs

### Google Sheets Integration
```typescript
// Export data to Google Sheets
const sheetData = {
  spreadsheetId: 'your-sheet-id',
  range: 'Sheet1!A1:Z100',
  values: analysisResults
};

await sheetsClient.updateSheet(sheetData);
```

### Statsig Integration
```typescript
// Send experiment data to Statsig
const experimentData = {
  experiment_id: 'conversion-test',
  user_id: 'user-123',
  variant: 'treatment',
  metrics: {
    conversion_rate: 0.25,
    cost_per_conversion: 4.00
  }
};

await statsigClient.trackExperiment(experimentData);
```

## Error Handling

### Common Error Types
```typescript
interface APIError {
  code: string;
  message: string;
  details?: any;
}

// Authentication errors
const authError: APIError = {
  code: 'AUTHENTICATION_FAILED',
  message: 'Invalid or expired credentials'
};

// Validation errors
const validationError: APIError = {
  code: 'VALIDATION_ERROR',
  message: 'Invalid graph data structure',
  details: { field: 'nodes', issue: 'Missing required property: id' }
};

// Network errors
const networkError: APIError = {
  code: 'NETWORK_ERROR',
  message: 'Failed to connect to repository'
};
```

### Error Handling Best Practices
```typescript
try {
  const graph = await graphGitService.getGraph('my-graph', 'main');
} catch (error) {
  if (error.code === 'AUTHENTICATION_FAILED') {
    // Prompt user to update credentials
    await credentialsManager.refreshCredentials();
  } else if (error.code === 'NETWORK_ERROR') {
    // Retry with exponential backoff
    await retryWithBackoff(() => graphGitService.getGraph('my-graph', 'main'));
  } else {
    // Log error and show user-friendly message
    console.error('Unexpected error:', error);
    showErrorMessage('Failed to load graph. Please try again.');
  }
}
```

## Rate Limits and Best Practices

### Rate Limiting
- **GitHub API**: 5000 requests per hour for authenticated users
- **Statsig API**: 1000 requests per minute
- **Google Sheets API**: 100 requests per 100 seconds per user

### Best Practices
1. **Cache Results**: Store frequently accessed data locally
2. **Batch Operations**: Combine multiple API calls when possible
3. **Error Handling**: Always handle errors gracefully
4. **Authentication**: Refresh tokens before they expire
5. **Validation**: Validate data before sending to API

## Examples

### Complete Workflow Example with Data Connections
```typescript
async function analyzeConversionFunnelWithLiveData() {
  try {
    // 1. Initialize credentials
    const credentialsManager = CredentialsManager.getInstance();
    await credentialsManager.initialize();
    
    // 2. Configure services
    const defaultCreds = credentialsManager.getDefaultGitCredentials();
    graphGitService.setCredentials(defaultCreds);
    
    // 3. Load graph and parameters
    const graph = await graphGitService.getGraph('conversion-funnel', 'main');
    const parameters = await paramRegistryService.loadParameter('conversion-rate');
    
    // 4. Sync latest data from external sources
    await dataConnectionService.retrieveLatestForAll(graph.id);
    
    // 5. Update graph elements from parameters
    await dataConnectionService.updateAllFromParams(graph.id);
    
    // 6. Run what-if analysis with live data
    const overrides = { 
      'conversion-rate': parameters.value || parameters.default_value 
    };
    const analysis = await whatIfService.analyze(graph, overrides);
    
    // 7. Export results to Google Sheets
    await sheetsClient.updateSheet({
      spreadsheetId: 'analysis-results',
      range: 'Sheet1!A1',
      values: analysis.results
    });
    
    // 8. Save updated parameters back to Git
    if (parameters.data_source) {
      await paramRegistryService.saveParameter(parameters.id, parameters);
      await gitService.commit('Updated parameters with latest data', 'main');
    }
    
    return analysis;
  } catch (error) {
    console.error('Analysis failed:', error);
    throw error;
  }
}

// Example: Working with multiple repositories
async function syncAcrossRepositories() {
  const credentials = await credentialsManager.getCurrentCredentials();
  
  // Work with first repository
  const repo1Data = await graphGitService.getGraph(
    'conversion-funnel', 
    'main',
    credentials.git[0]
  );
  
  // Work with second repository
  const repo2Data = await paramRegistryService.loadParameter(
    'shared-conversion-rate',
    credentials.git[1]
  );
  
  // Merge and analyze
  const merged = mergeDataSources(repo1Data, repo2Data);
  return await whatIfService.analyze(merged);
}
```

This API reference provides comprehensive coverage of DagNet's programmatic interface for building custom integrations and automation workflows.
