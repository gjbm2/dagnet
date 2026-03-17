/**
 * Layout algorithms extracted from GraphCanvas — pure computation cores.
 *
 * computeDagreLayout:  Dagre-based auto-layout, returns new node positions.
 * computeSankeyLayout: d3-sankey layout, returns new node positions + heights.
 */

import dagre from 'dagre';
import { sankey, sankeyCenter, sankeyJustify } from 'd3-sankey';
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from '@/lib/nodeEdgeConstants';

// ---------------------------------------------------------------------------
// Dagre layout
// ---------------------------------------------------------------------------

export interface DagreLayoutResult {
  /** Map from node ID to new position (dagre centre coordinates). */
  positions: Map<string, { x: number; y: number }>;
}

/**
 * Compute a dagre layout for the given nodes/edges.
 *
 * Returns centre-point positions for each node. The caller is responsible
 * for applying these to the graph and triggering re-route.
 */
export function computeDagreLayout(
  nodes: any[],
  edges: any[],
  direction: 'LR' | 'RL' | 'TB' | 'BT',
  useSankeyView: boolean,
): DagreLayoutResult {
  // Determine which nodes to layout
  const selectedNodes = nodes.filter(n => n.selected);
  const nodesToLayout = selectedNodes.length > 0 ? selectedNodes : nodes;
  const nodeIdsToLayout = new Set(nodesToLayout.map(n => n.id));

  if (nodesToLayout.length === 0) return { positions: new Map() };

  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  // Configure layout direction and spacing
  const nodeSpacing = useSankeyView ? 20 : 60;
  const rankSpacing = useSankeyView ? 250 : 150;

  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: nodeSpacing,
    ranksep: rankSpacing,
    edgesep: 20,
    marginx: 40,
    marginy: 40,
  });

  // Add nodes
  nodesToLayout.forEach((node) => {
    let width = node.width || (node.data?.type === 'case' ? 96 : DEFAULT_NODE_WIDTH);
    let height = node.height || (node.data?.type === 'case' ? 96 : DEFAULT_NODE_HEIGHT);

    if (useSankeyView && node.data?.sankeyHeight) {
      height = node.data.sankeyHeight;
      width = node.data.sankeyWidth || DEFAULT_NODE_WIDTH;
      console.log(`[Dagre] Sankey node ${node.data?.label}: using sankeyHeight=${height}, sankeyWidth=${width}, node.width=${node.width}, node.height=${node.height}, style.height=${(node as any).style?.height}`);
    } else {
      console.log(`[Dagre] Normal node ${node.data?.label}: using width=${width}, height=${height}`);
    }

    dagreGraph.setNode(node.id, { width, height });
  });

  // Add edges (only between nodes being laid out)
  edges.forEach((edge) => {
    if (nodeIdsToLayout.has(edge.source) && nodeIdsToLayout.has(edge.target)) {
      dagreGraph.setEdge(edge.source, edge.target);
    }
  });

  // Verify node dimensions before layout
  if (useSankeyView) {
    console.log('[Dagre] Node dimensions BEFORE layout:');
    dagreGraph.nodes().forEach((nodeId) => {
      const node = dagreGraph.node(nodeId);
      console.log(`  ${nodeId}: width=${node.width}, height=${node.height}`);
    });
  }

  dagre.layout(dagreGraph);

  // Verify positions after layout
  if (useSankeyView) {
    console.log('[Dagre] Node positions AFTER layout:');
    dagreGraph.nodes().forEach((nodeId) => {
      const node = dagreGraph.node(nodeId);
      console.log(`  ${nodeId}: x=${node.x}, y=${node.y}, width=${node.width}, height=${node.height}`);
    });
  }

  const positions = new Map<string, { x: number; y: number }>();
  dagreGraph.nodes().forEach((nodeId) => {
    const dagreNode = dagreGraph.node(nodeId);
    positions.set(nodeId, { x: dagreNode.x, y: dagreNode.y });
  });

  // When laying out a selection subset, anchor the topologically highest node
  // (fewest incoming edges within the selection) so it stays stationary.
  if (selectedNodes.length > 0) {
    // Count in-degree within the selection for each node
    const inDegree = new Map<string, number>();
    for (const id of nodeIdsToLayout) inDegree.set(id, 0);
    for (const edge of edges) {
      if (nodeIdsToLayout.has(edge.source) && nodeIdsToLayout.has(edge.target)) {
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
      }
    }

    // Pick the node with lowest in-degree (ties broken by first found)
    let anchorId: string | null = null;
    let minInDegree = Infinity;
    for (const [id, deg] of inDegree) {
      if (deg < minInDegree) {
        minInDegree = deg;
        anchorId = id;
      }
    }

    if (anchorId) {
      const anchorNode = nodesToLayout.find(n => n.id === anchorId);
      const anchorDagrePos = positions.get(anchorId);
      if (anchorNode && anchorDagrePos) {
        // Original position is the node's current centre
        const origX = (anchorNode.position?.x ?? anchorNode.positionAbsolute?.x ?? 0)
          + (anchorNode.width || DEFAULT_NODE_WIDTH) / 2;
        const origY = (anchorNode.position?.y ?? anchorNode.positionAbsolute?.y ?? 0)
          + (anchorNode.height || DEFAULT_NODE_HEIGHT) / 2;

        const dx = origX - anchorDagrePos.x;
        const dy = origY - anchorDagrePos.y;

        for (const [id, pos] of positions) {
          positions.set(id, { x: pos.x + dx, y: pos.y + dy });
        }
      }
    }
  }

  return { positions };
}

// ---------------------------------------------------------------------------
// Sankey layout
// ---------------------------------------------------------------------------

export interface SankeyLayoutResult {
  /** Map from node ID to new top-left position + computed height. */
  positions: Map<string, { x: number; y: number; sankeyHeight: number }>;
}

/**
 * Compute a d3-sankey layout for the given nodes/edges.
 *
 * Returns top-left positions and computed heights. The caller is responsible
 * for applying these to the graph and managing refs/timeouts.
 */
export function computeSankeyLayout(
  nodes: any[],
  edges: any[],
): SankeyLayoutResult {
  // Determine which nodes to layout
  const selectedNodes = nodes.filter(n => n.selected);
  const nodesToLayout = selectedNodes.length > 0 ? selectedNodes : nodes;
  const nodeIdsToLayout = new Set(nodesToLayout.map(n => n.id));

  if (nodesToLayout.length === 0) return { positions: new Map() };

  // Build d3-sankey compatible data structure
  const sankeyNodes: any[] = [];
  const sankeyLinks: any[] = [];

  nodesToLayout.forEach((node) => {
    const height = node.data?.sankeyHeight || (node.data?.type === 'case' ? 96 : DEFAULT_NODE_HEIGHT);
    sankeyNodes.push({
      id: node.id,
      name: node.data?.label || node.id,
      fixedValue: height,
      height: height,
    });
  });

  edges.forEach((edge) => {
    if (nodeIdsToLayout.has(edge.source) && nodeIdsToLayout.has(edge.target)) {
      const raw = edge.data?.scaledWidth ?? 1;
      const linkValue = Math.max(1, raw);
      sankeyLinks.push({
        source: edge.source,
        target: edge.target,
        value: linkValue,
      });
    }
  });

  console.log('[Sankey Layout] Nodes:', sankeyNodes.length, 'Links:', sankeyLinks.length);

  // ===== ADAPTIVE SANKEY LAYOUT POLICY =====
  const nodeWidth = DEFAULT_NODE_WIDTH;
  const margin = 40;
  const viewportWidth = 1800;

  // Calculate number of columns (depth) by doing a simple rank assignment
  const nodeDepths = new Map<string, number>();
  const visited = new Set<string>();
  const calculateDepth = (nodeId: string, depth: number = 0) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    nodeDepths.set(nodeId, Math.max(nodeDepths.get(nodeId) || 0, depth));

    sankeyLinks.forEach(link => {
      if (link.source === nodeId) {
        calculateDepth(link.target, depth + 1);
      }
    });
  };

  const nodesWithIncoming = new Set(sankeyLinks.map(l => l.target));
  sankeyNodes.forEach(node => {
    if (!nodesWithIncoming.has(node.id)) {
      calculateDepth(node.id, 0);
    }
  });

  const maxDepth = Math.max(...Array.from(nodeDepths.values()), 0);
  const D = maxDepth + 1;

  // Calculate nodes per column and heights per column
  const countsPerColumn = new Array(D).fill(0);
  const heightsPerColumn = new Array(D).fill(0);
  sankeyNodes.forEach(node => {
    const depth = nodeDepths.get(node.id) || 0;
    countsPerColumn[depth]++;
    heightsPerColumn[depth] += node.height;
  });
  const countsMax = Math.max(...countsPerColumn);

  // === Horizontal spacing G (column gap) ===
  let G: number;
  if (D <= 3) G = 250;
  else if (D <= 6) G = 200;
  else G = 150;

  // === Vertical node padding P ===
  let P: number;
  if (countsMax >= 6) {
    P = D >= 8 ? 25 : D >= 6 ? 20 : 15;
  } else if (countsMax >= 4) {
    P = 25;
  } else {
    P = 35;
  }

  // === Calculate extent ===
  let W = margin * 2 + D * nodeWidth + (D - 1) * G;
  let H = margin * 2 + Math.max(...heightsPerColumn.map((h, i) =>
    h + (countsPerColumn[i] - 1) * P * 1.5
  ));
  H = Math.max(H, 600);

  // Viewport fit pass (scale G only)
  if (W > 1.25 * viewportWidth) {
    const scale = Math.max(0.7, Math.min(1.0, (1.25 * viewportWidth) / W));
    G = G * scale;
    W = margin * 2 + D * nodeWidth + (D - 1) * G;
  } else if (W < 0.8 * viewportWidth) {
    const scale = Math.max(1.0, Math.min(1.2, (0.8 * viewportWidth) / W));
    G = G * scale;
    W = margin * 2 + D * nodeWidth + (D - 1) * G;
  }

  // === Alignment ===
  const alignment = countsMax >= 4 ? sankeyJustify : sankeyCenter;

  // === Iterations ===
  const E = sankeyLinks.length;
  let iterations: number;
  if (E <= 150) iterations = 32;
  else if (E <= 300) iterations = 48;
  else iterations = 64;

  console.log(`[Sankey Layout] Adaptive settings: D=${D}, countsMax=${countsMax}, G=${G.toFixed(0)}, P=${P}, W=${W.toFixed(0)}, H=${H.toFixed(0)}, iterations=${iterations}`);

  const sankeyGenerator = sankey()
    .nodeId((d: any) => d.id)
    .nodeWidth(nodeWidth)
    .nodePadding(P)
    .extent([[margin, margin], [W - margin, H - margin]])
    .nodeAlign(alignment)
    .iterations(iterations);

  const sankeyGraph = sankeyGenerator({
    nodes: sankeyNodes,
    links: sankeyLinks,
  });

  console.log('[Sankey Layout] Layout computed, applying positions');
  console.log('[Sankey Layout] Sample sankeyNode:', sankeyGraph.nodes[0]);

  const positions = new Map<string, { x: number; y: number; sankeyHeight: number }>();
  sankeyGraph.nodes.forEach((sankeyNode: any) => {
    if (sankeyNode.x0 === undefined || sankeyNode.y0 === undefined) {
      console.error(`[Sankey Layout] Node ${sankeyNode.id} has no x0/y0! Node:`, sankeyNode);
      return;
    }

    const sankeyHeight = sankeyNode.y1 - sankeyNode.y0;
    console.log(`[Sankey Layout] Node ${sankeyNode.name}: x=${sankeyNode.x0.toFixed(0)}, y=${sankeyNode.y0.toFixed(0)} (top-left), height=${sankeyHeight.toFixed(0)}`);

    positions.set(sankeyNode.id, {
      x: sankeyNode.x0,
      y: sankeyNode.y0,
      sankeyHeight,
    });
  });

  return { positions };
}
