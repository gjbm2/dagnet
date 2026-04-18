/**
 * SelectionContext — shares canvas selection state with sidebar panels.
 *
 * Extracted from GraphEditor.tsx so the editor file can export only
 * React components (required for Vite Fast Refresh).
 */

import { createContext, useContext } from 'react';
import type { ItemBase } from '../../hooks/useItemFiltering';

export type CanvasAnnotationType = 'postit' | 'container' | 'canvasAnalysis';

export interface SelectorModalConfig {
  type: 'parameter' | 'context' | 'case' | 'node' | 'event';
  items: ItemBase[];
  currentValue: string;
  onSelect: (value: string) => void;
  onOpenItem?: (itemId: string) => void;
}

export interface SelectionContextType {
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectedAnnotationId: string | null;
  selectedAnnotationType: CanvasAnnotationType | null;
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  onSelectedAnnotationChange: (id: string | null, type: CanvasAnnotationType | null) => void;
  openSelectorModal: (config: SelectorModalConfig) => void;
}

export const SelectionContext = createContext<SelectionContextType | null>(null);

export function useSelectionContext() {
  const context = useContext(SelectionContext);
  if (!context) {
    // Return a no-op context instead of throwing.
    // This can happen during Error Boundary recovery or when the component tree is being rebuilt.
    console.warn('[useSelectionContext] Context not available - returning no-op defaults');
    return {
      selectedNodeId: null,
      selectedEdgeId: null,
      selectedAnnotationId: null,
      selectedAnnotationType: null,
      onSelectedNodeChange: () => {},
      onSelectedEdgeChange: () => {},
      onSelectedAnnotationChange: () => {},
      openSelectorModal: () => {},
    } as SelectionContextType;
  }
  return context;
}
