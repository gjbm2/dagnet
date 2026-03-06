/**
 * Tests for shareLinkService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// shareLinkService now imports db + fileRegistry for live chart share.
// For URL-building unit tests we stub those dependencies to avoid Dexie/IDB in happy-dom.
vi.mock('../../db/appDatabase', () => ({
  db: {
    files: { get: vi.fn(async () => null) },
    tabs: { get: vi.fn(async () => null) },
    scenarios: { where: vi.fn(() => ({ equals: vi.fn(() => ({ toArray: vi.fn(async () => []) })) })) },
  },
}));

vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: { getFile: vi.fn(() => null) },
}));

vi.mock(import('../../lib/sharePayload'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stableShortHash: vi.fn(() => 'x'),
  };
});

import {
  buildStaticShareUrl,
  buildStaticSingleTabShareUrl,
  buildLiveShareUrl,
  extractIdentityFromFileSource,
  getShareUrlSoftWarning,
  buildLiveChartShareUrlFromRecipe,
} from '../shareLinkService';
import { decodeSharePayloadFromParam } from '../../lib/sharePayload';

// Mock sessionLogService
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('shareLinkService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildStaticShareUrl', () => {
    it('builds URL with compressed data', () => {
      const url = buildStaticShareUrl({
        graphData: { nodes: [], edges: [] },
        baseUrl: 'https://example.com/app',
      });

      expect(url).toContain('https://example.com/app');
      expect(url).toContain('data=');
      expect(url).toContain('mode=static');
      expect(url).toContain('nonudge=1');
      expect(url).toContain('dashboard=1');
    });

    it('includes identity metadata when provided', () => {
      const url = buildStaticShareUrl({
        graphData: { nodes: [], edges: [] },
        identity: {
          repo: 'my-repo',
          branch: 'main',
          graph: 'test-graph',
        },
        baseUrl: 'https://example.com/app',
      });

      expect(url).toContain('repo=my-repo');
      expect(url).toContain('branch=main');
      expect(url).toContain('graph=test-graph');
    });

    it('works without identity metadata', () => {
      const url = buildStaticShareUrl({
        graphData: { test: true },
        baseUrl: 'https://example.com/app',
      });

      expect(url).toContain('data=');
      expect(url).not.toContain('repo=');
    });

    it('does not include dashboard param when dashboardMode is false', () => {
      const url = buildStaticShareUrl({
        graphData: { nodes: [], edges: [] },
        baseUrl: 'https://example.com/app',
        dashboardMode: false,
      });

      expect(url).not.toContain('dashboard=1');
    });
  });

  describe('getShareUrlSoftWarning', () => {
    it('returns null for short URLs', () => {
      expect(getShareUrlSoftWarning('https://example.com/a')).toBeNull();
    });

    it('returns a warning for long URLs (Notion safety)', () => {
      const long = 'https://example.com/' + 'a'.repeat(2000);
      const warning = getShareUrlSoftWarning(long);
      expect(warning).toBeTruthy();
      expect(String(warning)).toContain('Notion');
      expect(String(warning)).toContain('characters');
    });
  });

  describe('buildLiveShareUrl', () => {
    it('builds URL with live mode params', () => {
      const url = buildLiveShareUrl({
        repo: 'my-repo',
        branch: 'main',
        graph: 'test-graph',
        secret: 'abc123',
        baseUrl: 'https://example.com/app',
      });

      expect(url).toContain('https://example.com/app');
      expect(url).toContain('mode=live');
      expect(url).toContain('repo=my-repo');
      expect(url).toContain('branch=main');
      expect(url).toContain('graph=test-graph');
      expect(url).toContain('secret=abc123');
      expect(url).not.toContain('nonudge=1');
      expect(url).toContain('dashboard=1');
    });

    it('does not include data param', () => {
      const url = buildLiveShareUrl({
        repo: 'r',
        branch: 'b',
        graph: 'g',
        secret: 's',
        baseUrl: 'https://example.com',
      });

      expect(url).not.toContain('data=');
    });

    it('does not include dashboard param when dashboardMode is false', () => {
      const url = buildLiveShareUrl({
        repo: 'r',
        branch: 'b',
        graph: 'g',
        secret: 's',
        baseUrl: 'https://example.com',
        dashboardMode: false,
      });

      expect(url).not.toContain('dashboard=1');
    });
  });

  describe('buildStaticSingleTabShareUrl', () => {
    it('wraps chart tabs in a bundle payload', () => {
      const url = buildStaticSingleTabShareUrl({
        tabType: 'chart',
        title: 'My Chart',
        data: { version: '1.0.0', chart_kind: 'analysis_funnel', title: 'My Chart', created_at_uk: '1-Jan-26', created_at_ms: 0, payload: { analysis_result: {}, scenario_ids: [] } },
        baseUrl: 'https://example.com/app',
      });

      expect(url).toContain('data=');
      expect(url).toContain('mode=static');
      expect(url).toContain('nonudge=1');
    });
  });

  describe('extractIdentityFromFileSource', () => {
    it('extracts identity from file source', () => {
      const identity = extractIdentityFromFileSource({
        repository: 'my-repo',
        branch: 'main',
        path: 'graphs/test-graph.json',
      });

      expect(identity).toEqual({
        repo: 'my-repo',
        branch: 'main',
        graph: 'test-graph',
      });
    });

    it('handles different file extensions', () => {
      const jsonIdentity = extractIdentityFromFileSource({
        repository: 'r',
        branch: 'b',
        path: 'graphs/my-graph.json',
      });
      expect(jsonIdentity?.graph).toBe('my-graph');

      const yamlIdentity = extractIdentityFromFileSource({
        repository: 'r',
        branch: 'b',
        path: 'graphs/my-graph.yaml',
      });
      expect(yamlIdentity?.graph).toBe('my-graph');

      const ymlIdentity = extractIdentityFromFileSource({
        repository: 'r',
        branch: 'b',
        path: 'graphs/my-graph.yml',
      });
      expect(ymlIdentity?.graph).toBe('my-graph');
    });

    it('returns undefined for incomplete source', () => {
      expect(extractIdentityFromFileSource(undefined)).toBeUndefined();
      expect(extractIdentityFromFileSource({})).toBeUndefined();
      expect(extractIdentityFromFileSource({ repository: 'r' })).toBeUndefined();
      expect(extractIdentityFromFileSource({ repository: 'r', branch: 'b' })).toBeUndefined();
    });

    it('extracts graph name from nested paths', () => {
      const identity = extractIdentityFromFileSource({
        repository: 'r',
        branch: 'b',
        path: 'some/nested/path/graphs/deep-graph.json',
      });
      expect(identity?.graph).toBe('deep-graph');
    });
  });

  describe('buildLiveChartShareUrlFromRecipe', () => {
    it('should build a share URL from a ChartRecipeCore with scenarios', () => {

      const result = buildLiveChartShareUrlFromRecipe({
        recipe: {
          analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)' },
          scenarios: [
            { scenario_id: 'current', effective_dsl: 'window(-30d:)', name: 'Current', colour: '#3b82f6' },
            { scenario_id: 'sc-1', effective_dsl: 'window(-30d:).context(channel:google)', name: 'Google', colour: '#ec4899', is_live: true },
          ],
        },
        identity: { repo: 'test-repo', branch: 'main', graph: 'test-graph' },
        secret: 'test-secret',
        chartKind: 'analysis_funnel',
        title: 'Test Funnel',
        graphState: { base_dsl: '', current_query_dsl: 'window(-30d:)' },
      });

      expect(result.success).toBe(true);
      expect(result.url).toBeDefined();
      expect(result.url).toContain('mode=live');
      expect(result.url).toContain('repo=test-repo');
      expect(result.url).toContain('share=');

      const url = new URL(result.url!);
      const shareParam = url.searchParams.get('share');
      expect(shareParam).toBeTruthy();

      const payload = decodeSharePayloadFromParam(shareParam!);
      expect(payload).toBeDefined();
      expect(payload!.target).toBe('chart');
      expect((payload as any).analysis.query_dsl).toBe('from(a).to(b)');
      expect((payload as any).scenarios.items).toHaveLength(1);
      expect((payload as any).scenarios.items[0].dsl).toBe('window(-30d:).context(channel:google)');
      expect((payload as any).scenarios.items[0].id).toBe('sc-1');
      expect((payload as any).scenarios.current?.dsl).toBe('window(-30d:)');
    });

    it('should fail when analytics DSL is missing', () => {
      const result = buildLiveChartShareUrlFromRecipe({
        recipe: {
          analysis: { analysis_type: 'graph_overview' },
        },
        identity: { repo: 'r', branch: 'b', graph: 'g' },
        secret: 's',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('analytics DSL');
    });

    it('should skip scenarios without effective_dsl', () => {
      const result = buildLiveChartShareUrlFromRecipe({
        recipe: {
          analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)' },
          scenarios: [
            { scenario_id: 'current', effective_dsl: 'window(-30d:)' },
            { scenario_id: 'sc-no-dsl', name: 'Empty' },
            { scenario_id: 'sc-ok', effective_dsl: 'context(channel:meta)', name: 'Meta' },
          ],
        },
        identity: { repo: 'r', branch: 'b', graph: 'g' },
        secret: 's',
      });

      expect(result.success).toBe(true);
      const payload = decodeSharePayloadFromParam(new URL(result.url!).searchParams.get('share')!);
      expect((payload as any).scenarios.items).toHaveLength(1);
      expect((payload as any).scenarios.items[0].id).toBe('sc-ok');
    });
  });
});
