import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import DockLayout from 'rc-dock';
import type { LayoutData } from 'rc-dock';

import { fileRegistry, useTabContext } from '../../contexts/TabContext';
import { useVisibleTabs } from '../../contexts/VisibleTabsContext';
import { useDashboardMode } from '../../hooks/useDashboardMode';
import { buildDashboardDockLayout } from '../../layouts/dashboardDockLayout';
import { getEditorComponent } from '../editors/EditorRegistry';
import { useIsReadOnlyShare } from '../../contexts/ShareModeContext';

import '../../styles/dashboard-mode.css';

export function DashboardShell() {
  const { tabs } = useTabContext();
  const { updateFromLayout } = useVisibleTabs();
  const { toggleDashboardMode } = useDashboardMode();
  const isReadOnlyShare = useIsReadOnlyShare();

  const dashboardTabMeta = useMemo(() => {
    return tabs
      .filter(t => {
        if (t.viewMode !== 'interactive') return false;

        // Prefer registry type where possible (works even if fileId naming changes).
        const file = fileRegistry.getFile(t.fileId);
        if (file?.type === 'graph' || file?.type === 'chart') return true;

        // Fallback for IDs that include workspace prefixes.
        return (
          t.fileId.startsWith('graph-') ||
          t.fileId.includes('-graph-') ||
          t.fileId.startsWith('chart-') ||
          t.fileId.includes('-chart-')
        );
      })
      .map(t => ({ id: t.id, fileId: t.fileId }));
  }, [tabs]);

  const tabIdsKey = useMemo(() => dashboardTabMeta.map(t => t.id).join('|'), [dashboardTabMeta]);

  // Keep a ref map so loadTab can stay stable even if TabContext updates frequently.
  // IMPORTANT: this must be populated synchronously (not in useEffect), because rc-dock
  // can call `loadTab` during the initial mount before effects run.
  const tabFileIdByTabIdRef = useRef<Map<string, string>>(new Map());
  tabFileIdByTabIdRef.current = new Map(dashboardTabMeta.map(t => [t.id, t.fileId]));

  // IMPORTANT: `defaultLayout` is only applied by rc-dock on mount.
  // So we must compute the correct layout synchronously for the current tab set,
  // and remount DockLayout when that set changes (via `key={tabIdsKey}` below).
  const layout: LayoutData = useMemo(() => {
    return buildDashboardDockLayout(dashboardTabMeta.map(t => t.id));
  }, [tabIdsKey, dashboardTabMeta]);

  const loadTab = useCallback((tab: any) => {
    const tabId = tab?.id as string | undefined;
    if (!tabId) return tab;
    const fileId = tabFileIdByTabIdRef.current.get(tabId);
    if (!fileId) {
      console.warn('[Dashboard] loadTab: missing fileId for tab', { tabId });
      return tab;
    }

    const file = fileRegistry.getFile(fileId);
    const objectType = (file?.type || (fileId.split('-')[0] as any)) as any;
    const EditorComponent = getEditorComponent(objectType, 'interactive');

    return {
      ...tab,
      title: '',
      content: (
        <div style={{ width: '100%', height: '100%' }}>
          <EditorComponent fileId={fileId} tabId={tabId} viewMode="interactive" readonly={isReadOnlyShare} onChange={() => {}} />
        </div>
      ),
      cached: true,
      closable: false,
    };
  }, [isReadOnlyShare]);

  // Keep VisibleTabsContext in sync so GraphCanvas/GraphEditor visibility gating works.
  // Dashboard layout is static (no dragging/splitting), so only update when the tab set changes.
  useEffect(() => {
    updateFromLayout(layout);
  }, [layout, updateFromLayout]);

  // Fit view across all graphs on entry / when graph set changes.
  const graphTabIdsKey = useMemo(() => {
    return dashboardTabMeta
      .filter(t => {
        const file = fileRegistry.getFile(t.fileId);
        return file?.type === 'graph' || t.fileId.startsWith('graph-') || t.fileId.includes('-graph-');
      })
      .map(t => t.id)
      .join('|');
  }, [dashboardTabMeta]);

  const lastFitKeyRef = useRef<string>('');
  useEffect(() => {
    if (!graphTabIdsKey) return;
    if (lastFitKeyRef.current === graphTabIdsKey) return;
    lastFitKeyRef.current = graphTabIdsKey;

    const t = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('dagnet:fitView'));
    }, 450);
    return () => window.clearTimeout(t);
  }, [graphTabIdsKey]);

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

      {dashboardTabMeta.length === 0 ? (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255, 255, 255, 0.72)', fontSize: 14 }}>
          No graph or chart tabs are open.
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


