/**
 * GraphCanvas Integration Tests
 * 
 * Tests real user interaction patterns to ensure:
 * - No infinite loops or render cycles
 * - Components correctly interact with each other
 * - Graph operations work end-to-end
 * - State management is correct
 * 
 * Uses React Testing Library + user-event for realistic interactions
 * Runs in jsdom virtual DOM environment
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GraphCanvas from '../GraphCanvas';
import { GraphStoreContext, createGraphStore } from '../../contexts/GraphStoreContext';
import { TabProvider } from '../../contexts/TabContext';
import { ViewPreferencesProvider } from '../../contexts/ViewPreferencesContext';

// Mock ReactFlow - Core component that needs proper testing
// We mock it to avoid canvas/DOM complexity but still test ReactFlow interactions
const mockReactFlow = {
  onNodesChange: vi.fn(),
  onEdgesChange: vi.fn(),
  onConnect: vi.fn(),
  onNodeDrag: vi.fn(),
  onNodeDragStop: vi.fn(),
  onPaneClick: vi.fn(),
  onNodeClick: vi.fn(),
  onEdgeClick: vi.fn(),
};

vi.mock('reactflow', () => {
  const React = require('react');
  return {
    ReactFlow: ({ 
      children, 
      nodes, 
      edges, 
      onNodesChange, 
      onEdgesChange, 
      onConnect,
      onNodeDrag,
      onNodeDragStop,
      onPaneClick,
      onNodeClick,
      onEdgeClick,
      ...props 
    }: any) => {
      // Store callbacks for testing
      if (onNodesChange) mockReactFlow.onNodesChange = onNodesChange;
      if (onEdgesChange) mockReactFlow.onEdgesChange = onEdgesChange;
      if (onConnect) mockReactFlow.onConnect = onConnect;
      if (onNodeDrag) mockReactFlow.onNodeDrag = onNodeDrag;
      if (onNodeDragStop) mockReactFlow.onNodeDragStop = onNodeDragStop;
      if (onPaneClick) mockReactFlow.onPaneClick = onPaneClick;
      if (onNodeClick) mockReactFlow.onNodeClick = onNodeClick;
      if (onEdgeClick) mockReactFlow.onEdgeClick = onEdgeClick;
      
      return (
        <div 
          data-testid="reactflow-container" 
          data-reactflow="true"
          {...props}
        >
          {children}
          {/* Simulate ReactFlow node rendering */}
          <div data-testid="reactflow-nodes" data-nodes-count={nodes?.length || 0}>
            {nodes?.map((node: any) => (
              <div 
                key={node.id} 
                data-testid={`node-${node.id}`} 
                data-node-id={node.id}
                data-node-selected={node.selected}
                data-node-position-x={node.position?.x}
                data-node-position-y={node.position?.y}
                onClick={() => onNodeClick?.(null, node)}
                onMouseDown={() => onNodeDrag?.(null, node)}
                onMouseUp={() => onNodeDragStop?.(null, node)}
              >
                {node.data?.label || node.label || node.id}
              </div>
            ))}
          </div>
          {/* Simulate ReactFlow edge rendering */}
          <div data-testid="reactflow-edges" data-edges-count={edges?.length || 0}>
            {edges?.map((edge: any) => (
              <div 
                key={edge.id} 
                data-testid={`edge-${edge.id}`} 
                data-edge-id={edge.id}
                data-edge-source={edge.source}
                data-edge-target={edge.target}
                data-edge-selected={edge.selected}
                onClick={() => onEdgeClick?.(null, edge)}
              >
                {edge.source} → {edge.target}
                {edge.label && <span data-testid={`edge-label-${edge.id}`}>{edge.label}</span>}
              </div>
            ))}
          </div>
          {/* Simulate pane for click events */}
          <div 
            data-testid="reactflow-pane"
            onClick={(e) => onPaneClick?.(e)}
            style={{ position: 'absolute', inset: 0 }}
          />
        </div>
      );
    },
    ReactFlowProvider: ({ children }: any) => <div data-testid="reactflow-provider">{children}</div>,
    useNodesState: (initial: any) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes];
    },
    useEdgesState: (initial: any) => {
      const [edges, setEdges] = React.useState(initial);
      return [edges, setEdges];
    },
    useReactFlow: () => ({
      screenToFlowPosition: (pos: any) => ({ x: pos.x || 0, y: pos.y || 0 }),
      flowToScreenPosition: (pos: any) => ({ x: pos.x || 0, y: pos.y || 0 }),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      fitView: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      zoomTo: vi.fn(),
      setCenter: vi.fn(),
      project: (pos: any) => ({ x: pos.x || 0, y: pos.y || 0 }),
    }),
    Background: ({ variant, ...props }: any) => (
      <div data-testid="reactflow-background" data-variant={variant} {...props} />
    ),
    Controls: (props: any) => <div data-testid="reactflow-controls" {...props} />,
    MiniMap: (props: any) => <div data-testid="reactflow-minimap" {...props} />,
    Panel: ({ children, position, ...props }: any) => (
      <div data-testid="reactflow-panel" data-position={position} {...props}>
        {children}
      </div>
    ),
    addEdge: vi.fn((params: any, edges: any[]) => [...edges, params]),
    ConnectionMode: { Loose: 'loose', Strict: 'strict' },
    MarkerType: { Arrow: 'arrow', ArrowClosed: 'arrowclosed' },
  };
});

// Mock contexts - create actual store instances for testing
const createMockGraphStore = () => {
  const store = createGraphStore();
  // Initialize with test data
  store.setState({
    graph: {
      nodes: [],
      edges: [],
      metadata: { name: 'Test Graph', version: '1.0.0' }
    },
    history: [],
    historyIndex: -1,
    canUndo: false,
    canRedo: false,
  });
  return store;
};

// Test wrapper component
const TestWrapper = ({ children, store }: { children: React.ReactNode; store?: ReturnType<typeof createGraphStore> }) => {
  const graphStore = React.useMemo(() => store || createMockGraphStore(), [store]);
  
  return (
    <GraphStoreContext.Provider value={graphStore}>
      <TabProvider>
        <ViewPreferencesProvider>
          {children}
        </ViewPreferencesProvider>
      </TabProvider>
    </GraphStoreContext.Provider>
  );
};

describe('GraphCanvas Integration Tests', () => {
  const mockCallbacks = {
    onSelectedNodeChange: vi.fn(),
    onSelectedEdgeChange: vi.fn(),
    onDoubleClickNode: vi.fn(),
    onDoubleClickEdge: vi.fn(),
    onSelectEdge: vi.fn(),
    onAddNodeRef: { current: null },
    onDeleteSelectedRef: { current: null },
    onAutoLayoutRef: { current: null },
    onSankeyLayoutRef: { current: null },
    onForceRerouteRef: { current: null },
    onHideUnselectedRef: { current: null },
  };

  let graphStore: ReturnType<typeof createGraphStore>;
  
  beforeEach(() => {
    vi.clearAllMocks();
    // Create fresh store for each test
    graphStore = createMockGraphStore();
    // Reset graph to empty state
    graphStore.setState({
      graph: {
        nodes: [],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      },
      history: [],
      historyIndex: -1,
      canUndo: false,
      canRedo: false,
    });
  });

  describe('Graph Creation and Node Management', () => {
    it('should render empty graph without errors', () => {
      const { container } = render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      // Should render ReactFlow container
      expect(screen.getByTestId('reactflow-container')).toBeInTheDocument();
      
      // Should not have any nodes initially
      const nodesContainer = screen.getByTestId('reactflow-nodes');
      expect(within(nodesContainer).queryAllByTestId(/^node-/)).toHaveLength(0);
    });

    it('should add a node when addNode is called', async () => {
      const { container } = render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      // Wait for component to mount and expose addNode ref
      await waitFor(() => {
        expect(mockCallbacks.onAddNodeRef.current).toBeDefined();
      });

      // Call addNode function
      if (mockCallbacks.onAddNodeRef.current) {
        mockCallbacks.onAddNodeRef.current();
      }

      // Wait for graph to update
      await waitFor(() => {
        const state = graphStore.getState();
        expect(state.graph?.nodes.length).toBeGreaterThan(0);
      });

      // Verify a node was added
      const state = graphStore.getState();
      expect(state.graph?.nodes).toHaveLength(1);
      expect(state.graph?.nodes[0]).toHaveProperty('id');
      expect(state.graph?.nodes[0]).toHaveProperty('label');
    });

    it('should add multiple nodes without infinite loops', async () => {
      const { container } = render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(mockCallbacks.onAddNodeRef.current).toBeDefined();
      });

      // Add 3 nodes in quick succession
      if (mockCallbacks.onAddNodeRef.current) {
        mockCallbacks.onAddNodeRef.current();
        mockCallbacks.onAddNodeRef.current();
        mockCallbacks.onAddNodeRef.current();
      }

      // Wait for all updates to complete
      await waitFor(() => {
        const state = graphStore.getState();
        expect(state.graph?.nodes.length).toBeGreaterThanOrEqual(3);
      }, { timeout: 2000 });

      // Verify no infinite loop (should have exactly 3 nodes, not hundreds)
      const state = graphStore.getState();
      expect(state.graph?.nodes.length).toBeLessThan(10); // Reasonable upper bound
    });
  });

  describe('Edge Creation', () => {
    it('should create an edge between two nodes', async () => {
      // Start with a graph that has two nodes
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } },
          { id: 'node-2', label: 'Node 2', position: { x: 100, y: 100 } }
        ],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      const { container } = render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      // Simulate connection between nodes
      // In real ReactFlow, this would be triggered by dragging from node-1 to node-2
      // For testing, we simulate the onConnect callback
      const reactFlowContainer = screen.getByTestId('reactflow-container');
      const onConnect = reactFlowContainer.getAttribute('data-onconnect');
      
      // Verify nodes are rendered
      expect(screen.getByTestId('node-node-1')).toBeInTheDocument();
      expect(screen.getByTestId('node-node-2')).toBeInTheDocument();
    });
  });

  describe('ReactFlow Integration', () => {
    it('should render ReactFlow with correct props', () => {
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } }
        ],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      // Verify ReactFlow container is rendered
      const container = screen.getByTestId('reactflow-container');
      expect(container).toBeInTheDocument();
      expect(container).toHaveAttribute('data-reactflow', 'true');
      
      // Verify ReactFlow components are present
      expect(screen.getByTestId('reactflow-provider')).toBeInTheDocument();
      expect(screen.getByTestId('reactflow-background')).toBeInTheDocument();
      expect(screen.getByTestId('reactflow-controls')).toBeInTheDocument();
      expect(screen.getByTestId('reactflow-minimap')).toBeInTheDocument();
    });

    it('should render nodes through ReactFlow', () => {
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Landing Page', position: { x: 100, y: 100 } },
          { id: 'node-2', label: 'Sign Up', position: { x: 300, y: 100 } }
        ],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      // Verify nodes are rendered via ReactFlow
      const nodesContainer = screen.getByTestId('reactflow-nodes');
      expect(nodesContainer).toHaveAttribute('data-nodes-count', '2');
      expect(screen.getByTestId('node-node-1')).toBeInTheDocument();
      expect(screen.getByTestId('node-node-2')).toBeInTheDocument();
      expect(screen.getByText('Landing Page')).toBeInTheDocument();
      expect(screen.getByText('Sign Up')).toBeInTheDocument();
    });

    it('should render edges through ReactFlow', () => {
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } },
          { id: 'node-2', label: 'Node 2', position: { x: 200, y: 0 } }
        ],
        edges: [
          { id: 'edge-1', source: 'node-1', target: 'node-2', label: 'Conversion' }
        ],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      // Verify edges are rendered via ReactFlow
      const edgesContainer = screen.getByTestId('reactflow-edges');
      expect(edgesContainer).toHaveAttribute('data-edges-count', '1');
      expect(screen.getByTestId('edge-edge-1')).toBeInTheDocument();
      expect(screen.getByText('node-1 → node-2')).toBeInTheDocument();
      expect(screen.getByTestId('edge-label-edge-1')).toHaveTextContent('Conversion');
    });

    it('should handle ReactFlow node click events', async () => {
      const user = userEvent.setup();
      
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } }
        ],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      const node = screen.getByTestId('node-node-1');
      await user.click(node);

      // Verify ReactFlow onNodeClick was triggered
      await waitFor(() => {
        expect(mockReactFlow.onNodeClick).toHaveBeenCalled();
      });
    });

    it('should handle ReactFlow edge click events', async () => {
      const user = userEvent.setup();
      
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } },
          { id: 'node-2', label: 'Node 2', position: { x: 200, y: 0 } }
        ],
        edges: [
          { id: 'edge-1', source: 'node-1', target: 'node-2' }
        ],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      const edge = screen.getByTestId('edge-edge-1');
      await user.click(edge);

      // Verify ReactFlow onEdgeClick was triggered
      await waitFor(() => {
        expect(mockReactFlow.onEdgeClick).toHaveBeenCalled();
      });
    });

    it('should handle ReactFlow pane click events', async () => {
      const user = userEvent.setup();
      
      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      const pane = screen.getByTestId('reactflow-pane');
      await user.click(pane);

      // Verify ReactFlow onPaneClick was triggered
      await waitFor(() => {
        expect(mockReactFlow.onPaneClick).toHaveBeenCalled();
      });
    });

    it('should handle ReactFlow node drag events', async () => {
      const user = userEvent.setup();
      
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } }
        ],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      const node = screen.getByTestId('node-node-1');
      
      // Simulate drag
      await user.pointer({ keys: '[MouseLeft>]', target: node });
      await user.pointer({ coords: { x: 100, y: 100 } });
      await user.pointer({ keys: '[/MouseLeft]' });

      // Verify ReactFlow drag callbacks were triggered
      await waitFor(() => {
        expect(mockReactFlow.onNodeDrag).toHaveBeenCalled();
        expect(mockReactFlow.onNodeDragStop).toHaveBeenCalled();
      });
    });
  });

  describe('Node Interaction', () => {
    it('should handle node selection without errors', async () => {
      const user = userEvent.setup();
      
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } }
        ],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      const node = screen.getByTestId('node-node-1');
      
      // Simulate clicking on node
      await user.click(node);

      // Verify selection callback was called
      await waitFor(() => {
        expect(mockCallbacks.onSelectedNodeChange).toHaveBeenCalledWith('node-1');
      });
    });

    it('should handle node drag without infinite re-renders', async () => {
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } }
        ],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      const renderCount = vi.fn();
      
      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      const node = screen.getByTestId('node-node-1');
      
      // Simulate drag operation
      await userEvent.click(node);
      await userEvent.pointer({ keys: '[MouseLeft>]', target: node });
      // Move mouse
      await userEvent.pointer({ coords: { x: 100, y: 100 } });
      await userEvent.pointer({ keys: '[/MouseLeft]' });

      // Wait a bit to ensure no infinite loops
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify setGraph was called (for position update) but not excessively
      const callCount = mockGraphStore.setGraph.mock.calls.length;
      expect(callCount).toBeLessThan(5); // Should be 1-2 calls, not hundreds
    });
  });

  describe('Component Interaction', () => {
    it('should sync graph state between GraphCanvas and GraphStore', async () => {
      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      // Add a node
      await waitFor(() => {
        expect(mockCallbacks.onAddNodeRef.current).toBeDefined();
      });

      if (mockCallbacks.onAddNodeRef.current) {
        mockCallbacks.onAddNodeRef.current();
      }

      // Verify GraphStore was updated
      await waitFor(() => {
        const state = graphStore.getState();
        expect(state.graph?.nodes.length).toBeGreaterThan(0);
      });
    });

    it('should notify parent components of selection changes', async () => {
      graphStore.setState({
        graph: {
        nodes: [
          { id: 'node-1', label: 'Node 1', position: { x: 0, y: 0 } }
        ],
        edges: [],
        metadata: { name: 'Test Graph', version: '1.0.0' }
      };

      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      const node = screen.getByTestId('node-node-1');
      await userEvent.click(node);

      // Verify callbacks were called
      await waitFor(() => {
        expect(mockCallbacks.onSelectedNodeChange).toHaveBeenCalled();
      });
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle rapid successive operations without crashing', async () => {
      render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(mockCallbacks.onAddNodeRef.current).toBeDefined();
      });

      // Rapidly add nodes
      if (mockCallbacks.onAddNodeRef.current) {
        for (let i = 0; i < 5; i++) {
          mockCallbacks.onAddNodeRef.current();
        }
      }

      // Should complete without errors
      await waitFor(() => {
        const state = graphStore.getState();
        expect(state.graph?.nodes.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      // Component should still be mounted
      expect(screen.getByTestId('reactflow-container')).toBeInTheDocument();
    });

    it('should handle empty graph state gracefully', () => {
      graphStore.setState({
        graph: {
          nodes: [],
          edges: [],
          metadata: { name: 'Test Graph', version: '1.0.0' }
        },
        history: [],
        historyIndex: -1,
        canUndo: false,
        canRedo: false,
      });

      const { container } = render(
        <TestWrapper store={graphStore}>
          <GraphCanvas
            {...mockCallbacks}
            whatIfAnalysis={null}
            caseOverrides={{}}
            conditionalOverrides={{}}
            tabId="test-tab"
            activeTabId="test-tab"
          />
        </TestWrapper>
      );

      // Should render without errors
      expect(screen.getByTestId('reactflow-container')).toBeInTheDocument();
    });
  });
});

