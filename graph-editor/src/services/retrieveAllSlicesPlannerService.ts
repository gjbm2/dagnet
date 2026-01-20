import type { GraphData } from '../types';
import { enumerateFetchTargets } from './fetchTargetEnumerationService';

export type RetrieveAllSlicesTarget =
  | {
      type: 'parameter';
      objectId: string;
      targetId: string;
      name: string;
      paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
      conditionalIndex?: number;
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
    return enumerateFetchTargets(graph as any).map((t): RetrieveAllSlicesTarget => {
      if (t.type === 'case') {
        return {
          type: 'case',
          objectId: t.objectId,
          targetId: t.targetId,
          name: `case: ${t.objectId}`,
        };
      }

      const slot = t.paramSlot || 'p';
      const isConditional = typeof t.conditionalIndex === 'number';
      return {
        type: 'parameter',
        objectId: t.objectId,
        targetId: t.targetId,
        name: isConditional ? `conditional_p[${t.conditionalIndex}]: ${t.objectId}` : `${slot}: ${t.objectId}`,
        paramSlot: slot,
        conditionalIndex: t.conditionalIndex,
      };
    });
  }
}

export const retrieveAllSlicesPlannerService = RetrieveAllSlicesPlannerService.getInstance();


