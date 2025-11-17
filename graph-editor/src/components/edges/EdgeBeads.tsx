/**
 * EdgeBeads Component
 * 
 * Renders interactive beads along an edge spline for displaying edge parameters.
 * Each bead can be expanded to show detailed information or collapsed to a circle.
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { EdgeLabelRenderer } from 'reactflow';
import { Plug } from 'lucide-react';
import { buildBeadDefinitions, type BeadDefinition } from './edgeBeadHelpers';
import type { Graph, GraphEdge } from '../../types';
import { BEAD_MARKER_DISTANCE, BEAD_SPACING } from '../../lib/nodeEdgeConstants';

// Helper to extract text content from React node for SVG textPath
function extractTextFromReactNode(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (React.isValidElement(node)) {
    if (node.type === 'span') {
      // Extract text from span children
      const children = React.Children.toArray(node.props.children);
      return children.map(extractTextFromReactNode).join('');
    }
    // For other elements, extract children
    const children = React.Children.toArray(node.props.children);
    return children.map(extractTextFromReactNode).join('');
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromReactNode).join('');
  }
  return '';
}

// Measure text width more accurately using canvas
// This provides better estimates than character counting
function measureTextWidth(text: string, fontSize: number = 8, fontWeight: string = '500'): number {
  // Use a hidden canvas to measure text width
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return text.length * 4.5; // Fallback to character count
  
  context.font = `${fontWeight} ${fontSize}px sans-serif`;
  const metrics = context.measureText(text);
  return metrics.width;
}

interface EdgeBeadsProps {
  edgeId: string;
  edge: GraphEdge;
  path: SVGPathElement | null;
  graph: Graph | null;
  visibleScenarioIds: string[];
  visibleColorOrderIds: string[];
  scenarioColors: Map<string, string>;
  scenariosContext: any;
  whatIfDSL?: string | null;
  visibleStartOffset?: number;
  onDoubleClick?: () => void;
}

interface BeadState {
  [beadType: string]: boolean; // Map of bead type -> expanded state
}

// Hook version that returns object with svg and html parts
export function useEdgeBeads(props: EdgeBeadsProps): { svg: React.ReactNode; html: React.ReactNode } {
  const {
    edge,
    path,
    graph,
    visibleScenarioIds,
    visibleColorOrderIds,
    scenarioColors,
    scenariosContext,
    whatIfDSL,
    visibleStartOffset = 0,
    onDoubleClick
  } = props;
  
  // Bead expansion state (per-edge, per-bead type)
  const [beadStates, setBeadStates] = useState<Map<string, BeadState>>(new Map());
  
  // Get bead definitions - memoize with stable dependencies
  const beadDefinitions = useMemo(() => {
    if (!graph || !path || !scenariosContext) {
      return [];
    }
    
    // Create stable key for edge identification
    const edgeKey = edge.uuid || edge.id;
    if (!edgeKey) return [];
    
    // Ensure 'current' is always included if no scenarios are visible
    const effectiveVisibleIds = visibleScenarioIds.length > 0 
      ? visibleScenarioIds 
      : ['current'];
    
    const beads = buildBeadDefinitions(
      edge,
      graph,
      scenariosContext,
      effectiveVisibleIds,
      visibleColorOrderIds.length > 0 ? visibleColorOrderIds : ['current'],
      scenarioColors,
      whatIfDSL,
      visibleStartOffset
    );
    
    return beads;
  }, [
    edge.uuid || edge.id, // Stable edge identifier
    edge.p?.mean, // Probability value
    edge.p?.stdev, // Standard deviation
    edge.cost_gbp?.mean, // GBP cost
    edge.cost_time?.mean, // Time cost
    edge.case_variant, // Case variant name
    edge.conditional_p?.length, // Conditional probabilities count
    graph?.nodes?.length, // Graph structure indicator
    visibleScenarioIds.join(','), // Visible scenarios (stable string)
    visibleColorOrderIds.join(','), // Color order (stable string)
    whatIfDSL, // What-If DSL
    visibleStartOffset, // Visible start offset
  ]);
  
  // Get expansion state for a specific bead
  const getBeadExpanded = useCallback((bead: BeadDefinition): boolean => {
    const edgeState = beadStates.get(edge.uuid || edge.id);
    if (!edgeState) {
      return bead.expanded; // Use default
    }
    const key = `${bead.type}-${bead.index}`;
    return edgeState[key] ?? bead.expanded;
  }, [beadStates, edge]);
  
  // Toggle bead expansion
  const toggleBead = useCallback((bead: BeadDefinition) => {
    setBeadStates(prev => {
      const newMap = new Map(prev);
      const edgeId = edge.uuid || edge.id;
      const edgeState = newMap.get(edgeId) || {};
      const key = `${bead.type}-${bead.index}`;
      const newState = { ...edgeState };
      newState[key] = !getBeadExpanded(bead);
      newMap.set(edgeId, newState);
      return newMap;
    });
  }, [edge, getBeadExpanded]);
  
  if (!path) {
    console.log('[EdgeBeads] No path element');
    return null;
  }
  
  if (beadDefinitions.length === 0) {
    console.log('[EdgeBeads] No bead definitions for edge', edge.uuid || edge.id);
    return null;
  }
  
  const pathLength = path.getTotalLength();
  if (!pathLength || pathLength <= 0) {
    console.log('[EdgeBeads] Invalid path length:', pathLength);
    return null;
  }
  
  // Get path ID for textPath reference (must be unique per edge)
  const pathId = `bead-path-${edge.uuid || edge.id}`;
  const pathD = path.getAttribute('d') || '';
  
  // Spacing along the spline is cumulative per bead
  // Use shared constants from nodeEdgeConstants.ts
  let currentDistance = visibleStartOffset + BEAD_MARKER_DISTANCE;
  
  const svgBeads: React.ReactNode[] = [];
  const htmlBeads: React.ReactNode[] = [];
  
  beadDefinitions.forEach((bead) => {
    const expanded = getBeadExpanded(bead);
    
    // Position this bead at current distance along spline
    const distance = Math.min(currentDistance, pathLength * 0.9); // Clamp to path
    const point = path.getPointAtLength(distance);
    
    if (!point || isNaN(point.x) || isNaN(point.y)) {
      console.warn('[EdgeBeads] Invalid point at distance', distance, 'for bead', bead.type);
      return;
    }
    
    if (expanded) {
      // Expanded bead: lozenge with text along spline using SVG textPath
      const hasPlug = bead.hasParameterConnection;
      
      // Get text content (without plug icon - will render separately)
      const textContent = typeof bead.displayText === 'string' 
        ? bead.displayText 
        : extractTextFromReactNode(bead.displayText);
      
      // Create unique path ID for this bead's textPath
      const beadPathId = `${pathId}-bead-${bead.index}`;
      
      // Calculate lozenge dimensions
      const LOZENGE_HEIGHT = 14; // Match collapsed bead diameter
      const LOZENGE_PADDING = 4; // Padding on each side (increased for larger text)
      // Measure text width accurately using canvas
      const measuredTextWidth = measureTextWidth(textContent, 9, '500'); // Increased from 8px to 9px
      // Add space for plug icon if present (~10px)
      const plugIconWidth = hasPlug ? 10 : 0;
      // Reduce width by 20% to fix overestimation; treat this as the FULL lozenge length
      const lozengeLength = (measuredTextWidth + LOZENGE_PADDING * 2 + plugIconWidth) * 1;
      // Stroke START is fixed at this bead's distance; lozenge grows forward only
      const strokeStartDistance = distance;
      const textStartDistance = strokeStartDistance + LOZENGE_PADDING;
      const textEndDistance = Math.min(strokeStartDistance + lozengeLength - LOZENGE_PADDING, pathLength * 0.9);
      
      // Calculate plug icon position (after text)
      const plugIconDistance = textEndDistance;
      const plugIconPoint = path.getPointAtLength(Math.min(plugIconDistance, pathLength * 0.9));
      
      // Calculate tangent angle for icon rotation
      const iconAngle = plugIconPoint ? (() => {
        const beforePoint = path.getPointAtLength(Math.max(0, plugIconDistance - 1));
        const afterPoint = path.getPointAtLength(Math.min(pathLength, plugIconDistance + 1));
        return Math.atan2(afterPoint.y - beforePoint.y, afterPoint.x - beforePoint.x) * 180 / Math.PI;
      })() : 0;
      
      // Get text color for plug icon (use first colored segment or default to white)
      const getTextColor = (): string => {
        if (typeof bead.displayText === 'string') {
          return '#FFFFFF';
        }
        // Extract first color from ReactNode
        const extractFirstColor = (node: React.ReactNode): string => {
          if (typeof node === 'string' || typeof node === 'number') {
            return '#FFFFFF';
          } else if (React.isValidElement(node)) {
            if (node.type === 'span' && node.props.style?.color) {
              let color = node.props.style.color;
              // Never use black - convert to white
              if (color === '#000000' || color === 'black' || color === '#374151') {
                color = '#FFFFFF';
              }
              return color;
            }
            const children = React.Children.toArray(node.props.children);
            for (const child of children) {
              const color = extractFirstColor(child);
              if (color && color !== '#FFFFFF') return color;
            }
          } else if (Array.isArray(node)) {
            for (const item of node) {
              const color = extractFirstColor(item);
              if (color && color !== '#FFFFFF') return color;
            }
          }
          return '#FFFFFF';
        };
        return extractFirstColor(bead.displayText);
      };
      const plugIconColor = getTextColor();
      
      // Render colored text segments in SVG
      // SVG textPath can contain tspan elements for colored text
      const renderColoredText = () => {
        if (typeof bead.displayText === 'string') {
          return bead.displayText;
        }
        
        // Default text color: always use bright colors (white) on dark backgrounds, never black
        const defaultTextColor = '#FFFFFF';
        
        // Helper to lighten a color (increase lightness) - but keep it saturated enough to be distinguishable
        const lightenColor = (color: string): string => {
          // If already white or invalid, return as-is
          if (color === '#FFFFFF' || color === '#fff' || color === 'white' || !color.startsWith('#')) {
            return color;
          }
          
          // Convert hex to RGB
          const hex = color.replace('#', '');
          const r = parseInt(hex.substring(0, 2), 16);
          const g = parseInt(hex.substring(2, 4), 16);
          const b = parseInt(hex.substring(4, 6), 16);
          
          // Convert to HSL
          const rNorm = r / 255;
          const gNorm = g / 255;
          const bNorm = b / 255;
          const max = Math.max(rNorm, gNorm, bNorm);
          const min = Math.min(rNorm, gNorm, bNorm);
          let h = 0, s = 0, l = (max + min) / 2;
          
          if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
              case rNorm: h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6; break;
              case gNorm: h = ((bNorm - rNorm) / d + 2) / 6; break;
              case bNorm: h = ((rNorm - gNorm) / d + 4) / 6; break;
            }
          }
          
          // Increase lightness, but slightly less aggressively so colors don't wash out
          // Target: at least 60% lightness, or +20% if already bright
          l = Math.min(0.9, Math.max(0.6, l + 0.2));
          
          // Convert back to RGB
          const c = (1 - Math.abs(2 * l - 1)) * s;
          const x = c * (1 - Math.abs((h * 6) % 2 - 1));
          const m = l - c / 2;
          let rNew = 0, gNew = 0, bNew = 0;
          
          if (h < 1/6) { rNew = c; gNew = x; bNew = 0; }
          else if (h < 2/6) { rNew = x; gNew = c; bNew = 0; }
          else if (h < 3/6) { rNew = 0; gNew = c; bNew = x; }
          else if (h < 4/6) { rNew = 0; gNew = x; bNew = c; }
          else if (h < 5/6) { rNew = x; gNew = 0; bNew = c; }
          else { rNew = c; gNew = 0; bNew = x; }
          
          rNew = Math.round((rNew + m) * 255);
          gNew = Math.round((gNew + m) * 255);
          bNew = Math.round((bNew + m) * 255);
          
          return `#${[rNew, gNew, bNew].map(x => x.toString(16).padStart(2, '0')).join('')}`;
        };
        
        // Extract text and colors from ReactNode
        const extractTextAndColors = (node: React.ReactNode): Array<{ text: string; color: string }> => {
          const result: Array<{ text: string; color: string }> = [];
          
          if (typeof node === 'string' || typeof node === 'number') {
            result.push({ text: String(node), color: defaultTextColor });
          } else if (React.isValidElement(node)) {
            if (node.type === 'span') {
              // Use the span's color, but ensure it's bright (never black) and lighten it
              let color = node.props.style?.color || defaultTextColor;
              // Never use black - convert to white
              if (color === '#000000' || color === 'black' || color === '#374151') {
                color = '#FFFFFF';
              } else {
                // Lighten the color to make it brighter
                color = lightenColor(color);
              }
              const children = React.Children.toArray(node.props.children);
              children.forEach(child => {
                const extracted = extractTextAndColors(child);
                extracted.forEach(item => {
                  result.push({ text: item.text, color });
                });
              });
            } else {
              const children = React.Children.toArray(node.props.children);
              children.forEach(child => {
                const extracted = extractTextAndColors(child);
                result.push(...extracted);
              });
            }
          } else if (Array.isArray(node)) {
            node.forEach(item => {
              const extracted = extractTextAndColors(item);
              result.push(...extracted);
            });
          }
          
          return result;
        };
        
        const segments = extractTextAndColors(bead.displayText);
        
        // Render as tspan elements within textPath
        return segments.map((seg, idx) => {
          const tspan = (
            <tspan key={idx} fill={seg.color} dx={idx === 0 ? 0 : undefined}>
              {seg.text}
            </tspan>
          );
          return tspan;
        });
      };
      
      svgBeads.push(
        <g 
          key={`bead-expanded-${bead.type}-${bead.index}`}
          style={{ cursor: 'pointer', pointerEvents: 'all' }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleBead(bead);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onDoubleClick?.();
          }}
        >
          <defs>
            <path id={beadPathId} d={pathD} />
          </defs>
          
          {/* Background lozenge - rounded edges along path */}
          <use
            href={`#${beadPathId}`}
            stroke={bead.backgroundColor}
            strokeWidth={LOZENGE_HEIGHT}
            strokeLinecap="round"
            strokeDasharray={`${lozengeLength} ${pathLength}`}
            strokeDashoffset={-strokeStartDistance}
            fill="none"
            opacity={bead.backgroundColor === '#000000' ? '0.6' : '0.85'} // 60% opacity for black params
            style={{
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.15))',
            }}
          />
          
          {/* Text along the path - render with scenario colors using tspan */}
          <text
            style={{
              fontSize: '9px', // Increased from 8px
              fontWeight: '500',
              fill: '#FFFFFF', // Always white/bright text on dark grey or colored backgrounds
            }}
            dominantBaseline="middle"
            dy="0"
          >
            <textPath
              href={`#${beadPathId}`}
              startOffset={`${(textStartDistance / pathLength) * 100}%`}
            >
              {renderColoredText()}
            </textPath>
          </text>
          
          {/* Plug icon after text (if parameter connection exists) */}
          {hasPlug && plugIconPoint && (
            <g
              transform={`translate(${plugIconPoint.x}, ${plugIconPoint.y}) rotate(${iconAngle})`}
              style={{ pointerEvents: 'none' }}
            >
              <foreignObject
                x={-5}
                y={-5}
                width={10}
                height={10}
                style={{ overflow: 'visible' }}
              >
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  width: '10px',
                  height: '10px'
                }}>
                  <Plug 
                    size={10} 
                    strokeWidth={2}
                    color="#FFFFFF"
                    style={{ 
                      filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.3))'
                    }}
                  />
                </div>
              </foreignObject>
            </g>
          )}
        </g>
      );
      
      // Advance currentDistance based on this lozenge's end + spacing
      const lozengeEndDistance = strokeStartDistance + lozengeLength;
      currentDistance = lozengeEndDistance + BEAD_SPACING;
    } else {
      // Collapsed bead: use the SAME geometry path as lozenges, but with no content width.
      // Conceptually: WIDTH = BASE_WIDTH (caps + padding), CONTENT_WIDTH = 0.
      const LOZENGE_HEIGHT = 14;
      const LOZENGE_PADDING = 0;
      const beadPathId = `${pathId}-bead-collapsed-${bead.index}`;

      // Base width for a bead (no text): just padding on each side, scaled the same way
      const baseWidth = (LOZENGE_PADDING * 2) * 0.8;
      const strokeStartDistance = distance;
      const strokeLength = baseWidth;

      svgBeads.push(
        <g 
          key={`bead-collapsed-${bead.type}-${bead.index}`}
          style={{ cursor: 'pointer', pointerEvents: 'all' }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleBead(bead);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onDoubleClick?.();
          }}
        >
          <defs>
            <path id={beadPathId} d={pathD} />
          </defs>
          
          {/* Collapsed bead: short lozenge segment with same stroke geometry as expanded ones */}
          <use
            href={`#${beadPathId}`}
            stroke={bead.backgroundColor}
            strokeWidth={LOZENGE_HEIGHT}
            strokeLinecap="round"
            strokeDasharray={`${strokeLength} ${pathLength}`}
            strokeDashoffset={-strokeStartDistance}
            fill="none"
            opacity={bead.backgroundColor === '#000000' ? '0.6' : '0.85'}
            style={{
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.15))',
            }}
          />
        </g>
      );
      
      // Advance currentDistance: bead occupies baseWidth along the path
      currentDistance = strokeStartDistance + baseWidth + BEAD_SPACING;
    }
  });
  
  return {
    svg: svgBeads.length > 0 ? (
      <g className="edge-beads-svg" style={{ zIndex: 10000, pointerEvents: 'all' }}>
        <defs>
          <path id={pathId} d={pathD} />
        </defs>
        {svgBeads}
      </g>
    ) : null,
    html: htmlBeads.length > 0 ? htmlBeads : null
  };
}

// Component wrapper to avoid calling hook conditionally
// Memoize to prevent re-renders when props haven't changed
// ATOMIC RESTORATION: Now uses shouldSuppress flag (from context) instead of edge.data
export const EdgeBeadsRenderer = React.memo(function EdgeBeadsRenderer(props: EdgeBeadsProps & { visibleStartOffset?: number }) {
  const { path, visibleStartOffset = 0, ...restProps } = props;
  
  // Memoize the hook result to prevent unnecessary recalculations
  const beadsResult = useEdgeBeads({
    ...restProps,
    path,
    visibleStartOffset
  });
  
  return (
    <>
      {/* SVG beads rendered in edge SVG */}
      {beadsResult.svg}
      {/* HTML beads rendered in EdgeLabelRenderer */}
      <EdgeLabelRenderer>
        {beadsResult.html}
      </EdgeLabelRenderer>
    </>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function to prevent re-renders when only path reference changes
  // but actual values are the same
  // ATOMIC RESTORATION: Include shouldSuppress so beads re-render when visibility changes
  return (
    prevProps.edgeId === nextProps.edgeId &&
    prevProps.visibleScenarioIds?.join(',') === nextProps.visibleScenarioIds?.join(',') &&
    prevProps.visibleColorOrderIds?.join(',') === nextProps.visibleColorOrderIds?.join(',') &&
    prevProps.whatIfDSL === nextProps.whatIfDSL &&
    // Compare edge properties that matter
    prevProps.edge?.uuid === nextProps.edge?.uuid &&
    prevProps.edge?.p?.mean === nextProps.edge?.p?.mean &&
    prevProps.edge?.p?.stdev === nextProps.edge?.p?.stdev &&
    prevProps.edge?.cost_gbp?.mean === nextProps.edge?.cost_gbp?.mean &&
    prevProps.edge?.cost_time?.mean === nextProps.edge?.cost_time?.mean &&
    prevProps.edge?.case_variant === nextProps.edge?.case_variant &&
    prevProps.edge?.conditional_p?.length === nextProps.edge?.conditional_p?.length &&
    // Graph structure indicator
    prevProps.graph?.nodes?.length === nextProps.graph?.nodes?.length
  );
});


