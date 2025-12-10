/**
 * useCopyPaste Hook
 * 
 * Provides copy-paste functionality for nodes, parameters, cases, and subgraphs.
 * 
 * CLIPBOARD STRATEGY:
 * - Copy: Writes to system clipboard (for external use) AND memory cache (for our menus)
 * - Paste (our menus): Reads from memory cache only (synchronous, no permissions needed)
 * - Ctrl+V (manual): Uses system clipboard (browser native, not handled by us)
 * 
 * This approach avoids clipboard read permission issues while providing
 * reliable in-session copy-paste functionality.
 * 
 * SUBGRAPH COPY:
 * - Copies selected nodes and all edges between them
 * - Includes subsumed nodes (nodes wholly contained by selection)
 * - Paste creates new nodes/edges with unique IDs via UpdateManager
 */

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import toast from 'react-hot-toast';
import { GraphNode, GraphEdge } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Single object reference (node, parameter, case, event)
 */
export interface DagNetClipboardData {
  type: 'dagnet-copy';
  objectType: 'node' | 'parameter' | 'case' | 'event';
  objectId: string;
  timestamp: number;
}

/**
 * Subgraph data (multiple nodes + edges)
 */
export interface DagNetSubgraphClipboardData {
  type: 'dagnet-subgraph';
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceGraphId?: string;
  timestamp: number;
}

/**
 * Union type for all clipboard data types
 */
export type ClipboardContent = DagNetClipboardData | DagNetSubgraphClipboardData | null;

/**
 * Context for which paste operations are valid
 */
export type PasteContext = 
  | 'graph'      // Pasting onto graph canvas
  | 'node'       // Pasting onto a node
  | 'edge'       // Pasting onto an edge
  | 'navigator'; // Pasting in navigator

/**
 * Check if clipboard content can be pasted in a given context
 */
export function canPasteInContext(content: ClipboardContent, context: PasteContext): boolean {
  if (!content) return false;
  
  switch (context) {
    case 'graph':
      // Can paste subgraphs or single nodes onto graph
      if (content.type === 'dagnet-subgraph') return true;
      if (content.type === 'dagnet-copy' && content.objectType === 'node') return true;
      return false;
      
    case 'node':
      // Can paste nodes (to copy properties), cases, or events onto nodes
      if (content.type === 'dagnet-copy') {
        return ['node', 'case', 'event'].includes(content.objectType);
      }
      return false;
      
    case 'edge':
      // Can paste parameters onto edges
      if (content.type === 'dagnet-copy' && content.objectType === 'parameter') return true;
      return false;
      
    case 'navigator':
      // Currently no paste operations in navigator
      return false;
      
    default:
      return false;
  }
}

interface CopyPasteContextValue {
  copiedItem: ClipboardContent;
  setCopiedItem: (item: ClipboardContent) => void;
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
  const [copiedItem, setCopiedItem] = useState<ClipboardContent>(null);

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
   * Copy a single item to clipboard and memory cache.
   * 
   * @param objectType - Type of object being copied
   * @param objectId - ID of the object (e.g., 'household-created', 'p-completion-rate')
   */
  const copyToClipboard = useCallback(async (
    objectType: 'node' | 'parameter' | 'case' | 'event',
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
   * Copy a subgraph (nodes + edges) to clipboard and memory cache.
   * 
   * @param nodes - Array of nodes to copy
   * @param edges - Array of edges to copy
   * @param sourceGraphId - Optional ID of the source graph
   */
  const copySubgraph = useCallback(async (
    nodes: GraphNode[],
    edges: GraphEdge[],
    sourceGraphId?: string
  ): Promise<boolean> => {
    if (nodes.length === 0) {
      toast.error('No nodes selected to copy');
      return false;
    }
    
    const data: DagNetSubgraphClipboardData = {
      type: 'dagnet-subgraph',
      nodes: structuredClone(nodes),
      edges: structuredClone(edges),
      sourceGraphId,
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
    
    console.log('[useCopyPaste] Copied subgraph to memory cache:', {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      sourceGraphId,
    });
    
    // User feedback
    const parts: string[] = [];
    parts.push(`${nodes.length} node${nodes.length !== 1 ? 's' : ''}`);
    if (edges.length > 0) {
      parts.push(`${edges.length} edge${edges.length !== 1 ? 's' : ''}`);
    }
    toast.success(`Copied ${parts.join(' and ')}`);
    
    return true;
  }, [setCopiedItem]);
  
  /**
   * Get the currently copied item (from memory cache).
   * Returns null if nothing is copied.
   */
  const getCopiedItem = useCallback((): ClipboardContent => {
    return copiedItem;
  }, [copiedItem]);
  
  /**
   * Get the copied subgraph if present, otherwise null.
   */
  const getCopiedSubgraph = useCallback((): DagNetSubgraphClipboardData | null => {
    if (copiedItem?.type === 'dagnet-subgraph') {
      return copiedItem;
    }
    return null;
  }, [copiedItem]);
  
  /**
   * Get the copied item if it's a single node reference, otherwise null.
   */
  const getCopiedNode = useCallback((): DagNetClipboardData | null => {
    if (copiedItem?.type === 'dagnet-copy' && copiedItem.objectType === 'node') {
      return copiedItem;
    }
    return null;
  }, [copiedItem]);
  
  /**
   * Get the copied item if it's a parameter, otherwise null.
   */
  const getCopiedParameter = useCallback((): DagNetClipboardData | null => {
    if (copiedItem?.type === 'dagnet-copy' && copiedItem.objectType === 'parameter') {
      return copiedItem;
    }
    return null;
  }, [copiedItem]);
  
  /**
   * Get the copied item if it's a case, otherwise null.
   */
  const getCopiedCase = useCallback((): DagNetClipboardData | null => {
    if (copiedItem?.type === 'dagnet-copy' && copiedItem.objectType === 'case') {
      return copiedItem;
    }
    return null;
  }, [copiedItem]);
  
  /**
   * Check if paste is valid for a given context
   */
  const canPaste = useCallback((context: PasteContext): boolean => {
    return canPasteInContext(copiedItem, context);
  }, [copiedItem]);
  
  /**
   * Clear the copied item from memory cache.
   */
  const clearCopied = useCallback(() => {
    setCopiedItem(null);
  }, [setCopiedItem]);
  
  return {
    copyToClipboard,
    copySubgraph,
    getCopiedItem,
    getCopiedSubgraph,
    getCopiedNode,
    getCopiedParameter,
    getCopiedCase,
    canPaste,
    clearCopied,
    // Direct access to state for conditional rendering
    copiedItem,
  };
}

