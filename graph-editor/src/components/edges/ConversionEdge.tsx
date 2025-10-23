import React, { useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { EdgeProps, getBezierPath, EdgeLabelRenderer, useReactFlow, MarkerType, Handle, Position, getSmoothStepPath } from 'reactflow';
import { useGraphStore } from '@/lib/useGraphStore';
import Tooltip from '@/components/Tooltip';
import { getConditionalColor, isConditionalEdge } from '@/lib/conditionalColors';
import { computeEffectiveEdgeProbability, getEdgeWhatIfDisplay } from '@/lib/whatIf';

interface ConversionEdgeData {
  id: string;
  slug?: string;
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
  onReconnect?: (id: string, newSource?: string, newTarget?: string, newTargetHandle?: string, newSourceHandle?: string) => void;
  onDoubleClick?: (id: string, field: string) => void;
  onSelect?: (id: string) => void;
  calculateWidth?: () => number;
  sourceOffsetX?: number;
  sourceOffsetY?: number;
  targetOffsetX?: number;
  targetOffsetY?: number;
  scaledWidth?: number;
  isHighlighted?: boolean;
  highlightDepth?: number;
  isSingleNodeHighlight?: boolean;
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
  const [isDraggingSource, setIsDraggingSource] = useState(false);
  const [isDraggingTarget, setIsDraggingTarget] = useState(false);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [adjustedLabelPosition, setAdjustedLabelPosition] = useState<{ x: number; y: number } | null>(null);
  const pathRef = React.useRef<SVGPathElement>(null);

  // Generate tooltip content
  const getTooltipContent = () => {
    if (!data) return 'No data available';
    
    const lines: string[] = [];
    
    // Edge slug (more useful than UUID)
    if (data.slug) {
      lines.push(`Edge: ${data.slug}`);
    }
    
    // Probability info
    lines.push(`Probability: ${(data.probability * 100).toFixed(1)}%`);
    if (data.stdev) {
      lines.push(`Std Dev: ${(data.stdev * 100).toFixed(1)}%`);
    }
    
    // Case edge specific info - show variant weight
    if (data.case_variant) {
      lines.push(`\nCase Variant: ${data.case_variant}`);
      if (data.case_id) {
        lines.push(`Case ID: ${data.case_id}`);
        // Find the case node and get variant weight
        const sourceNode = graph?.nodes.find((n: any) => n.id === source);
        if (sourceNode?.type === 'case' && sourceNode?.case?.id === data.case_id) {
          const variant = sourceNode.case.variants?.find((v: any) => v.name === data.case_variant);
          if (variant) {
            lines.push(`Variant Weight: ${(variant.weight * 100).toFixed(1)}%`);
          }
        }
      }
    }
    
    // Conditional probabilities
    if (fullEdge?.conditional_p && fullEdge.conditional_p.length > 0) {
      lines.push(`\nConditional Probabilities:`);
      for (const cond of fullEdge.conditional_p) {
        const nodeNames = cond.condition.visited.map((nodeId: string) => {
          const node = graph?.nodes.find((n: any) => n.id === nodeId);
          return node?.slug || node?.label || nodeId;
        }).join(', ');
        const condProb = ((cond.p.mean ?? 0) * 100).toFixed(1);
        lines.push(`  • p | visited(${nodeNames}): ${condProb}%`);
        if (cond.p.stdev) {
          lines.push(`    σ: ${(cond.p.stdev * 100).toFixed(1)}%`);
        }
      }
    }
    
    // Description
    if (data.description) {
      lines.push(`\nDescription: ${data.description}`);
    }
    
    // Costs
    if (data.costs) {
      lines.push('\nCosts:');
      if (data.costs.monetary) {
        const currency = data.costs.monetary.currency || 'USD';
        lines.push(`  Monetary: ${data.costs.monetary.value} ${currency}`);
        if (data.costs.monetary.stdev) {
          lines.push(`    (±${data.costs.monetary.stdev} ${currency})`);
        }
      }
      if (data.costs.time) {
        const units = data.costs.time.units || 'minutes';
        lines.push(`  Time: ${data.costs.time.value} ${units}`);
        if (data.costs.time.stdev) {
          lines.push(`    (±${data.costs.time.stdev} ${units})`);
        }
      }
    }
    
    // Weight default
    if (data.weight_default !== undefined) {
      lines.push(`\nDefault Weight: ${data.weight_default}`);
    }
    
    return lines.join('\n');
  };
  const { deleteElements, setEdges, getNodes, screenToFlowPosition } = useReactFlow();
  const { whatIfAnalysis, graph } = useGraphStore();
  // Subscribe to version directly to force re-renders
  const overridesVersion = useGraphStore(state => state.whatIfOverrides._version);
  
  // Get the full edge object from graph (needed for tooltips and colors)
  const fullEdge = graph?.edges.find((e: any) => e.id === id);
  
  // UNIFIED: Compute effective probability using shared logic
  const effectiveProbability = useMemo(() => {
    const currentOverrides = useGraphStore.getState().whatIfOverrides;
    return computeEffectiveEdgeProbability(graph, id, currentOverrides, whatIfAnalysis);
  }, [graph, id, whatIfAnalysis, overridesVersion]);
  
  // UNIFIED: Get what-if display info using shared logic
  const whatIfDisplay = useMemo(() => {
    const currentOverrides = useGraphStore.getState().whatIfOverrides;
    return getEdgeWhatIfDisplay(graph, id, currentOverrides, whatIfAnalysis);
  }, [graph, id, whatIfAnalysis, overridesVersion]);
  
  // Calculate stroke width using useMemo to enable CSS transitions
  const strokeWidth = useMemo(() => {
    // Use scaledWidth if available (for mass-based scaling modes), otherwise fall back to calculateWidth
    if (data?.scaledWidth !== undefined) {
      if (id && id.includes('node-2')) {
        console.log(`[RENDER] Edge ${id}: using scaledWidth=${data.scaledWidth}, prob=${data?.probability}`);
      }
      return data.scaledWidth;
    }
    if (data?.calculateWidth) {
      const width = data.calculateWidth();
      if (id && id.includes('node-2')) {
        console.log(`[RENDER] Edge ${id}: using calculateWidth=${width}, prob=${data?.probability}`);
      }
      return width;
    }
    if (selected) return 3;
    if (data?.probability === undefined || data?.probability === null) return 3;
    return 2;
  }, [data?.scaledWidth, data?.calculateWidth, data?.probability, selected, graph, overridesVersion]);
  
  // Update stroke-width via DOM to enable CSS transitions
  React.useEffect(() => {
    if (pathRef.current) {
      pathRef.current.style.strokeWidth = `${strokeWidth}px`;
    }
  }, [strokeWidth]);
  
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



  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: adjustedSourceX,
    sourceY: adjustedSourceY,
    sourcePosition,
    targetX: adjustedTargetX,
    targetY: adjustedTargetY,
    targetPosition,
  });

  // Helper function to get point on Bézier curve at parameter t (for label positioning)
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
      
      // Arrow calculation
      
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
      
      // Arrow placement complete
      
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

  // Collision detection and avoidance for edge labels
  const { getEdges } = useReactFlow();
  
  React.useEffect(() => {
    // Skip collision detection for selected edges (reconnection handles are more important)
    if (selected) {
      setAdjustedLabelPosition(null);
      return;
    }
    
    // Debounce collision detection to avoid excessive recalculations
    const timeoutId = setTimeout(() => {
      const otherEdges = getEdges().filter(e => e.id !== id);
      const nodes = getNodes();

      // Extract Bézier parameters from this edge's path
      const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
      if (!nums || nums.length < 8) {
        setAdjustedLabelPosition(null);
        return;
      }
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);

      // Try different positions along the curve
      const candidatePositions = [0.5, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75];
      const labelWidth = 60; // Approximate label width
      const labelHeight = 30; // Approximate label height
      
      // Collision weights (higher = worse)
      const LABEL_COLLISION_WEIGHT = 100;  // Highest priority: avoid other labels
      const NODE_COLLISION_WEIGHT = 10;    // Second priority: avoid nodes
      const EDGE_COLLISION_WEIGHT = 1;     // Lowest priority: avoid edge paths
      
      // Function to check if two rectangles overlap
      const rectanglesOverlap = (x1: number, y1: number, w1: number, h1: number,
                                  x2: number, y2: number, w2: number, h2: number): boolean => {
        return !(x1 + w1 / 2 < x2 - w2 / 2 || 
                 x1 - w1 / 2 > x2 + w2 / 2 || 
                 y1 + h1 / 2 < y2 - h2 / 2 || 
                 y1 - h1 / 2 > y2 + h2 / 2);
      };
      
      // Function to check if a label position collides with other edge labels
      const checkLabelCollisions = (lx: number, ly: number): number => {
        let collisions = 0;
        for (const edge of otherEdges) {
          // Get the label element for this edge
          const labelElements = document.querySelectorAll(`[style*="translate(${edge.id}"]`);
          for (const labelEl of Array.from(labelElements)) {
            const rect = (labelEl as HTMLElement).getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              // Convert screen coordinates to flow coordinates (approximate)
              if (rectanglesOverlap(lx, ly, labelWidth, labelHeight, 
                                   rect.left + rect.width / 2, rect.top + rect.height / 2, 
                                   rect.width, rect.height)) {
                collisions++;
              }
            }
          }
        }
        return collisions * LABEL_COLLISION_WEIGHT;
      };
      
      // Function to check if a label position collides with nodes
      const checkNodeCollisions = (lx: number, ly: number): number => {
        let collisions = 0;
        for (const node of nodes) {
          const nodeWidth = (node.data as any)?.type === 'case' ? 96 : 120;
          const nodeHeight = (node.data as any)?.type === 'case' ? 96 : 120;
          const nodeX = node.position.x + nodeWidth / 2;
          const nodeY = node.position.y + nodeHeight / 2;
          
          if (rectanglesOverlap(lx, ly, labelWidth, labelHeight, 
                               nodeX, nodeY, nodeWidth, nodeHeight)) {
            collisions++;
          }
        }
        return collisions * NODE_COLLISION_WEIGHT;
      };
      
      // Function to check if a label position collides with an edge path
      const checkEdgePathCollisions = (lx: number, ly: number): number => {
        let collisions = 0;
        for (const edge of otherEdges) {
          const edgeElement = document.getElementById(edge.id);
          if (edgeElement) {
            const pathData = edgeElement.getAttribute('d');
            if (pathData) {
              const pathNums = pathData.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
              if (pathNums && pathNums.length >= 8) {
                const [esx, esy, ec1x, ec1y, ec2x, ec2y, eex, eey] = pathNums.slice(0, 8).map(Number);
                
                // Check multiple points along the edge for intersection with label box
                for (let t = 0; t <= 1; t += 0.1) {
                  const point = getBezierPoint(t, esx, esy, ec1x, ec1y, ec2x, ec2y, eex, eey);
                  
                  if (
                    point.x >= lx - labelWidth / 2 &&
                    point.x <= lx + labelWidth / 2 &&
                    point.y >= ly - labelHeight / 2 &&
                    point.y <= ly + labelHeight / 2
                  ) {
                    collisions++;
                    break; // One collision per edge is enough
                  }
                }
              }
            }
          }
        }
        return collisions * EDGE_COLLISION_WEIGHT;
      };

      // Find position with lowest collision score
      let bestPosition = { x: labelX, y: labelY };
      let minScore = Infinity;

      for (const t of candidatePositions) {
        const point = getBezierPoint(t, sx, sy, c1x, c1y, c2x, c2y, ex, ey);
        
        // Calculate weighted collision score
        const labelCollisions = checkLabelCollisions(point.x, point.y);
        const nodeCollisions = checkNodeCollisions(point.x, point.y);
        const edgeCollisions = checkEdgePathCollisions(point.x, point.y);
        const totalScore = labelCollisions + nodeCollisions + edgeCollisions;
        
        if (totalScore < minScore) {
          minScore = totalScore;
          bestPosition = point;
        }
        
        // If we found a position with no collisions, use it
        if (totalScore === 0) break;
      }

      // Only adjust if we found a better position (score improved)
      const defaultScore = checkLabelCollisions(labelX, labelY) + 
                          checkNodeCollisions(labelX, labelY) + 
                          checkEdgePathCollisions(labelX, labelY);
      
      if (minScore < defaultScore && (bestPosition.x !== labelX || bestPosition.y !== labelY)) {
        setAdjustedLabelPosition(bestPosition);
      } else {
        setAdjustedLabelPosition(null);
      }
    }, 100); // 100ms debounce

    return () => clearTimeout(timeoutId);
  }, [edgePath, labelX, labelY, id, getEdges, getNodes, selected]);

  // Use adjusted position if available, otherwise use default
  const finalLabelX = adjustedLabelPosition?.x ?? labelX;
  const finalLabelY = adjustedLabelPosition?.y ?? labelY;

  // Edge color logic: conditional colors, purple for case edges, gray for normal, highlight for connected selected nodes
  const getEdgeColor = () => {
    if (selected) {
      // Explicitly selected edge: 80% opacity
      return 'rgba(0, 123, 255, 0.8)'; // blue at 80%
    }
    if (data?.isHighlighted) {
      // Different opacity for different selection types:
      // - Single node (isSingleNodeHighlight=true): 30% fading with depth
      // - Multi-node topological (isSingleNodeHighlight=false): 50% solid
      let blackIntensity: number;
      
      if (data.isSingleNodeHighlight) {
        // Single node selection: Start at 30%, fade by 10% per hop
        const depth = data.highlightDepth || 0;
        blackIntensity = 0.3 * Math.pow(0.9, depth); // 30% × 0.9^depth
      } else {
        // Multi-node topological selection: 50% solid
        blackIntensity = 0.5;
      }
      
      // Get the base color for this edge type (underlying color)
      let baseColor = '#b3b3b3'; // default gray
      if (data?.probability === undefined || data?.probability === null) {
        baseColor = '#ff6b6b';
      } else if (fullEdge && isConditionalEdge(fullEdge)) {
        // Conditional edges get their conditional color
        baseColor = getConditionalColor(fullEdge) || '#4ade80'; // green-400 fallback
      } else {
        // Check if source node is a case node and inherit its color
        // This applies to both case variant edges AND normal edges downstream
        const sourceNode = graph?.nodes.find((n: any) => n.id === source);
        if (sourceNode?.type === 'case' && sourceNode?.layout?.color) {
          baseColor = sourceNode.layout.color;
        }
      }
      
      // Blend pure black with base color based on black intensity
      // blackIntensity = how much black, (1 - blackIntensity) = how much base color
      const black = { r: 0, g: 0, b: 0 }; // Pure black
      const baseColorRgb = hexToRgb(baseColor);
      
      const blendedR = Math.round(black.r * blackIntensity + baseColorRgb.r * (1 - blackIntensity));
      const blendedG = Math.round(black.g * blackIntensity + baseColorRgb.g * (1 - blackIntensity));
      const blendedB = Math.round(black.b * blackIntensity + baseColorRgb.b * (1 - blackIntensity));
      
      return `rgb(${blendedR}, ${blendedG}, ${blendedB})`;
    }
    if (data?.probability === undefined || data?.probability === null) return '#ff6b6b';
    
    // Check for conditional edges and apply conditional color
    if (fullEdge && isConditionalEdge(fullEdge)) {
      return getConditionalColor(fullEdge) || '#4ade80'; // green-400 fallback
    }
    
    // Check if source node is a case node and inherit its color
    // This applies to both case variant edges AND normal edges downstream
    const sourceNode = graph?.nodes.find((n: any) => n.id === source);
    if (sourceNode?.type === 'case' && sourceNode?.layout?.color) {
      return sourceNode.layout.color;
    }
    
    return '#b3b3b3'; // 15% lighter gray for normal edges
  };

  // Helper function to convert hex to RGB
  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 153, g: 153, b: 153 }; // fallback to gray
  };

  const handleDelete = useCallback(() => {
    deleteElements({ edges: [{ id }] });
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

  // Handle source handle drag
  const handleSourceMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Use the mouse position directly - this avoids coordinate system issues
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    
    // Source handle mousedown
    
    setIsDraggingSource(true);
    setDragPosition({ x: mouseX, y: mouseY });
  }, []);

  // Handle target handle drag
  const handleTargetMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Use the mouse position directly - this avoids coordinate system issues
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    
    // Target handle mousedown
    
    setIsDraggingTarget(true);
    setDragPosition({ x: mouseX, y: mouseY });
  }, []);

  // Handle mouse move during drag
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDraggingSource || isDraggingTarget) {
      e.preventDefault();
      const newPos = { x: e.clientX, y: e.clientY };
      // Mouse move
      setDragPosition(newPos);
    }
  }, [isDraggingSource, isDraggingTarget]);

  // Handle mouse up to complete drag
  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (isDraggingSource || isDraggingTarget) {
      // Convert screen position to flow position
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      
      // Find the node at this position
      const nodes = getNodes();
      const targetNode = nodes.find(node => {
        const nodeX = node.position.x;
        const nodeY = node.position.y;
        const nodeWidth = 120; // Standard node width (adjust for case nodes if needed)
        const nodeHeight = 120; // Standard node height
        
        return (
          flowPos.x >= nodeX &&
          flowPos.x <= nodeX + nodeWidth &&
          flowPos.y >= nodeY &&
          flowPos.y <= nodeY + nodeHeight
        );
      });

      if (targetNode && data?.onReconnect) {
        // Calculate which face of the node we're closest to
        const nodeX = targetNode.position.x;
        const nodeY = targetNode.position.y;
        const nodeWidth = 120;
        const nodeHeight = 120;
        
        // Calculate relative position within the node (0 to 1)
        const relX = (flowPos.x - nodeX) / nodeWidth;
        const relY = (flowPos.y - nodeY) / nodeHeight;
        
        // Calculate distances to all faces
        const faceDistances = [
          { face: 'left', distance: relX },
          { face: 'right', distance: 1 - relX },
          { face: 'top', distance: relY },
          { face: 'bottom', distance: 1 - relY }
        ];
        
        // Sort by distance (closest first)
        faceDistances.sort((a, b) => a.distance - b.distance);
        
        // Get existing edges to analyze face usage
        const allEdges = getEdges();
        const nodeId = targetNode.id;
        
        // Determine if we're connecting as input or output
        const isInputConnection = isDraggingTarget;
        const isOutputConnection = isDraggingSource;
        
        // Find best face with type preference
        let targetHandle: string = faceDistances[0].face; // fallback to closest
        
        for (const { face, distance } of faceDistances) {
          // Get all edges using this face (both input and output)
          const faceEdges = allEdges.filter(edge => {
            const sourceHandle = edge.sourceHandle || 'right-out';
            const targetHandle = edge.targetHandle || 'left';
            const sourceFace = sourceHandle.split('-')[0];
            const targetFace = targetHandle.split('-')[0];
            
            // Check if this face is used by any edge connected to this node
            return (edge.source === nodeId && sourceFace === face) || 
                   (edge.target === nodeId && targetFace === face);
          });
          
          if (faceEdges.length === 0) {
            // Empty face - use it
            targetHandle = face;
            break;
          }
          
          // Check if face is used consistently (all input or all output)
          const hasInputs = faceEdges.some(edge => edge.target === nodeId);
          const hasOutputs = faceEdges.some(edge => edge.source === nodeId);
          
          // If face is mixed (both inputs and outputs), skip it
          if (hasInputs && hasOutputs) {
            continue;
          }
          
          // If face has only inputs and we're adding an input, use it
          if (hasInputs && !hasOutputs && isInputConnection) {
            targetHandle = face;
            break;
          }
          
          // If face has only outputs and we're adding an output, use it
          if (hasOutputs && !hasInputs && isOutputConnection) {
            targetHandle = face;
            break;
          }
        }
        
        // Drop position analysis complete
        
        if (isDraggingSource) {
          // Reconnecting source
          data.onReconnect(id, targetNode.id, undefined, undefined, targetHandle);
        } else if (isDraggingTarget) {
          // Reconnecting target
          data.onReconnect(id, undefined, targetNode.id, targetHandle, undefined);
        }
      }

      setIsDraggingSource(false);
      setIsDraggingTarget(false);
      setDragPosition(null);
    }
  }, [isDraggingSource, isDraggingTarget, screenToFlowPosition, getNodes, data, id, source, target]);

  // Close context menu when clicking elsewhere
  React.useEffect(() => {
    const handleClickOutside = () => setShowContextMenu(false);
    if (showContextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showContextMenu]);

  // Add global mouse event listeners for dragging
  React.useEffect(() => {
    if (isDraggingSource || isDraggingTarget) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDraggingSource, isDraggingTarget, handleMouseMove, handleMouseUp]);

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
        ref={pathRef}
        id={id}
        style={{
          stroke: getEdgeColor(),
          fill: 'none',
          zIndex: selected ? 1000 : 1,
          strokeDasharray: (data?.probability === undefined || data?.probability === null) ? '5,5' : 'none',
          markerEnd: data?.calculateWidth ? 'none' : `url(#arrow-${id})`,
          transition: 'stroke-width 0.3s ease-in-out',
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
          zIndex: selected ? 1000 : 1,
          transition: 'stroke-width 0.3s ease-in-out',
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
            transform: `translate(-50%, -50%) translate(${finalLabelX}px,${finalLabelY}px)`,
            background: selected ? '#007bff' : 'rgba(255, 255, 255, 0.85)',
            color: selected ? '#fff' : '#333',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: 'bold',
            border: selected ? 'none' : '1px solid #ddd',
            minWidth: '40px',
            textAlign: 'center',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            pointerEvents: selected ? 'none' : 'auto',
          }}
          onDoubleClick={handleDoubleClick}
          onMouseEnter={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
            setShowTooltip(true);
          }}
          onMouseLeave={() => {
            setShowTooltip(false);
          }}
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
            ) : whatIfDisplay?.isOverridden ? (
              // UNIFIED: Any what-if override (conditional or case variant)
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <div style={{ 
                  fontWeight: 'bold', 
                  fontSize: '11px',
                  color: whatIfDisplay.type === 'conditional' ? '#10b981' : '#8B5CF6',
                  background: whatIfDisplay.type === 'conditional' ? '#f0fdf4' : '#F3F0FF',
                  padding: '2px 4px',
                  borderRadius: '2px'
                }}>
                  {Math.round((effectiveProbability || 0) * 100)}%
                </div>
                <div style={{ 
                  fontWeight: 'normal', 
                  fontSize: '9px',
                  color: '#666'
                }}>
                  {whatIfDisplay.displayLabel || '🔬 What-If'}
                </div>
              </div>
            ) : isCaseEdge ? (
              // Case edge without override: show variant weight (purple) and sub-route probability (gray)
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <div style={{ 
                  fontWeight: 'bold', 
                  fontSize: '11px',
                  color: '#8B5CF6',
                  background: '#F3F0FF',
                  padding: '2px 4px',
                  borderRadius: '2px'
                }}>
                  {Math.round((effectiveProbability || 0) * 100)}%
                </div>
                <div style={{ 
                  fontWeight: 'bold', 
                  fontSize: '10px',
                  color: '#666'
                }}>
                  variant weight
                </div>
              </div>
            ) : (
              <div style={{ fontWeight: 'bold' }}>
                {Math.round((effectiveProbability || 0) * 100)}%
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
        {selected && (
          <>
              {/* Delete button */}
              <div
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${finalLabelX}px,${finalLabelY + 20}px)`,
                background: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '50%',
                width: '16px',
                height: '16px',
                fontSize: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
                pointerEvents: 'none',
              }}
              title="Delete edge (use context menu)"
            >
              ×
            </div>
            
            {/* ReactFlow's built-in reconnection handles will appear automatically for selected edges with reconnectable=true */}
          </>
        )}
      </EdgeLabelRenderer>

      {/* Edge tooltip - rendered as portal */}
      {showTooltip && ReactDOM.createPortal(
        <div
          style={{
            position: 'fixed',
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
            transform: 'translate(-50%, -100%)',
            marginTop: '-8px',
            background: '#1a1a1a',
            color: '#ffffff',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            lineHeight: '1.4',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            border: '1px solid #333',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxWidth: '300px',
            zIndex: 10000,
            pointerEvents: 'none',
          }}
        >
          {getTooltipContent()}
        </div>,
        document.body
      )}

      {/* Context Menu */}
      {showContextMenu && (
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${finalLabelX}px,${finalLabelY}px)`,
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
