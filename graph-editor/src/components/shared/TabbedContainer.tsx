/**
 * TabbedContainer — lightweight shared tab component.
 *
 * Provides a compact horizontal tab bar with content switching.
 * No opinions about sizing, positioning, or portal rendering —
 * the parent container owns layout constraints.
 *
 * Height stability: on first render, ALL panels are rendered (hidden) and
 * measured. The tallest panel's height becomes the min-height of the panel
 * area, so tab switching never changes the container height.
 *
 * Used by hover previews (node_info / edge_info) and later by
 * pinned canvas analysis cards.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './tabbed-container.css';

export interface TabDefinition {
  id: string;
  label: string;
  /** When true, tab is hidden from the tab bar entirely */
  hidden?: boolean;
}

interface TabbedContainerProps {
  tabs: TabDefinition[];
  /** Which tab to show initially (uncontrolled mode). Defaults to first visible tab. */
  defaultTab?: string;
  /** Controlled mode: parent owns active tab state. */
  activeTab?: string;
  /** Fires when the user switches tabs (hover or click). */
  onTabChange?: (tabId: string) => void;
  /** Tab panels: keyed by tab id. Only the active panel is rendered. */
  panels: Record<string, React.ReactNode>;
}

export function TabbedContainer({
  tabs,
  defaultTab,
  activeTab: controlledTab,
  onTabChange,
  panels,
}: TabbedContainerProps) {
  const visibleTabs = useMemo(() => tabs.filter(t => !t.hidden), [tabs]);
  const firstVisible = visibleTabs[0]?.id ?? '';

  const [internalTab, setInternalTab] = useState(defaultTab ?? firstVisible);
  const currentTab = controlledTab ?? internalTab;

  // Height stability: render all panels hidden on first frame, measure tallest,
  // then lock min-height and switch to single-panel rendering.
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lockedHeight != null) return; // already measured
    const el = measureRef.current;
    if (!el) return;
    // Measure each hidden panel child
    let maxH = 0;
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i] as HTMLElement;
      maxH = Math.max(maxH, child.scrollHeight);
    }
    if (maxH > 0) {
      setLockedHeight(maxH);
    }
  });

  const handleTabSelect = useCallback((tabId: string) => {
    if (tabId === currentTab) return;
    if (controlledTab === undefined) {
      setInternalTab(tabId);
    }
    onTabChange?.(tabId);
  }, [currentTab, controlledTab, onTabChange]);

  // If only one visible tab, skip the tab bar entirely
  if (visibleTabs.length <= 1) {
    const onlyId = visibleTabs[0]?.id;
    return (
      <div className="dagnet-tabs dagnet-tabs--single">
        <div className="dagnet-tab-panel">
          {onlyId ? panels[onlyId] : null}
        </div>
      </div>
    );
  }

  // Measurement phase: render all panels invisibly to measure tallest
  const measuring = lockedHeight == null;

  return (
    <div className="dagnet-tabs">
      <div className="dagnet-tab-bar" role="tablist">
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === currentTab}
            className={
              'dagnet-tab-button' +
              (tab.id === currentTab ? ' dagnet-tab-button--active' : '')
            }
            onClick={() => handleTabSelect(tab.id)}
            onMouseEnter={() => handleTabSelect(tab.id)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {measuring ? (
        // Measurement render: all panels stacked, visibility hidden, no overflow clip
        <div ref={measureRef} className="dagnet-tab-panel dagnet-tab-panel--measure">
          {visibleTabs.map(tab => (
            <div key={tab.id} className="dagnet-tab-measure-slot">
              {panels[tab.id] ?? null}
            </div>
          ))}
        </div>
      ) : (
        <div className="dagnet-tab-panel" style={{ minHeight: lockedHeight ?? undefined }}>
          {panels[currentTab] ?? null}
        </div>
      )}
    </div>
  );
}
