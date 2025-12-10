/**
 * Data Operations Sections
 * 
 * SINGLE SOURCE OF TRUTH for what data operations are available for a given selection.
 * Used by:
 * - NodeContextMenu (submenus)
 * - EdgeContextMenu (submenus)
 * - DataMenu (top menu bar items)
 * 
 * This ensures all three menus show IDENTICAL options based on the same logic.
 * 
 * NOTE: hasFile now means "file EXISTS or COULD exist" based on having an objectId.
 * The actual file content check happens at operation time (in useClearDataFile).
 * This allows menu items to be enabled even if files aren't loaded into memory.
 */

import { fileRegistry } from '../contexts/TabContext';

export interface DataOperationSection {
  id: string;                    // Unique ID for this section (e.g., 'node-file', 'case-data', 'param-p')
  label: string;                 // Display label (e.g., 'Node file', 'Case Data', 'Probability parameter')
  objectType: 'parameter' | 'case' | 'node' | 'event';
  objectId: string;              // File ID (e.g., 'my-param', 'coffee-promotion', 'node-abc')
  targetId: string;              // Graph element ID (edgeId or nodeId)
  paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
  
  // Flags
  hasFile: boolean;              // File exists in fileRegistry
  hasConnection: boolean;        // Has ANY connection (direct or file)
  hasFileConnection: boolean;    // File exists AND has connection
  canPutToFile: boolean;         // Can create/update file
  
  // Available operations (computed from flags)
  operations: {
    getFromFile: boolean;        // hasFile
    getFromSource: boolean;      // hasFileConnection
    getFromSourceDirect: boolean; // hasConnection
    putToFile: boolean;          // canPutToFile
    clearCache: boolean;         // hasFile && objectType === 'parameter'
    clearDataFile: boolean;      // hasFile && (objectType === 'parameter' || objectType === 'case')
  };
}

/**
 * Get all data operation sections for a given node selection
 */
export function getNodeDataSections(
  nodeId: string,
  graph: any
): DataOperationSection[] {
  const sections: DataOperationSection[] = [];
  
  const node = graph?.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId);
  if (!node) return sections;
  
  // 1. Node file section (if node has an id)
  if (node.id) {
    const file = fileRegistry.getFile(`node-${node.id}`);
    const hasFileLoaded = !!file;
    // hasFile = true if objectId exists (file COULD exist, even if not loaded)
    const hasFile = true; // node.id exists, so file could exist
    
    sections.push({
      id: 'node-file',
      label: 'Node file',
      objectType: 'node',
      objectId: node.id,
      targetId: nodeId,
      hasFile,
      hasConnection: false, // Nodes don't have external connections
      hasFileConnection: false,
      canPutToFile: true, // Can always put if node.id exists
      operations: {
        getFromFile: hasFileLoaded, // Need loaded file to get from it
        getFromSource: false,
        getFromSourceDirect: false,
        putToFile: true,
        clearCache: false, // Nodes don't have cached data
        clearDataFile: false, // Nodes don't have data files to clear
      },
    });
  }
  
  // 2. Case data section (if node is case type)
  if (node.case) {
    const caseId = node.case.id;
    const file = caseId ? fileRegistry.getFile(`case-${caseId}`) : null;
    const hasFileLoaded = !!file;
    // hasFile = true if caseId exists (file COULD exist, even if not loaded)
    const hasFile = !!caseId;
    // For case files, connection is at file.data.case.connection (per case-parameter-schema)
    const hasFileConnection = hasFileLoaded && !!file.data?.case?.connection;
    const hasDirectConnection = !!node.case.connection;
    const hasAnyConnection = hasDirectConnection || hasFileConnection;
    const canPutToFile = !!caseId;
    
    sections.push({
      id: 'case-data',
      label: 'Case Data',
      objectType: 'case',
      objectId: caseId || '',
      targetId: nodeId,
      hasFile,
      hasConnection: hasAnyConnection,
      hasFileConnection,
      canPutToFile,
      operations: {
        getFromFile: hasFileLoaded, // Need loaded file to get from it
        getFromSource: hasFileConnection,
        getFromSourceDirect: hasAnyConnection,
        putToFile: canPutToFile,
        clearCache: hasFile, // Can clear cache if file could exist
        clearDataFile: hasFile, // Can clear data if file could exist
      },
    });
  }
  
  return sections;
}

/**
 * Get all data operation sections for a given edge selection
 */
export function getEdgeDataSections(
  edgeId: string,
  graph: any
): DataOperationSection[] {
  const sections: DataOperationSection[] = [];
  
  const edge = graph?.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
  if (!edge) return sections;
  
  // 1. Probability parameter (edge.p) - use nested p.id only
  const parameterId = edge.p?.id;
  if (parameterId || edge.p?.connection) {
    const file = parameterId ? fileRegistry.getFile(`parameter-${parameterId}`) : null;
    const hasFileLoaded = !!file;
    // hasFile = true if parameterId exists (file COULD exist, even if not loaded)
    const hasFile = !!parameterId;
    const hasFileConnection = hasFileLoaded && !!file.data?.connection;
    const hasDirectConnection = !!edge.p?.connection;
    const hasAnyConnection = hasDirectConnection || hasFileConnection;
    const canPutToFile = !!parameterId;
    
    sections.push({
      id: 'param-p',
      label: 'Probability parameter',
      objectType: 'parameter',
      objectId: parameterId || '',
      targetId: edgeId,
      paramSlot: 'p',
      hasFile,
      hasConnection: hasAnyConnection,
      hasFileConnection,
      canPutToFile,
      operations: {
        getFromFile: hasFileLoaded, // Need loaded file to get from it
        getFromSource: hasFileConnection,
        getFromSourceDirect: hasAnyConnection,
        putToFile: canPutToFile,
        clearCache: hasFile, // Can clear cache if file could exist
        clearDataFile: hasFile, // Can clear data if file could exist
      },
    });
  }
  
  // 2. Conditional probability parameters (edge.conditional_p)
  // Create a section for EACH conditional probability
  console.log('[DataOperationsSections] Processing conditional_p:', {
    hasConditionalP: !!edge.conditional_p,
    isArray: Array.isArray(edge.conditional_p),
    length: edge.conditional_p?.length,
    entries: edge.conditional_p?.map((c: any, i: number) => ({
      index: i,
      condition: c.condition,
      conditionType: typeof c.condition,
      hasQuery: !!c.query,
      hasPConnection: !!c.p?.connection,
      baseConnection: edge.p?.connection,
    })),
  });
  
  if (edge.conditional_p && Array.isArray(edge.conditional_p)) {
    edge.conditional_p.forEach((condP: any, index: number) => {
      // String conditions are the current format (e.g., "visited(node-a)")
      // Object conditions were an older format - skip those
      if (typeof condP.condition === 'object') {
        console.log(`[DataOperationsSections] Skipping conditional_p[${index}] - object condition`);
        return;
      }
      
      const condParamId = condP.p?.id;
      // Conditional probabilities can inherit connection from base edge.p
      const condDirectConnection = condP.p?.connection;
      const baseConnection = edge.p?.connection;
      const effectiveConnection = condDirectConnection || baseConnection;
      
      // Only create section if there's a connection (direct or inherited from base)
      if (condParamId || effectiveConnection) {
        const file = condParamId ? fileRegistry.getFile(`parameter-${condParamId}`) : null;
        const hasFileLoaded = !!file;
        // hasFile = true if condParamId exists (file COULD exist, even if not loaded)
        const hasFile = !!condParamId;
        const hasFileConnection = hasFileLoaded && !!file.data?.connection;
        const hasDirectConnection = !!effectiveConnection;
        const hasAnyConnection = hasDirectConnection || hasFileConnection;
        const canPutToFile = !!condParamId;
        
        // Generate label with condition display
        const conditionDisplay = condP.condition ? 
          (typeof condP.condition === 'string' ? condP.condition : JSON.stringify(condP.condition)) :
          `#${index + 1}`;
        
        console.log(`[DataOperationsSections] Creating conditional section:`, {
          index,
          condition: conditionDisplay,
          hasAnyConnection,
          effectiveConnection,
        });
        
        sections.push({
          id: `param-conditional-${index}`,
          label: `Conditional: ${conditionDisplay}`,
          objectType: 'parameter',
          objectId: condParamId || '',
          targetId: edgeId,
          paramSlot: 'p',
          conditionalIndex: index,
          hasFile,
          hasConnection: hasAnyConnection,
          hasFileConnection,
          canPutToFile,
          operations: {
            getFromFile: hasFileLoaded, // Need loaded file to get from it
            getFromSource: hasFileConnection,
            getFromSourceDirect: hasAnyConnection,
            putToFile: canPutToFile,
            clearCache: hasFile, // Can clear cache if file could exist
            clearDataFile: hasFile, // Can clear data if file could exist
          },
        });
      } else {
        console.log(`[DataOperationsSections] Skipping conditional_p[${index}] - no connection:`, {
          condParamId,
          effectiveConnection,
        });
      }
    });
  }
  
  // 3. Cost (GBP) parameter (edge.cost_gbp) - use nested cost_gbp.id only
  const costGbpParameterId = edge.cost_gbp?.id;
  if (costGbpParameterId || edge.cost_gbp?.connection) {
    const file = costGbpParameterId ? fileRegistry.getFile(`parameter-${costGbpParameterId}`) : null;
    const hasFileLoaded = !!file;
    // hasFile = true if parameterId exists (file COULD exist, even if not loaded)
    const hasFile = !!costGbpParameterId;
    const hasFileConnection = hasFileLoaded && !!file.data?.connection;
    const hasDirectConnection = !!edge.cost_gbp?.connection;
    const hasAnyConnection = hasDirectConnection || hasFileConnection;
    const canPutToFile = !!costGbpParameterId;
    
    sections.push({
      id: 'param-cost-gbp',
      label: 'Cost (GBP)',
      objectType: 'parameter',
      objectId: costGbpParameterId || '',
      targetId: edgeId,
      paramSlot: 'cost_gbp',
      hasFile,
      hasConnection: hasAnyConnection,
      hasFileConnection,
      canPutToFile,
      operations: {
        getFromFile: hasFileLoaded, // Need loaded file to get from it
        getFromSource: hasFileConnection,
        getFromSourceDirect: hasAnyConnection,
        putToFile: canPutToFile,
        clearCache: hasFile, // Can clear cache if file could exist
        clearDataFile: hasFile, // Can clear data if file could exist
      },
    });
  }
  
  // 4. Cost (time) parameter (edge.labour_cost) - use nested labour_cost.id only
  const costTimeParameterId = edge.labour_cost?.id;
  if (costTimeParameterId || edge.labour_cost?.connection) {
    const file = costTimeParameterId ? fileRegistry.getFile(`parameter-${costTimeParameterId}`) : null;
    const hasFileLoaded = !!file;
    // hasFile = true if parameterId exists (file COULD exist, even if not loaded)
    const hasFile = !!costTimeParameterId;
    const hasFileConnection = hasFileLoaded && !!file.data?.connection;
    const hasDirectConnection = !!edge.labour_cost?.connection;
    const hasAnyConnection = hasDirectConnection || hasFileConnection;
    const canPutToFile = !!costTimeParameterId;
    
    sections.push({
      id: 'param-cost-time',
      label: 'Cost (time)',
      objectType: 'parameter',
      objectId: costTimeParameterId || '',
      targetId: edgeId,
      paramSlot: 'labour_cost',
      hasFile,
      hasConnection: hasAnyConnection,
      hasFileConnection,
      canPutToFile,
      operations: {
        getFromFile: hasFileLoaded, // Need loaded file to get from it
        getFromSource: hasFileConnection,
        getFromSourceDirect: hasAnyConnection,
        putToFile: canPutToFile,
        clearCache: hasFile, // Can clear cache if file could exist
        clearDataFile: hasFile, // Can clear data if file could exist
      },
    });
  }
  
  return sections;
}

/**
 * Get all data operation sections for current selection (node OR edge)
 */
export function getAllDataSections(
  selectedNodeId: string | null,
  selectedEdgeId: string | null,
  graph: any
): DataOperationSection[] {
  if (selectedEdgeId) {
    return getEdgeDataSections(selectedEdgeId, graph);
  } else if (selectedNodeId) {
    return getNodeDataSections(selectedNodeId, graph);
  }
  return [];
}

