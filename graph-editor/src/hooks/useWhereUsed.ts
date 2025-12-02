/**
 * useWhereUsed Hook
 * 
 * Centralized hook for finding where a file is referenced across the workspace.
 * Used by NavigatorItemContextMenu, TabContextMenu, and FileMenu.
 */

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTabContext } from '../contexts/TabContext';
import { WhereUsedService } from '../services/whereUsedService';

interface UseWhereUsedResult {
  /** Find where the file is used */
  findWhereUsed: () => Promise<void>;
  /** Whether search is currently running */
  isSearching: boolean;
  /** Whether the action is available (file must exist) */
  canSearch: boolean;
}

/**
 * Hook to find where a file is referenced across the workspace
 * 
 * Scans all graphs and data files for references to the target file.
 * Produces a report with navigable links.
 */
export function useWhereUsed(fileId: string | undefined): UseWhereUsedResult {
  const { operations } = useTabContext();
  const [isSearching, setIsSearching] = useState(false);
  
  // Can search if we have a valid fileId (not undefined, not an index file)
  const canSearch = Boolean(
    fileId && 
    !fileId.endsWith('-index') && 
    !fileId.startsWith('log-')
  );
  
  const findWhereUsed = useCallback(async () => {
    if (!fileId || isSearching || !canSearch) return;
    
    setIsSearching(true);
    const toastId = toast.loading('Searching for references...');
    
    try {
      const result = await WhereUsedService.findReferences(fileId, operations, true);
      
      if (result.references.length === 0) {
        toast.success(
          `No references found for "${result.targetId}"`,
          { id: toastId }
        );
      } else {
        toast.success(
          `Found ${result.references.length} reference(s) - see report`,
          { id: toastId }
        );
      }
    } catch (error) {
      toast.error(
        `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { id: toastId }
      );
    } finally {
      setIsSearching(false);
    }
  }, [fileId, operations, isSearching, canSearch]);
  
  return {
    findWhereUsed,
    isSearching,
    canSearch
  };
}

