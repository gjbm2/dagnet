/**
 * PropertiesPanel Integration Tests
 * 
 * Tests property editing for graphs, nodes, and edges
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PropertiesPanel from '../PropertiesPanel';
import { GraphStoreProvider } from '../../contexts/GraphStoreContext';
import { TabContextProvider } from '../../contexts/TabContext';

// Mock contexts
const mockGraph = {
  nodes: [
    { 
      id: 'node-1', 
      label: 'Landing Page', 
      position: { x: 0, y: 0 },
      color: '#3B82F6',
      description: 'Initial landing page'
    }
  ],
  edges: [
    { 
      id: 'edge-1', 
      from: 'node-1', 
      to: 'node-2', 
      p: { mean: 0.75, stdev: 0.05 },
      label: 'Conversion'
    }
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
  tabs: [{ id: 'test-tab', type: 'graph', name: 'Test Graph', editorState: {} }],
  operations: {
    updateTabState: vi.fn(),
  }
};

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <GraphStoreProvider value={mockGraphStore as any}>
    <TabContextProvider value={mockTabContext as any}>
      {children}
    </TabContextProvider>
  </GraphStoreProvider>
);

describe('PropertiesPanel - Graph Properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphStore.graph = { ...mockGraph };
  });

  it('should display graph properties when nothing selected', () => {
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Should show graph-level properties
    expect(screen.getByText(/graph properties/i)).toBeInTheDocument();
  });

  it('should update graph metadata', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Find and update graph name input
    const nameInput = screen.getByRole('textbox', { name: /name/i });
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated Graph Name');

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
    });
  });
});

describe('PropertiesPanel - Node Properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphStore.graph = { ...mockGraph };
  });

  it('should display node properties when node selected', () => {
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId="node-1"
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Should show node-specific properties
    expect(screen.getByText(/node properties/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Landing Page')).toBeInTheDocument();
  });

  it('should update node label', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId="node-1"
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    const labelInput = screen.getByDisplayValue('Landing Page');
    await user.clear(labelInput);
    await user.type(labelInput, 'Updated Label');

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
      const lastCall = mockGraphStore.setGraph.mock.calls[mockGraphStore.setGraph.mock.calls.length - 1];
      const updatedGraph = lastCall[0];
      expect(updatedGraph.nodes[0].label).toBe('Updated Label');
    });
  });

  it('should update node color', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId="node-1"
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Look for color selector
    const colorButton = screen.getByTestId('color-selector-button');
    await user.click(colorButton);

    // Select a preset color
    const colorOption = screen.getByTestId('color-option-red');
    await user.click(colorOption);

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
    });
  });

  it('should update node description', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId="node-1"
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    const descInput = screen.getByRole('textbox', { name: /description/i });
    await user.clear(descInput);
    await user.type(descInput, 'New description');

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
    });
  });

  it('should handle rapid property changes without infinite loops', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId="node-1"
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    const labelInput = screen.getByDisplayValue('Landing Page');
    
    // Rapid changes
    await user.type(labelInput, 'abc');
    await user.type(labelInput, 'def');
    await user.type(labelInput, 'ghi');

    // Wait a bit to ensure no infinite loops
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have reasonable number of calls (not hundreds)
    expect(mockGraphStore.setGraph.mock.calls.length).toBeLessThan(20);
  });
});

describe('PropertiesPanel - Edge Properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphStore.graph = { ...mockGraph };
  });

  it('should display edge properties when edge selected', () => {
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId="edge-1"
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Should show edge-specific properties
    expect(screen.getByText(/edge properties/i)).toBeInTheDocument();
  });

  it('should update edge probability', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId="edge-1"
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Find probability slider/input
    const probInput = screen.getByRole('slider', { name: /mean/i });
    await user.clear(probInput);
    await user.type(probInput, '0.85');

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
    });
  });

  it('should update edge label', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId="edge-1"
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    const labelInput = screen.getByDisplayValue('Conversion');
    await user.clear(labelInput);
    await user.type(labelInput, 'Sign-Up');

    await waitFor(() => {
      expect(mockGraphStore.setGraph).toHaveBeenCalled();
    });
  });
});

describe('PropertiesPanel - Collapsible Sections', () => {
  it('should expand and collapse sections', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId="node-1"
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Find a collapsible section header
    const sectionHeader = screen.getByText(/basic information/i);
    
    // Should be expanded by default
    expect(sectionHeader).toBeVisible();
    
    // Click to collapse
    await user.click(sectionHeader);
    
    // Content should be hidden (accordion animation)
    await waitFor(() => {
      const content = sectionHeader.nextElementSibling;
      expect(content).toHaveStyle({ height: '0px' });
    });
  });
});

describe('PropertiesPanel - Context Integration', () => {
  it('should sync with graph store on selection change', async () => {
    const { rerender } = render(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId="node-1"
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId={null}
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Initially shows node-1 properties
    expect(screen.getByDisplayValue('Landing Page')).toBeInTheDocument();

    // Change selection to edge
    rerender(
      <TestWrapper>
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={vi.fn()}
          selectedEdgeId="edge-1"
          onSelectedEdgeChange={vi.fn()}
          tabId="test-tab"
        />
      </TestWrapper>
    );

    // Should now show edge properties
    await waitFor(() => {
      expect(screen.getByText(/edge properties/i)).toBeInTheDocument();
    });
  });
});

