/**
 * Simplified Google Apps Script for Dagnet roundtrip:
 * - Menu: Dagnet → Initialize, Edit graph
 * - editGraph: opens Dagnet with selected cell JSON (empty cell = '', JSON cell = pass JSON)
 * - doPost: receives graph JSON and writes back to the same cell
 * - getCurrentWebAppUrl: returns current deployment URL
 * - GraphCalc: calculates analytics on direct JSON (no graph:// pointers or history)
 */

const DAGNET_APP_URL = 'https://dagnet-nine.vercel.app/';
const SCRIPT_VERSION = '2025-01-15-SIMPLIFIED-V3'; // Change this every time you edit!

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
 * NODES constant - Extract only node parameters
 * @returns {string} "nodes"
 * @customfunction
 */
function NODES() {
  return 'nodes';
}

/**
 * EDGES constant - Extract only edge parameters
 * @returns {string} "edges"
 * @customfunction
 */
function EDGES() {
  return 'edges';
}

/**
 * GLOBAL constant - Extract only global parameters
 * @returns {string} "global"
 * @customfunction
 */
function GLOBAL() {
  return 'global';
}

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
  
  // 1. Create named ranges first (simple)
  var namedRangesResult = createDagNamedRanges();
  
  // 2. Ask for URL (if none stored)
  var currentUrl = getCurrentWebAppUrl();
  var urlToTest = currentUrl;
  
  if (!currentUrl) {
    var newUrl = Browser.inputBox('Please paste your web app URL:');
    if (!newUrl || newUrl === 'cancel') {
      ui.alert('Setup cancelled. URL is required.');
      return;
    }
    setWebAppUrl(newUrl.trim());
    urlToTest = newUrl.trim();
  }
  
  // 3. Test URL
  var testResult = testWebAppUrl(urlToTest);
  
  // 4. Show success
  if (testResult.success) {
    ui.alert('✅ Setup complete!\n\n• Created ' + namedRangesResult + ' named ranges\n• Web app URL is working\n• Type "DG" to see constants in autocomplete\n\nYou can now use "Edit graph" from the menu.');
  } else {
    ui.alert('⚠️ Setup partially complete\n\n• Created ' + namedRangesResult + ' named ranges\n• Type "DG" to see constants in autocomplete\n\n• Web app URL is not working: ' + urlToTest + '\n• Please check deployment settings before using "Edit graph"');
  }
}

/**
 * Create named ranges for DAG constants
 */
function createDagNamedRanges() {
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    console.log('Starting to create named ranges...');
    
    // Create or get hidden sheet for constants
    var constsSheet;
    try {
      constsSheet = spreadsheet.getSheetByName('__DAG_CONSTS');
      if (constsSheet) {
        console.log('Found existing __DAG_CONSTS sheet, clearing it');
        constsSheet.clear();
      } else {
        console.log('Creating new __DAG_CONSTS sheet');
        constsSheet = spreadsheet.insertSheet('__DAG_CONSTS');
        constsSheet.hideSheet();
      }
    } catch (e) {
      console.log('Error with sheet creation: ' + e.message);
      constsSheet = spreadsheet.insertSheet('__DAG_CONSTS');
      constsSheet.hideSheet();
    }
    
    // Define constants and their values
    var constants = [
      { name: 'DG_PROBABILITY', value: 'probability' },
      { name: 'DG_COST', value: 'cost' },
      { name: 'DG_TIME', value: 'time' },
      { name: 'DG_ANY_SUCCESS', value: 'anySuccess' },
      { name: 'DG_ANY_FAILURE', value: 'anyFailure' },
      { name: 'DG_NODES', value: 'nodes' },
      { name: 'DG_EDGES', value: 'edges' },
      { name: 'DG_GLOBAL', value: 'global' }
    ];
    
    var successCount = 0;
    
    // Write values to sheet and create named ranges
    for (var i = 0; i < constants.length; i++) {
      var constant = constants[i];
      try {
        var cell = constsSheet.getRange(i + 1, 1);
        cell.setValue(constant.value);
        console.log('Set value for ' + constant.name + ': ' + constant.value);
        
        // Create named range
        try {
          spreadsheet.setNamedRange(constant.name, cell);
          console.log('Created named range: ' + constant.name);
          successCount++;
        } catch (e) {
          // If named range exists, remove it first
          try {
            spreadsheet.removeNamedRange(constant.name);
            spreadsheet.setNamedRange(constant.name, cell);
            console.log('Recreated named range: ' + constant.name);
            successCount++;
          } catch (e2) {
            console.log('Could not create named range: ' + constant.name + ' - ' + e2.message);
          }
        }
      } catch (e) {
        console.log('Error with constant ' + constant.name + ': ' + e.message);
      }
    }
    
    console.log('Successfully created ' + successCount + ' out of ' + constants.length + ' named ranges');
    return successCount;
  } catch (e) {
    console.log('Error creating named ranges: ' + e.message);
    return 0;
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
      <p style="font-size:12px;color:#666;margin-top:10px;">This dialog will close automatically when you save in Dagnet.</p>
      <button onclick="google.script.host.close()" style="margin-top:10px;padding:8px 16px;background:#1a73e8;color:white;border:none;border-radius:4px;cursor:pointer">Close Dialog</button>
      <script>
        (function(){
          var w = window.open(${JSON.stringify(appUrl)}, '_blank');
          if (w) {
            // Close dialog after 3 seconds to allow Dagnet to load
            setTimeout(function(){ 
              google.script.host.close(); 
            }, 5000);
          }
        })();
      </script>
    </body></html>
  `).setWidth(380).setHeight(200);

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
/**
 * dagParamsFromTable function - builds JSON dictionary from a parameter table
 * @param {string} tableRange - Range containing parameter table (e.g., "A1:C3")
 * @param {string} scenarioName - Name of scenario column to extract
 * @returns {string} JSON string with parameter dictionary
 * @customfunction
 */
function dagParamsFromTable(tableRange, scenarioName) {
  try {
    // tableRange is already a 2D array of values from the range
    var values = tableRange;
      
    // Find scenario column
    var scenarioColumn = -1;
    for (var col = 0; col < values[0].length; col++) {
      if (values[0][col] == scenarioName) {
        scenarioColumn = col;
        break;
      }
    }
    
    if (scenarioColumn === -1) {
      return "Error: Scenario not found";
    }
    
    // Build parameter dictionary
    var params = {};
    for (var row = 1; row < values.length; row++) {
      var paramName = values[row][0];
      var paramValue = values[row][scenarioColumn];
      
      if (paramName && paramName.toString().trim() !== '') {
        params[paramName.toString().trim()] = paramValue;
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
 *   =GetParamTable(M1) - extracts all interesting parameters from graph in M1 (smart filtering)
 *   =GetParamTable(M1, NODES) - extracts only node parameters
 *   =GetParamTable(M1, EDGES) - extracts only edge parameters  
 *   =GetParamTable(M1, GLOBAL) - extracts only global parameters
 *   =GetParamTable(M1, "probability") - extracts only parameters containing "probability"
 *   =GetParamTable(M1, null, true) - extracts ALL parameters (overrides smart filtering)
 *   =GetParamTable(M1, NODES, true) - extracts ALL node parameters (including defaults)
 * Returns: Multi-row/column array with param names in first column, values in second column
 * Use as array formula: =GetParamTable(M1) in F1, then it fills F2:Fn with param names, G2:Gn with values
 */
/**
 * dagGetParamTable function - extracts parameters from a graph into a table
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [filter] - Filter type: "nodes", "edges", "global", or search string
 * @param {boolean} [includeAll] - If true, includes all parameters (overrides smart filtering)
 * @returns {Array<Array>} Multi-row array with parameter names and values
 * @customfunction
 */
function dagGetParamTable(input, filter, includeAll) {
  try {
    var graph;
    
    // Parse input - the input is the actual cell value, not a cell reference
    if (input && typeof input === 'string') {
      try {
        // Try parsing as JSON first
        graph = JSON.parse(input);
      } catch (parseError) {
        // If that fails, it might be double-encoded, try parsing again
        try {
          var decoded = JSON.parse(input);
          graph = JSON.parse(decoded);
        } catch (secondParseError) {
          return [["JSON Parse Error: " + parseError.message + "\nInput: " + input.substring(0, 100) + "..."]];
        }
      }
    } else if (input && typeof input === 'object') {
      // Already parsed JSON object
      graph = input;
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
      
      // Normalize filter value
      var filterValue = filter;
      if (typeof filter === 'function') {
        filterValue = filter();
      }
      
      // Check for filter constants (both string and constant values)
      if (filterValue === 'nodes' || filterValue === 'NODES') return paramType === 'node';
      if (filterValue === 'edges' || filterValue === 'EDGES') return paramType === 'edge';
      if (filterValue === 'global' || filterValue === 'GLOBAL') return paramType === 'global';
      
      // If filter is a string, check if param name contains it
      if (typeof filterValue === 'string') {
        return paramName.toLowerCase().includes(filterValue.toLowerCase());
      }
      
      return true;
    }
    
    // Extract parameters in logical order: Global first, then systematic graph traversal
    var allParams = includeAll ? extractAllParametersInLogicalOrder(graph) : extractParametersInLogicalOrder(graph);
    
    // Debug: Log the number of parameters found
    var filterValue = filter;
    if (typeof filter === 'function') {
      filterValue = filter();
    }
    console.log('GetParamTable: Found ' + allParams.length + ' parameters, filter=' + filterValue + ', includeAll=' + includeAll);
    
    for (var i = 0; i < allParams.length; i++) {
      var param = allParams[i];
      if (shouldIncludeParam(param.name, param.type)) {
        params.push([param.name, param.value]);
      }
    }
    
    // If no parameters found, return debug info
    if (params.length === 0) {
      return [["No parameters found. Debug: " + allParams.length + " total params, filter=" + filterValue + ", includeAll=" + includeAll]];
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
/**
 * dagGetParam function - extracts a single parameter from a graph
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [paramName] - Name of parameter to extract (e.g., "n.start.costs.monetary" or "e.edge-slug.p.mean")
 * @returns {string|number} Parameter value or graph description if no paramName
 * @customfunction
 */
function dagGetParam(input, paramName) {
  try {
    var graph;
    
    // Parse input - the input is the actual cell value, not a cell reference
    if (input && typeof input === 'string') {
      try {
        // Try parsing as JSON first
        graph = JSON.parse(input);
      } catch (parseError) {
        // If that fails, it might be double-encoded, try parsing again
        try {
          var decoded = JSON.parse(input);
          graph = JSON.parse(decoded);
        } catch (secondParseError) {
          return "JSON Parse Error: " + parseError.message + "\nInput: " + input.substring(0, 100) + "...";
        }
      }
    } else if (input && typeof input === 'object') {
      // Already parsed JSON object
      graph = input;
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
  // Search in global parameters first
  if (graph.metadata && graph.metadata.parameters) {
    for (var key in graph.metadata.parameters) {
      var fullParamName = 'G:' + key;
      if (fullParamName === paramName) {
        return graph.metadata.parameters[key];
      }
    }
  }
  
  // Search in nodes
  if (graph.nodes) {
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
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
          name: 'n.' + nodeIdentifier + '.' + key,
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
          name: 'n.' + nodeIdentifier + '.costs.' + key,
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
        name: 'e.' + edgeIdentifier + '.p.mean',
        value: edge.p.mean
      });
    }
    if (edge.p.stdev !== undefined && edge.p.stdev > 0) { // Only include if present and > 0
      params.push({
        name: 'e.' + edgeIdentifier + '.p.stdev',
        value: edge.p.stdev
      });
    }
    if (edge.p.locked !== undefined && edge.p.locked !== false) { // Only include if locked
      params.push({
        name: 'e.' + edgeIdentifier + '.p.locked',
        value: edge.p.locked
      });
    }
  }
  
  // Handle costs parameters (new structure)
  if (edge.costs) {
    // Handle monetary costs
    if (edge.costs.monetary) {
      if (typeof edge.costs.monetary === 'object' && edge.costs.monetary.value > 0) {
        params.push({
          name: 'e.' + edgeIdentifier + '.costs.monetary.value',
          value: edge.costs.monetary.value
        });
        if (edge.costs.monetary.stdev && edge.costs.monetary.stdev > 0) {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.monetary.stdev',
            value: edge.costs.monetary.stdev
          });
        }
        if (edge.costs.monetary.currency && edge.costs.monetary.currency !== 'GBP') {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.monetary.currency',
            value: edge.costs.monetary.currency
          });
        }
        if (edge.costs.monetary.distribution && edge.costs.monetary.distribution !== 'normal') {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.monetary.distribution',
            value: edge.costs.monetary.distribution
          });
        }
      } else if (typeof edge.costs.monetary === 'number' && edge.costs.monetary > 0) {
        // Backward compatibility with old structure
        params.push({
          name: 'e.' + edgeIdentifier + '.costs.monetary',
          value: edge.costs.monetary
        });
      }
    }
    
    // Handle time costs
    if (edge.costs.time) {
      if (typeof edge.costs.time === 'object' && edge.costs.time.value > 0) {
        params.push({
          name: 'e.' + edgeIdentifier + '.costs.time.value',
          value: edge.costs.time.value
        });
        if (edge.costs.time.stdev && edge.costs.time.stdev > 0) {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.time.stdev',
            value: edge.costs.time.stdev
          });
        }
        if (edge.costs.time.units && edge.costs.time.units !== 'days') {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.time.units',
            value: edge.costs.time.units
          });
        }
        if (edge.costs.time.distribution && edge.costs.time.distribution !== 'lognormal') {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.time.distribution',
            value: edge.costs.time.distribution
          });
        }
      } else if (typeof edge.costs.time === 'number' && edge.costs.time > 0) {
        // Backward compatibility with old structure
        params.push({
          name: 'e.' + edgeIdentifier + '.costs.time',
          value: edge.costs.time
        });
      }
    }
  }
  
  // Handle weight_default
  if (edge.weight_default !== undefined && edge.weight_default > 0) {
    params.push({
      name: 'e.' + edgeIdentifier + '.weight_default',
      value: edge.weight_default
    });
  }
  
  return params;
}

// Extract parameters in logical order: Global first, then systematic graph traversal
function extractParametersInLogicalOrder(graph) {
  var params = [];
  
  // 1. Global parameters first
  if (graph.metadata && graph.metadata.parameters) {
    for (var key in graph.metadata.parameters) {
      params.push({
        name: 'G:' + key,
        value: graph.metadata.parameters[key],
        type: 'global'
      });
    }
  }
  
  // 2. Find entry nodes (nodes with entry.is_start = true)
  var entryNodes = [];
  if (graph.nodes) {
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (node.entry && node.entry.is_start) {
        entryNodes.push(node);
      }
    }
  }
  
  // 3. If no entry nodes found, use first node
  if (entryNodes.length === 0 && graph.nodes && graph.nodes.length > 0) {
    entryNodes.push(graph.nodes[0]);
  }
  
  // 4. Traverse graph systematically from entry nodes
  var visitedNodes = new Set();
  var visitedEdges = new Set();
  
  function traverseFromNode(node) {
    if (visitedNodes.has(node.id)) return;
    visitedNodes.add(node.id);
    
    // Extract node parameters
    var nodeParams = flattenNodeParameters(node);
    for (var i = 0; i < nodeParams.length; i++) {
      params.push({
        name: nodeParams[i].name,
        value: nodeParams[i].value,
        type: 'node'
      });
    }
    
    // Find outgoing edges from this node
    if (graph.edges) {
      for (var i = 0; i < graph.edges.length; i++) {
        var edge = graph.edges[i];
        if (edge.from === node.id || edge.from === node.slug) {
          if (!visitedEdges.has(edge.id)) {
            visitedEdges.add(edge.id);
            
            // Extract edge parameters
            var edgeParams = flattenEdgeParameters(edge);
            for (var j = 0; j < edgeParams.length; j++) {
              params.push({
                name: edgeParams[j].name,
                value: edgeParams[j].value,
                type: 'edge'
              });
            }
            
            // Find target node and continue traversal
            var targetNode = null;
            for (var k = 0; k < graph.nodes.length; k++) {
              if (graph.nodes[k].id === edge.to || graph.nodes[k].slug === edge.to) {
                targetNode = graph.nodes[k];
                break;
              }
            }
            
            if (targetNode) {
              traverseFromNode(targetNode);
            }
          }
        }
      }
    }
  }
  
  // 5. Start traversal from entry nodes
  for (var i = 0; i < entryNodes.length; i++) {
    traverseFromNode(entryNodes[i]);
  }
  
  // 6. Handle any remaining nodes not reached by traversal
  if (graph.nodes) {
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (!visitedNodes.has(node.id)) {
        var nodeParams = flattenNodeParameters(node);
        for (var j = 0; j < nodeParams.length; j++) {
          params.push({
            name: nodeParams[j].name,
            value: nodeParams[j].value,
            type: 'node'
          });
        }
      }
    }
  }
  
  // 7. Handle any remaining edges not reached by traversal
  if (graph.edges) {
    for (var i = 0; i < graph.edges.length; i++) {
      var edge = graph.edges[i];
      if (!visitedEdges.has(edge.id)) {
        var edgeParams = flattenEdgeParameters(edge);
        for (var j = 0; j < edgeParams.length; j++) {
          params.push({
            name: edgeParams[j].name,
            value: edgeParams[j].value,
            type: 'edge'
          });
        }
      }
    }
  }
  
  return params;
}

// Extract ALL parameters in logical order (overriding smart filtering)
function extractAllParametersInLogicalOrder(graph) {
  var params = [];
  
  // 1. Global parameters first
  if (graph.metadata && graph.metadata.parameters) {
    for (var key in graph.metadata.parameters) {
      params.push({
        name: 'G:' + key,
        value: graph.metadata.parameters[key],
        type: 'global'
      });
    }
  }
  
  // 2. Find entry nodes (nodes with entry.is_start = true)
  var entryNodes = [];
  if (graph.nodes) {
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (node.entry && node.entry.is_start) {
        entryNodes.push(node);
      }
    }
  }
  
  // 3. If no entry nodes found, use first node
  if (entryNodes.length === 0 && graph.nodes && graph.nodes.length > 0) {
    entryNodes.push(graph.nodes[0]);
  }
  
  // 4. Traverse graph systematically from entry nodes
  var visitedNodes = new Set();
  var visitedEdges = new Set();
  
  function traverseFromNode(node) {
    if (visitedNodes.has(node.id)) return;
    visitedNodes.add(node.id);
    
    // Extract ALL node parameters (no smart filtering)
    var nodeParams = flattenAllNodeParameters(node);
    for (var i = 0; i < nodeParams.length; i++) {
      params.push({
        name: nodeParams[i].name,
        value: nodeParams[i].value,
        type: 'node'
      });
    }
    
    // Find outgoing edges from this node
    if (graph.edges) {
      for (var i = 0; i < graph.edges.length; i++) {
        var edge = graph.edges[i];
        if (edge.from === node.id || edge.from === node.slug) {
          if (!visitedEdges.has(edge.id)) {
            visitedEdges.add(edge.id);
            
            // Extract ALL edge parameters (no smart filtering)
            var edgeParams = flattenAllEdgeParameters(edge);
            for (var j = 0; j < edgeParams.length; j++) {
              params.push({
                name: edgeParams[j].name,
                value: edgeParams[j].value,
                type: 'edge'
              });
            }
            
            // Find target node and continue traversal
            var targetNode = null;
            for (var k = 0; k < graph.nodes.length; k++) {
              if (graph.nodes[k].id === edge.to || graph.nodes[k].slug === edge.to) {
                targetNode = graph.nodes[k];
                break;
              }
            }
            
            if (targetNode) {
              traverseFromNode(targetNode);
            }
          }
        }
      }
    }
  }
  
  // 5. Start traversal from entry nodes
  for (var i = 0; i < entryNodes.length; i++) {
    traverseFromNode(entryNodes[i]);
  }
  
  // 6. Handle any remaining nodes not reached by traversal
  if (graph.nodes) {
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (!visitedNodes.has(node.id)) {
        var nodeParams = flattenAllNodeParameters(node);
        for (var j = 0; j < nodeParams.length; j++) {
          params.push({
            name: nodeParams[j].name,
            value: nodeParams[j].value,
            type: 'node'
          });
        }
      }
    }
  }
  
  // 7. Handle any remaining edges not reached by traversal
  if (graph.edges) {
    for (var i = 0; i < graph.edges.length; i++) {
      var edge = graph.edges[i];
      if (!visitedEdges.has(edge.id)) {
        var edgeParams = flattenAllEdgeParameters(edge);
        for (var j = 0; j < edgeParams.length; j++) {
          params.push({
            name: edgeParams[j].name,
            value: edgeParams[j].value,
            type: 'edge'
          });
        }
      }
    }
  }
  
  return params;
}

// Flatten ALL node parameters (no smart filtering)
function flattenAllNodeParameters(node) {
  var params = [];
  var nodeIdentifier = node.slug || node.id;
  
  // Handle entry parameters (include all, even defaults)
  if (node.entry) {
    for (var key in node.entry) {
      params.push({
        name: 'n.' + nodeIdentifier + '.' + key,
        value: node.entry[key]
      });
    }
  }
  
  // Handle costs parameters (include all, even zeros)
  if (node.costs) {
    for (var key in node.costs) {
      params.push({
        name: 'n.' + nodeIdentifier + '.costs.' + key,
        value: node.costs[key]
      });
    }
  }
  
  return params;
}

// Flatten ALL edge parameters (no smart filtering)
function flattenAllEdgeParameters(edge) {
  var params = [];
  var edgeIdentifier = edge.slug || edge.id;
  
  // Handle probability parameters (include all, even defaults)
  if (edge.p) {
    if (edge.p.mean !== undefined) {
      params.push({
        name: 'e.' + edgeIdentifier + '.p.mean',
        value: edge.p.mean
      });
    }
    if (edge.p.stdev !== undefined) {
      params.push({
        name: 'e.' + edgeIdentifier + '.p.stdev',
        value: edge.p.stdev
      });
    }
    if (edge.p.locked !== undefined) {
      params.push({
        name: 'e.' + edgeIdentifier + '.p.locked',
        value: edge.p.locked
      });
    }
  }
  
  // Handle costs parameters (include all, even zeros) - new structure
  if (edge.costs) {
    // Handle monetary costs
    if (edge.costs.monetary) {
      if (typeof edge.costs.monetary === 'object') {
        params.push({
          name: 'e.' + edgeIdentifier + '.costs.monetary.value',
          value: edge.costs.monetary.value || 0
        });
        if (edge.costs.monetary.stdev !== undefined) {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.monetary.stdev',
            value: edge.costs.monetary.stdev
          });
        }
        if (edge.costs.monetary.currency !== undefined) {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.monetary.currency',
            value: edge.costs.monetary.currency
          });
        }
        if (edge.costs.monetary.distribution !== undefined) {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.monetary.distribution',
            value: edge.costs.monetary.distribution
          });
        }
      } else {
        // Backward compatibility with old structure
        params.push({
          name: 'e.' + edgeIdentifier + '.costs.monetary',
          value: edge.costs.monetary
        });
      }
    }
    
    // Handle time costs
    if (edge.costs.time) {
      if (typeof edge.costs.time === 'object') {
        params.push({
          name: 'e.' + edgeIdentifier + '.costs.time.value',
          value: edge.costs.time.value || 0
        });
        if (edge.costs.time.stdev !== undefined) {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.time.stdev',
            value: edge.costs.time.stdev
          });
        }
        if (edge.costs.time.units !== undefined) {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.time.units',
            value: edge.costs.time.units
          });
        }
        if (edge.costs.time.distribution !== undefined) {
          params.push({
            name: 'e.' + edgeIdentifier + '.costs.time.distribution',
            value: edge.costs.time.distribution
          });
        }
      } else {
        // Backward compatibility with old structure
        params.push({
          name: 'e.' + edgeIdentifier + '.costs.time',
          value: edge.costs.time
        });
      }
    }
  }
  
  // Handle weight_default (include all, even zeros)
  if (edge.weight_default !== undefined) {
    params.push({
      name: 'e.' + edgeIdentifier + '.weight_default',
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
/**
 * dagTestParamTable function - test function to debug dagGetParamTable
 * @param {string} input - Cell reference containing graph
 * @returns {string} Debug information about the graph
 * @customfunction
 */
function dagTestParamTable(input) {
  try {
    var graph;
    
    // Debug: Log what we're getting
    console.log('TestGetParamTable: input type = ' + typeof input);
    console.log('TestGetParamTable: input = ' + input);
    
    // The input is the actual cell value, not a cell reference string
    if (input && typeof input === 'string') {
      try {
        // Try parsing as JSON first
        graph = JSON.parse(input);
      } catch (parseError) {
        // If that fails, it might be double-encoded, try parsing again
        try {
          var decoded = JSON.parse(input);
          graph = JSON.parse(decoded);
        } catch (secondParseError) {
          return "JSON Parse Error: " + parseError.message + "\nInput: " + input.substring(0, 100) + "...";
        }
      }
    } else if (input && typeof input === 'object') {
      // Already parsed JSON object
      graph = input;
    } else {
      return "Error: Input is empty or invalid. Type: " + typeof input + ", Value: " + input;
    }
    
    if (!graph) {
      return "Error: Could not parse graph from " + input;
    }
    
    var result = "Graph has " + (graph.nodes ? graph.nodes.length : 0) + " nodes, " + 
                 (graph.edges ? graph.edges.length : 0) + " edges";
    
    if (graph.nodes && graph.nodes.length > 0) {
      result += "\nFirst node: " + (graph.nodes[0].slug || graph.nodes[0].id);
    }
    
    if (graph.edges && graph.edges.length > 0) {
      result += "\nFirst edge: " + (graph.edges[0].slug || graph.edges[0].id);
    }
    
    return result;
  } catch (e) {
    return "Error: " + e.message;
  }
}

/**
 * dagGetNodes function - retrieves nodes with their details
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [match] - Optional pattern to match node slugs/IDs (e.g., "start", "node_*")
 * @returns {Array<Array>} Multi-row array with node information
 * @customfunction
 */
function dagGetNodes(input, match) {
  try {
    var graph;
    
    // Parse input - the input is the actual cell value, not a cell reference
    if (input && typeof input === 'string') {
      try {
        // Try parsing as JSON first
        graph = JSON.parse(input);
      } catch (parseError) {
        // If that fails, it might be double-encoded, try parsing again
        try {
          var decoded = JSON.parse(input);
          graph = JSON.parse(decoded);
        } catch (secondParseError) {
          return [["JSON Parse Error: " + parseError.message + "\nInput: " + input.substring(0, 100) + "..."]];
        }
      }
    } else if (input && typeof input === 'object') {
      // Already parsed JSON object
      graph = input;
    } else {
      return [["Error: Invalid input"]];
    }
    
    if (!graph || !graph.nodes) {
      return [["Error: Invalid graph format"]];
    }
    
    var results = [];
    results.push(["Node", "Label", "Type", "Outgoing Edges", "Incoming Edges"]);
    
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      var nodeIdentifier = node.slug || node.id;
      var label = node.label || '';
      var type = node.absorbing ? (node.outcome_type || 'terminal') : 'intermediate';
      
      // Check if node matches the pattern
      if (match && !matchesPattern(nodeIdentifier, match)) {
        continue;
      }
      
      // Count outgoing edges
      var outgoingCount = 0;
      var incomingCount = 0;
      if (graph.edges) {
        for (var j = 0; j < graph.edges.length; j++) {
          var edge = graph.edges[j];
          if (edge.from === node.id || edge.from === node.slug) {
            outgoingCount++;
          }
          if (edge.to === node.id || edge.to === node.slug) {
            incomingCount++;
          }
        }
      }
      
      results.push([nodeIdentifier, label, type, outgoingCount, incomingCount]);
    }
    
    return results;
  } catch (e) {
    return [["Error: " + e.message]];
  }
}

/**
 * dagGetEdges function - retrieves edges with their details
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [match] - Optional pattern to match edge slugs/IDs (e.g., "start-to-*", "edge_*")
 * @returns {Array<Array>} Multi-row array with edge information
 * @customfunction
 */
function dagGetEdges(input, match) {
  try {
    var graph;
    
    // Parse input - the input is the actual cell value, not a cell reference
    if (input && typeof input === 'string') {
      try {
        // Try parsing as JSON first
        graph = JSON.parse(input);
      } catch (parseError) {
        // If that fails, it might be double-encoded, try parsing again
        try {
          var decoded = JSON.parse(input);
          graph = JSON.parse(decoded);
        } catch (secondParseError) {
          return [["JSON Parse Error: " + parseError.message + "\nInput: " + input.substring(0, 100) + "..."]];
        }
      }
    } else if (input && typeof input === 'object') {
      // Already parsed JSON object
      graph = input;
    } else {
      return [["Error: Invalid input"]];
    }
    
    if (!graph || !graph.edges) {
      return [["Error: Invalid graph format"]];
    }
    
    var results = [];
    results.push(["Edge", "From", "To", "Probability", "Costs", "Description"]);
    
    for (var i = 0; i < graph.edges.length; i++) {
      var edge = graph.edges[i];
      var edgeIdentifier = edge.slug || edge.id;
      
      // Convert from/to to human-readable names
      var fromNode = findNodeByIdOrSlug(graph, edge.from);
      var toNode = findNodeByIdOrSlug(graph, edge.to);
      var fromName = fromNode ? (fromNode.slug || fromNode.id) : edge.from;
      var toName = toNode ? (toNode.slug || toNode.id) : edge.to;
      
      var probability = edge.p ? edge.p.mean : 'N/A';
      var costs = edge.costs ? JSON.stringify(edge.costs) : 'None';
      var description = edge.description || '';
      
      // Check if edge matches the pattern
      if (match && !matchesPattern(edgeIdentifier, match)) {
        continue;
      }
      
      results.push([edgeIdentifier, fromName, toName, probability, costs, description]);
    }
    
    return results;
  } catch (e) {
    return [["Error: " + e.message]];
  }
}

// Helper function to check if a string matches a pattern
function matchesPattern(str, pattern) {
  if (!pattern) return true;
  var regex = pattern.replace(/\*/g, '.*');
  return new RegExp('^' + regex + '$').test(str);
}

// Helper function to find a node by ID or slug
function findNodeByIdOrSlug(graph, identifier) {
  if (!graph.nodes) return null;
  
  for (var i = 0; i < graph.nodes.length; i++) {
    var node = graph.nodes[i];
    if (node.id === identifier || node.slug === identifier) {
      return node;
    }
  }
  return null;
}

/**
 * dagParams function - builds JSON dictionary from any combination of ranges and individual values
 * @param {...string} args - Any combination of:
 *   - Individual cell references or values (E17, 0.5, A1, 0.3, ...)
 *   - Range references (A1:B2, C1:D3, ...)
 * All values are flattened and processed as alternating param/value pairs
 * @returns {string} JSON string with parameter dictionary
 * @customfunction
 */
function dagParams() {
  try {
    var params = {};
    var args = Array.prototype.slice.call(arguments);
    var allValues = [];
    
    // Flatten all inputs into a single array
    for (var i = 0; i < args.length; i++) {
      var arg = args[i];
      
      // Check if it's a 2D array (range values)
      if (Array.isArray(arg) && arg.length > 0 && Array.isArray(arg[0])) {
        // It's a 2D array from a range - flatten it
        for (var row = 0; row < arg.length; row++) {
          for (var col = 0; col < arg[row].length; col++) {
            allValues.push(arg[row][col]);
          }
        }
      }
      // Check if it's a range reference (contains colon)
      else if (typeof arg === 'string' && arg.includes(':')) {
        // It's a range reference - get all values from the range
        var range = SpreadsheetApp.getActiveSheet().getRange(arg);
        var values = range.getValues();
        
        // Flatten the 2D array into 1D
        for (var row = 0; row < values.length; row++) {
          for (var col = 0; col < values[row].length; col++) {
            allValues.push(values[row][col]);
          }
        }
      } else {
        // It's an individual cell reference or value
        allValues.push(arg);
      }
    }
    
    // Now process all values as alternating param/value pairs
    if (allValues.length % 2 !== 0) {
      return "Error: Must have an even number of values (param, value, param, value, ...)";
    }
    
    for (var j = 0; j < allValues.length; j += 2) {
      var paramName = allValues[j];
      var paramValue = allValues[j + 1];
      if (paramName && paramName.toString().trim() !== '') {
        // Support dot notation for nested parameters (e.g., "edge-slug.p.mean", "node-slug.costs.monetary")
        var trimmedName = paramName.toString().trim();
        params[trimmedName] = paramValue;
      }
    }
    
    return JSON.stringify(params);
  } catch (e) {
    return "Error: " + e.message;
  }
}

/**
 * Apply custom parameters to graph using dot notation
 * @param {Object} graph - The graph object
 * @param {Object} customParams - Parameters with dot notation keys
 * @returns {Object} Modified graph
 */
function applyCustomParameters(graph, customParams) {
  try {
    var modifiedGraph = JSON.parse(JSON.stringify(graph)); // Deep clone
    
    for (var paramKey in customParams) {
      var paramValue = customParams[paramKey];
      var parts = paramKey.split('.');
      
      if (parts.length >= 2) {
        var elementIdentifier = parts[0];
        var propertyPath = parts.slice(1);
        
        // Handle optional prefixes (n., e., g.)
        if (elementIdentifier === 'n' || elementIdentifier === 'e' || elementIdentifier === 'g') {
          if (parts.length >= 3) {
            elementIdentifier = parts[1];
            propertyPath = parts.slice(2);
          } else {
            continue; // Skip invalid format
          }
        }
        
        // Try to find the element (node or edge) by slug or ID
        var element = null;
        var elementType = null;
        
        // Check nodes first
        for (var i = 0; i < modifiedGraph.nodes.length; i++) {
          var node = modifiedGraph.nodes[i];
          if (node.slug === elementIdentifier || node.id === elementIdentifier || 
              (node.label && node.label === elementIdentifier)) {
            element = node;
            elementType = 'node';
            break;
          }
        }
        
        // Check edges if not found in nodes
        if (!element) {
          for (var j = 0; j < modifiedGraph.edges.length; j++) {
            var edge = modifiedGraph.edges[j];
            if (edge.slug === elementIdentifier || edge.id === elementIdentifier) {
              element = edge;
              elementType = 'edge';
              break;
            }
          }
        }
        
        if (element) {
          // Apply the parameter using dot notation
          setNestedProperty(element, propertyPath, paramValue);
        }
      }
    }
    
    return modifiedGraph;
  } catch (e) {
    console.log('Error applying custom parameters: ' + e.message);
    return graph; // Return original graph if there's an error
  }
}

/**
 * Set a nested property using an array of keys
 * @param {Object} obj - The object to modify
 * @param {Array} keys - Array of property keys
 * @param {*} value - The value to set
 */
function setNestedProperty(obj, keys, value) {
  var current = obj;
  for (var i = 0; i < keys.length - 1; i++) {
    var key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * dagCalc function - calculates graph analytics (probability, cost, time)
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [operation] - Operation: DG_PROBABILITY, DG_COST, DG_TIME (default: DG_PROBABILITY)
 * @param {string} [startNode] - Start node slug/ID (default: first node)
 * @param {string} [endNode] - End node: DG_ANY_SUCCESS, DG_ANY_FAILURE, or node slug (default: DG_ANY_SUCCESS)
 * @param {string} [customParams] - JSON string with custom parameters (optional)
 * @returns {number} Calculated result
 * @customfunction
 * 
 * Tip: Type "DG" to see available constants in autocomplete
 */
function dagCalc(input, operation, startNode, endNode, customParams) {
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
      startNode = graph.nodes[0] ? (graph.nodes[0].id || graph.nodes[0].slug || graph.nodes[0].label) : 'start';
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
    
    // Apply custom parameters to graph
    if (customParamsObj) {
      graph = applyCustomParameters(graph, customParamsObj);
    }
    
    // Find start and end nodes
    var startNodeObj = graph.nodes.find(function(node) {
      return node.id === startNode || node.slug === startNode || (node.label && node.label === startNode);
    });
    
    if (!startNodeObj) {
      return "Error: Start node '" + startNode + "' not found";
    }
    
    var endNodes = [];
    if (endNode === ANY_SUCCESS || endNode === 'anySuccess') {
      endNodes = graph.nodes.filter(function(node) {
        return node.absorbing && node.outcome_type === 'success';
      });
    } else if (endNode === ANY_FAILURE || endNode === 'anyFailure') {
      endNodes = graph.nodes.filter(function(node) {
        return node.absorbing && node.outcome_type === 'failure';
      });
    } else {
      var endNodeObj = graph.nodes.find(function(node) {
        return node.id === endNode || node.slug === endNode || (node.label && node.label === endNode);
      });
      if (endNodeObj) {
        endNodes = [endNodeObj];
      }
    }
    
    if (endNodes.length === 0) {
      // Debug: Show what nodes we have
      var nodeInfo = graph.nodes.map(function(node) {
        return node.slug + " (absorbing:" + node.absorbing + ", outcome_type:" + node.outcome_type + ")";
      }).join(", ");
      return "Error: End node(s) not found. Available nodes: " + nodeInfo + ". Looking for: " + endNode;
    }
    
    // Calculate based on operation
    if (operation === PROBABILITY || operation === 'probability') {
      return calculateProbability(graph, startNodeObj, endNodes);
    } else if (operation === COST || operation === 'cost') {
      var totalExpectedCost = calculateCost(graph, startNodeObj, endNodes);
      var successProbability = calculateProbability(graph, startNodeObj, endNodes);
      
      if (successProbability === 0) {
        return "Error: No path to success - cost per success is undefined";
      }
      
      // Return cost per successful conversion
      return totalExpectedCost / successProbability;
    } else if (operation === TIME || operation === 'time') {
      var totalExpectedTime = calculateTime(graph, startNodeObj, endNodes);
      var successProbability = calculateProbability(graph, startNodeObj, endNodes);
      
      if (successProbability === 0) {
        return "Error: No path to success - time per success is undefined";
      }
      
      // Return time per successful conversion
      return totalExpectedTime / successProbability;
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
        return edge.from === nodeId;
      });
      
      for (var i = 0; i < outgoingEdges.length; i++) {
        var edge = outgoingEdges[i];
        var edgeProb = edge.p && edge.p.mean ? edge.p.mean : 0.5;
        var targetProb = dfs(edge.to);
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
    var visited = [];
    var costs = {};
    
    function dfs(nodeId) {
      // Check if already visited
      for (var i = 0; i < visited.length; i++) {
        if (visited[i] === nodeId) {
          return costs[nodeId] || 0;
        }
      }
      
      // Check if it's an end node
      for (var j = 0; j < endNodes.length; j++) {
        if (endNodes[j].id === nodeId) {
          costs[nodeId] = 0;
          return 0;
        }
      }
      
      visited.push(nodeId);
      var totalCost = 0;
      
      var outgoingEdges = [];
      for (var k = 0; k < graph.edges.length; k++) {
        if (graph.edges[k].from === nodeId) {
          outgoingEdges.push(graph.edges[k]);
        }
      }
      
      for (var i = 0; i < outgoingEdges.length; i++) {
        var edge = outgoingEdges[i];
        
        // Handle new cost structure: edge.costs.monetary.value
        var edgeCost = 0;
        if (edge.costs && edge.costs.monetary && typeof edge.costs.monetary === 'object') {
          edgeCost = edge.costs.monetary.value || 0;
        } else if (edge.costs && typeof edge.costs.monetary === 'number') {
          // Backward compatibility with old structure
          edgeCost = edge.costs.monetary;
        }
        
        var edgeProb = edge.p && edge.p.mean ? edge.p.mean : 0.5;
        var targetCost = dfs(edge.to);
        totalCost += edgeProb * (edgeCost + targetCost);
      }
      
      costs[nodeId] = totalCost;
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
    var visited = [];
    var times = {};
    
    function dfs(nodeId) {
      // Check if already visited
      for (var i = 0; i < visited.length; i++) {
        if (visited[i] === nodeId) {
          return times[nodeId] || 0;
        }
      }
      
      // Check if it's an end node
      for (var j = 0; j < endNodes.length; j++) {
        if (endNodes[j].id === nodeId) {
          times[nodeId] = 0;
          return 0;
        }
      }
      
      visited.push(nodeId);
      var totalTime = 0;
      
      var outgoingEdges = [];
      for (var k = 0; k < graph.edges.length; k++) {
        if (graph.edges[k].from === nodeId) {
          outgoingEdges.push(graph.edges[k]);
        }
      }
      
      for (var i = 0; i < outgoingEdges.length; i++) {
        var edge = outgoingEdges[i];
        // Handle new cost structure: edge.costs.time.value (in days)
        var edgeTime = 0;
        if (edge.costs && edge.costs.time && typeof edge.costs.time === 'object') {
          edgeTime = edge.costs.time.value || 0;
          // Convert to days if needed
          if (edge.costs.time.units === 'hours') {
            edgeTime = edgeTime / 24; // Convert hours to days
          } else if (edge.costs.time.units === 'weeks') {
            edgeTime = edgeTime * 7; // Convert weeks to days
          }
          // If units is 'days' or undefined, use as-is
        } else if (edge.costs && typeof edge.costs.time === 'number') {
          // Backward compatibility with old structure (assume days)
          edgeTime = edge.costs.time;
        }
        
        var edgeProb = edge.p && edge.p.mean ? edge.p.mean : 0.5;
        var targetTime = dfs(edge.to);
        totalTime += edgeProb * (edgeTime + targetTime);
      }
      
      times[nodeId] = totalTime;
      return totalTime;
    }
    
    return dfs(startNode.id);
  } catch (e) {
    return "Error calculating time: " + e.message;
  }
}
