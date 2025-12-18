import type { GraphData } from '../types';

export type RetrieveAllSlicesTarget =
  | {
      type: 'parameter';
      objectId: string;
      targetId: string;
      name: string;
      paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
    }
  | {
      type: 'case';
      objectId: string;
      targetId: string;
      name: string;
    };

/**
 * Centralised planner for "Retrieve All Slices" / batch data operations.
 *
 * IMPORTANT:
 * - UI files should not contain business logic for determining which items are in-scope.
 * - This is intentionally minimal: it only enumerates graph-linked parameters/cases.
 */
class RetrieveAllSlicesPlannerService {
  private static instance: RetrieveAllSlicesPlannerService;

  static getInstance(): RetrieveAllSlicesPlannerService {
    if (!RetrieveAllSlicesPlannerService.instance) {
      RetrieveAllSlicesPlannerService.instance = new RetrieveAllSlicesPlannerService();
    }
    return RetrieveAllSlicesPlannerService.instance;
  }

  collectTargets(graph: GraphData): RetrieveAllSlicesTarget[] {
    const items: RetrieveAllSlicesTarget[] = [];

    // Collect parameters from edges
    if (graph.edges) {
      for (const edge of graph.edges as any[]) {
        const edgeId: string = edge.uuid || edge.id || '';
        if (!edgeId) continue;

        if (edge.p?.id && typeof edge.p.id === 'string') {
          items.push({
            type: 'parameter',
            objectId: edge.p.id,
            targetId: edgeId,
            name: `p: ${edge.p.id}`,
            paramSlot: 'p',
          });
        }

        if (edge.cost_gbp?.id && typeof edge.cost_gbp.id === 'string') {
          items.push({
            type: 'parameter',
            objectId: edge.cost_gbp.id,
            targetId: edgeId,
            name: `cost_gbp: ${edge.cost_gbp.id}`,
            paramSlot: 'cost_gbp',
          });
        }

        if (edge.labour_cost?.id && typeof edge.labour_cost.id === 'string') {
          items.push({
            type: 'parameter',
            objectId: edge.labour_cost.id,
            targetId: edgeId,
            name: `labour_cost: ${edge.labour_cost.id}`,
            paramSlot: 'labour_cost',
          });
        }
      }
    }

    // Collect cases from nodes
    if (graph.nodes) {
      for (const node of graph.nodes as any[]) {
        const nodeId: string = node.uuid || node.id || '';
        if (!nodeId) continue;

        if (node.case?.id && typeof node.case.id === 'string') {
          items.push({
            type: 'case',
            objectId: node.case.id,
            targetId: nodeId,
            name: `case: ${node.case.id}`,
          });
        }
      }
    }

    return items;
  }
}

export const retrieveAllSlicesPlannerService = RetrieveAllSlicesPlannerService.getInstance();


