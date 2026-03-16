/**
 * Cache & settings management operations.
 *
 * Provides cache unsigning (signature removal) and settings file openers.
 *
 * Extracted from dataOperationsService.ts (Cluster L) during slimdown.
 */

import toast from 'react-hot-toast';
import { fileRegistry } from '../../contexts/TabContext';

/**
 * Open connection settings modal
 * Opens File > Connections tab
 */
export async function openConnectionSettings(objectType: 'parameter' | 'case', objectId: string): Promise<void> {
  // Open connections file using fileOperationsService
  const { fileOperationsService } = await import('../fileOperationsService');
  const connectionsItem = {
    id: 'connections',
    type: 'connections' as const,
    name: 'Connections',
    path: 'connections/connections.yaml'
  };
  
  await fileOperationsService.openFile(connectionsItem, {
    viewMode: 'interactive',
    switchIfExists: true
  });
}

/**
 * Open forecasting settings (shared settings/settings.yaml)
 *
 * NOTE: This is a shared, repo-committed file. Changes affect analytics results across clients.
 */
export async function openForecastingSettings(): Promise<void> {
  const { fileOperationsService } = await import('../fileOperationsService');
  const settingsItem = {
    id: 'settings',
    type: 'settings' as const,
    name: 'Forecasting settings',
    path: 'settings/settings.yaml',
  };

  await fileOperationsService.openFile(settingsItem, {
    viewMode: 'interactive',
    switchIfExists: true,
  });
}

/**
 * Unsign cache for a parameter, case, or node file
 * 
 * For parameters: Removes query_signature from all cached values[] entries
 *   - Data stays intact (less destructive)
 *   - Signatures don't match, so next fetch will re-retrieve
 * For cases: Removes signatures from schedule data
 * For nodes: Currently no-op (nodes don't have cached data)
 * 
 * Use this when:
 * - Implementation bugs were fixed (e.g., adapter query generation)
 * - You suspect cached data is stale
 * - Query signature doesn't detect the change but data is wrong
 */
export async function clearCache(objectType: 'parameter' | 'case' | 'node', objectId: string): Promise<void> {
  try {
    if (objectType === 'parameter') {
      const fileId = `parameter-${objectId}`;
      const file = fileRegistry.getFile(fileId);
      
      if (!file) {
        toast.error(`Parameter file not found: ${objectId}`);
        return;
      }
      
      // Count how many values have signatures
      const signedCount = file.data.values?.filter((v: any) => v.query_signature).length || 0;
      
      if (signedCount === 0) {
        toast('No signed cache entries to unsign', { icon: 'ℹ️', duration: 2000 });
        return;
      }
      
      // Remove query_signature from all values (keep the data itself)
      const updatedValues = file.data.values?.map((v: any) => {
        const { query_signature, ...rest } = v;
        return rest;
      }) || [];
      
      const updatedData = {
        ...file.data,
        values: updatedValues
      };
      
      await fileRegistry.updateFile(fileId, updatedData);
      
      toast.success(`Unsigned ${signedCount} cached value${signedCount !== 1 ? 's' : ''} in ${objectId}`, {
        duration: 3000
      });
      
      console.log('[DataOperationsService] Unsigned cache:', {
        objectType,
        objectId,
        signedCount
      });
      
    } else if (objectType === 'case') {
      const fileId = `case-${objectId}`;
      const file = fileRegistry.getFile(fileId);
      
      if (!file) {
        toast.error(`Case file not found: ${objectId}`);
        return;
      }
      
      // For cases, remove signature if present
      // (Case schema may vary - adjust as needed)
      const scheduleCount = Array.isArray(file.data.schedules) 
        ? file.data.schedules.length 
        : file.data.case?.schedules?.length || 0;
      
      if (scheduleCount === 0) {
        toast('No cached schedules to unsign', { icon: 'ℹ️', duration: 2000 });
        return;
      }
      
      // Remove signatures from schedules if they have them
      const updatedSchedules = (file.data.schedules || file.data.case?.schedules || []).map((s: any) => {
        const { query_signature, ...rest } = s;
        return rest;
      });
      
      const updatedData = {
        ...file.data,
        schedules: updatedSchedules,
        case: {
          ...file.data.case,
          schedules: updatedSchedules
        }
      };
      
      await fileRegistry.updateFile(fileId, updatedData);
      
      toast.success(`Unsigned ${scheduleCount} cached schedule${scheduleCount !== 1 ? 's' : ''} in ${objectId}`, {
        duration: 3000
      });
      
    } else {
      // Nodes don't have cached data (yet)
      toast('Nodes don\'t have cached data to unsign', { icon: 'ℹ️', duration: 2000 });
    }
    
  } catch (error) {
    console.error('[DataOperationsService] Failed to unsign cache:', error);
    toast.error(`Failed to unsign cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}
