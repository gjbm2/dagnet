import dagre from 'dagre';
import type { Edge, Node } from 'reactflow';

export function applyAutoLayout(nodes: Node[], edges: Edge[], direction: 'LR' | 'TB' | 'RL' | 'BT' = 'LR') {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ 
    rankdir: direction, 
    nodesep: 60, 
    ranksep: 80,
    edgesep: 10,
    marginx: 20,
    marginy: 20
  });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach(n => g.setNode(String(n.id), { width: 120, height: 120 }));
  edges.forEach(e => g.setEdge(String(e.source), String(e.target)));
  dagre.layout(g);

  const n = nodes.map(nd => {
    const p = g.node(String(nd.id));
    return { ...nd, position: { x: p.x - 80, y: p.y - 30 }, data: nd.data };
  });
  return { n, e: edges };
}
