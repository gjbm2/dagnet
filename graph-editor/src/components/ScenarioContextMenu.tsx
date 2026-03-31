/**
 * ScenarioContextMenu
 *
 * Always-mounted component that listens for `dagnet:scenarioContextMenu` custom
 * events (dispatched by ScenarioLegend pills on the canvas) and renders a
 * context menu using the shared ContextMenu component.
 *
 * Also exposes a programmatic `open(x, y, scenarioId)` for the ScenariosPanel
 * palette rows to call directly.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import { useScenarioShareLink } from '../hooks/useScenarioShareLink';
import toast from 'react-hot-toast';

interface MenuState {
  x: number;
  y: number;
  scenarioId: string;
}

interface ScenarioContextMenuProps {
  tabId: string;
}

export function ScenarioContextMenu({ tabId }: ScenarioContextMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const scenariosContext = useScenariosContextOptional();
  const { operations, tabs } = useTabContext();

  const currentTab = tabs.find(t => t.id === tabId);
  const graphFileId = currentTab?.fileId || '';
  const { canShareScenario, copyStaticScenarioShareLink, copyLiveScenarioShareLink } = useScenarioShareLink(graphFileId, tabId);

  const scenarioState = currentTab?.editorState?.scenarioState as any;
  const visibleScenarioIds: string[] = scenarioState?.visibleScenarioIds || [];

  // Listen for custom events from ScenarioLegend pills
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { x, y, scenarioId } = e.detail;
      setMenu({ x, y, scenarioId });
    };
    window.addEventListener('dagnet:scenarioContextMenu', handler as EventListener);
    return () => {
      window.removeEventListener('dagnet:scenarioContextMenu', handler as EventListener);
    };
  }, []);

  const close = useCallback(() => setMenu(null), []);

  // ── Operations ──────────────────────────────────────────────────────────

  const handleToggleVisibility = useCallback(async (scenarioId: string) => {
    if (!tabId) return;
    await operations.toggleScenarioVisibility(tabId, scenarioId);
  }, [tabId, operations]);

  const handleShowOnly = useCallback(async (scenarioId: string) => {
    if (!tabId) return;
    await operations.setVisibleScenarios(tabId, [scenarioId]);
  }, [tabId, operations]);

  const handleUseAsCurrent = useCallback(async (scenarioId: string) => {
    if (!tabId || !scenariosContext) return;
    const { scenarios, setCurrentParams, baseParams, composeVisibleParams } = scenariosContext;

    if (scenarioId === 'current') return;
    if (scenarioId === 'base') {
      setCurrentParams(baseParams);
    } else {
      const scenario = scenarios.find(s => s.id === scenarioId);
      if (!scenario) { toast.error('Scenario not found'); return; }

      const state = operations.getScenarioState(tabId);
      const visible = state?.visibleScenarioIds || [];
      const idx = visible.indexOf(scenarioId);
      const layersUpToThis = idx >= 0
        ? visible.slice(0, idx + 1).filter(id => id !== 'current' && id !== 'base')
        : [scenarioId];
      setCurrentParams(composeVisibleParams(layersUpToThis));
    }

    await operations.updateTabState(tabId, { whatIfDSL: null });
    const state = operations.getScenarioState(tabId);
    if (state && !state.visibleScenarioIds.includes('current')) {
      await operations.toggleScenarioVisibility(tabId, 'current');
    }
    toast.success('Copied to current');
  }, [tabId, operations, scenariosContext]);

  const handleOpenEditor = useCallback((scenarioId: string) => {
    scenariosContext?.openInEditor(scenarioId);
  }, [scenariosContext]);

  const handleDelete = useCallback(async (scenarioId: string) => {
    if (!scenariosContext) return;
    await scenariosContext.deleteScenario(scenarioId);

    if (tabId) {
      const state = operations.getScenarioState(tabId);
      if (state?.visibleScenarioIds.includes(scenarioId)) {
        await operations.updateTabState(tabId, {
          scenarioState: {
            ...state,
            visibleScenarioIds: state.visibleScenarioIds.filter(id => id !== scenarioId),
            visibleColourOrderIds: state.visibleColourOrderIds.filter((id: string) => id !== scenarioId),
          },
        });
      }
    }
    toast.success('Scenario deleted');
  }, [scenariosContext, tabId, operations]);

  // ── Build menu items ───────────────────────────────────────────────────

  const buildItems = useCallback((scenarioId: string): ContextMenuItem[] => {
    if (!scenariosContext) return [];
    const { scenarios } = scenariosContext;
    const isVisible = visibleScenarioIds.includes(scenarioId);
    const isUserScenario = scenarios.some(s => s.id === scenarioId);
    const canMergeDown = scenarioId !== 'base' && scenarioId !== 'current';

    const items: ContextMenuItem[] = [];

    // Visibility
    items.push({
      label: isVisible ? 'Hide' : 'Show',
      onClick: () => handleToggleVisibility(scenarioId),
    });
    items.push({
      label: 'Show only',
      onClick: () => handleShowOnly(scenarioId),
    });

    items.push({ label: '', onClick: () => {}, divider: true });

    // Edit
    items.push({
      label: 'Edit',
      onClick: () => handleOpenEditor(scenarioId),
    });

    // Share
    if (canShareScenario(scenarioId)) {
      items.push({
        label: 'Share link (static)',
        onClick: () => void copyStaticScenarioShareLink(scenarioId),
      });
      items.push({
        label: 'Share link (live)',
        onClick: () => void copyLiveScenarioShareLink(scenarioId),
      });
    }

    // Use as current
    if (scenarioId !== 'current') {
      items.push({
        label: 'Use as current',
        onClick: () => handleUseAsCurrent(scenarioId),
      });
    }

    // Merge down (stub — not yet implemented)
    if (canMergeDown) {
      items.push({
        label: 'Merge down',
        disabled: true,
        onClick: () => {},
      });
    }

    // Delete
    if (isUserScenario) {
      items.push({ label: '', onClick: () => {}, divider: true });
      items.push({
        label: 'Delete',
        onClick: () => handleDelete(scenarioId),
      });
    }

    return items;
  }, [
    scenariosContext, visibleScenarioIds,
    handleToggleVisibility, handleShowOnly, handleOpenEditor,
    handleUseAsCurrent, handleDelete,
    canShareScenario, copyStaticScenarioShareLink, copyLiveScenarioShareLink,
  ]);

  if (!menu) return null;

  return createPortal(
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={buildItems(menu.scenarioId)}
      onClose={close}
    />,
    document.body,
  );
}
