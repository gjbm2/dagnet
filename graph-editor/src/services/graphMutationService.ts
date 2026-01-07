/**
 * Graph Mutation Service
 * 
 * Wraps graph updates to detect topology changes and trigger cascades (MSMDC, etc.)
 * 
 * Usage:
 *   Instead of: setGraph(newGraph)
 *   Use: graphMutationService.updateGraph(oldGraph, newGraph, setGraph, options)
 * 
 * This service will:
 * 1. Detect if topology changed (nodes/edges added/removed/reconnected)
 * 2. Trigger async query regeneration if needed
 * 3. Call setGraph with updated graph (including regenerated queries)
 * 4. Cascade to parameter files (if not overridden)
 */

import toast from 'react-hot-toast';
import { queryRegenerationService } from './queryRegenerationService';
import { sessionLogService } from './sessionLogService';
import type { Graph } from '../types';

type GraphMasteredAnchorComparison = {
  edgeUuid: string;
  edgeLocation: string;
  paramId?: string;
  latencyParameter: boolean;
  graphAnchor?: string;
  msmdcAnchor?: string | null;
  overridden: boolean;
  willApply: boolean;
  reason:
    | 'will-apply'
    | 'no-change'
    | 'skipped: overridden'
    | 'skipped: no-anchor-from-msmdc';
};

function computeDjb2Hash(input: string): string {
  // Deterministic, lightweight hash for logging/fingerprinting only (not cryptographic).
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i); // hash * 33 ^ c
  }
  // Unsigned 32-bit to hex
  return `djb2:${(hash >>> 0).toString(16)}`;
}

function computeGraphMasteredFingerprint(graph: Graph): {
  fingerprint: string;
  itemCount: number;
} {
  const items = graph.edges
    .map(e => {
      const query = typeof e.query === 'string' ? e.query : '';
      const nQuery = typeof (e as any).n_query === 'string' ? (e as any).n_query : '';
      const anchor = typeof e.p?.latency?.anchor_node_id === 'string' ? e.p.latency.anchor_node_id : '';
      const overridden = e.p?.latency?.anchor_node_id_overridden ? '1' : '0';
      return `${e.uuid}|q:${query}|nq:${nQuery}|a:${anchor}|ao:${overridden}`;
    })
    .sort();

  const joined = items.join('\n');
  return { fingerprint: computeDjb2Hash(joined), itemCount: items.length };
}

/**
 * Detect if a graph change is topology-related (vs data-only)
 */
function detectTopologyChange(oldGraph: Graph | null, newGraph: Graph | null): {
  hasChange: boolean;
  changeType?: string;
  affectedNode?: string;
} {
  if (!oldGraph || !newGraph) {
    return { hasChange: false };
  }
  
  // Check node count
  if (oldGraph.nodes.length !== newGraph.nodes.length) {
    return {
      hasChange: true,
      changeType: oldGraph.nodes.length < newGraph.nodes.length ? 'node-added' : 'node-removed'
    };
  }
  
  // Check edge count
  if (oldGraph.edges.length !== newGraph.edges.length) {
    return {
      hasChange: true,
      changeType: oldGraph.edges.length < newGraph.edges.length ? 'edge-added' : 'edge-removed'
    };
  }
  
  // Check node UUIDs (detect node replacement)
  const oldNodeUUIDs = new Set(oldGraph.nodes.map(n => n.uuid));
  const newNodeUUIDs = new Set(newGraph.nodes.map(n => n.uuid));
  for (const uuid of newNodeUUIDs) {
    if (!oldNodeUUIDs.has(uuid)) {
      return { hasChange: true, changeType: 'node-added' };
    }
  }
  for (const uuid of oldNodeUUIDs) {
    if (!newNodeUUIDs.has(uuid)) {
      return { hasChange: true, changeType: 'node-removed', affectedNode: uuid };
    }
  }
  
  // Check edge UUIDs (detect edge replacement)
  const oldEdgeUUIDs = new Set(oldGraph.edges.map(e => e.uuid));
  const newEdgeUUIDs = new Set(newGraph.edges.map(e => e.uuid));
  for (const uuid of newEdgeUUIDs) {
    if (!oldEdgeUUIDs.has(uuid)) {
      return { hasChange: true, changeType: 'edge-added' };
    }
  }
  for (const uuid of oldEdgeUUIDs) {
    if (!newEdgeUUIDs.has(uuid)) {
      return { hasChange: true, changeType: 'edge-removed' };
    }
  }
  
  // Check edge connectivity (from/to changes)
  const oldEdgeMap = new Map(oldGraph.edges.map(e => [e.uuid, `${e.from}->${e.to}`]));
  const newEdgeMap = new Map(newGraph.edges.map(e => [e.uuid, `${e.from}->${e.to}`]));
  for (const [uuid, connectivity] of newEdgeMap) {
    if (oldEdgeMap.has(uuid) && oldEdgeMap.get(uuid) !== connectivity) {
      return { hasChange: true, changeType: 'edge-connectivity-changed' };
    }
  }

  // Check latency enablement (semantic change that must trigger MSMDC for anchors)
  for (const newEdge of newGraph.edges) {
    const oldEdge = oldGraph.edges.find(e => e.uuid === newEdge.uuid);
    if (!oldEdge) continue;

    const oldLatencyEnabled = oldEdge.p?.latency?.latency_parameter === true;
    const newLatencyEnabled = newEdge.p?.latency?.latency_parameter === true;

    // Requirement: when latency_parameter transitions to true, we need MSMDC to generate anchors.
    if (!oldLatencyEnabled && newLatencyEnabled) {
      return { hasChange: true, changeType: 'latency-edge-enabled' };
    }

    // Conditional probability latency enablement should mirror base behaviour.
    // If ANY conditional_p[i].p.latency.latency_parameter transitions false→true, treat as topology-relevant
    // so MSMDC can compute anchors.
    const oldCps = Array.isArray((oldEdge as any).conditional_p) ? (oldEdge as any).conditional_p : [];
    const newCps = Array.isArray((newEdge as any).conditional_p) ? (newEdge as any).conditional_p : [];
    const count = Math.max(oldCps.length, newCps.length);
    for (let i = 0; i < count; i++) {
      const oldEnabled = oldCps?.[i]?.p?.latency?.latency_parameter === true;
      const newEnabled = newCps?.[i]?.p?.latency?.latency_parameter === true;
      if (!oldEnabled && newEnabled) {
        return { hasChange: true, changeType: 'conditional-latency-edge-enabled' };
      }
    }
  }
  
  // Check conditional_p conditions (semantic changes)
  for (let i = 0; i < newGraph.edges.length; i++) {
    const oldEdge = oldGraph.edges.find(e => e.uuid === newGraph.edges[i].uuid);
    if (!oldEdge) continue;
    
    const oldConditions = oldEdge.conditional_p?.map(c => c.condition).join(',') || '';
    const newConditions = newGraph.edges[i].conditional_p?.map(c => c.condition).join(',') || '';
    
    if (oldConditions !== newConditions) {
      return { hasChange: true, changeType: 'conditional-condition-changed' };
    }
  }
  
  return { hasChange: false };
}

class GraphMutationService {
  private regenerationInProgress = false;
  private pendingRegeneration: {
    graph: Graph;
    setGraph: ((graph: Graph | null) => void) | ((graph: Graph) => void);
  } | null = null;
  
  /**
   * Update graph with automatic query regeneration on topology changes
   * 
   * @param oldGraph - Current graph state (for change detection)
   * @param newGraph - New graph state to apply
   * @param setGraph - Function to update graph store
   * @param options - Optional configuration
   */
  async updateGraph(
    oldGraph: Graph | null,
    newGraph: Graph | null,
    setGraph: ((graph: Graph | null) => void) | ((graph: Graph) => void),
    options?: {
      skipQueryRegeneration?: boolean;
      downstreamOf?: string;
      literalWeights?: { visited: number; exclude: number };
      setAutoUpdating?: (updating: boolean) => void;
      source?: string;
    }
  ): Promise<void> {
    console.log('🔄 [GraphMutation] updateGraph called', {
      hasOldGraph: !!oldGraph,
      hasNewGraph: !!newGraph,
      oldNodeCount: oldGraph?.nodes?.length,
      newNodeCount: newGraph?.nodes?.length,
      oldEdgeCount: oldGraph?.edges?.length,
      newEdgeCount: newGraph?.edges?.length,
      skipRegen: options?.skipQueryRegeneration,
      source: options?.source,
    });
    
    if (!newGraph) {
      (setGraph as (graph: Graph | null) => void)(null);
      return;
    }
    
    // Apply graph update immediately (don't block UI)
    setGraph(newGraph);
    
    // Skip if regeneration disabled
    if (options?.skipQueryRegeneration) {
      console.log('⏭️  [GraphMutation] Skipping regeneration (disabled)');
      return;
    }
    
    // Detect topology change
    const change = detectTopologyChange(oldGraph, newGraph);
    
    if (!change.hasChange) {
      console.log('✅ [GraphMutation] No topology change detected - skipping regeneration');
      return;  // Data-only change, no query regeneration needed
    }
    
    console.log('🚨 [GraphMutation] TOPOLOGY CHANGE DETECTED:', change);
    
    // Log topology change to session log
    const changeDescriptions: Record<string, string> = {
      'node-added': 'Node added to graph',
      'node-removed': 'Node removed from graph',
      'edge-added': 'Edge added to graph',
      'edge-removed': 'Edge removed from graph',
      'edge-connectivity-changed': 'Edge connection changed',
      'latency-edge-enabled': 'Latency enabled on edge',
      'conditional-latency-edge-enabled': 'Latency enabled on conditional probability',
      'conditional-condition-changed': 'Conditional probability condition changed'
    };
    
    sessionLogService.info(
      'graph',
      `GRAPH_${(change.changeType || 'unknown').toUpperCase().replace(/-/g, '_')}`,
      changeDescriptions[change.changeType || ''] || `Graph topology changed: ${change.changeType}`,
      change.affectedNode ? `Affected: ${change.affectedNode}` : undefined
    );
    
    // If regeneration already in progress, queue this one
    if (this.regenerationInProgress) {
      console.log('[GraphMutation] Regeneration in progress, queuing...');
      this.pendingRegeneration = { graph: newGraph, setGraph };
      return;
    }
    
    // Start async regeneration (non-blocking)
    this.regenerateQueriesAsync(newGraph, setGraph, {
      downstreamOf: options?.downstreamOf || change.affectedNode,
      literalWeights: options?.literalWeights,
      setAutoUpdating: options?.setAutoUpdating
    }).catch(err => {
      console.error('[GraphMutation] Query regeneration failed:', err);
      toast.error('Failed to regenerate queries - see console');
    });
  }
  
  /**
   * Async query regeneration (runs in background)
   */
  private async regenerateQueriesAsync(
    graph: Graph,
    setGraph: ((graph: Graph | null) => void) | ((graph: Graph) => void),
    options?: {
      downstreamOf?: string;
      literalWeights?: { visited: number; exclude: number };
      setAutoUpdating?: (updating: boolean) => void;
    }
  ): Promise<void> {
    this.regenerationInProgress = true;
    const startTime = performance.now();
    
    // Set auto-updating flag for animation
    console.log('🎬 [GraphMutation] Setting isAutoUpdating = true');
    options?.setAutoUpdating?.(true);
    
    // Helper to resolve node UUID to human-readable ID
    const resolveNodeId = (uuidOrId: string): string => {
      const node = graph.nodes.find(n => n.uuid === uuidOrId || n.id === uuidOrId);
      return node?.id || uuidOrId;
    };

    const diag = sessionLogService.getDiagnosticLoggingEnabled();
    const fingerprintBefore = computeGraphMasteredFingerprint(graph);
    const graphAnchoredEdges = graph.edges.filter(e => typeof e.p?.latency?.anchor_node_id === 'string' && e.p.latency.anchor_node_id.trim().length > 0);
    const latencyEdges = graph.edges.filter(e => !!e.p?.latency?.latency_parameter);
    const latencyEdgesMissingAnchor = latencyEdges.filter(e => !(typeof e.p?.latency?.anchor_node_id === 'string' && e.p.latency.anchor_node_id.trim().length > 0));
    const anchorOverriddenEdges = graph.edges.filter(e => !!e.p?.latency?.anchor_node_id_overridden);
    
    // Start hierarchical log operation for MSMDC
    const logOpId = sessionLogService.startOperation(
      'info',
      'msmdc',
      'MSMDC_REGEN',
      `Query regeneration starting (${graph.nodes.length} nodes, ${graph.edges.length} edges)`,
      {
        nodesAffected: graph.nodes.map(n => n.id || n.uuid),
        edgesAffected: graph.edges.map(e => `${resolveNodeId(e.from)}→${resolveNodeId(e.to)}`)
      }
    );

    if (diag) {
      sessionLogService.addChild(
        logOpId,
        'info',
        'MSMDC_INPUT_GRAPH_MASTERED_STATE',
        'Input graph-mastered state fingerprint',
        `fingerprint=${fingerprintBefore.fingerprint} (edges=${fingerprintBefore.itemCount})`,
        {
          fingerprint: fingerprintBefore.fingerprint,
          edges: fingerprintBefore.itemCount,
          anchoredEdges: graphAnchoredEdges.length,
          latencyEdges: latencyEdges.length,
          latencyEdgesMissingAnchor: latencyEdgesMissingAnchor.length,
          anchorOverriddenEdges: anchorOverriddenEdges.length,
        }
      );
    }
    
    try {
      // Step 1: Call Python MSMDC
      console.log('[GraphMutation] Calling MSMDC...', {
        downstreamOf: options?.downstreamOf,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length
      });
      
      sessionLogService.addChild(
        logOpId,
        'info',
        'MSMDC_API_CALL',
        'Calling Python MSMDC API',
        options?.downstreamOf ? `Downstream of: ${options.downstreamOf}` : 'Full graph regeneration'
      );
      
      const result = await queryRegenerationService.regenerateQueries(graph, {
        downstreamOf: options?.downstreamOf,
        literalWeights: options?.literalWeights || { visited: 10, exclude: 1 },
        preserveCondition: true
      });
      
      const elapsed = performance.now() - startTime;
      console.log('[GraphMutation] MSMDC completed in', elapsed.toFixed(0), 'ms', {
        parametersGenerated: result.parameters.length
      });
      
      sessionLogService.addChild(
        logOpId,
        'success',
        'MSMDC_API_RESPONSE',
        `Python API returned ${result.parameters.length} parameter queries and ${Object.keys(result.anchors || {}).length} anchors`,
        `Duration: ${elapsed.toFixed(0)}ms`
      );

      // Diagnostic: compare MSMDC anchors vs current graph anchor state BEFORE apply, even if it will be a no-op.
      if (diag) {
        const anchorsByEdgeUuid = result.anchors || {};

        const comparisons: GraphMasteredAnchorComparison[] = [];
        for (const edge of graph.edges) {
          const msmdcAnchor = anchorsByEdgeUuid[edge.uuid]; // may be undefined if MSMDC did not return an anchor for this edge
          const graphAnchor = edge.p?.latency?.anchor_node_id;
          const overridden = !!edge.p?.latency?.anchor_node_id_overridden;
          const latencyParameter = !!edge.p?.latency?.latency_parameter;

          // Only log edges that are relevant to anchoring: latency edges, or edges with an anchor already set,
          // or edges explicitly mentioned by MSMDC in its anchors map.
          const shouldLog =
            latencyParameter ||
            typeof graphAnchor === 'string' ||
            msmdcAnchor !== undefined;
          if (!shouldLog) continue;

          const fromId = resolveNodeId(edge.from);
          const toId = resolveNodeId(edge.to);
          const edgeLocation = `edge ${fromId}→${toId}`;
          const paramId = typeof edge.p?.id === 'string' ? edge.p.id : undefined;

          let willApply = false;
          let reason: GraphMasteredAnchorComparison['reason'] = 'no-change';

          if (overridden) {
            reason = 'skipped: overridden';
          } else if (msmdcAnchor === undefined) {
            reason = 'skipped: no-anchor-from-msmdc';
          } else {
            const graphAnchorOrNull = typeof graphAnchor === 'string' && graphAnchor.trim().length > 0 ? graphAnchor : null;
            if (graphAnchorOrNull === msmdcAnchor) {
              reason = 'no-change';
            } else {
              willApply = true;
              reason = 'will-apply';
            }
          }

          comparisons.push({
            edgeUuid: edge.uuid,
            edgeLocation,
            paramId,
            latencyParameter,
            graphAnchor: graphAnchor,
            msmdcAnchor: msmdcAnchor,
            overridden,
            willApply,
            reason,
          });
        }

        const willApplyCount = comparisons.filter(c => c.willApply).length;
        const overriddenCount = comparisons.filter(c => c.reason === 'skipped: overridden').length;
        const missingFromMsmdcCount = comparisons.filter(c => c.reason === 'skipped: no-anchor-from-msmdc').length;
        const noChangeCount = comparisons.filter(c => c.reason === 'no-change').length;

        sessionLogService.addChild(
          logOpId,
          'info',
          'MSMDC_ANCHOR_COMPARISON_SUMMARY',
          'Anchor comparison (graph vs MSMDC output)',
          `willApply=${willApplyCount}, noChange=${noChangeCount}, overridden=${overriddenCount}, missingFromMSMDC=${missingFromMsmdcCount}`,
          {
            willApply: willApplyCount,
            noChange: noChangeCount,
            overridden: overriddenCount,
            missingFromMSMDC: missingFromMsmdcCount,
            totalCompared: comparisons.length,
          }
        );

        // Per-edge detail: keep bounded to avoid session log blowups on huge graphs.
        const maxPerEdge = 200;
        const shown = comparisons.slice(0, maxPerEdge);
        for (const c of shown) {
          sessionLogService.addChild(
            logOpId,
            'info',
            'MSMDC_ANCHOR_COMPARISON',
            `${c.edgeLocation}: ${c.reason}`,
            `graph=${c.graphAnchor ?? '(unset)'}; msmdc=${c.msmdcAnchor ?? (c.msmdcAnchor === null ? '(null)' : '(unset)')}`,
            {
              edgeUuid: c.edgeUuid,
              paramId: c.paramId,
              latencyParameter: c.latencyParameter,
              overridden: c.overridden,
              valuesBefore: { anchor_node_id: c.graphAnchor },
              valuesAfter: { anchor_node_id: c.msmdcAnchor ?? undefined },
              reason: c.reason,
            }
          );
        }
        if (comparisons.length > maxPerEdge) {
          sessionLogService.addChild(
            logOpId,
            'info',
            'MSMDC_ANCHOR_COMPARISON_TRUNCATED',
            'Anchor comparison truncated',
            `Showing ${maxPerEdge}/${comparisons.length} edges`,
          );
        }
      }
      
      // Step 2: Apply regenerated queries and anchors to graph
      const updatedGraph = structuredClone(graph);
      const applyResult = await queryRegenerationService.applyRegeneratedQueries(
        updatedGraph,
        result.parameters,
        result.anchors
      );
      
      console.log('[GraphMutation] Applied queries:', {
        graphUpdates: applyResult.graphUpdates,
        fileUpdates: applyResult.fileUpdates,
        skipped: applyResult.skipped
      });

      // Diagnostic children: log each change (queries, anchors, n_query)
      if (diag) {
        for (const param of applyResult.changedParameters || []) {
          sessionLogService.addChild(
            logOpId,
            'info',
            'PARAM_UPDATED',
            `Query updated: ${param.paramId}`,
            `Location: ${param.location}`,
            {
              paramId: param.paramId,
              valuesBefore: { query: param.oldQuery },
              valuesAfter: { query: param.newQuery }
            }
          );
        }

        for (const a of applyResult.changedAnchors || []) {
          sessionLogService.addChild(
            logOpId,
            'info',
            'ANCHOR_UPDATED',
            `Anchor updated: ${a.edgeLocation}`,
            `anchor_node_id: ${a.oldAnchor ?? '(unset)'} → ${a.newAnchor ?? '(unset)'}`,
            {
              edgeUuid: a.edgeUuid,
              paramId: a.paramId ?? undefined,
              valuesBefore: { anchor_node_id: a.oldAnchor },
              valuesAfter: { anchor_node_id: a.newAnchor ?? undefined },
            }
          );
        }

        for (const nq of applyResult.changedNQueries || []) {
          sessionLogService.addChild(
            logOpId,
            'info',
            'N_QUERY_UPDATED',
            `n_query updated: ${nq.paramId}`,
            `Location: ${nq.location}`,
            {
              paramId: nq.paramId,
              valuesBefore: { n_query: nq.oldNQuery },
              valuesAfter: { n_query: nq.newNQuery },
            }
          );
        }

        // File cascade decisions: WHY did we (not) write parameter/case files?
        const decisions = (applyResult as any).fileCascadeDecisions as any[] | undefined;
        if (Array.isArray(decisions) && decisions.length > 0) {
          const summary = decisions.reduce(
            (acc, d) => {
              const key = `${d.field}:${d.decision}`;
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>
          );
          sessionLogService.addChild(
            logOpId,
            'info',
            'FILE_CASCADE_SUMMARY',
            'Graph→file cascade decisions (diagnostic)',
            undefined,
            { summary, total: decisions.length }
          );

          const max = 200;
          for (const d of decisions.slice(0, max)) {
            sessionLogService.addChild(
              logOpId,
              d.decision === 'error' ? 'error' : 'info',
              'FILE_CASCADE_DECISION',
              `${d.fileId}: ${d.field} → ${d.decision}`,
              d.reason,
              {
                fileId: d.fileId,
                fileType: d.fileType,
                field: d.field,
                objectId: d.objectId,
                decision: d.decision,
                valuesBefore: d.valuesBefore,
                valuesAfter: d.valuesAfter,
                error: d.error,
              }
            );
          }
          if (decisions.length > max) {
            sessionLogService.addChild(
              logOpId,
              'info',
              'FILE_CASCADE_TRUNCATED',
              'File cascade decision list truncated',
              `Showing ${max}/${decisions.length}`
            );
          }
        } else {
          sessionLogService.addChild(
            logOpId,
            'info',
            'FILE_CASCADE_SUMMARY',
            'Graph→file cascade decisions (diagnostic)',
            'No cascaded file updates were attempted'
          );
        }
      }
      
      // Step 3: Update graph store with regenerated queries
      if (applyResult.graphUpdates > 0) {
        updatedGraph.metadata = updatedGraph.metadata || {
          version: '1.0.0',
          created_at: new Date().toISOString()
        };
        updatedGraph.metadata.updated_at = new Date().toISOString();

        // CRITICAL: Suppress File→Store sync BEFORE updating the store.
        // Otherwise, there is a race where stale `data` from FileRegistry can overwrite
        // the freshly updated graph-mastered fields (anchors, queries, n_query) we’re about to set.
        // The sync chain (GraphEditor ↔ GraphStoreContext ↔ FileRegistry) has race conditions.
        window.dispatchEvent(new CustomEvent('dagnet:suppressFileToStoreSync', { detail: { duration: 1000 } }));

        setGraph(updatedGraph);
        
        // Notify user (keep brief; details are in session log)
        toast.success(`✓ MSMDC applied ${applyResult.graphUpdates} update(s)`, { duration: 3000 });
        
        const qCount = applyResult.changedParameters?.length ?? 0;
        const aCount = applyResult.changedAnchors?.length ?? 0;
        const nqCount = applyResult.changedNQueries?.length ?? 0;

        sessionLogService.endOperation(
          logOpId,
          'success',
          `MSMDC completed: ${applyResult.graphUpdates} graph-mastered update(s) (queries=${qCount}, anchors=${aCount}, n_query=${nqCount})`,
          {
            // Back-compat field (queries only)
            parametersGenerated: applyResult.changedParameters?.map(p => ({
              paramId: p.paramId,
              query: p.newQuery?.substring(0, 80) || '',
              location: p.location,
              changed: true
            })),
            // New, explicit fields
            anchorsUpdated: applyResult.changedAnchors?.map(a => ({
              edgeUuid: a.edgeUuid,
              location: a.edgeLocation,
              paramId: a.paramId ?? undefined,
              old: a.oldAnchor,
              new: a.newAnchor ?? undefined,
            })),
            nQueriesUpdated: applyResult.changedNQueries?.map(nq => ({
              paramId: nq.paramId,
              location: nq.location,
              old: nq.oldNQuery,
              new: nq.newNQuery,
            })),
            updated: applyResult.graphUpdates,
            fileUpdates: applyResult.fileUpdates,
          }
        );
      } else {
        console.log('[GraphMutation] No graph-mastered changes needed');
        const fingerprintAfter = computeGraphMasteredFingerprint(updatedGraph);
        sessionLogService.endOperation(
          logOpId,
          'info',
          'MSMDC completed: No graph-mastered changes needed',
          diag
            ? {
                fingerprintBefore: fingerprintBefore.fingerprint,
                fingerprintAfter: fingerprintAfter.fingerprint,
                fingerprintChanged: fingerprintBefore.fingerprint !== fingerprintAfter.fingerprint,
                updated: 0,
                fileUpdates: 0,
                graphNodes: graph.nodes.length,
                graphEdges: graph.edges.length,
                anchoredEdges: graphAnchoredEdges.length,
                latencyEdges: latencyEdges.length,
                latencyEdgesMissingAnchor: latencyEdgesMissingAnchor.length,
                anchorOverriddenEdges: anchorOverriddenEdges.length,
                anchorsReturned: Object.keys(result.anchors || {}).length,
              }
            : undefined
        );
      }
      
    } catch (error) {
      console.error('[GraphMutation] Regeneration error:', error);
      // Don't throw - graph is already updated, this is just cascade failure
      toast.error('Query regeneration failed - queries may be stale');
      
      sessionLogService.endOperation(
        logOpId,
        'error',
        'MSMDC query regeneration failed',
        { error: error instanceof Error ? error.message : String(error) }
      );
    } finally {
      this.regenerationInProgress = false;
      
      // Clear auto-updating flag after a delay to ensure animations trigger
      // Components need to see isAutoUpdating=true when their values change
      setTimeout(() => {
        console.log('🎬 [GraphMutation] Setting isAutoUpdating = false');
        options?.setAutoUpdating?.(false);
      }, 100);
      
      // Process queued regeneration if any
      if (this.pendingRegeneration) {
        const { graph: pendingGraph, setGraph: pendingSetGraph } = this.pendingRegeneration;
        this.pendingRegeneration = null;
        
        console.log('[GraphMutation] Processing queued regeneration');
        await this.regenerateQueriesAsync(pendingGraph, pendingSetGraph);
      }
    }
  }
  
  /**
   * Manual trigger for query regeneration (for user-initiated regeneration)
   */
  async regenerateAllQueries(
    graph: Graph,
    setGraph: ((graph: Graph | null) => void) | ((graph: Graph) => void),
    options?: {
      literalWeights?: { visited: number; exclude: number };
    }
  ): Promise<void> {
    toast.loading('Regenerating all queries...', { id: 'query-regen' });
    
    try {
      await this.regenerateQueriesAsync(graph, setGraph, {
        downstreamOf: undefined,  // Regenerate ALL
        literalWeights: options?.literalWeights
      });
      
      toast.success('All queries regenerated', { id: 'query-regen' });
    } catch (error) {
      toast.error('Failed to regenerate queries', { id: 'query-regen' });
      throw error;
    }
  }
}

// Singleton instance
export const graphMutationService = new GraphMutationService();

