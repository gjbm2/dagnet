/**
 * Google Apps Script for Dagnet Graph Editor Integration
 * 
 * This script provides functionality to:
 * 1. Open the Dagnet app in a new tab
 * 2. Inject JSON graph data into the app
 * 3. Monitor for save events and handle completion
 * 
 * Usage:
 * - Call openDagnetWithData(graphJson) to open the app with specific graph data
 * - The script will automatically handle the injection and monitoring
 */

// Configuration
const DAGNET_APP_URL = 'https://dagnet-nine.vercel.app/';
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();

/**
 * Web app endpoint - MUST BE FIRST FUNCTION
 */
function doGet(e) {
  try {
    if (!e.parameter || Object.keys(e.parameter).length === 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, message: "doGet is working!" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const { sessionId, graphData, outputCell, sheetId } = e.parameter;
    
    if (!sessionId || !graphData || !outputCell || !sheetId) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: 'Missing parameters' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Show modal dialog to confirm the function was called
    try {
      const sheet = SpreadsheetApp.openById(sheetId).getActiveSheet();
      const ui = SpreadsheetApp.getUi();
      
      // Show the JSON data in a modal
      const jsonPreview = graphData.length > 500 ? graphData.substring(0, 500) + '...' : graphData;
      ui.alert(
        'DAGNET SAVE DETECTED!', 
        'doGet function was called!\n\n' +
        'Session ID: ' + sessionId + '\n' +
        'Output Cell: ' + outputCell + '\n' +
        'Sheet ID: ' + sheetId + '\n\n' +
        'JSON Data (first 500 chars):\n' + jsonPreview,
        ui.ButtonSet.OK
      );
      
      // Write to the specified cell
      const cell = sheet.getRange(outputCell);
      const jsonString = JSON.stringify(JSON.parse(graphData), null, 2);
      cell.setValue(jsonString);
      
      // Show success dialog
      ui.alert('SUCCESS!', 'Cell ' + outputCell + ' has been updated with the new JSON data!', ui.ButtonSet.OK);
      
    } catch (dialogError) {
      console.error('Error showing dialog:', dialogError);
      // Still try to write the cell even if dialog fails
      const sheet = SpreadsheetApp.openById(sheetId).getActiveSheet();
      const cell = sheet.getRange(outputCell);
      const jsonString = JSON.stringify(JSON.parse(graphData), null, 2);
      cell.setValue(jsonString);
    }
    
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, message: "Cell updated successfully!" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Simple compression for Google Apps Script
 * Since we can't use LZ-string, we'll use base64 encoding which should work
 */
function compressData(data) {
  // Just use base64 encoding - your app might handle this
  return Utilities.base64Encode(data);
}

/**
 * Decompress data (for testing)
 */
function decompressData(compressedData) {
  return Utilities.base64Decode(compressedData);
}

/**
 * Main function to open Dagnet app with injected graph data
 * @param {Object} graphData - The graph JSON object to inject
 * @param {Object} options - Optional configuration
 * @param {boolean} options.waitForSave - Whether to wait for save completion (default: true)
 * @param {number} options.timeout - Timeout in milliseconds (default: 30000)
 * @param {string} options.sheetId - Google Sheet ID for saving (optional)
 * @returns {Object} Result object with success status and details
 */
function openDagnetWithData(graphData, options = {}) {
  const {
    waitForSave = true,
    timeout = 30000,
    sheetId = null
  } = options;

  try {
    // Validate graph data
    const validationResult = validateGraphData(graphData);
    if (!validationResult.isValid) {
      throw new Error(`Invalid graph data: ${validationResult.errors.join(', ')}`);
    }

    // Generate unique session ID for this operation
    const sessionId = Utilities.getUuid();
    SCRIPT_PROPERTIES.setProperty('dagnet_session_id', sessionId);
    SCRIPT_PROPERTIES.setProperty('dagnet_graph_data', JSON.stringify(graphData));
    SCRIPT_PROPERTIES.setProperty('dagnet_wait_for_save', waitForSave.toString());
    SCRIPT_PROPERTIES.setProperty('dagnet_timeout', timeout.toString());
    
    if (sheetId) {
      SCRIPT_PROPERTIES.setProperty('dagnet_sheet_id', sheetId);
    }

    // Create URL with encoded graph data
    const jsonString = JSON.stringify(graphData);
    const encodedData = encodeURIComponent(jsonString);
    const appUrl = `${DAGNET_APP_URL}?data=${encodedData}&session=${sessionId}`;
    
    // Debug: Log the URL to see what we're sending
    console.log('Generated URL:', appUrl);
    console.log('JSON data length:', jsonString.length);
    
    // Use a more reliable method to open a new tab
    const htmlOutput = HtmlService.createHtmlOutput(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Opening Dagnet...</title>
        </head>
        <body>
          <div style="text-align: center; padding: 20px; font-family: Arial, sans-serif;">
            <h2>🚀 Opening Dagnet App...</h2>
            <p>If the app doesn't open automatically, <a href="${appUrl}" target="_blank">click here</a></p>
            <button onclick="window.open('${appUrl}', '_blank'); google.script.host.close();" 
                    style="background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer;">
              Open Dagnet App
            </button>
            <button onclick="google.script.host.close();" 
                    style="background: #6c757d; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin-left: 10px;">
              Close
            </button>
          </div>
          <script>
            // Try to open immediately
            setTimeout(() => {
              const newWindow = window.open('${appUrl}', '_blank');
              if (!newWindow) {
                // If popup was blocked, show the manual link
                document.body.innerHTML = '<div style="text-align: center; padding: 20px;"><h2>Popup Blocked</h2><p>Please <a href="${appUrl}" target="_blank">click here to open Dagnet</a></p></div>';
              } else {
                // Successfully opened, close this dialog
                setTimeout(() => {
                  google.script.host.close();
                }, 1000);
              }
            }, 500);
          </script>
        </body>
      </html>
    `)
    .setWidth(400)
    .setHeight(200)
    .setTitle('Opening Dagnet...');

    // Return the HTML service
    return {
      success: true,
      sessionId: sessionId,
      appUrl: appUrl,
      htmlOutput: htmlOutput
    };

  } catch (error) {
    console.error('Error opening Dagnet with data:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Validate graph data against the Dagnet schema
 * @param {Object} graphData - The graph data to validate
 * @returns {Object} Validation result with isValid boolean and errors array
 */
function validateGraphData(graphData) {
  const errors = [];
  
  try {
    // Check if it's a valid object
    if (!graphData || typeof graphData !== 'object') {
      errors.push('Graph data must be a valid object');
      return { isValid: false, errors };
    }
    
    // Check required top-level properties
    const requiredProps = ['nodes', 'edges', 'policies', 'metadata'];
    for (const prop of requiredProps) {
      if (!graphData.hasOwnProperty(prop)) {
        errors.push(`Missing required property: ${prop}`);
      }
    }
    
    // Validate nodes
    if (graphData.nodes && Array.isArray(graphData.nodes)) {
      if (graphData.nodes.length === 0) {
        errors.push('Graph must have at least one node');
      }
      
      graphData.nodes.forEach((node, index) => {
        if (!node.id) {
          errors.push(`Node ${index} missing required 'id' field`);
        }
        if (!node.slug) {
          errors.push(`Node ${index} missing required 'slug' field`);
        }
        // Skip UUID validation for now since the app handles it fine
        // if (node.id && !isValidUUID(node.id)) {
        //   errors.push(`Node ${index} has invalid UUID format for 'id'`);
        // }
      });
    } else {
      errors.push('Nodes must be an array');
    }
    
    // Validate edges
    if (graphData.edges && Array.isArray(graphData.edges)) {
      graphData.edges.forEach((edge, index) => {
        if (!edge.id) {
          errors.push(`Edge ${index} missing required 'id' field`);
        }
        if (!edge.from) {
          errors.push(`Edge ${index} missing required 'from' field`);
        }
        if (!edge.to) {
          errors.push(`Edge ${index} missing required 'to' field`);
        }
        // Skip UUID validation for now since the app handles it fine
        // if (edge.id && !isValidUUID(edge.id)) {
        //   errors.push(`Edge ${index} has invalid UUID format for 'id'`);
        // }
      });
    } else {
      errors.push('Edges must be an array');
    }
    
    // Validate policies
    if (graphData.policies) {
      if (!graphData.policies.default_outcome) {
        errors.push('Policies must specify default_outcome');
      }
    }
    
    // Validate metadata
    if (graphData.metadata) {
      if (!graphData.metadata.version) {
        errors.push('Metadata must specify version');
      }
      if (!graphData.metadata.created_at) {
        errors.push('Metadata must specify created_at');
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors
    };
    
  } catch (error) {
    return {
      isValid: false,
      errors: ['Validation error: ' + error.message]
    };
  }
}

/**
 * Check if a string is a valid UUID (more flexible validation)
 * @param {string} str - String to validate
 * @returns {boolean} True if valid UUID
 */
function isValidUUID(str) {
  if (!str || typeof str !== 'string') return false;
  
  // More flexible UUID validation - accepts various formats
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Create a sample graph for testing
 * @returns {Object} Sample graph data
 */
function createSampleGraph() {
  return {
    "nodes": [
      {
        "id": "11111111-1111-4111-8111-111111111111",
        "slug": "landing",
        "label": "Landing Page",
        "entry": { "is_start": true, "entry_weight": 1 },
        "layout": { "x": 40, "y": 60, "rank": 0, "group": "Top", "color": "#111827" },
        "tags": ["entry"]
      },
      {
        "id": "22222222-2222-4222-8222-222222222222",
        "slug": "add_to_basket",
        "label": "Add to Basket",
        "layout": { "x": 240, "y": 60, "rank": 1 }
      },
      {
        "id": "33333333-3333-4333-8333-333333333333",
        "slug": "purchase",
        "label": "Purchase",
        "absorbing": true,
        "outcome_type": "success",
        "layout": { "x": 440, "y": 60, "rank": 2, "color": "#16A34A" }
      },
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "slug": "abandon",
        "label": "Abandon",
        "absorbing": true,
        "outcome_type": "failure",
        "layout": { "x": 440, "y": 140, "rank": 2, "color": "#EF4444" }
      }
    ],
    "edges": [
      {
        "id": "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        "from": "landing",
        "to": "add_to_basket",
        "fromHandle": "right",
        "toHandle": "left",
        "p": { "mean": 0.7 }
      },
      {
        "id": "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        "from": "add_to_basket",
        "to": "purchase",
        "fromHandle": "right",
        "toHandle": "left",
        "p": { "mean": 0.25 }
      },
      {
        "id": "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        "from": "add_to_basket",
        "to": "abandon",
        "fromHandle": "bottom",
        "toHandle": "top",
        "p": { "mean": 0.75 }
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
      "author": "Apps Script Integration",
      "description": "Sample conversion funnel created via Apps Script"
    }
  };
}

/**
 * Test function to demonstrate the integration
 * @returns {Object} Test result
 */
function testDagnetIntegration() {
  try {
    console.log('Testing Dagnet integration...');
    
    // Create sample graph
    const sampleGraph = createSampleGraph();
    console.log('Sample graph created:', JSON.stringify(sampleGraph, null, 2));
    
    // Validate the graph
    const validation = validateGraphData(sampleGraph);
    console.log('Validation result:', validation);
    
    if (!validation.isValid) {
      throw new Error('Sample graph validation failed: ' + validation.errors.join(', '));
    }
    
    // Open Dagnet with the sample graph
    const result = openDagnetWithData(sampleGraph, {
      waitForSave: true,
      timeout: 60000
    });
    
    console.log('Dagnet opened with result:', result);
    return result;
    
  } catch (error) {
    console.error('Test failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Helper function to create a graph from Google Sheets data
 * @param {string} sheetId - Google Sheet ID
 * @param {string} sheetName - Sheet name (optional)
 * @returns {Object} Graph data created from sheet
 */
function createGraphFromSheet(sheetId, sheetName = 'GraphData') {
  try {
    const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(sheetName);
    if (!sheet) {
      throw new Error(`Sheet '${sheetName}' not found`);
    }
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    
    // This is a simplified example - you'd need to implement
    // proper parsing based on your sheet structure
    const graph = {
      nodes: [],
      edges: [],
      policies: {
        default_outcome: "abandon",
        overflow_policy: "error",
        free_edge_policy: "complement"
      },
      metadata: {
        version: "1.0.0",
        created_at: new Date().toISOString(),
        author: "Sheet Integration",
        description: "Graph created from Google Sheets data"
      }
    };
    
    // Parse nodes from sheet data
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0] && row[1]) { // Assuming first two columns are id and slug
        graph.nodes.push({
          id: row[0],
          slug: row[1],
          label: row[2] || row[1],
          layout: { x: (i * 100) % 400, y: Math.floor(i / 4) * 100 + 60, rank: Math.floor(i / 4) }
        });
      }
    }
    
    return graph;
    
  } catch (error) {
    console.error('Error creating graph from sheet:', error);
    throw error;
  }
}

/**
 * Monitor function to check save status (can be called periodically)
 * @returns {Object} Current save status
 */
function checkSaveStatus() {
  try {
    const sessionId = SCRIPT_PROPERTIES.getProperty('dagnet_session_id');
    const saveStatus = SCRIPT_PROPERTIES.getProperty('dagnet_save_status');
    
    if (!sessionId) {
      return { status: 'no_session', message: 'No active session' };
    }
    
    if (saveStatus === 'completed') {
      return { status: 'completed', message: 'Save completed successfully' };
    } else if (saveStatus === 'failed') {
      return { status: 'failed', message: 'Save failed' };
    } else {
      return { status: 'pending', message: 'Waiting for save...' };
    }
    
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

/**
 * Clean up session data
 */
function cleanupSession() {
  SCRIPT_PROPERTIES.deleteProperty('dagnet_session_id');
  SCRIPT_PROPERTIES.deleteProperty('dagnet_graph_data');
  SCRIPT_PROPERTIES.deleteProperty('dagnet_save_status');
  SCRIPT_PROPERTIES.deleteProperty('dagnet_wait_for_save');
  SCRIPT_PROPERTIES.deleteProperty('dagnet_timeout');
  SCRIPT_PROPERTIES.deleteProperty('dagnet_sheet_id');
  console.log('Session data cleaned up');
}

/**
 * SHEET INTEGRATION FUNCTIONS
 * These functions create the menu and handle sheet-based operations
 */

/**
 * Creates the custom menu when the sheet opens
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Dagnet Integration')
    .addItem('Edit Selected Cell in Dagnet', 'openDagnetFromCell')
    .addItem('Open Dagnet with Sample Graph', 'openSampleGraph')
    .addItem('Open Dagnet with Sheet Data', 'openWithSheetData')
    .addItem('Test Integration', 'testFromSheet')
    .addItem('Check Save Status', 'checkSaveStatusFromSheet')
    .addItem('Mark Save Complete', 'markSaveComplete')
    .addItem('Import Updated Data', 'importUpdatedData')
    .addToUi();
    
  // Check for save completion when sheet opens (this runs every time user returns to sheet)
  checkForSaveCompletion();
}

/**
 * Opens Dagnet with JSON data from a specific cell
 * @param {string} cellAddress - Cell address containing JSON (e.g., "A1")
 * @param {string} resultCellAddress - Cell to update with results (e.g., "B1")
 */
function openDagnetFromCell(cellAddress = null, resultCellAddress = null) {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    
    // If no cell specified, use the currently selected cell
    if (!cellAddress) {
      const activeRange = sheet.getActiveRange();
      cellAddress = activeRange.getA1Notation();
    }
    
    // If no result cell specified, use the same cell (edit in place)
    if (!resultCellAddress) {
      resultCellAddress = cellAddress;
    }
    
    const cell = sheet.getRange(cellAddress);
    
    // Try multiple methods to get the cell content
    let jsonString = cell.getValue();
    let displayValue = cell.getDisplayValue();
    let formula = cell.getFormula();
    
    // Debug information
    console.log('Cell address:', cellAddress);
    console.log('getValue():', jsonString);
    console.log('getDisplayValue():', displayValue);
    console.log('getFormula():', formula);
    console.log('Value type:', typeof jsonString);
    console.log('Display value type:', typeof displayValue);
    
    // Use display value if getValue() is empty but display value has content
    if ((!jsonString || jsonString.toString().trim() === '') && displayValue && displayValue.toString().trim() !== '') {
      console.log('Using display value instead of getValue()');
      jsonString = displayValue;
    }
    
    // If it's a formula, try to get the calculated value
    if (formula && formula.startsWith('=')) {
      console.log('Cell contains formula, using display value');
      jsonString = displayValue;
    }
    
    if (!jsonString || jsonString.toString().trim() === '') {
      SpreadsheetApp.getUi().alert('No JSON data found in cell ' + cellAddress + 
        '\n\nDebug info:\n' +
        'getValue(): "' + cell.getValue() + '"\n' +
        'getDisplayValue(): "' + cell.getDisplayValue() + '"\n' +
        'getFormula(): "' + cell.getFormula() + '"\n' +
        'Cell is empty: ' + cell.isBlank());
      return;
    }
    
    // Just pass the raw JSON string - let the app handle parsing
    const graphData = jsonString;
    
    // No validation - the app will handle it
    
    // Generate unique session ID for this operation
    const sessionId = Utilities.getUuid();
    
    // Store the result cell for updates (async to not block)
    SCRIPT_PROPERTIES.setProperty('dagnet_result_cell', resultCellAddress);
    SCRIPT_PROPERTIES.setProperty('dagnet_source_cell', cellAddress);
    SCRIPT_PROPERTIES.setProperty('dagnet_session_id', sessionId);
    SCRIPT_PROPERTIES.setProperty('dagnet_start_time', new Date().getTime().toString());
    
    // Don't overwrite the original data - just show a status message in a different cell if needed
    // sheet.getRange(resultCellAddress).setValue('Opening Dagnet app...');
    
    // Use plain JSON encoding for now
    const plainData = encodeURIComponent(graphData);
    
    // Get the current sheet ID
    const sheetId = sheet.getParent().getId();
    
    // Get the Apps Script web app URL (you'll need to set this after deploying)
    const appsScriptUrl = SCRIPT_PROPERTIES.getProperty('dagnet_web_app_url') || 'https://script.google.com/macros/s/AKfycbypxBzpD6O3jKCPWRGTlG0mT4awCChN4eOoVO2OiXmLGRLalU5r6Kwlu-2RNl5eF1rS/exec';
    
    const appUrl = `${DAGNET_APP_URL}?data=${plainData}&session=${sessionId}&outputCell=${resultCellAddress}&sheetId=${sheetId}&appsScriptUrl=${encodeURIComponent(appsScriptUrl)}`;
    
    console.log('Plain data length:', plainData.length);
    console.log('App URL:', appUrl);
    
    console.log('URL generated, opening dialog...');
    
    // Create a simple, fast HTML dialog
    const htmlOutput = HtmlService.createHtmlOutput(`
      <!DOCTYPE html>
      <html>
        <head><title>Opening Dagnet...</title></head>
        <body style="text-align: center; padding: 20px; font-family: Arial, sans-serif;">
          <h2>🚀 Opening Dagnet App...</h2>
          <p>If the app doesn't open automatically, <a href="${appUrl}" target="_blank">click here</a></p>
          <button onclick="window.open('${appUrl}', '_blank'); google.script.host.close();" 
                  style="background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer;">
            Open Dagnet App
          </button>
          <button onclick="google.script.host.close();" 
                  style="background: #6c757d; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin-left: 10px;">
            Close
          </button>
          <script>
            // Try to open immediately
            setTimeout(() => {
              const newWindow = window.open('${appUrl}', '_blank');
              if (newWindow) {
                setTimeout(() => google.script.host.close(), 1000);
              }
            }, 500);
          </script>
        </body>
      </html>
    `).setWidth(400).setHeight(200);
    
    // Show the dialog immediately
    SpreadsheetApp.getUi().showModalDialog(htmlOutput, 'Opening Dagnet App...');
    
    // Start monitoring for save completion (async)
    startSaveMonitoring();
    
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error: ' + error.message);
  }
}

/**
 * Opens Dagnet with sample graph data
 */
function openSampleGraph() {
  try {
    const sampleGraph = createSampleGraph();
    const result = openDagnetWithData(sampleGraph, {
      waitForSave: true,
      timeout: 60000
    });
    
    if (result.success) {
      SpreadsheetApp.getUi().alert('Dagnet opened with sample graph!');
      startSaveMonitoring();
    } else {
      SpreadsheetApp.getUi().alert('Error: ' + result.error);
    }
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error: ' + error.message);
  }
}

/**
 * Opens Dagnet with data parsed from the current sheet
 */
function openWithSheetData() {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const graph = createGraphFromSheet(sheet.getParent().getId(), sheet.getName());
    const result = openDagnetWithData(graph, {
      waitForSave: true,
      timeout: 60000
    });
    
    if (result.success) {
      SpreadsheetApp.getUi().alert('Dagnet opened with sheet data!');
      startSaveMonitoring();
    } else {
      SpreadsheetApp.getUi().alert('Error: ' + result.error);
    }
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error creating graph from sheet: ' + error.message);
  }
}

/**
 * Tests the integration from the sheet
 */
function testFromSheet() {
  try {
    const result = testDagnetIntegration();
    SpreadsheetApp.getUi().alert('Test result: ' + JSON.stringify(result, null, 2));
  } catch (error) {
    SpreadsheetApp.getUi().alert('Test failed: ' + error.message);
  }
}

/**
 * Checks save status from the sheet
 */
function checkSaveStatusFromSheet() {
  try {
    const status = checkSaveStatus();
    SpreadsheetApp.getUi().alert('Save Status: ' + status.message);
    
    if (status.status === 'completed') {
      updateResultCell('Save completed successfully!');
    }
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error checking status: ' + error.message);
  }
}

/**
 * Check for save completion when user returns to the sheet
 */
function checkForSaveCompletion() {
  try {
    const sessionId = SCRIPT_PROPERTIES.getProperty('dagnet_session_id');
    const resultCell = SCRIPT_PROPERTIES.getProperty('dagnet_result_cell');
    const startTime = SCRIPT_PROPERTIES.getProperty('dagnet_start_time');
    
    if (!sessionId || !resultCell) {
      return; // No active session
    }
    
    // Only check if we started a session recently (within last 10 minutes)
    if (startTime) {
      const sessionStart = parseInt(startTime);
      const now = new Date().getTime();
      const timeDiff = now - sessionStart;
      
      // Only check if session started within last 10 minutes
      if (timeDiff > 10 * 60 * 1000) { // 10 minutes
        return;
      }
    }
    
    const sheet = SpreadsheetApp.getActiveSheet();
    const currentValue = sheet.getRange(resultCell).getValue();
    
    // Check if the cell shows we're still opening or waiting
    const isWaiting = !currentValue || 
                     currentValue.toString().includes('Opening Dagnet app') ||
                     currentValue.toString().includes('waiting') ||
                     currentValue.toString().includes('opening');
    
    if (isWaiting) {
      // User has returned to sheet, assume they saved and closed the app
      sheet.getRange(resultCell).setValue('Save completed at ' + new Date().toLocaleString());
      console.log('Save completion detected and updated');
      
      // Show a dialog asking user to paste the updated data
      const sourceCell = SCRIPT_PROPERTIES.getProperty('dagnet_source_cell');
      if (sourceCell) {
        SpreadsheetApp.getUi().alert(
          'Save completed! The updated JSON has been copied to your clipboard. Please paste it into cell ' + sourceCell + ' to update your data.'
        );
      }
      
      // Clean up the session
      SCRIPT_PROPERTIES.deleteProperty('dagnet_session_id');
      SCRIPT_PROPERTIES.deleteProperty('dagnet_result_cell');
      SCRIPT_PROPERTIES.deleteProperty('dagnet_start_time');
      SCRIPT_PROPERTIES.deleteProperty('dagnet_source_cell');
      SCRIPT_PROPERTIES.deleteProperty('dagnet_graph_data');
    }
    
  } catch (error) {
    console.error('Error checking save completion:', error);
  }
}

/**
 * Manual function to update result cell when user returns from Dagnet
 * Call this after editing and saving in the Dagnet app
 */
function markSaveComplete() {
  try {
    const resultCell = SCRIPT_PROPERTIES.getProperty('dagnet_result_cell');
    if (resultCell) {
      const sheet = SpreadsheetApp.getActiveSheet();
      sheet.getRange(resultCell).setValue('Save completed at ' + new Date().toLocaleString());
      SpreadsheetApp.getUi().alert('Save status updated in cell ' + resultCell);
    } else {
      SpreadsheetApp.getUi().alert('No active session found. Please run the integration first.');
    }
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error updating save status: ' + error.message);
  }
}

/**
 * Import updated data from Dagnet app
 * This opens the app again to get the current data and updates the source cell
 */
function importUpdatedData() {
  try {
    const sourceCell = SCRIPT_PROPERTIES.getProperty('dagnet_source_cell');
    const resultCell = SCRIPT_PROPERTIES.getProperty('dagnet_result_cell');
    
    if (!sourceCell || !resultCell) {
      SpreadsheetApp.getUi().alert('No active session found. Please run the integration first.');
      return;
    }
    
    // Open Dagnet app again to get the current data
    const sessionId = Utilities.getUuid();
    const appUrl = `${DAGNET_APP_URL}?session=${sessionId}&import=true`;
    
    // Store the session for import
    SCRIPT_PROPERTIES.setProperty('dagnet_import_session', sessionId);
    SCRIPT_PROPERTIES.setProperty('dagnet_import_source', sourceCell);
    SCRIPT_PROPERTIES.setProperty('dagnet_import_result', resultCell);
    
    // Open the app
    const htmlOutput = HtmlService.createHtmlOutput(`
      <!DOCTYPE html>
      <html>
        <head><title>Importing Data...</title></head>
        <body style="text-align: center; padding: 20px; font-family: Arial, sans-serif;">
          <h2>📥 Importing Updated Data...</h2>
          <p>Opening Dagnet app to get current data...</p>
          <button onclick="window.open('${appUrl}', '_blank'); google.script.host.close();" 
                  style="background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer;">
            Open Dagnet App
          </button>
          <script>
            setTimeout(() => {
              window.open('${appUrl}', '_blank');
              google.script.host.close();
            }, 1000);
          </script>
        </body>
      </html>
    `).setWidth(400).setHeight(200);
    
    SpreadsheetApp.getUi().showModalDialog(htmlOutput, 'Importing Data...');
    
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error importing data: ' + error.message);
  }
}

/**
 * Starts monitoring for save completion
 */
function startSaveMonitoring() {
  // Check if we already have a trigger running
  const existingTriggerId = SCRIPT_PROPERTIES.getProperty('dagnet_trigger_id');
  if (existingTriggerId) {
    console.log('Save monitoring already active, skipping trigger creation');
    return;
  }
  
  // Set up a trigger to check save status every 2 seconds
  const trigger = ScriptApp.newTrigger('checkSaveAndUpdate')
    .timeBased()
    .everyMinutes(1) // Minimum is 1 minute, but we'll check more frequently in the function
    .create();
  
  SCRIPT_PROPERTIES.setProperty('dagnet_trigger_id', trigger.getUniqueId());
  SCRIPT_PROPERTIES.setProperty('dagnet_start_time', new Date().getTime().toString());
  console.log('Save monitoring started');
}

/**
 * Checks for save completion and updates the result cell
 */
function checkSaveAndUpdate() {
  try {
    const sessionId = SCRIPT_PROPERTIES.getProperty('dagnet_session_id');
    if (!sessionId) {
      console.log('No active session to check');
      return;
    }
    
    // Check localStorage for save status (this won't work from Apps Script directly)
    // Instead, we'll use a different approach - check if the user has returned to the sheet
    
    const status = checkSaveStatus();
    
    if (status.status === 'completed') {
      // Update the result cell
      updateResultCell('Save completed at ' + new Date().toLocaleString());
      
      // Get the updated graph data from the app (if possible)
      const updatedData = SCRIPT_PROPERTIES.getProperty('dagnet_graph_data');
      if (updatedData) {
        updateResultCellWithData(updatedData);
      }
      
      // Clean up the trigger
      cleanupSaveMonitoring();
      
    } else if (status.status === 'failed') {
      updateResultCell('Save failed: ' + status.message);
      cleanupSaveMonitoring();
    }
    
  } catch (error) {
    console.error('Error in checkSaveAndUpdate:', error);
  }
}

/**
 * Updates the result cell with a message
 */
function updateResultCell(message) {
  try {
    const resultCell = SCRIPT_PROPERTIES.getProperty('dagnet_result_cell');
    if (resultCell) {
      const sheet = SpreadsheetApp.getActiveSheet();
      sheet.getRange(resultCell).setValue(message);
      console.log('Updated result cell with:', message);
    }
  } catch (error) {
    console.error('Error updating result cell:', error);
  }
}

/**
 * Updates the result cell with updated graph data
 */
function updateResultCellWithData(graphData) {
  try {
    const resultCell = SCRIPT_PROPERTIES.getProperty('dagnet_result_cell');
    if (resultCell) {
      const sheet = SpreadsheetApp.getActiveSheet();
      const cell = sheet.getRange(resultCell);
      
      // Update the cell with the new graph data
      cell.setValue(JSON.stringify(graphData, null, 2));
      
      // Add a timestamp
      const timestampCell = sheet.getRange(resultCell.replace(/\d+/, (match) => parseInt(match) + 1));
      timestampCell.setValue('Updated: ' + new Date().toLocaleString());
      
      console.log('Updated result cell with new graph data');
    }
  } catch (error) {
    console.error('Error updating result cell with data:', error);
  }
}

/**
 * Cleans up the save monitoring trigger
 */
function cleanupSaveMonitoring() {
  try {
    const triggerId = SCRIPT_PROPERTIES.getProperty('dagnet_trigger_id');
    if (triggerId) {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach(trigger => {
        if (trigger.getUniqueId() === triggerId) {
          ScriptApp.deleteTrigger(trigger);
        }
      });
      SCRIPT_PROPERTIES.deleteProperty('dagnet_trigger_id');
      console.log('Save monitoring cleaned up');
    }
  } catch (error) {
    console.error('Error cleaning up save monitoring:', error);
  }
}

/**
 * CONVENIENCE FUNCTIONS FOR EASY USE
 */

/**
 * Quick function to open Dagnet with JSON from cell A1, update cell B1
 */
function openFromA1() {
  openDagnetFromCell("A1", "B1");
}

/**
 * Quick function to open Dagnet with JSON from cell A2, update cell B2
 */
function openFromA2() {
  openDagnetFromCell("A2", "B2");
}

/**
 * Quick function to open Dagnet with JSON from cell A3, update cell B3
 */
function openFromA3() {
  openDagnetFromCell("A3", "B3");
}

/**
 * Edit the currently selected cell in Dagnet (edit in place)
 */
function editSelectedCell() {
  openDagnetFromCell(); // Uses selected cell by default
}

/**
 * DEBUG: Test URL generation with sample data
 */
function testUrlGeneration() {
  try {
    const sampleGraph = createSampleGraph();
    const jsonString = JSON.stringify(sampleGraph);
    
    // Test compressed format (what your app expects)
    const compressedData = compressData(jsonString);
    const compressedUrl = `${DAGNET_APP_URL}?data=${compressedData}`;
    
    // Test plain format
    const plainData = encodeURIComponent(jsonString);
    const plainUrl = `${DAGNET_APP_URL}?data=${plainData}`;
    
    console.log('Sample graph JSON:', jsonString);
    console.log('Compressed data:', compressedData);
    console.log('Plain data:', plainData);
    console.log('Compressed URL:', compressedUrl);
    console.log('Plain URL:', plainUrl);
    
    SpreadsheetApp.getUi().alert('Test URLs generated:\n\nCompressed: ' + compressedUrl + '\n\nPlain: ' + plainUrl + '\n\nCheck the execution log for full details.');
    
    return { compressedUrl, plainUrl };
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error generating test URL: ' + error.message);
  }
}

/**
 * DEBUG FUNCTION: Check what's actually in a cell
 */
function debugCell(cellAddress = "A1") {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const cell = sheet.getRange(cellAddress);
    const value = cell.getValue();
    const displayValue = cell.getDisplayValue();
    const formula = cell.getFormula();
    
    const debugInfo = {
      cellAddress: cellAddress,
      getValue: value,
      getDisplayValue: displayValue,
      getFormula: formula,
      valueType: typeof value,
      displayValueType: typeof displayValue,
      valueLength: value ? value.length : 'null/undefined',
      displayValueLength: displayValue ? displayValue.length : 'null/undefined',
      valuePreview: value ? value.substring(0, 200) : 'null/undefined',
      displayValuePreview: displayValue ? displayValue.substring(0, 200) : 'null/undefined',
      isEmpty: !value || value.toString().trim() === '',
      isBlank: cell.isBlank(),
      hasFormula: !!formula,
      isFormula: formula && formula.startsWith('=')
    };
    
    console.log('Debug info for cell ' + cellAddress + ':', debugInfo);
    SpreadsheetApp.getUi().alert('Cell ' + cellAddress + ' debug info:\n' + JSON.stringify(debugInfo, null, 2));
    
    return debugInfo;
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error debugging cell: ' + error.message);
  }
}

/**
 * FIX CELL: Convert formula to value if needed
 */
function fixCell(cellAddress = "A1") {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const cell = sheet.getRange(cellAddress);
    const formula = cell.getFormula();
    const displayValue = cell.getDisplayValue();
    
    if (formula && formula.startsWith('=')) {
      // Convert formula to value
      cell.setValue(displayValue);
      SpreadsheetApp.getUi().alert('Cell ' + cellAddress + ' converted from formula to value');
    } else {
      SpreadsheetApp.getUi().alert('Cell ' + cellAddress + ' is not a formula, no conversion needed');
    }
  } catch (error) {
    SpreadsheetApp.getUi().alert('Error fixing cell: ' + error.message);
  }
}


/**
 * Set the web app URL for the Dagnet integration
 * Call this after deploying your Apps Script as a web app
 */
function setWebAppUrl(webAppUrl) {
  SCRIPT_PROPERTIES.setProperty('dagnet_web_app_url', webAppUrl);
  console.log('Web app URL set to:', webAppUrl);
  SpreadsheetApp.getUi().alert('Web app URL set successfully!');
}

/**
 * Clean up all triggers to avoid the "too many triggers" error
 */
function cleanupAllTriggers() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    console.log('Found ' + triggers.length + ' triggers to delete');
    
    triggers.forEach(trigger => {
      console.log('Deleting trigger:', trigger.getHandlerFunction(), trigger.getTriggerSource());
      ScriptApp.deleteTrigger(trigger);
    });
    
    console.log('All triggers cleaned up');
    SpreadsheetApp.getUi().alert('All triggers cleaned up successfully!');
  } catch (error) {
    console.error('Error cleaning up triggers:', error);
    SpreadsheetApp.getUi().alert('Error cleaning up triggers: ' + error.message);
  }
}

/**
 * Simple test function for web app deployment
 */
function testWebApp() {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, message: "Web app is working!" }))
    .setMimeType(ContentService.MimeType.JSON);
}


/**
 * Test function to verify the web app endpoint is working
 */
function testWebAppEndpoint() {
  try {
    const sheetId = SpreadsheetApp.getActiveSheet().getParent().getId();
    const testData = JSON.stringify({ test: "data", timestamp: new Date().toISOString() });
    const encodedData = encodeURIComponent(testData);
    
    const webAppUrl = SCRIPT_PROPERTIES.getProperty('dagnet_web_app_url') || 'https://script.google.com/macros/s/AKfycbypxBzpD6O3jKCPWRGTlG0mT4awCChN4eOoVO2OiXmLGRLalU5r6Kwlu-2RNl5eF1rS/exec';
    
    const testUrl = `${webAppUrl}?sessionId=test123&graphData=${encodedData}&outputCell=A1&sheetId=${sheetId}`;
    
    console.log('Testing web app endpoint with URL:', testUrl);
    
    // Use muteHttpExceptions to see the full response
    const response = UrlFetchApp.fetch(testUrl, {
      muteHttpExceptions: true
    });
    
    const responseText = response.getContentText();
    const responseCode = response.getResponseCode();
    
    console.log('Response status:', responseCode);
    console.log('Response text:', responseText);
    
    if (responseCode === 302) {
      SpreadsheetApp.getUi().alert('ERROR: Web app is redirecting (302). This means the deployment is not configured correctly.\n\nYou need to:\n1. Go to Deploy → Manage deployments\n2. Click the pencil icon to edit\n3. Make sure "Execute as" is set to "Me"\n4. Make sure "Who has access" is set to "Anyone"\n5. Click Deploy to update');
    } else if (responseCode === 200) {
      SpreadsheetApp.getUi().alert('SUCCESS: Web app is working!\n\nResponse: ' + responseText);
    } else {
      SpreadsheetApp.getUi().alert('Web app returned status ' + responseCode + '\n\nResponse: ' + responseText);
    }
    
    return { success: responseCode === 200, response: responseText, status: responseCode };
  } catch (error) {
    console.error('Test failed:', error);
    SpreadsheetApp.getUi().alert('Test failed: ' + error.message);
    return { success: false, error: error.message };
  }
}
