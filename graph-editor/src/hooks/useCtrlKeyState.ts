/**
 * Shared hook for tracking CTRL key state globally.
 * 
 * Uses a singleton pattern to ensure only ONE event listener is attached
 * to the document, regardless of how many components use this hook.
 * 
 * This fixes the issue where ConversionNode was adding a listener for
 * every node instance (20 nodes = 20 listeners = keyboard event leak).
 */

import { useState, useEffect, useCallback } from 'react';

// Global state - shared across all hook instances
let listenerCount = 0;
let isCtrlHeld = false;
const listeners = new Set<(held: boolean) => void>();

function notifyListeners() {
  listeners.forEach(fn => fn(isCtrlHeld));
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Control' && !isCtrlHeld) {
    isCtrlHeld = true;
    notifyListeners();
  }
}

function handleKeyUp(e: KeyboardEvent) {
  if (e.key === 'Control' && isCtrlHeld) {
    isCtrlHeld = false;
    notifyListeners();
  }
}

function handleWindowBlur() {
  // Reset on window blur to prevent stuck state
  if (isCtrlHeld) {
    isCtrlHeld = false;
    notifyListeners();
  }
}

/**
 * Hook to track whether the CTRL key is currently held.
 * Uses a single global listener shared across all component instances.
 */
export function useCtrlKeyState(): boolean {
  const [ctrlHeld, setCtrlHeld] = useState(isCtrlHeld);

  useEffect(() => {
    // Subscribe this component to updates
    listeners.add(setCtrlHeld);
    listenerCount++;

    // Only attach document listeners if this is the first subscriber
    if (listenerCount === 1) {
      document.addEventListener('keydown', handleKeyDown);
      document.addEventListener('keyup', handleKeyUp);
      window.addEventListener('blur', handleWindowBlur);
    }

    // Sync initial state
    setCtrlHeld(isCtrlHeld);

    return () => {
      listeners.delete(setCtrlHeld);
      listenerCount--;

      // Only remove document listeners if this was the last subscriber
      if (listenerCount === 0) {
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('keyup', handleKeyUp);
        window.removeEventListener('blur', handleWindowBlur);
        isCtrlHeld = false; // Reset global state
      }
    };
  }, []);

  return ctrlHeld;
}











