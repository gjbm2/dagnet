/**
 * DataDepthContext — distributes pre-computed depth scores to edge components.
 *
 * Provided by GraphEditor when the data-depth overlay is active.
 * Consumed by ConversionEdge and EdgeBeads to colour edges and beads.
 */

import React, { createContext, useContext } from 'react';
import type { DataDepthScore } from '../services/dataDepthService';

export interface DataDepthContextValue {
  /** Per-edge depth scores, keyed by edge UUID. Null while loading. */
  scores: Map<string, DataDepthScore> | null;
  /** True while the async computation is in progress. */
  loading: boolean;
}

const DataDepthContext = createContext<DataDepthContextValue>({
  scores: null,
  loading: false,
});

export function DataDepthProvider({
  scores,
  loading,
  children,
}: DataDepthContextValue & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({ scores, loading }),
    [scores, loading],
  );
  return (
    <DataDepthContext.Provider value={value}>
      {children}
    </DataDepthContext.Provider>
  );
}

export function useDataDepthContext(): DataDepthContextValue {
  return useContext(DataDepthContext);
}
