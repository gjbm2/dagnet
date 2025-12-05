/**
 * useRenameFile Hook
 * 
 * Centralized hook for renaming files with referential integrity.
 * Used by NavigatorItemContextMenu, TabContextMenu, and FileMenu.
 * 
 * For graph files: Simply renames the file
 * For parameter files: Also updates ID and all references across the workspace
 */

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { fileRegistry } from '../contexts/TabContext';
import { fileOperationsService } from '../services/fileOperationsService';

interface UseRenameFileResult {
  /** Whether the file can be renamed (file exists) */
  canRename: boolean;
  /** Show the rename modal */
  showRenameModal: () => void;
  /** Hide the rename modal */
  hideRenameModal: () => void;
  /** Whether the rename modal is visible */
  isRenameModalOpen: boolean;
  /** Execute the rename operation */
  renameFile: (newName: string) => Promise<boolean>;
  /** Current file name (without type prefix) */
  currentName: string;
  /** File type */
  fileType: string;
  /** Whether a rename is in progress */
  isRenaming: boolean;
}

/**
 * Hook to rename a file with referential integrity
 * 
 * @param fileId - The file ID to rename (e.g., 'parameter-my-param', 'graph-my-graph')
 * @returns Object with canRename flag, modal controls, and renameFile function
 */
export function useRenameFile(fileId: string | undefined): UseRenameFileResult {
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  
  const file = fileId ? fileRegistry.getFile(fileId) : null;
  const canRename = !!file;
  
  // Extract current name from fileId (e.g., 'parameter-my-param' -> 'my-param')
  const [fileType, ...nameParts] = (fileId || '').split('-');
  const currentName = nameParts.join('-');
  
  const showRenameModal = useCallback(() => {
    setIsRenameModalOpen(true);
  }, []);
  
  const hideRenameModal = useCallback(() => {
    setIsRenameModalOpen(false);
  }, []);
  
  const renameFile = useCallback(async (newName: string): Promise<boolean> => {
    if (!fileId || !canRename) return false;
    
    // Validate input
    if (!newName.trim()) {
      toast.error('Name cannot be empty');
      return false;
    }
    
    if (newName === currentName) {
      setIsRenameModalOpen(false);
      return true; // No change needed
    }
    
    setIsRenaming(true);
    const toastId = toast.loading(`Renaming ${currentName} to ${newName}...`);
    
    try {
      const result = await fileOperationsService.renameFile(fileId, newName, {
        showProgress: (message) => {
          toast.loading(message, { id: toastId });
        }
      });
      
      if (result.success) {
        let successMessage = `Renamed to ${newName}`;
        if (result.updatedReferences > 0) {
          successMessage += ` (updated ${result.updatedReferences} reference${result.updatedReferences > 1 ? 's' : ''})`;
        }
        toast.success(successMessage, { id: toastId });
        setIsRenameModalOpen(false);
        return true;
      } else {
        toast.error(result.error || 'Failed to rename file', { id: toastId });
        return false;
      }
    } catch (error) {
      toast.error(`Failed to rename: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: toastId });
      return false;
    } finally {
      setIsRenaming(false);
    }
  }, [fileId, canRename, currentName]);
  
  return { 
    canRename, 
    showRenameModal, 
    hideRenameModal, 
    isRenameModalOpen, 
    renameFile, 
    currentName,
    fileType,
    isRenaming
  };
}


