/**
 * Tests for dependencyClosure
 */

import { describe, it, expect } from 'vitest';
import {
  collectGraphDependencies,
  extractContextKeysFromDSL,
  mergeDependencies,
  createEmptyDependencyClosure,
  getMinimalParameterIds,
} from '../dependencyClosure';

describe('dependencyClosure', () => {
  describe('extractContextKeysFromDSL', () => {
    it('extracts context() keys', () => {
      const keys = extractContextKeysFromDSL('context(region)');
      expect(keys.has('region')).toBe(true);
    });

    it('extracts context() keys with values', () => {
      const keys = extractContextKeysFromDSL('context(region:uk)');
      expect(keys.has('region')).toBe(true);
    });

    it('extracts contextAny() keys', () => {
      const keys = extractContextKeysFromDSL('contextAny(region:uk,country:us)');
      expect(keys.has('region')).toBe(true);
      expect(keys.has('country')).toBe(true);
    });

    it('extracts multiple context keys from complex DSL', () => {
      const dsl = 'context(region:uk) & context(platform) | contextAny(device:mobile,os:ios)';
      const keys = extractContextKeysFromDSL(dsl);
      expect(keys.has('region')).toBe(true);
      expect(keys.has('platform')).toBe(true);
      expect(keys.has('device')).toBe(true);
      expect(keys.has('os')).toBe(true);
    });

    it('returns empty set for null/undefined DSL', () => {
      expect(extractContextKeysFromDSL(null).size).toBe(0);
      expect(extractContextKeysFromDSL(undefined).size).toBe(0);
      expect(extractContextKeysFromDSL('').size).toBe(0);
    });
  });

  describe('collectGraphDependencies', () => {
    it('extracts parameter IDs from edges', () => {
      const graph = {
        nodes: [],
        edges: [
          { p: { id: 'param-1' } },
          { p: { id: 'param-2' }, cost_gbp: { id: 'cost-param' } },
        ],
      };
      const deps = collectGraphDependencies(graph);
      expect(deps.parameterIds.has('param-1')).toBe(true);
      expect(deps.parameterIds.has('param-2')).toBe(true);
      expect(deps.parameterIds.has('cost-param')).toBe(true);
    });

    it('extracts labour_cost parameter IDs', () => {
      const graph = {
        nodes: [],
        edges: [{ labour_cost: { id: 'labour-1' } }],
      };
      const deps = collectGraphDependencies(graph);
      expect(deps.parameterIds.has('labour-1')).toBe(true);
    });

    it('extracts conditional_p parameter IDs', () => {
      const graph = {
        nodes: [],
        edges: [
          {
            conditional_p: [
              { p: { id: 'cond-param-1' } },
              { p: { id: 'cond-param-2' } },
            ],
          },
        ],
      };
      const deps = collectGraphDependencies(graph);
      expect(deps.parameterIds.has('cond-param-1')).toBe(true);
      expect(deps.parameterIds.has('cond-param-2')).toBe(true);
    });

    it('extracts event IDs from nodes', () => {
      const graph = {
        nodes: [
          { id: 'node-1', event_id: 'event-a' },
          { id: 'node-2', event: { id: 'event-b' } },
        ],
        edges: [],
      };
      const deps = collectGraphDependencies(graph);
      expect(deps.eventIds.has('event-a')).toBe(true);
      expect(deps.eventIds.has('event-b')).toBe(true);
    });

    it('extracts case IDs from case nodes', () => {
      const graph = {
        nodes: [
          { id: 'node-1', type: 'case', case: { id: 'case-1' } },
          { id: 'node-2', type: 'regular' }, // Not a case node
        ],
        edges: [],
      };
      const deps = collectGraphDependencies(graph);
      expect(deps.caseIds.has('case-1')).toBe(true);
    });

    it('extracts node IDs', () => {
      const graph = {
        nodes: [
          { id: 'human-id-1' },
          { uuid: 'uuid-2' },
          { id: 'human-id-3', uuid: 'uuid-3' }, // Prefer id over uuid
        ],
        edges: [],
      };
      const deps = collectGraphDependencies(graph);
      expect(deps.nodeIds.has('human-id-1')).toBe(true);
      expect(deps.nodeIds.has('uuid-2')).toBe(true);
      expect(deps.nodeIds.has('human-id-3')).toBe(true);
      expect(deps.nodeIds.has('uuid-3')).toBe(false); // uuid-3 not added since id takes precedence
    });

    it('extracts context keys from DSL fields', () => {
      const graph = {
        nodes: [],
        edges: [],
        dataInterestsDSL: 'context(region)',
        currentQueryDSL: 'context(platform)',
        baseDSL: 'contextAny(device:mobile)',
      };
      const deps = collectGraphDependencies(graph);
      expect(deps.contextKeys.has('region')).toBe(true);
      expect(deps.contextKeys.has('platform')).toBe(true);
      expect(deps.contextKeys.has('device')).toBe(true);
    });

    it('handles empty/malformed graphs', () => {
      expect(() => collectGraphDependencies(null)).not.toThrow();
      expect(() => collectGraphDependencies({})).not.toThrow();
      expect(() => collectGraphDependencies({ nodes: 'invalid' })).not.toThrow();
    });
  });

  describe('mergeDependencies', () => {
    it('merges two dependency closures', () => {
      const a = createEmptyDependencyClosure();
      a.parameterIds.add('p1');
      a.eventIds.add('e1');

      const b = createEmptyDependencyClosure();
      b.parameterIds.add('p2');
      b.contextKeys.add('c1');

      const merged = mergeDependencies(a, b);
      expect(merged.parameterIds.has('p1')).toBe(true);
      expect(merged.parameterIds.has('p2')).toBe(true);
      expect(merged.eventIds.has('e1')).toBe(true);
      expect(merged.contextKeys.has('c1')).toBe(true);
    });
  });

  describe('getMinimalParameterIds', () => {
    it('returns array of parameter IDs', () => {
      const graph = {
        nodes: [],
        edges: [
          { p: { id: 'param-a' } },
          { p: { id: 'param-b' } },
        ],
      };
      const params = getMinimalParameterIds(graph);
      expect(params).toContain('param-a');
      expect(params).toContain('param-b');
      expect(params.length).toBe(2);
    });
  });

  describe('navigator dependency filter — fileId mapping', () => {
    /**
     * These tests verify the contract between collectGraphDependencies output
     * and the navigator's fileId-based filtering. The navigator builds a Set
     * of `type-id` fileIds from the closure and uses Set.has() to filter.
     * If this mapping breaks, the navigator shows wrong files.
     */

    function buildDependencyFileIds(graphJson: any, graphFileId: string): Set<string> {
      const deps = collectGraphDependencies(graphJson);
      const fileIds = new Set<string>();
      fileIds.add(graphFileId);
      for (const id of deps.parameterIds) fileIds.add(`parameter-${id}`);
      for (const id of deps.eventIds) fileIds.add(`event-${id}`);
      for (const id of deps.caseIds) fileIds.add(`case-${id}`);
      for (const id of deps.contextKeys) fileIds.add(`context-${id}`);
      for (const id of deps.nodeIds) fileIds.add(`node-${id}`);
      return fileIds;
    }

    const sampleGraph = {
      nodes: [
        { id: 'signup', event_id: 'user-signed-up' },
        { id: 'purchase', type: 'case', case: { id: 'purchase-type' } },
      ],
      edges: [
        { p: { id: 'channel' }, cost_gbp: { id: 'channel-cost' } },
        { p: { id: 'conversion' } },
      ],
      currentQueryDSL: 'context(region:uk)',
    };

    it('should include the graph itself in the filtered set', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-my-funnel');
      expect(fileIds.has('graph-my-funnel')).toBe(true);
    });

    it('should map parameter dependencies to parameter-prefixed fileIds', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-test');
      expect(fileIds.has('parameter-channel')).toBe(true);
      expect(fileIds.has('parameter-channel-cost')).toBe(true);
      expect(fileIds.has('parameter-conversion')).toBe(true);
    });

    it('should map event dependencies to event-prefixed fileIds', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-test');
      expect(fileIds.has('event-user-signed-up')).toBe(true);
    });

    it('should map case dependencies to case-prefixed fileIds', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-test');
      expect(fileIds.has('case-purchase-type')).toBe(true);
    });

    it('should map context DSL keys to context-prefixed fileIds', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-test');
      expect(fileIds.has('context-region')).toBe(true);
    });

    it('should map node IDs to node-prefixed fileIds', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-test');
      expect(fileIds.has('node-signup')).toBe(true);
      expect(fileIds.has('node-purchase')).toBe(true);
    });

    it('should not include unrelated fileIds', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-test');
      expect(fileIds.has('parameter-unrelated')).toBe(false);
      expect(fileIds.has('event-other-event')).toBe(false);
      expect(fileIds.has('graph-other-graph')).toBe(false);
    });

    it('should return only the graph for an empty graph', () => {
      const fileIds = buildDependencyFileIds({ nodes: [], edges: [] }, 'graph-empty');
      expect(fileIds.size).toBe(1);
      expect(fileIds.has('graph-empty')).toBe(true);
    });

    it('should correctly filter navigator entries via Set membership', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-my-funnel');

      // Simulate navigator entries (only fileId matters for filtering)
      const allEntries = [
        { fileId: 'graph-my-funnel' },
        { fileId: 'graph-other-graph' },
        { fileId: 'parameter-channel' },
        { fileId: 'parameter-channel-cost' },
        { fileId: 'parameter-unrelated' },
        { fileId: 'event-user-signed-up' },
        { fileId: 'event-other-event' },
        { fileId: 'case-purchase-type' },
        { fileId: 'node-signup' },
        { fileId: 'node-purchase' },
        { fileId: 'node-orphan-node' },
        { fileId: 'context-region' },
      ];

      const filtered = allEntries.filter(e => fileIds.has(e.fileId));
      const filteredIds = filtered.map(e => e.fileId);

      // Should include all dependencies
      expect(filteredIds).toContain('graph-my-funnel');
      expect(filteredIds).toContain('parameter-channel');
      expect(filteredIds).toContain('parameter-channel-cost');
      expect(filteredIds).toContain('event-user-signed-up');
      expect(filteredIds).toContain('case-purchase-type');
      expect(filteredIds).toContain('node-signup');
      expect(filteredIds).toContain('node-purchase');
      expect(filteredIds).toContain('context-region');

      // Should exclude non-dependencies
      expect(filteredIds).not.toContain('graph-other-graph');
      expect(filteredIds).not.toContain('parameter-unrelated');
      expect(filteredIds).not.toContain('event-other-event');
      expect(filteredIds).not.toContain('node-orphan-node');

      expect(filtered.length).toBe(8);
    });

    it('should compose with other filters (AND semantics)', () => {
      const fileIds = buildDependencyFileIds(sampleGraph, 'graph-my-funnel');

      const allEntries = [
        { fileId: 'graph-my-funnel', isDirty: true },
        { fileId: 'parameter-channel', isDirty: false },
        { fileId: 'parameter-channel-cost', isDirty: true },
        { fileId: 'parameter-unrelated', isDirty: true },
        { fileId: 'event-user-signed-up', isDirty: false },
      ];

      // Apply dependency filter AND dirty filter (composable)
      const filtered = allEntries.filter(e =>
        fileIds.has(e.fileId) && e.isDirty
      );

      expect(filtered.map(e => e.fileId)).toEqual([
        'graph-my-funnel',
        'parameter-channel-cost',
      ]);
    });
  });
});
