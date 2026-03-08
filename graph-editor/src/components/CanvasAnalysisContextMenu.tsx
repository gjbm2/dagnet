import React, { useMemo } from 'react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import type { CanvasAnalysis } from '@/types';
import type { ChartRecipeScenario } from '../types/chartRecipe';

interface CanvasAnalysisContextMenuProps {
  x: number;
  y: number;
  analysisId: string;
  analysis: CanvasAnalysis;
  analysisCount: number;
  onUpdate: (id: string, updates: Partial<CanvasAnalysis>) => void;
  onCaptureFromTab?: () => { scenarios: ChartRecipeScenario[]; what_if_dsl?: string } | null;
  onUseAsCurrent?: (dsl: string) => void;
  onEditScenarioDsl?: (scenarioId: string) => void;
  onBringToFront: (id: string) => void;
  onBringForward: (id: string) => void;
  onSendBackward: (id: string) => void;
  onSendToBack: (id: string) => void;
  onCopy: (id: string) => void;
  onCut: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function CanvasAnalysisContextMenu({
  x, y, analysisId, analysis, analysisCount,
  onUpdate, onCaptureFromTab, onUseAsCurrent, onEditScenarioDsl, onBringToFront, onBringForward, onSendBackward, onSendToBack,
  onCopy, onCut, onDelete, onClose,
}: CanvasAnalysisContextMenuProps) {
  const items = useMemo((): ContextMenuItem[] => {
    const result: ContextMenuItem[] = [];

    const viewModeItems: ContextMenuItem[] = [
      { label: `${analysis.view_mode === 'chart' ? '● ' : ''}Chart`, onClick: () => onUpdate(analysisId, { view_mode: 'chart' }) },
      { label: `${analysis.view_mode === 'cards' ? '● ' : ''}Cards`, onClick: () => onUpdate(analysisId, { view_mode: 'cards' }) },
    ];
    result.push({ label: 'View Mode', onClick: () => {}, submenu: viewModeItems });

    result.push(
      { label: '', onClick: () => {}, divider: true },
      analysis.live
        ? {
            label: 'Switch to Custom scenarios',
            onClick: () => {
              const captured = onCaptureFromTab?.();
              if (captured) {
                onUpdate(analysisId, {
                  live: false,
                  recipe: {
                    ...analysis.recipe,
                    scenarios: captured.scenarios,
                    analysis: { ...analysis.recipe.analysis, what_if_dsl: captured.what_if_dsl },
                  },
                } as any);
              } else {
                onUpdate(analysisId, { live: false } as any);
              }
            },
          }
        : {
            label: 'Return to Live scenarios',
            onClick: () => onUpdate(analysisId, {
              live: true,
              recipe: {
                ...analysis.recipe,
                scenarios: undefined,
                analysis: { ...analysis.recipe.analysis, what_if_dsl: undefined },
              },
            } as any),
          },
    );

    if (!analysis.live && onEditScenarioDsl) {
      const scenarios = analysis.recipe?.scenarios || [];
      if (scenarios.length > 0) {
        const editItems: ContextMenuItem[] = scenarios.map((s: any) => ({
          label: s.name || s.scenario_id,
          onClick: () => onEditScenarioDsl(s.scenario_id),
        }));
        result.push({ label: 'Edit scenario DSL', onClick: () => {}, submenu: editItems });
      }
    }

    if (!analysis.live && onUseAsCurrent) {
      const scenarios = analysis.recipe?.scenarios || [];
      const currentScenario = scenarios.find((s: any) => s.scenario_id === 'current');
      const dsl = currentScenario?.effective_dsl;
      if (typeof dsl === 'string' && dsl.trim()) {
        result.push({
          label: 'Use as Current query',
          onClick: () => onUseAsCurrent(dsl.trim()),
        });
      }
    }

    if (analysisCount > 1) {
      result.push(
        { label: '', onClick: () => {}, divider: true },
        { label: 'Bring to Front', onClick: () => onBringToFront(analysisId) },
        { label: 'Bring Forward', onClick: () => onBringForward(analysisId) },
        { label: 'Send Backward', onClick: () => onSendBackward(analysisId) },
        { label: 'Send to Back', onClick: () => onSendToBack(analysisId) },
      );
    }

    result.push(
      { label: '', onClick: () => {}, divider: true },
      { label: 'Copy', onClick: () => onCopy(analysisId) },
      { label: 'Cut', onClick: () => onCut(analysisId) },
      { label: 'Delete', onClick: () => onDelete(analysisId) },
    );

    return result;
  }, [analysisId, analysis, analysisCount, onUpdate, onCaptureFromTab, onUseAsCurrent, onEditScenarioDsl, onBringToFront, onBringForward, onSendBackward, onSendToBack, onCopy, onCut, onDelete]);

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
