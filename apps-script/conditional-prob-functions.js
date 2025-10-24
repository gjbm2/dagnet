/**
 * Google Sheets Functions for Conditional Probability & What-If Analysis
 * 
 * This file contains the implementation of:
 * - dagGetGraph: Retrieve graphs from repository or URL
 * - dagParams: Create parameter/case/visited overrides (EXTENDED)
 * - dagCalc: Graph analytics with what-if support (EXTENDED)
 * - Supporting helper functions
 * 
 * Date: October 24, 2025
 */

// ===== CONSTANTS =====

/**
 * @const {string} DAGNET_GRAPH_API_BASE - Base URL for graph API
 */
const DAGNET_GRAPH_API_BASE = 'https://dagnet-nine.vercel.app/api/graph';

// ===== MAIN FUNCTIONS =====

/**
 * Retrieves a graph from a URL or by name from default repo
 * @param {string} urlOrName - Full URL or graph name (uses DAGNET_GRAPH_API_BASE if name)
 * @param {string} [branch="main"] - Branch (only used if urlOrName is a name)
 * @returns {string} Graph JSON
 * @customfunction
 */
function dagGetGraph(urlOrName, branch) {
  try {
    if (!urlOrName) {
      return 'Error: Graph name or URL required';
    }
    
    var url;
    
    // Check if it's already a URL
    if (urlOrName.startsWith('http://') || urlOrName.startsWith('https://')) {
      url = urlOrName;
    } else {
      // Construct URL using default base
      var branchParam = branch || 'main';
      url = DAGNET_GRAPH_API_BASE + 
            '?name=' + encodeURIComponent(urlOrName) +
            '&branch=' + encodeURIComponent(branchParam) +
            '&raw=true&format=pretty';
    }
    
    // Fetch the graph
    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true
    });
    
    var statusCode = response.getResponseCode();
    var content = response.getContentText();
    
    if (statusCode !== 200) {
      try {
        var errorData = JSON.parse(content);
        return 'Error: ' + (errorData.error || 'Failed to fetch graph');
      } catch (e) {
        return 'Error: HTTP ' + statusCode;
      }
    }
    
    return content;
  } catch (error) {
    return 'Error: ' + error.message;
  }
}

/**
 * Creates parameter overrides for dagCalc
 * Supports:
 * - Parameter refs: dagParams("e.checkout.p.mean", 0.9, ...)
 * - Case overrides: dagParams("checkout-experiment", "treatment", ...)
 * - Visited conditions: dagParams("visited(promo)", true, ...)
 * - Visited exclusions: dagParams("visited(promo)", false, ...)
 * Can chain multiple of each type
 * @param {...} arguments - Alternating key-value pairs
 * @returns {string} JSON string for dagCalc
 * @customfunction
 */
function dagParams() {
  try {
    var result = {
      parameters: {},
      cases: {},
      assumeVisited: [],
      excludeVisited: []
    };
    
    var args = Array.prototype.slice.call(arguments);
    
    for (var i = 0; i < args.length; i += 2) {
      if (i + 1 >= args.length) break;
      
      var key = args[i];
      var value = args[i + 1];
      
      // Skip empty/null keys
      if (!key || key === '') continue;
      
      // Convert key to string
      key = key.toString();
      
      // Normalize boolean values
      var normalizedValue = 
        (value === "true" || value === true) ? true :
        (value === "false" || value === false) ? false : 
        value;
      
      // Check if key is a visited condition: visited(...)
      var keyVisitedMatch = key.match(/^visited\(([^)]+)\)$/);
      var valueVisitedMatch = (typeof value === 'string') ? 
        value.match(/^visited\(([^)]+)\)$/) : null;
      
      if (keyVisitedMatch) {
        // Key is visited(...)
        var nodes = keyVisitedMatch[1].split(',').map(function(n) { 
          return n.trim(); 
        }).sort();
        
        if (normalizedValue === true) {
          // Add to assumeVisited
          result.assumeVisited.push(nodes);
        } else if (normalizedValue === false) {
          // Add to excludeVisited (override hyperprior)
          result.excludeVisited.push(nodes);
        }
        
        // If value is ALSO visited(...), add it to assumeVisited too
        if (valueVisitedMatch) {
          var valueNodes = valueVisitedMatch[1].split(',').map(function(n) { 
            return n.trim(); 
          }).sort();
          result.assumeVisited.push(valueNodes);
        }
      } else if (key.startsWith('e.')) {
        // Parameter override (edge parameter reference)
        result.parameters[key] = normalizedValue;
      } else {
        // Case override (case-id -> variant-name)
        result.cases[key] = normalizedValue;
      }
    }
    
    return JSON.stringify(result);
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

/**
 * Calculate graph analytics with conditional probability and what-if support
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [operation] - Operation: DG_PROBABILITY, DG_COST, DG_TIME
 * @param {string} [startNode] - Start node slug/ID
 * @param {string} [endNode] - End node: DG_ANY_SUCCESS, DG_ANY_FAILURE, or node slug
 * @param {string} [customParams] - JSON from dagParams() for parameter overrides
 * @param {string} [whatIf] - JSON from dagParams() for case/visited what-if scenarios
 * @returns {number} Calculated result
 * @customfunction
 */
function dagCalc(input, operation, startNode, endNode, customParams, whatIf) {
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
          return 'Error: Cell ' + input + ' is empty or doesn\'t contain JSON';
        }
      } else {
        // Direct JSON string
        graph = JSON.parse(input);
      }
    } else {
      return 'Error: Input must be a cell reference or JSON string';
    }
    
    if (!graph || !graph.nodes || !graph.edges) {
      return 'Error: Invalid graph format';
    }
    
    // Set defaults
    if (!operation) operation = 'probability';
    if (!startNode || startNode === '') {
      startNode = graph.nodes[0] ? (graph.nodes[0].id || graph.nodes[0].slug || graph.nodes[0].label) : 'start';
    }
    if (!endNode) endNode = 'anySuccess';
    
    // Parse customParams (parameter overrides)
    if (customParams) {
      var params = JSON.parse(customParams);
      if (params.parameters) {
        graph = applyParameterOverrides(graph, params.parameters);
      }
    }
    
    // Parse whatIf scenarios
    var whatIfData = null;
    if (whatIf) {
      whatIfData = JSON.parse(whatIf);
    }
    
    // Run calculation with what-if context
    var result = runGraphAnalysis(
      graph, 
      operation, 
      startNode, 
      endNode,
      whatIfData
    );
    
    return result;
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

// ===== HELPER FUNCTIONS =====

/**
 * Apply parameter overrides to graph
 * @param {Object} graph - Graph object
 * @param {Object} parameters - Parameter overrides (e.g., {"e.checkout.p.mean": 0.7})
 * @returns {Object} Modified graph
 */
function applyParameterOverrides(graph, parameters) {
  try {
    var modifiedGraph = JSON.parse(JSON.stringify(graph)); // Deep clone
    
    for (var reference in parameters) {
      var value = parameters[reference];
      var parsed = parseConditionalReference(reference);
      if (!parsed) continue;
      
      // Find the edge
      var edgeIndex = -1;
      for (var i = 0; i < modifiedGraph.edges.length; i++) {
        var edge = modifiedGraph.edges[i];
        if (edge.slug === parsed.edgeSlug || edge.id === parsed.edgeSlug) {
          edgeIndex = i;
          break;
        }
      }
      if (edgeIndex < 0) continue;
      
      var edge = modifiedGraph.edges[edgeIndex];
      
      if (parsed.isConditional) {
        // Apply to conditional_p
        if (!edge.conditional_p) edge.conditional_p = [];
        
        // Find or create matching conditional
        var conditionalProb = null;
        for (var j = 0; j < edge.conditional_p.length; j++) {
          var cp = edge.conditional_p[j];
          var conditionNodes = cp.condition.visited.map(function(id) {
            return resolveNodeSlug(modifiedGraph, id);
          }).sort();
          
          if (arraysEqual(conditionNodes, parsed.nodeSlugs)) {
            conditionalProb = cp;
            break;
          }
        }
        
        if (!conditionalProb) {
          // Create new conditional
          var nodeIds = parsed.nodeSlugs.map(function(slug) {
            return resolveNodeId(modifiedGraph, slug);
          });
          conditionalProb = {
            condition: { visited: nodeIds },
            p: {}
          };
          edge.conditional_p.push(conditionalProb);
        }
        
        // Update parameter
        conditionalProb.p[parsed.param] = value;
      } else {
        // Apply to base probability
        if (!edge.p) edge.p = {};
        edge.p[parsed.param] = value;
      }
    }
    
    return modifiedGraph;
  } catch (e) {
    Logger.log('Error applying parameter overrides: ' + e.message);
    return graph;
  }
}

/**
 * Parse a conditional probability reference
 * @param {string} reference - Reference like "e.edge1.p.mean" or "e.edge1.visited(node1,node2).p.mean"
 * @returns {Object|null} Parsed components or null if invalid
 */
function parseConditionalReference(reference) {
  // Base pattern: e.<edge-slug>.p.<param>
  var basePattern = /^e\.([^.]+)\.p\.(mean|stdev)$/;
  
  // Conditional pattern: e.<edge-slug>.visited(<slugs>).p.<param>
  var conditionalPattern = /^e\.([^.]+)\.visited\(([^)]+)\)\.p\.(mean|stdev)$/;
  
  // Try conditional first
  var match = reference.match(conditionalPattern);
  if (match) {
    var nodeSlugs = match[2].split(',').map(function(s) { 
      return s.trim(); 
    }).sort();
    return {
      edgeSlug: match[1],
      nodeSlugs: nodeSlugs,
      param: match[3],
      isConditional: true
    };
  }
  
  // Try base
  match = reference.match(basePattern);
  if (match) {
    return {
      edgeSlug: match[1],
      nodeSlugs: [],
      param: match[2],
      isConditional: false
    };
  }
  
  return null;
}

/**
 * Resolve node ID to slug
 * @param {Object} graph - Graph object
 * @param {string} nodeId - Node ID
 * @returns {string} Node slug or ID if not found
 */
function resolveNodeSlug(graph, nodeId) {
  for (var i = 0; i < graph.nodes.length; i++) {
    var node = graph.nodes[i];
    if (node.id === nodeId) {
      return node.slug || nodeId;
    }
  }
  return nodeId;
}

/**
 * Resolve node slug to ID
 * @param {Object} graph - Graph object
 * @param {string} slug - Node slug
 * @returns {string} Node ID or slug if not found
 */
function resolveNodeId(graph, slug) {
  for (var i = 0; i < graph.nodes.length; i++) {
    var node = graph.nodes[i];
    if (node.slug === slug || node.id === slug) {
      return node.id;
    }
  }
  return slug;
}

/**
 * Check if two arrays are equal
 * @param {Array} arr1 - First array
 * @param {Array} arr2 - Second array
 * @returns {boolean} True if arrays are equal
 */
function arraysEqual(arr1, arr2) {
  if (arr1.length !== arr2.length) return false;
  for (var i = 0; i < arr1.length; i++) {
    if (arr1[i] !== arr2[i]) return false;
  }
  return true;
}

/**
 * Compute effective visited set based on what-if data
 * @param {Object} graph - Graph object
 * @param {Object} whatIfData - What-if data with cases, assumeVisited, excludeVisited
 * @returns {Set} Set of node IDs that are effectively visited
 */
function computeEffectiveVisited(graph, whatIfData) {
  var visited = {};
  
  if (!whatIfData) return visited;
  
  // 1. Add hyperprior (from case overrides)
  if (whatIfData.cases) {
    for (var caseNodeId in whatIfData.cases) {
      var selectedVariant = whatIfData.cases[caseNodeId];
      
      // Find case node
      var caseNode = null;
      for (var i = 0; i < graph.nodes.length; i++) {
        if (graph.nodes[i].id === caseNodeId) {
          caseNode = graph.nodes[i];
          break;
        }
      }
      if (!caseNode || !caseNode.case) continue;
      
      // Find edges with this case and variant
      for (var j = 0; j < graph.edges.length; j++) {
        var edge = graph.edges[j];
        if (edge.case_id === caseNode.case.id && 
            edge.case_variant === selectedVariant) {
          visited[edge.to] = true;
        }
      }
    }
  }
  
  // 2. Add assumeVisited
  if (whatIfData.assumeVisited) {
    for (var i = 0; i < whatIfData.assumeVisited.length; i++) {
      var nodeList = whatIfData.assumeVisited[i];
      for (var j = 0; j < nodeList.length; j++) {
        var nodeSlug = nodeList[j];
        var node = null;
        for (var k = 0; k < graph.nodes.length; k++) {
          if (graph.nodes[k].slug === nodeSlug || graph.nodes[k].id === nodeSlug) {
            node = graph.nodes[k];
            break;
          }
        }
        if (node) visited[node.id] = true;
      }
    }
  }
  
  // 3. Remove excludeVisited
  if (whatIfData.excludeVisited) {
    for (var i = 0; i < whatIfData.excludeVisited.length; i++) {
      var nodeList = whatIfData.excludeVisited[i];
      for (var j = 0; j < nodeList.length; j++) {
        var nodeSlug = nodeList[j];
        var node = null;
        for (var k = 0; k < graph.nodes.length; k++) {
          if (graph.nodes[k].slug === nodeSlug || graph.nodes[k].id === nodeSlug) {
            node = graph.nodes[k];
            break;
          }
        }
        if (node) delete visited[node.id];
      }
    }
  }
  
  return visited;
}

/**
 * Get effective edge probability considering what-if overrides
 * @param {Object} edge - Edge object
 * @param {Object} graph - Graph object
 * @param {Object} effectiveVisited - Set of visited node IDs
 * @param {Object} whatIfData - What-if data with case overrides
 * @returns {number} Effective probability
 */
function getEffectiveEdgeProbability(edge, graph, effectiveVisited, whatIfData) {
  var probability = edge.p?.mean || 0;
  
  // 1. Check conditional probabilities
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    // Try to find matching condition
    for (var i = 0; i < edge.conditional_p.length; i++) {
      var conditionalProb = edge.conditional_p[i];
      if (!conditionalProb.condition || !conditionalProb.condition.visited) continue;
      
      var conditionNodes = conditionalProb.condition.visited;
      
      // Check if ALL required nodes are in effectiveVisited
      var allVisited = true;
      for (var j = 0; j < conditionNodes.length; j++) {
        if (!effectiveVisited[conditionNodes[j]]) {
          allVisited = false;
          break;
        }
      }
      
      if (allVisited) {
        // Use conditional probability
        probability = conditionalProb.p?.mean !== undefined ? 
          conditionalProb.p.mean : probability;
        break; // First match wins
      }
    }
  }
  
  // 2. Apply case variant weight if applicable
  if (edge.case_id && edge.case_variant && whatIfData && whatIfData.cases) {
    // Find the case node
    var caseNode = null;
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (node.type === 'case' && node.case && node.case.id === edge.case_id) {
        caseNode = node;
        break;
      }
    }
    
    if (caseNode && whatIfData.cases[caseNode.id]) {
      var selectedVariant = whatIfData.cases[caseNode.id];
      var variantWeight = (edge.case_variant === selectedVariant) ? 1.0 : 0.0;
      probability *= variantWeight;
    }
  }
  
  return probability;
}

/**
 * Run graph analysis with what-if support
 * @param {Object} graph - Graph object
 * @param {string} operation - Operation type (probability, cost, time)
 * @param {string} startNode - Start node slug/ID
 * @param {string} endNode - End node slug/ID or special (anySuccess, anyFailure)
 * @param {Object} whatIfData - What-if scenario data
 * @returns {number} Calculated result
 */
function runGraphAnalysis(graph, operation, startNode, endNode, whatIfData) {
  // Compute effective visited set
  var effectiveVisited = computeEffectiveVisited(graph, whatIfData);
  
  // Find start node
  var startNodeObj = null;
  for (var i = 0; i < graph.nodes.length; i++) {
    var node = graph.nodes[i];
    if (node.id === startNode || node.slug === startNode || node.label === startNode) {
      startNodeObj = node;
      break;
    }
  }
  
  if (!startNodeObj) {
    return 'Error: Start node not found: ' + startNode;
  }
  
  // Simple traversal for probability calculation
  // This is a simplified implementation - real implementation would need:
  // - Proper path traversal
  // - Monte Carlo simulation or analytical solution
  // - Handling of different operation types (cost, time)
  // - Proper end node detection
  
  if (operation === 'probability') {
    return calculateProbability(graph, startNodeObj, endNode, effectiveVisited, whatIfData);
  } else if (operation === 'cost') {
    return calculateCost(graph, startNodeObj, endNode, effectiveVisited, whatIfData);
  } else if (operation === 'time') {
    return calculateTime(graph, startNodeObj, endNode, effectiveVisited, whatIfData);
  }
  
  return 'Error: Unknown operation: ' + operation;
}

/**
 * Calculate probability from start to end node
 * NOTE: This is a simplified implementation for demonstration
 * Real implementation would need proper graph traversal algorithm
 * @param {Object} graph - Graph object
 * @param {Object} startNode - Start node object
 * @param {string} endNode - End node identifier
 * @param {Object} effectiveVisited - Effective visited set
 * @param {Object} whatIfData - What-if data
 * @returns {number} Probability
 */
function calculateProbability(graph, startNode, endNode, effectiveVisited, whatIfData) {
  // TODO: Implement proper graph traversal with conditional probability support
  // This is a placeholder that demonstrates the concept
  
  // For now, return a simple calculation based on direct edges
  var outgoingEdges = [];
  for (var i = 0; i < graph.edges.length; i++) {
    if (graph.edges[i].from === startNode.id) {
      outgoingEdges.push(graph.edges[i]);
    }
  }
  
  if (outgoingEdges.length === 0) return 0;
  
  var totalProb = 0;
  for (var i = 0; i < outgoingEdges.length; i++) {
    var edge = outgoingEdges[i];
    var prob = getEffectiveEdgeProbability(edge, graph, effectiveVisited, whatIfData);
    totalProb += prob;
  }
  
  return totalProb;
}

/**
 * Calculate cost from start to end node
 * @param {Object} graph - Graph object
 * @param {Object} startNode - Start node object
 * @param {string} endNode - End node identifier
 * @param {Object} effectiveVisited - Effective visited set
 * @param {Object} whatIfData - What-if data
 * @returns {number} Cost
 */
function calculateCost(graph, startNode, endNode, effectiveVisited, whatIfData) {
  // TODO: Implement cost calculation
  return 0;
}

/**
 * Calculate time from start to end node
 * @param {Object} graph - Graph object
 * @param {Object} startNode - Start node object
 * @param {string} endNode - End node identifier
 * @param {Object} effectiveVisited - Effective visited set
 * @param {Object} whatIfData - What-if data
 * @returns {number} Time
 */
function calculateTime(graph, startNode, endNode, effectiveVisited, whatIfData) {
  // TODO: Implement time calculation
  return 0;
}

