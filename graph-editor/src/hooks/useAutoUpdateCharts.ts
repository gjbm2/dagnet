import { useCallback, useEffect, useState } from 'react';
import { autoUpdatePolicyService } from '../services/autoUpdatePolicyService';

type Policy = {
  enabled: boolean;
  forced: boolean;
  reason: string;
};

export function useAutoUpdateCharts() {
  const [policy, setPolicy] = useState<Policy>({ enabled: true, forced: false, reason: 'default' });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
      setPolicy(p);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return autoUpdatePolicyService.subscribe(() => {
      void refresh();
    });
  }, [refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      // Forced modes ignore workspace preference (but we still allow setting the pref for later).
      await autoUpdatePolicyService.setWorkspaceAutoUpdateChartsEnabled(enabled);
    },
    [refresh]
  );

  return { policy, loading, refresh, setEnabled };
}


