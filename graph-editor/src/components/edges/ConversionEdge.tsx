import React, { useState, useCallback } from 'react';
import { EdgeProps, getBezierPath, EdgeLabelRenderer, useReactFlow, MarkerType, Handle, Position, getSmoothStepPath } from 'reactflow';
import { useGraphStore } from '@/lib/useGraphStore';

interface ConversionEdgeData {
  id: string;
  probability: number;
  stdev?: number;
  locked?: boolean;
  description?: string;
  costs?: {
    monetary?: {
      value: number;
      stdev?: number;
      distribution?: string;
      currency?: string;
    };
    time?: {
      value: number;
      stdev?: number;
      distribution?: string;
      units?: string;
    };
  };
  weight_default?: number;
  case_variant?: string; // Name of the variant this edge represents
  case_id?: string; // Reference to parent case node
  onUpdate: (id: string, data: Partial<ConversionEdgeData>) => void;
  onDelete: (id: string) => void;
  onReconnect?: (id: string, newSource?: string, newTarget?: string) => void;
  onDoubleClick?: (id: string, field: string) => void;
  onSelect?: (id: string) => void;
  calculateWidth?: () => number;
  sourceOffsetX?: number;
  sourceOffsetY?: number;
  targetOffsetX?: number;
  targetOffsetY?: number;
  scaledWidth?: number;
  isHighlighted?: boolean;
}

export default function ConversionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  source,
  target,
}: EdgeProps<ConversionEdgeData>) {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const { deleteElements, setEdges, getNodes } = useReactFlow();
  const { whatIfAnalysis } = useGraphStore();
  
  // Get variant weight for case edges (respecting what-if analysis)
  const getVariantWeight = () => {
    if (data?.case_id && data?.case_variant) {
      const nodes = getNodes();
      const caseNode = nodes.find((n: any) => n.data?.case?.id === data.case_id);
      if (caseNode) {
        const variant = caseNode.data?.case?.variants?.find((v: any) => v.name === data.case_variant);
        let weight = variant?.weight || 0;
        
        // Apply what-if analysis override
        if (whatIfAnalysis && whatIfAnalysis.caseNodeId === caseNode.id) {
          weight = data.case_variant === whatIfAnalysis.selectedVariant ? 1.0 : 0.0;
        }
        
        return weight;
      }
    }
    return null;
  };
  
  const variantWeight = getVariantWeight();
  const isCaseEdge = data?.case_id || data?.case_variant;


  // Apply offsets to source and target positions for Sankey-style visualization
  const sourceOffsetX = data?.sourceOffsetX || 0;
  const sourceOffsetY = data?.sourceOffsetY || 0;
  const targetOffsetX = data?.targetOffsetX || 0;
  const targetOffsetY = data?.targetOffsetY || 0;
  
  const adjustedSourceX = sourceX + sourceOffsetX;
  const adjustedSourceY = sourceY + sourceOffsetY;
  const adjustedTargetX = targetX + targetOffsetX;
  const adjustedTargetY = targetY + targetOffsetY;

  // Debug logging for offset application
  if (Math.abs(sourceOffsetX) > 0.1 || Math.abs(sourceOffsetY) > 0.1 || Math.abs(targetOffsetX) > 0.1 || Math.abs(targetOffsetY) > 0.1) {
    console.log(`Edge ${id}: source offset=(${sourceOffsetX.toFixed(1)}, ${sourceOffsetY.toFixed(1)}), target offset=(${targetOffsetX.toFixed(1)}, ${targetOffsetY.toFixed(1)})`);
  }


  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: adjustedSourceX,
    sourceY: adjustedSourceY,
    sourcePosition,
    targetX: adjustedTargetX,
    targetY: adjustedTargetY,
    targetPosition,
  });

  // Helper function to get point on Bézier curve at parameter t
  const getBezierPoint = (t: number, sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;
    
    return {
      x: mt3 * sx + 3 * mt2 * t * c1x + 3 * mt * t2 * c2x + t3 * ex,
      y: mt3 * sy + 3 * mt2 * t * c1y + 3 * mt * t2 * c2y + t3 * ey
    };
  };

  // Helper function to calculate arc length of a cubic Bézier curve up to parameter tMax
  const calculateBezierLengthToT = (sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number, tMax: number): number => {
    const steps = 100;
    let length = 0;
    const actualSteps = Math.floor(steps * tMax);
    
    for (let i = 0; i < actualSteps; i++) {
      const t1 = i / steps;
      const t2 = (i + 1) / steps;
      
      const p1 = getBezierPoint(t1, sx, sy, c1x, c1y, c2x, c2y, ex, ey);
      const p2 = getBezierPoint(t2, sx, sy, c1x, c1y, c2x, c2y, ex, ey);
      
      length += Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
    }
    
    return length;
  };

  // Helper function to calculate arc length of a cubic Bézier curve (full length)
  const calculateBezierLength = (sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number): number => {
    return calculateBezierLengthToT(sx, sy, c1x, c1y, c2x, c2y, ex, ey, 1.0);
  };

  // Calculate arrow positions along the path
  const arrowPositions = React.useMemo(() => {
    if (!data?.calculateWidth) return [];
    
    try {
      // Extract first 8 numbers from the path: M sx,sy C c1x,c1y c2x,c2y ex,ey
      const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
      if (!nums || nums.length < 8) return [];
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);

      const lerp = (a: number, b: number, tt: number) => a + (b - a) * tt;

      // Calculate multiple positions along the curve using correct algorithmic approach
      const positions: { x: number; y: number; angle: number }[] = [];
      
      // Calculate actual arc length of the Bézier curve (not just Euclidean distance)
      const pathLength = calculateBezierLength(sx, sy, c1x, c1y, c2x, c2y, ex, ey);
      
      // Algorithm: Place arrows at L/2 +/- nY (while avoiding first X and last X pixels)
      const excludePixels = 14; // Exclude 14 pixels from each end (20 * 0.7)
      const arrowSpacing = 28; // Y = spacing between arrows (40 * 0.7)
      const L = pathLength;
      const L_half = L / 2;
      
      console.log(`Edge ${id}: L=${L.toFixed(1)}px, L/2=${L_half.toFixed(1)}px, excludePixels=${excludePixels}px`);
      
      // Helper function to find t value for a given arc length distance
      const findTForArcLength = (targetLength: number): number => {
        if (targetLength <= 0) return 0;
        if (targetLength >= L) return 1;
        
        // Binary search for the t value that gives us the target arc length
        let t = targetLength / L; // Initial guess (linear approximation)
        let low = 0;
        let high = 1;
        
        for (let i = 0; i < 20; i++) { // 20 iterations should be enough
          const currentLength = calculateBezierLengthToT(sx, sy, c1x, c1y, c2x, c2y, ex, ey, t);
          
          if (Math.abs(currentLength - targetLength) < 0.1) {
            return t; // Close enough
          }
          
          if (currentLength < targetLength) {
            low = t;
            t = (t + high) / 2;
          } else {
            high = t;
            t = (low + t) / 2;
          }
        }
        
        return t;
      };
      
      // Place arrows at L/2 +/- nY, but only if they're within valid range
      let n = 0;
      while (true) {
        // Calculate positions: L/2 + nY and L/2 - nY
        const pos1 = L_half + (n * arrowSpacing);
        const pos2 = L_half - (n * arrowSpacing);
        
        // Check if positions are valid (not in excluded areas)
        const pos1Valid = pos1 >= excludePixels && pos1 <= (L - excludePixels);
        const pos2Valid = pos2 >= excludePixels && pos2 <= (L - excludePixels);
        
        // If neither position is valid, we're done
        if (!pos1Valid && !pos2Valid) break;
        
        // Add valid positions
        if (pos1Valid) {
          const t1 = findTForArcLength(pos1);
          const point1 = calculatePointOnCurve(t1, sx, sy, c1x, c1y, c2x, c2y, ex, ey, lerp);
          if (point1) positions.push(point1);
        }
        
        if (pos2Valid && n > 0) { // Don't duplicate the center arrow
          const t2 = findTForArcLength(pos2);
          const point2 = calculatePointOnCurve(t2, sx, sy, c1x, c1y, c2x, c2y, ex, ey, lerp);
          if (point2) positions.push(point2);
        }
        
        n++;
      }
      
      console.log(`Edge ${id}: placed ${positions.length} arrows`);
      
      // Helper function to calculate point and angle on curve
      function calculatePointOnCurve(t: number, sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number, lerp: (a: number, b: number, tt: number) => number) {
        // De Casteljau to get point and tangent at t
        const p0x = sx, p0y = sy;
        const p1x = c1x, p1y = c1y;
        const p2x = c2x, p2y = c2y;
        const p3x = ex, p3y = ey;

        const p01x = lerp(p0x, p1x, t);
        const p01y = lerp(p0y, p1y, t);
        const p12x = lerp(p1x, p2x, t);
        const p12y = lerp(p1y, p2y, t);
        const p23x = lerp(p2x, p3x, t);
        const p23y = lerp(p2y, p3y, t);

        const p012x = lerp(p01x, p12x, t);
        const p012y = lerp(p01y, p12y, t);
        const p123x = lerp(p12x, p23x, t);
        const p123y = lerp(p12y, p23y, t);

        const p0123x = lerp(p012x, p123x, t);
        const p0123y = lerp(p012y, p123y, t);

        // Calculate tangent for arrow direction
        const tangentX = p123x - p012x;
        const tangentY = p123y - p012y;
        const angle = Math.atan2(tangentY, tangentX) * (180 / Math.PI);

        return { x: p0123x, y: p0123y, angle };
      }
      
      return positions;
    } catch {
      return [];
    }
  }, [edgePath, adjustedTargetX, adjustedTargetY, data?.calculateWidth]);

  // Calculate the arrow position at 75% along the path (for single arrow mode)
  const arrowPosition = React.useMemo(() => {
    try {
      // Extract first 8 numbers from the path: M sx,sy C c1x,c1y c2x,c2y ex,ey
      const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
      if (!nums || nums.length < 8) return { x: adjustedTargetX, y: adjustedTargetY, angle: 0 };
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);

      const t = 0.75; // position arrow at 75% of the curve

      const lerp = (a: number, b: number, tt: number) => a + (b - a) * tt;

      // De Casteljau to get point and tangent at t
      const p0x = sx, p0y = sy;
      const p1x = c1x, p1y = c1y;
      const p2x = c2x, p2y = c2y;
      const p3x = ex, p3y = ey;

      const p01x = lerp(p0x, p1x, t);
      const p01y = lerp(p0y, p1y, t);
      const p12x = lerp(p1x, p2x, t);
      const p12y = lerp(p1y, p2y, t);
      const p23x = lerp(p2x, p3x, t);
      const p23y = lerp(p2y, p3y, t);

      const p012x = lerp(p01x, p12x, t);
      const p012y = lerp(p01y, p12y, t);
      const p123x = lerp(p12x, p23x, t);
      const p123y = lerp(p12y, p23y, t);

      const p0123x = lerp(p012x, p123x, t);
      const p0123y = lerp(p012y, p123y, t);

      // Calculate tangent for arrow direction
      const tangentX = p123x - p012x;
      const tangentY = p123y - p012y;
      const angle = Math.atan2(tangentY, tangentX) * (180 / Math.PI);

      return { x: p0123x, y: p0123y, angle };
    } catch {
      return { x: adjustedTargetX, y: adjustedTargetY, angle: 0 };
    }
  }, [edgePath, adjustedTargetX, adjustedTargetY]);




  // Edge color logic: purple for case edges, gray for normal, highlight for connected selected nodes
  const getEdgeColor = () => {
    if (selected) return '#007bff';
    if (data?.isHighlighted) return '#ff6b35'; // orange highlight for edges connecting selected nodes
    if (data?.probability === undefined || data?.probability === null) return '#ff6b6b';
    if (isCaseEdge) return '#C4B5FD'; // purple-300 for case edges
    return '#999'; // gray for normal edges
  };

  const handleDelete = useCallback(() => {
    if (confirm('Delete this edge?')) {
      deleteElements({ edges: [{ id }] });
    }
  }, [id, deleteElements]);

  const handleDoubleClick = useCallback(() => {
    // First select the edge to update the properties panel
    if (data?.onSelect) {
      data.onSelect(id);
    }
    
    // Then focus the probability field
    if (data?.onDoubleClick) {
      data.onDoubleClick(id, 'probability');
    }
  }, [id, data]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowContextMenu(true);
  }, []);

  const handleReconnectSource = useCallback(() => {
    if (data?.onReconnect) {
      const newSource = prompt('Enter new source node ID:', source);
      if (newSource && newSource !== source) {
        data.onReconnect(id, newSource, undefined);
      }
    }
    setShowContextMenu(false);
  }, [data, id, source]);

  const handleReconnectTarget = useCallback(() => {
    if (data?.onReconnect) {
      const newTarget = prompt('Enter new target node ID:', target);
      if (newTarget && newTarget !== target) {
        data.onReconnect(id, undefined, newTarget);
      }
    }
    setShowContextMenu(false);
  }, [data, id, target]);

  // Close context menu when clicking elsewhere
  React.useEffect(() => {
    const handleClickOutside = () => setShowContextMenu(false);
    if (showContextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showContextMenu]);

  return (
    <>
      <defs>
        <marker
          id={`arrow-${id}`}
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="3"
          orient={arrowPosition.angle}
          markerUnits="strokeWidth"
        >
          <path
            d="M0,0 L0,6 L9,3 z"
            fill={getEdgeColor()}
          />
        </marker>
      </defs>
      
      <path
        id={id}
        style={{
          stroke: getEdgeColor(),
          strokeWidth: data?.scaledWidth || (data?.calculateWidth ? data.calculateWidth() : (selected ? 3 : (data?.probability === undefined || data?.probability === null) ? 3 : 2)),
          fill: 'none',
          cursor: 'pointer',
          zIndex: selected ? 1000 : 1,
          strokeDasharray: (data?.probability === undefined || data?.probability === null) ? '5,5' : 'none',
          markerEnd: data?.calculateWidth ? 'none' : `url(#arrow-${id})`,
        }}
        className="react-flow__edge-path"
        d={edgePath}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
      />
      
      {/* Invisible wider path for easier selection */}
      <path
        id={`${id}-selection`}
        style={{
          stroke: 'transparent',
          strokeWidth: 20,
          fill: 'none',
          cursor: 'pointer',
          zIndex: selected ? 1000 : 1,
        }}
        className="react-flow__edge-path"
        d={edgePath}
        onDoubleClick={handleDoubleClick}
      />
      
      {/* Repeating arrows along the path - only show when using custom scaling */}
      {data?.calculateWidth && arrowPositions.map((pos, index) => (
        <g key={index}>
          {/* Arrow background (canvas color) */}
          <polygon
            points={`${pos.x - 6},${pos.y - 4} ${pos.x - 6},${pos.y + 4} ${pos.x + 6},${pos.y}`}
            fill="#f8f9fa"
            stroke={getEdgeColor()}
            strokeWidth="1"
            transform={`rotate(${pos.angle} ${pos.x} ${pos.y})`}
            style={{ zIndex: selected ? 1000 : 1001 }}
          />
        </g>
      ))}
      
      {/* Single arrow at 75% position - only show when NOT using custom scaling */}
      {!data?.calculateWidth && (
        <polygon
          points={`${arrowPosition.x - 4},${arrowPosition.y - 3} ${arrowPosition.x - 4},${arrowPosition.y + 3} ${arrowPosition.x + 4},${arrowPosition.y}`}
          fill={getEdgeColor()}
          transform={`rotate(${arrowPosition.angle} ${arrowPosition.x} ${arrowPosition.y})`}
          style={{ zIndex: selected ? 1000 : 1 }}
        />
      )}
      
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: selected ? '#007bff' : 'rgba(255, 255, 255, 0.85)',
            color: selected ? '#fff' : '#333',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: 'bold',
            border: selected ? 'none' : '1px solid #ddd',
            cursor: 'pointer',
            minWidth: '40px',
            textAlign: 'center',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          }}
          onDoubleClick={handleDoubleClick}
          title="Double-click to edit probability in properties panel"
        >
          <div style={{ textAlign: 'center' }}>
            {(data?.probability === undefined || data?.probability === null) ? (
              <div style={{ 
                fontWeight: 'bold', 
                color: '#ff6b6b',
                fontSize: '11px',
                background: '#fff5f5',
                padding: '2px 6px',
                borderRadius: '3px',
                border: '1px solid #ff6b6b'
              }}>
                ⚠️ No Probability
              </div>
            ) : isCaseEdge && variantWeight !== null ? (
              // Case edge: show variant weight (purple) and sub-route probability (gray)
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <div style={{ 
                  fontWeight: 'bold', 
                  fontSize: '11px',
                  color: '#8B5CF6',
                  background: '#F3F0FF',
                  padding: '2px 4px',
                  borderRadius: '2px'
                }}>
                  {Math.round(variantWeight * 100)}%
                </div>
                <div style={{ 
                  fontWeight: 'bold', 
                  fontSize: '10px',
                  color: '#666'
                }}>
                  × {Math.round((data?.probability || 1.0) * 100)}%
                </div>
              </div>
            ) : (
              <div style={{ fontWeight: 'bold' }}>
                {Math.round((data?.probability || 0) * 100)}%
                {data?.stdev && data.stdev > 0 && (
                  <span style={{ fontSize: '10px', color: '#666', marginLeft: '4px' }}>
                    ±{Math.round(data.stdev * 100)}%
                  </span>
                )}
              </div>
            )}
            {data?.costs && (data.costs.monetary || data.costs.time) && (
              <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
                {data.costs.monetary && (
                  <div>
                    £{typeof data.costs.monetary === 'object' ? data.costs.monetary.value : data.costs.monetary}
                    {typeof data.costs.monetary === 'object' && data.costs.monetary.currency && ` ${data.costs.monetary.currency}`}
                  </div>
                )}
                {data.costs.time && (
                  <div>
                    {typeof data.costs.time === 'object' ? data.costs.time.value : data.costs.time}
                    {typeof data.costs.time === 'object' ? (data.costs.time.units || 'days') : 'days'}
                  </div>
                )}
              </div>
            )}
            {data?.description && (
              <div style={{ 
                fontSize: '9px', 
                color: '#888', 
                marginTop: '2px',
                fontStyle: 'italic',
                maxWidth: '80px',
                textAlign: 'center',
                lineHeight: '1.2'
              }}>
                {data.description}
              </div>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
      
      {selected && (
        <>
          {/* Delete button */}
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY + 20}px)`,
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '50%',
              width: '16px',
              height: '16px',
              cursor: 'pointer',
              fontSize: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
            }}
            onClick={handleDelete}
            title="Delete edge"
          >
            ×
          </div>
          
          {/* Draggable source handle */}
          <div
            style={{
              position: 'absolute',
              left: adjustedSourceX - 6,
              top: adjustedSourceY - 6,
              width: '12px',
              height: '12px',
              background: '#007bff',
              border: '2px solid #fff',
              borderRadius: '50%',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              cursor: 'grab',
              zIndex: 1000,
            }}
            title="Drag to reconnect source"
          />
          
          {/* Draggable target handle */}
          <div
            style={{
              position: 'absolute',
              left: adjustedTargetX - 6,
              top: adjustedTargetY - 6,
              width: '12px',
              height: '12px',
              background: '#28a745',
              border: '2px solid #fff',
              borderRadius: '50%',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              cursor: 'grab',
              zIndex: 1000,
            }}
            title="Drag to reconnect target"
          />
        </>
      )}

      {/* Context Menu */}
      {showContextMenu && (
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 1000,
            minWidth: '120px',
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '12px',
              borderBottom: '1px solid #eee',
            }}
            onClick={handleReconnectSource}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
          >
            Reconnect Source
          </div>
          <div
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '12px',
              borderBottom: '1px solid #eee',
            }}
            onClick={handleReconnectTarget}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
          >
            Reconnect Target
          </div>
          <div
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#dc3545',
            }}
            onClick={() => {
              handleDelete();
              setShowContextMenu(false);
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
          >
            Delete Edge
          </div>
        </div>
      )}
    </>
  );
}
