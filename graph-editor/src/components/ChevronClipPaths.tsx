import React from 'react';
import { EdgeBundle, generateChevronClipPath } from '../lib/chevronClipping';
import { Node } from 'reactflow';

interface ChevronClipPathsProps {
  bundles: EdgeBundle[];
  nodes: Node[];
  frameId?: number;
}

/**
 * Renders SVG clipPath definitions for chevron arrows at edge bundle boundaries.
 * This component should be rendered inside ReactFlow's Panel to inject into the SVG.
 * Positions are calculated dynamically from current node positions on each render.
 */
export const ChevronClipPaths: React.FC<ChevronClipPathsProps> = ({ bundles, nodes, frameId }) => {
  // Cache last known node sizes to avoid transient undefined width/height frames
  const lastNodeSizeRef = React.useRef(new Map<string, { width: number; height: number }>());
  // Update cache with any measured sizes on this render
  nodes.forEach(n => {
    const w = (n as any).width;
    const h = (n as any).height;
    if (typeof w === 'number' && typeof h === 'number') {
      lastNodeSizeRef.current.set(n.id, { width: w, height: h });
    }
  });

  const CURVE_ALLOWANCE = 30; // pixels
  
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        {bundles.map((bundle, idx) => {
          let node = nodes.find(n => n.id === bundle.nodeId);
          if (!node) return null;
          // If width/height are missing (transient), fallback to last known to avoid 1-frame jump
          const fallbackSize = lastNodeSizeRef.current.get(node.id);
          const needSizeFallback = (!(node as any).width || !(node as any).height) && !!fallbackSize;
          const nodeForCalc = needSizeFallback
            ? ({
                ...node,
                width: fallbackSize?.width,
                height: fallbackSize?.height,
              } as Node)
            : node;
          // Size fallback handled silently
          const clipPathPoints = generateChevronClipPath(bundle, nodeForCalc);
          
          if (!clipPathPoints) {
            return null; // Skip thin bundles
          }
          
          // Parse triangle points
          const points = clipPathPoints.split(' ');
          const [p1, p2, p3] = points.map(p => {
            const [x, y] = p.split(',');
            return { x: parseFloat(x), y: parseFloat(y) };
          });
          
          if (bundle.type === 'source') {
            // SOURCE: Subtract triangle from visible area (everything visible EXCEPT triangle)
            // Using evenodd: large rect + triangle = rect with triangle hole
            const trianglePath = points.map((p, i) => {
              const [x, y] = p.split(',');
              return i === 0 ? `M${x} ${y}` : `L${x} ${y}`;
            }).join(' ') + ' Z';
            
            return (
              <clipPath key={bundle.id} id={`chevron-${bundle.id}`} clipPathUnits="userSpaceOnUse">
                <path
                  d={`M-9999 -9999 L19999 -9999 L19999 19999 L-9999 19999 Z ${trianglePath}`}
                  clipRule="evenodd"
                />
              </clipPath>
            );
          } else {
            // TARGET: Everything visible EXCEPT (bbox - triangle)
            // = Everything visible EXCEPT bbox, PLUS triangle
            // = large_rect - bbox + triangle
            // Using evenodd with 3 paths creates this automatically
            
            // Extend chevron base points along their rays (tip->base) to preserve edge angles
            const ray2 = { x: p2.x - p1.x, y: p2.y - p1.y };
            const ray2Len = Math.sqrt(ray2.x * ray2.x + ray2.y * ray2.y) || 1;
            const u2x = ray2.x / ray2Len;
            const u2y = ray2.y / ray2Len;
            const p2e = { x: p2.x + u2x * CURVE_ALLOWANCE, y: p2.y + u2y * CURVE_ALLOWANCE };

            const ray3 = { x: p3.x - p1.x, y: p3.y - p1.y };
            const ray3Len = Math.sqrt(ray3.x * ray3.x + ray3.y * ray3.y) || 1;
            const u3x = ray3.x / ray3Len;
            const u3y = ray3.y / ray3Len;
            const p3e = { x: p3.x + u3x * CURVE_ALLOWANCE, y: p3.y + u3y * CURVE_ALLOWANCE };

            // Calculate bounding box from extended triangle and extend perpendicular to flow
            let minX = Math.min(p1.x, p2e.x, p3e.x);
            let maxX = Math.max(p1.x, p2e.x, p3e.x);
            let minY = Math.min(p1.y, p2e.y, p3e.y);
            let maxY = Math.max(p1.y, p2e.y, p3e.y);
            
            if (bundle.face === 'left' || bundle.face === 'right') {
              // Vertical stack: extend up/down to include steep curves
              minY -= CURVE_ALLOWANCE;
              maxY += CURVE_ALLOWANCE;
            } else {
              // Horizontal stack: extend left/right to include steep curves
              minX -= CURVE_ALLOWANCE;
              maxX += CURVE_ALLOWANCE;
            }
            
            // Build triangle path from extended points
            const trianglePath = `M${p1.x} ${p1.y} L${p2e.x} ${p2e.y} L${p3e.x} ${p3e.y} Z`;
            
            const bboxPath = `M${minX} ${minY} L${maxX} ${minY} L${maxX} ${maxY} L${minX} ${maxY} Z`;
            
            // Large canvas - bbox + triangle = everything except bbox-minus-triangle
            return (
              <clipPath key={bundle.id} id={`chevron-${bundle.id}`} clipPathUnits="userSpaceOnUse">
                <path
                  d={`M-9999 -9999 L19999 -9999 L19999 19999 L-9999 19999 Z ${bboxPath} ${trianglePath}`}
                  clipRule="evenodd"
                />
              </clipPath>
            );
          }
        })}
      </defs>
    </svg>
  );
};

