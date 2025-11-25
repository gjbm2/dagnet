/**
 * Copy Vars Service
 * 
 * Extracts variables from selected nodes/edges and copies them to clipboard
 * in HRN DSL format (same as param pack snapshots).
 * 
 * Used by:
 * - Node/Edge context menus
 * - Edit menu
 */

import { extractParamsFromSelection } from './GraphParamExtractor';
import { flattenParams } from './ParamPackDSLService';
import type { Graph } from '../types';

export interface CopyVarsResult {
  success: boolean;
  count: number;
  nodeCount: number;
  edgeCount: number;
  output: string;
  error?: string;
}

/**
 * Copy variables from selected nodes and/or edges to clipboard
 * 
 * @param graph - The graph object
 * @param selectedNodeUuids - Array of selected node UUIDs
 * @param selectedEdgeUuids - Array of selected edge UUIDs
 * @returns Result with success status and counts
 */
export async function copyVarsToClipboard(
  graph: Graph | null,
  selectedNodeUuids: string[],
  selectedEdgeUuids: string[]
): Promise<CopyVarsResult> {
  try {
    if (selectedNodeUuids.length === 0 && selectedEdgeUuids.length === 0) {
      return {
        success: false,
        count: 0,
        nodeCount: 0,
        edgeCount: 0,
        output: '',
        error: 'No nodes or edges selected'
      };
    }

    // Extract params from selected nodes and edges
    const params = extractParamsFromSelection(graph, selectedNodeUuids, selectedEdgeUuids);
    
    // Flatten to HRN DSL format (same as param pack snapshot)
    const flatParams = flattenParams(params);
    
    // Format as key: value strings
    const lines: string[] = [];
    for (const [key, value] of Object.entries(flatParams)) {
      lines.push(`${key}: ${value}`);
    }
    
    const output = lines.join('\n');
    
    if (lines.length === 0) {
      return {
        success: false,
        count: 0,
        nodeCount: selectedNodeUuids.length,
        edgeCount: selectedEdgeUuids.length,
        output: '',
        error: 'No variables found in selection'
      };
    }
    
    // Copy to clipboard
    await navigator.clipboard.writeText(output);
    
    return {
      success: true,
      count: lines.length,
      nodeCount: selectedNodeUuids.length,
      edgeCount: selectedEdgeUuids.length,
      output
    };
  } catch (error) {
    console.error('Failed to copy vars:', error);
    return {
      success: false,
      count: 0,
      nodeCount: selectedNodeUuids.length,
      edgeCount: selectedEdgeUuids.length,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}




