/**
 * useRetrieveAllSlices Hook
 * 
 * Handles the "Retrieve All Slices" flow:
 * 1. Check if pinned query (dataInterestsDSL) is defined
 * 2. If not, open the PinnedQueryModal for user to set one
 * 3. Once set (or if already set), proceed to open AllSlicesModal
 * 
 * This keeps menu files as pure access points with no logic.
 */

import { useState, useCallback, useEffect } from 'react';
import type { GraphData } from '../types';
import toast from 'react-hot-toast';
import { validatePinnedDataInterestsDSL } from '../services/slicePlanValidationService';

export interface UseRetrieveAllSlicesOptions {
  graph: GraphData | null;
  setGraph: (graph: GraphData | null) => void;
}

export interface UseRetrieveAllSlicesReturn {
  // State
  showPinnedQueryModal: boolean;
  showAllSlicesModal: boolean;
  
  // Actions
  initiateRetrieveAllSlices: () => void;
  closePinnedQueryModal: () => void;
  closeAllSlicesModal: () => void;
  
  // Pinned query modal props
  pinnedQueryModalProps: {
    isOpen: boolean;
    currentDSL: string;
    onSave: (newDSL: string) => void;
    onClose: () => void;
  };
  
  // Indicates if the flow can proceed (has pinned query)
  hasPinnedQuery: boolean;
}

export function useRetrieveAllSlices(options: UseRetrieveAllSlicesOptions): UseRetrieveAllSlicesReturn {
  const { graph, setGraph } = options;
  
  const [showPinnedQueryModal, setShowPinnedQueryModal] = useState(false);
  const [showAllSlicesModal, setShowAllSlicesModal] = useState(false);
  const [pendingAllSlices, setPendingAllSlices] = useState(false);
  
  const hasPinnedQuery = !!graph?.dataInterestsDSL;
  
  // Initiate the flow - either open AllSlicesModal directly or prompt for pinned query first
  const initiateRetrieveAllSlices = useCallback(() => {
    if (hasPinnedQuery) {
      // Pinned query exists - go straight to all slices modal
      setShowAllSlicesModal(true);
    } else {
      // No pinned query - open modal to set one, then continue
      setPendingAllSlices(true);
      setShowPinnedQueryModal(true);
    }
  }, [hasPinnedQuery]);
  
  // Handle saving the pinned query from the modal
  const handleSavePinnedQuery = useCallback(async (newDSL: string) => {
    if (!graph) return;
    
    // Update graph with new pinned query
    setGraph({ ...graph, dataInterestsDSL: newDSL });

    // Non-blocking warnings on save
    try {
      const result = await validatePinnedDataInterestsDSL(newDSL);
      for (const w of result.warnings) {
        toast(w, { icon: '⚠️', duration: 6000 });
      }
    } catch (e) {
      // Never block saving; warnings are advisory only.
      console.warn('[useRetrieveAllSlices] Failed to validate pinned DSL:', e);
    }
    
    // Close the pinned query modal
    setShowPinnedQueryModal(false);
    
    // If we were pending an all slices operation, continue with it
    if (pendingAllSlices && newDSL) {
      setPendingAllSlices(false);
      // Small delay to allow state to update
      setTimeout(() => {
        setShowAllSlicesModal(true);
      }, 100);
    } else {
      setPendingAllSlices(false);
    }
  }, [graph, setGraph, pendingAllSlices]);
  
  // Close handlers
  const closePinnedQueryModal = useCallback(() => {
    setShowPinnedQueryModal(false);
    setPendingAllSlices(false);
  }, []);
  
  const closeAllSlicesModal = useCallback(() => {
    setShowAllSlicesModal(false);
  }, []);
  
  // Build props for PinnedQueryModal
  const pinnedQueryModalProps = {
    isOpen: showPinnedQueryModal,
    currentDSL: graph?.dataInterestsDSL || '',
    onSave: handleSavePinnedQuery,
    onClose: closePinnedQueryModal,
  };
  
  return {
    showPinnedQueryModal,
    showAllSlicesModal,
    initiateRetrieveAllSlices,
    closePinnedQueryModal,
    closeAllSlicesModal,
    pinnedQueryModalProps,
    hasPinnedQuery,
  };
}

