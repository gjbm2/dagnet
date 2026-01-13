/**
 * Tests for shareLinkService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildStaticShareUrl,
  buildLiveShareUrl,
  extractIdentityFromFileSource,
} from '../shareLinkService';

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
      expect(url).toContain('nonudge=1');
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
});
