import React, { useEffect } from 'react';

import { useShareModeOptional } from '../../contexts/ShareModeContext';
import { GraphStoreProvider, useGraphStore } from '../../contexts/GraphStoreContext';
import { ScenariosProvider, useScenariosContextOptional } from '../../contexts/ScenariosContext';
import { useFileState } from '../../contexts/TabContext';
import { decodeSharePayloadFromUrl } from '../../lib/sharePayload';
import { useShareChartFromUrl } from '../../hooks/useShareChartFromUrl';

/**
 * Share-live: chart-only bootstrap host.
 *
 * Why this exists:
 * - ChartViewer can render a chart tab without GraphEditor.
 * - But live chart share recomputation needs GraphStore + ScenariosContext.
 * - We want chart-only share links to open ONLY the chart tab (no visible graph tab).
 *
 * This component:
 * - Bootstraps GraphStore from the graph file in FileRegistry/IndexedDB
 * - Mounts ScenariosProvider for that graph
 * - Runs the existing share chart URL boot hook
 *
 * It renders nothing (logic host only).
 */
export function ShareChartBootstrapper(): JSX.Element | null {
  const shareMode = useShareModeOptional();

  const payload = React.useMemo(() => decodeSharePayloadFromUrl(), []);
  const isEligible =
    Boolean(payload && payload.target === 'chart') &&
    Boolean(shareMode?.isLiveMode) &&
    Boolean(shareMode?.identity.graph);

  const graphFileId = React.useMemo(() => {
    if (!isEligible) return null;
    return `graph-${shareMode?.identity.graph}`;
  }, [isEligible, shareMode?.identity.graph]);

  if (!isEligible || !graphFileId) return null;

  // Dev-only introspection for Playwright debugging.
  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    try {
      (window as any).__dagnetShareChartBootstrapper = {
        mountedAtMs: Date.now(),
        graphFileId,
        mode: 'mounted',
      };
    } catch {
      // ignore
    }
  }, [graphFileId]);

  return (
    <GraphStoreProvider fileId={graphFileId}>
      <GraphStoreBootloader fileId={graphFileId} />
      <ScenariosProvider fileId={graphFileId}>
        <ScenariosReadyMarker />
        <ShareChartBootRunner fileId={graphFileId} />
      </ScenariosProvider>
    </GraphStoreProvider>
  );
}

function GraphStoreBootloader({ fileId }: { fileId: string }): null {
  const { data } = useFileState(fileId);
  const setGraph = useGraphStore(s => s.setGraph);

  useEffect(() => {
    if (!data) return;
    setGraph(data as any);
    if (import.meta.env.DEV) {
      try {
        const o = (window as any).__dagnetShareChartBootstrapper;
        if (o) o.mode = 'graph-set';
      } catch {
        // ignore
      }
    }
  }, [data, setGraph]);

  return null;
}

function ShareChartBootRunner({ fileId }: { fileId: string }): null {
  // No tabId: we are intentionally not creating a visible graph tab.
  useShareChartFromUrl({ fileId });
  return null;
}

function ScenariosReadyMarker(): null {
  // Dev-only introspection for Playwright: confirm ScenariosContext is mounted + ready.
  const scenariosContext = useScenariosContextOptional();

  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    try {
      const o = (window as any).__dagnetShareChartBootstrapper;
      if (!o) return;
      if (scenariosContext && o.mode === 'graph-set') o.mode = 'scenarios-mounted';
      if (scenariosContext?.scenariosReady && (o.mode === 'scenarios-mounted' || o.mode === 'graph-set')) o.mode = 'scenarios-ready';
    } catch {
      // ignore
    }
  }, [scenariosContext, scenariosContext?.scenariosReady]);

  return null;
}

