import React, { useState, useEffect } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import EdgeScalingControl from '../EdgeScalingControl';
import { useViewPreferencesContext } from '../../contexts/ViewPreferencesContext';
import { sessionLogService } from '../../services/sessionLogService';

/**
 * View Menu
 * 
 * Context-sensitive based on active tab type:
 * - Graph tabs: Show graph-specific options (Edge Scaling, Re-route, Auto Layout, etc.)
 * - Other tabs: Show general view options
 * - All tabs: Open in New Tab (JSON/YAML views)
 */
export function ViewMenu() {
  const { activeTabId, tabs, operations } = useTabContext();
  const { operations: navOps } = useNavigatorContext();
  
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isGraphTab = activeTab?.fileId.startsWith('graph-') ?? false;
  const isInteractiveView = activeTab?.viewMode === 'interactive';
  
  // View preferences from context (per-tab, instant updates)
  // ViewMenu is at app shell level, so context may not be available when no graph tab is active
  const viewPrefsCtx = useViewPreferencesContext();
  
  // Fallback: read from active tab state when context not available
  const useUniformScaling = viewPrefsCtx?.useUniformScaling ?? (activeTab?.editorState?.useUniformScaling ?? false);
  const massGenerosity = viewPrefsCtx?.massGenerosity ?? (activeTab?.editorState?.massGenerosity ?? 0.5);
  const autoReroute = viewPrefsCtx?.autoReroute ?? (activeTab?.editorState?.autoReroute ?? true);
  const useSankeyView = viewPrefsCtx?.useSankeyView ?? (activeTab?.editorState?.useSankeyView ?? false);
  const confidenceIntervalLevel = viewPrefsCtx?.confidenceIntervalLevel ?? (activeTab?.editorState?.confidenceIntervalLevel as 'none' | '80' | '90' | '95' | '99' ?? 'none');
  
  // Debug: Log when menu is checked
  React.useEffect(() => {
    if (activeTab) {
      console.log(`ViewMenu: activeTab=${activeTab.id}, fileId=${activeTab.fileId}, isGraphTab=${isGraphTab}, isInteractive=${isInteractiveView}, editorState=`, activeTab.editorState);
    }
  }, [activeTab, isGraphTab, isInteractiveView]);

  const handleOpenInNewTab = async (viewMode: 'raw-json' | 'raw-yaml') => {
    if (activeTabId) {
      await operations.openInNewView(activeTabId, viewMode);
    }
  };

  const handleToggleNavigator = () => {
    navOps.toggleNavigator();
  };

  // Graph-specific handlers
  const handleToggleUniformScaling = (newValue: boolean) => {
    if (viewPrefsCtx) {
      viewPrefsCtx.setUseUniformScaling(newValue);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { useUniformScaling: newValue });
    }
  };

  const handleSetMassGenerosity = (value: number) => {
    if (viewPrefsCtx) {
      viewPrefsCtx.setMassGenerosity(value);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { massGenerosity: value });
    }
  };

  const handleReRoute = () => {
    window.dispatchEvent(new CustomEvent('dagnet:forceReroute'));
  };

  const handleToggleAutoReroute = () => {
    const newValue = !autoReroute;
    if (viewPrefsCtx) {
      viewPrefsCtx.setAutoReroute(newValue);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { autoReroute: newValue });
    }
  };

  const handleToggleSankeyView = () => {
    const newValue = !useSankeyView;
    if (viewPrefsCtx) {
      viewPrefsCtx.setUseSankeyView(newValue);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { useSankeyView: newValue });
    }
  };

  const handleConfidenceIntervalChange = (level: 'none' | '80' | '90' | '95' | '99') => {
    if (viewPrefsCtx) {
      viewPrefsCtx.setConfidenceIntervalLevel(level);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { confidenceIntervalLevel: level });
    }
  };

  const handleAutoLayout = (direction: 'LR' | 'RL' | 'TB' | 'BT') => {
    window.dispatchEvent(new CustomEvent('dagnet:autoLayout', { detail: { direction } }));
  };

  const handleSankeyLayout = () => {
    window.dispatchEvent(new CustomEvent('dagnet:sankeyLayout'));
  };

  const handleTogglePropertiesPanel = () => {
    // TODO: Implement sidebar panel toggles
    console.log('Toggle Properties Panel');
  };

  const handleToggleWhatIfPanel = () => {
    // TODO: Implement sidebar panel toggles
    console.log('Toggle What-If Analysis');
  };

  const handleOpenSessionLogs = async () => {
    await sessionLogService.openLogTab();
  };

  const handleHideUnselected = async () => {
    if (!activeTabId || !isGraphTab) return;
    
    // Dispatch event to GraphEditor to handle hide unselected
    window.dispatchEvent(new CustomEvent('dagnet:hideUnselected'));
  };

  const handleShowAll = async () => {
    if (!activeTabId || !isGraphTab) return;
    await operations.showAllNodes(activeTabId);
  };

  return (
    <Menubar.Menu>
      <Menubar.Trigger className="menubar-trigger">View</Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content className="menubar-content" align="start">
          {/* Open in New Tab submenu */}
          {activeTab && isInteractiveView && (
            <>
              <Menubar.Sub>
                <Menubar.SubTrigger className="menubar-item">
                  Open in New Tab
                  <div className="menubar-right-slot">›</div>
                </Menubar.SubTrigger>
                <Menubar.Portal>
                  <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleOpenInNewTab('raw-json')}
                    >
                      Open JSON View
                    </Menubar.Item>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleOpenInNewTab('raw-yaml')}
                    >
                      Open YAML View
                    </Menubar.Item>
                  </Menubar.SubContent>
                </Menubar.Portal>
              </Menubar.Sub>

              <Menubar.Separator className="menubar-separator" />
            </>
          )}

          {/* Graph-specific options */}
          {isGraphTab && isInteractiveView && (
            <>
              <Menubar.Sub>
                <Menubar.SubTrigger className="menubar-item">
                  Edge Scaling
                  <div className="menubar-right-slot">›</div>
                </Menubar.SubTrigger>
                <Menubar.Portal>
                  <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                    <EdgeScalingControl
                      className="compact"
                      useUniformScaling={useUniformScaling}
                      massGenerosity={massGenerosity}
                      onUniformScalingChange={handleToggleUniformScaling}
                      onMassGenerosityChange={handleSetMassGenerosity}
                    />
                  </Menubar.SubContent>
                </Menubar.Portal>
              </Menubar.Sub>

              <Menubar.Separator className="menubar-separator" />

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleReRoute}
              >
                Re-route
              </Menubar.Item>

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleToggleAutoReroute}
              >
                {autoReroute ? '✓ ' : ''}Auto Re-route
              </Menubar.Item>

              <Menubar.Separator className="menubar-separator" />

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleToggleSankeyView}
              >
                {useSankeyView ? '✓ ' : ''}Sankey View
              </Menubar.Item>

              <Menubar.Separator className="menubar-separator" />

              <Menubar.Sub>
                <Menubar.SubTrigger className="menubar-item">
                  Confidence Intervals
                  <div className="menubar-right-slot">›</div>
                </Menubar.SubTrigger>
                <Menubar.Portal>
                  <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleConfidenceIntervalChange('99')}
                    >
                      {confidenceIntervalLevel === '99' ? '✓ ' : ''}99%
                    </Menubar.Item>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleConfidenceIntervalChange('95')}
                    >
                      {confidenceIntervalLevel === '95' ? '✓ ' : ''}95%
                    </Menubar.Item>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleConfidenceIntervalChange('90')}
                    >
                      {confidenceIntervalLevel === '90' ? '✓ ' : ''}90%
                    </Menubar.Item>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleConfidenceIntervalChange('80')}
                    >
                      {confidenceIntervalLevel === '80' ? '✓ ' : ''}80%
                    </Menubar.Item>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleConfidenceIntervalChange('none')}
                    >
                      {confidenceIntervalLevel === 'none' ? '✓ ' : ''}None
                    </Menubar.Item>
                  </Menubar.SubContent>
                </Menubar.Portal>
              </Menubar.Sub>

              <Menubar.Separator className="menubar-separator" />

              <Menubar.Sub>
                <Menubar.SubTrigger className="menubar-item">
                  Auto Layout
                  <div className="menubar-right-slot">›</div>
                </Menubar.SubTrigger>
                <Menubar.Portal>
                  <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleAutoLayout('LR')}
                    >
                      Left-to-right
                    </Menubar.Item>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleAutoLayout('RL')}
                    >
                      Right-to-left
                    </Menubar.Item>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleAutoLayout('TB')}
                    >
                      Top-to-bottom
                    </Menubar.Item>
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleAutoLayout('BT')}
                    >
                      Bottom-to-top
                    </Menubar.Item>
                  </Menubar.SubContent>
                </Menubar.Portal>
              </Menubar.Sub>

              {/* Sankey Layout option - only show when Sankey view is active */}
              {useSankeyView && (
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={handleSankeyLayout}
                >
                  Sankey Layout
                </Menubar.Item>
              )}

              <Menubar.Separator className="menubar-separator" />

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleTogglePropertiesPanel}
              >
                Properties Panel
              </Menubar.Item>

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleToggleWhatIfPanel}
              >
                What-If Analysis
              </Menubar.Item>

              <Menubar.Separator className="menubar-separator" />

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleHideUnselected}
              >
                Hide unselected
              </Menubar.Item>

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleShowAll}
              >
                Show all
              </Menubar.Item>

              <Menubar.Separator className="menubar-separator" />
            </>
          )}

          {/* General view options */}
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleToggleNavigator}
          >
            Navigator
            <div className="menubar-right-slot">⌘B</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleOpenSessionLogs}
          >
            Session Logs
          </Menubar.Item>
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

