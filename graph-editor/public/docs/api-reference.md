# DagNet API Reference

## Overview

DagNet provides a comprehensive API for programmatic access to graphs, parameters, and analysis features. The API is designed for integration with external tools, automation, and custom applications.

## Authentication

### Credentials
All API operations require proper authentication credentials:

```typescript
interface Credentials {
  git: GitRepositoryCredential[];
  statsig?: StatsigCredential;
  googleSheets?: GoogleSheetsCredential;
}

interface GitRepositoryCredential {
  name: string;
  owner: string;
  repo: string;
  token: string;
  basePath?: string;
  branch?: string;
}
```

### Token Management
- **GitHub Tokens**: Required for repository access
- **Statsig API Keys**: For experiment management integration
- **Google Sheets**: For spreadsheet integration

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
  };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  label?: string;
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
  constraints?: {
    min?: number;
    max?: number;
    options?: string[];
  };
  metadata: {
    created_at: string;
    updated_at: string;
    tags?: string[];
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

### Complete Workflow Example
```typescript
async function analyzeConversionFunnel() {
  try {
    // 1. Load credentials
    const credentials = await credentialsManager.loadCredentials();
    
    // 2. Configure services
    graphGitService.setCredentials(credentials);
    paramRegistryService.setConfig({
      source: 'git',
      gitRepoOwner: credentials.git[0].owner,
      gitRepoName: credentials.git[0].repo,
      gitToken: credentials.git[0].token
    });
    
    // 3. Load graph and parameters
    const graph = await graphGitService.getGraph('conversion-funnel', 'main');
    const parameters = await paramRegistryService.loadParameter('conversion-rate');
    
    // 4. Run what-if analysis
    const overrides = { 'conversion-rate': parameters.treatment_value };
    const analysis = await whatIfService.analyze(graph, overrides);
    
    // 5. Export results
    await sheetsClient.updateSheet({
      spreadsheetId: 'analysis-results',
      range: 'Sheet1!A1',
      values: analysis.results
    });
    
    return analysis;
  } catch (error) {
    console.error('Analysis failed:', error);
    throw error;
  }
}
```

This API reference provides comprehensive coverage of DagNet's programmatic interface for building custom integrations and automation workflows.
