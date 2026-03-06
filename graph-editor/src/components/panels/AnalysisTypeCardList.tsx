import React, { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AvailableAnalysis } from '../../lib/graphComputeClient';
import { ANALYSIS_TYPES, type AnalysisTypeMeta } from './analysisTypes';

interface AnalysisTypeCardListProps {
  availableAnalyses: AvailableAnalysis[];
  selectedAnalysisId: string | null | undefined;
  onSelect: (analysisId: string) => void;
  showAll?: boolean;
  draggableAvailableCards?: boolean;
  onCardDragStart?: (event: React.DragEvent<HTMLButtonElement>, typeMeta: AnalysisTypeMeta) => void;
  className?: string;
}

const normalizeAnalysisId = (id: string) => (id === 'graph_overview_empty' ? 'graph_overview' : id);

export function AnalysisTypeCardList({
  availableAnalyses,
  selectedAnalysisId,
  onSelect,
  showAll = true,
  draggableAvailableCards = false,
  onCardDragStart,
  className = 'analytics-type-cards',
}: AnalysisTypeCardListProps) {
  const availableById = useMemo(() => {
    const map = new Map<string, AvailableAnalysis>();
    for (const analysis of availableAnalyses) {
      map.set(normalizeAnalysisId(analysis.id), analysis);
    }
    return map;
  }, [availableAnalyses]);

  const filteredTypes = useMemo(
    () => ANALYSIS_TYPES.filter((typeMeta) => showAll || availableById.has(typeMeta.id)),
    [showAll, availableById]
  );

  return (
    <div className={className}>
      {filteredTypes.map((typeMeta) => {
        const isAvailable = availableById.has(typeMeta.id);
        const isSelected = selectedAnalysisId === typeMeta.id;
        const availableInfo = availableById.get(typeMeta.id);
        const Icon = typeMeta.icon;
        const isDraggable = Boolean(draggableAvailableCards && isAvailable && onCardDragStart);

        return (
          <button
            key={typeMeta.id}
            className={`analytics-type-card ${isSelected ? 'selected' : ''} ${!isAvailable ? 'unavailable' : ''}`}
            onClick={() => onSelect(typeMeta.id)}
            title={typeMeta.selectionHint}
            draggable={isDraggable}
            onDragStart={isDraggable ? (event) => onCardDragStart?.(event, typeMeta) : undefined}
          >
            <div className="analytics-type-card-icon">
              <Icon size={14} strokeWidth={2} />
            </div>
            <div className="analytics-type-card-content">
              <div className="analytics-type-card-name">
                {typeMeta.name}
                {availableInfo?.is_primary && <ChevronRight size={10} className="analytics-primary-indicator" />}
              </div>
              <div className="analytics-type-card-desc">
                {typeMeta.shortDescription}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
