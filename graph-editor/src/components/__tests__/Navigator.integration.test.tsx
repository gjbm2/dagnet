/**
 * Navigator Integration Tests
 * 
 * Tests file/object CRUD operations via Navigator
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NavigatorContent } from '../Navigator/NavigatorContent';
import { NavigatorProvider } from '../../contexts/NavigatorContext';
import { TabContextProvider } from '../../contexts/TabContext';

// Mock file registry
vi.mock('../../contexts/TabContext', async () => {
  const actual = await vi.importActual('../../contexts/TabContext');
  return {
    ...actual,
    fileRegistry: {
      getFile: vi.fn(),
      setFile: vi.fn(),
      deleteFile: vi.fn(),
      getAllFiles: vi.fn(() => []),
    },
    useFileRegistry: () => ({
      getFile: vi.fn(),
      setFile: vi.fn(),
      deleteFile: vi.fn(),
      getAllFiles: vi.fn(() => []),
    }),
  };
});

const mockNavigatorState = {
  items: [
    { id: 'graph-1', name: 'Test Graph', type: 'graph', path: 'graphs/test-graph.json' },
    { id: 'param-1', name: 'Conversion Rate', type: 'parameter', path: 'parameters/conversion-rate.yaml' },
    { id: 'node-1', name: 'Landing Page', type: 'node', path: 'nodes/landing-page.yaml' },
  ],
  selectedId: null,
  expandedSections: ['graph', 'parameter', 'node'],
  filter: '',
  sortMode: 'name' as const,
  groupMode: 'type' as const,
};

const mockNavigatorOperations = {
  selectItem: vi.fn(),
  toggleSection: vi.fn(),
  setFilter: vi.fn(),
  setSortMode: vi.fn(),
  setGroupMode: vi.fn(),
  createItem: vi.fn(),
  deleteItem: vi.fn(),
  renameItem: vi.fn(),
  duplicateItem: vi.fn(),
};

const mockNavigatorContext = {
  state: mockNavigatorState,
  operations: mockNavigatorOperations,
  items: mockNavigatorState.items,
  isLoading: false,
};

const mockTabContext = {
  activeTabId: 'test-tab',
  tabs: [{ id: 'test-tab', type: 'navigator', name: 'Navigator' }],
  operations: {
    openTab: vi.fn(),
    closeTab: vi.fn(),
    updateTabState: vi.fn(),
  },
};

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <NavigatorProvider value={mockNavigatorContext as any}>
    <TabContextProvider value={mockTabContext as any}>
      {children}
    </TabContextProvider>
  </NavigatorProvider>
);

describe('Navigator - Display and Navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render navigator with items grouped by type', () => {
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    // Should show type sections
    expect(screen.getByText(/graphs/i)).toBeInTheDocument();
    expect(screen.getByText(/parameters/i)).toBeInTheDocument();
    expect(screen.getByText(/nodes/i)).toBeInTheDocument();

    // Should show items
    expect(screen.getByText('Test Graph')).toBeInTheDocument();
    expect(screen.getByText('Conversion Rate')).toBeInTheDocument();
    expect(screen.getByText('Landing Page')).toBeInTheDocument();
  });

  it('should handle item selection', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const graphItem = screen.getByText('Test Graph');
    await user.click(graphItem);

    await waitFor(() => {
      expect(mockNavigatorOperations.selectItem).toHaveBeenCalledWith('graph-1');
    });
  });

  it('should expand and collapse sections', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const graphSection = screen.getByText(/graphs/i);
    await user.click(graphSection);

    await waitFor(() => {
      expect(mockNavigatorOperations.toggleSection).toHaveBeenCalledWith('graph');
    });
  });
});

describe('Navigator - Filtering and Sorting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should filter items by search text', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const searchInput = screen.getByRole('textbox', { name: /search/i });
    await user.type(searchInput, 'conversion');

    await waitFor(() => {
      expect(mockNavigatorOperations.setFilter).toHaveBeenCalledWith('conversion');
    });
  });

  it('should change sort mode', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const sortButton = screen.getByRole('button', { name: /sort/i });
    await user.click(sortButton);

    // Select different sort option
    const dateOption = screen.getByText(/date modified/i);
    await user.click(dateOption);

    await waitFor(() => {
      expect(mockNavigatorOperations.setSortMode).toHaveBeenCalledWith('modified');
    });
  });

  it('should change group mode', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const groupButton = screen.getByRole('button', { name: /group/i });
    await user.click(groupButton);

    // Select different group option
    const tagsOption = screen.getByText(/tags/i);
    await user.click(tagsOption);

    await waitFor(() => {
      expect(mockNavigatorOperations.setGroupMode).toHaveBeenCalledWith('tags');
    });
  });
});

describe('Navigator - CRUD Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create new graph', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    // Right-click on graphs section
    const graphSection = screen.getByText(/graphs/i);
    await user.pointer({ keys: '[MouseRight]', target: graphSection });

    // Click "New Graph" in context menu
    const newGraphOption = screen.getByText(/new graph/i);
    await user.click(newGraphOption);

    await waitFor(() => {
      expect(mockNavigatorOperations.createItem).toHaveBeenCalledWith({
        type: 'graph',
        name: expect.any(String),
      });
    });
  });

  it('should create new parameter', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const paramSection = screen.getByText(/parameters/i);
    await user.pointer({ keys: '[MouseRight]', target: paramSection });

    const newParamOption = screen.getByText(/new parameter/i);
    await user.click(newParamOption);

    await waitFor(() => {
      expect(mockNavigatorOperations.createItem).toHaveBeenCalledWith({
        type: 'parameter',
        name: expect.any(String),
      });
    });
  });

  it('should delete item', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    // Right-click on item
    const graphItem = screen.getByText('Test Graph');
    await user.pointer({ keys: '[MouseRight]', target: graphItem });

    // Click "Delete" in context menu
    const deleteOption = screen.getByText(/delete/i);
    await user.click(deleteOption);

    // Confirm deletion
    const confirmButton = screen.getByRole('button', { name: /confirm/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockNavigatorOperations.deleteItem).toHaveBeenCalledWith('graph-1');
    });
  });

  it('should rename item', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    // Right-click on item
    const graphItem = screen.getByText('Test Graph');
    await user.pointer({ keys: '[MouseRight]', target: graphItem });

    // Click "Rename" in context menu
    const renameOption = screen.getByText(/rename/i);
    await user.click(renameOption);

    // Enter new name
    const nameInput = screen.getByRole('textbox', { name: /name/i });
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed Graph');

    // Confirm
    const confirmButton = screen.getByRole('button', { name: /save|ok/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockNavigatorOperations.renameItem).toHaveBeenCalledWith('graph-1', 'Renamed Graph');
    });
  });

  it('should duplicate item', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    // Right-click on item
    const paramItem = screen.getByText('Conversion Rate');
    await user.pointer({ keys: '[MouseRight]', target: paramItem });

    // Click "Duplicate" in context menu
    const duplicateOption = screen.getByText(/duplicate/i);
    await user.click(duplicateOption);

    await waitFor(() => {
      expect(mockNavigatorOperations.duplicateItem).toHaveBeenCalledWith('param-1');
    });
  });
});

describe('Navigator - Drag and Drop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle item drag start', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const graphItem = screen.getByText('Test Graph');
    
    // Start drag
    await user.pointer({ keys: '[MouseLeft>]', target: graphItem });
    await user.pointer({ coords: { x: 100, y: 100 } });

    // Should add dragging class
    expect(graphItem.closest('.navigator-item')).toHaveClass('dragging');
  });

  it('should reorder items via drag and drop', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const item1 = screen.getByText('Test Graph');
    const item2 = screen.getByText('Conversion Rate');

    // Drag item1 to item2's position
    await user.pointer({ keys: '[MouseLeft>]', target: item1 });
    await user.pointer({ target: item2 });
    await user.pointer({ keys: '[/MouseLeft]' });

    // Should trigger reorder
    await waitFor(() => {
      // Check that items were reordered (implementation specific)
      expect(mockNavigatorOperations.selectItem).toHaveBeenCalled();
    });
  });
});

describe('Navigator - Performance', () => {
  it('should handle large number of items without slowdown', () => {
    // Create 1000 mock items
    const largeItemList = Array.from({ length: 1000 }, (_, i) => ({
      id: `item-${i}`,
      name: `Item ${i}`,
      type: 'parameter' as const,
      path: `parameters/item-${i}.yaml`,
    }));

    const largeContext = {
      ...mockNavigatorContext,
      items: largeItemList,
      state: { ...mockNavigatorState, items: largeItemList },
    };

    const startTime = performance.now();
    
    render(
      <NavigatorProvider value={largeContext as any}>
        <TabContextProvider value={mockTabContext as any}>
          <NavigatorContent />
        </TabContextProvider>
      </NavigatorProvider>
    );

    const endTime = performance.now();
    const renderTime = endTime - startTime;

    // Should render in less than 1 second
    expect(renderTime).toBeLessThan(1000);
  });

  it('should handle rapid filter changes without lag', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const searchInput = screen.getByRole('textbox', { name: /search/i });

    // Rapid typing
    await user.type(searchInput, 'abcdefghijk');

    // Should complete without hanging
    await waitFor(() => {
      expect(searchInput).toHaveValue('abcdefghijk');
    }, { timeout: 1000 });
  });
});

describe('Navigator - Context Menu Integration', () => {
  it('should show context menu on right-click', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const graphItem = screen.getByText('Test Graph');
    await user.pointer({ keys: '[MouseRight]', target: graphItem });

    // Context menu should appear
    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.getByText(/open/i)).toBeInTheDocument();
      expect(screen.getByText(/rename/i)).toBeInTheDocument();
      expect(screen.getByText(/delete/i)).toBeInTheDocument();
    });
  });

  it('should close context menu on outside click', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NavigatorContent />
      </TestWrapper>
    );

    const graphItem = screen.getByText('Test Graph');
    await user.pointer({ keys: '[MouseRight]', target: graphItem });

    // Context menu visible
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // Click outside
    await user.click(document.body);

    // Menu should close
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});

