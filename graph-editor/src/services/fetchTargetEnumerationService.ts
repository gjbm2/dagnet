import type { Graph } from '../types';

export type FetchTargetType = 'parameter' | 'case';

export interface EnumeratedFetchTarget {
  type: FetchTargetType;
  objectId: string;
  targetId: string;
  /** For parameters on edges (p/cost slots). */
  paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
  /** For conditional probabilities (edge.conditional_p[index].p). */
  conditionalIndex?: number;
  /** Original graph objects (used by planners for connection checking). */
  edge?: any;
  node?: any;
}

/**
 * Canonical enumeration of fetch targets in a graph.
 *
 * This is the single source of truth for "what is fetchable":
 * - Edge parameters: p, cost_gbp, labour_cost
 * - Conditional probabilities: edge.conditional_p[i].p (with conditionalIndex)
 * - Cases: node.case.id (schema/type truth)
 *
 * IMPORTANT: We intentionally do NOT support node.case_id. That field is not part of
 * the schema/types, and treating it as real would perpetuate drift.
 */
export function enumerateFetchTargets(graph: Graph): EnumeratedFetchTarget[] {
  const targets: EnumeratedFetchTarget[] = [];

  // Parameters on edges
  if (Array.isArray((graph as any)?.edges)) {
    for (const edge of (graph as any).edges) {
      const edgeId: string = edge?.uuid || edge?.id || '';
      if (!edgeId) continue;

      const slots: Array<{ slot: 'p' | 'cost_gbp' | 'labour_cost'; param: any }> = [];
      if (edge?.p) slots.push({ slot: 'p', param: edge.p });
      if (edge?.cost_gbp) slots.push({ slot: 'cost_gbp', param: edge.cost_gbp });
      if (edge?.labour_cost) slots.push({ slot: 'labour_cost', param: edge.labour_cost });

      for (const { slot, param } of slots) {
        const paramId: string | undefined = param?.id;
        if (!paramId) continue;
        targets.push({
          type: 'parameter',
          objectId: paramId,
          targetId: edgeId,
          paramSlot: slot,
          edge,
        });
      }

      // Conditional probabilities (edge.conditional_p[i].p)
      const cps = (edge as any)?.conditional_p;
      if (Array.isArray(cps)) {
        for (let idx = 0; idx < cps.length; idx++) {
          const condParamId: string | undefined = cps[idx]?.p?.id;
          if (!condParamId) continue;
          targets.push({
            type: 'parameter',
            objectId: condParamId,
            targetId: edgeId,
            paramSlot: 'p',
            conditionalIndex: idx,
            edge,
          });
        }
      }
    }
  }

  // Cases on nodes (node.case.id)
  if (Array.isArray((graph as any)?.nodes)) {
    for (const node of (graph as any).nodes) {
      const nodeId: string = node?.uuid || node?.id || '';
      if (!nodeId) continue;
      const caseId: string | undefined = node?.case?.id;
      if (!caseId) continue;
      targets.push({
        type: 'case',
        objectId: caseId,
        targetId: nodeId,
        node,
      });
    }
  }

  return targets;
}


