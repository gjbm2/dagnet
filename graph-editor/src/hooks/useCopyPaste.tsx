/**
 * useCopyPaste Hook
 * 
 * Provides copy-paste functionality for nodes, parameters, and cases.
 * 
 * CLIPBOARD STRATEGY:
 * - Copy: Writes to system clipboard (for external use) AND memory cache (for our menus)
 * - Paste (our menus): Reads from memory cache only (synchronous, no permissions needed)
 * - Ctrl+V (manual): Uses system clipboard (browser native, not handled by us)
 * 
 * This approach avoids clipboard read permission issues while providing
 * reliable in-session copy-paste functionality.
 */

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import toast from 'react-hot-toast';

// ============================================================================
// Types
// ============================================================================

export interface DagNetClipboardData {
  type: 'dagnet-copy';
  objectType: 'node' | 'parameter' | 'case';
  objectId: string;
  timestamp: number;
}

interface CopyPasteContextValue {
  copiedItem: DagNetClipboardData | null;
  setCopiedItem: (item: DagNetClipboardData | null) => void;
}

// ============================================================================
// Context
// ============================================================================

const CopyPasteContext = createContext<CopyPasteContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface CopyPasteProviderProps {
  children: ReactNode;
}

export function CopyPasteProvider({ children }: CopyPasteProviderProps) {
  const [copiedItem, setCopiedItem] = useState<DagNetClipboardData | null>(null);

  return (
    <CopyPasteContext.Provider value={{ copiedItem, setCopiedItem }}>
      {children}
    </CopyPasteContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useCopyPaste() {
  const context = useContext(CopyPasteContext);
  
  if (!context) {
    throw new Error('useCopyPaste must be used within a CopyPasteProvider');
  }
  
  const { copiedItem, setCopiedItem } = context;
  
  /**
   * Copy an item to clipboard and memory cache.
   * 
   * @param objectType - Type of object being copied
   * @param objectId - ID of the object (e.g., 'household-created', 'p-completion-rate')
   */
  const copyToClipboard = useCallback(async (
    objectType: 'node' | 'parameter' | 'case',
    objectId: string
  ): Promise<boolean> => {
    const data: DagNetClipboardData = {
      type: 'dagnet-copy',
      objectType,
      objectId,
      timestamp: Date.now(),
    };
    
    // Write to system clipboard (best effort - for external paste like Ctrl+V)
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    } catch (e) {
      // Clipboard write failed - not critical, memory cache still works
      console.warn('[useCopyPaste] Clipboard write failed (memory cache still works):', e);
    }
    
    // Store in memory cache (this is what our paste menus use)
    setCopiedItem(data);
    
    console.log('[useCopyPaste] Copied to memory cache:', data);
    
    // User feedback
    const typeLabel = objectType === 'parameter' ? 'parameter' : objectType;
    toast.success(`Copied ${typeLabel}: ${objectId}`);
    
    return true;
  }, [setCopiedItem]);
  
  /**
   * Get the currently copied item (from memory cache).
   * Returns null if nothing is copied.
   */
  const getCopiedItem = useCallback((): DagNetClipboardData | null => {
    return copiedItem;
  }, [copiedItem]);
  
  /**
   * Get the copied item if it's a node, otherwise null.
   */
  const getCopiedNode = useCallback((): DagNetClipboardData | null => {
    const result = copiedItem?.objectType === 'node' ? copiedItem : null;
    console.log('[useCopyPaste] getCopiedNode called, copiedItem:', copiedItem, 'result:', result);
    return result;
  }, [copiedItem]);
  
  /**
   * Get the copied item if it's a parameter, otherwise null.
   */
  const getCopiedParameter = useCallback((): DagNetClipboardData | null => {
    return copiedItem?.objectType === 'parameter' ? copiedItem : null;
  }, [copiedItem]);
  
  /**
   * Get the copied item if it's a case, otherwise null.
   */
  const getCopiedCase = useCallback((): DagNetClipboardData | null => {
    return copiedItem?.objectType === 'case' ? copiedItem : null;
  }, [copiedItem]);
  
  /**
   * Clear the copied item from memory cache.
   */
  const clearCopied = useCallback(() => {
    setCopiedItem(null);
  }, [setCopiedItem]);
  
  return {
    copyToClipboard,
    getCopiedItem,
    getCopiedNode,
    getCopiedParameter,
    getCopiedCase,
    clearCopied,
    // Direct access to state for conditional rendering
    copiedItem,
  };
}

