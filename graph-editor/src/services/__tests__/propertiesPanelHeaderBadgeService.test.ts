import { describe, it, expect } from 'vitest';
import { getPropertiesPanelHeaderBadges } from '../propertiesPanelHeaderBadgeService';

describe('propertiesPanelHeaderBadgeService', () => {
  it('shows override count and tooltip for an edge with multiple override flags', () => {
    const graph: any = {
      nodes: [],
      edges: [
        {
          uuid: 'e1',
          from: 'A',
          to: 'B',
          query_overridden: true,
          p: { mean_overridden: true, distribution_overridden: true },
        },
      ],
    };

    const badges = getPropertiesPanelHeaderBadges(graph, null, 'e1');
    expect(badges.overrides.visible).toBe(true);
    expect(badges.overrides.count).toBeGreaterThanOrEqual(3);
    expect(badges.overrides.tooltip).toContain('Overrides:');
  });

  it('shows connection tooltip with param name and data source type', () => {
    const graph: any = {
      nodes: [],
      edges: [
        {
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: {
            connection: 'amplitude-prod',
            data_source: { type: 'amplitude' },
          },
        },
      ],
    };

    const badges = getPropertiesPanelHeaderBadges(graph, null, 'e1');
    expect(badges.connection.visible).toBe(true);
    expect(badges.connection.tooltip).toContain('p:');
    expect(badges.connection.tooltip).toContain('connection=amplitude-prod');
    expect(badges.connection.tooltip).toContain('source=amplitude');
  });
});


