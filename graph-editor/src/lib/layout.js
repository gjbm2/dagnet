import dagre from 'dagre';
export function applyAutoLayout(nodes, edges, options = {}) {
    const { direction = 'LR', selectedOnly = false, selectedNodeIds = new Set() } = options;
    // Determine which nodes to layout
    const nodesToLayout = selectedOnly && selectedNodeIds.size > 0
        ? nodes.filter(n => selectedNodeIds.has(n.id))
        : nodes;
    const fixedNodes = selectedOnly && selectedNodeIds.size > 0
        ? nodes.filter(n => !selectedNodeIds.has(n.id))
        : [];
    // If no nodes to layout, return original
    if (nodesToLayout.length === 0) {
        return { nodes, edges };
    }
    // Filter edges to only those between nodes being laid out
    const edgesToLayout = edges.filter(e => nodesToLayout.some(n => n.id === e.source) &&
        nodesToLayout.some(n => n.id === e.target));
    // Create dagre graph
    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: direction,
        nodesep: 80, // Horizontal spacing between nodes in same rank
        ranksep: 150, // Vertical spacing between ranks
        edgesep: 20, // Spacing between edges
        marginx: 40,
        marginy: 40
    });
    g.setDefaultEdgeLabel(() => ({}));
    // Add nodes with appropriate dimensions (case nodes are smaller)
    nodesToLayout.forEach(n => {
        const isCaseNode = n.data?.type === 'case';
        const width = isCaseNode ? 96 : 120;
        const height = isCaseNode ? 96 : 120;
        g.setNode(String(n.id), { width, height });
    });
    // Add edges
    edgesToLayout.forEach(e => {
        g.setEdge(String(e.source), String(e.target));
    });
    // Perform layout
    dagre.layout(g);
    // Apply new positions to nodes
    const layoutedNodes = nodesToLayout.map(nd => {
        const nodeWithPosition = g.node(String(nd.id));
        const isCaseNode = nd.data?.type === 'case';
        const width = isCaseNode ? 96 : 120;
        const height = isCaseNode ? 96 : 120;
        return {
            ...nd,
            position: {
                x: nodeWithPosition.x - width / 2,
                y: nodeWithPosition.y - height / 2
            },
            selected: nd.selected // Preserve selection state
        };
    });
    // For partial layouts, calculate offset to keep nodes near their original location
    if (selectedOnly && nodesToLayout.length > 0 && fixedNodes.length > 0) {
        // Calculate centroid of original positions
        const originalCentroid = {
            x: nodesToLayout.reduce((sum, n) => sum + n.position.x, 0) / nodesToLayout.length,
            y: nodesToLayout.reduce((sum, n) => sum + n.position.y, 0) / nodesToLayout.length
        };
        // Calculate centroid of new positions
        const newCentroid = {
            x: layoutedNodes.reduce((sum, n) => sum + n.position.x, 0) / layoutedNodes.length,
            y: layoutedNodes.reduce((sum, n) => sum + n.position.y, 0) / layoutedNodes.length
        };
        // Calculate offset to maintain relative position
        const offset = {
            x: originalCentroid.x - newCentroid.x,
            y: originalCentroid.y - newCentroid.y
        };
        // Apply offset to all layouted nodes
        layoutedNodes.forEach(node => {
            node.position.x += offset.x;
            node.position.y += offset.y;
        });
    }
    // Combine fixed and layouted nodes
    const allNodes = [...fixedNodes, ...layoutedNodes];
    return { nodes: allNodes, edges };
}
