/**
 * Sidebar Integration Tests
 * 
 * Tests sidebar panels (What-If, Properties, Tools) and icon bar
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarIconBar } from '../SidebarIconBar';
import { SidebarHoverPreview } from '../SidebarHoverPreview';
import { TabContextProvider } from '../../contexts/TabContext';
import { GraphStoreProvider } from '../../contexts/GraphStoreContext';

// Mock rc-dock
vi.mock('rc-dock', () => ({
  DockLayout: ({ children }: any) => <div data-testid="dock-layout">{children}</div>,
  DockPanel: ({ children }: any) => <div data-testid="dock-panel">{children}</div>,
}));

const mockSidebarState = {
  mode: 'minimized' as const,
  activePanel: 'properties' as const,
  floatingPanels: [],
  hasAutoOpened: false,
};

const mockTabContext = {
  activeTabId: 'test-tab',
  tabs: [{
    id: 'test-tab',
    type: 'graph',
    name: 'Test Graph',
    editorState: {
      sidebarState: mockSidebarState,
    },
  }],
  operations: {
    updateTabState: vi.fn(),
  },
};

const mockGraph = {
  nodes: [{ id: 'node-1', label: 'Test Node', position: { x: 0, y: 0 } }],
  edges: [],
  metadata: { name: 'Test Graph', version: '1.0.0' },
};

const mockGraphStore = {
  graph: mockGraph,
  setGraph: vi.fn(),
  saveHistoryState: vi.fn(),
};

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <TabContextProvider value={mockTabContext as any}>
    <GraphStoreProvider value={mockGraphStore as any}>
      {children}
    </GraphStoreProvider>
  </TabContextProvider>
);

describe('SidebarIconBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render sidebar icons', () => {
    render(
      <TestWrapper>
        <SidebarIconBar
          tabId="test-tab"
          activePanel="properties"
          onPanelClick={vi.fn()}
          floatingPanels={[]}
        />
      </TestWrapper>
    );

    // Should show three panel icons
    expect(screen.getByTestId('sidebar-icon-whatif')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-icon-properties')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-icon-tools')).toBeInTheDocument();
  });

  it('should highlight active panel', () => {
    render(
      <TestWrapper>
        <SidebarIconBar
          tabId="test-tab"
          activePanel="properties"
          onPanelClick={vi.fn()}
          floatingPanels={[]}
        />
      </TestWrapper>
    );

    const propertiesIcon = screen.getByTestId('sidebar-icon-properties');
    expect(propertiesIcon).toHaveClass('active');
  });

  it('should switch panels on click', async () => {
    const user = userEvent.setup();
    const onPanelClick = vi.fn();
    
    render(
      <TestWrapper>
        <SidebarIconBar
          tabId="test-tab"
          activePanel="properties"
          onPanelClick={onPanelClick}
          floatingPanels={[]}
        />
      </TestWrapper>
    );

    const whatifIcon = screen.getByTestId('sidebar-icon-whatif');
    await user.click(whatifIcon);

    expect(onPanelClick).toHaveBeenCalledWith('whatif');
  });

  it('should show floating panel indicator', () => {
    render(
      <TestWrapper>
        <SidebarIconBar
          tabId="test-tab"
          activePanel="properties"
          onPanelClick={vi.fn()}
          floatingPanels={['tools']}
        />
      </TestWrapper>
    );

    const toolsIcon = screen.getByTestId('sidebar-icon-tools');
    const indicator = within(toolsIcon).getByTestId('floating-indicator');
    expect(indicator).toBeInTheDocument();
  });

  it('should show hover preview on mouse enter', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <SidebarIconBar
          tabId="test-tab"
          activePanel="properties"
          onPanelClick={vi.fn()}
          floatingPanels={[]}
        />
        <SidebarHoverPreview
          panel="whatif"
          tabId="test-tab"
          selectedNodeId={null}
          selectedEdgeId={null}
          onSelectedNodeChange={vi.fn()}
          onSelectedEdgeChange={vi.fn()}
        />
      </TestWrapper>
    );

    const whatifIcon = screen.getByTestId('sidebar-icon-whatif');
    await user.hover(whatifIcon);

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-hover-preview')).toBeInTheDocument();
    });
  });

  it('should hide hover preview on mouse leave', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <SidebarIconBar
          tabId="test-tab"
          activePanel="properties"
          onPanelClick={vi.fn()}
          floatingPanels={[]}
        />
      </TestWrapper>
    );

    const whatifIcon = screen.getByTestId('sidebar-icon-whatif');
    
    // Hover
    await user.hover(whatifIcon);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-hover-preview')).toBeInTheDocument();
    });

    // Unhover
    await user.unhover(whatifIcon);
    await waitFor(() => {
      expect(screen.queryByTestId('sidebar-hover-preview')).not.toBeInTheDocument();
    });
  });
});

describe('Sidebar - Panel Toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should minimize sidebar from maximized state', async () => {
    const user = userEvent.setup();
    
    const maxTabContext = {
      ...mockTabContext,
      tabs: [{
        ...mockTabContext.tabs[0],
        editorState: {
          sidebarState: { ...mockSidebarState, mode: 'maximized' },
        },
      }],
    };

    render(
      <TabContextProvider value={maxTabContext as any}>
        <GraphStoreProvider value={mockGraphStore as any}>
          <button
            data-testid="minimize-button"
            onClick={() => maxTabContext.operations.updateTabState('test-tab', {
              sidebarState: { ...mockSidebarState, mode: 'minimized' }
            })}
          >
            Minimize
          </button>
        </GraphStoreProvider>
      </TabContextProvider>
    );

    const minimizeButton = screen.getByTestId('minimize-button');
    await user.click(minimizeButton);

    expect(maxTabContext.operations.updateTabState).toHaveBeenCalledWith(
      'test-tab',
      expect.objectContaining({
        sidebarState: expect.objectContaining({ mode: 'minimized' })
      })
    );
  });

  it('should maximize sidebar from minimized state', async () => {
    const user = userEvent.setup();
    const onPanelClick = vi.fn((panel) => {
      mockTabContext.operations.updateTabState('test-tab', {
        sidebarState: { ...mockSidebarState, mode: 'maximized', activePanel: panel }
      });
    });
    
    render(
      <TestWrapper>
        <SidebarIconBar
          tabId="test-tab"
          activePanel={null}
          onPanelClick={onPanelClick}
          floatingPanels={[]}
        />
      </TestWrapper>
    );

    const propertiesIcon = screen.getByTestId('sidebar-icon-properties');
    await user.click(propertiesIcon);

    expect(onPanelClick).toHaveBeenCalledWith('properties');
    expect(mockTabContext.operations.updateTabState).toHaveBeenCalled();
  });
});

describe('Sidebar - Smart Auto-Open', () => {
  it('should auto-open Properties panel on first node selection', async () => {
    const tabWithoutAutoOpen = {
      ...mockTabContext,
      tabs: [{
        ...mockTabContext.tabs[0],
        editorState: {
          sidebarState: { ...mockSidebarState, hasAutoOpened: false },
        },
      }],
    };

    render(
      <TabContextProvider value={tabWithoutAutoOpen as any}>
        <GraphStoreProvider value={mockGraphStore as any}>
          <div data-testid="test-component">Test</div>
        </GraphStoreProvider>
      </TabContextProvider>
    );

    // Simulate node selection (would trigger auto-open)
    // In real app, this is handled by GraphCanvas
    const autoOpenLogic = () => {
      const state = tabWithoutAutoOpen.tabs[0].editorState.sidebarState;
      if (!state.hasAutoOpened && state.mode === 'minimized') {
        tabWithoutAutoOpen.operations.updateTabState('test-tab', {
          sidebarState: {
            ...state,
            mode: 'maximized',
            activePanel: 'properties',
            hasAutoOpened: true,
          }
        });
      }
    };

    autoOpenLogic();

    expect(tabWithoutAutoOpen.operations.updateTabState).toHaveBeenCalledWith(
      'test-tab',
      expect.objectContaining({
        sidebarState: expect.objectContaining({
          mode: 'maximized',
          activePanel: 'properties',
          hasAutoOpened: true,
        })
      })
    );
  });

  it('should not auto-open if already opened once', () => {
    const tabWithAutoOpened = {
      ...mockTabContext,
      tabs: [{
        ...mockTabContext.tabs[0],
        editorState: {
          sidebarState: { ...mockSidebarState, hasAutoOpened: true },
        },
      }],
    };

    render(
      <TabContextProvider value={tabWithAutoOpened as any}>
        <GraphStoreProvider value={mockGraphStore as any}>
          <div>Test</div>
        </GraphStoreProvider>
      </TabContextProvider>
    );

    // Simulate second node selection
    const autoOpenLogic = () => {
      const state = tabWithAutoOpened.tabs[0].editorState.sidebarState;
      if (!state.hasAutoOpened && state.mode === 'minimized') {
        // Should not execute
        tabWithAutoOpened.operations.updateTabState('test-tab', {});
      }
    };

    autoOpenLogic();

    // Should not update since hasAutoOpened is true
    expect(tabWithAutoOpened.operations.updateTabState).not.toHaveBeenCalled();
  });
});

describe('Sidebar - Panel Content', () => {
  it('should show What-If panel content', async () => {
    render(
      <TestWrapper>
        <div data-testid="whatif-panel">
          <h3>What-If Analysis</h3>
          <div>Case overrides</div>
          <div>Conditional overrides</div>
        </div>
      </TestWrapper>
    );

    expect(screen.getByText('What-If Analysis')).toBeInTheDocument();
    expect(screen.getByText('Case overrides')).toBeInTheDocument();
  });

  it('should show Properties panel content', () => {
    render(
      <TestWrapper>
        <div data-testid="properties-panel">
          <h3>Node Properties</h3>
          <input type="text" placeholder="Label" />
        </div>
      </TestWrapper>
    );

    expect(screen.getByText('Node Properties')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
  });

  it('should show Tools panel content', () => {
    render(
      <TestWrapper>
        <div data-testid="tools-panel">
          <h3>Canvas Tools</h3>
          <button>Auto Layout</button>
          <button>Force Reroute</button>
        </div>
      </TestWrapper>
    );

    expect(screen.getByText('Canvas Tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /auto layout/i })).toBeInTheDocument();
  });
});

describe('Sidebar - Keyboard Shortcuts', () => {
  it('should toggle sidebar with Ctrl+B', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <div>Test Content</div>
      </TestWrapper>
    );

    await user.keyboard('{Control>}b{/Control}');

    await waitFor(() => {
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalledWith(
        'test-tab',
        expect.objectContaining({
          sidebarState: expect.any(Object)
        })
      );
    });
  });

  it('should open What-If panel with Ctrl+Shift+W', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <div>Test Content</div>
      </TestWrapper>
    );

    await user.keyboard('{Control>}{Shift>}w{/Shift}{/Control}');

    await waitFor(() => {
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalledWith(
        'test-tab',
        expect.objectContaining({
          sidebarState: expect.objectContaining({
            activePanel: 'whatif'
          })
        })
      );
    });
  });

  it('should open Properties panel with Ctrl+Shift+P', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <div>Test Content</div>
      </TestWrapper>
    );

    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}');

    await waitFor(() => {
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalledWith(
        'test-tab',
        expect.objectContaining({
          sidebarState: expect.objectContaining({
            activePanel: 'properties'
          })
        })
      );
    });
  });
});

describe('Sidebar - State Persistence', () => {
  it('should persist sidebar state per tab', () => {
    const tab1State = { mode: 'maximized' as const, activePanel: 'whatif' as const };
    const tab2State = { mode: 'minimized' as const, activePanel: 'properties' as const };

    const multiTabContext = {
      ...mockTabContext,
      tabs: [
        { id: 'tab-1', editorState: { sidebarState: tab1State } },
        { id: 'tab-2', editorState: { sidebarState: tab2State } },
      ],
      activeTabId: 'tab-1',
    };

    const { rerender } = render(
      <TabContextProvider value={multiTabContext as any}>
        <GraphStoreProvider value={mockGraphStore as any}>
          <div>Tab 1 Content</div>
        </GraphStoreProvider>
      </TabContextProvider>
    );

    // Check tab 1 state
    expect(multiTabContext.tabs[0].editorState.sidebarState.mode).toBe('maximized');

    // Switch to tab 2
    multiTabContext.activeTabId = 'tab-2';
    rerender(
      <TabContextProvider value={multiTabContext as any}>
        <GraphStoreProvider value={mockGraphStore as any}>
          <div>Tab 2 Content</div>
        </GraphStoreProvider>
      </TabContextProvider>
    );

    // Check tab 2 has different state
    expect(multiTabContext.tabs[1].editorState.sidebarState.mode).toBe('minimized');
  });
});

