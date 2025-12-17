import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import DockLayout from 'rc-dock';
import type { LayoutData } from 'rc-dock';

import { fileRegistry, useTabContext } from '../../contexts/TabContext';
import { useVisibleTabs } from '../../contexts/VisibleTabsContext';
import { useDashboardMode } from '../../hooks/useDashboardMode';
import { buildDashboardDockLayout } from '../../layouts/dashboardDockLayout';
import { GraphEditor } from '../editors/GraphEditor';

import '../../styles/dashboard-mode.css';

export function DashboardShell() {
  const { tabs } = useTabContext();
  const { updateFromLayout } = useVisibleTabs();
  const { toggleDashboardMode } = useDashboardMode();

  const graphTabMeta = useMemo(() => {
    return tabs
      .filter(t => {
        if (t.viewMode !== 'interactive') return false;

        // Prefer registry type where possible (works even if fileId naming changes).
        const file = fileRegistry.getFile(t.fileId);
        if (file?.type === 'graph') return true;

        // Fallback for IDs that include workspace prefixes.
        return t.fileId.startsWith('graph-') || t.fileId.includes('-graph-');
      })
      .map(t => ({ id: t.id, fileId: t.fileId }));
  }, [tabs]);

  const tabIdsKey = useMemo(() => graphTabMeta.map(t => t.id).join('|'), [graphTabMeta]);

  // Keep a ref map so loadTab can stay stable even if TabContext updates frequently.
  // IMPORTANT: this must be populated synchronously (not in useEffect), because rc-dock
  // can call `loadTab` during the initial mount before effects run.
  const tabFileIdByTabIdRef = useRef<Map<string, string>>(new Map());
  tabFileIdByTabIdRef.current = new Map(graphTabMeta.map(t => [t.id, t.fileId]));

  // IMPORTANT: `defaultLayout` is only applied by rc-dock on mount.
  // So we must compute the correct layout synchronously for the current tab set,
  // and remount DockLayout when that set changes (via `key={tabIdsKey}` below).
  const layout: LayoutData = useMemo(() => {
    return buildDashboardDockLayout(graphTabMeta.map(t => t.id));
  }, [tabIdsKey, graphTabMeta]);

  const loadTab = useCallback((tab: any) => {
    const tabId = tab?.id as string | undefined;
    if (!tabId) return tab;
    const fileId = tabFileIdByTabIdRef.current.get(tabId);
    if (!fileId) {
      console.warn('[Dashboard] loadTab: missing fileId for tab', { tabId });
      return tab;
    }
    return {
      ...tab,
      title: '',
      content: (
        <div style={{ width: '100%', height: '100%' }}>
          <GraphEditor fileId={fileId} tabId={tabId} viewMode="interactive" readonly={false} onChange={() => {}} />
        </div>
      ),
      cached: true,
      closable: false,
    };
  }, []);

  // Keep VisibleTabsContext in sync so GraphCanvas/GraphEditor visibility gating works.
  // Dashboard layout is static (no dragging/splitting), so only update when the tab set changes.
  useEffect(() => {
    updateFromLayout(layout);
  }, [layout, updateFromLayout]);

  // Fit view across all graphs on entry / when graph set changes.
  const lastFitKeyRef = useRef<string>('');
  useEffect(() => {
    if (!tabIdsKey) return;
    if (lastFitKeyRef.current === tabIdsKey) return;
    lastFitKeyRef.current = tabIdsKey;

    const t = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('dagnet:fitView'));
    }, 450);
    return () => window.clearTimeout(t);
  }, [tabIdsKey]);

  return (
    <div className="dashboard-shell">
      <div className="dashboard-overlay">
        <button
          type="button"
          className="dashboard-brand"
          onClick={() => toggleDashboardMode({ updateUrl: true })}
          aria-label="Toggle dashboard mode"
          title="Toggle dashboard mode"
        >
          <img src="/dagnet-icon.png" alt="" />
          <div className="dashboard-title">DagNet</div>
        </button>
      </div>

      {graphTabMeta.length === 0 ? (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255, 255, 255, 0.72)', fontSize: 14 }}>
          No graph tabs are open.
        </div>
      ) : (
        <DockLayout
          key={tabIdsKey}
          defaultLayout={layout}
          loadTab={loadTab}
          style={{ width: '100%', height: '100%' }}
        />
      )}
    </div>
  );
}


