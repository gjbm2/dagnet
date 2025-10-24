/**
 * Minimal Google Apps Script for Dagnet roundtrip:
 * - Menu: Dagnet → Initialize, Edit Selected Cell in Dagnet
 * - openDagnetFromCell: opens Dagnet with selected cell JSON
 * - doPost: receives graph JSON and writes back to the same cell
 * - getCurrentWebAppUrl: returns current deployment URL (no hardcoding)
 */

const DAGNET_APP_URL = 'https://dagnet-nine.vercel.app/';
const SCRIPT_VERSION = '2025-10-13-23-30-CACHE-BUST'; // Change this every time you edit!

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

// ===== USAGE EXAMPLES =====
// Smart input detection - works with multiple input types:
// =GraphCalc(A1, ANY_SUCCESS, PROBABILITY)  // Graph cell A1 contains "graph://graph_123"
// =GraphCalc(B2, ANY_SUCCESS, PROBABILITY)  // Cell B2 contains "graph_123" (use as graph ID)
// =GraphCalc(C3, ANY_SUCCESS, PROBABILITY)  // Cell C3 contains JSON blob (parse directly)
// =GraphCalc("graph://graph_123", ANY_SUCCESS, PROBABILITY)  // Direct graph:// protocol
// =GraphCalc("graph_123", ANY_SUCCESS, PROBABILITY)  // Direct graph ID string
// =GraphCalc('{"nodes":[...],"edges":[...]}', ANY_SUCCESS, PROBABILITY)  // Direct JSON blob
// =GraphCalc(A1, "start", ANY_SUCCESS, PROBABILITY)  // Explicit start node
// =GraphCalc(A1, , ANY_SUCCESS, PROBABILITY)  // Skip start node (auto-detect)
// =GraphCalc(A1, B2, ANY_SUCCESS, PROBABILITY)  // Start node from cell B2
// =GraphCalc(A1, "start", ANY_SUCCESS, PROBABILITY, "Scenario 2")  // With scenario
// =GraphCalc(A1, , ANY_SUCCESS, PROBABILITY, , customParams)  // Skip start and scenario
//
// Smart input behavior:
// - Graph cell (graph://...): Extract graph ID from graph:// protocol
// - Cell with graph ID: Use cell contents as graph ID
// - Cell with JSON: Parse JSON directly (no history lookup)
// - Direct graph:// string: Parse graph ID from protocol
// - Direct graph ID string: Use as graph ID
// - Direct JSON string: Parse JSON directly (no history lookup)
//
// All parameters are positional and optional:
// GraphCalc(input, startNode, endNode, operation, scenario, customParams)

function testGraphCalc() {
  // Test function to trace GraphCalc logic
  var cellRef = "H11"; // Change this to your actual cell reference
  console.log('Testing GraphCalc with cell:', cellRef);
  
  var sheet = SpreadsheetApp.getActiveSheet();
  var cell = sheet.getRange(cellRef);
  
  var note = cell.getNote();
  console.log('Cell note:', note);
  console.log('Note includes DAGNET_GRAPH:', note && note.includes('DAGNET_GRAPH:'));
  
  var cellValue = cell.getValue();
  console.log('Cell value:', cellValue);
  
  if (note && note.includes('DAGNET_GRAPH:')) {
    var graphIdMatch = note.match(/DAGNET_GRAPH:([^|]+)/);
    console.log('Graph ID match:', graphIdMatch);
    if (graphIdMatch) {
      console.log('Extracted graph ID:', graphIdMatch[1]);
    }
  }
  
  return "Check console logs for details";
}

function debugGraphCalc() {
  // Simple debug function that returns visible output
  var cellRef = "H11";
  var sheet = SpreadsheetApp.getActiveSheet();
  var cell = sheet.getRange(cellRef);
  
  var note = cell.getNote();
  var cellValue = cell.getValue();
  
  var result = "DEBUG INFO:\n";
  result += "Cell: " + cellRef + "\n";
  result += "Note: " + note + "\n";
  result += "Note has DAGNET_GRAPH: " + (note && note.includes('DAGNET_GRAPH:')) + "\n";
  result += "Cell value: " + cellValue + "\n";
  
  if (note && note.includes('DAGNET_GRAPH:')) {
    var graphIdMatch = note.match(/DAGNET_GRAPH:([^|]+)/);
    result += "Graph ID match: " + (graphIdMatch ? graphIdMatch[1] : "NO MATCH") + "\n";
  }
  
  return result;
}

function GraphCalcNew(cellRefOrGraphId, startNode, endNode, operation, scenario, customParams) {
  // New function to bypass caching issues - uses graph:// protocol
  try {
    var graphId;
    
    // Check if input is graph:// protocol
    if (typeof cellRefOrGraphId === 'string' && cellRefOrGraphId.startsWith('graph://')) {
      graphId = cellRefOrGraphId.replace('graph://', '').split('?')[0];
      return "SUCCESS: graph:// protocol detected, ID: " + graphId;
    }
    
    // It's a cell reference - check its value
    if (typeof cellRefOrGraphId === 'string' && cellRefOrGraphId.match(/^[A-Z]+\d+$/)) {
      var sheet = SpreadsheetApp.getActiveSheet();
      var cell = sheet.getRange(cellRefOrGraphId);
      var cellValue = cell.getValue();
      
      if (cellValue && cellValue.toString().startsWith('graph://')) {
        graphId = cellValue.toString().replace('graph://', '').split('?')[0];
        return "SUCCESS: Cell contains graph:// protocol, ID: " + graphId;
      } else {
        return "ERROR: Cell does not contain graph:// protocol. Cell value: '" + cellValue + "'";
      }
    } else {
      return "ERROR: Input is not a cell reference or graph:// protocol: '" + cellRefOrGraphId + "'";
    }
    
  } catch (e) {
    return "Error: " + e.message;
  }
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Dagnet')
      .addItem('Initialize', 'initialize')
      .addItem('Enable Sidebar', 'requestSidebarPermissions')
      .addSeparator()
      .addItem('Create Graph', 'createNewGraph')
      .addItem('Edit Selected Cell in Dagnet', 'openDagnetFromCell')
      .addSeparator()
      .addItem('Edit in Dagnet (Menu)', 'menuEditInDagnet')
      .addItem('Extract Parameters (Menu)', 'menuExtractParameters')
      .addItem('Add Scenario (Menu)', 'menuAddScenario')
      .addItem('View History (Menu)', 'menuViewHistory')
      .addSeparator()
      .addItem('Show Sidebar', 'showSidebarWithPolling')
      .addItem('Test Sidebar', 'testSidebar')
      .addToUi();
    
    // Check if we have sidebar permissions without actually showing sidebar
    checkSidebarPermissions();
  } catch (e) {
    SpreadsheetApp.getUi().alert('Error in onOpen: ' + e.message);
  }
}

/**
 * Check sidebar permissions without showing sidebar
 */
function checkSidebarPermissions() {
  try {
    // Try to create a simple HTML output (this requires container.ui permission)
    var testHtml = HtmlService.createHtmlOutput('<html><body>test</body></html>');
    // If we get here, permissions are OK - show sidebar automatically
    showSimpleSidebar();
  } catch (e) {
    if (e.message.includes('container.ui')) {
      // Show a notification that sidebar needs authorization
      SpreadsheetApp.getUi().alert(
        'Dagnet Sidebar Ready!\n\n' +
        'To enable the automatic sidebar:\n' +
        '1. Go to Dagnet menu\n' +
        '2. Click "Enable Sidebar" (fast!)\n' +
        '3. Authorize when prompted\n\n' +
        'Or use "Show Sidebar" from the menu.'
      );
    }
  }
}

/**
 * Lightweight permission request - just for sidebar (fast!)
 */
function requestSidebarPermissions() {
  var ui = SpreadsheetApp.getUi();
  
  try {
    showSimpleSidebar();
  } catch (e) {
    ui.alert('❌ Permission error: ' + e.message + '\n\nPlease authorize the script when prompted.');
  }
}

function initialize() {
  var ui = SpreadsheetApp.getUi();
  
  // Step 1: Request permissions by trying to show sidebar
  try {
    showSimpleSidebar();
  } catch (e) {
    ui.alert('Permission error: ' + e.message + '\n\nPlease authorize the script when prompted.');
    return;
  }
  
  // Step 2: Check/Update web app URL
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
  
  // Step 3: Test the URL
  var testResult = testWebAppUrl(urlToTest);
  if (testResult.success) {
    // Step 4: Update all existing graph cells
    updateAllGraphCells();
    
    ui.alert('✅ Setup complete!\n\nWeb app URL: ' + urlToTest + '\nStatus: Working\n\nAll graph cells updated with latest options.\n\nYou can now use "Create Graph" and "Edit Selected Cell in Dagnet"');
  } else {
    ui.alert('❌ Web app URL not working: ' + urlToTest + '\n\nPlease check the URL and try again.');
    var retryUrl = Browser.inputBox('Paste the correct web app URL:');
    if (retryUrl && retryUrl !== 'cancel') {
      setWebAppUrl(retryUrl.trim());
      var retest = testWebAppUrl(retryUrl.trim());
      if (retest.success) {
        updateAllGraphCells();
        ui.alert('✅ Fixed! Web app is now working and all graph cells updated.');
      } else {
        ui.alert('❌ Still not working. Check the deployment settings.');
      }
    }
  }
}

function testWebAppUrl(url) {
  try {
    // Simple health check - just test if the URL responds, don't write anything
    var testUrl = url + '?healthcheck=1';
    var response = UrlFetchApp.fetch(testUrl, { muteHttpExceptions: true });
    // Any non-404 response means the deployment exists and is accessible
    return { success: response.getResponseCode() !== 404, status: response.getResponseCode() };
  } catch (e) {
    return { success: false, status: 'error' };
  }
}

/**
 * Open Dagnet with JSON from the currently selected cell. Edit-in-place by default.
 */
function openDagnetFromCell() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();
  const cellA1 = activeRange.getA1Notation();
  let cellValue = activeRange.getDisplayValue() || activeRange.getValue();
  if (!cellValue || cellValue.toString().trim() === '') {
    SpreadsheetApp.getUi().alert('Selected cell is empty. Put a graph:// reference or JSON in the cell and try again.');
    return;
  }
  
  // Check if this is a graph:// protocol cell
  if (cellValue.toString().startsWith('graph://')) {
    const graphId = cellValue.toString().replace('graph://', '').split('?')[0]; // Extract graph ID (ignore params for now)
    openDagnetFromPointer(activeRange, graphId);
    return;
  }
  
  // Otherwise treat as JSON
  let jsonString = cellValue;

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
 * Create a new graph with placeholder data
 */
function createNewGraph() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();
  const cellA1 = activeRange.getA1Notation();
  
  // Check if cell is empty
  if (activeRange.getValue() && activeRange.getValue().toString().trim() !== '') {
    SpreadsheetApp.getUi().alert('Selected cell is not empty. Please select an empty cell to create a new graph.');
    return;
  }
  
  // Generate unique graph ID
  const graphId = 'graph_' + Utilities.getUuid().slice(0, 8);
  
  // Create graph cell with image and metadata
  createGraphCell(activeRange, graphId);
  
  // Create minimal history entry (just so Dagnet can find the graph ID)
  const historySheet = getOrCreateHistorySheet();
  const minimalGraph = null; // NULL as requested
  
  addHistoryEntry(historySheet, graphId, minimalGraph, 'New graph created');
  
  // Open Dagnet - it will find the graph ID in history but get null data
  openDagnetFromPointer(activeRange, graphId);
}

/**
 * Create a graph cell with graph:// protocol
 */
function createGraphCell(cell, graphId) {
  // Use graph:// protocol as cell value
  cell.setValue('graph://' + graphId);
  cell.setFontSize(10);
  cell.setHorizontalAlignment('left');
  cell.setVerticalAlignment('middle');
  
  // Style the cell to look like a graph cell
  cell.setBackground('#e8f4fd');
  cell.setBorder(true, true, true, true, true, true);
  cell.setFontColor('#0066cc');
  cell.setFontWeight('bold');
}

/**
 * Show sidebar with automatic polling
 */
function showSidebarWithPolling() {
  console.log('showSidebarWithPolling: Starting...');
  var html = HtmlService.createHtmlOutput(`
    <!DOCTYPE html>
    <html>
    <head>
      <base target="_top">
      <style>
        body { font-family: Arial, sans-serif; padding: 16px; margin: 0; }
        .header { font-weight: bold; color: #1a73e8; margin-bottom: 16px; }
        .action-button { 
          display: block; 
          width: 100%; 
          padding: 8px 12px; 
          margin: 4px 0; 
          background: #1a73e8; 
          color: white; 
          border: none; 
          border-radius: 4px; 
          cursor: pointer;
          text-align: left;
        }
        .action-button:hover { background: #1557b0; }
        .info { background: #f8f9fa; padding: 8px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
        .section { margin: 16px 0; }
        .section-title { font-weight: bold; color: #333; margin-bottom: 8px; }
        .no-selection { color: #666; font-style: italic; }
      </style>
    </head>
    <body>
      <div class="header">📊 Graph Actions</div>
      <div class="info">Automatically detecting selection...</div>
      
      <div id="content">
        <div class="no-selection">Select a graph cell to see actions</div>
      </div>
      
      <div id="debug-info" style="margin-top: 20px; padding: 10px; background: #f0f0f0; border-radius: 4px; font-size: 11px;">
        <strong>Debug Info:</strong><br>
        <div id="current-cell">Current Cell: Detecting...</div>
        <div id="cell-note">Cell Note: Detecting...</div>
        <div id="polling-status">Polling: Starting...</div>
      </div>
      
      <script>
        var currentGraphId = null;
        
        function updateContent(selectionInfo) {
          console.log('Update content called with:', selectionInfo);
          
          // Update debug info
          document.getElementById('current-cell').textContent = 'Current Cell: ' + (selectionInfo.cellRef || 'Unknown');
          document.getElementById('cell-note').textContent = 'Cell Note: ' + (selectionInfo.cellNote || 'None');
          document.getElementById('polling-status').textContent = 'Polling: Active (Last: ' + new Date().toLocaleTimeString() + ')';
          
          if (selectionInfo && selectionInfo.isGraphCell) {
            if (currentGraphId !== selectionInfo.graphId) {
              currentGraphId = selectionInfo.graphId;
              showGraphActions(selectionInfo);
            }
          } else {
            if (currentGraphId !== null) {
              currentGraphId = null;
              showNoSelection();
            }
          }
        }
        
        function showGraphActions(selectionInfo) {
          var html = '<div class="section">';
          html += '<div class="section-title">Graph Management</div>';
          html += '<button class="action-button" onclick="editGraph()">✏️ Edit in Dagnet</button>';
          html += '<button class="action-button" onclick="extractParams()">📋 Extract Parameters</button>';
          html += '<button class="action-button" onclick="addScenario()">➕ Add Scenario</button>';
          html += '<button class="action-button" onclick="viewHistory()">📚 View History</button>';
          html += '<button class="action-button" onclick="createNew()">➕ Create New Graph</button>';
          html += '</div>';
          document.getElementById('content').innerHTML = html;
        }
        
        function showNoSelection() {
          document.getElementById('content').innerHTML = '<div class="no-selection">Select a graph cell to see actions</div>';
        }
        
        function editGraph() {
          google.script.run.editGraphFromSidebar(currentGraphId);
        }
        
        function extractParams() {
          google.script.run.extractParamsFromSidebar(currentGraphId);
        }
        
        function addScenario() {
          google.script.run.addScenarioFromSidebar(currentGraphId);
        }
        
        function viewHistory() {
          google.script.run.viewHistoryFromSidebar(currentGraphId);
        }
        
        function createNew() {
          google.script.run.createNewGraphFromSidebar();
        }
        
        // Start polling immediately
        console.log('Starting polling...');
        setInterval(function() {
          google.script.run
            .withSuccessHandler(updateContent)
            .withFailureHandler(function(error) {
              console.log('Polling error:', error);
              document.getElementById('polling-status').textContent = 'Polling: Error - ' + error.message;
            })
            .getCurrentSelectionInfo();
        }, 2000);
        
        // Initial call
        google.script.run
          .withSuccessHandler(updateContent)
          .getCurrentSelectionInfo();
      </script>
    </body>
    </html>
  `).setTitle('Graph Actions').setWidth(350);
  
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Simple fallback sidebar
 */
function showSimpleSidebar() {
  try {
    var ui = SpreadsheetApp.getUi();
    
    var html = HtmlService.createHtmlOutput(`
      <!DOCTYPE html>
      <html>
      <head><base target="_top"></head>
      <body>
        <h3>📊 Graph Actions</h3>
        <div id="content">
          <p>Use the menu to access graph functions.</p>
          <button onclick="google.script.run.createNewGraphFromSidebar()">Create Graph</button>
        </div>
        
        <div id="debug-info" style="margin-top: 20px; padding: 10px; background: #f0f0f0; border-radius: 4px; font-size: 11px;">
          <strong>Debug Info:</strong><br>
          <div id="current-cell">Current Cell: Detecting...</div>
          <div id="cell-note">Cell Note: Detecting...</div>
          <div id="polling-status">Polling: Starting...</div>
        </div>
        
        <script>
          var currentGraphId = null;
          
          function updateDebugInfo(selectionInfo) {
            // Update debug info
            document.getElementById('current-cell').textContent = 'Current Cell: ' + (selectionInfo.cellRef || 'Unknown');
            document.getElementById('cell-note').textContent = 'Cell Note: ' + (selectionInfo.cellNote || 'None');
            document.getElementById('polling-status').textContent = 'Polling: Active (Last: ' + new Date().toLocaleTimeString() + ')';
            
            // Update content based on selection
            if (selectionInfo && selectionInfo.isGraphCell) {
              if (currentGraphId !== selectionInfo.graphId) {
                currentGraphId = selectionInfo.graphId;
                showGraphActions(selectionInfo);
              }
            } else {
              if (currentGraphId !== null) {
                currentGraphId = null;
                showNoSelection();
              }
            }
          }
          
          function showGraphActions(selectionInfo) {
            var html = '<div style="margin: 10px 0;">';
            html += '<h4>Graph Management</h4>';
            html += '<button onclick="editGraph()" style="display: block; width: 100%; padding: 8px; margin: 4px 0; background: #1a73e8; color: white; border: none; border-radius: 4px; cursor: pointer;">✏️ Edit in Dagnet</button>';
            html += '<button onclick="extractParams()" style="display: block; width: 100%; padding: 8px; margin: 4px 0; background: #1a73e8; color: white; border: none; border-radius: 4px; cursor: pointer;">📋 Extract Parameters</button>';
            html += '<button onclick="addScenario()" style="display: block; width: 100%; padding: 8px; margin: 4px 0; background: #1a73e8; color: white; border: none; border-radius: 4px; cursor: pointer;">➕ Add Scenario</button>';
            html += '<button onclick="viewHistory()" style="display: block; width: 100%; padding: 8px; margin: 4px 0; background: #1a73e8; color: white; border: none; border-radius: 4px; cursor: pointer;">📚 View History</button>';
            html += '</div>';
            document.getElementById('content').innerHTML = html;
          }
          
          function showNoSelection() {
            document.getElementById('content').innerHTML = '<p>Use the menu to access graph functions.</p><button onclick="google.script.run.createNewGraphFromSidebar()">Create Graph</button>';
          }
          
          function editGraph() {
            google.script.run.editGraphFromSidebar(currentGraphId);
          }
          
          function extractParams() {
            google.script.run.extractParamsFromSidebar(currentGraphId);
          }
          
          function addScenario() {
            google.script.run.addScenarioFromSidebar(currentGraphId);
          }
          
          function viewHistory() {
            google.script.run.viewHistoryFromSidebar(currentGraphId);
          }
          
          // Start polling immediately
          setInterval(function() {
            google.script.run
              .withSuccessHandler(updateDebugInfo)
              .withFailureHandler(function(error) {
                document.getElementById('polling-status').textContent = 'Polling: Error - ' + error.message;
              })
              .getCurrentSelectionInfo();
          }, 1000);
          
          // Initial call
          google.script.run
            .withSuccessHandler(updateDebugInfo)
            .getCurrentSelectionInfo();
        </script>
      </body>
      </html>
    `).setTitle('Graph Actions').setWidth(350);
    
    ui.showSidebar(html);
  } catch (e) {
    // If sidebar fails due to permissions, show a dialog instead
    if (e.message.includes('permissions') || e.message.includes('container.ui')) {
      SpreadsheetApp.getUi().alert('Sidebar requires additional permissions. Please run "Enable Sidebar" from the menu to authorize the script.');
    } else {
      SpreadsheetApp.getUi().alert('Error showing sidebar: ' + e.message);
    }
  }
}

/**
 * Setup sidebar polling for automatic updates (DISABLED FOR NOW)
 */
function setupSidebarPolling() {
  // Create a persistent sidebar that polls for selection changes
  var html = HtmlService.createHtmlOutput(`
    <!DOCTYPE html>
    <html>
    <head>
      <base target="_top">
      <style>
        body { font-family: Arial, sans-serif; padding: 16px; margin: 0; }
        .header { font-weight: bold; color: #1a73e8; margin-bottom: 16px; }
        .action-button { 
          display: block; 
          width: 100%; 
          padding: 8px 12px; 
          margin: 4px 0; 
          background: #1a73e8; 
          color: white; 
          border: none; 
          border-radius: 4px; 
          cursor: pointer;
          text-align: left;
        }
        .action-button:hover { background: #1557b0; }
        .info { background: #f8f9fa; padding: 8px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
        .section { margin: 16px 0; }
        .section-title { font-weight: bold; color: #333; margin-bottom: 8px; }
        .node-list { background: #f0f8ff; padding: 8px; border-radius: 4px; margin: 8px 0; font-size: 11px; }
        .analytics-button { background: #28a745; }
        .analytics-button:hover { background: #218838; }
        .no-selection { color: #666; font-style: italic; }
      </style>
    </head>
    <body>
      <div id="sidebar-content">
        <div class="no-selection">Select a graph cell to see actions</div>
      </div>
      
      <div id="debug-info" style="margin-top: 20px; padding: 10px; background: #f0f0f0; border-radius: 4px; font-size: 11px;">
        <strong>Debug Info:</strong><br>
        <div id="current-cell">Current Cell: Loading...</div>
        <div id="cell-note">Cell Note: Loading...</div>
        <div id="polling-status">Polling: Active</div>
      </div>
      
      <script>
        var currentGraphId = null;
        var pollInterval;
        
        function startPolling() {
          console.log('Starting polling...');
          pollInterval = setInterval(function() {
            console.log('Polling...');
            google.script.run
              .withSuccessHandler(function(result) {
                console.log('Polling success:', result);
                updateSidebar(result);
              })
              .withFailureHandler(function(error) {
                console.log('Polling error:', error);
                document.getElementById('current-cell').textContent = 'Current Cell: Error - ' + error;
                document.getElementById('cell-note').textContent = 'Cell Note: Error - ' + error;
                document.getElementById('polling-status').textContent = 'Polling: Error - ' + error;
              })
              .getCurrentSelectionInfo();
          }, 2000);
        }
        
        function updateSidebar(selectionInfo) {
          // Update debug info
          document.getElementById('current-cell').textContent = 'Current Cell: ' + (selectionInfo.cellRef || 'Unknown');
          document.getElementById('cell-note').textContent = 'Cell Note: ' + (selectionInfo.cellNote || 'None');
          document.getElementById('polling-status').textContent = 'Polling: Active (Last: ' + new Date().toLocaleTimeString() + ')';
          
          if (selectionInfo && selectionInfo.isGraphCell) {
            if (currentGraphId !== selectionInfo.graphId) {
              currentGraphId = selectionInfo.graphId;
              showGraphActions(selectionInfo);
            }
          } else {
            if (currentGraphId !== null) {
              currentGraphId = null;
              showNoSelection();
            }
          }
        }
        
        function showGraphActions(selectionInfo) {
          var html = '<div class="header">📊 Graph Actions</div>';
          html += '<div class="info">Graph ID: ' + selectionInfo.graphId + '</div>';
          
          html += '<div class="section">';
          html += '<div class="section-title">Graph Management</div>';
          html += '<button class="action-button" onclick="editGraph()">✏️ Edit in Dagnet</button>';
          html += '<button class="action-button" onclick="extractParams()">📋 Extract Parameters</button>';
          html += '<button class="action-button" onclick="addScenario()">➕ Add Scenario</button>';
          html += '<button class="action-button" onclick="viewHistory()">📚 View History</button>';
          html += '<button class="action-button" onclick="createNew()">➕ Create New Graph</button>';
          html += '</div>';
          
          if (selectionInfo.nodeNames && selectionInfo.nodeNames.length > 0) {
            html += '<div class="section">';
            html += '<div class="section-title">Analytics</div>';
            html += '<div class="node-list"><strong>Available Nodes:</strong><br>' + selectionInfo.nodeNames.join(', ') + '</div>';
            html += '<button class="action-button analytics-button" onclick="runAnalytics(\'probability\')">📈 P(Start → Success)</button>';
            html += '<button class="action-button analytics-button" onclick="runAnalytics(\'cost\')">💰 Cost(Start → Success)</button>';
            html += '<button class="action-button analytics-button" onclick="runAnalytics(\'time\')">⏱️ Time(Start → Success)</button>';
            html += '<button class="action-button analytics-button" onclick="runCustomAnalytics()">🔧 Custom Analytics</button>';
            html += '</div>';
          }
          
          document.getElementById('sidebar-content').innerHTML = html;
        }
        
        function showNoSelection() {
          document.getElementById('sidebar-content').innerHTML = '<div class="no-selection">Select a graph cell to see actions</div>';
        }
        
        function editGraph() {
          google.script.run.editGraphFromSidebar(currentGraphId);
        }
        
        function extractParams() {
          google.script.run.extractParamsFromSidebar(currentGraphId);
        }
        
        function addScenario() {
          google.script.run.addScenarioFromSidebar(currentGraphId);
        }
        
        function viewHistory() {
          google.script.run.viewHistoryFromSidebar(currentGraphId);
        }
        
        function createNew() {
          google.script.run.createNewGraphFromSidebar();
        }
        
        function runAnalytics(operation) {
          google.script.run.runStandardAnalytics(currentGraphId, operation);
        }
        
        function runCustomAnalytics() {
          google.script.run.runCustomAnalytics(currentGraphId);
        }
        
        // Test function to manually trigger polling
        function testPolling() {
          console.log('Manual polling test...');
          google.script.run
            .withSuccessHandler(function(result) {
              console.log('Manual test success:', result);
              updateSidebar(result);
            })
            .withFailureHandler(function(error) {
              console.log('Manual test error:', error);
              alert('Error: ' + error);
            })
            .getCurrentSelectionInfo();
        }
        
        // Add test button
        document.addEventListener('DOMContentLoaded', function() {
          var testButton = document.createElement('button');
          testButton.textContent = 'Test Polling';
          testButton.onclick = testPolling;
          testButton.style.marginTop = '10px';
          testButton.style.padding = '5px 10px';
          document.getElementById('debug-info').appendChild(testButton);
        });
        
        // Start polling when sidebar loads
        startPolling();
      </script>
    </body>
    </html>
  `).setTitle('Graph Actions').setWidth(350);
  
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Get current selection info for polling
 */
function getCurrentSelectionInfo() {
  try {
    var sheet = SpreadsheetApp.getActiveSheet();
    var cell = sheet.getActiveRange();
    var cellValue = cell.getValue();
    var note = cell.getNote();
    
    // Debug logging
    console.log('Selection info - Cell:', cell.getA1Notation(), 'Value:', cellValue, 'Note:', note);
    
    // Check for graph:// protocol
    if (cellValue && cellValue.toString().startsWith('graph://')) {
      var graphId = cellValue.toString().replace('graph://', '').split('?')[0];
      var historySheet = getOrCreateHistorySheet();
      var graphData = getLatestGraphData(historySheet, graphId);
      
      // Extract node names
      var nodeNames = [];
      if (graphData && graphData.nodes) {
        nodeNames = graphData.nodes.map(function(node) {
          return node.data ? node.data.label : node.id;
        });
      }
      
      return {
        isGraphCell: true,
        graphId: graphId,
        nodeNames: nodeNames,
        cellRef: cell.getA1Notation(),
        cellNote: 'graph://' + graphId
      };
    } else {
      // Check if within a graph's parameter range
      var graphInfo = findGraphFromNamedRange(cell);
      if (graphInfo) {
        // Extract graph ID from cell value (graph:// protocol)
        var graphCellValue = graphInfo.cell.getValue();
        var graphId = graphCellValue.toString().replace('graph://', '').split('?')[0];
        var historySheet = getOrCreateHistorySheet();
        var graphData = getLatestGraphData(historySheet, graphId);
        
        var nodeNames = [];
        if (graphData && graphData.nodes) {
          nodeNames = graphData.nodes.map(function(node) {
            return node.data ? node.data.label : node.id;
          });
        }
        
        return {
          isGraphCell: true,
          graphId: graphId,
          nodeNames: nodeNames,
          cellRef: cell.getA1Notation(),
          cellNote: graphInfo.note
        };
      }
    }
    
    return { 
      isGraphCell: false,
      cellRef: cell.getA1Notation(),
      cellNote: note || 'None'
    };
  } catch (e) {
    console.log('Error getting selection info:', e);
    return { 
      isGraphCell: false,
      cellRef: 'Error',
      cellNote: 'Error: ' + e.message
    };
  }
}

/**
 * Setup edit trigger for contextual actions
 */
function setupEditTrigger() {
  // Delete existing onEdit triggers first
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'onEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create new onEdit trigger
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger('onEdit')
    .forSpreadsheet(spreadsheet)
    .onEdit()
    .create();
}

/**
 * Handle edit events for contextual actions
 */
function onEdit(e) {
  try {
    var cell = e.range;
    var value = cell.getValue();
    var note = cell.getNote();
    
    // Check if this is a graph cell with action selected
    if (note && note.includes('DAGNET_GRAPH:')) {
      var graphId = note.split(':')[1];
      
      switch (value) {
        case '✏️ Edit in Dagnet':
          openDagnetFromPointer(cell, graphId);
          break;
        case '📋 Extract Parameters':
          extractParametersToNamedRange(cell, graphId);
          break;
        case '➕ Add Scenario':
          addScenarioToGraph(cell, graphId);
          break;
        case '📚 View History':
          showHistoryForGraph(graphId);
          break;
        case '📊 Graph Actions':
          // Show sidebar for more options
          showGraphSidebar(cell, note);
          break;
      }
    }
  } catch (err) {
    console.log('Error in onEdit:', err);
  }
}

/**
 * Manual function to show sidebar for selected cell
 * (Google Apps Script doesn't support automatic onSelectionChange triggers)
 */
function showSidebarForSelectedCell() {
  try {
    var sheet = SpreadsheetApp.getActiveSheet();
    var cell = sheet.getActiveRange();
    var note = cell.getNote();
    
    if (note && note.includes('DAGNET_GRAPH:')) {
      // This is a graph cell - show sidebar
      showGraphSidebar(cell, note);
    } else {
      // Check if this cell is within a graph's named range
      var graphInfo = findGraphFromNamedRange(cell);
      if (graphInfo) {
        // This is within a graph's parameter range - show sidebar
        showGraphSidebar(cell, graphInfo.note);
      } else {
        // Not a graph cell or parameter range
        SpreadsheetApp.getUi().alert('Please select a graph cell (one with 📊 icon) or a cell within a graph\'s parameter range.');
      }
    }
  } catch (err) {
    console.log('Error in showSidebarForSelectedCell:', err);
    SpreadsheetApp.getUi().alert('Error showing sidebar: ' + err.message);
  }
}

/**
 * Show sidebar with graph actions
 */
function showGraphSidebar(cell, note) {
  var graphId = note.split(':')[1];
  var historySheet = getOrCreateHistorySheet();
  var graphData = getLatestGraphData(historySheet, graphId);
  
  // Extract node names from graph data
  var nodeNames = [];
  if (graphData && graphData.nodes) {
    nodeNames = graphData.nodes.map(function(node) {
      return node.data ? node.data.label : node.id;
    });
  }
  
  var html = HtmlService.createHtmlOutput(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 16px; margin: 0; }
        .header { font-weight: bold; color: #1a73e8; margin-bottom: 16px; }
        .action-button { 
          display: block; 
          width: 100%; 
          padding: 8px 12px; 
          margin: 4px 0; 
          background: #1a73e8; 
          color: white; 
          border: none; 
          border-radius: 4px; 
          cursor: pointer;
          text-align: left;
        }
        .action-button:hover { background: #1557b0; }
        .info { background: #f8f9fa; padding: 8px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
        .section { margin: 16px 0; }
        .section-title { font-weight: bold; color: #333; margin-bottom: 8px; }
        .node-list { background: #f0f8ff; padding: 8px; border-radius: 4px; margin: 8px 0; font-size: 11px; }
        .analytics-button { background: #28a745; }
        .analytics-button:hover { background: #218838; }
      </style>
    </head>
    <body>
      <div class="header">📊 Graph Actions</div>
      <div class="info">Graph ID: ${graphId}</div>
      
      <div class="section">
        <div class="section-title">Graph Management</div>
        <button class="action-button" onclick="editGraph()">✏️ Edit in Dagnet</button>
        <button class="action-button" onclick="extractParams()">📋 Extract Parameters</button>
        <button class="action-button" onclick="addScenario()">➕ Add Scenario</button>
        <button class="action-button" onclick="viewHistory()">📚 View History</button>
        <button class="action-button" onclick="createNew()">➕ Create New Graph</button>
      </div>
      
      <div class="section">
        <div class="section-title">Analytics</div>
        <div class="node-list">
          <strong>Available Nodes:</strong><br>
          ${nodeNames.join(', ')}
        </div>
        <button class="action-button analytics-button" onclick="runAnalytics('probability')">📈 P(Start → Success)</button>
        <button class="action-button analytics-button" onclick="runAnalytics('cost')">💰 Cost(Start → Success)</button>
        <button class="action-button analytics-button" onclick="runAnalytics('time')">⏱️ Time(Start → Success)</button>
        <button class="action-button analytics-button" onclick="runCustomAnalytics()">🔧 Custom Analytics</button>
      </div>
      
      <script>
        function editGraph() {
          google.script.run.editGraphFromSidebar('${graphId}');
        }
        
        function extractParams() {
          google.script.run.extractParamsFromSidebar('${graphId}');
        }
        
        function viewHistory() {
          google.script.run.viewHistoryFromSidebar('${graphId}');
        }
        
        function addScenario() {
          google.script.run.addScenarioFromSidebar('${graphId}');
        }
        
        function createNew() {
          google.script.run.createNewGraphFromSidebar();
        }
        
        function runAnalytics(operation) {
          google.script.run.runStandardAnalytics('${graphId}', operation);
        }
        
        function runCustomAnalytics() {
          google.script.run.runCustomAnalytics('${graphId}');
        }
      </script>
    </body>
    </html>
  `).setTitle('Graph Actions').setWidth(350);
  
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Hide sidebar
 */
function hideSidebar() {
  // Note: Apps Script doesn't have a direct way to hide sidebar
  // The sidebar will remain visible until user closes it manually
}

/**
 * Sidebar action handlers
 */
function editGraphFromSidebar(graphId) {
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet.getActiveRange();
  openDagnetFromPointer(range, graphId);
}

function extractParamsFromSidebar(graphId) {
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet.getActiveRange();
  extractParametersToNamedRange(range, graphId);
}

function viewHistoryFromSidebar(graphId) {
  showHistoryForGraph(graphId);
}

function addScenarioFromSidebar(graphId) {
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet.getActiveRange();
  addScenarioToGraph(range, graphId);
}

function runStandardAnalytics(graphId, operation) {
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet.getActiveRange();
  runAnalyticsOnGraph(range, graphId, operation);
}

function runCustomAnalytics(graphId) {
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet.getActiveRange();
  runCustomAnalyticsOnGraph(range, graphId);
}

function createNewGraphFromSidebar() {
  createNewGraph();
}


/**
 * Update all graph cells with latest validation options
 */
function updateAllGraphCells() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = spreadsheet.getSheets();
  var updatedCount = 0;
  
  sheets.forEach(function(sheet) {
    var range = sheet.getDataRange();
    var values = range.getValues();
    var comments = range.getComments();
    
    for (var i = 0; i < values.length; i++) {
      for (var j = 0; j < values[i].length; j++) {
        var cell = sheet.getRange(i + 1, j + 1);
        var comment = comments[i][j];
        
        if (comment && comment.includes('DAGNET_POINTER:')) {
          // This is a graph cell - update its validation
          updateGraphCellValidation(cell);
          updatedCount++;
        }
      }
    }
  });
  
  SpreadsheetApp.getUi().alert('✅ Updated ' + updatedCount + ' graph cells with latest validation options.');
}

/**
 * Update validation for a single graph cell
 */
function updateGraphCellValidation(cell) {
  // Get current graph ID from comment
  var comment = cell.getComment();
  if (!comment || !comment.includes('DAGNET_POINTER:')) {
    return;
  }
  
  var graphId = comment.split(':')[1];
  
  // Update validation with latest options
  var validation = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Edit in Dagnet', 'Extract Params', 'View History', 'Create New'])
    .setAllowInvalid(false)
    .setHelpText('Select action for this graph')
    .build();
  
  cell.setDataValidation(validation);
  
  // Note: setLocked() doesn't exist in Apps Script
  // Validation dropdown itself prevents editing the options
  
  // Reset to default value if it's not a valid option
  var currentValue = cell.getValue();
  var validOptions = ['Edit in Dagnet', 'Extract Params', 'View History', 'Create New'];
  if (!validOptions.includes(currentValue)) {
    cell.setValue('Select Action...');
  }
}

/**
 * Get or create the history sheet
 */
function getOrCreateHistorySheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let historySheet = spreadsheet.getSheetByName('History');
  
  if (!historySheet) {
    historySheet = spreadsheet.insertSheet('History');
    
    // Add headers
    historySheet.getRange('A1').setValue('Timestamp');
    historySheet.getRange('B1').setValue('User');
    historySheet.getRange('C1').setValue('Narrative');
    historySheet.getRange('D1').setValue('JSON Data');
    historySheet.getRange('E1').setValue('Graph ID');
    historySheet.getRange('F1').setValue('Label');
    
    // Style headers
    const headerRange = historySheet.getRange('A1:F1');
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#f0f0f0');
  }
  
  return historySheet;
}

/**
 * Add a new entry to the history sheet
 */
function addHistoryEntry(historySheet, graphId, graphData, narrative) {
  const lastRow = historySheet.getLastRow();
  const newRow = lastRow + 1;
  
  // If no graphId provided, generate one
  if (!graphId) {
    graphId = 'graph_' + Utilities.getUuid().slice(0, 8);
  }
  
  historySheet.getRange(newRow, 1).setValue(new Date());
  historySheet.getRange(newRow, 2).setValue(Session.getActiveUser().getEmail());
  historySheet.getRange(newRow, 3).setValue(narrative);
  historySheet.getRange(newRow, 4).setValue(JSON.stringify(graphData, null, 2));
  historySheet.getRange(newRow, 5).setValue(graphId);
  historySheet.getRange(newRow, 6).setValue('Graph ' + graphId);
  
  return graphId; // Return the graph ID, not the row number!
}

/**
 * Handle dropdown selection changes
 */
function onEdit(e) {
  try {
    var cell = e.range;
    var value = e.value;
    
    if (!value || !cell.getComment() || !cell.getComment().includes('DAGNET_POINTER:')) {
      return;
    }
    
    var graphId = cell.getComment().split(':')[1];
    
    switch(value) {
      case 'Edit in Dagnet':
        openDagnetFromPointer(cell, graphId);
        break;
      case 'Extract Params':
        extractParametersFromPointer(cell, graphId);
        break;
      case 'View History':
        showHistoryForGraph(graphId);
        break;
      case 'Create New':
        createNewGraph();
        break;
    }
    
    // Clear the dropdown selection after action
    cell.setValue('');
    
  } catch (err) {
    console.log('Error in onEdit:', err);
  }
}

/**
 * Open Dagnet with graph data from pointer
 */
function openDagnetFromPointer(cell, graphId) {
  // CACHE BUSTER: Show version to verify we're running latest code
  SpreadsheetApp.getUi().alert('SCRIPT VERSION: ' + SCRIPT_VERSION + '\n\nOpening graph: ' + graphId);
  
  const historySheet = getOrCreateHistorySheet();
  const graphData = getLatestGraphData(historySheet, graphId);
  
  const sessionId = Utilities.getUuid();
  const sheetId = cell.getSheet().getParent().getId();
  const cellA1 = cell.getA1Notation();
  const appsScriptUrl = getCurrentWebAppUrl();
  
  const appUrl = DAGNET_APP_URL
    + '?data=' + encodeURIComponent(JSON.stringify(graphData))
    + '&session=' + encodeURIComponent(sessionId)
    + '&outputCell=' + encodeURIComponent(cellA1)
    + '&sheetId=' + encodeURIComponent(sheetId)
    + '&appsScriptUrl=' + encodeURIComponent(appsScriptUrl)
    + '&graphId=' + encodeURIComponent(graphId);
  
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
 * Get the latest graph data for a given graph ID
 */
function getLatestGraphData(historySheet, graphId) {
  const data = historySheet.getDataRange().getValues();
  
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][4] === graphId) { // Column E (Graph ID)
      const jsonString = data[i][3]; // Column D (JSON Data)
      if (!jsonString || jsonString === 'null') return null;
      return JSON.parse(jsonString);
    }
  }
  return null;
}

/**
 * Extract parameters to a named range
 */
function extractParametersToNamedRange(cell, graphId) {
  const historySheet = getOrCreateHistorySheet();
  const graphData = getLatestGraphData(historySheet, graphId);
  const params = extractNamedParameters(graphData);
  const namedRangeName = 'GraphParams_' + graphId;
  
  createOrUpdateNamedRange(cell, namedRangeName, params);
  
  // Note: Named range is associated with graph cell via the naming convention
  // GraphParams_{graphId} where graphId matches the cell's graph://graph_id value
}

/**
 * Create or update a named range with parameters
 */
function createOrUpdateNamedRange(cell, namedRangeName, params) {
  const sheet = cell.getSheet();
  const spreadsheet = sheet.getParent();
  
  // Calculate position for parameter table (below the graph cell)
  const graphRow = cell.getRow();
  const graphCol = cell.getColumn();
  const startRow = graphRow + 1;
  const startCol = graphCol;
  
  // Calculate range size needed
  const numParams = params.length;
  const numRows = Math.max(numParams + 1, 2); // +1 for header, minimum 2 rows
  const numCols = 2; // Parameter name and value columns
  
  // Create the range
  const paramRange = sheet.getRange(startRow, startCol, numRows, numCols);
  
  // Clear existing content
  paramRange.clearContent();
  
  if (params.length === 0) {
    // No parameters found
    sheet.getRange(startRow, startCol).setValue('No parameters found');
    sheet.getRange(startRow, startCol).setBackground('#f0f0f0');
  } else {
    // Add headers for multi-scenario format
    sheet.getRange(startRow, startCol).setValue('Parameter Name');
    sheet.getRange(startRow, startCol + 1).setValue('Default');
    
    // Style headers
    const headerRange = sheet.getRange(startRow, startCol, 1, 2);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#e8f4fd');
    headerRange.setBorder(true, true, true, true, true, true);
    
    // Add parameter data
    params.forEach(function(param, index) {
      const dataRow = startRow + index + 1; // +1 for header row
      sheet.getRange(dataRow, startCol).setValue(param.name);
      sheet.getRange(dataRow, startCol + 1).setValue(param.value);
    });
    
    // Style parameter rows
    const dataRange = sheet.getRange(startRow + 1, startCol, numParams, 2);
    dataRange.setBorder(true, true, true, true, true, true);
  }
  
  // Create or update named range
  try {
    // Try to get existing named range
    const existingRange = spreadsheet.getRangeByName(namedRangeName);
    if (existingRange) {
      // Update existing named range - keep original position, update size
      const originalRange = existingRange.getRange();
      const newRange = sheet.getRange(originalRange.getRow(), originalRange.getColumn(), numRows, numCols);
      
      // Remove old named range and create new one
      var namedRanges = spreadsheet.getNamedRanges();
      for (var i = 0; i < namedRanges.length; i++) {
        if (namedRanges[i].getName() === namedRangeName) {
          namedRanges[i].remove();
          break;
        }
      }
      spreadsheet.setNamedRange(namedRangeName, newRange);
      
      // Named range doesn't need to store graph ID - graph cell stores named range ID
      
      // Clear and repopulate the existing range
      newRange.clearContent();
      if (params.length === 0) {
        newRange.getRange(1, 1).setValue('No parameters found');
        newRange.getRange(1, 1).setBackground('#f0f0f0');
      } else {
        // Add headers
        newRange.getRange(1, 1).setValue('Parameter Name');
        newRange.getRange(1, 2).setValue('Parameter Value');
        
        // Style headers
        const headerRange = newRange.getRange(1, 1, 1, 2);
        headerRange.setFontWeight('bold');
        headerRange.setBackground('#e8f4fd');
        headerRange.setBorder(true, true, true, true, true, true);
        
        // Add parameter data
        params.forEach(function(param, index) {
          const dataRow = index + 2; // +2 because headers are in row 1
          newRange.getRange(dataRow, 1).setValue(param.name);
          newRange.getRange(dataRow, 2).setValue(param.value);
        });
        
        // Style parameter rows
        const dataRange = newRange.getRange(2, 1, numParams, 2);
        dataRange.setBorder(true, true, true, true, true, true);
      }
    } else {
      // Create new named range
      spreadsheet.setNamedRange(namedRangeName, paramRange);
      
      // Named range doesn't need to store graph ID - graph cell stores named range ID
    }
  } catch (e) {
    // If there's an error, try to create a new one
    try {
      spreadsheet.setNamedRange(namedRangeName, paramRange);
      // Named range doesn't need to store graph ID - graph cell stores named range ID
    } catch (e2) {
      console.log('Error creating named range:', e2);
      SpreadsheetApp.getUi().alert('Warning: Could not create named range. Parameters displayed but not linked.');
    }
  }
  
  return paramRange;
}

/**
 * Add a new scenario column to an existing parameter table
 */
function addScenarioToGraph(cell, graphId) {
  try {
    // DEBUG: Show version and function entry
    SpreadsheetApp.getUi().alert('DEBUG: addScenarioToGraph called\n\nScript Version: ' + SCRIPT_VERSION + '\nGraph ID: ' + graphId + '\nCell: ' + cell.getA1Notation());
    
    var namedRangeName = getNamedRangeFromGraphCell(cell);
    if (!namedRangeName) {
      SpreadsheetApp.getUi().alert('No parameter table found for this graph. Extract parameters first.');
      return;
    }
    
    var sheet = cell.getSheet();
    var spreadsheet = sheet.getParent();
    var namedRange = spreadsheet.getRangeByName(namedRangeName);
    
    if (!namedRange) {
      SpreadsheetApp.getUi().alert('Parameter table not found. Extract parameters first.');
      return;
    }
    
    // Get current range dimensions
    var currentRange = namedRange; // namedRange is already a Range object
    var currentRows = currentRange.getNumRows();
    var currentCols = currentRange.getNumColumns();
    var startRow = currentRange.getRow();
    var startCol = currentRange.getColumn();
    
    // Calculate new scenario number
    var newScenarioNum = currentCols; // Next scenario number (2, 3, 4, etc.)
    var newScenarioName = 'Scenario ' + newScenarioNum;
    
    // Create new range with one additional column
    var newRange = sheet.getRange(startRow, startCol, currentRows, currentCols + 1);
    
    // Update the named range to point to the expanded range
    // Delete the old named range and create a new one
    var namedRangeObj = spreadsheet.getRangeByName(namedRangeName);
    if (namedRangeObj) {
      // Get the NamedRange object (not the Range) to remove it
      var namedRanges = spreadsheet.getNamedRanges();
      for (var i = 0; i < namedRanges.length; i++) {
        if (namedRanges[i].getName() === namedRangeName) {
          namedRanges[i].remove();
          break;
        }
      }
    }
    
    // Create new named range with expanded range
    spreadsheet.setNamedRange(namedRangeName, newRange);
    
    // Add new scenario header
    var newColNum = startCol + currentCols; // Absolute column number
    sheet.getRange(startRow, newColNum, 1, 1).setValue(newScenarioName);
    
    // Copy parameter values from Default column to new scenario
    for (var i = 2; i <= currentRows; i++) {
      var defaultValue = currentRange.getCell(i, 2).getValue(); // Get from Default column
      sheet.getRange(startRow + i - 1, newColNum, 1, 1).setValue(defaultValue);
    }
    
    // Style the new column
    var newColRange = sheet.getRange(startRow, newColNum, currentRows, 1);
    newColRange.setBorder(true, true, true, true, true, true);
    
    // Style the new header
    var newHeaderRange = sheet.getRange(startRow, newColNum, 1, 1);
    newHeaderRange.setFontWeight('bold');
    newHeaderRange.setBackground('#e8f4fd');
    newHeaderRange.setBorder(true, true, true, true, true, true);
    
    SpreadsheetApp.getUi().alert('✅ New scenario added: ' + newScenarioName + '\n\nYou can now edit the parameter values in the new column to create alternative scenarios.');
    
  } catch (e) {
    console.log('Error adding scenario:', e);
    SpreadsheetApp.getUi().alert('Error adding scenario: ' + e.message);
  }
}

/**
 * Update an existing named range with new parameters
 */
function updateExistingNamedRange(existingRange, params) {
  const sheet = existingRange.getSheet();
  const spreadsheet = sheet.getParent();
  
  // Get original position
  const originalRow = existingRange.getRow();
  const originalCol = existingRange.getColumn();
  
  // Calculate new size needed
  const numParams = params.length;
  const numRows = Math.max(numParams + 1, 2); // +1 for header, minimum 2 rows
  const numCols = 2; // Parameter name and value columns
  
  // Create new range with same position but updated size
  const newRange = sheet.getRange(originalRow, originalCol, numRows, numCols);
  
  // Update the named range to point to the new range
  var namedRanges = spreadsheet.getNamedRanges();
  for (var i = 0; i < namedRanges.length; i++) {
    if (namedRanges[i].getName() === namedRangeName) {
      namedRanges[i].remove();
      break;
    }
  }
  spreadsheet.setNamedRange(namedRangeName, newRange);
  
  // Named range doesn't need to store graph ID - graph cell stores named range ID
  
  // Clear and repopulate the range
  newRange.clearContent();
  
  if (params.length === 0) {
    // No parameters found
    newRange.getRange(1, 1).setValue('No parameters found');
    newRange.getRange(1, 1).setBackground('#f0f0f0');
  } else {
    // Add headers
    newRange.getRange(1, 1).setValue('Parameter Name');
    newRange.getRange(1, 2).setValue('Parameter Value');
    
    // Style headers
    const headerRange = newRange.getRange(1, 1, 1, 2);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#e8f4fd');
    headerRange.setBorder(true, true, true, true, true, true);
    
    // Add parameter data
    params.forEach(function(param, index) {
      const dataRow = index + 2; // +2 because headers are in row 1
      newRange.getRange(dataRow, 1).setValue(param.name);
      newRange.getRange(dataRow, 2).setValue(param.value);
    });
    
    // Style parameter rows
    const dataRange = newRange.getRange(2, 1, numParams, 2);
    dataRange.setBorder(true, true, true, true, true, true);
  }
}

/**
 * Run standard analytics on a graph
 */
function runAnalyticsOnGraph(cell, graphId, operation) {
  try {
    var historySheet = getOrCreateHistorySheet();
    var graphData = getLatestGraphData(historySheet, graphId);
    var scenarioData = getCurrentScenarioData(cell, graphId);
    
    // Run the analytics
    var result = runGraphAnalytics(graphData, scenarioData, operation);
    
    // Output the result
    outputAnalyticsResult(cell, operation, result);
    
  } catch (e) {
    console.log('Error running analytics:', e);
    SpreadsheetApp.getUi().alert('Error running analytics: ' + e.message);
  }
}

/**
 * Run custom analytics on a graph
 */
function runCustomAnalyticsOnGraph(cell, graphId) {
  try {
    var historySheet = getOrCreateHistorySheet();
    var graphData = getLatestGraphData(historySheet, graphId);
    var scenarioData = getCurrentScenarioData(cell, graphId);
    
    // Show custom analytics dialog
    showCustomAnalyticsDialog(graphData, scenarioData);
    
  } catch (e) {
    console.log('Error running custom analytics:', e);
    SpreadsheetApp.getUi().alert('Error running custom analytics: ' + e.message);
  }
}

/**
 * Get current scenario data from parameter table
 */
function getCurrentScenarioData(cell, graphId) {
  try {
    var namedRangeName = getNamedRangeFromGraphCell(cell);
    if (!namedRangeName) {
      return {};
    }
    
    var sheet = cell.getSheet();
    var spreadsheet = sheet.getParent();
    var namedRange = spreadsheet.getRangeByName(namedRangeName);
    
    if (!namedRange) {
      return {};
    }
    
    var range = namedRange.getRange();
    var params = {};
    
    // Get parameter values from Default column (column 2)
    for (var i = 2; i <= range.getNumRows(); i++) {
      var paramName = range.getRange(i, 1).getValue();
      var paramValue = range.getRange(i, 2).getValue();
      if (paramName && paramValue !== '') {
        params[paramName] = paramValue;
      }
    }
    
    return params;
  } catch (e) {
    console.log('Error getting scenario data:', e);
    return {};
  }
}

/**
 * Run graph analytics with given parameters
 */
function runGraphAnalytics(graphData, scenarioData, operation) {
  // This is a placeholder for the actual analytics engine
  // In a real implementation, this would:
  // 1. Parse the graph structure
  // 2. Apply parameter values
  // 3. Run the specified operation
  // 4. Return the result
  
  var result = {
    operation: operation,
    value: '0.85', // Placeholder result
    formula: '=ANALYTICS("' + operation + '", ' + JSON.stringify(scenarioData) + ')',
    timestamp: new Date().toISOString()
  };
  
  return result;
}

/**
 * Output analytics result to user
 */
function outputAnalyticsResult(cell, operation, result) {
  try {
    var sheet = cell.getSheet();
    var activeRange = sheet.getActiveRange();
    
    // Create results table below the current selection
    var startRow = activeRange.getRow() + 1;
    var startCol = activeRange.getColumn();
    
    var resultsRange = sheet.getRange(startRow, startCol, 4, 2);
    resultsRange.clearContent();
    
    // Add results
    resultsRange.getRange(1, 1).setValue('Analytics Result');
    resultsRange.getRange(1, 2).setValue(result.value);
    
    resultsRange.getRange(2, 1).setValue('Operation');
    resultsRange.getRange(2, 2).setValue(operation);
    
    resultsRange.getRange(3, 1).setValue('Formula');
    resultsRange.getRange(3, 2).setValue(result.formula);
    
    resultsRange.getRange(4, 1).setValue('Timestamp');
    resultsRange.getRange(4, 2).setValue(result.timestamp);
    
    // Style the results
    var headerRange = resultsRange.getRange(1, 1, 1, 2);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#e8f4fd');
    headerRange.setBorder(true, true, true, true, true, true);
    
    var dataRange = resultsRange.getRange(2, 1, 3, 2);
    dataRange.setBorder(true, true, true, true, true, true);
    
    // Copy formula to clipboard
    copyToClipboard(result.formula);
    
    SpreadsheetApp.getUi().alert('✅ Analytics completed!\n\nResult: ' + result.value + '\n\nFormula copied to clipboard: ' + result.formula);
    
  } catch (e) {
    console.log('Error outputting analytics result:', e);
    SpreadsheetApp.getUi().alert('Error outputting results: ' + e.message);
  }
}

/**
 * Show custom analytics dialog
 */
function showCustomAnalyticsDialog(graphData, scenarioData) {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('Custom Analytics', 'Enter custom operation (e.g., "probability", "cost", "time"):', ui.ButtonSet.OK_CANCEL);
  
  if (response.getSelectedButton() === ui.Button.OK) {
    var operation = response.getResponseText();
    if (operation) {
      var result = runGraphAnalytics(graphData, scenarioData, operation);
      outputAnalyticsResult(SpreadsheetApp.getActiveSheet().getActiveRange(), operation, result);
    }
  }
}

/**
 * Copy text to clipboard (placeholder - Apps Script doesn't have direct clipboard access)
 */
function copyToClipboard(text) {
  // Note: Apps Script doesn't have direct clipboard access
  // This would need to be implemented via a web app or browser extension
  console.log('Formula to copy: ' + text);
}

// ===== ANALYTICS FUNCTIONS =====
// Functions for running analytics on graphs as inline formulas

/**
 * Main analytics function - called like Excel formula
 * =GraphCalc(A1, ANY_SUCCESS, PROBABILITY)  // Auto start node
 * =GraphCalc(A1, "start", ANY_SUCCESS, PROBABILITY)  // Explicit start node
 * =GraphCalc(A1, , ANY_SUCCESS, PROBABILITY)  // Skip start node (auto-detect)
 * =GraphCalc(A1, B2, ANY_SUCCESS, PROBABILITY)  // Start node from cell B2
 * 
 * @param {string} cellRefOrGraphId - Cell reference (e.g., "A1") or graph ID (e.g., "graph_123")
 * @param {string} startNode - Starting node (optional, empty string or null for auto-detect)
 * @param {string} endNode - Ending node
 * @param {string} operation - Analysis operation (PROBABILITY, COST, TIME)
 * @param {string} scenario - Optional scenario name (DEFAULT_SCENARIO, "Scenario 2", etc.)
 * @param {object} customParams - Optional custom parameters object
 * @return {number} The calculated result
 * @customfunction
 */
function GraphCalc(cellRefOrGraphId, startNode, endNode, operation, scenario, customParams) {
  try {
    // Handle Excel-style missing parameters (empty strings, null, undefined)
    if (!startNode || startNode === '' || startNode === null || startNode === undefined) {
      startNode = null; // Will auto-detect first/entry node
    }
    
    if (!scenario || scenario === '' || scenario === null || scenario === undefined) {
      scenario = null; // Will use default scenario
    }
    
    if (!customParams || customParams === '' || customParams === null || customParams === undefined) {
      customParams = null; // Will use scenario parameters
    }
    
    // DEBUG: Log function call
    console.log('GraphCalc called with:', {
      cellRefOrGraphId: cellRefOrGraphId,
      startNode: startNode,
      endNode: endNode,
      operation: operation,
      scenario: scenario,
      customParams: customParams,
      argumentCount: arguments.length
    });
    
    var graphId;
    var graphData;
    
    // Smart detection: graph:// protocol, cell ref, graph ID, or JSON blob
    
    // Check if input is graph:// protocol
    if (typeof cellRefOrGraphId === 'string' && cellRefOrGraphId.startsWith('graph://')) {
      graphId = cellRefOrGraphId.replace('graph://', '').split('?')[0];
      console.log('Direct graph:// protocol, ID:', graphId);
    }
    // Check if input is a cell reference
    else if (typeof cellRefOrGraphId === 'string' && cellRefOrGraphId.match(/^[A-Z]+\d+$/)) {
      // It's a cell reference like "A1", "B5", etc.
      var sheet = SpreadsheetApp.getActiveSheet();
      var cell = sheet.getRange(cellRefOrGraphId);
      var cellValue = cell.getValue();
      
      console.log('Cell value:', cellValue);
      
      // Check if cell contains graph:// protocol
      if (cellValue && cellValue.toString().startsWith('graph://')) {
        graphId = cellValue.toString().replace('graph://', '').split('?')[0];
        console.log('Cell contains graph:// protocol, ID:', graphId);
      } 
      else if (!cellValue || cellValue === '') {
        return "Error: Cell is empty";
      }
      else {
        // Regular cell - check if it's a graph ID or JSON
        console.log('Regular cell value:', cellValue);
        
        // Check if cell content is a valid graph ID
        var historySheet = getOrCreateHistorySheet();
        var testGraphData = getLatestGraphData(historySheet, cellValue);
        if (testGraphData) {
          // It's a valid graph ID
          graphId = cellValue;
          console.log('Cell contains valid graph ID:', graphId);
        } else {
          // Treat as JSON blob
          try {
            graphData = JSON.parse(cellValue);
            console.log('Cell contains JSON blob, parsing directly');
          } catch (e) {
            console.log('JSON parse error:', e);
            return "Error: Cell content is neither a graph ID nor valid JSON";
          }
        }
      }
    }
    // Direct string input (not a cell reference)
    else {
      // It's a string - check if it's a graph ID or JSON
      var historySheet = getOrCreateHistorySheet();
      var testGraphData = getLatestGraphData(historySheet, cellRefOrGraphId);
      if (testGraphData) {
        // It's a valid graph ID
        graphId = cellRefOrGraphId;
        console.log('String is valid graph ID:', graphId);
      } else {
        // Try to parse as JSON
        try {
          graphData = JSON.parse(cellRefOrGraphId);
          console.log('String is JSON blob, parsing directly');
        } catch (e) {
          return "Error: Input is neither a valid graph ID nor valid JSON";
        }
      }
    }
    
    // Get graph data - either from History sheet or from JSON parsing
    if (!graphData) {
      console.log('Looking up graph data for ID:', graphId);
      var historySheet = getOrCreateHistorySheet();
      graphData = getLatestGraphData(historySheet, graphId);
      
      if (!graphData) {
        console.log('Graph not found for ID:', graphId);
        return "DEBUG: Graph not found for ID: " + graphId;
      }
      console.log('Graph data found in history:', graphData);
    } else {
      console.log('Using provided graph data:', graphData);
    }
    
    console.log('Graph data found:', {
      nodes: graphData.nodes ? graphData.nodes.length : 0,
      edges: graphData.edges ? graphData.edges.length : 0
    });
    
    // If no start node provided, find the first node (entry node or first in list)
    if (!startNode) {
      if (graphData.nodes && graphData.nodes.length > 0) {
        // Look for entry node first
        var entryNode = graphData.nodes.find(function(node) {
          return node.entry && node.entry.is_start;
        });
        
        if (entryNode) {
          startNode = entryNode.slug || entryNode.id;
        } else {
          // Fall back to first node
          startNode = graphData.nodes[0].slug || graphData.nodes[0].id;
        }
        
        console.log('Auto-selected start node:', startNode);
      } else {
        return "Error: No nodes found in graph";
      }
    }
    
    // Get parameter values based on scenario or custom params
    var scenarioData;
    if (customParams && typeof customParams === 'object') {
      // Use custom parameters provided directly
      scenarioData = customParams;
      console.log('Using custom parameters:', scenarioData);
    } else {
      // Use scenario from parameter table (defaults to "Default" if not specified)
      scenarioData = getScenarioData(graphId, scenario || "Default");
      console.log('Using scenario data:', scenarioData);
    }
    
    var result = runGraphAnalytics(graphData, scenarioData, operation, startNode, endNode);
    console.log('Analytics result:', result);
    return result;
    
  } catch (e) {
    console.log('GraphCalc error:', e);
    return "Error: " + e.message;
  }
}

/**
 * Get current scenario data for a graph
 */
function getCurrentScenarioData(graphId) {
  try {
    var sheet = SpreadsheetApp.getActiveSheet();
    var graphCell = findGraphCellByGraphId(sheet, graphId);
    
    if (!graphCell) {
      return {};
    }
    
    var namedRangeName = getNamedRangeFromGraphCell(graphCell);
    if (!namedRangeName) {
      return {};
    }
    
    var spreadsheet = sheet.getParent();
    var namedRange = spreadsheet.getRangeByName(namedRangeName);
    
    if (!namedRange) {
      return {};
    }
    
    var range = namedRange.getRange();
    var params = {};
    
    // Get parameter values from Default column (column 2)
    for (var i = 2; i <= range.getNumRows(); i++) {
      var paramName = range.getRange(i, 1).getValue();
      var paramValue = range.getRange(i, 2).getValue();
      if (paramName && paramValue !== '') {
        params[paramName] = paramValue;
      }
    }
    
    return params;
  } catch (e) {
    console.log('Error getting scenario data:', e);
    return {};
  }
}

/**
 * Get scenario data for a specific graph and scenario
 */
function getScenarioData(graphId, scenarioName) {
  try {
    var sheet = SpreadsheetApp.getActiveSheet();
    var graphCell = findGraphCellByGraphId(sheet, graphId);
    
    if (!graphCell) {
      return {};
    }
    
    var namedRangeName = getNamedRangeFromGraphCell(graphCell);
    if (!namedRangeName) {
      return {};
    }
    
    var spreadsheet = sheet.getParent();
    var namedRange = spreadsheet.getRangeByName(namedRangeName);
    
    if (!namedRange) {
      return {};
    }
    
    var range = namedRange.getRange();
    var paramData = range.getValues();
    
    if (paramData.length < 2) {
      return {}; // No parameters
    }
    
    // Find the scenario column
    var headerRow = paramData[0];
    var scenarioColIndex = -1;
    
    for (var i = 0; i < headerRow.length; i++) {
      if (headerRow[i] === scenarioName) {
        scenarioColIndex = i;
        break;
      }
    }
    
    if (scenarioColIndex === -1) {
      // Scenario not found, try "Default"
      for (var i = 0; i < headerRow.length; i++) {
        if (headerRow[i] === "Default") {
          scenarioColIndex = i;
          break;
        }
      }
    }
    
    if (scenarioColIndex === -1) {
      return {}; // No valid scenario found
    }
    
    // Extract parameter values for this scenario
    var scenarioData = {};
    for (var i = 1; i < paramData.length; i++) {
      var paramName = paramData[i][0]; // Parameter name in first column
      var paramValue = paramData[i][scenarioColIndex]; // Value in scenario column
      
      if (paramName && paramValue !== "") {
        scenarioData[paramName] = paramValue;
      }
    }
    
    return scenarioData;
  } catch (e) {
    console.log('Error getting scenario data:', e);
    return {};
  }
}

/**
 * Find graph cell by graph ID
 */
function findGraphCellByGraphId(sheet, graphId) {
  try {
    var dataRange = sheet.getDataRange();
    var notes = dataRange.getNotes();
    
    for (var i = 0; i < notes.length; i++) {
      for (var j = 0; j < notes[i].length; j++) {
        var note = notes[i][j];
        if (note && note.includes('DAGNET_GRAPH:' + graphId)) {
          return sheet.getRange(i + 1, j + 1);
        }
      }
    }
    return null;
  } catch (e) {
    console.log('Error finding graph cell:', e);
    return null;
  }
}

/**
 * Run the actual analytics calculation
 */
function runGraphAnalytics(graphData, scenarioData, operation, startNode, endNode) {
  try {
    // Apply parameter values to graph
    var graphWithParams = applyParametersToGraph(graphData, scenarioData);
    
    // Run the specified operation
    switch (operation.toLowerCase()) {
      case 'probability':
        return calculateProbability(graphWithParams, startNode, endNode);
      case 'cost':
        return calculateCost(graphWithParams, startNode, endNode);
      case 'time':
        return calculateTime(graphWithParams, startNode, endNode);
      default:
        return "Unknown operation: " + operation;
    }
  } catch (e) {
    return "Error in analytics: " + e.message;
  }
}

/**
 * Apply parameter values to graph
 */
function applyParametersToGraph(graphData, scenarioData) {
  try {
    // Create a copy of the graph data
    var graphWithParams = JSON.parse(JSON.stringify(graphData));
    
    // Apply parameters to nodes
    if (graphWithParams.nodes) {
      graphWithParams.nodes.forEach(function(node, nodeIndex) {
        // Apply entry_weight parameter
        var entryWeightParam = node.slug + '.entry_weight';
        if (scenarioData[entryWeightParam] !== undefined && node.entry) {
          node.entry.entry_weight = scenarioData[entryWeightParam];
        }
        
        // Apply node costs
        if (node.costs) {
          for (var costType in node.costs) {
            var costParam = node.slug + '.costs.' + costType;
            if (scenarioData[costParam] !== undefined) {
              node.costs[costType] = scenarioData[costParam];
            }
          }
        }
      });
    }
    
    // Apply parameters to edges
    if (graphWithParams.edges) {
      graphWithParams.edges.forEach(function(edge, edgeIndex) {
        // Apply probability parameters
        var probParam = 'edge_' + edgeIndex + '.p.mean';
        if (scenarioData[probParam] !== undefined) {
          if (!edge.p) edge.p = {};
          edge.p.mean = scenarioData[probParam];
        }
        
        // Apply cost parameters
        if (edge.costs) {
          for (var costType in edge.costs) {
            var costParam = 'edge_' + edgeIndex + '.costs.' + costType;
            if (scenarioData[costParam] !== undefined) {
              edge.costs[costType] = scenarioData[costParam];
            }
          }
        }
      });
    }
    
    return graphWithParams;
  } catch (e) {
    console.log('Error applying parameters:', e);
    return graphData;
  }
}

/**
 * Calculate probability from start to end
 */
function calculateProbability(graphData, startNode, endNode) {
  try {
    // DEBUG: Log the graph data and parameters
    console.log('calculateProbability called with:', {
      startNode: startNode,
      endNode: endNode,
      nodes: graphData.nodes ? graphData.nodes.length : 0,
      edges: graphData.edges ? graphData.edges.length : 0
    });
    
    // Find all paths from startNode to endNode and calculate total probability
    var totalProbability = 0;
    var visited = {};
    
    function findPaths(currentNode, currentProbability, path) {
      if (visited[currentNode]) return; // Avoid cycles
      visited[currentNode] = true;
      
      // If we reached the end node, add to total probability
      if (currentNode === endNode) {
        totalProbability += currentProbability;
        return;
      }
      
      // Find all outgoing edges from current node
      var outgoingEdges = graphData.edges.filter(function(edge) {
        return edge.from === currentNode;
      });
      
      // If no outgoing edges and not at end node, this path leads nowhere
      if (outgoingEdges.length === 0) {
        return;
      }
      
      // Follow each outgoing edge
      outgoingEdges.forEach(function(edge) {
        var edgeProbability = edge.p ? edge.p.mean : 0;
        var newProbability = currentProbability * edgeProbability;
        var newPath = path.concat([edge.to]);
        
        // Recursively explore from the target node
        findPaths(edge.to, newProbability, newPath);
      });
      
      visited[currentNode] = false; // Reset for other paths
    }
    
    // Handle special cases for endNode
    if (endNode === 'anySuccess') {
      // Find all success nodes and calculate probability to each
      var successNodes = graphData.nodes.filter(function(node) {
        return node.outcome_type === 'success';
      });
      
      successNodes.forEach(function(successNode) {
        findPaths(startNode, 1, [startNode]);
      });
    } else if (endNode === 'anyFailure') {
      // Find all failure nodes and calculate probability to each
      var failureNodes = graphData.nodes.filter(function(node) {
        return node.outcome_type === 'failure';
      });
      
      failureNodes.forEach(function(failureNode) {
        findPaths(startNode, 1, [startNode]);
      });
    } else {
      // Specific end node
      findPaths(startNode, 1, [startNode]);
    }
    
    return totalProbability;
  } catch (e) {
    return "Error calculating probability: " + e.message;
  }
}

/**
 * Calculate cost from start to end
 */
function calculateCost(graphData, startNode, endNode) {
  try {
    var totalCost = 0;
    var totalProbability = 0;
    var visited = {};
    
    function findPathsWithCost(currentNode, currentProbability, currentCost, path) {
      if (visited[currentNode]) return; // Avoid cycles
      visited[currentNode] = true;
      
      // If we reached the end node, add weighted cost
      if (currentNode === endNode) {
        totalCost += currentCost * currentProbability;
        totalProbability += currentProbability;
        return;
      }
      
      // Find all outgoing edges from current node
      var outgoingEdges = graphData.edges.filter(function(edge) {
        return edge.from === currentNode;
      });
      
      // If no outgoing edges and not at end node, this path leads nowhere
      if (outgoingEdges.length === 0) {
        return;
      }
      
      // Follow each outgoing edge
      outgoingEdges.forEach(function(edge) {
        var edgeProbability = edge.p ? edge.p.mean : 0;
        var edgeCost = edge.costs ? (edge.costs.monetary || 0) : 0;
        var newProbability = currentProbability * edgeProbability;
        var newCost = currentCost + edgeCost;
        var newPath = path.concat([edge.to]);
        
        // Recursively explore from the target node
        findPathsWithCost(edge.to, newProbability, newCost, newPath);
      });
      
      visited[currentNode] = false; // Reset for other paths
    }
    
    // Handle special cases for endNode
    if (endNode === 'anySuccess') {
      var successNodes = graphData.nodes.filter(function(node) {
        return node.outcome_type === 'success';
      });
      
      successNodes.forEach(function(successNode) {
        findPathsWithCost(startNode, 1, 0, [startNode]);
      });
    } else if (endNode === 'anyFailure') {
      var failureNodes = graphData.nodes.filter(function(node) {
        return node.outcome_type === 'failure';
      });
      
      failureNodes.forEach(function(failureNode) {
        findPathsWithCost(startNode, 1, 0, [startNode]);
      });
    } else {
      findPathsWithCost(startNode, 1, 0, [startNode]);
    }
    
    // Return weighted average cost
    return totalProbability > 0 ? totalCost / totalProbability : 0;
  } catch (e) {
    return "Error calculating cost: " + e.message;
  }
}

/**
 * Calculate time from start to end
 */
function calculateTime(graphData, startNode, endNode) {
  try {
    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Parse the graph structure
    // 2. Find all paths from startNode to endNode
    // 3. Calculate time for each path
    // 4. Return minimum time or expected time
    
    // For now, return a placeholder value
    return 45.0;
  } catch (e) {
    return "Error calculating time: " + e.message;
  }
}

/**
 * Update parameter table with intelligent scenario management
 */
function updateParameterTableWithScenarios(namedRange, newParams) {
  try {
    var sheet = namedRange.getSheet();
    var currentRange = namedRange.getRange();
    var currentRows = currentRange.getNumRows();
    var currentCols = currentRange.getNumColumns();
    var startRow = currentRange.getRow();
    var startCol = currentRange.getColumn();
    
    // Get current parameter names and values
    var currentParams = {};
    for (var i = 2; i <= currentRows; i++) {
      var paramName = currentRange.getRange(i, 1).getValue();
      if (paramName) {
        currentParams[paramName] = {
          row: i,
          values: {}
        };
        // Get values from all scenarios
        for (var j = 2; j <= currentCols; j++) {
          var scenarioName = currentRange.getRange(1, j).getValue();
          var value = currentRange.getRange(i, j).getValue();
          currentParams[paramName].values[scenarioName] = value;
        }
      }
    }
    
    // Calculate new dimensions
    var newParamCount = newParams.length;
    var newRows = Math.max(newParamCount + 1, 2); // +1 for header, minimum 2 rows
    var newCols = Math.max(currentCols, 2); // Keep existing scenarios, minimum 2 columns
    
    // Create new range
    var newRange = sheet.getRange(startRow, startCol, newRows, newCols);
    
    // Remove old named range and create new one
    var namedRanges = spreadsheet.getNamedRanges();
    for (var i = 0; i < namedRanges.length; i++) {
      if (namedRanges[i].getName() === namedRangeName) {
        namedRanges[i].remove();
        break;
      }
    }
    spreadsheet.setNamedRange(namedRangeName, newRange);
    
    // Clear and rebuild the table
    newRange.clearContent();
    
    if (newParamCount === 0) {
      // No parameters found
      newRange.getRange(1, 1).setValue('No parameters found');
      newRange.getRange(1, 1).setBackground('#f0f0f0');
    } else {
      // Add headers
      newRange.getRange(1, 1).setValue('Parameter Name');
      newRange.getRange(1, 2).setValue('Default');
      
      // Add scenario headers for existing scenarios
      for (var j = 3; j <= newCols; j++) {
        var scenarioName = 'Scenario ' + (j - 1);
        newRange.getRange(1, j).setValue(scenarioName);
      }
      
      // Style headers
      var headerRange = newRange.getRange(1, 1, 1, newCols);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#e8f4fd');
      headerRange.setBorder(true, true, true, true, true, true);
      
      // Add parameter data
      newParams.forEach(function(param, index) {
        var dataRow = index + 2; // +2 because headers are in row 1
        newRange.getRange(dataRow, 1).setValue(param.name);
        
        // Set Default column value (new or updated)
        newRange.getRange(dataRow, 2).setValue(param.value);
        
        // Handle existing scenarios
        if (currentParams[param.name]) {
          // Parameter exists - preserve scenario values
          for (var j = 3; j <= newCols; j++) {
            var scenarioName = 'Scenario ' + (j - 1);
            var existingValue = currentParams[param.name].values[scenarioName];
            if (existingValue !== undefined) {
              newRange.getRange(dataRow, j).setValue(existingValue);
            } else {
              // New scenario - copy from Default
              newRange.getRange(dataRow, j).setValue(param.value);
            }
          }
        } else {
          // New parameter - copy Default value to all scenarios
          for (var j = 3; j <= newCols; j++) {
            newRange.getRange(dataRow, j).setValue(param.value);
          }
        }
      });
      
      // Add rows for removed parameters (marked as deleted)
      var removedParams = [];
      for (var paramName in currentParams) {
        var stillExists = newParams.some(function(p) { return p.name === paramName; });
        if (!stillExists) {
          removedParams.push(paramName);
        }
      }
      
      if (removedParams.length > 0) {
        var startRow = newParamCount + 2;
        removedParams.forEach(function(paramName, index) {
          var dataRow = startRow + index;
          newRange.getRange(dataRow, 1).setValue(paramName + ' (REMOVED)');
          newRange.getRange(dataRow, 1).setFontStyle('italic');
          newRange.getRange(dataRow, 1).setBackground('#ffebee');
          
          // Show values from all scenarios
          for (var j = 2; j <= newCols; j++) {
            var value = currentParams[paramName].values[newRange.getRange(1, j).getValue()];
            if (value !== undefined) {
              newRange.getRange(dataRow, j).setValue(value);
              newRange.getRange(dataRow, j).setFontStyle('italic');
              newRange.getRange(dataRow, j).setBackground('#ffebee');
            }
          }
        });
      }
      
      // Style all data rows
      var totalRows = newParamCount + removedParams.length;
      var dataRange = newRange.getRange(2, 1, totalRows, newCols);
      dataRange.setBorder(true, true, true, true, true, true);
    }
    
  } catch (e) {
    console.log('Error updating parameter table with scenarios:', e);
    SpreadsheetApp.getUi().alert('Error updating parameter table: ' + e.message);
  }
}

/**
 * Get named range name from graph cell notes
 */
function getNamedRangeFromGraphCell(cell) {
  try {
    var note = cell.getNote();
    if (note && note.includes('|NAMED_RANGE:')) {
      var parts = note.split('|NAMED_RANGE:');
      if (parts.length > 1) {
        return parts[1];
      }
    }
    return null;
  } catch (e) {
    console.log('Error getting named range from graph cell:', e);
    return null;
  }
}

/**
 * Find graph info from a cell that might be within a named range
 */
function findGraphFromNamedRange(cell) {
  try {
    var sheet = cell.getSheet();
    var spreadsheet = sheet.getParent();
    var cellA1 = cell.getA1Notation();
    
    // Get all named ranges
    var namedRanges = spreadsheet.getNamedRanges();
    
    for (var i = 0; i < namedRanges.length; i++) {
      var namedRange = namedRanges[i];
      var range = namedRange.getRange();
      
      // Check if the selected cell is within this named range
      if (range.getSheet().getName() === sheet.getName()) {
        var rangeA1 = range.getA1Notation();
        var rangeStart = range.getRow();
        var rangeEnd = rangeStart + range.getNumRows() - 1;
        var rangeColStart = range.getColumn();
        var rangeColEnd = rangeColStart + range.getNumColumns() - 1;
        
        var cellRow = cell.getRow();
        var cellCol = cell.getColumn();
        
        if (cellRow >= rangeStart && cellRow <= rangeEnd && 
            cellCol >= rangeColStart && cellCol <= rangeColEnd) {
          
          // This cell is within the named range
          // Now find the graph cell that references this named range
          var graphCell = findGraphCellByNamedRange(sheet, namedRange.getName());
          if (graphCell) {
            return {
              cell: graphCell,
              note: graphCell.getNote(),
              namedRange: namedRange.getName()
            };
          }
        }
      }
    }
    
    return null;
  } catch (e) {
    console.log('Error finding graph from named range:', e);
    return null;
  }
}

/**
 * Find graph cell that references a specific named range
 */
function findGraphCellByNamedRange(sheet, namedRangeName) {
  try {
    var range = sheet.getDataRange();
    var values = range.getValues();
    
    // Extract graph ID from named range name (format: GraphParams_graph_xxxxx)
    var graphIdMatch = namedRangeName.match(/GraphParams_(graph_\w+)/);
    if (!graphIdMatch) {
      return null;
    }
    var targetGraphId = graphIdMatch[1];
    
    // Search for cell with matching graph:// protocol
    for (var i = 0; i < values.length; i++) {
      for (var j = 0; j < values[i].length; j++) {
        var cellValue = values[i][j];
        if (cellValue && cellValue.toString().startsWith('graph://')) {
          var graphId = cellValue.toString().replace('graph://', '').split('?')[0];
          if (graphId === targetGraphId) {
            return sheet.getRange(i + 1, j + 1);
          }
        }
      }
    }
    
    return null;
  } catch (e) {
    console.log('Error finding graph cell by named range:', e);
    return null;
  }
}

/**
 * Show history for a specific graph
 */
function showHistoryForGraph(graphId) {
  const historySheet = getOrCreateHistorySheet();
  const data = historySheet.getDataRange().getValues();
  const graphHistory = [];
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][4] === graphId) { // Column E (Graph ID)
      graphHistory.push({
        timestamp: data[i][0],
        user: data[i][1], 
        narrative: data[i][2]
      });
    }
  }
  
  if (graphHistory.length === 0) {
    SpreadsheetApp.getUi().alert('No history found for graph: ' + graphId);
    return;
  }
  
  let historyText = 'History for ' + graphId + ':\n\n';
  graphHistory.forEach(function(entry, index) {
    historyText += (index + 1) + '. ' + entry.timestamp + ' - ' + entry.user + '\n';
    historyText += '   ' + entry.narrative + '\n\n';
  });
  
  SpreadsheetApp.getUi().alert(historyText);
}

/**
 * Web app GET endpoint for simple roundtrip tests.
 * Expects: sessionId, sheetId, outputCell, graphData
 */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    
    // Health check - just return success without touching any data
    if (p.healthcheck) {
      return ContentService.createTextOutput(JSON.stringify({ success: true, message: 'Health check OK' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    var sheetId = p.sheetId;
    var outputCell = p.outputCell;
    var graphData = p.graphData;
    if (!sheetId || !outputCell || !graphData) {
			return ContentService.createTextOutput(JSON.stringify({ success:false, error:'Missing parameters', received:p }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var sheet = SpreadsheetApp.openById(sheetId).getActiveSheet();
    var cell = sheet.getRange(outputCell);
    var jsonString = typeof graphData === 'string' ? graphData : JSON.stringify(graphData);
    try { jsonString = JSON.stringify(JSON.parse(jsonString), null, 2); } catch (ignore) {}
    
    // Store in history and create pointer (same as doPost)
    var historySheet = getOrCreateHistorySheet();
    var narrative = 'Graph updated via Dagnet (GET)';
    
    // Extract narrative from graph metadata if available
    try {
      var graph = JSON.parse(jsonString);
      if (graph.metadata && graph.metadata.narrative) {
        narrative = graph.metadata.narrative;
      }
    } catch (e) {}
    
    // Add to history
    var newGraphId = addHistoryEntry(historySheet, null, JSON.parse(jsonString), narrative);
    
    // Update cell to use graph:// protocol
    cell.setValue('graph://' + newGraphId);
		return ContentService.createTextOutput(JSON.stringify({ success:true, message:'Cell updated via GET', received:p }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success:false, error:String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
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
    var graphId = body.graphId;

    if (!sheetId || !outputCell || !graphData) {
			return ContentService.createTextOutput(JSON.stringify({ success:false, error:'Missing fields', received:body }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var sheet = SpreadsheetApp.openById(sheetId).getActiveSheet();
    var cell = sheet.getRange(outputCell);
    var jsonString = typeof graphData === 'string' ? graphData : JSON.stringify(graphData);
    try { jsonString = JSON.stringify(JSON.parse(jsonString), null, 2); } catch (ignore) {}
    
    // ALWAYS store in history and create/update pointer
    var historySheet = getOrCreateHistorySheet();
    var narrative = 'Graph updated via Dagnet';
    
    // Extract narrative from graph metadata if available
    try {
      var graph = JSON.parse(jsonString);
      if (graph.metadata && graph.metadata.narrative) {
        narrative = graph.metadata.narrative;
      }
    } catch (e) {}
    
    // Add to history
    var newGraphId = addHistoryEntry(historySheet, graphId, JSON.parse(jsonString), narrative);
    
    // Update cell to use graph:// protocol
    cell.setValue('graph://' + newGraphId);
    
    // Update named range if it exists
    try {
      var params = extractNamedParameters(JSON.parse(jsonString));
      var namedRangeName = getNamedRangeFromGraphCell(cell);
      if (namedRangeName) {
        var namedRange = sheet.getParent().getRangeByName(namedRangeName);
        if (namedRange) {
          // Update existing named range with intelligent parameter management
          updateParameterTableWithScenarios(namedRange, params);
        }
      }
    } catch (parseErr) {
      console.log('Could not update named range:', parseErr);
    }

		return ContentService.createTextOutput(JSON.stringify({ success:true, received:body }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success:false, error: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Extract named parameters from graph data
 */
function extractNamedParameters(graph) {
  var params = [];
  if (!graph) return params;
  
  // Extract from nodes
  if (graph.nodes) {
    graph.nodes.forEach(function(node, idx) {
      // Extract entry_weight
      if (node.entry && node.entry.entry_weight !== undefined) {
        params.push({ name: node.slug + '.entry_weight', value: node.entry.entry_weight });
      }
    });
  }
  
  // Extract from edges
  if (graph.edges) {
    graph.edges.forEach(function(edge, idx) {
      var edgeLabel = 'edge_' + idx;
      
      // Extract p.mean (probability)
      if (edge.p && edge.p.mean !== undefined) {
        params.push({ name: edgeLabel + '.p.mean', value: edge.p.mean });
      }
      
      // Extract costs
      if (edge.costs) {
        Object.keys(edge.costs).forEach(function(costType) {
          params.push({ name: edgeLabel + '.costs.' + costType, value: edge.costs[costType] });
        });
      }
    });
  }
  
  return params;
}

/**
 * Display parameters in cells below the source cell
 */
function displayParameters(sheet, sourceCell, params) {
  try {
    // Get the row and column of the source cell
    var sourceRange = sheet.getRange(sourceCell);
    var sourceRow = sourceRange.getRow();
    var sourceCol = sourceRange.getColumn();
    
    // Clear existing parameter data (2 columns, 20 rows max)
    var clearRange = sheet.getRange(sourceRow + 1, sourceCol, 20, 2);
    clearRange.clearContent();
    
    if (params.length === 0) {
      // No parameters found
      sheet.getRange(sourceRow + 1, sourceCol).setValue('No named parameters found');
      return;
    }
    
    // Write parameter names in first column, values in second column
    params.forEach(function(param, index) {
      var nameCell = sheet.getRange(sourceRow + 1 + index, sourceCol);
      var valueCell = sheet.getRange(sourceRow + 1 + index, sourceCol + 1);
      
      nameCell.setValue(param.name);
      valueCell.setValue(param.value);
    });
    
    // Add headers
    sheet.getRange(sourceRow + 1, sourceCol).setValue('Parameter Name');
    sheet.getRange(sourceRow + 1, sourceCol + 1).setValue('Parameter Value');
    
    // Style the headers
    var headerRange = sheet.getRange(sourceRow + 1, sourceCol, 1, 2);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#f0f0f0');
    
  } catch (err) {
    console.log('Error displaying parameters:', err);
  }
}

/**
 * Current deployment URL for this script. Requires one manual deployment ever.
 */
function getCurrentWebAppUrl() {
  // Check stored URL first (workaround for broken getService().getUrl() on Workspace domains)
  try {
    var stored = PropertiesService.getScriptProperties().getProperty('DAGNET_WEB_APP_URL');
    if (stored) return stored;
  } catch (e) {}
  
  // Fallback to getService (unreliable on Workspace)
  try {
    var url = ScriptApp.getService().getUrl();
    return normalizeWebAppUrl(url);
  } catch (e) {
    return null;
  }
}

/**
 * Set the web app URL manually (run once after deployment)
 * Usage: setWebAppUrl('https://script.google.com/macros/s/AKfycbx00UMe.../exec')
 */
function setWebAppUrl(url) {
  PropertiesService.getScriptProperties().setProperty('DAGNET_WEB_APP_URL', url);
  SpreadsheetApp.getUi().alert('Stored web app URL: ' + url + '\n\nRun Initialize to verify.');
}

function normalizeWebAppUrl(url) {
  if (!url) return null;
  var m = url.match(/^https:\/\/script\.google\.com\/a\/[^/]+\/macros\/s\/([^/]+)\/exec$/);
  return m ? ('https://script.google.com/macros/s/' + m[1] + '/exec') : url;
}

/**
 * Test function to manually show sidebar
 */
function testSidebar() {
  console.log('testSidebar: Starting...');
  try {
    showSimpleSidebar();
    console.log('testSidebar: Completed successfully');
  } catch (e) {
    console.log('testSidebar error:', e);
    SpreadsheetApp.getUi().alert('Error in testSidebar: ' + e.message);
  }
}

/**
 * Force refresh the menu - run this if new menu items don't appear
 */
function forceMenuRefresh() {
  try {
    // Clear existing menu
    SpreadsheetApp.getUi().createMenu('Dagnet').addToUi();
    
    // Wait a moment
    Utilities.sleep(1000);
    
    // Recreate the full menu
    onOpen();
    
    SpreadsheetApp.getUi().alert('Menu refreshed! Check the Dagnet menu now.');
  } catch (e) {
    SpreadsheetApp.getUi().alert('Error refreshing menu: ' + e.message);
  }
}

/**
 * NUCLEAR OPTION: Force complete cache clear
 */
function nuclearCacheClear() {
  try {
    // Show version to prove we're running latest
    SpreadsheetApp.getUi().alert('NUCLEAR CACHE CLEAR\n\nScript Version: ' + SCRIPT_VERSION + '\n\nThis should show the latest code!');
    
    // Clear all properties
    PropertiesService.getScriptProperties().deleteAll();
    PropertiesService.getUserProperties().deleteAll();
    
    // Force menu recreation
    forceMenuRefresh();
    
    SpreadsheetApp.getUi().alert('Cache cleared! Version: ' + SCRIPT_VERSION);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Nuclear clear failed: ' + e.message);
  }
}

/**
 * Menu wrapper functions - these run the local script version instead of cached deployment
 */

function menuEditInDagnet() {
  try {
    var cell = SpreadsheetApp.getActiveRange();
    var cellValue = cell.getValue();
    
    if (!cellValue || !cellValue.toString().startsWith('graph://')) {
      SpreadsheetApp.getUi().alert('Please select a graph cell (starting with graph://)');
      return;
    }
    
    var graphId = cellValue.toString().replace('graph://', '').split('?')[0];
    
    openDagnetFromPointer(cell, graphId);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Error in menuEditInDagnet: ' + e.message);
  }
}

function menuExtractParameters() {
  try {
    var cell = SpreadsheetApp.getActiveRange();
    var cellValue = cell.getValue();
    
    if (!cellValue || !cellValue.toString().startsWith('graph://')) {
      SpreadsheetApp.getUi().alert('Please select a graph cell (starting with graph://)');
      return;
    }
    
    var graphId = cellValue.toString().replace('graph://', '').split('?')[0];
    
    extractParametersToNamedRange(cell, graphId);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Error in menuExtractParameters: ' + e.message);
  }
}

function menuAddScenario() {
  try {
    var cell = SpreadsheetApp.getActiveRange();
    var cellValue = cell.getValue();
    
    if (!cellValue || !cellValue.toString().startsWith('graph://')) {
      SpreadsheetApp.getUi().alert('Please select a graph cell (starting with graph://)');
      return;
    }
    
    var graphId = cellValue.toString().replace('graph://', '').split('?')[0];
    
    addScenarioToGraph(cell, graphId);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Error in menuAddScenario: ' + e.message);
  }
}

function menuViewHistory() {
  try {
    var cell = SpreadsheetApp.getActiveRange();
    var cellValue = cell.getValue();
    
    if (!cellValue || !cellValue.toString().startsWith('graph://')) {
      SpreadsheetApp.getUi().alert('Please select a graph cell (starting with graph://)');
      return;
    }
    
    var graphId = cellValue.toString().replace('graph://', '').split('?')[0];
    
    viewGraphHistory(cell, graphId);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Error in menuViewHistory: ' + e.message);
  }
}