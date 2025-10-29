import React, { useState, useEffect } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';

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
  
  // Get tab-specific state directly from tab
  const useUniformScaling = activeTab?.editorState?.useUniformScaling ?? false;
  const massGenerosity = activeTab?.editorState?.massGenerosity ?? 0.5;
  const autoReroute = activeTab?.editorState?.autoReroute ?? true;
  
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
  const handleToggleUniformScaling = () => {
    const newValue = !useUniformScaling;
    window.dispatchEvent(new CustomEvent('dagnet:setUniformScaling', { detail: { value: newValue } }));
  };

  const handleSetMassGenerosity = (value: number) => {
    window.dispatchEvent(new CustomEvent('dagnet:setMassGenerosity', { detail: { value } }));
  };

  const handleReRoute = () => {
    window.dispatchEvent(new CustomEvent('dagnet:forceReroute'));
  };

  const handleToggleAutoReroute = () => {
    const newValue = !autoReroute;
    window.dispatchEvent(new CustomEvent('dagnet:setAutoReroute', { detail: { value: newValue } }));
  };

  const handleAutoLayout = (direction: 'LR' | 'RL' | 'TB' | 'BT') => {
    window.dispatchEvent(new CustomEvent('dagnet:autoLayout', { detail: { direction } }));
  };

  const handleTogglePropertiesPanel = () => {
    // TODO: Implement sidebar panel toggles
    console.log('Toggle Properties Panel');
  };

  const handleToggleWhatIfPanel = () => {
    // TODO: Implement sidebar panel toggles
    console.log('Toggle What-If Analysis');
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
                    <div style={{ padding: '8px 12px' }}>
                      <label style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '8px',
                        cursor: 'pointer',
                        fontSize: '13px'
                      }}>
                        <input 
                          type="checkbox" 
                          checked={useUniformScaling} 
                          onChange={handleToggleUniformScaling}
                          style={{ cursor: 'pointer' }}
                        />
                        <span>Uniform</span>
                      </label>
                    </div>
                    
                    <div style={{ borderTop: '1px solid #e9ecef', margin: '4px 0' }} />
                    
                    <div style={{ padding: '8px 12px' }}>
                      <div style={{ 
                        marginBottom: '6px',
                        fontSize: '12px',
                        color: '#666',
                        display: 'flex',
                        justifyContent: 'space-between'
                      }}>
                        <span>Global</span>
                        <span>Local</span>
                      </div>
                      <input 
                        type="range" 
                        min="0" 
                        max="1" 
                        step="0.1"
                        value={massGenerosity}
                        onChange={(e) => handleSetMassGenerosity(parseFloat(e.target.value))}
                        disabled={useUniformScaling}
                        style={{ 
                          width: '100%',
                          cursor: useUniformScaling ? 'not-allowed' : 'pointer',
                          opacity: useUniformScaling ? 0.5 : 1
                        }}
                      />
                      <div style={{
                        fontSize: '11px',
                        color: '#999',
                        textAlign: 'center',
                        marginTop: '4px'
                      }}>
                        {(massGenerosity * 100).toFixed(0)}%
                      </div>
                    </div>
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
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

