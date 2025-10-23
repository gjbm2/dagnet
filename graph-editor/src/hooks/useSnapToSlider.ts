import { useCallback, useRef, useEffect } from 'react';

interface SnapToSliderOptions {
  snapPoints?: number[];
  snapThreshold?: number;
  shiftKeyOverride?: boolean;
  autoRebalance?: boolean;
  rebalanceDelay?: number;
}

export function useSnapToSlider({
  snapPoints = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  snapThreshold = 0.05,
  shiftKeyOverride = true,
  autoRebalance = true,
  rebalanceDelay = 50
}: SnapToSliderOptions = {}) {
  const shiftKeyRef = useRef(false);
  const ctrlKeyRef = useRef(false);
  const rebalanceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Track key states only when sliders are being used
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Capture key states when slider interaction starts
    shiftKeyRef.current = e.shiftKey;
    ctrlKeyRef.current = e.ctrlKey;
  }, []);
  
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore key tracking for text-like inputs, but allow for range sliders
    if (e.target) {
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      const isInput = tag === 'INPUT';
      const isTextarea = tag === 'TEXTAREA';
      const isSelect = tag === 'SELECT';
      const isContentEditable = (el as HTMLElement).isContentEditable === true;
      let isRange = false;
      if (isInput) {
        const input = el as HTMLInputElement;
        isRange = input.type === 'range';
      }
      if (!isRange && (isInput || isTextarea || isSelect || isContentEditable)) {
        return;
      }
    }

    // Update both key states based on the actual key states
    shiftKeyRef.current = e.shiftKey;
    ctrlKeyRef.current = e.ctrlKey;
  }, []);
  
  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    // Ignore key tracking for text-like inputs, but allow for range sliders
    if (e.target) {
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      const isInput = tag === 'INPUT';
      const isTextarea = tag === 'TEXTAREA';
      const isSelect = tag === 'SELECT';
      const isContentEditable = (el as HTMLElement).isContentEditable === true;
      let isRange = false;
      if (isInput) {
        const input = el as HTMLInputElement;
        isRange = input.type === 'range';
      }
      if (!isRange && (isInput || isTextarea || isSelect || isContentEditable)) {
        return;
      }
    }

    // Handle specific key releases to ensure proper state tracking
    if (e.key === 'Shift') {
      shiftKeyRef.current = false;
    }
    if (e.key === 'Control') {
      ctrlKeyRef.current = false;
    }
  }, []);
  
  useEffect(() => {
    // Use passive listeners to avoid interfering with form submissions
    window.addEventListener('keydown', handleKeyDown, { passive: true });
    window.addEventListener('keyup', handleKeyUp, { passive: true });
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);
  
  const snapValue = useCallback((value: number): number => {
    // If shift is held and override is enabled, don't snap
    if (shiftKeyRef.current && shiftKeyOverride) {
      return value;
    }
    
    // Find the closest snap point
    let closestSnapPoint = snapPoints[0];
    let minDistance = Math.abs(value - snapPoints[0]);
    
    for (const snapPoint of snapPoints) {
      const distance = Math.abs(value - snapPoint);
      if (distance < minDistance) {
        minDistance = distance;
        closestSnapPoint = snapPoint;
      }
    }
    
    // Only snap if within threshold
    if (minDistance <= snapThreshold) {
      return closestSnapPoint;
    }
    
    return value;
  }, [snapPoints, snapThreshold, shiftKeyOverride]);
  
  const shouldAutoRebalance = useCallback((): boolean => {
    return ctrlKeyRef.current && autoRebalance;
  }, [autoRebalance]);
  
  const scheduleRebalance = useCallback((callback: () => void) => {
    if (shouldAutoRebalance()) {
      // Clear existing timeout
      if (rebalanceTimeoutRef.current) {
        clearTimeout(rebalanceTimeoutRef.current);
      }
      
      // Schedule new rebalance
      rebalanceTimeoutRef.current = setTimeout(() => {
        callback();
        rebalanceTimeoutRef.current = null;
      }, rebalanceDelay);
    }
  }, [shouldAutoRebalance, rebalanceDelay]);
  
  return { snapValue, shouldAutoRebalance, scheduleRebalance, handleMouseDown };
}
