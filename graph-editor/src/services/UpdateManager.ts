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
import { DEFAULT_T95_DAYS } from '../constants/latency';
import { normalizeToUK } from '../lib/dateFormat';

// ─── Extracted modules (src-slimdown UM-PR1) ────────────────────────────────
import { getNestedValue, setNestedValue } from './updateManager/nestedValueAccess';
import { roundToDP, roundHorizonDays } from './updateManager/roundingUtils';
import { buildAuditEntry } from './updateManager/auditLog';
import { MAPPING_CONFIGURATIONS, getMappingKey } from './updateManager/mappingConfigurations';
import { applyMappings } from './updateManager/mappingEngine';
import type { ModelVarsEntry } from '../types';
import { upsertModelVars, ukDateNow, applyPromotion } from './modelVarsResolution';

// ─── Re-exports (public API — preserve existing import paths) ───────────────
export type {
  Direction,
  Operation,
  SubDestination,
  ConflictStrategy,
  UpdateOptions,
  UpdateResult,
  FieldChange,
  Conflict,
  UpdateError,
  Warning,
  FieldMapping,
  MappingConfiguration,
} from './updateManager/types';

import type {
  Direction,
  Operation,
  SubDestination,
  UpdateOptions,
  UpdateResult,
  FieldMapping,
  MappingConfiguration,
} from './updateManager/types';

// ============================================================
// UPDATEMANAGER CLASS
// ============================================================

export class UpdateManager {
  // Module-level MAPPING_CONFIGURATIONS replaces the old lazy-init static cache.
  // It's a module-level constant (eager-init singleton) built once on first import.
  private mappingConfigurations: ReadonlyMap<string, MappingConfiguration>;
  private auditLog: any[];

  constructor() {
    this.auditLog = [];
    this.mappingConfigurations = MAPPING_CONFIGURATIONS;
  }
  
  /**
   * Round a number to standard precision (PRECISION_DECIMAL_PLACES) to avoid
   * floating-point noise and ensure consistent values across the application.
   */
  private roundToDP(value: number): number {
    return roundToDP(value);
  }

  /**
   * Round latency horizons (days) to standard persisted precision.
   *
   * These are not probabilities; we intentionally use a separate precision constant
   * from `PRECISION_DECIMAL_PLACES`.
   */
  private roundHorizonDays(value: number): number {
    return roundHorizonDays(value);
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

    // MODEL_VARS: auto-create manual entry when overriding a model var field (doc 15 §5.3).
    // Centralised here so context menus, rebalance, and any other entry point all trigger it.
    if (setOverrideFlag && changesApplied > 0 && edge.p.model_vars?.length) {
      const existing = edge.p.model_vars.find((e: any) => e.source === 'manual');
      const base = existing ?? {
        source: 'manual' as const,
        source_at: ukDateNow(),
        probability: { mean: edge.p.mean ?? 0, stdev: edge.p.stdev ?? 0 },
        ...(edge.p.latency?.mu != null ? {
          latency: {
            mu: edge.p.latency.mu, sigma: edge.p.latency.sigma ?? 0,
            t95: edge.p.latency.t95 ?? 0, onset_delta_days: edge.p.latency.onset_delta_days ?? 0,
            ...(edge.p.latency.path_mu != null ? { path_mu: edge.p.latency.path_mu } : {}),
            ...(edge.p.latency.path_sigma != null ? { path_sigma: edge.p.latency.path_sigma } : {}),
            ...(edge.p.latency.path_t95 != null ? { path_t95: edge.p.latency.path_t95 } : {}),
          },
        } : {}),
      };
      const updated = { ...base, source_at: ukDateNow() };
      // Edge.p.mean/stdev already have the new values from above
      updated.probability = { mean: edge.p.mean ?? 0, stdev: edge.p.stdev ?? 0 };
      upsertModelVars(edge.p, updated);
      edge.p.model_source_preference = 'manual';
      edge.p.model_source_preference_overridden = true;
      applyPromotion(edge.p, nextGraph.model_source_preference);
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
      evidence?: { n?: number; k?: number; scope_from?: string; scope_to?: string; retrieved_at?: string; source?: string };
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
      if (updates.evidence.scope_from !== undefined) {
        condEntry.p.evidence.scope_from = normalizeToUK(updates.evidence.scope_from);
        changesApplied++;
      }
      if (updates.evidence.scope_to !== undefined) {
        condEntry.p.evidence.scope_to = normalizeToUK(updates.evidence.scope_to);
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
   * Cascade graph.defaultConnection to all edge param slots where
   * connection_overridden is not true.
   * 
   * Mutates the graph in place and returns the number of slots updated.
   */
  cascadeDefaultConnection(graph: any): number {
    const defaultConn: string | undefined = graph?.defaultConnection;
    let changed = 0;

    for (const edge of (graph?.edges ?? [])) {
      for (const slot of ['p', 'cost_gbp', 'labour_cost'] as const) {
        const param = edge[slot];
        if (!param) continue;
        if (param.connection_overridden) continue;
        if (param.connection !== defaultConn) {
          param.connection = defaultConn;
          changed++;
        }
      }
    }

    return changed;
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
    const isValidateOnly = options.validateOnly === true;
    const sourceId = source?.id || source?.uuid || source?.p?.id || source?.case?.id || 'graph';
    const targetId = target?.id || target?.fileId || null;
    const fallbackId =
      subDest === 'parameter'
        ? (source?.p?.id || source?.id || source?.uuid)
        : (source?.id || source?.uuid);
    const fileBaseId = targetId || fallbackId || null;
    const fileId = fileBaseId ? `${subDest}-${fileBaseId}` : 'unknown';

    // Session logs are user-facing. validateOnly calls are internal dry-runs and should not spam the log.
    if (!isValidateOnly) {
      sessionLogService.info(
        'data-update',
        `GRAPH_TO_FILE_${operation}`,
        `${operation} ${subDest} file from graph`,
        `Source: ${sourceId}`,
        { fileId, fileType: subDest, sourceId }
      );
    }
    
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
      
      if (result.success && !isValidateOnly) {
        sessionLogService.success(
          'data-update',
          `GRAPH_TO_FILE_${operation}_SUCCESS`,
          `${operation} ${subDest} file completed`,
          result.changes?.length ? `${result.changes.length} field(s) updated` : undefined,
          { fileId, fileType: subDest, sourceId }
        );
      }
      return result;
    } catch (error) {
      console.error('[UpdateManager] update:error', { direction: 'graph_to_file', operation, subDest, error });
      if (!isValidateOnly) {
        sessionLogService.error(
          'data-update',
          `GRAPH_TO_FILE_${operation}_ERROR`,
          `${operation} ${subDest} file failed`,
          error instanceof Error ? error.message : String(error),
          { fileId, fileType: subDest, sourceId }
        );
      }
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
    
    // MODEL_VARS: Build analytic entry from cascaded file values (doc 15 §5.1).
    // Attached as metadata so callers can upsert onto the edge after applying changes.
    if (result.success && subDest === 'parameter') {
      const isProbType = fileData.type === 'probability' ||
        fileData.type === 'conditional_probability' ||
        fileData.parameter_type === 'probability' ||
        fileData.parameter_type === 'conditional_probability';

      if (isProbType) {
        const latestValue = getNestedValue(fileData, 'values[latest]');
        if (latestValue) {
          const entry: ModelVarsEntry = {
            source: 'analytic',
            source_at: latestValue.data_source?.retrieved_at || latestValue.window_to || ukDateNow(),
            probability: {
              mean: latestValue.mean,
              stdev: latestValue.stdev,
            },
          };

          // Add latency block when mu/sigma are present on the file
          const lat = fileData.latency;
          if (lat?.mu != null && lat?.sigma != null) {
            entry.latency = {
              mu: lat.mu,
              sigma: lat.sigma,
              t95: lat.t95 ?? 0,
              onset_delta_days: lat.onset_delta_days ?? 0,
              ...(lat.path_mu != null ? { path_mu: lat.path_mu } : {}),
              ...(lat.path_sigma != null ? { path_sigma: lat.path_sigma } : {}),
              ...(lat.path_t95 != null ? { path_t95: lat.path_t95 } : {}),
              ...(lat.path_onset_delta_days != null ? { path_onset_delta_days: lat.path_onset_delta_days } : {}),
            };
          }

          result.metadata = result.metadata || {};
          (result.metadata as any).analyticModelVarsEntry = entry;
        }
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
  // (Implementation extracted to updateManager/mappingEngine.ts)
  // ============================================================

  private async applyMappings(
    source: any,
    target: any,
    mappings: FieldMapping[],
    options: UpdateOptions
  ): Promise<UpdateResult> {
    return applyMappings(source, target, mappings, options);
  }
  
  private getMappingKey(
    direction: Direction,
    operation: Operation,
    subDest?: SubDestination
  ): string {
    return getMappingKey(direction, operation, subDest);
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  private getNestedValue(obj: any, path: string): any {
    return getNestedValue(obj, path);
  }

  private setNestedValue(obj: any, path: string, value: any): void {
    setNestedValue(obj, path, value);
  }
  
  private recordUpdate(
    operation: Operation,
    direction: Direction,
    subDest: SubDestination | undefined,
    source: any,
    target: any
  ): void {
    this.auditLog.push(buildAuditEntry(operation, direction, subDest, source, target));
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
      /** 
       * Index into conditional_p array. 
       * undefined = base edge probability (edge.p)
       * number = conditional probability (edge.conditional_p[conditionalIndex].p)
       */
      conditionalIndex?: number;
      latency: {
        median_lag_days?: number;
        mean_lag_days?: number;
        t95: number;
        completeness: number;
        path_t95: number;
        onset_delta_days?: number;
      };
      blendedMean?: number;
      forecast?: {
        mean?: number;
      };
      evidence?: {
        mean?: number;
        n?: number;
        k?: number;
        stdev?: number;
      };
    }>,
    opts?: { writeHorizonsToGraph?: boolean }
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
    
    const writeHorizonsToGraph = opts?.writeHorizonsToGraph === true;

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
      
      // PARITY PRINCIPLE: Handle both base edge (edge.p) and conditional probabilities (edge.conditional_p[i].p)
      const conditionalIndex = update.conditionalIndex;
      let targetP: any;
      
      if (typeof conditionalIndex === 'number') {
        // Writing to conditional probability
        if (!edge.conditional_p?.[conditionalIndex]?.p) {
          console.warn('[UpdateManager] applyBatchLAGValues: conditional_p entry not found:', {
            edgeId: update.edgeId,
            conditionalIndex,
          });
          continue;
        }
        targetP = edge.conditional_p[conditionalIndex].p;
      } else {
        // Writing to base edge probability
        if (!edge.p) {
          edge.p = {};
        }
        targetP = edge.p;
      }
      
      // Ensure latency object exists on target
      if (!targetP.latency) {
        targetP.latency = {};
      }
      
      // Apply latency values (to targetP which is either edge.p or edge.conditional_p[i].p)
      if (update.latency.median_lag_days !== undefined) {
        targetP.latency.median_lag_days = update.latency.median_lag_days;
      }
      if (update.latency.mean_lag_days !== undefined) {
        targetP.latency.mean_lag_days = update.latency.mean_lag_days;
      }
      // Phase 2: respect override flags
      if (writeHorizonsToGraph) {
        if (targetP.latency.t95_overridden !== true) {
          targetP.latency.t95 = this.roundHorizonDays(update.latency.t95);
        }
      }
      targetP.latency.completeness = update.latency.completeness;
      if (writeHorizonsToGraph) {
        if (targetP.latency.path_t95_overridden !== true) {
          targetP.latency.path_t95 = this.roundHorizonDays(update.latency.path_t95);
        }
      }
      // onset_delta_days: only write if not overridden and value provided
      if ((update.latency as any).onset_delta_days !== undefined && 
          targetP.latency.onset_delta_days_overridden !== true) {
        targetP.latency.onset_delta_days = (update.latency as any).onset_delta_days;
      }
      // mu/sigma: fitted model params (internal, always written when available)
      if ((update.latency as any).mu !== undefined) {
        targetP.latency.mu = (update.latency as any).mu;
      }
      if ((update.latency as any).sigma !== undefined) {
        targetP.latency.sigma = (update.latency as any).sigma;
      }
      // path_mu/path_sigma/path_onset_delta_days: path-level A→Y CDF params (Fenton–Wilkinson combined)
      if ((update.latency as any).path_mu !== undefined) {
        targetP.latency.path_mu = (update.latency as any).path_mu;
      }
      if ((update.latency as any).path_sigma !== undefined) {
        targetP.latency.path_sigma = (update.latency as any).path_sigma;
      }
      if ((update.latency as any).path_onset_delta_days !== undefined) {
        targetP.latency.path_onset_delta_days = (update.latency as any).path_onset_delta_days;
      }
      
      // Apply forecast if provided
      if (update.forecast) {
        if (!targetP.forecast) {
          targetP.forecast = {};
        }
        if (update.forecast.mean !== undefined) {
          targetP.forecast.mean = update.forecast.mean;
        }
      }
      
      // Apply evidence if provided
      if (update.evidence) {
        if (!targetP.evidence) {
          targetP.evidence = {};
        }
        if (update.evidence.mean !== undefined) {
          targetP.evidence.mean = update.evidence.mean;
        }
        if (update.evidence.n !== undefined) {
          targetP.evidence.n = update.evidence.n;
        }
        if (update.evidence.k !== undefined) {
          targetP.evidence.k = update.evidence.k;
        }
        if (update.evidence.stdev !== undefined) {
          targetP.evidence.stdev = update.evidence.stdev;
        }
      }

      // Keep p.stdev consistently populated when the topo/LAG pass updates p.mean but
      // does not provide a corresponding blended stdev. Use evidence.stdev if available.
      // Respect explicit overrides.
      if (targetP.stdev_overridden !== true && targetP.stdev === undefined) {
        const es = (targetP.evidence as any)?.stdev;
        if (typeof es === 'number' && Number.isFinite(es)) {
          targetP.stdev = this.roundToDP(es);
        }
      }
      
      console.log('[UpdateManager] applyBatchLAGValues: Applied latency to edge:', {
        edgeId: update.edgeId,
        edgeIndex,
        conditionalIndex: update.conditionalIndex,
        t95: targetP.latency.t95,
        completeness: targetP.latency.completeness,
        path_t95: targetP.latency.path_t95,
        forecastMean: targetP.forecast?.mean,
        evidenceMean: targetP.evidence?.mean,
      });
      
      // Apply blended mean if provided and different.
      // Fallback: when blendedMean is unavailable (no forecast/completeness yet, e.g. first
      // fetch on a new graph), use raw evidence.mean so that p.mean reflects observed data
      // and sibling rebalancing fires correctly.
      if (update.blendedMean !== undefined) {
        const oldMean = targetP.mean;
        if (oldMean !== update.blendedMean) {
          targetP.mean = this.roundToDP(update.blendedMean);
          // Only rebalance sibling edges for base edge p.mean updates.
          // Conditional probability rebalancing is handled via the dedicated conditional rebalance flows.
          if (update.conditionalIndex === undefined) {
            edgesToRebalance.push(update.edgeId);
          }
        }
      } else if (update.evidence?.mean !== undefined && targetP.mean_overridden !== true) {
        // No blend available (no forecast or completeness yet) — fall back to raw evidence
        const oldMean = targetP.mean;
        const evidenceMean = this.roundToDP(update.evidence.mean);
        if (oldMean !== evidenceMean) {
          targetP.mean = evidenceMean;
          if (update.conditionalIndex === undefined) {
            edgesToRebalance.push(update.edgeId);
          }
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
    positionOffset: { x: number; y: number } = { x: 50, y: 50 },
    postits?: any[],
    canvasObjects?: { containers?: any[]; canvasAnalyses?: any[] }
  ): { 
    graph: any; 
    uuidMapping: Map<string, string>;
    idMapping: Map<string, string>;
    pastedNodeUuids: string[];
    pastedEdgeUuids: string[];
    pastedPostitIds: string[];
    pastedCanvasObjectIds: Record<string, string[]>;
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
      
      // Offset position — graph nodes use layout.{x,y}
      if (newNode.layout) {
        newNode.layout = {
          ...newNode.layout,
          x: (newNode.layout.x || 0) + positionOffset.x,
          y: (newNode.layout.y || 0) + positionOffset.y,
        };
      } else if (newNode.position) {
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
      
      // Remap node references in edge fields using the same patterns as renameNodeId
      const remapString = (str: string): string => {
        let result = str;
        for (const [old, mapped] of idMapping) {
          result = this.replaceNodeToken(result, old, mapped as string);
        }
        return result;
      };

      const remapParamQueries = (param: any) => {
        if (!param || typeof param !== 'object') return;
        if (param.query && typeof param.query === 'string') {
          param.query = remapString(param.query);
        }
        if (param.n_query && typeof param.n_query === 'string') {
          param.n_query = remapString(param.n_query);
        }
        if (Array.isArray(param.conditional_probabilities)) {
          for (const cond of param.conditional_probabilities) {
            if (cond.condition && typeof cond.condition === 'string') {
              cond.condition = remapString(cond.condition);
            }
          }
        }
        if (param.latency?.anchor_node_id) {
          const mapped = idMapping.get(param.latency.anchor_node_id);
          if (mapped) param.latency.anchor_node_id = mapped;
        }
      };

      // Edge-level query and n_query
      if (newEdge.query && typeof newEdge.query === 'string') {
        newEdge.query = remapString(newEdge.query);
      }
      if (newEdge.n_query && typeof newEdge.n_query === 'string') {
        newEdge.n_query = remapString(newEdge.n_query);
      }

      // Edge-level conditional probabilities
      if (Array.isArray(newEdge.conditional_p)) {
        for (const cond of newEdge.conditional_p) {
          if (cond.condition && typeof cond.condition === 'string') {
            cond.condition = remapString(cond.condition);
          }
        }
      }
      
      // Edge-level parameter objects (p, cost_gbp, labour_cost)
      remapParamQueries(newEdge.p);
      remapParamQueries(newEdge.cost_gbp);
      remapParamQueries(newEdge.labour_cost);

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
    
    // Phase 3: Paste canvas objects (postits, containers, analyses) — generic
    const pastedCanvasObjectIds: Record<string, string[]> = {};

    const pasteCanvasArray = (sourceItems: any[] | undefined, graphKey: string) => {
      if (!sourceItems || sourceItems.length === 0) return;
      const existing = new Set<string>((nextGraph[graphKey] || []).map((p: any) => p.id));
      const newItems: any[] = [];
      const ids: string[] = [];

      for (const item of sourceItems) {
        let newId = crypto.randomUUID();
        while (existing.has(newId)) newId = crypto.randomUUID();
        existing.add(newId);

        const clone = structuredClone(item);
        clone.id = newId;
        clone.x = (clone.x || 0) + positionOffset.x;
        clone.y = (clone.y || 0) + positionOffset.y;

        newItems.push(clone);
        ids.push(newId);
      }

      nextGraph[graphKey] = [...(nextGraph[graphKey] || []), ...newItems];
      pastedCanvasObjectIds[graphKey] = ids;
    };

    pasteCanvasArray(postits, 'postits');
    pasteCanvasArray(canvasObjects?.containers, 'containers');
    pasteCanvasArray(canvasObjects?.canvasAnalyses, 'canvasAnalyses');

    // Backward-compat alias
    const pastedPostitIds = pastedCanvasObjectIds['postits'] || [];
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Log operation
    const totalCanvasObjects = Object.values(pastedCanvasObjectIds).reduce((s, a) => s + a.length, 0);
    const logParts = [`${newNodes.length} nodes`, `${newEdges.length} edges`];
    if (totalCanvasObjects > 0) logParts.push(`${totalCanvasObjects} canvas objects`);
    sessionLogService.info('graph', 'PASTE_SUBGRAPH', 
      `Pasted ${logParts.join(' and ')}`, 
      undefined,
      { nodeCount: newNodes.length, edgeCount: newEdges.length, canvasObjectCount: totalCanvasObjects }
    );
    
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'pasteSubgraph',
      details: {
        nodesAdded: newNodes.length,
        edgesAdded: newEdges.length,
        canvasObjectsAdded: pastedCanvasObjectIds,
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
      pastedPostitIds,
      pastedCanvasObjectIds,
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

