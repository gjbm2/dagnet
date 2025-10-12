import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  onDoubleClickNode?: (id: string, field: string) => void;
  onDoubleClickEdge?: (id: string, field: string) => void;
  onSelectEdge?: (id: string) => void;
}

export default function GraphCanvas({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner 
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectedEdgeChange={onSelectedEdgeChange}
        onDoubleClickNode={onDoubleClickNode}
        onDoubleClickEdge={onDoubleClickEdge}
        onSelectEdge={onSelectEdge}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge }: GraphCanvasProps) {
  const { graph, setGraph } = useGraphStore();
  const { deleteElements, fitView, screenToFlowPosition, setCenter } = useReactFlow();
  
  // ReactFlow maintains local state for smooth interactions
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  
  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const isSyncingRef = useRef(false);
  
  // Callback functions for node/edge updates
  const handleUpdateNode = useCallback((id: string, data: any) => {
    console.log('handleUpdateNode called:', { id, data });
    setGraph((prevGraph) => {
      if (!prevGraph) return prevGraph;
      const nextGraph = structuredClone(prevGraph);
      const nodeIndex = nextGraph.nodes.findIndex(n => n.id === id);
      if (nodeIndex >= 0) {
        nextGraph.nodes[nodeIndex] = { ...nextGraph.nodes[nodeIndex], ...data };
        nextGraph.metadata.updated_at = new Date().toISOString();
        console.log('Updated node in graph:', nextGraph.nodes[nodeIndex]);
      }
      return nextGraph;
    });
  }, [setGraph]);

  const handleDeleteNode = useCallback((id: string) => {
    setGraph((prevGraph) => {
      if (!prevGraph) return prevGraph;
      const nextGraph = structuredClone(prevGraph);
      nextGraph.nodes = nextGraph.nodes.filter(n => n.id !== id);
      nextGraph.edges = nextGraph.edges.filter(e => e.from !== id && e.to !== id);
      nextGraph.metadata.updated_at = new Date().toISOString();
      return nextGraph;
    });
  }, [setGraph]);

  const handleUpdateEdge = useCallback((id: string, data: any) => {
    setGraph((prevGraph) => {
      if (!prevGraph) return prevGraph;
      const nextGraph = structuredClone(prevGraph);
      const edgeIndex = nextGraph.edges.findIndex(e => e.id === id);
      if (edgeIndex >= 0) {
        nextGraph.edges[edgeIndex] = { ...nextGraph.edges[edgeIndex], ...data };
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      return nextGraph;
    });
  }, [setGraph]);

  const handleDeleteEdge = useCallback((id: string) => {
    setGraph((prevGraph) => {
      if (!prevGraph) return prevGraph;
      const nextGraph = structuredClone(prevGraph);
      nextGraph.edges = nextGraph.edges.filter(e => e.id !== id);
      nextGraph.metadata.updated_at = new Date().toISOString();
      return nextGraph;
    });
  }, [setGraph]);

  // Sync FROM graph TO ReactFlow when graph changes externally
  useEffect(() => {
    if (!graph || isSyncingRef.current) return;
    
    const graphJson = JSON.stringify(graph);
    if (graphJson === lastSyncedGraphRef.current) return;
    
    lastSyncedGraphRef.current = graphJson;
    const { nodes: newNodes, edges: newEdges } = toFlow(graph, {
      onUpdateNode: handleUpdateNode,
      onDeleteNode: handleDeleteNode,
      onUpdateEdge: handleUpdateEdge,
      onDeleteEdge: handleDeleteEdge,
      onDoubleClickNode: onDoubleClickNode,
      onDoubleClickEdge: onDoubleClickEdge,
      onSelectEdge: onSelectEdge,
    });
    setNodes(newNodes);
    setEdges(newEdges);
  }, [graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge]);
  
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

  // Function to check if adding an edge would create a cycle
  const wouldCreateCycle = useCallback((source: string, target: string, currentEdges: any[]) => {
    // Create a directed graph representation
    const graph: { [key: string]: string[] } = {};
    
    // Initialize all nodes
    nodes.forEach(node => {
      graph[node.id] = [];
    });
    
    // Add existing edges
    currentEdges.forEach(edge => {
      if (graph[edge.source]) {
        graph[edge.source].push(edge.target);
      }
    });
    
    // Add the proposed new edge
    if (graph[source]) {
      graph[source].push(target);
    }
    
    // DFS to detect cycles
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const hasCycleDFS = (node: string): boolean => {
      if (recursionStack.has(node)) {
        return true; // Cycle detected
      }
      
      if (visited.has(node)) {
        return false; // Already processed
      }
      
      visited.add(node);
      recursionStack.add(node);
      
      const neighbors = graph[node] || [];
      for (const neighbor of neighbors) {
        if (hasCycleDFS(neighbor)) {
          return true;
        }
      }
      
      recursionStack.delete(node);
      return false;
    };
    
    // Check all nodes for cycles
    for (const nodeId of Object.keys(graph)) {
      if (!visited.has(nodeId)) {
        if (hasCycleDFS(nodeId)) {
          return true;
        }
      }
    }
    
    return false;
  }, [nodes]);

  // Handle new connections
  const onConnect = useCallback((connection: Connection) => {
    // Prevent self-referencing edges
    if (connection.source === connection.target) {
      alert('Cannot create an edge from a node to itself.');
      return;
    }

    // Prevent duplicate edges
    const existingEdge = edges.find(edge => 
      edge.source === connection.source && edge.target === connection.target
    );
    if (existingEdge) {
      alert('An edge already exists between these nodes.');
      return;
    }

    // Check for circular dependencies
    if (wouldCreateCycle(connection.source, connection.target, edges)) {
      alert('Cannot create this connection as it would create a circular dependency.');
      return;
    }

    setEdges((eds) => addEdge({
        ...connection,
        type: 'conversion',
      id: `${connection.source}->${connection.target}`,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
      data: { 
        id: `${connection.source}->${connection.target}`,
        probability: 0.5,
        onUpdate: handleUpdateEdge,
        onDelete: handleDeleteEdge,
      },
    }, eds));
  }, [setEdges, handleUpdateEdge, handleDeleteEdge, edges]);


  // Handle Shift+Drag lasso selection
  const [isLassoSelecting, setIsLassoSelecting] = useState(false);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);

  // Track Shift key state and handle mouse events globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(false);
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isShiftHeld && e.target && (e.target as Element).closest('.react-flow')) {
        e.preventDefault();
        e.stopPropagation();
        setIsLassoSelecting(true);
        setLassoStart({ x: e.clientX, y: e.clientY });
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart) {
        e.preventDefault();
        e.stopPropagation();
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart && lassoEnd) {
        e.preventDefault();
        e.stopPropagation();
        
        // Use ReactFlow's built-in coordinate conversion
        const flowStart = screenToFlowPosition({ x: lassoStart.x, y: lassoStart.y });
        const flowEnd = screenToFlowPosition({ x: lassoEnd.x, y: lassoEnd.y });
        
        const flowStartX = flowStart.x;
        const flowStartY = flowStart.y;
        const flowEndX = flowEnd.x;
        const flowEndY = flowEnd.y;
        
        const lassoRect = {
          left: Math.min(flowStartX, flowEndX),
          top: Math.min(flowStartY, flowEndY),
          right: Math.max(flowStartX, flowEndX),
          bottom: Math.max(flowStartY, flowEndY)
        };

        const selectedNodes = nodes.filter(node => {
          const nodeRect = {
            left: node.position.x,
            top: node.position.y,
            right: node.position.x + 120, // Approximate node width
            bottom: node.position.y + 60  // Approximate node height
          };

          const intersects = !(nodeRect.right < lassoRect.left || 
                             nodeRect.left > lassoRect.right || 
                             nodeRect.bottom < lassoRect.top || 
                             nodeRect.top > lassoRect.bottom);
          
          console.log(`Node ${node.id}:`, {
            nodeRect: {
              left: nodeRect.left,
              top: nodeRect.top,
              right: nodeRect.right,
              bottom: nodeRect.bottom
            },
            lassoRect: {
              left: lassoRect.left,
              top: lassoRect.top,
              right: lassoRect.right,
              bottom: lassoRect.bottom
            },
            intersects
          });

          return intersects;
        });

        console.log('Lasso selection:', {
          lassoRect,
          selectedNodes: selectedNodes.map(n => n.id),
          allNodes: nodes.map(n => ({ id: n.id, position: n.position })),
          screenCoords: {
            start: { x: lassoStart.x, y: lassoStart.y },
            end: { x: lassoEnd.x, y: lassoEnd.y }
          },
          flowCoords: {
            start: { x: flowStartX, y: flowStartY },
            end: { x: flowEndX, y: flowEndY }
          }
        });

        // Store the selected node IDs for persistence
        const selectedNodeIds = selectedNodes.map(n => n.id);
        
        // Update nodes with selection state
        setNodes(prevNodes => 
          prevNodes.map(n => ({ 
            ...n, 
            selected: selectedNodeIds.includes(n.id)
          }))
        );
        
        // Force the selection to persist by re-applying it after a short delay
        setTimeout(() => {
          setNodes(prevNodes => 
            prevNodes.map(n => ({ 
              ...n, 
              selected: selectedNodeIds.includes(n.id)
            }))
          );
        }, 50);
        
        // Delay resetting lasso state
        setTimeout(() => {
          setIsLassoSelecting(false);
          setLassoStart(null);
          setLassoEnd(null);
        }, 200);
      } else {
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('mouseup', handleMouseUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mousemove', handleMouseMove, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
    };
  }, [isShiftHeld, isLassoSelecting, lassoStart, lassoEnd, nodes, setNodes]);


  // Track selected nodes for probability calculation
  const [selectedNodesForAnalysis, setSelectedNodesForAnalysis] = useState<any[]>([]);

  // Calculate probability and cost for selected nodes
  const calculateSelectionAnalysis = useCallback(() => {
    if (selectedNodesForAnalysis.length === 0) return null;

    const selectedNodeIds = selectedNodesForAnalysis.map(n => n.id);
    
    // Find all edges between selected nodes
    const internalEdges = edges.filter(edge => 
      selectedNodeIds.includes(edge.source) && selectedNodeIds.includes(edge.target)
    );
    
    // Find edges entering the selection
    const incomingEdges = edges.filter(edge => 
      !selectedNodeIds.includes(edge.source) && selectedNodeIds.includes(edge.target)
    );
    
    // Find edges leaving the selection (source is in selection, target is not)
    const outgoingEdges = edges.filter(edge => 
      selectedNodeIds.includes(edge.source) && !selectedNodeIds.includes(edge.target)
    );
    
    console.log('Edge classification debug:', {
      selectedNodeIds,
      allEdges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceInSelection: selectedNodeIds.includes(e.source), targetInSelection: selectedNodeIds.includes(e.target) })),
      incomingEdges: incomingEdges.map(e => e.id),
      outgoingEdges: outgoingEdges.map(e => e.id)
    });

    // Calculate total probability mass
    const totalIncomingProbability = incomingEdges.reduce((sum, edge) => {
      const prob = edge.data?.probability || 0;
      console.log(`Incoming edge ${edge.id}: probability = ${prob}`);
      return sum + prob;
    }, 0);
    
    const totalOutgoingProbability = outgoingEdges.reduce((sum, edge) => {
      const prob = edge.data?.probability || 0;
      console.log(`Outgoing edge ${edge.id}: probability = ${prob}`);
      return sum + prob;
    }, 0);

    console.log('Probability calculation:', {
      totalIncomingProbability,
      totalOutgoingProbability,
      incomingEdges: incomingEdges.map(e => ({ id: e.id, prob: e.data?.probability })),
      outgoingEdges: outgoingEdges.map(e => ({ id: e.id, prob: e.data?.probability }))
    });

    // Calculate total costs
    const totalCosts = {
      monetary: 0,
      time: 0,
      units: ''
    };

    [...internalEdges, ...outgoingEdges].forEach(edge => {
      if (edge.data?.costs) {
        totalCosts.monetary += edge.data.costs.monetary || 0;
        totalCosts.time += edge.data.costs.time || 0;
        if (edge.data.costs.units && !totalCosts.units) {
          totalCosts.units = edge.data.costs.units;
        }
      }
    });

    return {
      selectedNodes: selectedNodesForAnalysis.length,
      internalEdges: internalEdges.length,
      incomingEdges: incomingEdges.length,
      outgoingEdges: outgoingEdges.length,
      totalIncomingProbability,
      totalOutgoingProbability,
      totalCosts,
      probabilityConservation: Math.abs(totalIncomingProbability - totalOutgoingProbability) < 0.001
    };
  }, [selectedNodesForAnalysis, edges]);

  const analysis = calculateSelectionAnalysis();

  // Handle selection changes
  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: any) => {
    console.log('Selection changed:', { 
      nodes: selectedNodes.map(n => n.id), 
      edges: selectedEdges.map(e => e.id) 
    });
    
    // Update selected nodes for analysis
    setSelectedNodesForAnalysis(selectedNodes);
    
    // Don't clear selection if we just finished a lasso selection
    if (isLassoSelecting) {
      console.log('Ignoring selection change during lasso selection');
      return;
    }
    
    // For multi-selection, we'll show the first selected item in the properties panel
    // but keep track of all selected items for operations like delete
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
  }, [onSelectedNodeChange, onSelectedEdgeChange, isLassoSelecting]);

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
        onUpdate: handleUpdateNode,
        onDelete: handleDeleteNode,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [nodes.length, setNodes, handleUpdateNode, handleDeleteNode]);

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
        selectionOnDrag={false}
        selectNodesOnDrag={false}
        selectionKeyCode={['Meta', 'Ctrl']}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        panOnDrag={!isLassoSelecting}
        style={{ background: '#f8f9fa' }}
        deleteKeyCode={['Backspace', 'Delete']}
        onInit={() => setTimeout(() => fitView(), 100)}
      >
        <Background />
        <Controls />
        <MiniMap />
        
        {/* Lasso selection rectangle */}
        {isLassoSelecting && lassoStart && lassoEnd && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(lassoStart.x, lassoEnd.x),
              top: Math.min(lassoStart.y, lassoEnd.y),
              width: Math.abs(lassoEnd.x - lassoStart.x),
              height: Math.abs(lassoEnd.y - lassoStart.y),
              border: '2px dashed #007bff',
              background: 'rgba(0, 123, 255, 0.1)',
              pointerEvents: 'none',
              zIndex: 1000,
            }}
          />
        )}
        
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

        {/* Selection Analysis Popup */}
        {analysis && (
          <Panel position="bottom-left">
            <div style={{
              background: 'white',
              border: '2px solid #007bff',
              borderRadius: '8px',
              padding: '16px',
              minWidth: '300px',
              maxWidth: '400px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              fontSize: '14px',
              lineHeight: '1.4'
            }}>
              <h3 style={{ margin: '0 0 12px 0', color: '#007bff', fontSize: '16px' }}>
                Selection Analysis
              </h3>
              
              <div style={{ marginBottom: '8px' }}>
                <strong>Nodes:</strong> {analysis.selectedNodes} selected
              </div>
              
              <div style={{ marginBottom: '8px' }}>
                <strong>Edges:</strong> {analysis.internalEdges} internal, {analysis.incomingEdges} incoming, {analysis.outgoingEdges} outgoing
              </div>
              
              <div style={{ marginBottom: '8px' }}>
                <strong>Probability Flow:</strong>
                <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                  In: {Math.round(analysis.totalIncomingProbability * 100)}% → Out: {Math.round(analysis.totalOutgoingProbability * 100)}%
                </div>
                {analysis.totalOutgoingProbability === 0 && analysis.totalIncomingProbability > 0 ? (
                  <div style={{ color: '#16a34a', fontSize: '12px', marginTop: '4px' }}>
                    ✅ Complete path selected - probability contained within selection
                  </div>
                ) : !analysis.probabilityConservation ? (
                  <div style={{ color: '#ff6b6b', fontSize: '12px', marginTop: '4px' }}>
                    ⚠️ Probability not conserved
                  </div>
                ) : (
                  <div style={{ color: '#16a34a', fontSize: '12px', marginTop: '4px' }}>
                    ✅ Probability conserved
                  </div>
                )}
              </div>
              
              {(analysis.totalCosts.monetary > 0 || analysis.totalCosts.time > 0) && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Total Costs:</strong>
                  <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                    {analysis.totalCosts.monetary > 0 && (
                      <div>£{analysis.totalCosts.monetary}{analysis.totalCosts.units && ` ${analysis.totalCosts.units}`}</div>
                    )}
                    {analysis.totalCosts.time > 0 && (
                      <div>{analysis.totalCosts.time}h{analysis.totalCosts.units && ` ${analysis.totalCosts.units}`}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}
