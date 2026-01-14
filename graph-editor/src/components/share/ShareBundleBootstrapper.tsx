import React, { useEffect } from 'react';

import { useShareModeOptional } from '../../contexts/ShareModeContext';
import { GraphStoreProvider, useGraphStore } from '../../contexts/GraphStoreContext';
import { ScenariosProvider } from '../../contexts/ScenariosContext';
import { useFileState } from '../../contexts/TabContext';
import { decodeSharePayloadFromUrl } from '../../lib/sharePayload';
import { useShareBundleFromUrl } from '../../hooks/useShareBundleFromUrl';

/**
 * Share-live: bundle bootstrap host.
 *
 * Live bundles must be able to open multiple tabs (graph + chart) without relying on
 * a pre-existing workspace clone or tab restoration.
 *
 * This component bootstraps GraphStore + ScenariosContext for the seeded live graph,
 * then runs the bundle URL hook to open the described tabs.
 */
export function ShareBundleBootstrapper(): JSX.Element | null {
  const shareMode = useShareModeOptional();
  const payload = React.useMemo(() => decodeSharePayloadFromUrl(), []);

  const isEligible =
    Boolean(payload && (payload as any).target === 'bundle') &&
    Boolean(shareMode?.isLiveMode) &&
    Boolean(shareMode?.identity.graph);

  const graphFileId = React.useMemo(() => {
    if (!isEligible) return null;
    return `graph-${shareMode?.identity.graph}`;
  }, [isEligible, shareMode?.identity.graph]);

  if (!isEligible || !graphFileId) return null;

  return (
    <GraphStoreProvider fileId={graphFileId}>
      <GraphStoreBootloader fileId={graphFileId} />
      <ScenariosProvider fileId={graphFileId}>
        <BundleBootRunner graphFileId={graphFileId} />
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
  }, [data, setGraph]);

  return null;
}

function BundleBootRunner({ graphFileId }: { graphFileId: string }): null {
  useShareBundleFromUrl({ graphFileId });
  return null;
}

