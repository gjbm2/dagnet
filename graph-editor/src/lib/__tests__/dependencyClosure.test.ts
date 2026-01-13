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
});
