/**
 * scenarioRehydrationService — match canvas view scenario blueprints against
 * existing scenarios and determine which need creation.
 *
 * Pure matching logic lives here. Actual scenario creation (which requires
 * ScenariosContext) is handled by the caller (typically GraphCanvas).
 */

import type { CanvasViewScenario, CanvasViewLayerVisibility } from '@/types';
import type { ScenarioVisibilityMode } from '@/types';

/** A scenario from the current session (from ScenariosContext). */
export interface ExistingScenario {
  id: string;
  name: string;
  colour: string;
  meta?: { queryDSL?: string; whatIfDSL?: string; isLive?: boolean };
  params?: Record<string, any>;
}

/** Result of matching a blueprint against existing scenarios. */
export interface RehydrationPlan {
  /** Matched or created scenario ID → blueprint, in stack order. */
  entries: RehydrationEntry[];
  /** Scenario IDs in visibility order (visibleScenarioIds for tab state). */
  visibleScenarioIds: string[];
  /** Full scenario order (scenarioOrder for tab state). */
  scenarioOrder: string[];
  /** Per-scenario visibility modes. */
  visibilityMode: Record<string, ScenarioVisibilityMode>;
}

export interface RehydrationEntry {
  blueprint: CanvasViewScenario;
  /** Existing scenario ID if matched, null if needs creation. */
  existingId: string | null;
}

/**
 * Match view scenario blueprints against existing scenarios.
 *
 * Matching rules (same as share bundle):
 * - Live scenarios: match by (queryDSL, name, colour). Never reuse the same ID twice.
 * - Static scenarios: match by (name, colour). Param content not compared (too expensive).
 *
 * Returns a plan with matched IDs and unmatched blueprints that need creation.
 */
export function buildRehydrationPlan(
  blueprints: CanvasViewScenario[],
  existing: ExistingScenario[],
  currentLayer?: CanvasViewLayerVisibility,
  baseLayer?: CanvasViewLayerVisibility,
): RehydrationPlan {
  const usedIds = new Set<string>();
  const entries: RehydrationEntry[] = [];

  // Sort blueprints by order to ensure deterministic stack position
  const sorted = [...blueprints].sort((a, b) => a.order - b.order);

  for (const bp of sorted) {
    let match: ExistingScenario | undefined;

    if (bp.is_live && bp.queryDSL) {
      // Live scenario: match by (queryDSL, name, colour)
      match = existing.find(s => {
        if (usedIds.has(s.id)) return false;
        if (s.meta?.queryDSL !== bp.queryDSL) return false;
        if (s.name !== bp.name) return false;
        if (s.colour !== bp.colour) return false;
        return true;
      });
    } else {
      // Static scenario: match by (name, colour)
      match = existing.find(s => {
        if (usedIds.has(s.id)) return false;
        if (s.meta?.queryDSL) return false; // Skip live scenarios
        if (s.name !== bp.name) return false;
        if (s.colour !== bp.colour) return false;
        return true;
      });
    }

    if (match) {
      usedIds.add(match.id);
      entries.push({ blueprint: bp, existingId: match.id });
    } else {
      entries.push({ blueprint: bp, existingId: null });
    }
  }

  // Build tab state from the plan (placeholder IDs for unmatched entries
  // will be replaced after creation by the caller)
  const scenarioOrder: string[] = [];
  const visibleScenarioIds: string[] = [];
  const visibilityMode: Record<string, ScenarioVisibilityMode> = {};

  // Current pseudo-scenario (top of stack)
  if (currentLayer?.visible !== false) visibleScenarioIds.push('current');
  if (currentLayer?.visibility_mode) visibilityMode['current'] = currentLayer.visibility_mode;

  // User scenarios (in stack order, between current and base)
  for (const entry of entries) {
    const id = entry.existingId ?? `__pending_${entry.blueprint.order}`;
    scenarioOrder.push(id);
    if (entry.blueprint.visible) visibleScenarioIds.push(id);
    if (entry.blueprint.visibility_mode) visibilityMode[id] = entry.blueprint.visibility_mode;
  }

  // Base pseudo-scenario (bottom of stack)
  if (baseLayer?.visible) visibleScenarioIds.push('base');
  if (baseLayer?.visibility_mode) visibilityMode['base'] = baseLayer.visibility_mode;

  // scenarioOrder must include current (always present in order)
  scenarioOrder.push('current');

  return { entries, visibleScenarioIds, scenarioOrder, visibilityMode };
}

/**
 * Finalise a rehydration plan after pending scenarios have been created.
 * Replaces placeholder IDs with real ones.
 */
export function finalisePlan(
  plan: RehydrationPlan,
  createdIds: Map<number, string>, // blueprint.order → created scenario ID
): {
  visibleScenarioIds: string[];
  scenarioOrder: string[];
  visibilityMode: Record<string, ScenarioVisibilityMode>;
} {
  const replaceId = (id: string): string => {
    if (!id.startsWith('__pending_')) return id;
    const order = parseInt(id.replace('__pending_', ''), 10);
    return createdIds.get(order) ?? id;
  };

  return {
    visibleScenarioIds: plan.visibleScenarioIds.map(replaceId),
    scenarioOrder: plan.scenarioOrder.map(replaceId),
    visibilityMode: Object.fromEntries(
      Object.entries(plan.visibilityMode).map(([k, v]) => [replaceId(k), v])
    ),
  };
}
