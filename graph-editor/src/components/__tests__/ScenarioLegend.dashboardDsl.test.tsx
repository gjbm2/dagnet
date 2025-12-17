import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ScenarioLegend } from '../ScenarioLegend';

describe('ScenarioLegend dashboard clarity', () => {
  it('shows Current chip even when there are no user scenarios, and includes active DSL in the chip title', () => {
    render(
      <ScenarioLegend
        scenarios={[]}
        scenarioOrder={[]}
        visibleScenarioIds={['current']}
        currentColour="#00ff00"
        baseColour="#ff0000"
        showCurrent={true}
        showBase={false}
        activeDsl="cohort(10-Dec-25:16-Dec-25)"
        onToggleVisibility={() => {}}
        onDelete={() => {}}
      />
    );

    const currentLabel = screen.getByText('Current');
    const chip = currentLabel.closest('.scenario-legend-chip');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('title')).toBe('Current — cohort(10-Dec-25:16-Dec-25)');
  });

  it('includes active DSL in the Base chip title when Base is shown', () => {
    render(
      <ScenarioLegend
        scenarios={[]}
        scenarioOrder={[]}
        visibleScenarioIds={['base']}
        currentColour="#00ff00"
        baseColour="#ff0000"
        showCurrent={false}
        showBase={true}
        activeDsl="window(1-Dec-25:7-Dec-25)"
        onToggleVisibility={() => {}}
        onDelete={() => {}}
      />
    );

    const baseLabel = screen.getByText('Base');
    const chip = baseLabel.closest('.scenario-legend-chip');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('title')).toBe('Base — window(1-Dec-25:7-Dec-25)');
  });
});


