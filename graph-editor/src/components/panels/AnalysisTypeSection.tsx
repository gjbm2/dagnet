/**
 * AnalysisTypeSection -- shared wrapped analysis type selector.
 *
 * Renders a CollapsibleSection with BarChart3 icon, view mode toggle (icons/list),
 * "Show all / Available only" toggle, AnalysisTypeCardList, and requirements hint
 * for unavailable types.
 *
 * Used identically by AnalyticsPanel and canvas analysis PropertiesPanel.
 */

import React, { useState } from 'react';
import { BarChart3, Eye, EyeOff, Grid3X3, List, Lightbulb, ZapOff } from 'lucide-react';
import CollapsibleSection from '../CollapsibleSection';
import { AnalysisTypeCardList, type AnalysisTypeViewMode } from './AnalysisTypeCardList';
import { getAnalysisTypeMeta, type AnalysisTypeMeta } from './analysisTypes';
import type { AvailableAnalysis } from '../../lib/graphComputeClient';

interface AnalysisTypeSectionProps {
  availableAnalyses: AvailableAnalysis[];
  selectedAnalysisId: string | null;
  onSelect: (analysisId: string) => void;
  defaultOpen?: boolean;
  /** Force the section open (e.g. when selected type is unsupported) */
  forceOpen?: boolean;
  /** Whether the analysis type has been manually overridden */
  overridden?: boolean;
  /** Callback to clear the override and revert to auto-resolved type */
  onClearOverride?: () => void;
  draggableAvailableCards?: boolean;
  onCardDragStart?: (event: React.DragEvent<HTMLButtonElement>, typeMeta: AnalysisTypeMeta) => void;
  /** Default view mode for the analysis type list */
  defaultViewMode?: AnalysisTypeViewMode;
}

export function AnalysisTypeSection({
  availableAnalyses,
  selectedAnalysisId,
  onSelect,
  defaultOpen = true,
  forceOpen,
  overridden,
  onClearOverride,
  draggableAvailableCards = false,
  onCardDragStart,
  defaultViewMode = 'icons',
}: AnalysisTypeSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const [viewMode, setViewMode] = useState<AnalysisTypeViewMode>(defaultViewMode);

  return (
    <>
      <CollapsibleSection
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <span>Analysis Type</span>
            {overridden && onClearOverride && (
              <button
                className={`override-toggle${overridden ? '' : ' disabled'}`}
                onClick={(e) => { e.stopPropagation(); onClearOverride(); }}
                title="Click to clear override"
                aria-label="Clear manual override"
                type="button"
              >
                <ZapOff size={12} />
              </button>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                className="analytics-show-all-toggle"
                onClick={(e) => { e.stopPropagation(); setViewMode(viewMode === 'icons' ? 'list' : 'icons'); }}
                title={viewMode === 'icons' ? 'Switch to list view' : 'Switch to icon view'}
              >
                {viewMode === 'icons' ? <List size={12} /> : <Grid3X3 size={12} />}
              </button>
              <button
                className="analytics-show-all-toggle"
                onClick={(e) => { e.stopPropagation(); setShowAll(!showAll); }}
                title={showAll ? 'Show only available' : 'Show all analysis types'}
              >
                {showAll ? <EyeOff size={12} /> : <Eye size={12} />}
                <span>{showAll ? 'Available only' : 'Show all'}</span>
              </button>
            </span>
          </span>
        }
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        icon={BarChart3}
      >
        <AnalysisTypeCardList
          availableAnalyses={availableAnalyses}
          selectedAnalysisId={selectedAnalysisId}
          onSelect={onSelect}
          showAll={showAll}
          viewMode={viewMode}
          draggableAvailableCards={draggableAvailableCards}
          onCardDragStart={onCardDragStart}
          searchable
        />
      </CollapsibleSection>

      {selectedAnalysisId && !availableAnalyses.some(a => a.id === selectedAnalysisId) && (
        <div className="analytics-requirements">
          <div className="analytics-requirements-title">
            <Lightbulb size={16} />
            <span>{getAnalysisTypeMeta(selectedAnalysisId)?.name || 'Analysis'}</span>
          </div>
          <div className="analytics-requirements-hint">
            {getAnalysisTypeMeta(selectedAnalysisId)?.selectionHint || 'Select appropriate nodes to enable this analysis.'}
          </div>
        </div>
      )}
    </>
  );
}
