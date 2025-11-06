/**
 * Chevron Arrow Clipping for Edge Bundles
 * 
 * Generates SVG clipPath definitions for chevron-shaped arrows at edge bundle boundaries.
 */

export interface EdgeBundle {
  id: string;
  nodeId: string;
  face: 'left' | 'right' | 'top' | 'bottom';
  type: 'source' | 'target';
  edges: any[];
  bundleWidth: number;
}

export const MIN_CHEVRON_THRESHOLD = 4; // pixels - below this, use fallback arrowhead
const CHEVRON_OFFSET =3.8; // pixels - offset from node edge to avoid clipping by node border

/**
 * Group edges by bundle (node + face + direction)
 */
export function groupEdgesIntoBundles(edges: any[], nodes: any[]): EdgeBundle[] {
  const bundles = new Map<string, EdgeBundle>();
  
  edges.forEach(edge => {
    const edgeData = edge.data || {};
    
    // SOURCE bundle
    if (edgeData.sourceBundleWidth && edgeData.sourceFace) {
      const sourceBundleId = `${edge.source}-${edgeData.sourceFace}-source`;
      
      if (!bundles.has(sourceBundleId)) {
        bundles.set(sourceBundleId, {
          id: sourceBundleId,
          nodeId: edge.source,
          face: edgeData.sourceFace,
          type: 'source',
          edges: [],
          bundleWidth: edgeData.sourceBundleWidth,
        });
      }
      bundles.get(sourceBundleId)?.edges.push(edge);
    }
    
    // TARGET bundle
    if (edgeData.targetBundleWidth && edgeData.targetFace) {
      const targetBundleId = `${edge.target}-${edgeData.targetFace}-target`;
      
      if (!bundles.has(targetBundleId)) {
        bundles.set(targetBundleId, {
          id: targetBundleId,
          nodeId: edge.target,
          face: edgeData.targetFace,
          type: 'target',
          edges: [],
          bundleWidth: edgeData.targetBundleWidth,
        });
      }
      bundles.get(targetBundleId)?.edges.push(edge);
    }
  });
  
  // Keep bundles lightweight; centers computed at render-time from node
  
  return Array.from(bundles.values());
}

/**
 * Calculate the center point of a bundle at the node face
 */
function calculateBundleCenterAtNode(
  node: any,
  face: string,
  bundleWidth: number
): { x: number; y: number } {
  // Get node dimensions from node object, or use defaults
  const nodeWidth = node.width || 120;
  const nodeHeight = node.height || 120;
  const nodeX = node.position.x;
  const nodeY = node.position.y;
  
  // Bundle center is at the midpoint of the node face
  switch (face) {
    case 'right':
      return { x: nodeX + nodeWidth, y: nodeY + nodeHeight / 2 };
    case 'left':
      return { x: nodeX, y: nodeY + nodeHeight / 2 };
    case 'bottom':
      return { x: nodeX + nodeWidth / 2, y: nodeY + nodeHeight };
    case 'top':
      return { x: nodeX + nodeWidth / 2, y: nodeY };
    default:
      return { x: nodeX + nodeWidth / 2, y: nodeY + nodeHeight / 2 };
  }
}

/**
 * Generate SVG clipPath polygon points for a chevron
 * @param bundle - The edge bundle
 * @param node - The node this bundle is attached to (for dynamic position)
 */
export function generateChevronClipPath(bundle: EdgeBundle, node: any): string | null {
  // Skip chevron for thin bundles
  if (bundle.bundleWidth < MIN_CHEVRON_THRESHOLD) {
    return null;
  }
  
  const height = bundle.bundleWidth;
  const width = height / 5; // CHEVRON_WIDTH = CHEVRON_HEIGHT / 5
  
  // Calculate center position dynamically from current node position
  const centerPos = calculateBundleCenterAtNode(node, bundle.face, bundle.bundleWidth);
  const { x: centerX, y: centerY } = centerPos;
  
  console.log(`[Chevron] Generating clipPath for ${bundle.type} bundle:`, {
    bundleId: bundle.id,
    nodeId: node.id,
    nodePos: { x: node.position.x, y: node.position.y },
    face: bundle.face,
    centerPos: { centerX, centerY },
    bundleWidth: bundle.bundleWidth
  });
  
  if (bundle.type === 'source') {
    // SOURCE: Direct triangle subtraction (creates "bite")
    return generateSourceChevronPath(centerX, centerY, width, height, bundle.face);
  } else {
    // TARGET: Inverted triangle (creates "point")
    return generateTargetChevronPath(centerX, centerY, width, height, bundle.face);
  }
}

function generateSourceChevronPath(
  nodeX: number,
  nodeY: number,
  width: number,
  height: number,
  face: string
): string {
  // Triangle with base offset from node face (to avoid node border clipping), tip extending outward
  switch (face) {
    case 'right': {
      // Flow direction: +X (right) - offset base to the right
      const baseX = nodeX + CHEVRON_OFFSET;
      const top = `${baseX},${nodeY - height / 2}`;
      const bottom = `${baseX},${nodeY + height / 2}`;
      const tip = `${baseX + width},${nodeY}`;
      return `${top} ${bottom} ${tip}`;
    }
    case 'left': {
      // Flow direction: -X (left) - offset base to the left
      const baseX = nodeX - CHEVRON_OFFSET;
      const top = `${baseX},${nodeY - height / 2}`;
      const bottom = `${baseX},${nodeY + height / 2}`;
      const tip = `${baseX - width},${nodeY}`;
      return `${top} ${bottom} ${tip}`;
    }
    case 'bottom': {
      // Flow direction: +Y (down) - offset base downward
      const baseY = nodeY + CHEVRON_OFFSET;
      const left = `${nodeX - height / 2},${baseY}`;
      const right = `${nodeX + height / 2},${baseY}`;
      const tip = `${nodeX},${baseY + width}`;
      return `${left} ${right} ${tip}`;
    }
    case 'top': {
      // Flow direction: -Y (up) - offset base upward
      const baseY = nodeY - CHEVRON_OFFSET;
      const left = `${nodeX - height / 2},${baseY}`;
      const right = `${nodeX + height / 2},${baseY}`;
      const tip = `${nodeX},${baseY - width}`;
      return `${left} ${right} ${tip}`;
    }
    default:
      return '';
  }
}

function generateTargetChevronPath(
  nodeX: number,
  nodeY: number,
  width: number,
  height: number,
  face: string
): string {
  // Triangle with tip offset from node face (to avoid node border clipping), base extending away from node
  // For TARGET, we want the INVERSE - keep the triangle, clip everything else
  switch (face) {
    case 'left': {
      // Flow direction: +X (toward node from left) - offset tip to the left
      const tipX = nodeX - CHEVRON_OFFSET;
      const tip = `${tipX},${nodeY}`;
      const top = `${tipX - width},${nodeY - height / 2}`;
      const bottom = `${tipX - width},${nodeY + height / 2}`;
      return `${tip} ${top} ${bottom}`;
    }
    case 'right': {
      // Flow direction: -X (toward node from right) - offset tip to the right
      const tipX = nodeX + CHEVRON_OFFSET;
      const tip = `${tipX},${nodeY}`;
      const top = `${tipX + width},${nodeY - height / 2}`;
      const bottom = `${tipX + width},${nodeY + height / 2}`;
      return `${tip} ${top} ${bottom}`;
    }
    case 'top': {
      // Flow direction: +Y (toward node from top) - offset tip upward
      const tipY = nodeY - CHEVRON_OFFSET;
      const tip = `${nodeX},${tipY}`;
      const left = `${nodeX - height / 2},${tipY - width}`;
      const right = `${nodeX + height / 2},${tipY - width}`;
      return `${tip} ${left} ${right}`;
    }
    case 'bottom': {
      // Flow direction: -Y (toward node from bottom) - offset tip downward
      const tipY = nodeY + CHEVRON_OFFSET;
      const tip = `${nodeX},${tipY}`;
      const left = `${nodeX - height / 2},${tipY + width}`;
      const right = `${nodeX + height / 2},${tipY + width}`;
      return `${tip} ${left} ${right}`;
    }
    default:
      return '';
  }
}

/**
 * Check if a bundle needs a fallback arrowhead instead of chevron
 */
export function needsFallbackArrow(bundle: EdgeBundle): boolean {
  return bundle.bundleWidth < MIN_CHEVRON_THRESHOLD && bundle.type === 'target';
}

