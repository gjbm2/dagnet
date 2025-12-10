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
 * 
 * NOTE: This hook now loads files from IndexedDB if they're not in memory,
 * allowing it to work on files that haven't been opened yet.
 */

import { useCallback } from 'react';
import { fileRegistry } from '../contexts/TabContext';
import { db } from '../db/appDatabase';
import { useDialog } from '../contexts/DialogContext';
import toast from 'react-hot-toast';
import { sessionLogService } from '../services/sessionLogService';
import type { FileState } from '../types';

export interface ClearDataFileResult {
  success: boolean;
  clearedCount: number;
}

/**
 * Helper to load a file, checking memory first then IndexedDB
 * Also tries workspace-prefixed versions in IndexedDB
 */
async function loadFileFromAnywhere(fileId: string): Promise<FileState | null> {
  // 1. Check fileRegistry (in-memory)
  let file = fileRegistry.getFile(fileId);
  if (file) return file;
  
  // 2. Check IndexedDB (unprefixed)
  const fileFromDb = await db.files.get(fileId);
  if (fileFromDb) {
    // Load into memory for subsequent operations
    (fileRegistry as any).files.set(fileId, fileFromDb);
    return fileFromDb;
  }
  
  // 3. Try workspace-prefixed versions in IndexedDB
  // Files from Git are stored as repo-branch-fileId
  const allFiles = await db.files.toArray();
  const prefixedFile = allFiles.find(f => f.fileId.endsWith(`-${fileId}`));
  if (prefixedFile) {
    // Load into memory with canonical (unprefixed) ID
    const canonicalFile = { ...prefixedFile, fileId };
    (fileRegistry as any).files.set(fileId, canonicalFile);
    return canonicalFile;
  }
  
  return null;
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
    // Load file from memory or IndexedDB
    const file = await loadFileFromAnywhere(fileId);
    
    if (!file) {
      // File doesn't exist anywhere - not an error, just nothing to clear
      toast('No file found to clear', { icon: 'ℹ️', duration: 2000 });
      return { success: true, clearedCount: 0 };
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
      
      // Also check for malformed 'values[N]' properties from buggy serialization
      const malformedKeys = Object.keys(file.data || {}).filter(k => /^values\[\d+\]$/.test(k));
      const hasMalformedData = malformedKeys.length > 0;
      
      hasDataToClear = hasValues || hasMalformedData;
      dataDescription = hasMalformedData 
        ? `${values.length} value${values.length !== 1 ? 's' : ''} + ${malformedKeys.length} malformed entries`
        : `${values.length} value${values.length !== 1 ? 's' : ''}`;
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
        // Clear values array completely - empty array is valid schema
        // Also remove any malformed 'values[N]' properties from buggy serialization
        const updatedData = { ...file.data };
        updatedData.values = [];  // Fully clear - no stub entries that cause aggregation issues
        
        // Clean up malformed properties like 'values[0]', 'values[1]', etc.
        // These were created by a bug in applyChanges that treated 'values[0]' as a literal key
        for (const key of Object.keys(updatedData)) {
          if (/^values\[\d+\]$/.test(key)) {
            console.log(`[useClearDataFile] Removing malformed property: ${key}`);
            delete updatedData[key];
            clearedCount++;
          }
        }
        
        await fileRegistry.updateFile(fileId, updatedData);
        clearedCount += file.data?.values?.length || 0;
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
   * Loads files from IndexedDB if not in memory
   */
  const clearDataFiles = useCallback(async (
    fileIds: string[],
    skipConfirm: boolean = false
  ): Promise<{ success: boolean; totalCleared: number; filesProcessed: number }> => {
    if (fileIds.length === 0) {
      toast.error('No files to clear');
      return { success: false, totalCleared: 0, filesProcessed: 0 };
    }

    // Load files from memory or IndexedDB, filter to only parameter and case files
    const loadedFiles: { id: string; file: FileState }[] = [];
    for (const id of fileIds) {
      const file = await loadFileFromAnywhere(id);
      if (file && (file.type === 'parameter' || file.type === 'case')) {
        loadedFiles.push({ id, file });
      }
    }

    if (loadedFiles.length === 0) {
      toast('No parameter or case files found to clear', { icon: 'ℹ️', duration: 2000 });
      return { success: true, totalCleared: 0, filesProcessed: 0 };
    }

    // Filter to files that actually have data to clear
    const filesWithData = loadedFiles.filter(({ file }) => {
      if (file.type === 'parameter') {
        const values = file.data?.values || [];
        return values.length > 0 && values.some((v: any) => 
          v.n !== undefined || v.k !== undefined || v.data_source || v.n_daily || v.k_daily
        );
      } else if (file.type === 'case') {
        return (file.data?.case?.schedules?.length || 0) > 0;
      }
      return false;
    });

    if (filesWithData.length === 0) {
      toast('No files have data to clear', { icon: 'ℹ️', duration: 2000 });
      return { success: true, totalCleared: 0, filesProcessed: 0 };
    }

    // Confirm batch operation
    if (!skipConfirm) {
      const confirmed = await showConfirm({
        title: 'Clear Data Files',
        message: `Clear fetched data from ${filesWithData.length} file${filesWithData.length !== 1 ? 's' : ''}?\n\n` +
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

    for (const { id } of filesWithData) {
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
   * Check if a file COULD have data that can be cleared
   * 
   * NOTE: This is a synchronous check used for menu enablement.
   * It returns true if the file type supports clearing, even if the file
   * isn't loaded yet. The actual data check happens at operation time.
   * 
   * For accurate data checking, use canClearDataAsync instead.
   */
  const canClearData = useCallback((fileId: string): boolean => {
    // Check if this is a parameter or case file type (which can have clearable data)
    const isParameter = fileId.startsWith('parameter-');
    const isCase = fileId.startsWith('case-');
    
    if (!isParameter && !isCase) return false;
    
    // Check if file is loaded and has actual data
    const file = fileRegistry.getFile(fileId);
    if (file) {
      if (file.type === 'parameter') {
        const values = file.data?.values || [];
        return values.length > 0 && values.some((v: any) => 
          v.n !== undefined || v.k !== undefined || v.data_source || v.n_daily || v.k_daily
        );
      } else if (file.type === 'case') {
        return (file.data?.case?.schedules?.length || 0) > 0;
      }
    }
    
    // File not loaded - return true to enable the menu item
    // The actual clearing operation will load the file and check
    return true;
  }, []);

  /**
   * Async check if a file has data that can be cleared
   * Loads from IndexedDB if needed for accurate checking
   */
  const canClearDataAsync = useCallback(async (fileId: string): Promise<boolean> => {
    const file = await loadFileFromAnywhere(fileId);
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
    canClearDataAsync,
    getParameterFileId
  };
}










