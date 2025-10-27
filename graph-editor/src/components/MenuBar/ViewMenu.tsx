import React from 'react';
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
  const isGraphTab = activeTab?.fileId.startsWith('graph-');
  const isInteractiveView = activeTab?.viewMode === 'interactive';

  const handleOpenInNewTab = async (viewMode: 'raw-json' | 'raw-yaml') => {
    if (activeTabId) {
      await operations.openInNewView(activeTabId, viewMode);
    }
  };

  const handleToggleNavigator = () => {
    navOps.toggleNavigator();
  };

  // Graph-specific handlers
  const handleEdgeScaling = () => {
    console.log('Edge Scaling');
    // TODO: Dispatch to graph editor
  };

  const handleReRoute = () => {
    console.log('Re-route');
    // TODO: Dispatch to graph editor
  };

  const handleAutoLayout = (direction: string) => {
    console.log('Auto Layout:', direction);
    // TODO: Dispatch to graph editor
  };

  const handleTogglePropertiesPanel = () => {
    console.log('Toggle Properties Panel');
    // TODO: Dispatch to graph editor
  };

  const handleToggleWhatIfPanel = () => {
    console.log('Toggle What-If Analysis');
    // TODO: Dispatch to graph editor
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
              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleEdgeScaling}
              >
                Edge Scaling
              </Menubar.Item>

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleReRoute}
              >
                Re-route
              </Menubar.Item>

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

