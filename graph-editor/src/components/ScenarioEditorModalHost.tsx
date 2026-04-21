/**
 * ScenarioEditorModalHost
 *
 * Always-mounted host for the ScenarioEditorModal. Lives at canvas scope
 * (alongside ScenarioContextMenu) so the modal can open even when the
 * Scenarios dock panel is collapsed / unmounted. Previously the modal was
 * rendered inside ScenariosPanel, which meant right-clicking a pill did
 * nothing unless the dock panel happened to be active.
 */

import React, { useCallback } from 'react';
import { ScenarioEditorModal } from './modals/ScenarioEditorModal';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';

interface ScenarioEditorModalHostProps {
  tabId: string;
}

export function ScenarioEditorModalHost({ tabId }: ScenarioEditorModalHostProps) {
  const scenariosContext = useScenariosContextOptional();
  const editorOpenScenarioId = scenariosContext?.editorOpenScenarioId ?? null;
  const closeEditor = scenariosContext?.closeEditor;

  const handleClose = useCallback(() => {
    closeEditor?.();
  }, [closeEditor]);

  if (!scenariosContext) return null;

  return (
    <ScenarioEditorModal
      isOpen={editorOpenScenarioId !== null}
      scenarioId={editorOpenScenarioId}
      tabId={tabId}
      onClose={handleClose}
    />
  );
}
