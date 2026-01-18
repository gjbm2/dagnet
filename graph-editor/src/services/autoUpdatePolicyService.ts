import { db } from '../db/appDatabase';
import { getShareBootConfig } from '../lib/shareBootResolver';

type AutoUpdatePolicySnapshot = {
  enabled: boolean;
  forced: boolean;
  reason: 'forced-live' | 'forced-dashboard' | 'url' | 'workspace-pref' | 'default';
};

function isDashboardModeUrl(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('dashboard');
  } catch {
    return false;
  }
}

function isAutoUpdateUrlOverride(): boolean {
  try {
    const v = new URLSearchParams(window.location.search).get('auto-update');
    if (!v) return false;
    return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
  } catch {
    return false;
  }
}

class AutoUpdatePolicyService {
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // best-effort only
      }
    }
  }

  async getWorkspaceAutoUpdateChartsEnabled(): Promise<boolean> {
    const s = await db.getAppState();
    // Default is ON (per design decision).
    return typeof s?.autoUpdateChartsEnabled === 'boolean' ? s.autoUpdateChartsEnabled : true;
  }

  async setWorkspaceAutoUpdateChartsEnabled(enabled: boolean): Promise<void> {
    await db.saveAppState({ autoUpdateChartsEnabled: enabled });
    this.notify();
  }

  async getAutoUpdateChartsPolicy(): Promise<AutoUpdatePolicySnapshot> {
    const boot = getShareBootConfig();
    if (boot.mode === 'live') return { enabled: true, forced: true, reason: 'forced-live' };
    if (isDashboardModeUrl()) return { enabled: true, forced: true, reason: 'forced-dashboard' };
    if (isAutoUpdateUrlOverride()) return { enabled: true, forced: false, reason: 'url' };

    const s = await db.getAppState();
    if (typeof s?.autoUpdateChartsEnabled === 'boolean') {
      return { enabled: s.autoUpdateChartsEnabled, forced: false, reason: 'workspace-pref' };
    }
    // Default is ON (per design decision).
    return { enabled: true, forced: false, reason: 'default' };
  }
}

export const autoUpdatePolicyService = new AutoUpdatePolicyService();
