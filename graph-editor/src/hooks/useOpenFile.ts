/**
 * useOpenFile Hook
 * 
 * Centralized hook for opening files by type and ID.
 * Reuses existing tabs if the file is already open.
 * 
 * Used by:
 * - EnhancedSelector (plug icon)
 * - EdgeContextMenu (data submenus)
 * - NodeContextMenu (data submenus)
 * - PropertiesPanel (various open file actions)
 */

import { useCallback } from 'react';
import { useTabContext } from '../contexts/TabContext';
import { ObjectType } from '../types';

type OpenableType = 'parameter' | 'case' | 'node' | 'context' | 'event';

interface UseOpenFileResult {
  /** Open a file by type and ID, reusing existing tab if open */
  openFile: (type: OpenableType, id: string) => void;
  /** Open a file by fileId (e.g., "parameter-my-param") */
  openFileById: (fileId: string) => void;
}

/**
 * Hook to open files in the tab system.
 * 
 * Will reuse an existing tab if the file is already open,
 * otherwise opens a new tab in interactive mode.
 */
export function useOpenFile(): UseOpenFileResult {
  const { tabs, operations: tabOps } = useTabContext();
  
  const openFile = useCallback((type: OpenableType, id: string) => {
    const fileId = `${type}-${id}`;
    
    // Check if file is already open in a tab
    const existingTab = tabs.find(tab => tab.fileId === fileId);
    
    if (existingTab) {
      // Navigate to existing tab
      tabOps.switchTab(existingTab.id);
    } else {
      // Open new tab
      const item = {
        id,
        type: type as ObjectType,
        name: id,
        path: `${type}s/${id}.yaml`,
      };
      tabOps.openTab(item, 'interactive', false);
    }
  }, [tabs, tabOps]);
  
  const openFileById = useCallback((fileId: string) => {
    // Parse fileId to extract type and id
    const [type, ...idParts] = fileId.split('-');
    const id = idParts.join('-');
    
    // Validate type
    const validTypes: OpenableType[] = ['parameter', 'case', 'node', 'context', 'event'];
    if (!validTypes.includes(type as OpenableType)) {
      console.warn(`[useOpenFile] Invalid file type: ${type}`);
      return;
    }
    
    openFile(type as OpenableType, id);
  }, [openFile]);
  
  return {
    openFile,
    openFileById
  };
}







