import React, { useState, useEffect } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import EdgeScalingControl from '../EdgeScalingControl';
import { useViewPreferencesContext } from '../../contexts/ViewPreferencesContext';
import { useSankeyView } from '../../hooks/useSankeyView';
import { useBeadDisplayMode } from '../../hooks/useDataValuesView';
import { useNodeImageView } from '../../hooks/useNodeImageView';
import { useDashboardMode } from '../../hooks/useDashboardMode';
import { useViewOverlayMode } from '../../hooks/useViewOverlayMode';
import { useProjectionMode } from '../../contexts/ProjectionModeContext';
import { useTheme } from '../../contexts/ThemeContext';
import { sessionLogService } from '../../services/sessionLogService';
import { graphIssuesService } from '../../services/graphIssuesService';

/**
 * View Menu
 * 
 * Context-sensitive based on active tab type:
 * - Graph tabs: Show graph-specific options (Edge Scaling, view toggles, etc.)
 * - Other tabs: Show general view options
 * - All tabs: Open in New Tab (JSON/YAML views)
 */
export function ViewMenu() {
  const { activeTabId, tabs, operations } = useTabContext();
  const { operations: navOps } = useNavigatorContext();
  const { isDashboardMode, toggleDashboardMode } = useDashboardMode();
  const { isProjectionMode, toggleProjectionMode } = useProjectionMode();
  const { theme, toggleTheme } = useTheme();
  
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isGraphTab = activeTab?.fileId.startsWith('graph-') ?? false;
  const isInteractiveView = activeTab?.viewMode === 'interactive';
  
  // View preferences from context (per-tab, instant updates)
  // ViewMenu is at app shell level, so context may not be available when no graph tab is active
  const viewPrefsCtx = useViewPreferencesContext();
  
  // Fallback: read from active tab state when context not available
  const useUniformScaling = viewPrefsCtx?.useUniformScaling ?? (activeTab?.editorState?.useUniformScaling ?? false);
  const massGenerosity = viewPrefsCtx?.massGenerosity ?? (activeTab?.editorState?.massGenerosity ?? 0.5);
  const snapToGuides = viewPrefsCtx?.snapToGuides ?? (activeTab?.editorState?.snapToGuides ?? true);
  const confidenceIntervalLevel = viewPrefsCtx?.confidenceIntervalLevel ?? (activeTab?.editorState?.confidenceIntervalLevel as 'none' | '80' | '90' | '95' | '99' ?? 'none');
  const animateFlow = viewPrefsCtx?.animateFlow ?? (activeTab?.editorState?.animateFlow ?? true);
  
  // Use centralised hooks for view toggles
  const { useSankeyView: isSankeyView, toggleSankeyView } = useSankeyView();
  const { beadDisplayMode, setBeadDisplayMode } = useBeadDisplayMode();
  const { showNodeImages, toggleNodeImageView } = useNodeImageView();
  const { isForecastQuality, toggleForecastQuality, isDataDepth, toggleDataDepth } = useViewOverlayMode();
  
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

  const handleToggleDashboardMode = () => {
    toggleDashboardMode({ updateUrl: true });
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

  const handleToggleSnapToGuides = () => {
    const newValue = !snapToGuides;
    if (viewPrefsCtx) {
      viewPrefsCtx.setSnapToGuides(newValue);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { snapToGuides: newValue });
    }
  };

  const handleConfidenceIntervalChange = (level: 'none' | '80' | '90' | '95' | '99') => {
    if (viewPrefsCtx) {
      viewPrefsCtx.setConfidenceIntervalLevel(level);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { confidenceIntervalLevel: level });
    }
  };

  const handleToggleAnimateFlow = () => {
    const newValue = !animateFlow;
    if (viewPrefsCtx) {
      viewPrefsCtx.setAnimateFlow(newValue);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { animateFlow: newValue });
    }
  };

  const handleSankeyLayout = () => {
    window.dispatchEvent(new CustomEvent('dagnet:sankeyLayout'));
  };

  const handleOpenSessionLogs = async () => {
    await sessionLogService.openLogTab();
  };

  const handleOpenGraphIssues = async () => {
    await graphIssuesService.openIssuesTab();
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

              <Menubar.CheckboxItem
                className="menubar-item menubar-item--checkable"
                checked={snapToGuides}
                onCheckedChange={handleToggleSnapToGuides}
              >
                <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                Snap to Guides
              </Menubar.CheckboxItem>

              <Menubar.CheckboxItem
                className="menubar-item menubar-item--checkable"
                checked={isSankeyView}
                onCheckedChange={toggleSankeyView}
              >
                <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                Sankey View
              </Menubar.CheckboxItem>

              <Menubar.CheckboxItem
                className="menubar-item menubar-item--checkable"
                checked={beadDisplayMode === 'data-values'}
                onCheckedChange={() => setBeadDisplayMode(beadDisplayMode === 'data-values' ? 'edge-rate' : 'data-values')}
              >
                <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                Data Values
              </Menubar.CheckboxItem>

              <Menubar.CheckboxItem
                className="menubar-item menubar-item--checkable"
                checked={beadDisplayMode === 'path-rate'}
                onCheckedChange={() => setBeadDisplayMode(beadDisplayMode === 'path-rate' ? 'edge-rate' : 'path-rate')}
              >
                <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                Path View
              </Menubar.CheckboxItem>

              <Menubar.CheckboxItem
                className="menubar-item menubar-item--checkable"
                checked={animateFlow}
                onCheckedChange={handleToggleAnimateFlow}
              >
                <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                Animate Flow
              </Menubar.CheckboxItem>

              <Menubar.CheckboxItem
                className="menubar-item menubar-item--checkable"
                checked={showNodeImages}
                onCheckedChange={toggleNodeImageView}
              >
                <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                Show Node Images
              </Menubar.CheckboxItem>

              <Menubar.Separator className="menubar-separator" />

              <Menubar.Sub>
                <Menubar.SubTrigger className="menubar-item">
                  Confidence Intervals
                  <div className="menubar-right-slot">›</div>
                </Menubar.SubTrigger>
                <Menubar.Portal>
                  <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                    <Menubar.RadioGroup value={confidenceIntervalLevel} onValueChange={(v) => handleConfidenceIntervalChange(v as 'none' | '80' | '90' | '95' | '99')}>
                      <Menubar.RadioItem className="menubar-item menubar-item--checkable" value="99">
                        <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                        99%
                      </Menubar.RadioItem>
                      <Menubar.RadioItem className="menubar-item menubar-item--checkable" value="95">
                        <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                        95%
                      </Menubar.RadioItem>
                      <Menubar.RadioItem className="menubar-item menubar-item--checkable" value="90">
                        <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                        90%
                      </Menubar.RadioItem>
                      <Menubar.RadioItem className="menubar-item menubar-item--checkable" value="80">
                        <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                        80%
                      </Menubar.RadioItem>
                      <Menubar.RadioItem className="menubar-item menubar-item--checkable" value="none">
                        <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                        None
                      </Menubar.RadioItem>
                    </Menubar.RadioGroup>
                  </Menubar.SubContent>
                </Menubar.Portal>
              </Menubar.Sub>

              <Menubar.Separator className="menubar-separator" />

              <Menubar.CheckboxItem
                className="menubar-item menubar-item--checkable"
                checked={isForecastQuality}
                onCheckedChange={toggleForecastQuality}
              >
                <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                Forecast Quality
              </Menubar.CheckboxItem>

              <Menubar.CheckboxItem
                className="menubar-item menubar-item--checkable"
                checked={isDataDepth}
                onCheckedChange={toggleDataDepth}
              >
                <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
                Data Depth
              </Menubar.CheckboxItem>

              {/* Sankey Layout option - only show when Sankey view is active */}
              {isSankeyView && (
                <>
                  <Menubar.Separator className="menubar-separator" />
                  <Menubar.Item
                    className="menubar-item"
                    onSelect={handleSankeyLayout}
                  >
                    Sankey Layout
                  </Menubar.Item>
                </>
              )}

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

              <Menubar.Sub>
                <Menubar.SubTrigger className="menubar-item">
                  Views
                  <div className="menubar-right-slot">›</div>
                </Menubar.SubTrigger>
                <Menubar.Portal>
                  <Menubar.SubContent className="menubar-content" sideOffset={4}>
                    {(() => {
                      const graphData = activeTab ? fileRegistry.getFile(activeTab.fileId)?.data : null;
                      const canvasViews = (graphData as any)?.canvasViews ?? [];
                      const activeViewId = activeTab?.editorState?.activeCanvasViewId ?? null;
                      return (
                        <>
                          {canvasViews.map((v: any) => (
                            <Menubar.Item
                              key={v.id}
                              className="menubar-item"
                              onSelect={() => window.dispatchEvent(new CustomEvent('dagnet:applyCanvasView', { detail: { viewId: v.id } }))}
                            >
                              {v.id === activeViewId ? '✓ ' : '   '}{v.name}
                            </Menubar.Item>
                          ))}
                          <Menubar.Item
                            className="menubar-item"
                            onSelect={() => window.dispatchEvent(new CustomEvent('dagnet:createCanvasView', { detail: { name: `View ${canvasViews.length + 1}` } }))}
                          >
                            New view
                          </Menubar.Item>
                          <Menubar.Separator className="menubar-separator" />
                          <Menubar.Item
                            className="menubar-item"
                            onSelect={() => window.dispatchEvent(new CustomEvent('dagnet:restoreAll', { detail: { clearView: true } }))}
                          >
                            Expand all
                          </Menubar.Item>
                          <Menubar.Item
                            className="menubar-item"
                            onSelect={() => window.dispatchEvent(new CustomEvent('dagnet:minimiseAll', { detail: { clearView: true } }))}
                          >
                            Shrink all
                          </Menubar.Item>
                        </>
                      );
                    })()}
                  </Menubar.SubContent>
                </Menubar.Portal>
              </Menubar.Sub>

              <Menubar.Separator className="menubar-separator" />
            </>
          )}

          {/* General view options */}
          <Menubar.CheckboxItem
            className="menubar-item menubar-item--checkable"
            checked={isDashboardMode}
            onCheckedChange={handleToggleDashboardMode}
          >
            <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
            Dashboard mode
          </Menubar.CheckboxItem>

          <Menubar.CheckboxItem
            className="menubar-item menubar-item--checkable"
            checked={isProjectionMode}
            onCheckedChange={() => toggleProjectionMode({ updateUrl: true })}
          >
            <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
            Projection view
          </Menubar.CheckboxItem>

          <Menubar.CheckboxItem
            className="menubar-item menubar-item--checkable"
            checked={theme === 'dark'}
            onCheckedChange={toggleTheme}
          >
            <Menubar.ItemIndicator className="menubar-item-indicator">✓</Menubar.ItemIndicator>
            Dark mode
          </Menubar.CheckboxItem>

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

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleOpenGraphIssues}
          >
            Graph Issues
          </Menubar.Item>
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

