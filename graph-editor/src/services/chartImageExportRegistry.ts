/**
 * chartImageExportRegistry — bridges an outer toolbar to the ECharts instance
 * owned by an AnalysisChartContainer.
 *
 * Only AnalysisChartContainer holds a chart's ECharts instance, but some
 * download controls live outside it (e.g. the ChartViewer header button). A
 * container registers a getter under a stable key; outer surfaces resolve the
 * live instance by that key when the user clicks Download. Mirrors the same
 * pattern used by canvasAnalysisRefreshRegistry.
 */

import type { ChartImageSource } from './chartImageExportService';

type ChartInstanceGetter = () => ChartImageSource | null;

const providers = new Map<string, ChartInstanceGetter>();

export function registerChartImageProvider(key: string, getter: ChartInstanceGetter): void {
  providers.set(key, getter);
}

export function unregisterChartImageProvider(key: string, getter: ChartInstanceGetter): void {
  if (providers.get(key) === getter) providers.delete(key);
}

/** Resolve the live chart instance for a key, or null if none is registered/ready. */
export function getChartImageInstance(key: string): ChartImageSource | null {
  const getter = providers.get(key);
  return getter ? getter() : null;
}
