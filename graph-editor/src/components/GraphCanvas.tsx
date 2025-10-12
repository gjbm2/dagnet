import React, { useCallback, useMemo } from 'react';
import ReactFlow, { addEdge, Background, Controls, Connection, Edge, MiniMap, Node, ReactFlowProvider, useEdgesState, useNodesState } from 'reactflow';
import { useGraphStore } from '@/lib/useGraphStore';
import { toFlow, fromFlow } from '@/lib/transform';
import { introducesCycle } from '@/lib/cycle';
import { applyAutoLayout } from '@/lib/layout';

export default function GraphCanvas({ onValidate }: { onValidate: () => string[] }) {
  return (
    <ReactFlowProvider>
      <CanvasInner onValidate={onValidate} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onValidate }: { onValidate: () => string[] }) {
  const { graph, setGraph } = useGraphStore();
  const initial = useMemo(() => toFlow(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node[]>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge[]>(initial.edges);

  // Sync back to JSON when nodes/edges change
  const commit = useCallback((n: Node[], e: Edge[]) => {
    const next = fromFlow(n, e, graph);
    setGraph(next);
    onValidate();
  }, [graph, setGraph, onValidate]);

  const onConnect = useCallback((conn: Connection) => {
    const nextEdges = addEdge({ ...conn, type: 'default' }, edges);
    const nodeIds = nodes.map(n => String(n.id));
    const simple = nextEdges.map(e => ({ from: String(e.source), to: String(e.target) }));
    if (introducesCycle(nodeIds, simple)) { alert('Adding this edge would create a cycle.'); return; }
    setEdges(nextEdges);
    commit(nodes, nextEdges);
  }, [edges, nodes, commit]);

  const onNodesChangeWrapped = useCallback((chg: any) => { onNodesChange(chg); setTimeout(() => commit(nodes, edges)); }, [onNodesChange, commit, nodes, edges]);
  const onEdgesChangeWrapped = useCallback((chg: any) => { onEdgesChange(chg); setTimeout(() => commit(nodes, edges)); }, [onEdgesChange, commit, nodes, edges]);

  const doAutoLayout = () => {
    const { n, e } = applyAutoLayout(nodes, edges);
    setNodes(n); setEdges(e); commit(n, e);
  };

  if (!graph) return <div style={{ padding: 16 }}>Loading…</div>;

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <div style={{ position: 'absolute', zIndex: 10, padding: 8 }}>
        <button onClick={doAutoLayout}>Auto-layout</button>
      </div>
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChangeWrapped} onEdgesChange={onEdgesChangeWrapped} onConnect={onConnect} fitView>
        <MiniMap />
        <Controls />
        <Background />
      </ReactFlow>
    </div>
  );
}
