/**
 * UpdateManager: Centralized service for all automated entity updates
 * 
 * Architecture:
 * - Level 1: 5 direction handlers (where data flows)
 * - Level 2: 4 operation types (what kind of change)
 * - Level 3: 18 mapping configurations (specific field mappings)
 * 
 * Responsibilities:
 * - Handle all data flow between graph, files, and external sources
 * - Respect override flags (don't update overridden fields)
 * - Resolve conflicts (interactive and non-interactive modes)
 * - Maintain audit trail of all updates
 * - Log events for debugging (TODO: Implement browser-compatible event system)
 * 
 * Phase: 0.3 - UpdateManager Implementation
 * Status: In Progress
 * 
 * Related Docs:
 * - PROJECT_CONNECT/CURRENT/OVERRIDE_PATTERN_DESIGN.md
 * - PROJECT_CONNECT/CURRENT/MAPPING_TYPES.md
 * - PROJECT_CONNECT/CURRENT/SCHEMA_FIELD_MAPPINGS.md
 */

// Note: Removed EventEmitter (Node.js only) - browser doesn't support it
// TODO: Implement browser-compatible event system if needed (e.g., CustomEvent)

import { generateUniqueId } from '../lib/idUtils';
import { getSiblingEdges } from '../lib/conditionalColours';
import { normalizeConstraintString } from '../lib/queryDSL';
import { sessionLogService } from './sessionLogService';
import { DEFAULT_T95_DAYS } from '../constants/statisticalConstants';
import { normalizeToUK } from '../lib/dateFormat';
import { PRECISION_DECIMAL_PLACES } from '../constants/statisticalConstants';
import { LATENCY_HORIZON_DECIMAL_PLACES } from '../constants/latency';
import { roundToDecimalPlaces } from '../utils/rounding';

// ============================================================
// TYPES & INTERFACES
// ============================================================

export type Direction =
  | 'graph_internal'      // Graph → Graph (MSMDC, cascades)
  | 'graph_to_file'       // Graph → File (save, export)
  | 'file_to_graph'       // File → Graph (pull, sync)
  | 'external_to_graph'   // External → Graph (direct update)
  | 'external_to_file';   // External → File (append history)

export type Operation = 'CREATE' | 'UPDATE' | 'APPEND' | 'DELETE';

export type SubDestination = 'parameter' | 'case' | 'node' | 'context' | 'event';

export type ConflictStrategy = 'skip' | 'overwrite' | 'error' | 'prompt';

export interface UpdateOptions {
  /** Interactive mode (shows modals for conflicts) vs batch mode */
  interactive?: boolean;
  
  /** How to handle conflicts in non-interactive mode */
  conflictStrategy?: ConflictStrategy;
  
  /** Validate only, don't actually apply changes */
  validateOnly?: boolean;

  /**
   * If true, do NOT honour target-side override flags when applying mappings.
   *
   * Intended for explicit user actions where copying between persistence domains is the point:
   * - graph → file ("Put to file")
   * - file → graph ("Get from file")
   *
   * Automated/background flows should leave this false and respect override flags.
   */
  ignoreOverrideFlags?: boolean;

  /**
   * If true, enable mappings that copy permission flags (override flags) across domains.
   *
   * This is intentionally separate from `ignoreOverrideFlags`:
   * - `ignoreOverrideFlags` bypasses override checks (force overwrite)
   * - `allowPermissionFlagCopy` only enables the *_overridden field mappings
   */
  allowPermissionFlagCopy?: boolean;
  
  /** Stop on first error or continue */
  stopOnError?: boolean;
  
  /** User context for audit trail */
  userId?: string;
  
  /** Additional metadata */
  metadata?: Record<string, any>;
}

export interface UpdateResult {
  success: boolean;
  changes?: FieldChange[];
  conflicts?: Conflict[];
  errors?: UpdateError[];
  warnings?: Warning[];
  metadata?: {
    affectedEntities?: string[];
    timestamp?: string;
    duration?: number;
  };
}

export interface FieldChange {
  field: string;
  oldValue: any;
  newValue: any;
  source: 'auto' | 'manual' | 'external';
  overridden?: boolean;
}

export interface Conflict {
  field: string;
  currentValue: any;
  newValue: any;
  lastModified?: string;
  reason: 'overridden' | 'modified_since_sync' | 'type_mismatch';
}

export interface UpdateError {
  code: string;
  message: string;
  field?: string;
  severity: 'error' | 'warning';
}

export interface Warning {
  code: string;
  message: string;
  field?: string;
}

export interface FieldMapping {
  sourceField: string;
  targetField: string;
  transform?: (value: any, source: any, target: any) => any;
  condition?: (source: any, target: any) => boolean;
  overrideFlag?: string;  // e.g., 'label_overridden'
  /** If true, this mapping only runs when caller explicitly opts in via UpdateOptions.ignoreOverrideFlags */
  requiresIgnoreOverrideFlags?: boolean;
}

export interface MappingConfiguration {
  direction: Direction;
  operation: Operation;
  subDestination?: SubDestination;
  mappings: FieldMapping[];
}

// ============================================================
// UPDATEMANAGER CLASS
// ============================================================

export class UpdateManager {
  private mappingConfigurations: Map<string, MappingConfiguration>;
  private auditLog: any[];
  
  constructor() {
    this.mappingConfigurations = new Map();
    this.auditLog = [];
    this.initializeMappings();
  }
  
  /**
   * Round a number to standard precision (PRECISION_DECIMAL_PLACES) to avoid
   * floating-point noise and ensure consistent values across the application.
   */
  private roundToDP(value: number): number {
    return roundToDecimalPlaces(value, PRECISION_DECIMAL_PLACES);
  }

  /**
   * Round latency horizons (days) to standard persisted precision.
   *
   * These are not probabilities; we intentionally use a separate precision constant
   * from `PRECISION_DECIMAL_PLACES`.
   */
  private roundHorizonDays(value: number): number {
    return roundToDecimalPlaces(value, LATENCY_HORIZON_DECIMAL_PLACES);
  }
  
  /**
   * Check if an edge parameter is locked (has external data source).
   * Locked edges should not be rebalanced automatically (in normal mode).
   * 
   * An edge is considered locked if it has:
   * - A parameter file reference (param.id)
   * - A direct connection to a data source (param.connection)
   * 
   * @param edge - The edge to check
   * @param paramSlot - Which parameter slot to check ('p', 'cost_gbp', 'labour_cost')
   * @returns true if the edge parameter is locked to external data
   */
  private isEdgeParameterLocked(edge: any, paramSlot: 'p' | 'cost_gbp' | 'labour_cost' = 'p'): boolean {
    const param = edge[paramSlot];
    return !!(param?.id || param?.connection);
  }
  
  /**
   * Internal helper: Rebalance a list of sibling edges by distributing weight among them.
   * This is the single code path for edge rebalancing - called by both force and normal modes.
   * 
   * @param nextGraph - The graph being modified
   * @param edgesToRebalance - Array of edges that should be rebalanced
   * @param remainingWeight - Total weight to distribute among these edges
   * @param clearOverrides - If true, clear mean_overridden flags
   */
  private rebalanceSiblingEdges(
    nextGraph: any,
    edgesToRebalance: any[],
    remainingWeight: number,
    clearOverrides: boolean
  ): void {
    if (edgesToRebalance.length === 0) return;
    
    // Prepare sibling items with indices for distribution
    const siblingItems = edgesToRebalance.map((sibling: any) => {
      const siblingIndex = nextGraph.edges.findIndex((e: any) => {
        // Match by UUID (most reliable)
        if (sibling.uuid && e.uuid === sibling.uuid) return true;
        // Match by ID (only if both have id defined)
        if (sibling.id && e.id && e.id === sibling.id) return true;
        // Match by composite key as fallback
        if (`${e.from}->${e.to}` === `${sibling.from}->${sibling.to}`) return true;
        return false;
      });
      return { sibling, index: siblingIndex };
    }).filter((item: any) => item.index >= 0);
    
    // Ensure p objects exist
    siblingItems.forEach((item: any) => {
      if (!nextGraph.edges[item.index].p) {
        nextGraph.edges[item.index].p = {};
      }
    });
    
    // Calculate current total from nextGraph.edges (after ensuring p objects exist)
    const currentTotal = siblingItems.reduce((sum: number, item: any) => {
      return sum + (nextGraph.edges[item.index].p?.mean || 0);
    }, 0);
    
    // Distribute with exact sum
    this.distributeWithExactSum(
      siblingItems,
      (item: any) => nextGraph.edges[item.index].p?.mean || 0,
      (item: any, value: number) => {
        nextGraph.edges[item.index].p.mean = value;
        // Also set forecast to same value so F mode has something to render.
        // For non-latency edges, p.mean = p.evidence = p.forecast (all equal).
        // For latency edges, the real forecast comes from LAG, but rebalanced
        // siblings need a fallback.
        if (!nextGraph.edges[item.index].p.forecast) {
          nextGraph.edges[item.index].p.forecast = {};
        }
        nextGraph.edges[item.index].p.forecast.mean = value;
        if (clearOverrides) {
          delete nextGraph.edges[item.index].p.mean_overridden;
        }
      },
      remainingWeight,
      currentTotal
    );
  }
  
  /**
   * Internal helper: Rebalance conditional probabilities by distributing weight among siblings.
   * Single code path for conditional probability rebalancing - called by both force and normal modes.
   * 
   * @param nextGraph - The graph being modified
   * @param edgesToRebalance - Array of edges with matching conditional probabilities
   * @param conditionStr - The condition string to match
   * @param remainingWeight - Total weight to distribute
   * @param clearOverrides - If true, clear mean_overridden flags
   */
  private rebalanceConditionalSiblings(
    nextGraph: any,
    edgesToRebalance: any[],
    conditionStr: string,
    remainingWeight: number,
    clearOverrides: boolean
  ): void {
    if (edgesToRebalance.length === 0) return;
    
    // Prepare sibling items with indices and matching conditions
    const siblingItems = edgesToRebalance.map((sibling: any) => {
      const siblingIndex = nextGraph.edges.findIndex((e: any) => {
        // Match by UUID (most reliable)
        if (sibling.uuid && e.uuid === sibling.uuid) return true;
        // Match by ID (only if both have id defined)
        if (sibling.id && e.id && e.id === sibling.id) return true;
        // Match by composite key as fallback
        if (`${e.from}->${e.to}` === `${sibling.from}->${sibling.to}`) return true;
        return false;
      });
      
      if (siblingIndex >= 0) {
        const matchingCond = nextGraph.edges[siblingIndex].conditional_p?.find((cp: any) => {
          const cpConditionStr = typeof cp.condition === 'string' ? cp.condition : '';
          return cpConditionStr === conditionStr;
        });
        if (matchingCond) {
          if (!matchingCond.p) {
            matchingCond.p = {};
          }
          return { sibling, index: siblingIndex, cond: matchingCond };
        }
      }
      return null;
    }).filter((item: any) => item !== null);
    
    // Calculate current total
    const currentTotal = siblingItems.reduce((sum: number, item: any) => {
      return sum + (item.cond.p?.mean || 0);
    }, 0);
    
    // Distribute with exact sum
    this.distributeWithExactSum(
      siblingItems,
      (item: any) => item.cond.p?.mean || 0,
      (item: any, value: number) => {
        item.cond.p.mean = value;
        if (clearOverrides) {
          delete item.cond.p.mean_overridden;
        }
      },
      remainingWeight,
      currentTotal
    );
  }
  
  /**
   * Find sibling edges for rebalancing (same source, same case_variant if applicable, has p.mean).
   * Extracted to consolidate sibling-finding logic across rebalancing methods.
   * 
   * @param graph - The graph to search
   * @param edgeId - ID of the origin edge
   * @returns Object with originEdge, siblings array, and originValue
   */
  private findSiblingsForRebalance(graph: any, edgeId: string): {
    originEdge: any | null;
    siblings: any[];
    originValue: number;
  } {
    const edgeIndex = graph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      return { originEdge: null, siblings: [], originValue: 0 };
    }
    
    const currentEdge = graph.edges[edgeIndex];
    const sourceNodeId = currentEdge.from;
    const currentEdgeId = currentEdge.uuid || currentEdge.id || `${currentEdge.from}->${currentEdge.to}`;
    const originValue = this.roundToDP(currentEdge.p?.mean ?? 0);
    
    // Find siblings (same source, different edge, has p.mean)
    const siblings = graph.edges.filter((e: any) => {
      const eId = e.uuid || e.id || `${e.from}->${e.to}`;
      if (eId === currentEdgeId) return false;
      if (e.from !== sourceNodeId) return false;
      if (e.p?.mean === undefined) return false;
      // For case edges, match case_variant
      if (currentEdge.case_variant && e.case_variant !== currentEdge.case_variant) return false;
      if (!currentEdge.case_variant && e.case_variant) return false;
      return true;
    });
    
    return { originEdge: currentEdge, siblings, originValue };
  }

  /**
   * Distribute remainingWeight proportionally among items, ensuring sum equals exactly remainingWeight.
   * Rounds all but the last item, then sets the last to make up the difference.
   * 
   * @param items - Array of items to distribute to
   * @param getCurrentValue - Function to get current value from item
   * @param setValue - Function to set new value on item
   * @param remainingWeight - Total weight to distribute (must sum to exactly this)
   * @param currentTotal - Current sum of all items (for proportional distribution)
   */
  private distributeWithExactSum(
    items: any[],
    getCurrentValue: (item: any) => number,
    setValue: (item: any, value: number) => void,
    remainingWeight: number,
    currentTotal: number
  ): void {
    if (items.length === 0) return;
    
    console.log('[UpdateManager] distributeWithExactSum:', {
      itemsCount: items.length,
      remainingWeight,
      currentTotal,
      itemsCurrentValues: items.map(item => getCurrentValue(item))
    });
    
    if (currentTotal === 0) {
      // Equal distribution
      const equalShare = this.roundToDP(remainingWeight / items.length);
      let sum = 0;
      const newValues: number[] = [];
      items.forEach((item, index) => {
        if (index === items.length - 1) {
          // Last item gets the remainder to ensure exact sum
          const lastValue = remainingWeight - sum;
          const roundedLast = this.roundToDP(lastValue);
          newValues.push(roundedLast);
          setValue(item, roundedLast);
        } else {
          newValues.push(equalShare);
          setValue(item, equalShare);
          sum += equalShare;
        }
      });
      const finalSum = newValues.reduce((s, v) => s + v, 0);
      console.log('[UpdateManager] distributeWithExactSum (equal):', {
        equalShare,
        newValues,
        finalSum,
        expectedSum: remainingWeight,
        diff: Math.abs(finalSum - remainingWeight)
      });
    } else {
      // Proportional distribution
      const unroundedValues: number[] = [];
      let sum = 0;
      
      // Calculate unrounded values
      items.forEach((item) => {
        const currentValue = getCurrentValue(item);
        const unrounded = (currentValue / currentTotal) * remainingWeight;
        unroundedValues.push(unrounded);
      });
      
      const newValues: number[] = [];
      // Round all but the last, accumulate sum
      items.forEach((item, index) => {
        if (index === items.length - 1) {
          // Last item gets the remainder to ensure exact sum
          const lastValue = remainingWeight - sum;
          const roundedLast = this.roundToDP(lastValue);
          newValues.push(roundedLast);
          setValue(item, roundedLast);
        } else {
          const rounded = this.roundToDP(unroundedValues[index]);
          newValues.push(rounded);
          setValue(item, rounded);
          sum += rounded;
        }
      });
      
      const finalSum = newValues.reduce((s, v) => s + v, 0);
      console.log('[UpdateManager] distributeWithExactSum (proportional):', {
        unroundedValues,
        newValues,
        finalSum,
        expectedSum: remainingWeight,
        diff: Math.abs(finalSum - remainingWeight)
      });
    }
  }
  
  // ============================================================
  // PROBABILITY UPDATES (unified code path)
  // ============================================================
  
  /**
   * Update edge probability (p.mean, p.stdev, etc.)
   * 
   * This is the SINGLE code path for all edge p updates from UI:
   * - Slider edits
   * - Number input edits
   * 
   * Applies consistent transforms (rounding to PRECISION_DECIMAL_PLACES) and override handling.
   * 
   * @param graph - Current graph (immutable - returns new graph)
   * @param edgeId - Edge UUID or ID
   * @param updates - Values to update (mean, stdev)
   * @param options - Control override flag behaviour
   * @returns Updated graph (new object)
   */
  updateEdgeProbability(
    graph: any,
    edgeId: string,
    updates: {
      mean?: number;
      stdev?: number;
    },
    options: {
      setOverrideFlag?: boolean;  // If true, set mean_overridden = true (for UI edits)
      respectOverrides?: boolean; // If true, skip updating if *_overridden is set
    } = {}
  ): any {
    const { setOverrideFlag = false, respectOverrides = false } = options;
    
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] updateEdgeProbability: Edge not found:', edgeId);
      return graph;
    }
    
    const edge = nextGraph.edges[edgeIndex];
    
    // Ensure p object exists
    if (!edge.p) {
      edge.p = {};
    }
    
    let changesApplied = 0;
    
    // Mean - with transform (rounding) and override handling
    if (updates.mean !== undefined) {
      const shouldSkip = respectOverrides && edge.p.mean_overridden;
      if (!shouldSkip) {
        edge.p.mean = this.roundToDP(updates.mean);
        if (setOverrideFlag) {
          edge.p.mean_overridden = true;
        }
        changesApplied++;
      }
    }
    
    // Stdev - with transform (rounding) and override handling
    if (updates.stdev !== undefined) {
      const shouldSkip = respectOverrides && edge.p.stdev_overridden;
      if (!shouldSkip) {
        edge.p.stdev = this.roundToDP(updates.stdev);
        if (setOverrideFlag) {
          edge.p.stdev_overridden = true;
        }
        changesApplied++;
      }
    }
    
    // Update metadata timestamp
    if (changesApplied > 0 && nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    return nextGraph;
  }
  
  /**
   * Update a conditional probability entry on an edge.
   * 
   * This is the SINGLE code path for all conditional_p updates:
   * - UI slider edits (EdgeContextMenu)
   * - Data from parameter files (getParameterFromFile)
   * - Data from external sources (getFromSourceDirect)
   * 
   * Applies consistent transforms (rounding to PRECISION_DECIMAL_PLACES) and override handling.
   * 
   * @param graph - Current graph (immutable - returns new graph)
   * @param edgeId - Edge UUID or ID
   * @param conditionalIndex - Index into conditional_p array
   * @param updates - Values to update (mean, stdev, evidence, data_source)
   * @param options - Control override flag behaviour
   * @returns Updated graph (new object)
   */
  updateConditionalProbability(
    graph: any,
    edgeId: string,
    conditionalIndex: number,
    updates: {
      mean?: number;
      stdev?: number;
      evidence?: { n?: number; k?: number; retrieved_at?: string; source?: string };
      data_source?: any;
    },
    options: {
      setOverrideFlag?: boolean;  // If true, set mean_overridden = true (for UI edits)
      respectOverrides?: boolean; // If true, skip updating if *_overridden is set (for data pulls)
    } = {}
  ): any {
    const { setOverrideFlag = false, respectOverrides = false } = options;
    
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] updateConditionalProbability: Edge not found:', edgeId);
      return graph;
    }
    
    const edge = nextGraph.edges[edgeIndex];
    
    if (!edge.conditional_p?.[conditionalIndex]) {
      console.warn('[UpdateManager] updateConditionalProbability: conditional_p entry not found:', {
        edgeId,
        conditionalIndex,
        conditionalPLength: edge.conditional_p?.length
      });
      return graph;
    }
    
    const condEntry = edge.conditional_p[conditionalIndex];
    
    // Ensure p object exists
    if (!condEntry.p) {
      condEntry.p = {};
    }
    
    let changesApplied = 0;
    
    // Mean - with transform (rounding) and override handling
    if (updates.mean !== undefined) {
      const shouldSkip = respectOverrides && condEntry.p.mean_overridden;
      if (!shouldSkip) {
        condEntry.p.mean = this.roundToDP(updates.mean);
        if (setOverrideFlag) {
          condEntry.p.mean_overridden = true;
        }
        changesApplied++;
      } else {
        console.log('[UpdateManager] Skipping mean update (overridden)');
      }
    }
    
    // Stdev - with transform (rounding) and override handling
    if (updates.stdev !== undefined) {
      const shouldSkip = respectOverrides && condEntry.p.stdev_overridden;
      if (!shouldSkip) {
        condEntry.p.stdev = this.roundToDP(updates.stdev);
        if (setOverrideFlag) {
          condEntry.p.stdev_overridden = true;
        }
        changesApplied++;
      } else {
        console.log('[UpdateManager] Skipping stdev update (overridden)');
      }
    }
    
    // Evidence (n, k, etc.) - no transform needed, just structured assignment
    if (updates.evidence) {
      if (!condEntry.p.evidence) {
        condEntry.p.evidence = {};
      }
      if (updates.evidence.n !== undefined) {
        condEntry.p.evidence.n = updates.evidence.n;
        changesApplied++;
      }
      if (updates.evidence.k !== undefined) {
        condEntry.p.evidence.k = updates.evidence.k;
        changesApplied++;
      }
      if (updates.evidence.retrieved_at !== undefined) {
        condEntry.p.evidence.retrieved_at = updates.evidence.retrieved_at;
        changesApplied++;
      }
      if (updates.evidence.source !== undefined) {
        condEntry.p.evidence.source = updates.evidence.source;
        changesApplied++;
      }
    }
    
    // Data source (provenance)
    if (updates.data_source) {
      condEntry.p.data_source = updates.data_source;
      changesApplied++;
    }
    
    // Update metadata timestamp
    if (changesApplied > 0 && nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    console.log('[UpdateManager] updateConditionalProbability:', {
      edgeId,
      conditionalIndex,
      updates,
      options,
      changesApplied
    });
    
    return nextGraph;
  }
  
  // ============================================================
  // LEVEL 1: DIRECTION HANDLERS (5 methods)
  // ============================================================
  
  /**
   * Flow A: Graph → Graph updates
   * Examples: MSMDC query regeneration, label cascades, copy/paste
   */
  async handleGraphInternal(
    source: any,
    target: any,
    operation: 'UPDATE',
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'graph_internal', operation });
    
    try {
      const key = this.getMappingKey('graph_internal', operation);
      const config = this.mappingConfigurations.get(key);
      
      if (!config) {
        throw new Error(`No mapping configuration for ${key}`);
      }
      
      const result = await this.applyMappings(source, target, config.mappings, options);
      
      console.log('[UpdateManager] update:complete', { direction: 'graph_internal', operation, result });
      return result;
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'graph_internal', operation, error });
      throw error;
    }
  }
  
  /**
   * Flows B-F: Graph → File operations
   * Examples: 
   * - CREATE: New parameter file from edge, new case file from node
   * - UPDATE: Metadata changes (description, query)
   * - APPEND: New value to parameter values[], new schedule to case schedules[]
   */
  async handleGraphToFile(
    source: any,
    target: any | null,
    operation: 'CREATE' | 'UPDATE' | 'APPEND',
    subDest: SubDestination,
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'graph_to_file', operation, subDest });
    const sourceId = source?.id || source?.uuid || 'unknown';
    sessionLogService.info('data-update', `GRAPH_TO_FILE_${operation}`, 
      `${operation} ${subDest} file from graph`, `Source: ${sourceId}`, { fileId: sourceId, fileType: subDest });
    
    try {
      let result: UpdateResult;
      switch (operation) {
        case 'CREATE':
          result = await this.createFileFromGraph(source, subDest, options);
          break;
        case 'UPDATE':
          result = await this.updateFileMetadata(source, target!, subDest, options);
          break;
        case 'APPEND':
          result = await this.appendToFileHistory(source, target!, subDest, options);
          break;
        default:
          throw new Error(`Unsupported operation: ${operation}`);
      }
      
      if (result.success) {
        sessionLogService.success('data-update', `GRAPH_TO_FILE_${operation}_SUCCESS`, 
          `${operation} ${subDest} file completed`, 
          result.changes?.length ? `${result.changes.length} field(s) updated` : undefined,
          { fileId: sourceId, fileType: subDest });
      }
      return result;
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'graph_to_file', operation, subDest, error });
      sessionLogService.error('data-update', `GRAPH_TO_FILE_${operation}_ERROR`, 
        `${operation} ${subDest} file failed`, 
        error instanceof Error ? error.message : String(error),
        { fileId: sourceId, fileType: subDest });
      throw error;
    }
  }
  
  /**
   * Flows G-I: File → Graph updates
   * Examples:
   * - Pull from parameter file → update edge
   * - Pull from case file → update case node
   * - Link node to registry → sync label/description/event.id
   */
  async handleFileToGraph(
    source: any,
    target: any,
    operation: 'UPDATE',
    subDest: 'parameter' | 'case' | 'node',
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'file_to_graph', operation, subDest });
    
    try {
      return await this.syncFileToGraph(source, target, subDest, options);
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'file_to_graph', operation, subDest, error });
      throw error;
    }
  }
  
  /**
   * Flows L-M: External → Graph direct updates
   * Examples:
   * - Amplitude data → update edge.p directly (no parameter file)
   * - Statsig weights → update case node directly (no case file)
   */
  async handleExternalToGraph(
    source: any,
    target: any,
    operation: 'UPDATE',
    subDest: 'parameter' | 'case',
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'external_to_graph', operation, subDest });
    const sourceId = source?.id || source?.name || 'external source';
    const targetId = target?.uuid || target?.id || 'unknown';
    sessionLogService.info('data-fetch', `EXTERNAL_TO_GRAPH_${subDest.toUpperCase()}`, 
      `Fetching ${subDest} data from external source`, `Source: ${sourceId}`, 
      { sourceType: 'external', sourceId, targetId, fileType: subDest });
    
    try {
      const result = await this.updateGraphFromExternal(source, target, subDest, options);
      if (result.success) {
        sessionLogService.success('data-fetch', `EXTERNAL_TO_GRAPH_${subDest.toUpperCase()}_SUCCESS`, 
          `Updated graph from external ${subDest} source`, 
          result.changes?.length ? `${result.changes.length} field(s) updated` : undefined,
          { sourceId, targetId, fileType: subDest });
      }
      return result;
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'external_to_graph', operation, subDest, error });
      sessionLogService.error('data-fetch', `EXTERNAL_TO_GRAPH_${subDest.toUpperCase()}_ERROR`, 
        `External ${subDest} fetch failed`, 
        error instanceof Error ? error.message : String(error),
        { sourceId, targetId, fileType: subDest });
      throw error;
    }
  }
  
  /**
   * Flows Q-R: External → File append to history
   * Examples:
   * - Amplitude data → append to parameter values[]
   * - Statsig weights → append to case schedules[]
   */
  async handleExternalToFile(
    source: any,
    target: any,
    operation: 'APPEND',
    subDest: 'parameter' | 'case',
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    console.log('[UpdateManager] update:start', { direction: 'external_to_file', operation, subDest });
    const sourceId = source?.id || source?.name || 'external source';
    const targetId = target?.id || target?.fileId || 'target file';
    sessionLogService.info('data-update', `EXTERNAL_TO_FILE_${subDest.toUpperCase()}`, 
      `Appending external ${subDest} data to file`, 
      `Source: ${sourceId}, Target: ${targetId}`,
      { sourceType: 'external', sourceId, fileId: targetId, fileType: subDest });
    
    try {
      const result = await this.appendExternalToFile(source, target, subDest, options);
      if (result.success) {
        sessionLogService.success('data-update', `EXTERNAL_TO_FILE_${subDest.toUpperCase()}_SUCCESS`, 
          `Appended external data to ${subDest} file`, 
          result.changes?.length ? `${result.changes.length} item(s) appended` : undefined,
          { sourceId, fileId: targetId, fileType: subDest });
      }
      return result;
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'external_to_file', operation, subDest, error });
      sessionLogService.error('data-update', `EXTERNAL_TO_FILE_${subDest.toUpperCase()}_ERROR`, 
        `Append external data to ${subDest} file failed`, 
        error instanceof Error ? error.message : String(error),
        { sourceId, fileId: targetId, fileType: subDest });
      throw error;
    }
  }
  
  // ============================================================
  // LEVEL 2: OPERATION IMPLEMENTATIONS
  // ============================================================
  
  private async createFileFromGraph(
    graphEntity: any,
    subDest: SubDestination,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      success: true,
      changes: [],
      conflicts: [],
      errors: [],
      warnings: []
    };
    
    try {
      // 1. Get field mappings for CREATE operation
      const key = this.getMappingKey('graph_to_file', 'CREATE', subDest);
      const config = this.mappingConfigurations.get(key);
      
      if (!config) {
        throw new Error(`No mapping configuration for ${key}`);
      }
      
      // 2. Create new file structure
      const newFile: any = {};
      
      // 3. Apply mappings to populate file from graph entity
      for (const mapping of config.mappings) {
        try {
          const sourceValue = this.getNestedValue(graphEntity, mapping.sourceField);
          
          if (sourceValue !== undefined) {
            const transformedValue = mapping.transform
              ? mapping.transform(sourceValue, graphEntity, newFile)
              : sourceValue;
            
            this.setNestedValue(newFile, mapping.targetField, transformedValue);
            
            result.changes!.push({
              field: mapping.targetField,
              oldValue: undefined,
              newValue: transformedValue,
              source: 'manual'
            });
          }
        } catch (error) {
          result.errors!.push({
            code: 'MAPPING_ERROR',
            message: `Failed to map ${mapping.sourceField}: ${error}`,
            field: mapping.targetField,
            severity: 'error'
          });
        }
      }
      
      // 4. In validateOnly mode, don't actually write
      if (!options.validateOnly) {
        // TODO: Actual file write would happen here in Phase 1
        // await fs.writeFile(filePath, yaml.stringify(newFile));
        this.recordUpdate('CREATE', 'graph_to_file', subDest, graphEntity, newFile);
      }
      
      result.success = result.errors!.length === 0;
      return result;
    } catch (error) {
      result.success = false;
      result.errors!.push({
        code: 'CREATE_ERROR',
        message: `Failed to create file: ${error}`,
        severity: 'error'
      });
      return result;
    }
  }
  
  private async updateFileMetadata(
    graphEntity: any,
    existingFile: any,
    subDest: SubDestination,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // Phase 2: capture pre-state for transition-based default injection
    const prevLatencyParameter =
      subDest === 'parameter'
        ? (existingFile?.latency?.latency_parameter === true)
        : false;

    // Get field mappings for UPDATE operation
    const key = this.getMappingKey('graph_to_file', 'UPDATE', subDest);
    const config = this.mappingConfigurations.get(key);
    
    if (!config) {
      throw new Error(`No mapping configuration for ${key}`);
    }
    
    // Apply mappings (metadata fields only, not history arrays)
    const result = await this.applyMappings(
      graphEntity,
      existingFile,
      config.mappings,
      options
    );

    // =========================================================================
    // Phase 2: Default injection (t95) on latency enablement
    //
    // Requirement: When latency_parameter transitions to true, and t95 is missing and
    // not overridden, inject DEFAULT_T95_DAYS so the horizon is immediately available
    // and will persist via the dirty-file mechanism.
    // =========================================================================
    if (subDest === 'parameter' && !options.validateOnly) {
      const nextLatencyParameter = existingFile?.latency?.latency_parameter === true;
      const transitionedOn = !prevLatencyParameter && nextLatencyParameter;

      if (transitionedOn) {
        const t95Overridden = graphEntity?.p?.latency?.t95_overridden === true;
        const fileT95 = existingFile?.latency?.t95;
        const hasValidT95 = typeof fileT95 === 'number' && isFinite(fileT95) && fileT95 > 0;

        if (!t95Overridden && !hasValidT95) {
          // Ensure latency block exists
          if (!existingFile.latency) existingFile.latency = {};
          existingFile.latency.t95 = DEFAULT_T95_DAYS;

          result.changes = result.changes ?? [];
          result.changes.push({
            field: 'latency.t95',
            oldValue: fileT95,
            newValue: DEFAULT_T95_DAYS,
            source: 'system',
          } as any);
        }
      }
    }
    
    // Record audit trail
    if (!options.validateOnly && result.success) {
      this.recordUpdate('UPDATE', 'graph_to_file', subDest, graphEntity, existingFile);
    }
    
    return result;
  }
  
  private async appendToFileHistory(
    graphEntity: any,
    existingFile: any,
    subDest: SubDestination,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      success: true,
      changes: [],
      conflicts: [],
      errors: [],
      warnings: []
    };
    
    try {
      // Get field mappings for APPEND operation
      const key = this.getMappingKey('graph_to_file', 'APPEND', subDest);
      const config = this.mappingConfigurations.get(key);
      
      if (!config) {
        throw new Error(`No mapping configuration for ${key}`);
      }
      
      // Apply mappings (will use values[] or schedules[] syntax)
      for (const mapping of config.mappings) {
        try {
          const sourceValue = this.getNestedValue(graphEntity, mapping.sourceField);
          
          console.log('[UpdateManager] APPEND mapping check:', {
            sourceField: mapping.sourceField,
            sourceValue,
            hasCondition: !!mapping.condition,
            conditionPassed: mapping.condition ? mapping.condition(graphEntity, existingFile) : true
          });
          
          // Check condition
          if (mapping.condition && !mapping.condition(graphEntity, existingFile)) {
            console.log('[UpdateManager] APPEND mapping SKIPPED (condition false)');
            continue;
          }
          
          if (sourceValue !== undefined) {
            const transformedValue = mapping.transform
              ? mapping.transform(sourceValue, graphEntity, existingFile)
              : sourceValue;
            
            console.log('[UpdateManager] APPEND mapping APPLYING:', {
              sourceField: mapping.sourceField,
              transformedValue
            });
            
            // Set value (will append due to [] syntax in targetField)
            if (!options.validateOnly) {
              this.setNestedValue(existingFile, mapping.targetField, transformedValue);
            }
            
            result.changes!.push({
              field: mapping.targetField,
              oldValue: undefined,
              newValue: transformedValue,
              source: 'manual'
            });
          }
        } catch (error) {
          result.errors!.push({
            code: 'APPEND_ERROR',
            message: `Failed to append ${mapping.sourceField}: ${error}`,
            field: mapping.targetField,
            severity: 'error'
          });
        }
      }
      
      // Record audit trail
      if (!options.validateOnly && result.success) {
        this.recordUpdate('APPEND', 'graph_to_file', subDest, graphEntity, existingFile);
      }
      
      result.success = result.errors!.length === 0;
      return result;
    } catch (error) {
      result.success = false;
      result.errors!.push({
        code: 'APPEND_ERROR',
        message: `Failed to append to file: ${error}`,
        severity: 'error'
      });
      return result;
    }
  }
  
  private async syncFileToGraph(
    fileData: any,
    graphEntity: any,
    subDest: 'parameter' | 'case' | 'node',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const key = this.getMappingKey('file_to_graph', 'UPDATE', subDest);
    const config = this.mappingConfigurations.get(key);
    
    if (!config) {
      throw new Error(`No mapping configuration for ${key}`);
    }
    
    const result = await this.applyMappings(fileData, graphEntity, config.mappings, options);
    
    // AUTO-REBALANCE: After parameter update from file pull, rebalance siblings
    // This applies to "Get from file" - if p(A>B) gets updated, auto-compute p(A>C)
    // NOTE: Set flag even when validateOnly=true, because caller uses this to decide rebalancing
    if (result.success && subDest === 'parameter') {
      // Check if p.mean was actually updated
      const pMeanUpdated = result.changes?.some(change => change.field === 'p.mean');
      if (pMeanUpdated) {
        result.metadata = result.metadata || {};
        (result.metadata as any).requiresSiblingRebalance = true;
        (result.metadata as any).updatedEdgeId = graphEntity.uuid || graphEntity.id;
        (result.metadata as any).updatedField = 'p.mean';
      }
    }
    
    // AUTO-REBALANCE: After case variant update from file, rebalance variants
    // This applies to "Get from Source" (versioned) - if treatment weight changes from file, rebalance control weight
    // NOTE: Set flag even when validateOnly=true, because caller uses this to decide rebalancing
    if (result.success && subDest === 'case') {
      // Check if case.variants was actually updated
      const variantsUpdated = result.changes?.some(change => change.field === 'case.variants');
      if (variantsUpdated) {
        result.metadata = result.metadata || {};
        (result.metadata as any).requiresVariantRebalance = true;
        (result.metadata as any).updatedNodeId = graphEntity.uuid || graphEntity.id;
        (result.metadata as any).updatedField = 'case.variants';
      }
    }
    
    return result;
  }
  
  private async updateGraphFromExternal(
    externalData: any,
    graphEntity: any,
    subDest: 'parameter' | 'case',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const key = this.getMappingKey('external_to_graph', 'UPDATE', subDest);
    const config = this.mappingConfigurations.get(key);
    
    if (!config) {
      throw new Error(`No mapping configuration for ${key}`);
    }
    
    const result = await this.applyMappings(externalData, graphEntity, config.mappings, options);
    
    // AUTO-REBALANCE: After parameter update from external source, rebalance siblings
    // This applies to DAS (Amplitude, etc.) - if p(A>B) gets data, auto-compute p(A>C)
    // NOTE: Set flag even when validateOnly=true, because caller uses this to decide rebalancing
    if (result.success && subDest === 'parameter') {
      // Check if p.mean was actually updated
      const pMeanUpdated = result.changes?.some(change => change.field === 'p.mean');
      if (pMeanUpdated) {
        result.metadata = result.metadata || {};
        (result.metadata as any).requiresSiblingRebalance = true;
        (result.metadata as any).updatedEdgeId = graphEntity.uuid || graphEntity.id;
        (result.metadata as any).updatedField = 'p.mean';
      }
    }
    
    // AUTO-REBALANCE: After case variant update from external source, rebalance variants
    // This applies to Statsig - if treatment weight changes, rebalance control weight
    // NOTE: Set flag even when validateOnly=true, because caller uses this to decide rebalancing
    if (result.success && subDest === 'case') {
      // Check if case.variants was actually updated
      const variantsUpdated = result.changes?.some(change => change.field === 'case.variants');
      if (variantsUpdated) {
        result.metadata = result.metadata || {};
        (result.metadata as any).requiresVariantRebalance = true;
        (result.metadata as any).updatedNodeId = graphEntity.uuid || graphEntity.id;
        (result.metadata as any).updatedField = 'case.variants';
      }
    }
    
    return result;
  }
  
  private async appendExternalToFile(
    externalData: any,
    fileData: any,
    subDest: 'parameter' | 'case',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      success: true,
      changes: [],
      conflicts: [],
      errors: [],
      warnings: []
    };
    
    try {
      // Get field mappings for external append
      const key = this.getMappingKey('external_to_file', 'APPEND', subDest);
      const config = this.mappingConfigurations.get(key);
      
      if (!config) {
        throw new Error(`No mapping configuration for ${key}`);
      }
      
      // Apply mappings (will transform external data and append to file)
      for (const mapping of config.mappings) {
        try {
          const sourceValue = this.getNestedValue(externalData, mapping.sourceField);
          
          if (sourceValue !== undefined) {
            const transformedValue = mapping.transform
              ? mapping.transform(sourceValue, externalData, fileData)
              : sourceValue;
            
            // Append to file (will append due to [] syntax)
            if (!options.validateOnly) {
              this.setNestedValue(fileData, mapping.targetField, transformedValue);
            }
            
            result.changes!.push({
              field: mapping.targetField,
              oldValue: undefined,
              newValue: transformedValue,
              source: 'external'
            });
          }
        } catch (error) {
          result.errors!.push({
            code: 'EXTERNAL_APPEND_ERROR',
            message: `Failed to append external data: ${error}`,
            field: mapping.targetField,
            severity: 'error'
          });
        }
      }
      
      // Record audit trail
      if (!options.validateOnly && result.success) {
        this.recordUpdate('APPEND', 'external_to_file', subDest, externalData, fileData);
      }
      
      result.success = result.errors!.length === 0;
      return result;
    } catch (error) {
      result.success = false;
      result.errors!.push({
        code: 'EXTERNAL_APPEND_ERROR',
        message: `Failed to append external data: ${error}`,
        severity: 'error'
      });
      return result;
    }
  }
  
  // ============================================================
  // CORE LOGIC: APPLY MAPPINGS WITH OVERRIDE RESPECT
  // ============================================================
  
  /**
   * Apply field mappings from source to target, respecting override flags
   */
  private async applyMappings(
    source: any,
    target: any,
    mappings: FieldMapping[],
    options: UpdateOptions
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      success: true,
      changes: [],
      conflicts: [],
      errors: [],
      warnings: []
    };
    
    for (const mapping of mappings) {
      try {
        // Get values first for logging
        const sourceValue = this.getNestedValue(source, mapping.sourceField);
        
        console.log('[UpdateManager.applyMappings] Processing mapping:', {
          sourceField: mapping.sourceField,
          targetField: mapping.targetField,
          sourceValue,
          hasCondition: !!mapping.condition,
          hasOverrideFlag: !!mapping.overrideFlag
        });
        
        // Check condition
        if (mapping.condition && !mapping.condition(source, target)) {
          console.log('[UpdateManager.applyMappings] SKIPPED - condition failed');
          continue;
        }

        // Back-compat: historically these mappings were gated on ignoreOverrideFlags.
        // New behaviour: enable them when caller opts into permission copying, without necessarily
        // bypassing override checks for value fields.
        const allowPermissionCopy = options.allowPermissionFlagCopy === true || options.ignoreOverrideFlags === true;
        if (mapping.requiresIgnoreOverrideFlags && !allowPermissionCopy) {
          console.log('[UpdateManager.applyMappings] SKIPPED - requiresIgnoreOverrideFlags (permission copy not enabled)');
          continue;
        }
        
        // Check override flag (unless explicitly bypassed by caller)
        if (!options.ignoreOverrideFlags && mapping.overrideFlag) {
          const isOverridden = this.getNestedValue(target, mapping.overrideFlag);
          if (isOverridden) {
            console.log('[UpdateManager.applyMappings] SKIPPED - overridden flag set');
            result.conflicts!.push({
              field: mapping.targetField,
              currentValue: this.getNestedValue(target, mapping.targetField),
              newValue: sourceValue,
              reason: 'overridden'
            });
            continue; // Skip overridden fields
          }
        }
        
        const currentValue = this.getNestedValue(target, mapping.targetField);
        
        // Transform if needed
        const newValue = mapping.transform 
          ? mapping.transform(sourceValue, source, target)
          : sourceValue;
        
        // Skip if no usable data (undefined means "can't calculate, don't update")
        if (newValue === undefined) {
          console.log('[UpdateManager.applyMappings] SKIPPED - newValue is undefined');
          continue;
        }
        
        // Check for changes
        if (newValue !== currentValue) {
          console.log('[UpdateManager.applyMappings] APPLYING change:', {
            targetField: mapping.targetField,
            oldValue: currentValue,
            newValue
          });
          
          if (!options.validateOnly) {
            this.setNestedValue(target, mapping.targetField, newValue);
          }
          
          result.changes!.push({
            field: mapping.targetField,
            oldValue: currentValue,
            newValue: newValue,
            source: 'auto',
            overridden: false
          });
        } else {
          console.log('[UpdateManager.applyMappings] SKIPPED - no change (same value)');
        }
      } catch (error) {
        console.error('[UpdateManager.applyMappings] ERROR:', {
          sourceField: mapping.sourceField,
          targetField: mapping.targetField,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        
        result.errors!.push({
          code: 'MAPPING_ERROR',
          message: `Failed to map ${mapping.sourceField} → ${mapping.targetField}: ${error}`,
          field: mapping.targetField,
          severity: 'error'
        });
        
        if (options.stopOnError) {
          result.success = false;
          return result;
        }
      }
    }
    
    result.success = result.errors!.length === 0;
    
    console.log('[UpdateManager.applyMappings] FINAL RESULT:', {
      success: result.success,
      changesCount: result.changes?.length,
      errorsCount: result.errors?.length,
      errors: result.errors
    });
    
    return result;
  }
  
  // ============================================================
  // LEVEL 3: MAPPING CONFIGURATIONS (18 configs)
  // ============================================================
  
  private initializeMappings() {
    /**
     * Initialize all 18 mapping configurations
     * Based on validated field mappings from SCHEMA_FIELD_MAPPINGS.md (Phase 0.2)
     */
    
    // ============================================================
    // Flow A: Graph Internal (MSMDC, cascades)
    // ============================================================
    
    this.addMapping('graph_internal', 'UPDATE', undefined, [
      // MSMDC query regeneration handled separately
      // Label cascades handled by graph editor directly
    ]);
    
    // ============================================================
    // Flows B-F: Graph → File
    // ============================================================
    
    // Flow B.CREATE: Graph → File/Parameter (CREATE new file)
    // Note: When creating a new param file, we initialize its name/description from the edge
    // as a sensible default. This is different from GET, where we don't overwrite edge metadata.
    this.addMapping('graph_to_file', 'CREATE', 'parameter', [
      { sourceField: 'id', targetField: 'id' },
      { sourceField: 'label', targetField: 'name' },
      { sourceField: 'description', targetField: 'description' },
      { sourceField: 'query', targetField: 'query' },
      // Connection settings: initialize from graph if present
      // Probability parameter connection
      { 
        sourceField: 'p.connection', 
        targetField: 'connection',
        condition: (source) => !!source.p?.connection && source.p?.id
      },
      { 
        sourceField: 'p.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.p?.connection_string && source.p?.id
      },
      // Cost GBP parameter connection
      { 
        sourceField: 'cost_gbp.connection', 
        targetField: 'connection',
        condition: (source) => !!source.cost_gbp?.connection && source.cost_gbp?.id
      },
      { 
        sourceField: 'cost_gbp.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.cost_gbp?.connection_string && source.cost_gbp?.id
      },
      // Cost Time parameter connection
      { 
        sourceField: 'labour_cost.connection', 
        targetField: 'connection',
        condition: (source) => !!source.labour_cost?.connection && source.labour_cost?.id
      },
      { 
        sourceField: 'labour_cost.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.labour_cost?.connection_string && source.labour_cost?.id
      },
      // Type field: determine from which edge param is populated
      { 
        sourceField: 'p', 
        targetField: 'parameter_type',
        condition: (source) => !!source.p?.id,
        transform: () => 'probability'
      },
      { 
        sourceField: 'cost_gbp', 
        targetField: 'parameter_type',
        condition: (source) => !!source.cost_gbp?.id,
        transform: () => 'cost_gbp'
      },
      { 
        sourceField: 'labour_cost', 
        targetField: 'parameter_type',
        condition: (source) => !!source.labour_cost?.id,
        transform: () => 'labour_cost'
      },
      // Initial values: populate from whichever param type exists
      { 
        sourceField: 'p.mean', 
        targetField: 'values[0]',
        condition: (source) => !!source.p?.id,
        transform: (value, source) => ({
          mean: value,
          stdev: source.p.stdev,
          distribution: source.p.distribution,
          n: source.p.evidence?.n,
          k: source.p.evidence?.k,
          window_from: source.p.evidence?.window_from || normalizeToUK(new Date().toISOString()),
          window_to: source.p.evidence?.window_to
        })
      },
      { 
        sourceField: 'cost_gbp.mean', 
        targetField: 'values[0]',
        condition: (source) => !!source.cost_gbp?.id,
        transform: (value, source) => ({
          mean: value,
          stdev: source.cost_gbp.stdev,
          distribution: source.cost_gbp.distribution,
          window_from: source.cost_gbp.evidence?.window_from || normalizeToUK(new Date().toISOString()),
          window_to: source.cost_gbp.evidence?.window_to
        })
      },
      { 
        sourceField: 'labour_cost.mean', 
        targetField: 'values[0]',
        condition: (source) => !!source.labour_cost?.id,
        transform: (value, source) => ({
          mean: value,
          stdev: source.labour_cost.stdev,
          distribution: source.labour_cost.distribution,
          window_from: source.labour_cost.evidence?.window_from || normalizeToUK(new Date().toISOString()),
          window_to: source.labour_cost.evidence?.window_to
        })
      }
    ]);
    
    // Flow B.UPDATE: Graph → File/Parameter (UPDATE metadata)
    // NOTE: Connection settings always sync from graph to file (file doesn't have override flags)
    // If graph has overridden connection, PUT will update file to match graph's override
    // NOTE: query and description respect file-side override flags
    this.addMapping('graph_to_file', 'UPDATE', 'parameter', [
      { 
        sourceField: 'description', 
        targetField: 'description',
        overrideFlag: 'metadata.description_overridden' // Respect file-side override
      },
      { 
        sourceField: 'query', 
        targetField: 'query',
        overrideFlag: 'query_overridden' // Respect file-side override
      },
      // Copy override flags on explicit PUT (graph → file).
      // NOTE: This mapping does not mutate permissions in automated flows because callers must opt in
      // via `ignoreOverrideFlags` (see UpdateOptions).
      {
        sourceField: 'query_overridden',
        targetField: 'query_overridden',
        requiresIgnoreOverrideFlags: true,
        condition: (source) => source.query_overridden !== undefined
      },
      {
        sourceField: 'n_query',
        targetField: 'n_query',
        overrideFlag: 'n_query_overridden',
        condition: (source) => source.n_query !== undefined
      },
      {
        sourceField: 'n_query_overridden',
        targetField: 'n_query_overridden',
        requiresIgnoreOverrideFlags: true,
        condition: (source) => source.n_query_overridden !== undefined
      },
      // Connection settings: always sync from graph to file
      // Probability parameter connection
      { 
        sourceField: 'p.connection', 
        targetField: 'connection',
        condition: (source) => !!source.p?.connection && source.p?.id
      },
      { 
        sourceField: 'p.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.p?.connection_string && source.p?.id
      },
      // Cost GBP parameter connection
      { 
        sourceField: 'cost_gbp.connection', 
        targetField: 'connection',
        condition: (source) => !!source.cost_gbp?.connection && source.cost_gbp?.id
      },
      { 
        sourceField: 'cost_gbp.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.cost_gbp?.connection_string && source.cost_gbp?.id
      },
      // Cost Time parameter connection
      { 
        sourceField: 'labour_cost.connection', 
        targetField: 'connection',
        condition: (source) => !!source.labour_cost?.connection && source.labour_cost?.id
      },
      { 
        sourceField: 'labour_cost.connection_string', 
        targetField: 'connection_string',
        condition: (source) => !!source.labour_cost?.connection_string && source.labour_cost?.id
      },
      
      // LAG: Latency CONFIG fields (graph → file, bidirectional)
      // latency_parameter: explicit enablement flag
      { 
        sourceField: 'p.latency.latency_parameter', 
        targetField: 'latency.latency_parameter',
        overrideFlag: 'latency.latency_parameter_overridden',
        condition: (source) => source.p?.latency?.latency_parameter !== undefined && source.p?.id
      },
      {
        sourceField: 'p.latency.latency_parameter_overridden',
        targetField: 'latency.latency_parameter_overridden',
        requiresIgnoreOverrideFlags: true,
        condition: (source) => source.p?.latency?.latency_parameter_overridden !== undefined && source.p?.id
      },
      { 
        sourceField: 'p.latency.anchor_node_id', 
        targetField: 'latency.anchor_node_id',
        overrideFlag: 'latency.anchor_node_id_overridden',
        condition: (source) => source.p?.latency?.anchor_node_id !== undefined && source.p?.id
      },
      {
        sourceField: 'p.latency.anchor_node_id_overridden',
        targetField: 'latency.anchor_node_id_overridden',
        requiresIgnoreOverrideFlags: true,
        condition: (source) => source.p?.latency?.anchor_node_id_overridden !== undefined && source.p?.id
      },
      // t95 and path_t95: horizon fields (derived but user-overridable)
      { 
        sourceField: 'p.latency.t95', 
        targetField: 'latency.t95',
        overrideFlag: 'latency.t95_overridden',
        condition: (source) => source.p?.latency?.t95 !== undefined && source.p?.id,
        transform: (value: number) => this.roundHorizonDays(value)
      },
      {
        sourceField: 'p.latency.t95_overridden',
        targetField: 'latency.t95_overridden',
        requiresIgnoreOverrideFlags: true,
        condition: (source) => source.p?.latency?.t95_overridden !== undefined && source.p?.id
      },
      { 
        sourceField: 'p.latency.path_t95', 
        targetField: 'latency.path_t95',
        overrideFlag: 'latency.path_t95_overridden',
        condition: (source) => source.p?.latency?.path_t95 !== undefined && source.p?.id,
        transform: (value: number) => this.roundHorizonDays(value)
      },
      {
        sourceField: 'p.latency.path_t95_overridden',
        targetField: 'latency.path_t95_overridden',
        requiresIgnoreOverrideFlags: true,
        condition: (source) => source.p?.latency?.path_t95_overridden !== undefined && source.p?.id
      }
    ]);
    
    // Flow B.APPEND: Graph → File/Parameter (APPEND new value)
    this.addMapping('graph_to_file', 'APPEND', 'parameter', [
      // Probability parameter: edge.p.* → parameter.values[]
      // Preserve all relevant fields including evidence data if present
      // NOTE: Do NOT include daily values (n_daily, k_daily, dates) - those are only from external data pulls
      // NOTE: conditional_probability type is treated identically to probability (PARITY PRINCIPLE)
      { 
        sourceField: 'p.mean', 
        targetField: 'values[]',
        condition: (source, target) => target.type === 'probability' || target.type === 'conditional_probability' || target.parameter_type === 'probability' || target.parameter_type === 'conditional_probability',
        transform: (value, source) => {
          const entry: any = { mean: value };
          
          // Statistical fields
          if (source.p.stdev !== undefined) entry.stdev = source.p.stdev;
          if (source.p.distribution) entry.distribution = source.p.distribution;
          
          // Evidence fields (if present - from data pulls)
          // NOTE: Do NOT include n_daily/k_daily/dates - those are only for external data pulls
          // Only include evidence if it's from a data_source (not stale from previous GET)
          // Manual edits should NOT include stale evidence - check if data_source exists and is not manual
          if (source.p.evidence && source.p.data_source && source.p.data_source.type && source.p.data_source.type !== 'manual') {
            if (source.p.evidence.n !== undefined) entry.n = source.p.evidence.n;
            if (source.p.evidence.k !== undefined) entry.k = source.p.evidence.k;
            if (source.p.evidence.window_from) entry.window_from = source.p.evidence.window_from;
            if (source.p.evidence.window_to) entry.window_to = source.p.evidence.window_to;
          }
          
          // If no evidence window_from, use current time
          if (!entry.window_from) {
            entry.window_from = new Date().toISOString();
          }
          
          // Data source: preserve from edge if exists, otherwise mark as manual
          if (source.p.data_source) {
            entry.data_source = source.p.data_source;
          } else if (source.p.evidence?.source) {
            // If evidence has source info, construct data_source from evidence
            entry.data_source = {
              type: source.p.evidence.source,
              retrieved_at: source.p.evidence.retrieved_at || new Date().toISOString(),
              full_query: source.p.evidence.full_query,
              debug_trace: source.p.evidence.debug_trace
            };
          } else {
            // Manual edit - no evidence or data_source
            entry.data_source = {
              type: 'manual',
              edited_at: new Date().toISOString()
            };
          }
          
          return entry;
        }
      },
      // Cost GBP parameter: edge.cost_gbp.* → parameter.values[]
      { 
        sourceField: 'cost_gbp.mean', 
        targetField: 'values[]',
        condition: (source, target) => target.type === 'cost_gbp' || target.parameter_type === 'cost_gbp',
        transform: (value, source) => {
          const entry: any = { mean: value };
          
          // Statistical fields
          if (source.cost_gbp.stdev !== undefined) entry.stdev = source.cost_gbp.stdev;
          if (source.cost_gbp.distribution) entry.distribution = source.cost_gbp.distribution;
          
          // Evidence fields (if present - from data pulls)
          if (source.cost_gbp.evidence) {
            if (source.cost_gbp.evidence.n !== undefined) entry.n = source.cost_gbp.evidence.n;
            if (source.cost_gbp.evidence.k !== undefined) entry.k = source.cost_gbp.evidence.k;
            if (source.cost_gbp.evidence.window_from) entry.window_from = source.cost_gbp.evidence.window_from;
            if (source.cost_gbp.evidence.window_to) entry.window_to = source.cost_gbp.evidence.window_to;
          }
          
          // If no evidence window_from, use current time
          if (!entry.window_from) {
            entry.window_from = new Date().toISOString();
          }
          
          // Data source: preserve from edge if exists, otherwise mark as manual
          if (source.cost_gbp.data_source) {
            entry.data_source = source.cost_gbp.data_source;
          } else if (source.cost_gbp.evidence?.source) {
            entry.data_source = {
              type: source.cost_gbp.evidence.source,
              retrieved_at: source.cost_gbp.evidence.retrieved_at || new Date().toISOString(),
              full_query: source.cost_gbp.evidence.full_query,
              debug_trace: source.cost_gbp.evidence.debug_trace
            };
          } else {
            entry.data_source = {
              type: 'manual',
              edited_at: new Date().toISOString()
            };
          }
          
          return entry;
        }
      },
      // Cost Time parameter: edge.labour_cost.* → parameter.values[]
      { 
        sourceField: 'labour_cost.mean', 
        targetField: 'values[]',
        condition: (source, target) => target.type === 'labour_cost' || target.parameter_type === 'labour_cost',
        transform: (value, source) => {
          const entry: any = { mean: value };
          
          // Statistical fields
          if (source.labour_cost.stdev !== undefined) entry.stdev = source.labour_cost.stdev;
          if (source.labour_cost.distribution) entry.distribution = source.labour_cost.distribution;
          
          // Evidence fields (if present - from data pulls)
          if (source.labour_cost.evidence) {
            if (source.labour_cost.evidence.n !== undefined) entry.n = source.labour_cost.evidence.n;
            if (source.labour_cost.evidence.k !== undefined) entry.k = source.labour_cost.evidence.k;
            if (source.labour_cost.evidence.window_from) entry.window_from = source.labour_cost.evidence.window_from;
            if (source.labour_cost.evidence.window_to) entry.window_to = source.labour_cost.evidence.window_to;
          }
          
          // If no evidence window_from, use current time
          if (!entry.window_from) {
            entry.window_from = new Date().toISOString();
          }
          
          // Data source: preserve from edge if exists, otherwise mark as manual
          if (source.labour_cost.data_source) {
            entry.data_source = source.labour_cost.data_source;
          } else if (source.labour_cost.evidence?.source) {
            entry.data_source = {
              type: source.labour_cost.evidence.source,
              retrieved_at: source.labour_cost.evidence.retrieved_at || new Date().toISOString(),
              full_query: source.labour_cost.evidence.full_query,
              debug_trace: source.labour_cost.evidence.debug_trace
            };
          } else {
            entry.data_source = {
              type: 'manual',
              edited_at: new Date().toISOString()
            };
          }
          
          return entry;
        }
      }
      
      // NOTE: Conditional probabilities (edge.conditional_p[i].p) reuse the same mappings above
      // The dataOperationsService must pass conditional_p[i].p (the ProbabilityParam object) as the source
      // This way, the probability parameter mappings work for both edge.p and edge.conditional_p[i].p
    ]);
    
    // Flow C.CREATE: Graph → File/Case (CREATE new file)
    // Note: When creating a new case file, we pre-populate it with helpful defaults from the graph
    // User will then edit the form and save. After that, case file and node metadata are independent.
    this.addMapping('graph_to_file', 'CREATE', 'case', [
      { sourceField: 'case.id', targetField: 'case.id' },  // case.id (inside case object, not root level)
      { sourceField: 'label', targetField: 'name' },  // Initialize case name from node label
      { sourceField: 'description', targetField: 'description' },  // Initialize case description from node
      { sourceField: 'case.variants', targetField: 'case.variants' }  // Variants go inside case object
    ]);
    
    // Flow C.UPDATE: Graph → File/Case (UPDATE current case metadata + variant weights)
    // Note: This updates case.variants array with current weights from graph
    // and also syncs connection settings from graph node to case file (under case.*).
    this.addMapping('graph_to_file', 'UPDATE', 'case', [
      {
        sourceField: 'case.variants',
        targetField: 'case.variants',
        transform: (graphVariants, source, target) => {
          // Update weights in case file from graph node
          // Preserve all other variant properties from file
          
          // If file doesn't have case.variants yet, just return graph variants
          if (!target.case?.variants || !Array.isArray(target.case.variants)) {
            return graphVariants.map((gv: any) => ({
              name: gv.name,
              weight: gv.weight,
              description: gv.description
            }));
          }
          
          // 1. Update existing file variants with graph data
          const updated = target.case.variants.map((fileVariant: any) => {
            const graphVariant = graphVariants.find((gv: any) => gv.name === fileVariant.name);
            if (graphVariant) {
              return {
                ...fileVariant,
                name: graphVariant.name_overridden ? graphVariant.name : fileVariant.name,
                weight: graphVariant.weight_overridden ? graphVariant.weight : fileVariant.weight,
                description: graphVariant.description_overridden ? graphVariant.description : fileVariant.description
              };
            }
            return fileVariant;
          });
          
          // 2. Add any new variants from graph that don't exist in file
          const fileVariantNames = new Set(target.case.variants.map((fv: any) => fv.name));
          const newVariants = graphVariants
            .filter((gv: any) => !fileVariantNames.has(gv.name))
            .map((gv: any) => ({
              name: gv.name,
              weight: gv.weight,
              description: gv.description
            }));
          
          return [...updated, ...newVariants];
        }
      },
      // Connection settings: always sync from graph case node to case file (nested under case.* per case-parameter-schema)
      {
        sourceField: 'case.connection',
        targetField: 'case.connection',
        condition: (source) => !!source.case?.connection
      },
      {
        sourceField: 'case.connection_string',
        targetField: 'case.connection_string',
        condition: (source) => !!source.case?.connection_string
      }
    ]);
    
    // Flow C.APPEND: Graph → File/Case (APPEND new schedule)
    this.addMapping('graph_to_file', 'APPEND', 'case', [
      { 
        sourceField: 'case.variants', 
        targetField: 'case.schedules[]',  // Case files have schedules under case.schedules, not at root
        transform: (variants) => ({
          variants: variants.map((v: any) => ({
            name: v.name,
            weight: v.weight
          })),
          window_from: new Date().toISOString(),
          source: 'manual',
          edited_at: new Date().toISOString()
          // TODO: Add author from credentials when available
        })
      }
    ]);
    
    // Flow D.CREATE: Graph → File/Node (CREATE new registry entry)
    this.addMapping('graph_to_file', 'CREATE', 'node', [
      { sourceField: 'id', targetField: 'id' },  // human-readable ID
      { sourceField: 'label', targetField: 'name' },
      { sourceField: 'description', targetField: 'description' },
      { sourceField: 'event_id', targetField: 'event_id' }
    ]);
    
    // Flow D.UPDATE: Graph → File/Node (UPDATE registry entry)
    this.addMapping('graph_to_file', 'UPDATE', 'node', [
      { sourceField: 'label', targetField: 'name' },
      { sourceField: 'description', targetField: 'description' },
      { sourceField: 'event_id', targetField: 'event_id' },
      { 
        sourceField: 'url', 
        targetField: 'url',
        overrideFlag: 'url_overridden'
      },
      { 
        sourceField: 'images', 
        targetField: 'images',
        overrideFlag: 'images_overridden',
        transform: (images) => {
          // When syncing graph → registry:
          // - Keep image_id, caption, file_extension
          // - Remove caption_overridden (graph-only field)
          // - Add uploaded_at, uploaded_by (registry fields)
          return images?.map((img: any) => ({
            image_id: img.image_id,
            caption: img.caption,
            file_extension: img.file_extension,
            uploaded_at: img.uploaded_at || new Date().toISOString(),
            uploaded_by: img.uploaded_by || 'unknown'
          }));
        }
      }
    ]);
    
    // Flow E.CREATE: Graph → File/Context (CREATE new registry entry)
    this.addMapping('graph_to_file', 'CREATE', 'context', [
      // Contexts are curated manually, not auto-created from graph
      // This mapping exists for completeness but is rarely used
    ]);
    
    // Flow F.CREATE: Graph → File/Event (CREATE new registry entry)
    this.addMapping('graph_to_file', 'CREATE', 'event', [
      // Events are curated manually, not auto-created from graph
      // This mapping exists for completeness but is rarely used
    ]);
    
    // ============================================================
    // Flows G-I: File → Graph
    // ============================================================
    
    // Flow G: File/Parameter → Graph (UPDATE edge)
    // Note: This updates edge.p.* fields (probability parameter data), NOT edge-level metadata
    // NOTE: conditional_probability type is treated identically to probability (PARITY PRINCIPLE)
    const isProbType = (source: any) => 
      source.type === 'probability' || 
      source.type === 'conditional_probability' || 
      source.parameter_type === 'probability' || 
      source.parameter_type === 'conditional_probability';
    
    this.addMapping('file_to_graph', 'UPDATE', 'parameter', [
      // Edge-level query configuration (file → graph)
      //
      // Graph-mastered policy (15-Dec-25):
      // - `edge.query`, `edge.n_query`, and `edge.p.latency.anchor_node_id` are graph-mastered,
      //   because the graph has the context to generate and validate them.
      // - Therefore, we DO NOT copy these fields from parameter files → graph edges.

      // Probability parameters → edge.p.*
      { 
        sourceField: 'values[latest].mean', 
        targetField: 'p.mean',
        overrideFlag: 'p.mean_overridden',
        condition: isProbType
      },
      { 
        sourceField: 'values[latest].stdev', 
        targetField: 'p.stdev',
        overrideFlag: 'p.stdev_overridden',
        condition: isProbType
      },
      { 
        sourceField: 'values[latest].distribution', 
        targetField: 'p.distribution',
        overrideFlag: 'p.distribution_overridden',
        condition: isProbType
      },
      { 
        sourceField: 'values[latest].n', 
        targetField: 'p.evidence.n',
        condition: isProbType
      },
      { 
        sourceField: 'values[latest].k', 
        targetField: 'p.evidence.k',
        condition: isProbType
      },
      { 
        sourceField: 'values[latest].window_from', 
        targetField: 'p.evidence.window_from',
        condition: isProbType
      },
      { 
        sourceField: 'values[latest].window_to', 
        targetField: 'p.evidence.window_to',
        condition: isProbType
      },
      { 
        sourceField: 'values[latest].data_source', 
        targetField: 'p.data_source',
        condition: isProbType
      },
      // Map data_source fields to evidence if data_source exists
      { 
        sourceField: 'values[latest].data_source.retrieved_at', 
        targetField: 'p.evidence.retrieved_at',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.data_source?.retrieved_at
      },
      { 
        sourceField: 'values[latest].data_source.type', 
        targetField: 'p.evidence.source',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.data_source?.type
      },
      { 
        sourceField: 'values[latest].data_source.full_query', 
        targetField: 'p.evidence.full_query',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.data_source?.full_query
      },
      { 
        sourceField: 'values[latest].data_source.debug_trace', 
        targetField: 'p.evidence.debug_trace',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.data_source?.debug_trace
      },
      // LAG FIX (lag-fixes.md §4.3): Map evidence scalars to edge
      // evidence.mean = raw observed rate (k/n), evidence.stdev = binomial uncertainty
      { 
        sourceField: 'values[latest].evidence.mean', 
        targetField: 'p.evidence.mean',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.evidence?.mean !== undefined
      },
      { 
        sourceField: 'values[latest].evidence.stdev', 
        targetField: 'p.evidence.stdev',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.evidence?.stdev !== undefined
      },
      
      // LAG: Latency CONFIG fields (file → graph, bidirectional)
      // latency_parameter: explicit enablement flag
      { 
        sourceField: 'latency.latency_parameter', 
        targetField: 'p.latency.latency_parameter',
        overrideFlag: 'p.latency.latency_parameter_overridden',
        condition: isProbType
      },
      { sourceField: 'latency.latency_parameter_overridden', targetField: 'p.latency.latency_parameter_overridden', requiresIgnoreOverrideFlags: true },
      // anchor_node_id is graph-mastered (see note above) – do not copy from file → graph.
      // t95 and path_t95: horizon fields (derived but user-overridable)
      { 
        sourceField: 'latency.t95', 
        targetField: 'p.latency.t95',
        overrideFlag: 'p.latency.t95_overridden',
        condition: isProbType
      },
      { sourceField: 'latency.t95_overridden', targetField: 'p.latency.t95_overridden', requiresIgnoreOverrideFlags: true },
      { 
        sourceField: 'latency.path_t95', 
        targetField: 'p.latency.path_t95',
        overrideFlag: 'p.latency.path_t95_overridden',
        condition: isProbType
      },
      { sourceField: 'latency.path_t95_overridden', targetField: 'p.latency.path_t95_overridden', requiresIgnoreOverrideFlags: true },
      
      // LAG: Latency DATA fields (file → graph only, display-only)
      { 
        sourceField: 'values[latest].latency.median_lag_days', 
        targetField: 'p.latency.median_lag_days',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.latency?.median_lag_days !== undefined
      },
      { 
        sourceField: 'values[latest].latency.completeness', 
        targetField: 'p.latency.completeness',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.latency?.completeness !== undefined
      },
      { 
        sourceField: 'values[latest].latency.t95', 
        targetField: 'p.latency.t95',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.latency?.t95 !== undefined
      },
      { 
        sourceField: 'values[latest].latency.path_t95', 
        targetField: 'p.latency.path_t95',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.latency?.path_t95 !== undefined
      },
      
      // LAG: Forecast fields (file → graph only)
      { 
        sourceField: 'values[latest].forecast', 
        targetField: 'p.forecast.mean',
        condition: (source) => isProbType(source) && source.values?.[source.values.length - 1]?.forecast !== undefined
      },
      
      // Cost GBP parameters → edge.cost_gbp.*
      { 
        sourceField: 'values[latest].mean', 
        targetField: 'cost_gbp.mean',
        overrideFlag: 'cost_gbp.mean_overridden',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      { 
        sourceField: 'values[latest].stdev', 
        targetField: 'cost_gbp.stdev',
        overrideFlag: 'cost_gbp.stdev_overridden',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      { 
        sourceField: 'values[latest].distribution', 
        targetField: 'cost_gbp.distribution',
        overrideFlag: 'cost_gbp.distribution_overridden',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      { 
        sourceField: 'values[latest].window_from', 
        targetField: 'cost_gbp.evidence.window_from',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      { 
        sourceField: 'values[latest].window_to', 
        targetField: 'cost_gbp.evidence.window_to',
        condition: (source) => source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp'
      },
      
      // Cost Time parameters → edge.labour_cost.*
      { 
        sourceField: 'values[latest].mean', 
        targetField: 'labour_cost.mean',
        overrideFlag: 'labour_cost.mean_overridden',
        condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
      },
      { 
        sourceField: 'values[latest].stdev', 
        targetField: 'labour_cost.stdev',
        overrideFlag: 'labour_cost.stdev_overridden',
        condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
      },
      { 
        sourceField: 'values[latest].distribution', 
        targetField: 'labour_cost.distribution',
        overrideFlag: 'labour_cost.distribution_overridden',
        condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
      },
      { 
        sourceField: 'values[latest].window_from', 
        targetField: 'labour_cost.evidence.window_from',
        condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
      },
      { 
        sourceField: 'values[latest].window_to', 
        targetField: 'labour_cost.evidence.window_to',
        condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
      },
      { 
        sourceField: 'values[latest].data_source', 
        targetField: 'labour_cost.data_source',
        condition: (source) => source.type === 'labour_cost' || source.parameter_type === 'labour_cost'
      },
      { 
        sourceField: 'values[latest].data_source.retrieved_at', 
        targetField: 'labour_cost.evidence.retrieved_at',
        condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && source.values?.[source.values.length - 1]?.data_source?.retrieved_at
      },
      { 
        sourceField: 'values[latest].data_source.type', 
        targetField: 'labour_cost.evidence.source',
        condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && source.values?.[source.values.length - 1]?.data_source?.type
      },
      { 
        sourceField: 'values[latest].data_source.full_query', 
        targetField: 'labour_cost.evidence.full_query',
        condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && source.values?.[source.values.length - 1]?.data_source?.full_query
      },
      { 
        sourceField: 'values[latest].data_source.debug_trace', 
        targetField: 'labour_cost.evidence.debug_trace',
        condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && source.values?.[source.values.length - 1]?.data_source?.debug_trace
      },
      
      // NOTE: Query string is NOT synced from file→graph
      // The dataOperationsService must:
      // 1. Find the conditional_p[i] element that matches the target param (by p.id)
      // 2. Pass conditional_p[i].p (the ProbabilityParam object) as the target to UpdateManager
      // 3. After update, replace conditional_p[i].p with the updated object
      // This way, the same mappings work for both edge.p and edge.conditional_p[i].p
      
      // NOTE: We do NOT map parameter.name or parameter.description to edge.label or edge.description
      // Those are edge-level metadata and should be independent of the parameter
      
      // Connection settings: sync from file to graph if not overridden
      // Probability parameter connection
      { 
        sourceField: 'connection', 
        targetField: 'p.connection',
        overrideFlag: 'p.connection_overridden',
        condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && !!source.connection
      },
      { 
        sourceField: 'connection_string', 
        targetField: 'p.connection_string',
        overrideFlag: 'p.connection_overridden',
        condition: (source) => (source.type === 'probability' || source.parameter_type === 'probability') && !!source.connection_string
      },
      // Cost GBP parameter connection
      { 
        sourceField: 'connection', 
        targetField: 'cost_gbp.connection',
        overrideFlag: 'cost_gbp.connection_overridden',
        condition: (source) => (source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp') && !!source.connection
      },
      { 
        sourceField: 'connection_string', 
        targetField: 'cost_gbp.connection_string',
        overrideFlag: 'cost_gbp.connection_overridden',
        condition: (source) => (source.type === 'cost_gbp' || source.parameter_type === 'cost_gbp') && !!source.connection_string
      },
      // Cost Time parameter connection
      { 
        sourceField: 'connection', 
        targetField: 'labour_cost.connection',
        overrideFlag: 'labour_cost.connection_overridden',
        condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && !!source.connection
      },
      { 
        sourceField: 'connection_string', 
        targetField: 'labour_cost.connection_string',
        overrideFlag: 'labour_cost.connection_overridden',
        condition: (source) => (source.type === 'labour_cost' || source.parameter_type === 'labour_cost') && !!source.connection_string
      }
    ]);
    
    // Flow H: File/Case → Graph (UPDATE case node)
    // Note: This updates node.case.* fields (case-specific data), NOT node-level metadata
    // Node label/description come from node files, not case files
    this.addMapping('file_to_graph', 'UPDATE', 'case', [
      // Case status
      {
        sourceField: 'case.status',
        targetField: 'case.status',
        overrideFlag: 'case.status_overridden'
      },
      // Case variants - prefer schedules[latest].variants if schedules exist
      { 
        sourceField: 'case.variants',  // Fallback field
        targetField: 'case.variants',
        transform: (fileVariants, source, target) => {
          // Sync variant names and weights from case file to graph node
          // Respect override flags: if graph has overridden a variant, preserve it
          
          // Normalize fileVariants to array format
          let normalizedFileVariants = fileVariants;
          if (fileVariants && !Array.isArray(fileVariants) && typeof fileVariants === 'object') {
            normalizedFileVariants = Object.entries(fileVariants).map(([name, weight]) => ({
              name,
              weight: typeof weight === 'number' ? weight : parseFloat(String(weight))
            }));
          }
          
          // If case file has schedules, use the latest schedule's variants
          let variantsToUse = normalizedFileVariants;
          if (source.case?.schedules && source.case.schedules.length > 0) {
            // Get schedules[latest] by timestamp
            const sortedSchedules = source.case.schedules.slice().sort((a: any, b: any) => {
              const timeA = a.window_from ? new Date(a.window_from).getTime() : 0;
              const timeB = b.window_from ? new Date(b.window_from).getTime() : 0;
              return timeB - timeA; // Most recent first
            });
            const scheduleVariants = sortedSchedules[0].variants;
            
            // Convert variants from object/map to array if necessary
            // Schema has two formats:
            // - Array: [{ name: 'control', weight: 0.5 }, ...]
            // - Object/Map: { control: 0.5, 'single-page': 0.5 }
            if (Array.isArray(scheduleVariants)) {
              variantsToUse = scheduleVariants;
            } else if (scheduleVariants && typeof scheduleVariants === 'object') {
              // Convert object to array
              variantsToUse = Object.entries(scheduleVariants).map(([name, weight]) => ({
                name,
                weight: typeof weight === 'number' ? weight : parseFloat(String(weight))
              }));
            }
          }
          
          // If target doesn't have variants yet, create fresh from file
          if (!target.case || !target.case.variants || target.case.variants.length === 0) {
            return variantsToUse.map((fv: any) => ({
              name: fv.name,
              name_overridden: false,
              weight: fv.weight,
              weight_overridden: false,
              description: fv.description,
              description_overridden: false
            }));
          }
          
        // Merge: respect overrides, sync non-overridden fields
        // 1. Start with all variants from file (these are authoritative)
        const merged = variantsToUse.map((fv: any) => {
          const graphVariant = target.case.variants.find((gv: any) => gv.name === fv.name);
          
          return {
            name: graphVariant?.name_overridden ? graphVariant.name : fv.name,
            name_overridden: graphVariant?.name_overridden ?? false,
            weight: graphVariant?.weight_overridden ? graphVariant.weight : fv.weight,
            weight_overridden: graphVariant?.weight_overridden ?? false,
            description: graphVariant?.description_overridden ? graphVariant.description : fv.description,
            description_overridden: graphVariant?.description_overridden ?? false,
            // Preserve graph-only fields (e.g. edges array)
            ...(graphVariant && graphVariant.edges ? { edges: graphVariant.edges } : {})
          };
        });
        
        // 2. Preserve graph-only variants ONLY if they have edges or overrides
        // Non-overridden variants without edges are "disposable" and should be removed on GET
        const fileVariantNames = new Set(variantsToUse.map((fv: any) => fv.name));
        const graphOnlyVariants = target.case.variants.filter((gv: any) => {
          if (fileVariantNames.has(gv.name)) return false; // Already in file
          
          // Keep if it has edges or any override flags
          return gv.edges?.length > 0 || 
                 gv.name_overridden || 
                 gv.weight_overridden || 
                 gv.description_overridden;
        });
        
        return [...merged, ...graphOnlyVariants];
        }
      }
      // NOTE: We do NOT map case.name or case.description to node.label or node.description
      // Those are node-level metadata and come from node files, not case files
      // If needed, we could add node.case.name and node.case.description fields for case metadata
    ]);
    
    // Flow I: File/Node → Graph (UPDATE node from registry)
    this.addMapping('file_to_graph', 'UPDATE', 'node', [
      { 
        sourceField: 'name', 
        targetField: 'label',
        overrideFlag: 'label_overridden'
      },
      { 
        sourceField: 'description', 
        targetField: 'description',
        overrideFlag: 'description_overridden'
      },
      { 
        sourceField: 'event_id', 
        targetField: 'event_id',
        overrideFlag: 'event_id_overridden'
      },
      { 
        sourceField: 'url', 
        targetField: 'url',
        overrideFlag: 'url_overridden'
      },
      { 
        sourceField: 'images', 
        targetField: 'images',
        overrideFlag: 'images_overridden',
        transform: (images: any) => {
          // When syncing registry → graph:
          // - Keep image_id, caption, file_extension
          // - Remove uploaded_at, uploaded_by (registry-only fields)
          // - Add caption_overridden: false
          return images?.map((img: any) => ({
            image_id: img.image_id,
            caption: img.caption,
            file_extension: img.file_extension,
            caption_overridden: false
          }));
        }
      }
    ]);
    
    // ============================================================
    // Flows L-M: External → Graph
    // ============================================================
    
    // Flow L: External → Graph/Parameter (UPDATE edge directly)
    // Uses schema terminology: mean, n, k, stdev (not external API terminology)
    this.addMapping('external_to_graph', 'UPDATE', 'parameter', [
      { 
        sourceField: 'mean', 
        targetField: 'p.mean',
        overrideFlag: 'p.mean_overridden',
        transform: (mean, source) => {
          // Prefer explicit mean if provided (may be adjusted/rounded)
          // Only recalculate if explicit mean not available
          if (mean !== undefined && mean !== null) {
            return this.roundToDP(mean);
          }
          // Fallback: calculate from n/k if both are available
          if (source.n > 0 && source.k !== undefined) {
            // Calculate mean, clamping to [0, 1] in case of data errors
            const calculated = source.k / source.n;
            return this.roundToDP(Math.max(0, Math.min(1, calculated)));
          }
          // No mean data available - don't update mean
          return undefined;
        }
      },
      { 
        sourceField: 'stdev', 
        targetField: 'p.stdev',
        overrideFlag: 'p.stdev_overridden',
        transform: (stdev, source) => {
          // Round stdev to standard precision for consistency
          if (stdev !== undefined && stdev !== null) {
            return this.roundToDP(stdev);
          }
          return undefined;
        }
      },
      { 
        sourceField: 'n', 
        targetField: 'p.evidence.n'
      },
      { 
        sourceField: 'k', 
        targetField: 'p.evidence.k'
      },
      { 
        sourceField: 'retrieved_at', 
        targetField: 'p.evidence.retrieved_at'
      },
      { 
        sourceField: 'source', 
        targetField: 'p.evidence.source'
      },
      { 
        sourceField: 'data_source', 
        targetField: 'p.data_source'
      }
    ]);
    
    // Flow M: External → Graph/Case (UPDATE case node directly)
    // NOTE: External sources do NOT define variants - they only provide weights
    // that map to user-defined variants in the case file. This mapping ONLY
    // updates existing variants, it does NOT add new ones.
    this.addMapping('external_to_graph', 'UPDATE', 'case', [
      { 
        sourceField: 'variants', 
        targetField: 'case.variants',
        transform: (externalVariants, source, target) => {
          // Update weights for existing variants only (by name match)
          // Respect weight_overridden flags
          if (!target.case?.variants || !Array.isArray(externalVariants)) {
            return target.case?.variants || [];
          }
          
          return target.case.variants.map((v: any) => {
            const externalVariant = externalVariants.find((ev: any) => ev.name === v.name);
            
            // Only update weight if NOT overridden and external has data
            const shouldUpdate = !v.weight_overridden && externalVariant;
            
            return {
              ...v,
              weight: shouldUpdate ? externalVariant.weight : v.weight
            };
          });
        }
      },
      {
        sourceField: 'data_source',
        targetField: 'case.evidence',
        transform: (dataSource) => ({
          source: dataSource?.connection || dataSource?.type,
          fetched_at: dataSource?.retrieved_at,
          path: 'direct'
        })
      }
    ]);
    
    // ============================================================
    // Flows Q-R: External → File
    // ============================================================
    
    // Flow Q: External → File/Parameter (APPEND to values[])
    // Uses schema terminology: mean, n, k, stdev (not external API terminology)
    this.addMapping('external_to_file', 'APPEND', 'parameter', [
      { 
        sourceField: 'data', 
        targetField: 'values[]',
        transform: (externalData) => {
          // Calculate mean from n/k if not provided directly
          let mean = externalData.mean;
          if (mean === undefined && externalData.n > 0 && externalData.k !== undefined) {
            // Calculate and clamp to [0, 1]
            mean = Math.max(0, Math.min(1, externalData.k / externalData.n));
          }
          
          // Build value object with whatever fields we have (using schema terminology)
          const value: any = {};
          if (mean !== undefined) value.mean = mean;
          if (externalData.stdev !== undefined) value.stdev = externalData.stdev;
          if (externalData.n !== undefined) value.n = externalData.n;
          if (externalData.k !== undefined) value.k = externalData.k;
          if (externalData.window_from) value.window_from = externalData.window_from;
          if (externalData.window_to) value.window_to = externalData.window_to;
          if (externalData.retrieved_at) value.retrieved_at = externalData.retrieved_at;
          
          return value;
        }
      }
    ]);
    
    // Flow R: External → File/Case (APPEND to schedules[])
    this.addMapping('external_to_file', 'APPEND', 'case', [
      { 
        sourceField: 'data', 
        targetField: 'schedules[]',
        transform: (externalData) => ({
          variants: externalData.variants.map((v: any) => ({
            name: v.name,
            weight: v.weight
          })),
          window_from: externalData.window_from,
          window_to: externalData.window_to,
          retrieved_at: externalData.retrieved_at
        })
      }
    ]);
  }
  
  private addMapping(
    direction: Direction,
    operation: Operation,
    subDest: SubDestination | undefined,
    mappings: FieldMapping[]
  ) {
    const key = this.getMappingKey(direction, operation, subDest);
    this.mappingConfigurations.set(key, {
      direction,
      operation,
      subDestination: subDest,
      mappings
    });
  }
  
  private getMappingKey(
    direction: Direction,
    operation: Operation,
    subDest?: SubDestination
  ): string {
    return subDest ? `${direction}:${operation}:${subDest}` : `${direction}:${operation}`;
  }
  
  // ============================================================
  // UTILITIES
  // ============================================================
  
  private getNestedValue(obj: any, path: string): any {
    // Handle special array syntax: values[latest], values[0], schedules[latest]
    const parts = path.split('.');
    
    return parts.reduce((current, key) => {
      if (!current) return undefined;
      
      // Handle array access like "values[latest]" or "values[0]"
      const arrayMatch = key.match(/^(\w+)\[(\w+)\]$/);
      if (arrayMatch) {
        const [, arrayName, index] = arrayMatch;
        const array = current[arrayName];
        
        if (!Array.isArray(array) || array.length === 0) {
          return undefined;
        }
        
        if (index === 'latest') {
          // Get the entry with the most recent window_from timestamp
          // This is critical for parameter files where entries can be added out of order
          const sortedByTime = array.slice().sort((a, b) => {
            const timeA = a.window_from ? new Date(a.window_from).getTime() : 0;
            const timeB = b.window_from ? new Date(b.window_from).getTime() : 0;
            return timeB - timeA; // Most recent first
          });
          return sortedByTime[0];
        } else {
          const numIndex = parseInt(index, 10);
          return isNaN(numIndex) ? undefined : array[numIndex];
        }
      }
      
      return current[key];
    }, obj);
  }
  
  private setNestedValue(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    const lastPart = parts.pop()!;
    
    // Navigate to parent
    let current = obj;
    for (const part of parts) {
      // Handle array access in path
      const arrayMatch = part.match(/^(\w+)\[(\w+)\]$/);
      if (arrayMatch) {
        const [, arrayName, index] = arrayMatch;
        if (!current[arrayName]) current[arrayName] = [];
        
        if (index === 'latest') {
          // Access latest element
          const array = current[arrayName];
          if (array.length === 0) {
            array.push({});
          }
          current = array[array.length - 1];
        } else {
          const numIndex = parseInt(index, 10);
          if (!isNaN(numIndex)) {
            const array = current[arrayName];
            while (array.length <= numIndex) {
              array.push({});
            }
            current = array[numIndex];
          }
        }
      } else {
        if (!current[part]) current[part] = {};
        current = current[part];
      }
    }
    
    // Set final value
    // Handle array append syntax: "values[]" or "schedules[]"
    if (lastPart.endsWith('[]')) {
      const arrayName = lastPart.slice(0, -2);
      if (!current[arrayName]) current[arrayName] = [];
      current[arrayName].push(value);
    } else {
      current[lastPart] = value;
    }
  }
  
  private recordUpdate(
    operation: Operation,
    direction: Direction,
    subDest: SubDestination | undefined,
    source: any,
    target: any
  ): void {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation,
      direction,
      subDestination: subDest,
      source: this.sanitizeForAudit(source),
      target: this.sanitizeForAudit(target)
    });
  }
  
  private sanitizeForAudit(data: any): any {
    // TODO: Remove sensitive data, limit size
    return JSON.parse(JSON.stringify(data));
  }
  
  public getAuditLog(): any[] {
    return [...this.auditLog];
  }
  
  public clearAuditLog(): void {
    this.auditLog = [];
  }
  
  // ============================================================
  // GRAPH-TO-GRAPH UPDATE METHODS
  // Conditional Probability Management
  // ============================================================
  
  /**
   * Add conditional probability to an edge and propagate to sibling edges.
   * This is a graph-to-graph update that affects multiple edges.
   * 
   * @param graph - The current graph
   * @param edgeId - ID of the edge to add condition to
   * @param condition - The conditional probability object to add
   * @returns Updated graph with condition added to edge and siblings
   */
  addConditionalProbability(
    graph: any,
    edgeId: string,
    condition: any
  ): any {
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] Edge not found:', edgeId);
      return graph;
    }
    
    const currentEdge = nextGraph.edges[edgeIndex];
    
    // Add condition to current edge
    if (!currentEdge.conditional_p) {
      currentEdge.conditional_p = [];
    }
    currentEdge.conditional_p.push(structuredClone(condition));
    
    // Propagate to sibling edges (same source node)
    const siblings = getSiblingEdges(currentEdge, nextGraph);
    const defaultP = currentEdge.p?.mean ?? 0.5;
    const condStr = typeof condition.condition === 'string' ? condition.condition : '';
    
    siblings.forEach((sibling: any) => {
      const siblingIndex = nextGraph.edges.findIndex((e: any) => 
        e.uuid === sibling.uuid || e.id === sibling.id || 
        (e.from === sibling.from && e.to === sibling.to)
      );
      
      if (siblingIndex >= 0 && condStr) {
        const siblingEdge = nextGraph.edges[siblingIndex];
        if (!siblingEdge.conditional_p) {
          siblingEdge.conditional_p = [];
        }
        
        // Check if sibling already has this condition (by normalized string)
        const hasMatching = siblingEdge.conditional_p.some((existingCond: any) => {
          const existingStr = typeof existingCond.condition === 'string' ? existingCond.condition : '';
          return normalizeConstraintString(existingStr) === normalizeConstraintString(condStr);
        });
        
        if (!hasMatching) {
          siblingEdge.conditional_p.push({
            condition: condStr,
            query: condition.query || '',
            query_overridden: condition.query_overridden || false,
            p: {
              mean: siblingEdge.p?.mean ?? defaultP,
              ...(siblingEdge.p?.stdev !== undefined ? { stdev: siblingEdge.p.stdev } : {})
            }
          });
        }
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'addConditionalProbability',
      details: {
        edgeId,
        condition: condStr,
        siblingsUpdated: siblings.length
      }
    });
    
    return nextGraph;
  }
  
  /**
   * Update conditional probabilities on an edge and sync matching conditions on siblings.
   * 
   * @param graph - The current graph
   * @param edgeId - ID of the edge being updated
   * @param newConditions - Array of all conditional probabilities for this edge
   * @returns Updated graph with conditions synced to siblings
   */
  updateConditionalProbabilities(
    graph: any,
    edgeId: string,
    newConditions: any[]
  ): any {
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] Edge not found:', edgeId);
      return graph;
    }
    
    const currentEdge = nextGraph.edges[edgeIndex];
    const wasEmpty = !currentEdge.conditional_p || currentEdge.conditional_p.length === 0;
    const isNowEmpty = newConditions.length === 0;
    
    // Track old conditions BEFORE updating (needed for sibling sync)
    const oldConditions = !wasEmpty ? (currentEdge.conditional_p || []).map((cond: any) => {
      const condStr = typeof cond.condition === 'string' ? cond.condition : '';
      return normalizeConstraintString(condStr);
    }) : [];
    
    // Update current edge
    nextGraph.edges[edgeIndex].conditional_p = isNowEmpty ? undefined : newConditions.map(c => structuredClone(c));
    
    // If adding conditions (not removing), propagate to sibling edges
    if (!isNowEmpty && wasEmpty) {
      const siblings = getSiblingEdges(currentEdge, nextGraph);
      const defaultP = currentEdge.p?.mean ?? 0.5;
      
      siblings.forEach((sibling: any) => {
        const siblingIndex = nextGraph.edges.findIndex((e: any) => 
          e.uuid === sibling.uuid || e.id === sibling.id || 
          (e.from === sibling.from && e.to === sibling.to)
        );
        
        if (siblingIndex >= 0) {
          const siblingEdge = nextGraph.edges[siblingIndex];
          if (!siblingEdge.conditional_p) {
            siblingEdge.conditional_p = [];
          }
          
          // Add matching conditions to sibling
          newConditions.forEach((newCond: any) => {
            const condStr = typeof newCond.condition === 'string' ? newCond.condition : '';
            if (!condStr) return;
            
            const hasMatching = siblingEdge.conditional_p?.some((existingCond: any) => {
              const existingStr = typeof existingCond.condition === 'string' ? existingCond.condition : '';
              return normalizeConstraintString(existingStr) === normalizeConstraintString(condStr);
            }) || false;
            
            if (!hasMatching) {
              if (!siblingEdge.conditional_p) {
                siblingEdge.conditional_p = [];
              }
              siblingEdge.conditional_p.push({
                condition: condStr,
                query: newCond.query || '',
                query_overridden: newCond.query_overridden || false,
                p: {
                  mean: siblingEdge.p?.mean ?? defaultP,
                  ...(siblingEdge.p?.stdev !== undefined ? { stdev: siblingEdge.p.stdev } : {})
                }
              });
            }
          });
        }
      });
    }
    
    // If updating existing conditions, sync matching conditions on siblings
    if (!wasEmpty && !isNowEmpty) {
      const siblings = getSiblingEdges(currentEdge, nextGraph);
      
      // oldConditions was computed above, before updating the current edge
      
      siblings.forEach((sibling: any) => {
        const siblingIndex = nextGraph.edges.findIndex((e: any) => 
          e.uuid === sibling.uuid || e.id === sibling.id || 
          (e.from === sibling.from && e.to === sibling.to)
        );
        
        if (siblingIndex >= 0) {
          const siblingEdge = nextGraph.edges[siblingIndex];
          if (!siblingEdge.conditional_p) {
            siblingEdge.conditional_p = [];
          }
          
          // Track which old conditions have been matched/renamed to avoid duplicates
          const matchedOldIndices = new Set<number>();
          
          // For each new condition, find matching sibling condition and update structure
          newConditions.forEach((newCond: any) => {
            const condStr = typeof newCond.condition === 'string' ? newCond.condition : '';
            // Skip empty conditions for sibling propagation (they'll be added when user fills them in)
            if (!condStr) return;
            
            const normalizedNew = normalizeConstraintString(condStr);
            
            // Find matching condition in sibling (by normalized string)
            const matchingIndex = siblingEdge.conditional_p.findIndex((existingCond: any, idx: number) => {
              // Skip conditions that were already matched as renamed
              if (matchedOldIndices.has(idx)) return false;
              const existingStr = typeof existingCond.condition === 'string' ? existingCond.condition : '';
              return normalizeConstraintString(existingStr) === normalizedNew;
            });
            
            if (matchingIndex >= 0) {
              // Update existing matching condition (preserve p.mean if already set, update condition string)
              const existingConditionalP = siblingEdge.conditional_p[matchingIndex].p;
              siblingEdge.conditional_p[matchingIndex] = {
                condition: condStr, // Update to new condition string
                query: newCond.query || siblingEdge.conditional_p[matchingIndex].query || '',
                query_overridden: newCond.query_overridden || siblingEdge.conditional_p[matchingIndex].query_overridden || false,
                p: {
                  // Preserve existing p.mean if it exists, otherwise use base edge mean or default
                  mean: existingConditionalP?.mean !== undefined 
                    ? existingConditionalP.mean 
                    : (siblingEdge.p?.mean ?? 0.5),
                  // Preserve existing stdev if it exists, otherwise use base edge stdev if available
                  ...(existingConditionalP?.stdev !== undefined 
                    ? { stdev: existingConditionalP.stdev }
                    : (siblingEdge.p?.stdev !== undefined ? { stdev: siblingEdge.p.stdev } : {})),
                  // Preserve other existing p properties (distribution, etc.)
                  ...(existingConditionalP?.distribution ? { distribution: existingConditionalP.distribution } : {})
                }
              };
              matchedOldIndices.add(matchingIndex);
            } else {
              // New condition not found in sibling - check if it's a renamed condition
              // (old condition string changed to new condition string)
              // Find the old condition in sibling that matches one of the old conditions
              const oldConditionIndex = siblingEdge.conditional_p.findIndex((existingCond: any, idx: number) => {
                // Skip conditions that were already matched
                if (matchedOldIndices.has(idx)) return false;
                  const existingStr = typeof existingCond.condition === 'string' ? existingCond.condition : '';
                return oldConditions.includes(normalizeConstraintString(existingStr));
              });
              
              if (oldConditionIndex >= 0) {
                // This is a renamed condition - update the old one to the new one
                // Preserve the entire existing p object from the conditional probability
                const oldCondition = siblingEdge.conditional_p[oldConditionIndex];
                
                // Preserve the entire existing p object if it exists, otherwise create a new one
                const preservedP = oldCondition?.p 
                  ? { ...oldCondition.p }  // Copy all properties from existing p
                  : {
                      mean: siblingEdge.p?.mean ?? 0.5,
                      ...(siblingEdge.p?.stdev !== undefined ? { stdev: siblingEdge.p.stdev } : {})
                    };
                
                siblingEdge.conditional_p[oldConditionIndex] = {
                  condition: condStr, // Update to new condition string
                  query: newCond.query || oldCondition.query || '',
                  query_overridden: newCond.query_overridden ?? oldCondition.query_overridden ?? false,
                  p: preservedP  // Use the preserved p object
                };
                matchedOldIndices.add(oldConditionIndex);
              } else {
                // Truly new condition - add it to sibling
                siblingEdge.conditional_p.push({
                  condition: condStr,
                  query: newCond.query || '',
                  query_overridden: newCond.query_overridden || false,
                  p: {
                    mean: siblingEdge.p?.mean ?? 0.5,
                    ...(siblingEdge.p?.stdev !== undefined ? { stdev: siblingEdge.p.stdev } : {})
                  }
                });
              }
            }
          });
          
          // Remove conditions from sibling that no longer exist in current edge
          // Only keep conditions that match the new conditions (after any renames/updates)
          const newNormalized = newConditions.map((cond: any) => {
            const condStr = typeof cond.condition === 'string' ? cond.condition : '';
            return normalizeConstraintString(condStr);
          });
          
          siblingEdge.conditional_p = siblingEdge.conditional_p.filter((existingCond: any) => {
            const existingStr = typeof existingCond.condition === 'string' ? existingCond.condition : '';
            const normalizedExisting = normalizeConstraintString(existingStr);
            // Only keep if it matches one of the new conditions
            // Conditions that were in oldConditions but not in newNormalized should be removed
            return newNormalized.includes(normalizedExisting);
          });
        }
      });
    }
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'updateConditionalProbabilities',
      details: {
        edgeId,
        conditionsCount: newConditions.length
      }
    });
    
    return nextGraph;
  }
  
  /**
   * Remove conditional probability from an edge and remove matching conditions from siblings.
   * This is a graph-to-graph update that affects multiple edges.
   * 
   * @param graph - The current graph
   * @param edgeId - ID of the edge to remove condition from
   * @param condIndex - Index of the condition to remove
   * @returns Updated graph with condition removed from edge and siblings
   */
  removeConditionalProbability(
    graph: any,
    edgeId: string,
    condIndex: number
  ): any {
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] Edge not found:', edgeId);
      return graph;
    }
    
    const currentEdge = nextGraph.edges[edgeIndex];
    
    if (!currentEdge.conditional_p || condIndex >= currentEdge.conditional_p.length) {
      console.warn('[UpdateManager] Condition index out of range:', condIndex);
      return graph;
    }
    
    // Get the condition string to match on siblings
    const conditionToRemove = currentEdge.conditional_p[condIndex];
    const condStr = typeof conditionToRemove.condition === 'string' ? conditionToRemove.condition : '';
    
    // Remove condition from current edge
    currentEdge.conditional_p.splice(condIndex, 1);
    if (currentEdge.conditional_p.length === 0) {
      currentEdge.conditional_p = undefined;
    }
    
    // Remove matching conditions from sibling edges (same source node)
    if (condStr) {
      const siblings = getSiblingEdges(currentEdge, nextGraph);
      const normalizedToRemove = normalizeConstraintString(condStr);
      
      siblings.forEach((sibling: any) => {
        const siblingIndex = nextGraph.edges.findIndex((e: any) => 
          e.uuid === sibling.uuid || e.id === sibling.id || 
          (e.from === sibling.from && e.to === sibling.to)
        );
        
        if (siblingIndex >= 0 && nextGraph.edges[siblingIndex].conditional_p) {
          const siblingEdge = nextGraph.edges[siblingIndex];
          
          // Find and remove matching condition (by normalized string)
          const matchingIndex = siblingEdge.conditional_p.findIndex((cond: any) => {
            const existingStr = typeof cond.condition === 'string' ? cond.condition : '';
            return normalizeConstraintString(existingStr) === normalizedToRemove;
          });
          
          if (matchingIndex >= 0) {
            siblingEdge.conditional_p.splice(matchingIndex, 1);
            if (siblingEdge.conditional_p.length === 0) {
              siblingEdge.conditional_p = undefined;
            }
          }
        }
      });
    }
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'removeConditionalProbability',
      details: {
        edgeId,
        condIndex,
        condition: condStr
      }
    });
    
    return nextGraph;
  }
  
  /**
   * Create a new edge in the graph with proper ID generation and default probability calculation.
   * This is a graph-to-graph update that may affect sibling edge probabilities.
   * 
   * @param graph - The current graph
   * @param connection - Connection object with source, target, sourceHandle, targetHandle
   * @param options - Optional edge properties (case_id, case_variant, etc.)
   * @returns Updated graph with new edge added
   */
  createEdge(
    graph: any,
    connection: {
      source: string;
      target: string;
      sourceHandle?: string | null;
      targetHandle?: string | null;
    },
    options?: {
      case_id?: string;
      case_variant?: string;
      uuid?: string;
      id?: string;
    }
  ): { graph: any; edgeId: string } {
    const nextGraph = structuredClone(graph);
    
    // Find source and target nodes to get their IDs
    const sourceNode = nextGraph.nodes.find((n: any) => 
      n.uuid === connection.source || n.id === connection.source
    );
    const targetNode = nextGraph.nodes.find((n: any) => 
      n.uuid === connection.target || n.id === connection.target
    );
    
    if (!sourceNode || !targetNode) {
      console.warn('[UpdateManager] Source or target node not found:', {
        source: connection.source,
        target: connection.target
      });
      return { graph, edgeId: '' };
    }
    
    const sourceId = sourceNode.id || sourceNode.uuid || connection.source;
    const targetId = targetNode.id || targetNode.uuid || connection.target;
    
    // Generate unique edge ID (human-readable)
    const baseId = options?.id || `${sourceId}-to-${targetId}`;
    const existingIds = nextGraph.edges.map((e: any) => e.id || e.uuid).filter(Boolean);
    const edgeId = options?.id || generateUniqueId(baseId, existingIds);
    
    // Generate UUID (proper UUID, not human-readable ID)
    const edgeUuid = options?.uuid || crypto.randomUUID();
    
    // Calculate smart default probability based on existing outgoing edges
    const existingOutgoingEdges = nextGraph.edges.filter((e: any) => 
      e.from === connection.source || e.from === sourceNode.uuid || e.from === sourceNode.id
    );
    
    let defaultProbability: number;
    if (existingOutgoingEdges.length === 0) {
      // First edge from this node - default to 1.0 (100%)
      defaultProbability = 1.0;
    } else {
      // Subsequent edges - default to remaining probability
      const existingProbabilitySum = existingOutgoingEdges.reduce((sum: number, edge: any) => {
        return sum + (edge.p?.mean || 0);
      }, 0);
      defaultProbability = Math.max(0, 1.0 - existingProbabilitySum);
    }
    
    // Map handle IDs to match our node component
    // Source handles: "top" -> "top-out", "left" -> "left-out", etc.
    const sourceHandle = connection.sourceHandle ? 
      (connection.sourceHandle.endsWith('-out') ? connection.sourceHandle : `${connection.sourceHandle}-out`) : 
      null;
    const targetHandle = connection.targetHandle || null;
    
    // Create new edge
    const newEdge: any = {
      uuid: edgeUuid,
      id: edgeId,
      from: connection.source,
      to: connection.target,
      fromHandle: sourceHandle,
      toHandle: targetHandle,
      p: {
        mean: options?.case_variant ? 1.0 : defaultProbability // Case edges default to 1.0
      }
    };
    
    // Add case properties if provided
    // If case_variant is set but case_id is not, infer case_id from source node
    if (options?.case_variant) {
      newEdge.case_variant = options.case_variant;
      
      if (options?.case_id) {
        newEdge.case_id = options.case_id;
      } else {
        // Infer case_id from source node if it's a case node
        if (sourceNode?.type === 'case') {
          newEdge.case_id = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
        }
      }
    } else if (options?.case_id) {
      // Only set case_id if case_variant is not set (shouldn't happen, but handle it)
      newEdge.case_id = options.case_id;
    }
    
    nextGraph.edges.push(newEdge);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'createEdge',
      details: {
        edgeId,
        source: connection.source,
        target: connection.target,
        defaultProbability
      }
    });
    
    return { graph: nextGraph, edgeId };
  }

  /**
   * Update edge properties (e.g., case_variant, case_id)
   * 
   * When case_variant is set, automatically sets case_id from the source node if not provided.
   * When case_variant is cleared, also clears case_id.
   * 
   * @param graph - Current graph
   * @param edgeId - Edge UUID or ID
   * @param properties - Properties to update (case_variant, case_id, etc.)
   * @returns Updated graph
   */
  updateEdgeProperty(
    graph: any,
    edgeId: string,
    properties: {
      case_variant?: string | null;
      case_id?: string | null;
    }
  ): any {
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] Edge not found:', edgeId);
      return graph;
    }
    
    const edge = nextGraph.edges[edgeIndex];
    
    // Update case_variant
    if ('case_variant' in properties) {
      if (properties.case_variant === null || properties.case_variant === '') {
        // Clearing case_variant: also clear case_id
        delete edge.case_variant;
        delete edge.case_id;
      } else {
        // Setting case_variant: ensure case_id is set
        edge.case_variant = properties.case_variant;
        
        // If case_id is not explicitly provided, infer it from the source node
        if (!('case_id' in properties) || properties.case_id === null || properties.case_id === '') {
          const sourceNode = nextGraph.nodes.find((n: any) => 
            n.uuid === edge.from || n.id === edge.from
          );
          
          if (sourceNode?.type === 'case') {
            // Use case.id if set, otherwise fall back to node uuid or id
            edge.case_id = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
          } else {
            // If source is not a case node, keep existing case_id or clear it
            if (!edge.case_id) {
              delete edge.case_id;
            }
          }
        }
      }
    }
    
    // Update case_id (only if explicitly provided)
    if ('case_id' in properties) {
      if (properties.case_id === null || properties.case_id === '') {
        delete edge.case_id;
      } else {
        edge.case_id = properties.case_id;
      }
    }
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'updateEdgeProperty',
      details: {
        edgeId: edgeId,
        properties: properties,
        inferredCaseId: edge.case_id
      }
    });
    
    return nextGraph;
  }

  /**
   * Update edge with arbitrary properties (e.g., p.mean, p.stdev, etc.)
   * This is a general-purpose method for updating any edge properties.
   * 
   * @param graph - Current graph
   * @param edgeId - Edge UUID or ID
   * @param properties - Properties to update (e.g., { p: { mean: 0.75 } })
   * @returns Updated graph
   */
  updateEdge(
    graph: any,
    edgeId: string,
    properties: Record<string, any>
  ): any {
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] Edge not found:', edgeId);
      return graph;
    }
    
    const edge = nextGraph.edges[edgeIndex];
    
    // Deep merge properties into edge
    const deepMerge = (target: any, source: any): any => {
      const result = { ...target };
      for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          result[key] = deepMerge(target[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
      return result;
    };
    
    nextGraph.edges[edgeIndex] = deepMerge(edge, properties);
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'updateEdge',
      details: {
        edgeId: edgeId,
        properties: properties
      }
    });
    
    return nextGraph;
  }
  
  /**
   * Apply LAG (latency) values to multiple edges in ONE atomic operation.
   * 
   * This is the SINGLE code path for applying computed LAG statistics to graph edges.
   * 
   * Processing order (all on ONE cloned graph):
   * 1. Clone graph ONCE
   * 2. Apply ALL latency fields to ALL edges
   * 3. Apply ALL blended means to ALL edges
   * 4. Rebalance ALL affected sibling groups ONCE at the end
   * 
   * @param graph - Current graph
   * @param edgeUpdates - Array of edge updates to apply
   * @returns Updated graph with all LAG values applied
   */
  applyBatchLAGValues(
    graph: any,
    edgeUpdates: Array<{
      edgeId: string;
      latency: {
        median_lag_days?: number;
        mean_lag_days?: number;
        t95: number;
        completeness: number;
        path_t95: number;
      };
      blendedMean?: number;
      forecast?: {
        mean?: number;
      };
      evidence?: {
        mean?: number;
        n?: number;
        k?: number;
      };
    }>
  ): any {
    console.log('[UpdateManager] applyBatchLAGValues called:', {
      edgeUpdateCount: edgeUpdates?.length ?? 0,
      graphEdgeCount: graph?.edges?.length ?? 0,
      sampleUpdate: edgeUpdates?.[0] ? {
        edgeId: edgeUpdates[0].edgeId,
        t95: edgeUpdates[0].latency.t95,
        completeness: edgeUpdates[0].latency.completeness,
        blendedMean: edgeUpdates[0].blendedMean,
      } : 'none',
    });
    
    if (!edgeUpdates || edgeUpdates.length === 0) {
      return graph;
    }
    
    // STEP 1: Clone graph ONCE
    const nextGraph = structuredClone(graph);
    
    // Track which edges need rebalancing (by source node)
    const edgesToRebalance: string[] = [];
    
    // STEP 2: Apply ALL latency values and mean changes
    for (const update of edgeUpdates) {
      const edgeIndex = nextGraph.edges.findIndex((e: any) => 
        e.uuid === update.edgeId || e.id === update.edgeId || `${e.from}->${e.to}` === update.edgeId
      );
      
      if (edgeIndex < 0) {
        console.warn('[UpdateManager] applyBatchLAGValues: Edge not found:', update.edgeId);
        continue;
      }
      
      const edge = nextGraph.edges[edgeIndex];
      
      // Ensure p and p.latency exist
      if (!edge.p) {
        edge.p = {};
      }
      if (!edge.p.latency) {
        edge.p.latency = {};
      }
      
      // Apply latency values
      if (update.latency.median_lag_days !== undefined) {
        edge.p.latency.median_lag_days = update.latency.median_lag_days;
      }
      if (update.latency.mean_lag_days !== undefined) {
        edge.p.latency.mean_lag_days = update.latency.mean_lag_days;
      }
      // Phase 2: respect override flags
      if (edge.p.latency.t95_overridden !== true) {
        edge.p.latency.t95 = this.roundHorizonDays(update.latency.t95);
      }
      edge.p.latency.completeness = update.latency.completeness;
      if (edge.p.latency.path_t95_overridden !== true) {
        edge.p.latency.path_t95 = this.roundHorizonDays(update.latency.path_t95);
      }
      
      // Apply forecast if provided
      if (update.forecast) {
        if (!edge.p.forecast) {
          edge.p.forecast = {};
        }
        if (update.forecast.mean !== undefined) {
          edge.p.forecast.mean = update.forecast.mean;
        }
      }
      
      // Apply evidence if provided
      if (update.evidence) {
        if (!edge.p.evidence) {
          edge.p.evidence = {};
        }
        if (update.evidence.mean !== undefined) {
          edge.p.evidence.mean = update.evidence.mean;
        }
        if (update.evidence.n !== undefined) {
          edge.p.evidence.n = update.evidence.n;
        }
        if (update.evidence.k !== undefined) {
          edge.p.evidence.k = update.evidence.k;
        }
      }
      
      console.log('[UpdateManager] applyBatchLAGValues: Applied latency to edge:', {
        edgeId: update.edgeId,
        edgeIndex,
        t95: edge.p.latency.t95,
        completeness: edge.p.latency.completeness,
        path_t95: edge.p.latency.path_t95,
        forecastMean: edge.p.forecast?.mean,
        evidenceMean: edge.p.evidence?.mean,
      });
      
      // Apply blended mean if provided and different
      if (update.blendedMean !== undefined) {
        const oldMean = edge.p.mean;
        if (oldMean !== update.blendedMean) {
          edge.p.mean = this.roundToDP(update.blendedMean);
          edgesToRebalance.push(update.edgeId);
        }
      }
    }
    
    // STEP 3: Rebalance all affected edges ONCE using consolidated rebalancing logic
    // Uses findSiblingsForRebalance + rebalanceSiblingEdges (same path as rebalanceEdgeProbabilities)
    for (const edgeId of edgesToRebalance) {
      const { originEdge, siblings, originValue } = this.findSiblingsForRebalance(nextGraph, edgeId);
      if (!originEdge || siblings.length === 0) continue;
      
      // Filter to non-overridden siblings (normal rebalance mode)
      const freeEdges = siblings.filter((e: any) => !e.p?.mean_overridden);
      if (freeEdges.length === 0) continue;
      
      // Calculate remaining weight after accounting for origin and overridden siblings
      const overriddenTotal = siblings
        .filter((e: any) => e.p?.mean_overridden)
        .reduce((sum: number, e: any) => sum + (e.p?.mean || 0), 0);
      const remainingForFree = Math.max(0, 1 - originValue - overriddenTotal);
      
      this.rebalanceSiblingEdges(nextGraph, freeEdges, remainingForFree, false);
    }
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'applyBatchLAGValues',
      details: {
        edgeCount: edgeUpdates.length,
        rebalancedCount: edgesToRebalance.length,
      }
    });
    
    // Verify latency values are on the returned graph
    const verifyEdge = nextGraph.edges.find((e: any) => 
      e.uuid === edgeUpdates[0]?.edgeId || e.id === edgeUpdates[0]?.edgeId
    );
    console.log('[UpdateManager] applyBatchLAGValues: Returning graph with edge:', {
      edgeId: edgeUpdates[0]?.edgeId,
      hasLatency: !!verifyEdge?.p?.latency,
      t95: verifyEdge?.p?.latency?.t95,
      completeness: verifyEdge?.p?.latency?.completeness,
      pMean: verifyEdge?.p?.mean,
    });
    
    return nextGraph;
  }
  
  /**
   * Delete a node from the graph and clean up associated edges.
   * Uses smart image GC - only deletes images with zero references across all files.
   * 
   * @param graph - Current graph
   * @param nodeUuid - UUID of the node to delete
   * @returns Updated graph with node and associated edges removed
   */
  async deleteNode(graph: any, nodeUuid: string): Promise<any> {
    const nextGraph = structuredClone(graph);
    
    // Find the node to verify it exists
    const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === nodeUuid);
    if (nodeIndex < 0) {
      console.warn('[UpdateManager] deleteNode: Node not found:', nodeUuid);
      return graph;
    }
    
    const node = nextGraph.nodes[nodeIndex];
    const humanId = node.id;
    
    console.log('[UpdateManager] Deleting node:', {
      uuid: nodeUuid,
      humanId: humanId,
      label: node.label,
      hasImages: !!node.images?.length
    });
    
    // Smart image deletion using full GC scan
    if (node.images && node.images.length > 0) {
      // Import deleteOperationsService for shared GC utility
      const { deleteOperationsService } = await import('./deleteOperationsService');
      
      const imageIds = node.images.map((img: any) => img.image_id);
      const referencedImages = await deleteOperationsService.scanAllFilesForImageReferences(imageIds);
      
      const imagesToDelete = imageIds.filter((id: string) => !referencedImages.has(id));
      
      if (imagesToDelete.length > 0) {
        console.log('[UpdateManager] Registering images for deletion (no refs in any file):', {
          nodeId: humanId,
          imageCount: imagesToDelete.length
        });
        
        for (const imageId of imagesToDelete) {
          const img = node.images.find((i: any) => i.image_id === imageId);
          if (img) {
            this.registerImageDeletion(imageId, `nodes/images/${imageId}.${img.file_extension}`);
          }
        }
      }
      
      if (imagesToDelete.length < imageIds.length) {
        console.log('[UpdateManager] Keeping images (still referenced elsewhere):', {
          nodeId: humanId,
          imageCount: imageIds.length - imagesToDelete.length
        });
      }
    }
    
    // Remove the node
    nextGraph.nodes = nextGraph.nodes.filter((n: any) => n.uuid !== nodeUuid);
    
    // Remove all edges connected to this node
    // Edge.from and Edge.to can be EITHER uuid OR human-readable ID
    const edgesBefore = nextGraph.edges.length;
    nextGraph.edges = nextGraph.edges.filter((e: any) => 
      e.from !== nodeUuid && e.to !== nodeUuid &&
      e.from !== humanId && e.to !== humanId
    );
    const edgesAfter = nextGraph.edges.length;
    const edgesRemoved = edgesBefore - edgesAfter;
    
    console.log('[UpdateManager] Deleted node:', {
      uuid: nodeUuid,
      edgesRemoved: edgesRemoved
    });
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Log audit trail
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'deleteNode',
      details: {
        nodeUuid: nodeUuid,
        humanId: humanId,
        edgesRemoved: edgesRemoved
      }
    });
    
    return nextGraph;
  }
  
  /**
   * Register an image for deletion
   * Called by deleteNode when images are orphaned
   */
  private registerImageDeletion(imageId: string, path: string): void {
    // Use dynamic import to avoid circular dependency
    // Note: This is async but we don't await - image deletion registration is fire-and-forget
    import('../contexts/TabContext').then((module) => {
      module.fileRegistry.registerImageDelete(imageId, path);
    }).catch((err) => {
      console.error('[UpdateManager] Failed to register image deletion:', err);
    });
  }

  /**
   * Delete an edge from the graph.
   * 
   * @param graph - Current graph
   * @param edgeUuid - UUID of the edge to delete
   * @returns Updated graph with edge removed
   */
  deleteEdge(graph: any, edgeUuid: string): any {
    const nextGraph = structuredClone(graph);
    
    // Find the edge to verify it exists
    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeUuid);
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] deleteEdge: Edge not found:', edgeUuid);
      return graph;
    }
    
    const edge = nextGraph.edges[edgeIndex];
    console.log('[UpdateManager] Deleting edge:', {
      uuid: edgeUuid,
      from: edge.from,
      to: edge.to
    });
    
    // Remove the edge
    nextGraph.edges = nextGraph.edges.filter((e: any) => e.uuid !== edgeUuid);
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Log audit trail
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'deleteEdge',
      details: {
        edgeUuid: edgeUuid,
        from: edge.from,
        to: edge.to
      }
    });
    
    return nextGraph;
  }

  /**
   * Propagate condition-level colour to matching conditions on sibling edges.
   * Colours are stored per condition, not per edge.
   * 
   * @param graph - The current graph
   * @param edgeId - ID of the edge with the condition
   * @param condIndex - Index of the condition to update colour for
   * @param colour - Colour to set (or undefined to clear)
   * @returns Updated graph with colour propagated to matching conditions on siblings
   */
  propagateConditionalColour(
    graph: any,
    edgeId: string,
    condIndex: number,
    colour: string | undefined
  ): any {
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] Edge not found:', edgeId);
      return graph;
    }
    
    const currentEdge = nextGraph.edges[edgeIndex];
    
    if (!currentEdge.conditional_p || condIndex >= currentEdge.conditional_p.length) {
      console.warn('[UpdateManager] Condition index out of range:', condIndex);
      return graph;
    }
    
    // Update colour on current condition
    const conditionToUpdate = currentEdge.conditional_p[condIndex];
    const condStr = typeof conditionToUpdate.condition === 'string' ? conditionToUpdate.condition : '';
    
    if (colour === undefined) {
      delete currentEdge.conditional_p[condIndex].colour;
    } else {
      currentEdge.conditional_p[condIndex].colour = colour;
    }
    
    // Propagate to matching conditions on sibling edges (same source node, matching condition string)
    if (condStr) {
      const siblings = getSiblingEdges(currentEdge, nextGraph);
      const normalizedToUpdate = normalizeConstraintString(condStr);
      
      siblings.forEach((sibling: any) => {
        const siblingIndex = nextGraph.edges.findIndex((e: any) => 
          e.uuid === sibling.uuid || e.id === sibling.id || 
          (e.from === sibling.from && e.to === sibling.to)
        );
        
        if (siblingIndex >= 0 && nextGraph.edges[siblingIndex].conditional_p) {
          const siblingEdge = nextGraph.edges[siblingIndex];
          
          // Find matching condition (by normalized string) and update its colour
          const matchingIndex = siblingEdge.conditional_p.findIndex((cond: any) => {
            const existingStr = typeof cond.condition === 'string' ? cond.condition : '';
            return normalizeConstraintString(existingStr) === normalizedToUpdate;
          });
          
          if (matchingIndex >= 0) {
            if (colour === undefined) {
              delete siblingEdge.conditional_p[matchingIndex].colour;
            } else {
              siblingEdge.conditional_p[matchingIndex].colour = colour;
            }
          }
        }
      });
    }
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'propagateConditionalColour',
      details: {
        edgeId,
        condIndex,
        color: colour || 'cleared'
      }
    });
    
    return nextGraph;
  }

  /**
   * Rebalance regular edge probabilities for siblings of an edge.
   * When forceRebalance is true, ignores mean_overridden flags.
   * IMPORTANT: The origin edge's value is preserved - only siblings are updated.
   * 
   * @param graph - The current graph
   * @param edgeId - ID of the edge whose siblings should be rebalanced
   * @param forceRebalance - If true, override mean_overridden flags (for explicit rebalance action)
   * @returns Updated graph with rebalanced siblings
   */
  rebalanceEdgeProbabilities(
    graph: any,
    edgeId: string,
    forceRebalance: boolean = false
  ): any {
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] Edge not found:', edgeId);
      return graph;
    }
    
    const currentEdge = nextGraph.edges[edgeIndex];
    const sourceNodeId = currentEdge.from;
    
    // Infer case_id from source node if missing (for backward compatibility)
    let currentCaseId = currentEdge.case_id;
    if (!currentCaseId && currentEdge.case_variant) {
      const sourceNode = nextGraph.nodes.find((n: any) => 
        n.uuid === sourceNodeId || n.id === sourceNodeId
      );
      if (sourceNode?.type === 'case') {
        currentCaseId = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
      }
    }
    
    // IMPORTANT: Preserve the origin edge's current value - don't change it
    // Round to standard precision (external data may have many decimal places)
    const originValue = this.roundToDP(currentEdge.p?.mean ?? 0);
    
    // Find all sibling edges with the same parameter subtype (p, cost_gbp, or labour_cost)
    // For case edges: only rebalance edges with the same case_variant and case_id
    // For regular edges: rebalance all edges from same source node
    // Use consistent ID matching like edge finding logic
    // Note: Edges can have both conditional_p AND regular p.mean - we allow those to participate
    const currentEdgeId = currentEdge.uuid || currentEdge.id || `${currentEdge.from}->${currentEdge.to}`;
    const subtype = 'p'; // We're rebalancing p.mean, so subtype is 'p'
    
    const siblings = nextGraph.edges.filter((e: any) => {
      const eId = e.uuid || e.id || `${e.from}->${e.to}`;
      if (eId === currentEdgeId) return false; // Exclude the current edge (origin)
      if (e.from !== sourceNodeId) return false; // Must be from same source node
      // Match on subtype: must have the same parameter slot (p.mean for this function)
      if (subtype === 'p' && e.p?.mean === undefined) return false;
      
      // For case edges, only include edges with the same case_variant and case_id
      if (currentEdge.case_variant) {
        // Infer case_id for sibling edge if missing
        let siblingCaseId = e.case_id;
        if (!siblingCaseId && e.case_variant) {
          const siblingSourceNode = nextGraph.nodes.find((n: any) => 
            n.uuid === e.from || n.id === e.from
          );
          if (siblingSourceNode?.type === 'case') {
            siblingCaseId = siblingSourceNode.case?.id || siblingSourceNode.uuid || siblingSourceNode.id;
          }
        }
        
        // Must match both case_variant and case_id
        if (e.case_variant !== currentEdge.case_variant || siblingCaseId !== currentCaseId) {
          return false;
        }
      } else {
        // For regular edges, exclude case edges
        if (e.case_variant) return false;
      }
      
      return true;
    });
    
    if (siblings.length === 0) {
      const edgesFromSource = nextGraph.edges.filter((e: any) => e.from === sourceNodeId);
      
      console.warn('[UpdateManager] No siblings found for rebalance');
      console.log('Current edge ID:', currentEdgeId);
      console.log('Source node ID:', sourceNodeId);
      console.log('Subtype:', subtype);
      console.log(`Found ${edgesFromSource.length} edges from source node`);
      
      edgesFromSource.forEach((e: any, idx: number) => {
        const eId = e.uuid || e.id || `${e.from}->${e.to}`;
        const hasConditionalP = !!e.conditional_p;
        const hasP = !!e.p;
        const pMean = e.p?.mean;
        const hasSubtype = subtype === 'p' ? pMean !== undefined : false;
        const wouldBeSibling = eId !== currentEdgeId && hasSubtype;
        
        console.log(`\n=== Edge ${idx + 1} ===`);
        console.log('  UUID:', e.uuid);
        console.log('  ID:', e.id);
        console.log('  From->To:', `${e.from}->${e.to}`);
        console.log('  Edge ID:', eId);
        console.log('  Matches current:', eId === currentEdgeId);
        console.log('  Has subtype (p.mean):', hasSubtype);
        console.log('  Has conditional_p:', hasConditionalP);
        console.log('  Conditional_p count:', e.conditional_p?.length || 0);
        console.log('  Has p:', hasP);
        console.log('  p.mean:', pMean);
        console.log('  p.mean type:', typeof pMean);
        console.log('  Would be sibling:', wouldBeSibling);
        console.log('  Full p object:', e.p);
      });
      
      return nextGraph;
    }
    
    // Calculate remaining weight (1 - origin edge value)
    const remainingWeight = Math.max(0, 1 - originValue);
    
    console.log('[UpdateManager] Rebalancing edge probabilities:', {
      edgeId,
      currentEdgeId,
      originValue,
      siblingsCount: siblings.length,
      siblings: siblings.map((e: any) => ({
        uuid: e.uuid,
        id: e.id,
        fromTo: `${e.from}->${e.to}`,
        pMean: e.p?.mean
      })),
      remainingWeight
    });
    
    if (forceRebalance) {
      // Force rebalance: ignore ALL flags (overrides AND parameter locks)
      // Rebalance ALL siblings - force means force!
      console.log('[UpdateManager] Force rebalance:', {
        totalSiblings: siblings.length,
        remainingWeight
      });
      
      this.rebalanceSiblingEdges(nextGraph, siblings, remainingWeight, true);
      
      // Verify final sum
      const finalSum = siblings.reduce((sum, sibling) => {
        const edgeIndex = nextGraph.edges.findIndex((e: any) => {
          const eId = e.uuid || e.id || `${e.from}->${e.to}`;
          const sId = sibling.uuid || sibling.id || `${sibling.from}->${sibling.to}`;
          return eId === sId;
        });
        return sum + (edgeIndex >= 0 ? (nextGraph.edges[edgeIndex].p?.mean || 0) : 0);
      }, 0);
      const totalWithOrigin = originValue + finalSum;
      console.log('[UpdateManager] Force rebalance verification:', {
        originValue,
        siblingsSum: finalSum,
        totalWithOrigin,
        expectedTotal: 1.0,
        diff: Math.abs(totalWithOrigin - 1.0)
      });
    } else {
      // Normal rebalance: respect both override flags AND parameter locks
      const lockedEdges = siblings.filter((e: any) => this.isEdgeParameterLocked(e, subtype as any));
      const overriddenEdges = siblings.filter((e: any) => e.p?.mean_overridden && !this.isEdgeParameterLocked(e, subtype as any));
      const freeEdges = siblings.filter((e: any) => !e.p?.mean_overridden && !this.isEdgeParameterLocked(e, subtype as any));
      
      // Calculate fixed edges total (locked + overridden)
      const lockedTotal = lockedEdges.reduce((sum: number, e: any) => sum + (e.p?.mean || 0), 0);
      const overriddenTotal = overriddenEdges.reduce((sum: number, e: any) => sum + (e.p?.mean || 0), 0);
      const fixedTotal = lockedTotal + overriddenTotal;
      const remainingForFree = Math.max(0, remainingWeight - fixedTotal);
      
      console.log('[UpdateManager] Normal rebalance with locks and overrides:', {
        totalSiblings: siblings.length,
        lockedCount: lockedEdges.length,
        overriddenCount: overriddenEdges.length,
        freeCount: freeEdges.length,
        lockedTotal,
        overriddenTotal,
        remainingForFree
      });
      
      if (freeEdges.length > 0) {
        this.rebalanceSiblingEdges(nextGraph, freeEdges, remainingForFree, false);
        
        // Verify final sum
        const finalSum = freeEdges.reduce((sum, sibling) => {
          const edgeIndex = nextGraph.edges.findIndex((e: any) => {
            const eId = e.uuid || e.id || `${e.from}->${e.to}`;
            const sId = sibling.uuid || sibling.id || `${sibling.from}->${sibling.to}`;
            return eId === sId;
          });
          return sum + (edgeIndex >= 0 ? (nextGraph.edges[edgeIndex].p?.mean || 0) : 0);
        }, 0);
        const totalWithOrigin = originValue + lockedTotal + overriddenTotal + finalSum;
        console.log('[UpdateManager] Normal rebalance verification:', {
          originValue,
          lockedSum: lockedTotal,
          overriddenSum: overriddenTotal,
          freeSum: finalSum,
          totalWithOrigin,
          expectedTotal: 1.0,
          diff: Math.abs(totalWithOrigin - 1.0)
        });
      } else {
        console.warn('[UpdateManager] No free edges to rebalance (all siblings are locked or overridden)');
      }
    }
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'rebalanceEdgeProbabilities',
      details: {
        edgeId,
        originValue,
        forceRebalance,
        siblingsRebalanced: siblings.length
      }
    });
    
    return nextGraph;
  }

  /**
   * Rebalance conditional probabilities for siblings with the same condition.
   * When forceRebalance is true, ignores mean_overridden flags.
   * IMPORTANT: The origin condition's value is preserved - only siblings are updated.
   * 
   * @param graph - The current graph
   * @param edgeId - ID of the edge whose conditional probability should be rebalanced
   * @param condIndex - Index of the conditional probability to rebalance
   * @param forceRebalance - If true, override mean_overridden flags (for explicit rebalance action)
   * @returns Updated graph with rebalanced conditional probabilities
   */
  rebalanceConditionalProbabilities(
    graph: any,
    edgeId: string,
    condIndex: number,
    forceRebalance: boolean = false
  ): any {
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] Edge not found:', edgeId);
      return graph;
    }
    
    const currentEdge = nextGraph.edges[edgeIndex];
    const sourceNodeId = currentEdge.from;
    
    if (!currentEdge.conditional_p || condIndex >= currentEdge.conditional_p.length) {
      console.warn('[UpdateManager] Condition index out of range:', condIndex);
      return graph;
    }
    
    // IMPORTANT: Preserve the origin condition's current value - don't change it
    // Round to standard precision (external data may have many decimal places)
    const condition = currentEdge.conditional_p[condIndex];
    const conditionStr = typeof condition.condition === 'string' ? condition.condition : '';
    const originValue = this.roundToDP(condition.p?.mean ?? 0);
    
    
    if (!conditionStr) return nextGraph;
    
    // Find all sibling edges with the same condition string (EXCLUDE the current edge)
    const currentEdgeId = currentEdge.uuid || currentEdge.id || `${currentEdge.from}->${currentEdge.to}`;
    const siblings = nextGraph.edges.filter((e: any) => {
      const eId = e.uuid || e.id || `${e.from}->${e.to}`;
      // CRITICAL: Must exclude the origin edge that we're rebalancing FROM
      // Compare by UUID first (most reliable), then by id, then by composite key
      const isCurrentEdge = (currentEdge.uuid && e.uuid === currentEdge.uuid) ||
                            (currentEdge.id && e.id === currentEdge.id) ||
                            (eId === currentEdgeId);
      if (isCurrentEdge) return false; // Exclude the current edge (origin)
      if (e.from !== sourceNodeId) return false;
      if (!e.conditional_p || e.conditional_p.length === 0) return false;
      return e.conditional_p.some((cp: any) => {
        const cpConditionStr = typeof cp.condition === 'string' ? cp.condition : '';
        return cpConditionStr === conditionStr;
      });
    });
    
    // Calculate remaining weight (1 - origin condition value)
    const remainingWeight = Math.max(0, 1 - originValue);
    
    // Helper to check if a conditional probability is locked
    const isConditionalLocked = (edge: any, condStr: string): boolean => {
      const matchingCond = edge.conditional_p?.find((cp: any) => {
        const cpConditionStr = typeof cp.condition === 'string' ? cp.condition : '';
        return cpConditionStr === condStr;
      });
      return !!(matchingCond?.p?.id || matchingCond?.p?.connection);
    };
    
    if (forceRebalance) {
      // Force rebalance: ignore ALL flags (overrides AND parameter locks)
      // Rebalance ALL siblings - force means force!
      
      this.rebalanceConditionalSiblings(nextGraph, siblings, conditionStr, remainingWeight, true);
    } else {
      // Normal rebalance: respect both override flags AND parameter locks
      const lockedSiblings: any[] = [];
      const overriddenSiblings: any[] = [];
      const freeSiblings: any[] = [];
      
      siblings.forEach((sibling: any) => {
        const matchingCond = sibling.conditional_p?.find((cp: any) => {
          const cpConditionStr = typeof cp.condition === 'string' ? cp.condition : '';
          return cpConditionStr === conditionStr;
        });
        
        if (isConditionalLocked(sibling, conditionStr)) {
          lockedSiblings.push({ sibling, matchingCond });
        } else if (matchingCond?.p?.mean_overridden) {
          overriddenSiblings.push({ sibling, matchingCond });
        } else {
          freeSiblings.push({ sibling, matchingCond });
        }
      });
      
      const lockedTotal = lockedSiblings.reduce((sum: number, item: any) => 
        sum + (item.matchingCond?.p?.mean || 0), 0);
      const overriddenTotal = overriddenSiblings.reduce((sum: number, item: any) => 
        sum + (item.matchingCond?.p?.mean || 0), 0);
      const fixedTotal = lockedTotal + overriddenTotal;
      const remainingForFree = Math.max(0, remainingWeight - fixedTotal);
      
      console.log('[UpdateManager] Normal rebalance conditional with locks and overrides:', {
        totalSiblings: siblings.length,
        lockedCount: lockedSiblings.length,
        overriddenCount: overriddenSiblings.length,
        freeCount: freeSiblings.length,
        lockedTotal,
        overriddenTotal,
        remainingForFree
      });
      
      if (freeSiblings.length > 0) {
        // Extract just the sibling edges (without matchingCond wrapper)
        const freeSiblingEdges = freeSiblings.map((item: any) => item.sibling);
        this.rebalanceConditionalSiblings(nextGraph, freeSiblingEdges, conditionStr, remainingForFree, false);
      } else {
        console.warn('[UpdateManager] No free conditional siblings to rebalance (all are locked or overridden)');
      }
    }
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'rebalanceConditionalProbabilities',
      details: {
        edgeId,
        condIndex,
        originValue,
        forceRebalance,
        condition: conditionStr,
        siblingsRebalanced: siblings.length
      }
    });
    
    return nextGraph;
  }

  /**
   * Rebalance case variant weights for a case node.
   * When forceRebalance is true, ignores weight_overridden flags.
   * IMPORTANT: The origin variant's value is preserved - only other variants are updated.
   * 
   * @param graph - The current graph
   * @param nodeId - ID of the case node whose variants should be rebalanced
   * @param variantIndex - Index of the variant whose weight is being preserved
   * @param forceRebalance - If true, override weight_overridden flags (for explicit rebalance action)
   * @returns Object with updated graph and count of overridden variants that were skipped
   */
  rebalanceVariantWeights(
    graph: any,
    nodeId: string,
    variantIndex: number,
    forceRebalance: boolean = false
  ): { graph: any; overriddenCount: number } {
    const nextGraph = structuredClone(graph);
    const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
      n.uuid === nodeId || n.id === nodeId
    );
    
    if (nodeIndex < 0) {
      console.warn('[UpdateManager] Case node not found:', nodeId);
      return { graph, overriddenCount: 0 };
    }
    
    const caseNode = nextGraph.nodes[nodeIndex];
    if (
      !caseNode.case ||
      !caseNode.case.variants ||
      variantIndex < 0 ||
      variantIndex >= caseNode.case.variants.length
    ) {
      console.warn('[UpdateManager] Invalid variant index for rebalanceVariantWeights:', {
        nodeId,
        variantIndex,
        variantsLength: caseNode.case?.variants ? caseNode.case.variants.length : 0,
      });
      return { graph, overriddenCount: 0 };
    }
    
    // IMPORTANT: Preserve the origin variant's current value - don't change it
    // Round to standard precision (external data may have many decimal places)
    const originVariant = caseNode.case.variants[variantIndex];
    const originValue = this.roundToDP(originVariant.weight ?? 0);
    
    // Calculate remaining weight (1 - origin variant value)
    const remainingWeight = Math.max(0, 1 - originValue);
    
    // Get all other variants
    const otherVariants = caseNode.case.variants.filter((_: any, idx: number) => idx !== variantIndex);
    
    if (otherVariants.length === 0) return { graph: nextGraph, overriddenCount: 0 };
    
    let overriddenCount = 0;
    
    if (forceRebalance) {
      // Force rebalance: ignore all override flags, distribute proportionally
      const otherVariantsTotal = otherVariants.reduce((sum: number, v: any) => sum + (v.weight || 0), 0);
      
      // Distribute with exact sum
      this.distributeWithExactSum(
        otherVariants,
        (variant: any) => variant.weight || 0,
        (variant: any, value: number) => {
          variant.weight = value;
          delete variant.weight_overridden;
        },
        remainingWeight,
        otherVariantsTotal
      );
    } else {
      // Normal rebalance: respect override flags
      const overriddenVariants = otherVariants.filter((v: any) => v.weight_overridden);
      const nonOverriddenVariants = otherVariants.filter((v: any) => !v.weight_overridden);
      
      overriddenCount = overriddenVariants.length;
      
      const overriddenTotal = overriddenVariants.reduce((sum: number, v: any) => sum + (v.weight || 0), 0);
      const remainingForNonOverridden = Math.max(0, remainingWeight - overriddenTotal);
      
      if (nonOverriddenVariants.length > 0) {
        const nonOverriddenTotal = nonOverriddenVariants.reduce((sum: number, v: any) => sum + (v.weight || 0), 0);
        
        // Distribute with exact sum
        this.distributeWithExactSum(
          nonOverriddenVariants,
          (variant: any) => variant.weight || 0,
          (variant: any, value: number) => {
            variant.weight = value;
          },
          remainingForNonOverridden,
          nonOverriddenTotal
        );
      }
    }
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'rebalanceVariantWeights',
      details: {
        nodeId,
        variantIndex,
        originValue,
        forceRebalance,
        variantsRebalanced: otherVariants.length,
        overriddenCount
      }
    });
    
    return { graph: nextGraph, overriddenCount };
  }

  // ============================================================
  // Node ID Renaming
  // ============================================================

  /**
   * Rename a node's human-readable id and update related graph state.
   *
   * Responsibilities:
   * - Update node.id
   * - If label is not overridden, update it to a human-readable version of node.id
   *   e.g. "website-start-browse" -> "Website start browse"
   * - Update references to that node id in:
   *   - edge.from / edge.to
   *   - edge.id (both old id substrings and first-time uuid substitutions)
   *   - edge.query strings
   *   - conditional_p[].condition strings
   *
   * @param graph - Current graph
   * @param nodeKey - Node UUID or current id
   * @param newId - New human-readable node id
   */
  renameNodeId(
    graph: any,
    nodeKey: string,
    newId: string
  ): {
    graph: any;
    oldId?: string | null;
    edgesFromToUpdated: number;
    edgeIdsUpdatedFromId: number;
    edgeIdsUpdatedFromUuid: number;
    queriesUpdated: number;
    conditionsUpdated: number;
    edgeIdsDeduped: number;
  } {
    const nextGraph = structuredClone(graph);

    const node = nextGraph.nodes.find((n: any) =>
      n.uuid === nodeKey || n.id === nodeKey
    );

    if (!node) {
      console.warn('[UpdateManager] renameNodeId: node not found for key:', nodeKey);
      return { 
        graph, 
        oldId: undefined,
        edgesFromToUpdated: 0,
        edgeIdsUpdatedFromId: 0,
        edgeIdsUpdatedFromUuid: 0,
        queriesUpdated: 0,
        conditionsUpdated: 0,
        edgeIdsDeduped: 0
      };
    }

    const oldId: string | null | undefined = node.id;
    const nodeUuid: string = node.uuid;

    // Update node id
    node.id = newId;

    // If label is not overridden, update it to a human-readable version of the new id
    if (!node.label_overridden) {
      node.label = this.humanizeNodeId(newId);
    }

    // Helper tokens for replacement
    const firstTimeId = !oldId;
    const searchTokens: string[] = [];
    if (oldId && typeof oldId === 'string') {
      searchTokens.push(oldId);
    } else if (nodeUuid) {
      // First-time id assignment: replace uuid-based references
      searchTokens.push(nodeUuid);
    }

    // Update edges
    let edgesFromToUpdated = 0;
    let edgeIdsUpdatedFromId = 0;
    let edgeIdsUpdatedFromUuid = 0;
    let queriesUpdated = 0;
    let conditionsUpdated = 0;
    let edgeIdsDeduped = 0;

    // Helper to update queries/conditions in a parameter object (p, cost_gbp, labour_cost, etc.)
    const updateParamQueries = (param: any) => {
      if (!param || typeof param !== 'object') return;
      
      for (const token of searchTokens) {
        // Update query strings
        if (param.query && typeof param.query === 'string') {
          const updated = this.replaceNodeToken(param.query, token, newId);
          if (updated !== param.query) {
            param.query = updated;
            queriesUpdated++;
          }
        }
        
        // Update n_query strings (same pattern as query)
        if (param.n_query && typeof param.n_query === 'string') {
          const updated = this.replaceNodeToken(param.n_query, token, newId);
          if (updated !== param.n_query) {
            param.n_query = updated;
            queriesUpdated++;
          }
        }
        
        // Update conditional probabilities
        if (Array.isArray(param.conditional_probabilities)) {
          param.conditional_probabilities.forEach((cond: any) => {
            if (cond.condition && typeof cond.condition === 'string') {
              const updatedCond = this.replaceNodeToken(cond.condition, token, newId);
              if (updatedCond !== cond.condition) {
                cond.condition = updatedCond;
                conditionsUpdated++;
              }
            }
          });
        }
      }
    };

    // Update node-level parameters (p, cost_gbp, labour_cost, etc.)
    if (searchTokens.length > 0) {
      updateParamQueries(node.p);
      updateParamQueries(node.cost_gbp);
      updateParamQueries(node.labour_cost);
    }

    if (Array.isArray(nextGraph.edges)) {
      nextGraph.edges.forEach((edge: any) => {
        // NOTE: edge.from and edge.to MUST remain as node UUIDs (not human-readable IDs)
        // per GraphEdge type definition. Do NOT update them when renaming node IDs.
        // Other systems (Sankey, runner, etc.) rely on these being UUIDs.

        // Edge ID updates (use word boundaries for replacement)
        if (edge.id && typeof edge.id === 'string') {
          let edgeIdStr: string = edge.id;
          let idChanged = false;

          // Case 1: rename old id substring inside edge id (word boundaries)
          if (oldId && oldId.length > 0) {
            const updated = this.replaceNodeToken(edgeIdStr, oldId, newId);
            if (updated !== edgeIdStr) {
              edgeIdStr = updated;
              edgeIdsUpdatedFromId++;
              idChanged = true;
            }
          }

          // Case 2: first-time id assignment: replace uuid token with new id in id string
          if (firstTimeId && nodeUuid && edgeIdStr.includes(nodeUuid)) {
            edgeIdStr = edgeIdStr.replace(new RegExp(nodeUuid, 'g'), newId);
            edgeIdsUpdatedFromUuid++;
            idChanged = true;
          }

          if (idChanged) {
            edge.id = edgeIdStr;
          }
        }

        // Update edge-level queries & conditions that reference this node id
        if (searchTokens.length > 0) {
          for (const token of searchTokens) {
            // Edge-level query string
            if (edge.query && typeof edge.query === 'string') {
              const updatedEdgeQuery = this.replaceNodeToken(edge.query, token, newId);
              if (updatedEdgeQuery !== edge.query) {
                edge.query = updatedEdgeQuery;
                queriesUpdated++;
              }
            }
            
            // Edge-level n_query string (same pattern as query)
            if (edge.n_query && typeof edge.n_query === 'string') {
              const updatedNQuery = this.replaceNodeToken(edge.n_query, token, newId);
              if (updatedNQuery !== edge.n_query) {
                edge.n_query = updatedNQuery;
                queriesUpdated++;
              }
            }

            // Edge-level conditional_p conditions
            if (Array.isArray(edge.conditional_p)) {
              edge.conditional_p.forEach((cond: any) => {
                if (cond && typeof cond.condition === 'string') {
                  const updatedCond = this.replaceNodeToken(cond.condition, token, newId);
                  if (updatedCond !== cond.condition) {
                    cond.condition = updatedCond;
                    conditionsUpdated++;
                  }
                }
              });
            }
          }

          // Update edge-level parameters
          updateParamQueries(edge.p);
          updateParamQueries(edge.cost_gbp);
          updateParamQueries(edge.labour_cost);
        }
      });
    }

    // Ensure edge IDs are unique after all renames/replacements
    if (Array.isArray(nextGraph.edges)) {
      const seenIds = new Set<string>();
      nextGraph.edges.forEach((edge: any) => {
        if (!edge.id || typeof edge.id !== 'string') return;
        const baseId = edge.id;
        let candidate = baseId;
        let counter = 2;
        while (seenIds.has(candidate)) {
          candidate = `${baseId}.${counter++}`;
        }
        if (candidate !== edge.id) {
          edge.id = candidate;
          edgeIdsDeduped++;
        }
        seenIds.add(candidate);
      });
    }

    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'renameNodeId',
      details: {
        nodeUuid,
        oldId,
        newId
      }
    });

    return {
      graph: nextGraph,
      oldId,
      edgesFromToUpdated,
      edgeIdsUpdatedFromId,
      edgeIdsUpdatedFromUuid,
      queriesUpdated,
      conditionsUpdated,
      edgeIdsDeduped
    };
  }

  // ============================================================
  // Subgraph Paste (Copy-Paste)
  // ============================================================

  /**
   * Paste a subgraph (nodes + edges) into the current graph.
   * 
   * Handles:
   * - Generating new unique IDs (both uuid and human-readable id)
   * - Mapping old IDs to new IDs for edge references
   * - Offsetting node positions to avoid exact overlap
   * - Preserving all other node/edge properties
   * 
   * @param graph - Current graph
   * @param nodes - Nodes to paste
   * @param edges - Edges to paste (references will be updated to new node IDs)
   * @param positionOffset - Optional offset for node positions { x, y }
   * @returns Updated graph and mapping of old UUIDs to new UUIDs
   */
  pasteSubgraph(
    graph: any,
    nodes: any[],
    edges: any[],
    positionOffset: { x: number; y: number } = { x: 50, y: 50 }
  ): { 
    graph: any; 
    uuidMapping: Map<string, string>;
    idMapping: Map<string, string>;
    pastedNodeUuids: string[];
    pastedEdgeUuids: string[];
  } {
    const nextGraph = structuredClone(graph);
    
    // Collect existing IDs and UUIDs for uniqueness checks
    const existingNodeUuids = new Set<string>(nextGraph.nodes?.map((n: any) => n.uuid) || []);
    const existingNodeIds = nextGraph.nodes?.map((n: any) => n.id).filter(Boolean) || [];
    const existingEdgeUuids = new Set<string>(nextGraph.edges?.map((e: any) => e.uuid) || []);
    const existingEdgeIds = nextGraph.edges?.map((e: any) => e.id).filter(Boolean) || [];
    
    // Mappings from old to new
    const uuidMapping = new Map<string, string>(); // old UUID -> new UUID
    const idMapping = new Map<string, string>();   // old ID -> new ID
    const pastedNodeUuids: string[] = [];
    const pastedEdgeUuids: string[] = [];
    
    // Phase 1: Create new nodes with unique IDs
    const newNodes: any[] = [];
    for (const node of nodes) {
      // Generate new UUID
      let newUuid = crypto.randomUUID();
      while (existingNodeUuids.has(newUuid)) {
        newUuid = crypto.randomUUID();
      }
      existingNodeUuids.add(newUuid);
      
      // Generate new human-readable ID
      const baseId = node.id || node.uuid || 'node';
      const newId = generateUniqueId(baseId, existingNodeIds);
      existingNodeIds.push(newId);
      
      // Map old to new
      if (node.uuid) uuidMapping.set(node.uuid, newUuid);
      if (node.id) idMapping.set(node.id, newId);
      // Also map uuid to id mapping for edge reference resolution
      if (node.uuid) idMapping.set(node.uuid, newUuid);
      
      // Clone node with new IDs and offset position
      const newNode = structuredClone(node);
      newNode.uuid = newUuid;
      newNode.id = newId;
      
      // Update label if not overridden
      if (!newNode.label_overridden) {
        newNode.label = this.humanizeNodeId(newId);
      }
      
      // Offset position
      if (newNode.position) {
        newNode.position = {
          x: (newNode.position.x || 0) + positionOffset.x,
          y: (newNode.position.y || 0) + positionOffset.y,
        };
      } else if (newNode.x !== undefined && newNode.y !== undefined) {
        newNode.x = (newNode.x || 0) + positionOffset.x;
        newNode.y = (newNode.y || 0) + positionOffset.y;
      }
      
      newNodes.push(newNode);
      pastedNodeUuids.push(newUuid);
    }
    
    // Phase 2: Create new edges with updated references
    const newEdges: any[] = [];
    for (const edge of edges) {
      const oldFrom = edge.from;
      const oldTo = edge.to;
      
      // Resolve new from/to using the mapping
      // Check uuid mapping first, then id mapping
      const newFrom = uuidMapping.get(oldFrom) || idMapping.get(oldFrom);
      const newTo = uuidMapping.get(oldTo) || idMapping.get(oldTo);
      
      // Only include edge if both endpoints are in the pasted subgraph
      if (!newFrom || !newTo) {
        console.log('[UpdateManager] Skipping edge - endpoint not in subgraph:', { oldFrom, oldTo });
        continue;
      }
      
      // Generate new edge UUID
      let newEdgeUuid = crypto.randomUUID();
      while (existingEdgeUuids.has(newEdgeUuid)) {
        newEdgeUuid = crypto.randomUUID();
      }
      existingEdgeUuids.add(newEdgeUuid);
      
      // Find source and target node IDs for edge ID generation
      const sourceNode = newNodes.find(n => n.uuid === newFrom);
      const targetNode = newNodes.find(n => n.uuid === newTo);
      const sourceId = sourceNode?.id || newFrom;
      const targetId = targetNode?.id || newTo;
      
      // Generate new edge ID
      const baseEdgeId = edge.id || `${sourceId}-to-${targetId}`;
      const newEdgeId = generateUniqueId(`${sourceId}-to-${targetId}`, existingEdgeIds);
      existingEdgeIds.push(newEdgeId);
      
      // Clone edge with new IDs and updated references
      const newEdge = structuredClone(edge);
      newEdge.uuid = newEdgeUuid;
      newEdge.id = newEdgeId;
      newEdge.from = newFrom;
      newEdge.to = newTo;
      
      // Update query strings to use new node IDs
      if (newEdge.query && typeof newEdge.query === 'string') {
        for (const [oldId, newId] of idMapping) {
          newEdge.query = this.replaceNodeToken(newEdge.query, oldId, newId as string);
        }
      }
      
      // Update conditional probabilities
      if (Array.isArray(newEdge.conditional_p)) {
        for (const cond of newEdge.conditional_p) {
          if (cond.condition && typeof cond.condition === 'string') {
            for (const [oldId, newId] of idMapping) {
              cond.condition = this.replaceNodeToken(cond.condition, oldId, newId as string);
            }
          }
        }
      }
      
      // Update case_id if it references a pasted node
      if (newEdge.case_id) {
        const mappedCaseId = idMapping.get(newEdge.case_id);
        if (mappedCaseId) {
          newEdge.case_id = mappedCaseId;
        }
      }
      
      newEdges.push(newEdge);
      pastedEdgeUuids.push(newEdgeUuid);
    }
    
    // Add new nodes and edges to graph
    nextGraph.nodes = [...(nextGraph.nodes || []), ...newNodes];
    nextGraph.edges = [...(nextGraph.edges || []), ...newEdges];
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Log operation
    sessionLogService.info('graph', 'PASTE_SUBGRAPH', 
      `Pasted ${newNodes.length} nodes and ${newEdges.length} edges`, 
      undefined,
      { nodeCount: newNodes.length, edgeCount: newEdges.length }
    );
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'pasteSubgraph',
      details: {
        nodesAdded: newNodes.length,
        edgesAdded: newEdges.length,
        uuidMapping: Object.fromEntries(uuidMapping),
        idMapping: Object.fromEntries(idMapping),
      }
    });
    
    return {
      graph: nextGraph,
      uuidMapping,
      idMapping,
      pastedNodeUuids,
      pastedEdgeUuids,
    };
  }

  /**
   * Delete nodes and their connected edges from the graph.
   * 
   * @param graph - Current graph
   * @param nodeUuids - UUIDs of nodes to delete
   * @returns Updated graph and count of deleted items
   */
  deleteNodes(
    graph: any,
    nodeUuids: string[]
  ): { 
    graph: any; 
    deletedNodeCount: number;
    deletedEdgeCount: number;
  } {
    if (!nodeUuids || nodeUuids.length === 0) {
      return { graph, deletedNodeCount: 0, deletedEdgeCount: 0 };
    }
    
    const nextGraph = structuredClone(graph);
    const nodeUuidSet = new Set(nodeUuids);
    
    // Count nodes to be deleted
    const originalNodeCount = nextGraph.nodes?.length || 0;
    
    // Remove nodes
    nextGraph.nodes = (nextGraph.nodes || []).filter((n: any) => 
      !nodeUuidSet.has(n.uuid)
    );
    
    const deletedNodeCount = originalNodeCount - nextGraph.nodes.length;
    
    // Count edges to be deleted
    const originalEdgeCount = nextGraph.edges?.length || 0;
    
    // Remove edges connected to deleted nodes
    nextGraph.edges = (nextGraph.edges || []).filter((e: any) => {
      // Check if either endpoint is a deleted node
      // edge.from and edge.to can be either uuid or human-readable id
      // We need to check uuid first, then check if the id matches a deleted node's id
      const fromDeleted = nodeUuidSet.has(e.from);
      const toDeleted = nodeUuidSet.has(e.to);
      return !fromDeleted && !toDeleted;
    });
    
    const deletedEdgeCount = originalEdgeCount - nextGraph.edges.length;
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Log operation
    sessionLogService.info('graph', 'DELETE_NODES', 
      `Deleted ${deletedNodeCount} nodes and ${deletedEdgeCount} edges`, 
      undefined,
      { nodeCount: deletedNodeCount, edgeCount: deletedEdgeCount }
    );
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'deleteNodes',
      details: {
        nodesDeleted: deletedNodeCount,
        edgesDeleted: deletedEdgeCount,
        nodeUuids,
      }
    });
    
    return {
      graph: nextGraph,
      deletedNodeCount,
      deletedEdgeCount,
    };
  }

  /**
   * Convert a node id like "website-start-browse" into a human-readable label:
   * "Website start browse".
   */
  private humanizeNodeId(id: string): string {
    if (!id) return '';
    const withSpaces = id.replace(/-/g, ' ');
    return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
  }

  /**
   * Replace node-id tokens in a DSL string using a word-boundary regex,
   * to avoid partial replacements inside other identifiers.
   */
  private replaceNodeToken(input: string, oldToken: string, newToken: string): string {
    if (!oldToken) return input;

    // Escape regex special characters in oldToken
    const escaped = oldToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'g');
    return input.replace(pattern, newToken);
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

export const updateManager = new UpdateManager();

