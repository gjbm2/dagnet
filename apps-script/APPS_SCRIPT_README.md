# Dagnet Google Apps Script Integration

This Google Apps Script provides seamless integration with your Dagnet graph editor app, allowing you to programmatically open the app, inject graph data, and monitor save operations.

## Features

- **Open Dagnet App**: Automatically opens the Dagnet app in a new tab
- **Inject JSON Data**: Seamlessly injects graph JSON data into the app
- **Save Monitoring**: Monitors for save completion and provides status updates
- **Data Validation**: Validates graph data against the Dagnet schema
- **Error Handling**: Comprehensive error handling and logging
- **Session Management**: Tracks operations with unique session IDs

## Setup Instructions

### 1. Create a New Google Apps Script Project

1. Go to [script.google.com](https://script.google.com)
2. Click "New Project"
3. Replace the default code with the contents of `dagnet-apps-script.js`

### 2. Enable Required APIs

The script uses the following Google Apps Script services:
- `HtmlService` - For creating the web interface
- `PropertiesService` - For storing session data
- `Utilities` - For UUID generation
- `SpreadsheetApp` - For Google Sheets integration (optional)

### 3. Deploy the Script

1. Click "Deploy" → "New deployment"
2. Choose "Web app" as the type
3. Set access to "Anyone with Google account"
4. Click "Deploy"
5. Copy the web app URL for later use

## Usage Examples

### Basic Usage

```javascript
// Create a sample graph
const sampleGraph = {
  "nodes": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "slug": "landing",
      "label": "Landing Page",
      "entry": { "is_start": true, "entry_weight": 1 },
      "layout": { "x": 40, "y": 60, "rank": 0 }
    },
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "slug": "purchase",
      "label": "Purchase",
      "absorbing": true,
      "outcome_type": "success",
      "layout": { "x": 240, "y": 60, "rank": 1 }
    }
  ],
  "edges": [
    {
      "id": "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "from": "landing",
      "to": "purchase",
      "p": { "mean": 0.3 }
    }
  ],
  "policies": {
    "default_outcome": "abandon",
    "overflow_policy": "error",
    "free_edge_policy": "complement"
  },
  "metadata": {
    "version": "1.0.0",
    "created_at": new Date().toISOString(),
    "author": "Apps Script",
    "description": "Generated graph"
  }
};

// Open Dagnet with the graph
const result = openDagnetWithData(sampleGraph);
console.log(result);
```

### Advanced Usage with Options

```javascript
const result = openDagnetWithData(graphData, {
  waitForSave: true,        // Wait for save completion
  timeout: 60000,           // 60 second timeout
  sheetId: 'your-sheet-id' // Optional Google Sheet ID
});
```

### Test the Integration

```javascript
// Run this function to test the integration
function testIntegration() {
  const result = testDagnetIntegration();
  console.log('Test result:', result);
}
```

## API Reference

### Main Functions

#### `openDagnetWithData(graphData, options)`

Opens the Dagnet app with injected graph data.

**Parameters:**
- `graphData` (Object): The graph JSON object to inject
- `options` (Object, optional): Configuration options
  - `waitForSave` (boolean): Whether to wait for save completion (default: true)
  - `timeout` (number): Timeout in milliseconds (default: 30000)
  - `sheetId` (string): Google Sheet ID for saving (optional)

**Returns:**
- `Object`: Result object with success status and details

#### `validateGraphData(graphData)`

Validates graph data against the Dagnet schema.

**Parameters:**
- `graphData` (Object): The graph data to validate

**Returns:**
- `Object`: Validation result with `isValid` boolean and `errors` array

#### `createSampleGraph()`

Creates a sample graph for testing purposes.

**Returns:**
- `Object`: Sample graph data

#### `testDagnetIntegration()`

Tests the complete integration workflow.

**Returns:**
- `Object`: Test result object

### Helper Functions

#### `createGraphFromSheet(sheetId, sheetName)`

Creates a graph from Google Sheets data.

**Parameters:**
- `sheetId` (string): Google Sheet ID
- `sheetName` (string): Sheet name (optional, default: 'GraphData')

**Returns:**
- `Object`: Graph data created from sheet

#### `checkSaveStatus()`

Checks the current save status.

**Returns:**
- `Object`: Current save status

#### `cleanupSession()`

Cleans up session data.

## Save Detection Mechanism

The script implements multiple methods to detect when the Save button is clicked:

1. **DOM Monitoring**: Monitors the iframe for save success messages
2. **localStorage Tracking**: Uses browser localStorage to track save status
3. **Message Passing**: Implements postMessage communication between iframe and parent
4. **Session Properties**: Uses Google Apps Script properties to store session state

## Error Handling

The script includes comprehensive error handling for:

- Invalid graph data validation
- Network connectivity issues
- Timeout scenarios
- CORS restrictions
- Save operation failures

## Troubleshooting

### Common Issues

1. **CORS Errors**: The iframe may not be able to communicate due to CORS restrictions. The script includes fallback methods.

2. **Save Detection**: If save detection isn't working, try:
   - Increasing the timeout value
   - Checking browser console for errors
   - Using the manual "Check Save Status" button

3. **Graph Validation**: Ensure your graph data follows the Dagnet schema:
   - Required fields: `nodes`, `edges`, `policies`, `metadata`
   - Valid UUIDs for node and edge IDs
   - Proper probability values (0-1)

### Debug Mode

Enable debug logging by checking the browser console when running the script.

## Integration with Google Sheets

The script can optionally integrate with Google Sheets:

```javascript
// Create graph from sheet data
const graph = createGraphFromSheet('your-sheet-id', 'GraphData');

// Open Dagnet with sheet data
const result = openDagnetWithData(graph, {
  sheetId: 'your-sheet-id'
});
```

## Security Considerations

- The script uses Google Apps Script's built-in security model
- Session data is stored in script properties (not persistent)
- No sensitive data is logged or stored permanently
- All operations are performed within Google's secure environment

## Support and Maintenance

- Check the browser console for detailed error messages
- Use the `testDagnetIntegration()` function to verify setup
- Clean up sessions with `cleanupSession()` when needed
- Monitor the Apps Script execution logs for debugging

## Example Workflows

### 1. Automated Graph Creation

```javascript
function createAndEditGraph() {
  // Create a new graph
  const graph = createSampleGraph();
  
  // Open Dagnet for editing
  const result = openDagnetWithData(graph, {
    waitForSave: true,
    timeout: 120000 // 2 minutes
  });
  
  if (result.success) {
    console.log('Graph opened for editing');
  }
}
```

### 2. Batch Processing

```javascript
function processMultipleGraphs() {
  const graphs = [graph1, graph2, graph3];
  
  graphs.forEach((graph, index) => {
    console.log(`Processing graph ${index + 1}`);
    const result = openDagnetWithData(graph);
    // Process result...
  });
}
```

### 3. Sheet Integration

```javascript
function syncWithSheet() {
  const sheetId = 'your-sheet-id';
  const graph = createGraphFromSheet(sheetId);
  
  const result = openDagnetWithData(graph, {
    sheetId: sheetId,
    waitForSave: true
  });
  
  return result;
}
```

This integration provides a powerful way to automate your Dagnet workflow while maintaining the flexibility of the visual editor.
