/**
 * Tests for shareBootResolver
 * 
 * Note: These tests use vi.resetModules() to ensure each test gets a fresh
 * instance of the module with its cached _bootConfig cleared.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('shareBootResolver', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // Reset module cache to clear the singleton _bootConfig
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original location
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  function mockLocation(search: string) {
    Object.defineProperty(window, 'location', {
      value: { search },
      writable: true,
    });
  }
  
  async function getModule() {
    return await import('../shareBootResolver');
  }

  describe('resolveShareBootConfig', () => {
    it('returns none mode for normal workspace URLs', async () => {
      mockLocation('');
      const { resolveShareBootConfig } = await getModule();
      const config = resolveShareBootConfig();
      expect(config.mode).toBe('none');
      expect(config.dbName).toBe('DagNetGraphEditor');
      expect(config.hasDataParam).toBe(false);
    });

    it('returns static mode for ?data= URLs', async () => {
      mockLocation('?data=somecompresseddata');
      const { resolveShareBootConfig } = await getModule();
      const config = resolveShareBootConfig();
      expect(config.mode).toBe('static');
      expect(config.hasDataParam).toBe(true);
    });

    it('returns static mode for ?mode=static URLs', async () => {
      mockLocation('?mode=static');
      const { resolveShareBootConfig } = await getModule();
      const config = resolveShareBootConfig();
      expect(config.mode).toBe('static');
    });

    it('returns live mode for ?mode=live with full identity', async () => {
      mockLocation('?mode=live&repo=test-repo&branch=main&graph=my-graph&secret=abc123');
      const { resolveShareBootConfig } = await getModule();
      const config = resolveShareBootConfig();
      expect(config.mode).toBe('live');
      expect(config.repo).toBe('test-repo');
      expect(config.branch).toBe('main');
      expect(config.graph).toBe('my-graph');
      expect(config.secret).toBe('abc123');
      // DB name should be scoped
      expect(config.dbName).toMatch(/^DagNetGraphEditorShare:/);
    });

    it('falls back to static mode for ?mode=live without identity but with data', async () => {
      mockLocation('?mode=live&data=somedata');
      const { resolveShareBootConfig } = await getModule();
      const config = resolveShareBootConfig();
      expect(config.mode).toBe('static');
    });

    it('extracts identity metadata from static share URLs', async () => {
      mockLocation('?mode=static&data=x&repo=my-repo&branch=dev&graph=test-graph');
      const { resolveShareBootConfig } = await getModule();
      const config = resolveShareBootConfig();
      expect(config.mode).toBe('static');
      expect(config.repo).toBe('my-repo');
      expect(config.branch).toBe('dev');
      expect(config.graph).toBe('test-graph');
    });
  });

  describe('helper functions', () => {
    it('isShareMode returns true for static mode', async () => {
      mockLocation('?data=x');
      const { isShareMode } = await getModule();
      expect(isShareMode()).toBe(true);
    });

    it('isShareMode returns true for live mode', async () => {
      mockLocation('?mode=live&repo=r&branch=b&graph=g');
      const { isShareMode } = await getModule();
      expect(isShareMode()).toBe(true);
    });

    it('isShareMode returns false for normal mode', async () => {
      mockLocation('');
      const { isShareMode } = await getModule();
      expect(isShareMode()).toBe(false);
    });

    it('isStaticShareMode returns true only for static', async () => {
      mockLocation('?mode=static');
      const { isStaticShareMode, isLiveShareMode } = await getModule();
      expect(isStaticShareMode()).toBe(true);
      expect(isLiveShareMode()).toBe(false);
    });

    it('isLiveShareMode returns true only for live', async () => {
      mockLocation('?mode=live&repo=r&branch=b&graph=g');
      const { isLiveShareMode, isStaticShareMode } = await getModule();
      expect(isLiveShareMode()).toBe(true);
      expect(isStaticShareMode()).toBe(false);
    });
  });

  describe('DB name scoping', () => {
    it('uses default DB name for normal mode', async () => {
      mockLocation('');
      const { getShareDbName } = await getModule();
      expect(getShareDbName()).toBe('DagNetGraphEditor');
    });

    it('uses default DB name for static mode (ephemeral)', async () => {
      mockLocation('?mode=static&data=x');
      const { getShareDbName } = await getModule();
      expect(getShareDbName()).toBe('DagNetGraphEditor');
    });

    it('uses scoped DB name for live mode', async () => {
      mockLocation('?mode=live&repo=test-repo&branch=main&graph=my-graph');
      const { getShareDbName } = await getModule();
      const dbName = getShareDbName();
      expect(dbName).toMatch(/^DagNetGraphEditorShare:/);
      expect(dbName).toContain('testrep'); // Truncated repo prefix (non-alphanumeric removed)
    });

    it('generates different DB names for different live shares', async () => {
      mockLocation('?mode=live&repo=repo-a&branch=main&graph=graph-1');
      const mod1 = await getModule();
      const dbName1 = mod1.getShareDbName();

      vi.resetModules();
      mockLocation('?mode=live&repo=repo-b&branch=main&graph=graph-2');
      const mod2 = await getModule();
      const dbName2 = mod2.getShareDbName();

      expect(dbName1).not.toBe(dbName2);
    });
  });
});
