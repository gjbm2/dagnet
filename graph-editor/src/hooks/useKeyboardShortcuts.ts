import { useEffect } from 'react';
import { useTabContext } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';

/**
 * Keyboard Shortcuts Hook
 * 
 * Implements global keyboard shortcuts:
 * - Cmd/Ctrl+S: Save active tab
 * - Cmd/Ctrl+Shift+S: Save all
 * - Cmd/Ctrl+W: Close active tab
 * - Cmd/Ctrl+O: Open navigator
 * - Cmd/Ctrl+B: Toggle navigator
 * - Cmd/Ctrl+K: Commit
 * - Cmd/Ctrl+Shift+K: Commit all
 * - Cmd/Ctrl+Z: Undo
 * - Cmd/Ctrl+Shift+Z: Redo
 * - Cmd/Ctrl+,: Open settings
 */
export function useKeyboardShortcuts() {
  const { activeTabId, operations } = useTabContext();
  const { operations: navOps } = useNavigatorContext();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      // Ignore if user is typing in an input/textarea or Monaco editor
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('.monaco-editor') // Monaco editor elements
      ) {
        // Allow Cmd+S even in inputs
        if (modifier && e.key === 's') {
          // Continue to handle below
        } else {
          return;
        }
      }

      // Cmd/Ctrl+S: Save
      if (modifier && e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        if (activeTabId) {
          operations.saveTab(activeTabId);
        }
        return;
      }

      // Cmd/Ctrl+Shift+S: Save All
      if (modifier && e.key === 's' && e.shiftKey) {
        e.preventDefault();
        operations.saveAll();
        return;
      }

      // Cmd/Ctrl+W: Close Tab
      if (modifier && e.key === 'w') {
        e.preventDefault();
        if (activeTabId) {
          operations.closeTab(activeTabId);
        }
        return;
      }

      // Cmd/Ctrl+O: Open Navigator
      if (modifier && e.key === 'o') {
        e.preventDefault();
        navOps.toggleNavigator();
        return;
      }

      // Cmd/Ctrl+B: Toggle Navigator
      if (modifier && e.key === 'b') {
        e.preventDefault();
        navOps.toggleNavigator();
        return;
      }

      // Cmd/Ctrl+K: Commit (TODO: Open commit dialog)
      if (modifier && e.key === 'k' && !e.shiftKey) {
        e.preventDefault();
        console.log('Open commit dialog');
        return;
      }

      // Cmd/Ctrl+Shift+K: Commit All (TODO: Open commit dialog with all files)
      if (modifier && e.key === 'k' && e.shiftKey) {
        e.preventDefault();
        console.log('Open commit all dialog');
        return;
      }

      // Cmd/Ctrl+,: Settings (TODO: Open settings)
      if (modifier && e.key === ',') {
        e.preventDefault();
        console.log('Open settings');
        return;
      }

      // Cmd/Ctrl+Z: Undo - handled by individual editors
      if (modifier && e.key === 'z' && !e.shiftKey) {
        // Don't interfere - let the active editor handle this
        return;
      }

      // Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y: Redo - handled by individual editors
      if ((modifier && e.key === 'z' && e.shiftKey) || (modifier && e.key === 'y')) {
        // Don't interfere - let the active editor handle this
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTabId, operations, navOps]);
}

