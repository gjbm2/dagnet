import { useCallback } from 'react';
import type { GraphData } from '../types';
import { lagHorizonsService } from '../services/lagHorizonsService';

export function useLagHorizons(args: {
  getGraph: () => GraphData | null;
  setGraph: (g: GraphData | null) => void;
  getCurrentDsl: () => string;
}) {
  const recomputeGlobal = useCallback(async () => {
    await lagHorizonsService.recomputeHorizons({
      mode: 'global',
      getGraph: args.getGraph,
      setGraph: args.setGraph,
      reason: 'data-menu',
    });
  }, [args.getGraph, args.setGraph]);

  const recomputeCurrent = useCallback(async () => {
    // Prefer the authoritative graphStore.currentDSL (passed in), but fall back to the graph's
    // persisted DSL field when currentDSL is unexpectedly empty.
    const currentDslFromStore = args.getCurrentDsl();
    const currentDsl =
      currentDslFromStore && currentDslFromStore.trim()
        ? currentDslFromStore
        : (((args.getGraph() as any)?.currentQueryDSL as string | undefined) ?? '');

    await lagHorizonsService.recomputeHorizons({
      mode: 'current',
      getGraph: args.getGraph,
      setGraph: args.setGraph,
      currentDsl,
      reason: 'data-menu',
    });
  }, [args.getGraph, args.setGraph, args.getCurrentDsl]);

  const setAllOverrides = useCallback(async () => {
    await lagHorizonsService.setAllHorizonOverrides({
      getGraph: args.getGraph,
      setGraph: args.setGraph,
      overridden: true,
      reason: 'data-menu',
    });
  }, [args.getGraph, args.setGraph]);

  const removeAllOverrides = useCallback(async () => {
    await lagHorizonsService.setAllHorizonOverrides({
      getGraph: args.getGraph,
      setGraph: args.setGraph,
      overridden: false,
      reason: 'data-menu',
    });
  }, [args.getGraph, args.setGraph]);

  return { recomputeGlobal, recomputeCurrent, setAllOverrides, removeAllOverrides };
}


