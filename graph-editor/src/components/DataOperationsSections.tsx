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
 */

import { fileRegistry } from '../contexts/TabContext';

export interface DataOperationSection {
  id: string;                    // Unique ID for this section (e.g., 'node-file', 'case-data', 'param-p')
  label: string;                 // Display label (e.g., 'Node file', 'Case Data', 'Probability parameter')
  objectType: 'parameter' | 'case' | 'node' | 'event';
  objectId: string;              // File ID (e.g., 'my-param', 'coffee-promotion', 'node-abc')
  targetId: string;              // Graph element ID (edgeId or nodeId)
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
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
    const hasFile = !!file;
    
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
        getFromFile: hasFile,
        getFromSource: false,
        getFromSourceDirect: false,
        putToFile: true,
        clearCache: false, // Nodes don't have cached data
      },
    });
  }
  
  // 2. Case data section (if node is case type)
  if (node.case) {
    const caseId = node.case.id;
    const file = caseId ? fileRegistry.getFile(`case-${caseId}`) : null;
    const hasFile = !!file;
    // For case files, connection is at file.data.case.connection (per case-parameter-schema)
    const hasFileConnection = hasFile && !!file.data?.case?.connection;
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
        getFromFile: hasFile,
        getFromSource: hasFileConnection,
        getFromSourceDirect: hasAnyConnection,
        putToFile: canPutToFile,
        clearCache: hasFile, // Cases have schedules cache
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
    const hasFile = !!file;
    const hasFileConnection = hasFile && !!file.data?.connection;
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
        getFromFile: hasFile,
        getFromSource: hasFileConnection,
        getFromSourceDirect: hasAnyConnection,
        putToFile: canPutToFile,
        clearCache: hasFile, // Parameters have time-series cache
      },
    });
  }
  
  // 2. Conditional probability parameters (edge.conditional_p)
  // Create a section for EACH conditional probability
  if (edge.conditional_p && Array.isArray(edge.conditional_p)) {
    edge.conditional_p.forEach((condP: any, index: number) => {
      // Skip old format conditions (string-based)
      if (typeof condP.condition === 'string') return;
      
      const condParamId = condP.p?.id;
      if (condParamId || condP.p?.connection) {
        const file = condParamId ? fileRegistry.getFile(`parameter-${condParamId}`) : null;
        const hasFile = !!file;
        const hasFileConnection = hasFile && !!file.data?.connection;
        const hasDirectConnection = !!condP.p?.connection;
        const hasAnyConnection = hasDirectConnection || hasFileConnection;
        const canPutToFile = !!condParamId;
        
        // Generate label with condition display
        const conditionDisplay = condP.condition ? 
          (typeof condP.condition === 'object' ? JSON.stringify(condP.condition) : String(condP.condition)) :
          `#${index + 1}`;
        
        sections.push({
          id: `param-conditional-${index}`,
          label: `Conditional prob. ${conditionDisplay}`,
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
            getFromFile: hasFile,
            getFromSource: hasFileConnection,
            getFromSourceDirect: hasAnyConnection,
            putToFile: canPutToFile,
            clearCache: hasFile, // Parameters have time-series cache
          },
        });
      }
    });
  }
  
  // 3. Cost (GBP) parameter (edge.cost_gbp) - use nested cost_gbp.id only
  const costGbpParameterId = edge.cost_gbp?.id;
  if (costGbpParameterId || edge.cost_gbp?.connection) {
    const file = costGbpParameterId ? fileRegistry.getFile(`parameter-${costGbpParameterId}`) : null;
    const hasFile = !!file;
    const hasFileConnection = hasFile && !!file.data?.connection;
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
        getFromFile: hasFile,
        getFromSource: hasFileConnection,
        getFromSourceDirect: hasAnyConnection,
        putToFile: canPutToFile,
        clearCache: hasFile, // Parameters have time-series cache
      },
    });
  }
  
  // 4. Cost (time) parameter (edge.cost_time) - use nested cost_time.id only
  const costTimeParameterId = edge.cost_time?.id;
  if (costTimeParameterId || edge.cost_time?.connection) {
    const file = costTimeParameterId ? fileRegistry.getFile(`parameter-${costTimeParameterId}`) : null;
    const hasFile = !!file;
    const hasFileConnection = hasFile && !!file.data?.connection;
    const hasDirectConnection = !!edge.cost_time?.connection;
    const hasAnyConnection = hasDirectConnection || hasFileConnection;
    const canPutToFile = !!costTimeParameterId;
    
    sections.push({
      id: 'param-cost-time',
      label: 'Cost (time)',
      objectType: 'parameter',
      objectId: costTimeParameterId || '',
      targetId: edgeId,
      paramSlot: 'cost_time',
      hasFile,
      hasConnection: hasAnyConnection,
      hasFileConnection,
      canPutToFile,
      operations: {
        getFromFile: hasFile,
        getFromSource: hasFileConnection,
        getFromSourceDirect: hasAnyConnection,
        putToFile: canPutToFile,
        clearCache: hasFile, // Parameters have time-series cache
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

