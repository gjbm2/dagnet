/**
 * ExpressionToolbarTray — floating toolbar tray for non-chart expressions (cards/table).
 *
 * Provides:
 *  - View mode switcher (chart / cards / table pills)
 *  - Expression-specific display settings from the registry
 *  - Download CSV
 *  - Delete action (canvas only)
 *
 * Used by CanvasAnalysisNode to give cards/table the same floating toolbar
 * affordance that charts get via AnalysisChartContainer.
 */

import React from 'react';
import { BarChart3, LayoutGrid, Table2, Download, Trash2, ExternalLink, ClipboardCopy, MoreHorizontal } from 'lucide-react';
import type { ViewMode } from '../../types/chartRecipe';
import { getAvailableExpressions } from '../../types/chartRecipe';
import { getDisplaySettingsForSurface } from '../../lib/analysisDisplaySettingsRegistry';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import type { AnalysisResult } from '../../lib/graphComputeClient';
import { renderTraySettings } from './settingPillRenderer';
import { CfpPopover } from './CfpPopover';

const VIEW_MODE_META: Record<ViewMode, { icon: React.ComponentType<{ size?: number | string }>; label: string }> = {
  chart: { icon: BarChart3, label: 'Chart' },
  cards: { icon: LayoutGrid, label: 'Cards' },
  table: { icon: Table2, label: 'Table' },
};

export interface ExpressionToolbarTrayProps {
  viewMode: ViewMode;
  result: AnalysisResult | null;
  display?: Record<string, unknown>;
  onViewModeChange?: (mode: ViewMode) => void;
  onDisplayChange?: (keyOrBatch: string | Record<string, any>, value?: any) => void;
  onOpenAsTab?: () => void;
  onDumpDebug?: () => void;
  onDelete?: () => void;
}

export const ExpressionToolbarTray = React.memo(function ExpressionToolbarTray({
  viewMode,
  result,
  display,
  onViewModeChange,
  onDisplayChange,
  onOpenAsTab,
  onDumpDebug,
  onDelete,
}: ExpressionToolbarTrayProps) {
  const available = getAvailableExpressions(result);
  const settings = getDisplaySettingsForSurface(undefined, viewMode, 'inline', 'canvas');

  return (
    <>
      {/* View mode switcher */}
      {onViewModeChange && (
        <span className="cfp-pill-group" title="View">
          <span className="cfp-group-label">View</span>
          {available.map(mode => {
            const meta = VIEW_MODE_META[mode];
            const Icon = meta.icon;
            return (
              <button
                key={mode}
                type="button"
                className={`cfp-pill${mode === viewMode ? ' active' : ''}`}
                onClick={() => onViewModeChange(mode)}
                title={meta.label}
              >
                <Icon size={13} />
              </button>
            );
          })}
        </span>
      )}

      {/* Expression-specific display settings — same renderer as chart toolbar */}
      {settings.length > 0 && onDisplayChange && (
        <>
          <span className="cfp-sep" />
          {renderTraySettings(settings, display, onDisplayChange)}
        </>
      )}

      {/* Actions — grouped under "..." popover, same pattern as chart toolbar */}
      <CfpPopover
        icon={<MoreHorizontal size={13} />}
        title="More actions"
      >
        {onOpenAsTab && (
          <button type="button" className="cfp-menu-item" onClick={onOpenAsTab}>
            <ExternalLink size={12} /> Open as Tab
          </button>
        )}
        {result && (
          <button
            type="button"
            className="cfp-menu-item"
            onClick={() => {
              const { filename, csv } = analysisResultToCsv(result);
              downloadTextFile({ content: csv, filename, mimeType: 'text/csv' });
            }}
          >
            <Download size={12} /> Download CSV
          </button>
        )}
        {onDumpDebug && (
          <button type="button" className="cfp-menu-item" onClick={onDumpDebug}>
            <ClipboardCopy size={12} /> Dump Debug JSON
          </button>
        )}
        {onDelete && (
          <button type="button" className="cfp-menu-item cfp-menu-item--danger" onClick={onDelete}>
            <Trash2 size={12} /> Delete
          </button>
        )}
      </CfpPopover>
    </>
  );
});
