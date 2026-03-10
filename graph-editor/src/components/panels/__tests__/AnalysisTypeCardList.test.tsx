import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisTypeCardList } from '../AnalysisTypeCardList';
import type { AvailableAnalysis } from '../../../lib/graphComputeClient';

describe('AnalysisTypeCardList', () => {
  const availableOnlyOverview: AvailableAnalysis[] = [
    { id: 'graph_overview', is_primary: true, reason: 'compatible' },
  ];

  // ── List view ──

  it('should show only available analyses when showAll is false (list view)', () => {
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={false}
        viewMode="list"
      />
    );

    expect(screen.getByText('Graph Overview')).toBeDefined();
    expect(screen.queryByText('Conversion Funnel')).toBeNull();
  });

  it('should mark unavailable analyses when showAll is true (list view)', () => {
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={true}
        viewMode="list"
      />
    );

    const unavailableButton = screen.getByText('Conversion Funnel').closest('button');
    expect(unavailableButton?.classList.contains('unavailable')).toBe(true);
  });

  it('should show primary indicator for primary available analysis (list view)', () => {
    const { container } = render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={'graph_overview'}
        onSelect={vi.fn()}
        showAll={true}
        viewMode="list"
      />
    );

    expect(container.querySelectorAll('.analytics-primary-indicator').length).toBe(1);
  });

  it('should call drag handler only for available cards (list view)', () => {
    const onCardDragStart = vi.fn();
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={true}
        viewMode="list"
        draggableAvailableCards={true}
        onCardDragStart={onCardDragStart}
      />
    );

    const dataTransfer = { setData: vi.fn(), effectAllowed: 'copy' } as any;
    const availableButton = screen.getByText('Graph Overview').closest('button') as HTMLButtonElement;
    const unavailableButton = screen.getByText('Conversion Funnel').closest('button') as HTMLButtonElement;

    fireEvent.dragStart(availableButton, { dataTransfer });
    fireEvent.dragStart(unavailableButton, { dataTransfer });

    expect(onCardDragStart).toHaveBeenCalledTimes(1);
  });

  // ── Icon view ──

  it('should default to icon view and render icon tiles', () => {
    const { container } = render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={false}
      />
    );

    expect(container.querySelector('.analytics-type-icons')).not.toBeNull();
    expect(container.querySelectorAll('.analytics-type-icon-tile').length).toBe(1);
    expect(screen.getByText('Graph Overview')).toBeDefined();
  });

  it('should mark selected tile in icon view', () => {
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId="graph_overview"
        onSelect={vi.fn()}
        showAll={false}
        viewMode="icons"
      />
    );

    const tile = screen.getByText('Graph Overview').closest('button');
    expect(tile?.classList.contains('selected')).toBe(true);
  });

  it('should mark primary tile with primary class in icon view', () => {
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={false}
        viewMode="icons"
      />
    );

    const tile = screen.getByText('Graph Overview').closest('button');
    expect(tile?.classList.contains('primary')).toBe(true);
  });

  it('should mark unavailable tiles in icon view', () => {
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={true}
        viewMode="icons"
      />
    );

    const unavailableTile = screen.getByText('Conversion Funnel').closest('button');
    expect(unavailableTile?.classList.contains('unavailable')).toBe(true);
  });
});
