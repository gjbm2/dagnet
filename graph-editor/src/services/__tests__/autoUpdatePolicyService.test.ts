/**
 * autoUpdatePolicyService (workspace preference + forced modes)
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { db } from '../../db/appDatabase';

// Share boot config is cached globally in the real module, so keep it explicitly mocked here.
const shareBoot = vi.hoisted(() => ({ mode: 'none' as any }));
vi.mock('../../lib/shareBootResolver', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getShareBootConfig: () => ({ ...(actual.getShareBootConfig?.() || {}), mode: shareBoot.mode }),
  };
});

import { autoUpdatePolicyService } from '../autoUpdatePolicyService';

describe('autoUpdatePolicyService', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Clean app-state so defaults can be asserted.
    await db.delete();
    await db.open();
    await db.initialize();
    shareBoot.mode = 'none';
    window.history.pushState({}, '', '/?e2e=1');
  });

  it('defaults to enabled in normal workspace mode when no preference is stored', async () => {
    const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
    expect(p).toMatchObject({ enabled: true, forced: false, reason: 'default' });
  });

  it('respects stored workspace preference when not forced', async () => {
    await db.saveAppState({ autoUpdateChartsEnabled: false });
    const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
    expect(p).toMatchObject({ enabled: false, forced: false, reason: 'workspace-pref' });
  });

  it('treats ?auto-update=true as an enable override in workspace mode', async () => {
    await db.saveAppState({ autoUpdateChartsEnabled: false });
    window.history.pushState({}, '', '/?auto-update=true&e2e=1');
    const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
    expect(p).toMatchObject({ enabled: true, forced: false, reason: 'url' });
  });

  it('forces enabled in dashboard mode regardless of workspace preference', async () => {
    await db.saveAppState({ autoUpdateChartsEnabled: false });
    window.history.pushState({}, '', '/?dashboard=1&e2e=1');
    const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
    expect(p).toMatchObject({ enabled: true, forced: true, reason: 'forced-dashboard' });
  });

  it('forces enabled in live share mode regardless of workspace preference', async () => {
    await db.saveAppState({ autoUpdateChartsEnabled: false });
    shareBoot.mode = 'live';
    const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
    expect(p).toMatchObject({ enabled: true, forced: true, reason: 'forced-live' });
  });

  it('notifies subscribers when workspace preference changes', async () => {
    let notifyCount = 0;
    const unsubscribe = autoUpdatePolicyService.subscribe(() => {
      notifyCount++;
    });

    await autoUpdatePolicyService.setWorkspaceAutoUpdateChartsEnabled(false);
    await autoUpdatePolicyService.setWorkspaceAutoUpdateChartsEnabled(true);

    unsubscribe();

    expect(notifyCount).toBe(2);
    const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
    expect(p.enabled).toBe(true);
  });
});


