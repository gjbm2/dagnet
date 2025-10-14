/**
 * Simplified Google Apps Script for Dagnet roundtrip:
 * - Menu: Dagnet → Initialize, Edit graph
 * - editGraph: opens Dagnet with selected cell JSON (empty cell = '', JSON cell = pass JSON)
 * - doPost: receives graph JSON and writes back to the same cell
 * - getCurrentWebAppUrl: returns current deployment URL
 * - GraphCalc: calculates analytics on direct JSON (no graph:// pointers or history)
 */

const DAGNET_APP_URL = 'https://dagnet-nine.vercel.app/';
const SCRIPT_VERSION = '2025-01-15-SIMPLIFIED'; // Change this every time you edit!

// ===== NAMED CONSTANTS FOR GRAPHCALC FUNCTION =====
// These will appear in Google Sheets autocomplete and tooltips

/**
 * @const {string} PROBABILITY - Calculate probability from start to end node
 */
const PROBABILITY = 'probability';

/**
 * @const {string} COST - Calculate expected cost from start to end node
 */
const COST = 'cost';

/**
 * @const {string} TIME - Calculate expected time from start to end node
 */
const TIME = 'time';

/**
 * @const {string} ANY_SUCCESS - Target any success node
 */
const ANY_SUCCESS = 'anySuccess';

/**
 * @const {string} ANY_FAILURE - Target any failure node
 */
const ANY_FAILURE = 'anyFailure';

/**
 * @const {string} DEFAULT_SCENARIO - Use default scenario parameters
 */
const DEFAULT_SCENARIO = 'Default';

/**
 * @const {string} NODES - Extract only node parameters
 */
const NODES = 'nodes';

/**
 * @const {string} EDGES - Extract only edge parameters
 */
const EDGES = 'edges';

/**
 * @const {string} GLOBAL - Extract only global parameters
 */
const GLOBAL = 'global';

/**
 * Create menu when spreadsheet opens
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Dagnet')
      .addItem('Initialize', 'initialize')
      .addItem('Edit graph', 'editGraph')
      .addToUi();
  } catch (e) {
    SpreadsheetApp.getUi().alert('Error in onOpen: ' + e.message);
  }
}

/**
 * Initialize the script - check web app URL
 */
function initialize() {
  var ui = SpreadsheetApp.getUi();
  
  // Check/Update web app URL
  var currentUrl = getCurrentWebAppUrl();
  
  if (!currentUrl) {
    ui.alert('No web app URL found. You need to deploy this script as a web app first:\n\n1. Deploy → New deployment\n2. Choose "Web app"\n3. Execute as: Me\n4. Who has access: Anyone\n5. Click Deploy\n6. Copy the "Current web app URL"\n7. Run Initialize again');
    return;
  }
  
  // Always allow URL update
  var response = ui.alert(
    'Current web app URL: ' + currentUrl + '\n\nDo you want to update the URL?',
    'Update URL?',
    ui.ButtonSet.YES_NO
  );
  
  var urlToTest = currentUrl;
  if (response === ui.Button.YES) {
    var newUrl = Browser.inputBox('Paste the new web app URL:');
    if (newUrl && newUrl !== 'cancel') {
      setWebAppUrl(newUrl);
      urlToTest = newUrl;
    } else {
      ui.alert('URL update cancelled.');
      return;
    }
  }
  
  // Test the URL
  var testResult = testWebAppUrl(urlToTest);
  if (testResult.success) {
    ui.alert('✅ Setup complete! Web app URL is working.\n\nYou can now use "Edit graph" from the menu.');
  } else {
    ui.alert('❌ Web app URL not working: ' + urlToTest + '\n\nPlease check the deployment settings.');
  }
}

/**
 * Edit graph - opens Dagnet with selected cell contents
 */
function editGraph() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();
  const cellA1 = activeRange.getA1Notation();
  let cellValue = activeRange.getDisplayValue() || activeRange.getValue();
  
  // If cell is empty, pass empty string to Vercel app
  let jsonString = '';
  if (cellValue && cellValue.toString().trim() !== '') {
    jsonString = cellValue.toString();
  }

  const sessionId = Utilities.getUuid();
  const sheetId = sheet.getParent().getId();
  let appsScriptUrl = getCurrentWebAppUrl();
  
  // If no URL or URL doesn't work, prompt user to fix it
  if (!appsScriptUrl) {
    SpreadsheetApp.getUi().alert('No web app URL found. You need to deploy this script as a web app first:\n\n1. Deploy → New deployment\n2. Choose "Web app"\n3. Execute as: Me\n4. Who has access: Anyone\n5. Click Deploy\n6. Copy the "Current web app URL"\n7. Try again');
    return;
  }
  
  // Test the URL before proceeding
  var testResult = testWebAppUrl(appsScriptUrl);
  if (!testResult.success) {
    var ui = SpreadsheetApp.getUi();
    ui.alert('❌ Web app URL not working: ' + appsScriptUrl + '\n\nPlease:\n1. Go to Deploy → Manage deployments\n2. Copy the "Current web app URL"\n3. Try again and paste it');
    var newUrl = Browser.inputBox('Paste the correct web app URL:');
    if (newUrl && newUrl !== 'cancel') {
      setWebAppUrl(newUrl.trim());
      var retest = testWebAppUrl(newUrl.trim());
      if (retest.success) {
        appsScriptUrl = newUrl.trim();
        ui.alert('✅ Fixed! Opening Dagnet...');
      } else {
        ui.alert('❌ Still not working. Check the deployment settings.');
        return;
      }
    } else {
      return;
    }
  }

  const appUrl = DAGNET_APP_URL
    + '?data=' + encodeURIComponent(jsonString)
    + '&session=' + encodeURIComponent(sessionId)
    + '&outputCell=' + encodeURIComponent(cellA1)
    + '&sheetId=' + encodeURIComponent(sheetId)
    + '&appsScriptUrl=' + encodeURIComponent(appsScriptUrl);

  const html = HtmlService.createHtmlOutput(`
    <!doctype html>
    <html><body style="font-family:Arial;padding:16px;text-align:center">
      <h3>Opening Dagnet…</h3>
      <p>If it doesn't open, <a href="${appUrl}" target="_blank">click here</a>.</p>
      <button onclick="google.script.host.close()" style="margin-top:10px;padding:8px 16px">Close</button>
      <script>
        (function(){
          var w = window.open(${JSON.stringify(appUrl)}, '_blank');
          if (w) {
            setTimeout(function(){ google.script.host.close(); }, 10000);
          }
        })();
      </script>
    </body></html>
  `).setWidth(380).setHeight(180);

  SpreadsheetApp.getUi().showModalDialog(html, 'Dagnet');
}

/**
 * Web app POST endpoint: writes graphData JSON back to the specified cell.
 * Expects: sessionId, sheetId, outputCell, graphData
 */
function doPost(e) {
  try {
    var body = e && e.postData && e.postData.type === 'application/json'
      ? JSON.parse(e.postData.contents || '{}')
      : (e && e.parameter) || {};

    var sheetId = body.sheetId;
    var outputCell = body.outputCell;
    var graphData = body.graphData;

    if (!sheetId || !outputCell || !graphData) {
      return ContentService.createTextOutput(JSON.stringify({ success:false, error:'Missing fields', received:body }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var sheet = SpreadsheetApp.openById(sheetId).getActiveSheet();
    var cell = sheet.getRange(outputCell);
    var jsonString = typeof graphData === 'string' ? graphData : JSON.stringify(graphData);
    try { jsonString = JSON.stringify(JSON.parse(jsonString), null, 2); } catch (ignore) {}
    
    // Simply update the cell with the returned JSON
    cell.setValue(jsonString);

    return ContentService.createTextOutput(JSON.stringify({ success:true, received:body }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success:false, error: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Get current web app URL from script properties
 */
function getCurrentWebAppUrl() {
  return PropertiesService.getScriptProperties().getProperty('DAGNET_WEB_APP_URL');
}

/**
 * Set web app URL in script properties
 */
function setWebAppUrl(url) {
  PropertiesService.getScriptProperties().setProperty('DAGNET_WEB_APP_URL', url);
  SpreadsheetApp.getUi().alert('Stored web app URL: ' + url + '\n\nRun Initialize to verify.');
}

/**
 * Test if web app URL is working
 */
function testWebAppUrl(url) {
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'GET',
      muteHttpExceptions: true
    });
    return { success: response.getResponseCode() === 200, status: response.getResponseCode() };
  } catch (e) {
    return { success: false, status: 'error' };
  }
}

/**
 * Normalize web app URL format
 */
function normalizeWebAppUrl(url) {
  // Convert from Google Apps Script format to standard format
  var m = url.match(/^https:\/\/script\.google\.com\/a\/[^/]+\/macros\/s\/([^/]+)\/exec$/);
  return m ? ('https://script.google.com/macros/s/' + m[1] + '/exec') : url;
}

/**
 * ParamsTable function - builds JSON dictionary from parameter table
 * Usage: =ParamsTable(A1:C3, 'Scenario 2')
 * Table format: param names in first column, scenario names in first row
 * Returns JSON string with parameter values for the specified scenario
 */
function ParamsTable(tableRange, scenarioName) {
  try {
    var sheet = SpreadsheetApp.getActiveSheet();
    var range = sheet.getRange(tableRange);
    var values = range.getValues();
    
    if (values.length < 2 || values[0].length < 2) {
      return "Error: Table must have at least 2 rows and 2 columns";
    }
    
    // Find scenario column
    var scenarioColumn = -1;
    for (var col = 1; col < values[0].length; col++) {
      if (values[0][col] === scenarioName) {
        scenarioColumn = col;
        break;
      }
    }
    
    if (scenarioColumn === -1) {
      return "Error: Scenario '" + scenarioName + "' not found in table";
    }
    
    // Build parameter dictionary
    var params = {};
    for (var row = 1; row < values.length; row++) {
      var paramName = values[row][0];
      var paramValue = values[row][scenarioColumn];
      
      if (paramName && paramName.toString().trim() !== '') {
        // Try to parse as number if possible, otherwise keep as string
        var parsedValue = paramValue;
        if (typeof paramValue === 'string' && !isNaN(paramValue) && paramValue.trim() !== '') {
          parsedValue = parseFloat(paramValue);
        }
        params[paramName.toString().trim()] = parsedValue;
      }
    }
    
    return JSON.stringify(params);
  } catch (e) {
    return "Error: " + e.message;
  }
}

/**
 * GetParamTable function - extracts parameters from a graph and returns multi-row/column result
 * Usage: 
 *   =GetParamTable(M1) - extracts all parameters from graph in M1
 *   =GetParamTable(M1, NODES) - extracts only node parameters
 *   =GetParamTable(M1, EDGES) - extracts only edge parameters  
 *   =GetParamTable(M1, GLOBAL) - extracts only global parameters
 *   =GetParamTable(M1, "probability") - extracts only parameters containing "probability"
 * Returns: Multi-row/column array with param names in first column, values in second column
 * Use as array formula: =GetParamTable(M1) in F1, then it fills F2:Fn with param names, G2:Gn with values
 */
function GetParamTable(input, filter) {
  try {
    var graph;
    
    // Parse input - could be cell reference, direct JSON string, or cell value
    if (typeof input === 'string') {
      // Check if it's a cell reference (like "M1")
      if (input.match(/^[A-Z]+\d+$/)) {
        var sheet = SpreadsheetApp.getActiveSheet();
        var cell = sheet.getRange(input);
        var cellValue = cell.getValue();
        if (cellValue && typeof cellValue === 'string') {
          graph = JSON.parse(cellValue);
        } else {
          return [["Error: Cell " + input + " is empty or doesn't contain JSON"]];
        }
      } else {
        // Direct JSON string
        graph = JSON.parse(input);
      }
    } else {
      return [["Error: Input must be a cell reference or JSON string"]];
    }
    
    if (!graph || !graph.nodes || !graph.edges) {
      return [["Error: Invalid graph format"]];
    }
    
    // Extract parameters from graph
    var params = [];
    
    // Helper function to check if parameter should be included
    function shouldIncludeParam(paramName, paramType) {
      if (!filter) return true; // No filter = include all
      
      if (filter === NODES) return paramType === 'node';
      if (filter === EDGES) return paramType === 'edge';
      if (filter === GLOBAL) return paramType === 'global';
      
      // If filter is a string, check if param name contains it
      if (typeof filter === 'string') {
        return paramName.toLowerCase().includes(filter.toLowerCase());
      }
      
      return true;
    }
    
    // Extract parameters from nodes with smart filtering
    if (graph.nodes && (!filter || filter === NODES || typeof filter === 'string')) {
      for (var i = 0; i < graph.nodes.length; i++) {
        var node = graph.nodes[i];
        var nodeParams = flattenNodeParameters(node);
        
        for (var j = 0; j < nodeParams.length; j++) {
          var param = nodeParams[j];
          if (shouldIncludeParam(param.name, 'node')) {
            params.push([param.name, param.value]);
          }
        }
      }
    }
    
    // Extract parameters from edges with smart filtering
    if (graph.edges && (!filter || filter === EDGES || typeof filter === 'string')) {
      for (var i = 0; i < graph.edges.length; i++) {
        var edge = graph.edges[i];
        var edgeParams = flattenEdgeParameters(edge);
        
        for (var j = 0; j < edgeParams.length; j++) {
          var param = edgeParams[j];
          if (shouldIncludeParam(param.name, 'edge')) {
            params.push([param.name, param.value]);
          }
        }
      }
    }
    
    // Extract global parameters from graph metadata
    if (graph.metadata && graph.metadata.parameters && (!filter || filter === GLOBAL || typeof filter === 'string')) {
      for (var key in graph.metadata.parameters) {
        var paramName = 'global_' + key;
        var paramValue = graph.metadata.parameters[key];
        if (shouldIncludeParam(paramName, 'global')) {
          params.push([paramName, paramValue]);
        }
      }
    }
    
    // If no parameters found, return empty result
    if (params.length === 0) {
      return [["No interesting parameters found in graph"]];
    }
    
    return params;
  } catch (e) {
    return [["Error: " + e.message]];
  }
}

/**
 * GetParam function - extracts a single parameter from a graph or returns graph description
 * Usage: 
 *   =GetParam(M1) - returns graph description/metadata
 *   =GetParam(M1, "start_probability") - returns specific parameter value
 *   =GetParam(M1, "global_discount") - returns global parameter value
 * Returns: Single cell value (string, number, or description)
 */
function GetParam(input, paramName) {
  try {
    var graph;
    
    // Parse input - could be cell reference, direct JSON string, or cell value
    if (typeof input === 'string') {
      // Check if it's a cell reference (like "M1")
      if (input.match(/^[A-Z]+\d+$/)) {
        var sheet = SpreadsheetApp.getActiveSheet();
        var cell = sheet.getRange(input);
        var cellValue = cell.getValue();
        if (cellValue && typeof cellValue === 'string') {
          graph = JSON.parse(cellValue);
        } else {
          return "Error: Cell " + input + " is empty or doesn't contain JSON";
        }
      } else {
        // Direct JSON string
        graph = JSON.parse(input);
      }
    } else {
      return "Error: Input must be a cell reference or JSON string";
    }
    
    if (!graph || !graph.nodes || !graph.edges) {
      return "Error: Invalid graph format";
    }
    
    // If no parameter specified, return graph description
    if (!paramName) {
      var description = "Graph with " + graph.nodes.length + " nodes and " + graph.edges.length + " edges";
      if (graph.metadata && graph.metadata.title) {
        description = graph.metadata.title + " - " + description;
      }
      if (graph.metadata && graph.metadata.description) {
        description += "\n" + graph.metadata.description;
      }
      return description;
    }
    
    // Search for the specific parameter
    return getSpecificParameter(graph, paramName);
  } catch (e) {
    return "Error: " + e.message;
  }
}


// Get a specific parameter value
function getSpecificParameter(graph, paramName) {
  // Search in nodes
  if (graph.nodes) {
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      var nodeIdentifier = node.slug || node.id;
      
      // Search in node.data if it exists
      if (node.data) {
        for (var key in node.data) {
          if (key !== 'label' && key !== 'type' && key !== 'id') {
            var fullParamName = nodeIdentifier + '_' + key;
            if (fullParamName === paramName) {
              return node.data[key];
            }
          }
        }
      }
      
      // Search in direct node properties (flattened)
      var nodeParams = flattenNodeParameters(node);
      for (var j = 0; j < nodeParams.length; j++) {
        if (nodeParams[j].name === paramName) {
          return nodeParams[j].value;
        }
      }
    }
  }
  
  // Search in edges
  if (graph.edges) {
    for (var i = 0; i < graph.edges.length; i++) {
      var edge = graph.edges[i];
      var edgeParams = flattenEdgeParameters(edge);
      for (var j = 0; j < edgeParams.length; j++) {
        if (edgeParams[j].name === paramName) {
          return edgeParams[j].value;
        }
      }
    }
  }
  
  // Search in global parameters
  if (graph.metadata && graph.metadata.parameters) {
    for (var key in graph.metadata.parameters) {
      var fullParamName = 'global_' + key;
      if (fullParamName === paramName) {
        return graph.metadata.parameters[key];
      }
    }
  }
  
  return "Parameter '" + paramName + "' not found";
}


// Flatten node parameters
function flattenNodeParameters(node) {
  var params = [];
  var nodeIdentifier = node.slug || node.id;
  
  // Handle entry parameters
  if (node.entry) {
    for (var key in node.entry) {
      if (key === 'entry_weight' && node.entry[key] !== 1) { // Only include non-default
        params.push({
          name: 'N:' + nodeIdentifier + '_' + key,
          value: node.entry[key]
        });
      }
    }
  }
  
  // Handle costs parameters
  if (node.costs) {
    for (var key in node.costs) {
      if (node.costs[key] > 0) { // Only include non-zero costs
        params.push({
          name: 'N:' + nodeIdentifier + '_costs_' + key,
          value: node.costs[key]
        });
      }
    }
  }
  
  return params;
}

// Flatten edge parameters
function flattenEdgeParameters(edge) {
  var params = [];
  var edgeIdentifier = edge.slug || edge.id;
  
  // Handle probability parameters
  if (edge.p) {
    if (edge.p.mean !== undefined) { // Always include p_mean (including 0.5)
      params.push({
        name: edgeIdentifier + '_p_mean',
        value: edge.p.mean
      });
    }
    if (edge.p.stdev !== undefined && edge.p.stdev > 0) { // Only include if present and > 0
      params.push({
        name: edgeIdentifier + '_p_stdev',
        value: edge.p.stdev
      });
    }
    if (edge.p.locked !== undefined && edge.p.locked !== false) { // Only include if locked
      params.push({
        name: edgeIdentifier + '_p_locked',
        value: edge.p.locked
      });
    }
  }
  
  // Handle costs parameters
  if (edge.costs) {
    for (var key in edge.costs) {
      if (edge.costs[key] > 0) { // Only include non-zero costs
        params.push({
          name: edgeIdentifier + '_costs_' + key,
          value: edge.costs[key]
        });
      }
    }
  }
  
  // Handle weight_default
  if (edge.weight_default !== undefined && edge.weight_default > 0) {
    params.push({
      name: edgeIdentifier + '_weight_default',
      value: edge.weight_default
    });
  }
  
  return params;
}

/**
 * Params function - builds JSON dictionary from cell ranges
 * Usage: 
 *   =Params(A1:B1, A3:B3) - multiple 2-cell ranges (name, value pairs)
 *   =Params(A1:B3) - single range with names in column A, values in column B
 *   =Params(A1:C2) - 2x3 array with names in first row, values in second row
 * Returns: JSON string with parameter dictionary
 */
function Params() {
  try {
    var params = {};
    var args = Array.prototype.slice.call(arguments);
    
    for (var i = 0; i < args.length; i++) {
      var rangeStr = args[i];
      
      // Parse range string (e.g., "A1:B3")
      var range = SpreadsheetApp.getActiveSheet().getRange(rangeStr);
      var values = range.getValues();
      var numRows = values.length;
      var numCols = values[0].length;
      
      if (numRows === 1 && numCols === 2) {
        // Single row with 2 columns: [name, value]
        var paramName = values[0][0];
        var paramValue = values[0][1];
        if (paramName && paramName.toString().trim() !== '') {
          params[paramName.toString().trim()] = paramValue;
        }
      } else if (numRows === 2 && numCols === 1) {
        // Single column with 2 rows: [name, value]
        var paramName = values[0][0];
        var paramValue = values[1][0];
        if (paramName && paramName.toString().trim() !== '') {
          params[paramName.toString().trim()] = paramValue;
        }
      } else if (numRows === 2 && numCols >= 2) {
        // 2 rows: first row has names, second row has values
        for (var col = 0; col < numCols; col++) {
          var paramName = values[0][col];
          var paramValue = values[1][col];
          if (paramName && paramName.toString().trim() !== '') {
            params[paramName.toString().trim()] = paramValue;
          }
        }
      } else if (numCols === 2 && numRows >= 2) {
        // 2 columns: first column has names, second column has values
        for (var row = 0; row < numRows; row++) {
          var paramName = values[row][0];
          var paramValue = values[row][1];
          if (paramName && paramName.toString().trim() !== '') {
            params[paramName.toString().trim()] = paramValue;
          }
        }
      } else {
        return "Error: Range " + rangeStr + " must be 2x1, 1x2, 2xn, or nx2 format";
      }
    }
    
    return JSON.stringify(params);
  } catch (e) {
    return "Error: " + e.message;
  }
}

/**
 * GraphCalc function - calculates analytics on direct JSON
 * Usage: 
 *   =GraphCalc(A1) - probability from first node to any success
 *   =GraphCalc(A1, COST) - cost from first node to any success
 *   =GraphCalc(A1, COST, "start") - cost from "start" to any success
 *   =GraphCalc(A1, COST, "start", ANY_SUCCESS) - cost from "start" to any success
 *   =GraphCalc(A1, COST, "start", ANY_SUCCESS, '{"param1": 100}') - with custom parameters
 * Supports direct JSON strings or cell references containing JSON
 * Parameters: input, operation, startNode, endNode, customParams
 */
function GraphCalc(input, operation, startNode, endNode, customParams) {
  try {
    var graph;
    
    // Parse input - could be cell reference, direct JSON string, or cell value
    if (typeof input === 'string') {
      // Check if it's a cell reference (like "A1")
      if (input.match(/^[A-Z]+\d+$/)) {
        var sheet = SpreadsheetApp.getActiveSheet();
        var cell = sheet.getRange(input);
        var cellValue = cell.getValue();
        if (cellValue && typeof cellValue === 'string') {
          graph = JSON.parse(cellValue);
        } else {
          return "Error: Cell " + input + " is empty or doesn't contain JSON";
        }
      } else {
        // Direct JSON string
        graph = JSON.parse(input);
      }
    } else {
      return "Error: Input must be a cell reference or JSON string";
    }
    
    if (!graph || !graph.nodes || !graph.edges) {
      return "Error: Invalid graph format";
    }
    
    // Set defaults with smart fallbacks
    if (!operation) operation = PROBABILITY;
    if (!startNode || startNode === '') {
      startNode = graph.nodes[0] ? (graph.nodes[0].id || graph.nodes[0].data?.label) : 'start';
    }
    if (!endNode) endNode = ANY_SUCCESS;
    
    // Parse custom parameters if provided
    var customParamsObj = {};
    if (customParams) {
      if (typeof customParams === 'string') {
        // Check if it's a cell reference
        if (customParams.match(/^[A-Z]+\d+$/)) {
          var sheet = SpreadsheetApp.getActiveSheet();
          var cell = sheet.getRange(customParams);
          var cellValue = cell.getValue();
          if (cellValue && typeof cellValue === 'string') {
            try {
              customParamsObj = JSON.parse(cellValue);
            } catch (e) {
              return "Error: Custom parameters in " + customParams + " must be valid JSON";
            }
          }
        } else {
          // Direct JSON string
          try {
            customParamsObj = JSON.parse(customParams);
          } catch (e) {
            return "Error: Custom parameters must be valid JSON";
          }
        }
      } else if (typeof customParams === 'object') {
        customParamsObj = customParams;
      }
    }
    
    // Find start and end nodes
    var startNodeObj = graph.nodes.find(function(node) {
      return node.id === startNode || (node.data && node.data.label === startNode);
    });
    
    if (!startNodeObj) {
      return "Error: Start node '" + startNode + "' not found";
    }
    
    var endNodes = [];
    if (endNode === ANY_SUCCESS) {
      endNodes = graph.nodes.filter(function(node) {
        return node.data && node.data.type === 'success';
      });
    } else if (endNode === ANY_FAILURE) {
      endNodes = graph.nodes.filter(function(node) {
        return node.data && node.data.type === 'failure';
      });
    } else {
      var endNodeObj = graph.nodes.find(function(node) {
        return node.id === endNode || (node.data && node.data.label === endNode);
      });
      if (endNodeObj) {
        endNodes = [endNodeObj];
      }
    }
    
    if (endNodes.length === 0) {
      return "Error: End node(s) not found";
    }
    
    // Calculate based on operation
    if (operation === PROBABILITY) {
      return calculateProbability(graph, startNodeObj, endNodes);
    } else if (operation === COST) {
      return calculateCost(graph, startNodeObj, endNodes);
    } else if (operation === TIME) {
      return calculateTime(graph, startNodeObj, endNodes);
    } else {
      return "Error: Unknown operation '" + operation + "'";
    }
    
  } catch (e) {
    return "Error: " + e.message;
  }
}

/**
 * Calculate probability from start to any end node
 */
function calculateProbability(graph, startNode, endNodes) {
  try {
    var visited = new Set();
    var probabilities = new Map();
    
    function dfs(nodeId) {
      if (visited.has(nodeId)) return probabilities.get(nodeId) || 0;
      if (endNodes.some(function(end) { return end.id === nodeId; })) {
        probabilities.set(nodeId, 1);
        return 1;
      }
      
      visited.add(nodeId);
      var totalProb = 0;
      
      var outgoingEdges = graph.edges.filter(function(edge) {
        return edge.source === nodeId;
      });
      
      for (var i = 0; i < outgoingEdges.length; i++) {
        var edge = outgoingEdges[i];
        var edgeProb = edge.data && edge.data.probability ? edge.data.probability : 0.5;
        var targetProb = dfs(edge.target);
        totalProb += edgeProb * targetProb;
      }
      
      probabilities.set(nodeId, totalProb);
      return totalProb;
    }
    
    return dfs(startNode.id);
  } catch (e) {
    return "Error calculating probability: " + e.message;
  }
}

/**
 * Calculate expected cost from start to any end node
 */
function calculateCost(graph, startNode, endNodes) {
  try {
    var visited = new Set();
    var costs = new Map();
    
    function dfs(nodeId) {
      if (visited.has(nodeId)) return costs.get(nodeId) || 0;
      if (endNodes.some(function(end) { return end.id === nodeId; })) {
        costs.set(nodeId, 0);
        return 0;
      }
      
      visited.add(nodeId);
      var totalCost = 0;
      
      var outgoingEdges = graph.edges.filter(function(edge) {
        return edge.source === nodeId;
      });
      
      for (var i = 0; i < outgoingEdges.length; i++) {
        var edge = outgoingEdges[i];
        var edgeCost = edge.data && edge.data.cost ? edge.data.cost : 0;
        var edgeProb = edge.data && edge.data.probability ? edge.data.probability : 0.5;
        var targetCost = dfs(edge.target);
        totalCost += edgeProb * (edgeCost + targetCost);
      }
      
      costs.set(nodeId, totalCost);
      return totalCost;
    }
    
    return dfs(startNode.id);
  } catch (e) {
    return "Error calculating cost: " + e.message;
  }
}

/**
 * Calculate expected time from start to any end node
 */
function calculateTime(graph, startNode, endNodes) {
  try {
    var visited = new Set();
    var times = new Map();
    
    function dfs(nodeId) {
      if (visited.has(nodeId)) return times.get(nodeId) || 0;
      if (endNodes.some(function(end) { return end.id === nodeId; })) {
        times.set(nodeId, 0);
        return 0;
      }
      
      visited.add(nodeId);
      var totalTime = 0;
      
      var outgoingEdges = graph.edges.filter(function(edge) {
        return edge.source === nodeId;
      });
      
      for (var i = 0; i < outgoingEdges.length; i++) {
        var edge = outgoingEdges[i];
        var edgeTime = edge.data && edge.data.time ? edge.data.time : 0;
        var edgeProb = edge.data && edge.data.probability ? edge.data.probability : 0.5;
        var targetTime = dfs(edge.target);
        totalTime += edgeProb * (edgeTime + targetTime);
      }
      
      times.set(nodeId, totalTime);
      return totalTime;
    }
    
    return dfs(startNode.id);
  } catch (e) {
    return "Error calculating time: " + e.message;
  }
}
