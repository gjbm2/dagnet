import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  ProOptions,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useState } from 'react';

import '@xyflow/react/dist/style.css';

import {
  edges as defaultEdges,
  nodes as defaultNodes,
} from './initialElements';
import { useHelperLines } from './useHelperLines';

const proOptions: ProOptions = { hideAttribution: true };

// This example shows how to implement helper lines within React Flow
// usage: drag nodes around to see them snap and align with other nodes boundaries
function ReactFlowPro() {
  const [nodes, setNodes] = useState(defaultNodes);
  const [edges, setEdges] = useState(defaultEdges);

  const { rebuildIndex, updateHelperLines, HelperLines } = useHelperLines();

  const { getNodes } = useReactFlow();

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setNodes((nodes) => {
        const updatedChanges = updateHelperLines(changes, nodes);
        return applyNodeChanges(updatedChanges, nodes);
      });
    },
    [setNodes, updateHelperLines],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) =>
      setEdges((edgesSnapshot) => applyEdgeChanges(changes, edgesSnapshot)),
    [],
  );
  const onConnect: OnConnect = useCallback(
    (params) => setEdges((edgesSnapshot) => addEdge(params, edgesSnapshot)),
    [],
  );

  const onNodeDragStop = useCallback(() => {
    rebuildIndex(getNodes());
  }, [getNodes, rebuildIndex]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={onNodeDragStop}
      fitView
      elevateEdgesOnSelect
      elevateNodesOnSelect
      proOptions={proOptions}
    >
      <Background />
      <Controls />
      <HelperLines />
    </ReactFlow>
  );
}

function ReactFlowWrapper() {
  return (
    <ReactFlowProvider>
      <ReactFlowPro />
    </ReactFlowProvider>
  );
}

export default ReactFlowWrapper;
