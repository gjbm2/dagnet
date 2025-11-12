/**
 * MenuBar Integration Tests
 * 
 * Tests top menu bar interactions (File, Edit, View, Objects, etc.)
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MenuBarComponent } from '../MenuBar/MenuBar';
import { TabContextProvider } from '../../contexts/TabContext';
import { NavigatorProvider } from '../../contexts/NavigatorContext';

// Mock Radix UI menubar
vi.mock('@radix-ui/react-menubar', () => ({
  Root: ({ children, ...props }: any) => <div role="menubar" {...props}>{children}</div>,
  Menu: ({ children }: any) => <div role="none">{children}</div>,
  Trigger: ({ children, ...props }: any) => (
    <button role="menuitem" {...props}>{children}</button>
  ),
  Portal: ({ children }: any) => <div>{children}</div>,
  Content: ({ children, ...props }: any) => (
    <div role="menu" {...props}>{children}</div>
  ),
  Item: ({ children, onSelect, ...props }: any) => (
    <button role="menuitem" onClick={onSelect} {...props}>{children}</button>
  ),
  Separator: () => <hr role="separator" />,
  Sub: ({ children }: any) => <div>{children}</div>,
  SubTrigger: ({ children, ...props }: any) => (
    <button role="menuitem" {...props}>{children}</button>
  ),
  SubContent: ({ children, ...props }: any) => (
    <div role="menu" {...props}>{children}</div>
  ),
}));

const mockTabContext = {
  activeTabId: 'test-tab',
  tabs: [{ id: 'test-tab', type: 'graph', name: 'Test Graph' }],
  operations: {
    openTab: vi.fn(),
    closeTab: vi.fn(),
    closeAllTabs: vi.fn(),
    closeOtherTabs: vi.fn(),
    duplicateTab: vi.fn(),
    updateTabState: vi.fn(),
  },
};

const mockNavigatorContext = {
  state: { items: [] },
  operations: {
    createItem: vi.fn(),
    deleteItem: vi.fn(),
    refreshItems: vi.fn(),
  },
  items: [],
  isLoading: false,
};

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <TabContextProvider value={mockTabContext as any}>
    <NavigatorProvider value={mockNavigatorContext as any}>
      {children}
    </NavigatorProvider>
  </TabContextProvider>
);

describe('MenuBar - File Menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render File menu', () => {
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    expect(screen.getByText('File')).toBeInTheDocument();
  });

  it('should open File menu on click', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const fileMenu = screen.getByText('File');
    await user.click(fileMenu);

    // Should show file menu items
    await waitFor(() => {
      expect(screen.getByText(/new/i)).toBeInTheDocument();
      expect(screen.getByText(/open/i)).toBeInTheDocument();
      expect(screen.getByText(/save/i)).toBeInTheDocument();
    });
  });

  it('should trigger New action', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const fileMenu = screen.getByText('File');
    await user.click(fileMenu);

    const newItem = screen.getByText(/^new$/i);
    await user.click(newItem);

    // Should show submenu or trigger action
    await waitFor(() => {
      expect(mockNavigatorContext.operations.createItem).toHaveBeenCalled();
    });
  });

  it('should trigger Save action', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const fileMenu = screen.getByText('File');
    await user.click(fileMenu);

    const saveItem = screen.getByText(/save/i);
    await user.click(saveItem);

    await waitFor(() => {
      // Check that save operation was triggered
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalled();
    });
  });

  it('should close tab via Close action', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const fileMenu = screen.getByText('File');
    await user.click(fileMenu);

    const closeItem = screen.getByText(/^close$/i);
    await user.click(closeItem);

    await waitFor(() => {
      expect(mockTabContext.operations.closeTab).toHaveBeenCalledWith('test-tab');
    });
  });
});

describe('MenuBar - Edit Menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render Edit menu', () => {
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('should show Edit menu items', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const editMenu = screen.getByText('Edit');
    await user.click(editMenu);

    await waitFor(() => {
      expect(screen.getByText(/undo/i)).toBeInTheDocument();
      expect(screen.getByText(/redo/i)).toBeInTheDocument();
      expect(screen.getByText(/cut/i)).toBeInTheDocument();
      expect(screen.getByText(/copy/i)).toBeInTheDocument();
      expect(screen.getByText(/paste/i)).toBeInTheDocument();
    });
  });
});

describe('MenuBar - View Menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should toggle sidebar visibility', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const viewMenu = screen.getByText('View');
    await user.click(viewMenu);

    const toggleSidebar = screen.getByText(/toggle sidebar/i);
    await user.click(toggleSidebar);

    await waitFor(() => {
      // Verify sidebar toggle was triggered
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalled();
    });
  });

  it('should change view mode', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const viewMenu = screen.getByText('View');
    await user.click(viewMenu);

    const splitView = screen.getByText(/split view/i);
    await user.click(splitView);

    await waitFor(() => {
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalled();
    });
  });

  it('should zoom in/out', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const viewMenu = screen.getByText('View');
    await user.click(viewMenu);

    const zoomIn = screen.getByText(/zoom in/i);
    await user.click(zoomIn);

    // Verify zoom action
    await waitFor(() => {
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalled();
    });
  });
});

describe('MenuBar - Objects Menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create new graph', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const objectsMenu = screen.getByText('Objects');
    await user.click(objectsMenu);

    const newGraph = screen.getByText(/new graph/i);
    await user.click(newGraph);

    await waitFor(() => {
      expect(mockNavigatorContext.operations.createItem).toHaveBeenCalledWith({
        type: 'graph',
        name: expect.any(String),
      });
    });
  });

  it('should create new parameter', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const objectsMenu = screen.getByText('Objects');
    await user.click(objectsMenu);

    const newParam = screen.getByText(/new parameter/i);
    await user.click(newParam);

    await waitFor(() => {
      expect(mockNavigatorContext.operations.createItem).toHaveBeenCalledWith({
        type: 'parameter',
        name: expect.any(String),
      });
    });
  });

  it('should create new node', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const objectsMenu = screen.getByText('Objects');
    await user.click(objectsMenu);

    const newNode = screen.getByText(/new node/i);
    await user.click(newNode);

    await waitFor(() => {
      expect(mockNavigatorContext.operations.createItem).toHaveBeenCalledWith({
        type: 'node',
        name: expect.any(String),
      });
    });
  });
});

describe('MenuBar - Repository Menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show repository options', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const repoMenu = screen.getByText('Repository');
    await user.click(repoMenu);

    await waitFor(() => {
      expect(screen.getByText(/commit/i)).toBeInTheDocument();
      expect(screen.getByText(/pull/i)).toBeInTheDocument();
      expect(screen.getByText(/push/i)).toBeInTheDocument();
    });
  });

  it('should trigger commit dialog', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const repoMenu = screen.getByText('Repository');
    await user.click(repoMenu);

    const commitItem = screen.getByText(/^commit$/i);
    await user.click(commitItem);

    // Should open commit modal
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});

describe('MenuBar - Help Menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show help options', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const helpMenu = screen.getByText('Help');
    await user.click(helpMenu);

    await waitFor(() => {
      expect(screen.getByText(/documentation/i)).toBeInTheDocument();
      expect(screen.getByText(/keyboard shortcuts/i)).toBeInTheDocument();
      expect(screen.getByText(/about/i)).toBeInTheDocument();
    });
  });

  it('should open documentation', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const helpMenu = screen.getByText('Help');
    await user.click(helpMenu);

    const docsItem = screen.getByText(/documentation/i);
    await user.click(docsItem);

    // Should open docs tab
    await waitFor(() => {
      expect(mockTabContext.operations.openTab).toHaveBeenCalled();
    });
  });
});

describe('MenuBar - Keyboard Shortcuts', () => {
  it('should trigger File > Save with Ctrl+S', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    // Simulate Ctrl+S
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => {
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalled();
    });
  });

  it('should trigger Edit > Undo with Ctrl+Z', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    // Simulate Ctrl+Z
    await user.keyboard('{Control>}z{/Control}');

    await waitFor(() => {
      // Verify undo was triggered
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalled();
    });
  });

  it('should trigger Edit > Redo with Ctrl+Shift+Z', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    // Simulate Ctrl+Shift+Z
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');

    await waitFor(() => {
      // Verify redo was triggered
      expect(mockTabContext.operations.updateTabState).toHaveBeenCalled();
    });
  });
});

describe('MenuBar - Context Sensitivity', () => {
  it('should show graph-specific options when graph tab active', () => {
    const graphTabContext = {
      ...mockTabContext,
      tabs: [{ id: 'test-tab', type: 'graph', name: 'Test Graph' }],
    };

    render(
      <TabContextProvider value={graphTabContext as any}>
        <NavigatorProvider value={mockNavigatorContext as any}>
          <MenuBarComponent />
        </NavigatorProvider>
      </TabContextProvider>
    );

    // Should show graph-related menu items
    expect(screen.getByText('Objects')).toBeInTheDocument();
  });

  it('should adapt menu when no tab active', () => {
    const noTabContext = {
      ...mockTabContext,
      activeTabId: null,
      tabs: [],
    };

    render(
      <TabContextProvider value={noTabContext as any}>
        <NavigatorProvider value={mockNavigatorContext as any}>
          <MenuBarComponent />
        </NavigatorProvider>
      </TabContextProvider>
    );

    // Core menus still visible
    expect(screen.getByText('File')).toBeInTheDocument();
    expect(screen.getByText('Help')).toBeInTheDocument();
  });
});

describe('MenuBar - Performance', () => {
  it('should open menus quickly', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    const startTime = performance.now();
    
    const fileMenu = screen.getByText('File');
    await user.click(fileMenu);

    const endTime = performance.now();
    const openTime = endTime - startTime;

    // Should open in less than 100ms
    expect(openTime).toBeLessThan(100);
  });

  it('should handle rapid menu switching', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <MenuBarComponent />
      </TestWrapper>
    );

    // Rapidly click through menus
    await user.click(screen.getByText('File'));
    await user.click(screen.getByText('Edit'));
    await user.click(screen.getByText('View'));
    await user.click(screen.getByText('Objects'));

    // Should complete without errors
    expect(screen.getByText('Objects')).toBeInTheDocument();
  });
});

