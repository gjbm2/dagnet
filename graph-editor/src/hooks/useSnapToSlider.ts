import { useCallback, useRef, useEffect } from 'react';

interface SnapToSliderOptions {
  snapPoints?: number[];
  snapThreshold?: number;
  shiftKeyOverride?: boolean;
  autoRebalance?: boolean;
  rebalanceDelay?: number;
}

// ============================================================================
// SINGLETON KEY STATE TRACKING
// Uses a single global listener instead of per-hook-instance listeners.
// This fixes keyboard event listener leaks when multiple components use this hook.
// ============================================================================

let globalListenerCount = 0;
let globalShiftHeld = false;
let globalCtrlHeld = false;

function globalHandleKeyDown(e: KeyboardEvent) {
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

  // Update global key states
  globalShiftHeld = e.shiftKey;
  globalCtrlHeld = e.ctrlKey;
}

function globalHandleKeyUp(e: KeyboardEvent) {
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

  // Handle specific key releases
  if (e.key === 'Shift') {
    globalShiftHeld = false;
  }
  if (e.key === 'Control') {
    globalCtrlHeld = false;
  }
}

function globalHandleWindowBlur() {
  // Reset on window blur to prevent stuck keys
  globalShiftHeld = false;
  globalCtrlHeld = false;
}

// ============================================================================

export function useSnapToSlider({
  snapPoints = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  snapThreshold = 0.05,
  shiftKeyOverride = true,
  autoRebalance = true,
  rebalanceDelay = 50
}: SnapToSliderOptions = {}) {
  const rebalanceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Track key states only when sliders are being used (for mousedown events)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Capture key states when slider interaction starts
    globalShiftHeld = e.shiftKey;
    globalCtrlHeld = e.ctrlKey;
  }, []);
  
  // Register/unregister from global listeners
  useEffect(() => {
    globalListenerCount++;
    
    // Only attach listeners if this is the first subscriber
    if (globalListenerCount === 1) {
      window.addEventListener('keydown', globalHandleKeyDown, { passive: true });
      window.addEventListener('keyup', globalHandleKeyUp, { passive: true });
      window.addEventListener('blur', globalHandleWindowBlur);
    }
    
    return () => {
      globalListenerCount--;
      
      // Only remove listeners if this was the last subscriber
      if (globalListenerCount === 0) {
        window.removeEventListener('keydown', globalHandleKeyDown);
        window.removeEventListener('keyup', globalHandleKeyUp);
        window.removeEventListener('blur', globalHandleWindowBlur);
        globalShiftHeld = false;
        globalCtrlHeld = false;
      }
    };
  }, []);
  
  const snapValue = useCallback((value: number): number => {
    // If shift is held and override is enabled, don't snap
    if (globalShiftHeld && shiftKeyOverride) {
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
    return globalCtrlHeld && autoRebalance;
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
