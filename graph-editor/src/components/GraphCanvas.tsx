import React, { useCallback, useEffect, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  ReactFlowProvider,
  NodeTypes,
  EdgeTypes,
  useReactFlow,
  Panel,
} from 'reactflow';
import 'reactflow/dist/style.css';

import ConversionNode from './nodes/ConversionNode';
import ConversionEdge from './edges/ConversionEdge';
import { useGraphStore } from '@/lib/useGraphStore';
import { toFlow, fromFlow } from '@/lib/transform';

const nodeTypes: NodeTypes = {
  conversion: ConversionNode,
};

const edgeTypes: EdgeTypes = {
  conversion: ConversionEdge,
};

interface GraphCanvasProps {
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
}

export default function GraphCanvas({ onSelectedNodeChange, onSelectedEdgeChange }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner 
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectedEdgeChange={onSelectedEdgeChange}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onSelectedNodeChange, onSelectedEdgeChange }: GraphCanvasProps) {
  const { graph, setGraph } = useGraphStore();
  const { deleteElements, fitView } = useReactFlow();
  
  // ReactFlow maintains local state for smooth interactions
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  
  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const isSyncingRef = useRef(false);
  
  // Sync FROM graph TO ReactFlow when graph changes externally
  useEffect(() => {
    if (!graph || isSyncingRef.current) return;
    
    const graphJson = JSON.stringify(graph);
    if (graphJson === lastSyncedGraphRef.current) return;
    
    lastSyncedGraphRef.current = graphJson;
    const { nodes: newNodes, edges: newEdges } = toFlow(graph);
    setNodes(newNodes);
    setEdges(newEdges);
  }, [graph, setNodes, setEdges]);
  
  // Sync FROM ReactFlow TO graph when user makes changes
  useEffect(() => {
    if (!graph || isSyncingRef.current) return;
    if (nodes.length === 0 && graph.nodes.length > 0) return; // Still initializing
    
    const updatedGraph = fromFlow(nodes, edges, graph);
    if (updatedGraph) {
      const updatedJson = JSON.stringify(updatedGraph);
      if (updatedJson === lastSyncedGraphRef.current) return; // No real changes
      
      isSyncingRef.current = true;
      lastSyncedGraphRef.current = updatedJson;
      setGraph(updatedGraph);
      
      // Reset sync flag
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 0);
    }
  }, [nodes, edges, graph, setGraph]);

  // Handle new connections
  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge({
      ...connection,
      type: 'conversion',
      id: `${connection.source}->${connection.target}`,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
      data: { probability: 0.5 },
    }, eds));
  }, [setEdges]);

  // Handle selection changes
  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: any) => {
    if (selectedNodes.length > 0) {
      onSelectedNodeChange(selectedNodes[0].id);
      onSelectedEdgeChange(null);
    } else if (selectedEdges.length > 0) {
      onSelectedEdgeChange(selectedEdges[0].id);
      onSelectedNodeChange(null);
    } else {
      onSelectedNodeChange(null);
      onSelectedEdgeChange(null);
    }
  }, [onSelectedNodeChange, onSelectedEdgeChange]);

  // Add new node
  const addNode = useCallback(() => {
    const newId = crypto.randomUUID();
    const newNode: Node = {
      id: newId,
      type: 'conversion',
      position: { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 },
      data: {
        id: newId,
        label: `Node ${nodes.length + 1}`,
        slug: `node_${nodes.length + 1}`,
        absorbing: false,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [nodes.length, setNodes]);

  // Delete selected elements
  const deleteSelected = useCallback(() => {
    deleteElements({ nodes: [], edges: [] });
  }, [deleteElements]);

  if (!graph) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      Loading...
    </div>;
  }

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        style={{ background: '#f8f9fa' }}
        deleteKeyCode={['Backspace', 'Delete']}
        onInit={() => setTimeout(() => fitView(), 100)}
      >
        <Background />
        <Controls />
        <MiniMap />
        
        <Panel position="top-left">
          <button
            onClick={addNode}
            style={{
              padding: '8px 16px',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginRight: '8px',
            }}
          >
            + Add Node
          </button>
          <button
            onClick={deleteSelected}
            style={{
              padding: '8px 16px',
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Delete Selected
          </button>
        </Panel>
      </ReactFlow>
    </div>
  );
}
