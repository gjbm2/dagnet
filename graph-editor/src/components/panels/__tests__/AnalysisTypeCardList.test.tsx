import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisTypeCardList } from '../AnalysisTypeCardList';
import type { AvailableAnalysis } from '../../../lib/graphComputeClient';

describe('AnalysisTypeCardList', () => {
  const availableOnlyOverview: AvailableAnalysis[] = [
    { id: 'graph_overview', is_primary: true, reason: 'compatible' },
  ];

  it('should show only available analyses when showAll is false', () => {
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={false}
      />
    );

    expect(screen.getByText('Graph Overview')).toBeDefined();
    expect(screen.queryByText('Conversion Funnel')).toBeNull();
  });

  it('should mark unavailable analyses when showAll is true', () => {
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={true}
      />
    );

    const unavailableButton = screen.getByText('Conversion Funnel').closest('button');
    expect(unavailableButton?.classList.contains('unavailable')).toBe(true);
  });

  it('should show primary indicator for primary available analysis', () => {
    const { container } = render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={'graph_overview'}
        onSelect={vi.fn()}
        showAll={true}
      />
    );

    expect(container.querySelectorAll('.analytics-primary-indicator').length).toBe(1);
  });

  it('should call drag handler only for available cards', () => {
    const onCardDragStart = vi.fn();
    render(
      <AnalysisTypeCardList
        availableAnalyses={availableOnlyOverview}
        selectedAnalysisId={null}
        onSelect={vi.fn()}
        showAll={true}
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
});
