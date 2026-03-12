import React, { useMemo } from 'react';
import { Lock, Zap, Code, ArrowUpCircle, SlidersHorizontal, ExternalLink, RefreshCw, ArrowUpToLine, ArrowUp, ArrowDown, ArrowDownToLine, Copy, Scissors, Trash2, Crosshair } from 'lucide-react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import type { CanvasAnalysis } from '@/types';
import type { ChartRecipeScenario } from '../types/chartRecipe';
import type { AvailableAnalysis } from '../lib/graphComputeClient';
import { buildContextMenuSettingItems } from '../lib/analysisDisplaySettingsRegistry';
import { getAnalysisTypeMeta } from './panels/analysisTypes';

const OVERLAY_COLOURS: Array<{ hex: string; label: string }> = [
  { hex: '#f59e0b', label: 'Amber' },
  { hex: '#3b82f6', label: 'Blue' },
  { hex: '#22c55e', label: 'Green' },
  { hex: '#ef4444', label: 'Red' },
  { hex: '#8b5cf6', label: 'Purple' },
  { hex: '#ec4899', label: 'Pink' },
];

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
  /** Effective chart kind from result semantics (for Display submenu) */
  effectiveChartKind?: string;
  /** Current display overrides */
  display?: Record<string, unknown>;
  /** Update a display setting */
  onDisplayChange?: (key: string, value: any) => void;
  /** Open chart in new tab (disabled when no cached result) */
  onOpenAsTab?: () => void;
  /** Trigger recompute */
  onRefresh?: () => void;
  /** Whether Open as Tab is available */
  hasCachedResult?: boolean;
  /** Available analysis types for this chart's DSL */
  availableAnalyses?: AvailableAnalysis[];
  /** Callback when user changes analysis type */
  onAnalysisTypeChange?: (analysisTypeId: string) => void;
  /** Whether the subject overlay connectors are active */
  overlayActive?: boolean;
  /** Current overlay colour */
  overlayColour?: string;
  /** Toggle overlay on/off */
  onOverlayToggle?: (active: boolean) => void;
  /** Change overlay colour */
  onOverlayColourChange?: (colour: string | null) => void;
}

export function CanvasAnalysisContextMenu({
  x, y, analysisId, analysis, analysisCount,
  onUpdate, onCaptureFromTab, onUseAsCurrent, onEditScenarioDsl, onBringToFront, onBringForward, onSendBackward, onSendToBack,
  onCopy, onCut, onDelete, onClose,
  effectiveChartKind, display, onDisplayChange, onOpenAsTab, onRefresh, hasCachedResult,
  availableAnalyses, onAnalysisTypeChange,
  overlayActive, overlayColour, onOverlayToggle, onOverlayColourChange,
}: CanvasAnalysisContextMenuProps) {
  const currentTypeId = analysis.recipe?.analysis?.analysis_type;

  const items = useMemo((): ContextMenuItem[] => {
    const result: ContextMenuItem[] = [];

    if (onAnalysisTypeChange && availableAnalyses && availableAnalyses.length > 0) {
      const typeItems: ContextMenuItem[] = availableAnalyses.map(a => {
        const meta = getAnalysisTypeMeta(a.id);
        const icon = meta?.icon ? React.createElement(meta.icon, { size: 14 }) : undefined;
        return {
          label: meta?.name || a.name || a.id,
          icon,
          checked: a.id === currentTypeId,
          onClick: () => onAnalysisTypeChange(a.id),
        };
      });
      result.push({ label: 'Analysis Type', onClick: () => {}, submenu: typeItems });
    }

    const viewModeItems: ContextMenuItem[] = [
      { label: 'Chart', checked: analysis.view_mode === 'chart', onClick: () => onUpdate(analysisId, { view_mode: 'chart' }) },
      { label: 'Cards', checked: analysis.view_mode === 'cards', onClick: () => onUpdate(analysisId, { view_mode: 'cards' }) },
      { label: 'Table', checked: analysis.view_mode === 'table', onClick: () => onUpdate(analysisId, { view_mode: 'table' }) },
    ];
    result.push({ label: 'View Mode', onClick: () => {}, submenu: viewModeItems });

    if (onOverlayToggle) {
      const connectorItems: ContextMenuItem[] = [
        {
          label: 'Show connectors',
          icon: React.createElement(Crosshair, { size: 14 }),
          checked: !!overlayActive,
          onClick: () => onOverlayToggle(!overlayActive),
        },
      ];
      if (onOverlayColourChange) {
        connectorItems.push({ label: '', onClick: () => {}, divider: true });
        for (const { hex, label } of OVERLAY_COLOURS) {
          connectorItems.push({
            label,
            checked: !!overlayActive && overlayColour === hex,
            onClick: () => onOverlayColourChange(hex),
          });
        }
      }
      result.push({ label: 'Connectors', icon: React.createElement(Crosshair, { size: 14 }), onClick: () => {}, submenu: connectorItems });
    }

    result.push(
      { label: '', onClick: () => {}, divider: true },
      analysis.live
        ? {
            label: 'Switch to Custom scenarios',
            icon: <Lock size={14} />,
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
            icon: <Zap size={14} />,
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
        result.push({ label: 'Edit scenario DSL', icon: <Code size={14} />, onClick: () => {}, submenu: editItems });
      }
    }

    if (!analysis.live && onUseAsCurrent) {
      const scenarios = analysis.recipe?.scenarios || [];
      const currentScenario = scenarios.find((s: any) => s.scenario_id === 'current');
      const dsl = currentScenario?.effective_dsl;
      if (typeof dsl === 'string' && dsl.trim()) {
        result.push({
          label: 'Use as Current query',
          icon: <ArrowUpCircle size={14} />,
          onClick: () => onUseAsCurrent(dsl.trim()),
        });
      }
    }

    if (effectiveChartKind && onDisplayChange) {
      const displayItems = buildContextMenuSettingItems(
        effectiveChartKind,
        analysis.view_mode || 'chart',
        display,
        (key, value) => onDisplayChange(key, value),
      );
      if (displayItems.length > 0) {
        result.push(
          { label: '', onClick: () => {}, divider: true },
          { label: 'Display', icon: <SlidersHorizontal size={14} />, onClick: () => {}, submenu: displayItems as ContextMenuItem[] },
        );
      }
    }

    result.push({ label: '', onClick: () => {}, divider: true });
    if (onOpenAsTab) {
      result.push({
        label: 'Open as Tab',
        icon: <ExternalLink size={14} />,
        onClick: onOpenAsTab,
        disabled: !hasCachedResult,
      });
    }
    if (onRefresh) {
      result.push({
        label: 'Refresh',
        icon: <RefreshCw size={14} />,
        onClick: onRefresh,
      });
    }

    if (analysisCount > 1) {
      result.push(
        { label: '', onClick: () => {}, divider: true },
        { label: 'Bring to Front', icon: <ArrowUpToLine size={14} />, onClick: () => onBringToFront(analysisId) },
        { label: 'Bring Forward', icon: <ArrowUp size={14} />, onClick: () => onBringForward(analysisId) },
        { label: 'Send Backward', icon: <ArrowDown size={14} />, onClick: () => onSendBackward(analysisId) },
        { label: 'Send to Back', icon: <ArrowDownToLine size={14} />, onClick: () => onSendToBack(analysisId) },
      );
    }

    result.push(
      { label: '', onClick: () => {}, divider: true },
      { label: 'Copy', icon: <Copy size={14} />, onClick: () => onCopy(analysisId) },
      { label: 'Cut', icon: <Scissors size={14} />, onClick: () => onCut(analysisId) },
      { label: 'Delete', icon: <Trash2 size={14} />, onClick: () => onDelete(analysisId) },
    );

    return result;
  }, [analysisId, analysis, analysisCount, onUpdate, onCaptureFromTab, onUseAsCurrent, onEditScenarioDsl, onBringToFront, onBringForward, onSendBackward, onSendToBack, onCopy, onCut, onDelete, effectiveChartKind, display, onDisplayChange, onOpenAsTab, onRefresh, hasCachedResult, availableAnalyses, onAnalysisTypeChange, currentTypeId, overlayActive, overlayColour, onOverlayToggle, onOverlayColourChange]);

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
