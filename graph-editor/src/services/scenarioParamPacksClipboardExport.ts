import type { ScenarioParams } from '../types/scenarios';
import { formatDateUK } from '../lib/dateFormat';

export type ScenarioParamPacksClipboardExport = {
  exported_at_uk: string;
  exported_at_ms: number;
  fileId?: string;
  tabId?: string;
  baseDSL?: string;
  currentDSL?: string;
  layers: Array<{
    id: string;
    name: string;
    colour: string;
    kind: 'base' | 'current' | 'scenario';
    // Optional: record the *requested* and *effective* DSL for this layer (if known).
    // - For 'current': requested=currentDSL, effective=currentDSL
    // - For 'base': requested=baseDSL, effective=baseDSL
    // - For scenarios: requested=meta.queryDSL, effective=meta.lastEffectiveDSL (if present)
    queryDSL?: string;
    effectiveDSL?: string;
    // Fully materialised param pack for this layer (nested JSON).
    // This is intentionally not flattened; it is more economical and more "JSON-y".
    params: ScenarioParams;
  }>;
};

export function formatScenarioParamPacksForClipboard(args: {
  layers: ScenarioParamPacksClipboardExport['layers'];
  baseDSL?: string;
  currentDSL?: string;
  fileId?: string;
  tabId?: string;
}): { text: string; byteLength: number; scenarioCount: number } {
  const now = new Date();

  const exportObj: ScenarioParamPacksClipboardExport = {
    exported_at_uk: formatDateUK(now),
    exported_at_ms: now.getTime(),
    fileId: args.fileId,
    tabId: args.tabId,
    baseDSL: args.baseDSL,
    currentDSL: args.currentDSL,
    layers: args.layers,
  };

  const text = JSON.stringify(exportObj, null, 2);
  const byteLength = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
  return { text, byteLength, scenarioCount: args.layers.length };
}


