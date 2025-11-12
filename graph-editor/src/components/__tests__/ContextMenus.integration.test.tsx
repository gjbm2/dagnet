/**
 * Context Menu Integration Tests
 * 
 * Tests right-click context menus for nodes, edges, and navigator items
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeContextMenu } from '../NodeContextMenu';
import { EdgeContextMenu } from '../EdgeContextMenu';
import { NavigatorItemContextMenu } from '../NavigatorItemContextMenu';
import { GraphStoreProvider } from '../../contexts/GraphStoreContext';
import { TabContextProvider } from '../../contexts/TabContext';

const mockGraph = {
  nodes: [
    { id: 'node-1', label: 'Landing Page', position: { x: 0, y: 0 } },
    { id: 'node-2', label: 'Sign Up', position: { x: 100, y: 100 } }
  ],
  edges: [
    { id: 'edge-1', from: 'node-1', to: 'node-2', p: { mean: 0.75 } }
  ],
  metadata: { name: 'Test Graph', version: '1.0.0' }
};

const mockGraphStore = {
  graph: mockGraph,
  setGraph: vi.fn(),
  saveHistoryState: vi.fn(),
};

const mockTabContext = {
  activeTabId: 'test-tab',
  tabs: [{ id: 'test-tab', type: 'graph', name: 'Test Graph' }],
  operations: {
    openTab: vi.fn(),
    closeTab: vi.fn(),
  },
};

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <GraphStoreProvider value={mockGraphStore as any}>
    <TabContextProvider value={mockTabContext as any}>
      {children}
    </TabContextProvider>
  </GraphStoreProvider>
);

describe('NodeContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphStore.graph = { ...mockGraph };
  });

  it('should render node context menu on right-click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    // Should show menu options
    expect(screen.getByText(/edit properties/i)).toBeInTheDocument();
    expect(screen.getByText(/delete/i)).toBeInTheDocument();
    expect(screen.getByText(/duplicate/i)).toBeInTheDocument();
  });

  it('should delete node via context menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const deleteOption = screen.getByText(/delete/i);
    await user.click(deleteOption);

    // Confirm deletion
    const confirmButton = screen.getByRole('button', { name: /confirm|yes|delete/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
      const updatedGraph = mockGraphStore.setGraph.mock.calls[0][0];
      expect(updatedGraph.nodes).not.toContainEqual(
        expect.objectContaining({ id: 'node-1' })
      );
    });
  });

  it('should duplicate node via context menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const duplicateOption = screen.getByText(/duplicate/i);
    await user.click(duplicateOption);

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
      const updatedGraph = mockGraphStore.setGraph.mock.calls[0][0];
      // Should have 3 nodes (original 2 + duplicate)
      expect(updatedGraph.nodes.length).toBe(3);
    });
  });

  it('should set node color via context menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const colorOption = screen.getByText(/change color/i);
    await user.click(colorOption);

    // Select a color
    const redColor = screen.getByTestId('color-red');
    await user.click(redColor);

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
      const updatedGraph = mockGraphStore.setGraph.mock.calls[0][0];
      expect(updatedGraph.nodes[0].color).toBe('#EF4444');
    });
  });

  it('should rename node via context menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const renameOption = screen.getByText(/rename/i);
    await user.click(renameOption);

    // Enter new name
    const nameInput = screen.getByRole('textbox');
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated Name');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
      const updatedGraph = mockGraphStore.setGraph.mock.calls[0][0];
      expect(updatedGraph.nodes[0].label).toBe('Updated Name');
    });
  });

  it('should close menu on outside click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    // Click outside the menu
    await user.click(document.body);

    expect(onClose).toHaveBeenCalled();
  });
});

describe('EdgeContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphStore.graph = { ...mockGraph };
  });

  it('should render edge context menu', () => {
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <EdgeContextMenu
          edgeId="edge-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    expect(screen.getByText(/edit properties/i)).toBeInTheDocument();
    expect(screen.getByText(/delete/i)).toBeInTheDocument();
  });

  it('should delete edge via context menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <EdgeContextMenu
          edgeId="edge-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const deleteOption = screen.getByText(/delete/i);
    await user.click(deleteOption);

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
      const updatedGraph = mockGraphStore.setGraph.mock.calls[0][0];
      expect(updatedGraph.edges).toHaveLength(0);
    });
  });

  it('should reverse edge direction via context menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <EdgeContextMenu
          edgeId="edge-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const reverseOption = screen.getByText(/reverse direction/i);
    await user.click(reverseOption);

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
      const updatedGraph = mockGraphStore.setGraph.mock.calls[0][0];
      expect(updatedGraph.edges[0].from).toBe('node-2');
      expect(updatedGraph.edges[0].to).toBe('node-1');
    });
  });

  it('should add conditional probability via context menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <EdgeContextMenu
          edgeId="edge-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const addCondition = screen.getByText(/add condition/i);
    await user.click(addCondition);

    // Should open conditional probability editor
    await waitFor(() => {
      expect(screen.getByText(/conditional probability/i)).toBeInTheDocument();
    });
  });
});

describe('NavigatorItemContextMenu', () => {
  const mockItem = {
    id: 'graph-1',
    name: 'Test Graph',
    type: 'graph' as const,
    path: 'graphs/test-graph.json',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render navigator item context menu', () => {
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NavigatorItemContextMenu
          item={mockItem}
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    expect(screen.getByText(/open/i)).toBeInTheDocument();
    expect(screen.getByText(/rename/i)).toBeInTheDocument();
    expect(screen.getByText(/delete/i)).toBeInTheDocument();
  });

  it('should open item in new tab', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NavigatorItemContextMenu
          item={mockItem}
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const openOption = screen.getByText(/^open$/i);
    await user.click(openOption);

    await waitFor(() => {
      expect(mockTabContext.operations.openTab).toHaveBeenCalledWith({
        type: 'graph',
        name: 'Test Graph',
        fileId: 'graph-1',
      });
    });
  });

  it('should rename item', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NavigatorItemContextMenu
          item={mockItem}
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const renameOption = screen.getByText(/rename/i);
    await user.click(renameOption);

    const nameInput = screen.getByRole('textbox');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed Graph');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      // Verify rename operation was called
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('should delete item with confirmation', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NavigatorItemContextMenu
          item={mockItem}
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const deleteOption = screen.getByText(/^delete$/i);
    await user.click(deleteOption);

    // Should show confirmation dialog
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: /confirm|yes|delete/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('should duplicate item', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NavigatorItemContextMenu
          item={mockItem}
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const duplicateOption = screen.getByText(/duplicate/i);
    await user.click(duplicateOption);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('should show properties dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NavigatorItemContextMenu
          item={mockItem}
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const propertiesOption = screen.getByText(/properties/i);
    await user.click(propertiesOption);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});

describe('Context Menu - Positioning', () => {
  it('should position menu at cursor location', () => {
    const onClose = vi.fn();
    
    const { container } = render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={150}
          y={200}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const menu = container.querySelector('.context-menu');
    expect(menu).toHaveStyle({
      left: '150px',
      top: '200px',
    });
  });

  it('should adjust position to stay within viewport', () => {
    const onClose = vi.fn();
    
    // Position near right edge
    const { container } = render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={window.innerWidth - 50}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    const menu = container.querySelector('.context-menu');
    const menuRect = menu?.getBoundingClientRect();
    
    // Menu should not overflow viewport
    expect(menuRect?.right).toBeLessThanOrEqual(window.innerWidth);
  });
});

describe('Context Menu - Keyboard Navigation', () => {
  it('should navigate menu items with arrow keys', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    // Press down arrow
    await user.keyboard('{ArrowDown}');

    // First item should be focused
    const firstItem = screen.getByText(/edit properties/i);
    expect(firstItem).toHaveFocus();

    // Press down again
    await user.keyboard('{ArrowDown}');

    // Second item should be focused
    const secondItem = screen.getByText(/delete/i);
    expect(secondItem).toHaveFocus();
  });

  it('should close menu with Escape key', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('should activate item with Enter key', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    
    render(
      <TestWrapper>
        <NodeContextMenu
          nodeId="node-1"
          x={100}
          y={100}
          onClose={onClose}
        />
      </TestWrapper>
    );

    // Navigate to delete option
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Enter}');

    // Should trigger delete action
    await waitFor(() => {
      expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    });
  });
});

