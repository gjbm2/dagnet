/**
 * useClearDataFile Hook
 * 
 * Clears fetched data from parameter/case files while preserving structure.
 * This is useful for reducing file bloat from accumulated data over time.
 * 
 * For parameters: Clears values[] array data (n, k, n_daily, k_daily, data_source, etc.)
 * For cases: Clears schedule data
 * 
 * Preserves: id, name, type, query, connection, connection_string, metadata
 */

import { useCallback } from 'react';
import { fileRegistry } from '../contexts/TabContext';
import { useDialog } from '../contexts/DialogContext';
import toast from 'react-hot-toast';
import { sessionLogService } from '../services/sessionLogService';

export interface ClearDataFileResult {
  success: boolean;
  clearedCount: number;
}

export function useClearDataFile() {
  const { showConfirm } = useDialog();

  /**
   * Clear data from a single parameter or case file
   */
  const clearDataFile = useCallback(async (
    fileId: string,
    skipConfirm: boolean = false
  ): Promise<ClearDataFileResult> => {
    const file = fileRegistry.getFile(fileId);
    
    if (!file) {
      toast.error(`File not found: ${fileId}`);
      return { success: false, clearedCount: 0 };
    }

    const type = file.type;
    
    // Only applicable to parameter and case files
    if (type !== 'parameter' && type !== 'case') {
      toast.error('Clear data is only available for parameter and case files');
      return { success: false, clearedCount: 0 };
    }

    // Check if there's data to clear
    let hasDataToClear = false;
    let dataDescription = '';

    if (type === 'parameter') {
      const values = file.data?.values || [];
      const hasValues = values.length > 0 && values.some((v: any) => 
        v.n !== undefined || v.k !== undefined || v.data_source || v.n_daily || v.k_daily
      );
      hasDataToClear = hasValues;
      dataDescription = `${values.length} value${values.length !== 1 ? 's' : ''}`;
    } else if (type === 'case') {
      const schedules = file.data?.case?.schedules || [];
      hasDataToClear = schedules.length > 0;
      dataDescription = `${schedules.length} schedule${schedules.length !== 1 ? 's' : ''}`;
    }

    if (!hasDataToClear) {
      toast('No data to clear in this file', { icon: 'ℹ️', duration: 2000 });
      return { success: true, clearedCount: 0 };
    }

    // Confirm with user
    if (!skipConfirm) {
      const confirmed = await showConfirm({
        title: 'Clear Data File',
        message: `Clear fetched data from "${file.data?.name || fileId}"?\n\n` +
          `This will remove: ${dataDescription}\n\n` +
          `Structure will be preserved (id, name, query, connection, metadata).`,
        confirmLabel: 'Clear Data',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger'
      });

      if (!confirmed) {
        return { success: false, clearedCount: 0 };
      }
    }

    try {
      let clearedCount = 0;

      if (type === 'parameter') {
        // Clear values array but keep one minimal entry to maintain schema validity
        const updatedData = {
          ...file.data,
          values: [{ mean: file.data?.values?.[0]?.mean ?? 0 }] // Keep just the mean from first value
        };
        await fileRegistry.updateFile(fileId, updatedData);
        clearedCount = (file.data?.values?.length || 1) - 1;
      } else if (type === 'case') {
        // Clear schedules but keep structure
        const updatedData = {
          ...file.data,
          case: {
            ...file.data?.case,
            schedules: []
          }
        };
        await fileRegistry.updateFile(fileId, updatedData);
        clearedCount = file.data?.case?.schedules?.length || 0;
      }

      toast.success(`Cleared data from ${file.data?.name || fileId}`);
      
      sessionLogService.success('file', 'CLEAR_DATA_FILE', 
        `Cleared data from ${type} file: ${fileId}`,
        `Cleared ${clearedCount} entries`,
        { fileId, fileType: type, clearedCount }
      );

      return { success: true, clearedCount };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to clear data: ${errorMessage}`);
      
      sessionLogService.error('file', 'CLEAR_DATA_FILE_FAILED',
        `Failed to clear data from ${type} file: ${fileId}`,
        errorMessage,
        { fileId, fileType: type }
      );

      return { success: false, clearedCount: 0 };
    }
  }, [showConfirm]);

  /**
   * Clear data from multiple files (batch operation)
   */
  const clearDataFiles = useCallback(async (
    fileIds: string[],
    skipConfirm: boolean = false
  ): Promise<{ success: boolean; totalCleared: number; filesProcessed: number }> => {
    if (fileIds.length === 0) {
      toast.error('No files to clear');
      return { success: false, totalCleared: 0, filesProcessed: 0 };
    }

    // Filter to only parameter and case files
    const validFiles = fileIds
      .map(id => ({ id, file: fileRegistry.getFile(id) }))
      .filter(({ file }) => file && (file.type === 'parameter' || file.type === 'case'));

    if (validFiles.length === 0) {
      toast.error('No parameter or case files found to clear');
      return { success: false, totalCleared: 0, filesProcessed: 0 };
    }

    // Confirm batch operation
    if (!skipConfirm) {
      const confirmed = await showConfirm({
        title: 'Clear Data Files',
        message: `Clear fetched data from ${validFiles.length} file${validFiles.length !== 1 ? 's' : ''}?\n\n` +
          `This will remove values/schedules from all selected files.\n\n` +
          `Structure will be preserved (id, name, query, connection, metadata).`,
        confirmLabel: 'Clear All',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger'
      });

      if (!confirmed) {
        return { success: false, totalCleared: 0, filesProcessed: 0 };
      }
    }

    let totalCleared = 0;
    let filesProcessed = 0;

    for (const { id } of validFiles) {
      const result = await clearDataFile(id, true); // Skip individual confirms
      if (result.success) {
        totalCleared += result.clearedCount;
        filesProcessed++;
      }
    }

    if (filesProcessed > 0) {
      toast.success(`Cleared data from ${filesProcessed} file${filesProcessed !== 1 ? 's' : ''}`);
    }

    return { success: filesProcessed > 0, totalCleared, filesProcessed };
  }, [clearDataFile, showConfirm]);

  /**
   * Check if a file has data that can be cleared
   */
  const canClearData = useCallback((fileId: string): boolean => {
    const file = fileRegistry.getFile(fileId);
    if (!file) return false;
    
    if (file.type === 'parameter') {
      const values = file.data?.values || [];
      return values.length > 0 && values.some((v: any) => 
        v.n !== undefined || v.k !== undefined || v.data_source || v.n_daily || v.k_daily
      );
    } else if (file.type === 'case') {
      return (file.data?.case?.schedules?.length || 0) > 0;
    }
    
    return false;
  }, []);

  /**
   * Get file ID from a parameter_id on an edge
   */
  const getParameterFileId = useCallback((parameterId: string | undefined): string | undefined => {
    if (!parameterId) return undefined;
    return `parameter-${parameterId}`;
  }, []);

  return {
    clearDataFile,
    clearDataFiles,
    canClearData,
    getParameterFileId
  };
}

