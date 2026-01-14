/**
 * EdgeBeads Component
 * 
 * Renders interactive beads along an edge spline for displaying edge parameters.
 * Each bead can be expanded to show detailed information or collapsed to a circle.
 */

import React, { useMemo, useRef, useState, useCallback } from 'react';
import { EdgeLabelRenderer } from 'reactflow';
import { Plug, ZapOff } from 'lucide-react';
import { buildBeadDefinitions, type BeadDefinition } from './edgeBeadHelpers';
import type { Graph, GraphEdge } from '../../types';
import type { ScenarioVisibilityMode } from '../../types';
import { BEAD_MARKER_DISTANCE, BEAD_SPACING, BEAD_FONT_SIZE, BEAD_HEIGHT, BEAD_ARRIVAL_FACE_OFFSET } from '../../lib/nodeEdgeConstants';
import { hasAnyEdgeQueryOverride, listOverriddenFlagPaths } from '../../utils/overrideFlags';

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
  pathD?: string; // Path d attribute - use this instead of reading from DOM (avoids stale data)
  graph: Graph | null;
  scenarioOrder: string[];
  visibleScenarioIds: string[];
  visibleColourOrderIds: string[];
  scenarioColours: Map<string, string>;
  scenariosContext: any;
  whatIfDSL?: string | null;
  visibleStartOffset?: number;
  visibleEndOffset?: number; // Offset from path end for target node face geometry
  onDoubleClick?: () => void;
  useSankeyView?: boolean;
  edgeWidth?: number;
  /** Scenario visibility mode (E/F/F+E) affects which probability basis is shown on the probability bead */
  getScenarioVisibilityMode?: (scenarioId: string) => ScenarioVisibilityMode;
  /** Stable key that changes when scenario visibility modes change (forces recompute) */
  visibilityModesKey?: string;
}

interface BeadState {
  [beadType: string]: boolean; // Map of bead type -> expanded state
}

// Hook version that returns object with svg and html parts
export function useEdgeBeads(props: EdgeBeadsProps): { svg: React.ReactNode; html: React.ReactNode } {
  const {
    edge,
    path,
    pathD,
    graph,
    scenarioOrder,
    visibleScenarioIds,
    visibleColourOrderIds,
    scenarioColours,
    scenariosContext,
    whatIfDSL,
    visibleStartOffset = 0,
    visibleEndOffset = 0,
    onDoubleClick,
    useSankeyView = false,
    edgeWidth = 0,
    getScenarioVisibilityMode,
    visibilityModesKey
  } = props;
  
  // Create a memoized path element from pathD for accurate position calculations
  // This avoids reading from the DOM ref which may have stale data during render
  const computePath = useMemo(() => {
    if (pathD) {
      // Create a temporary SVG path element with the current pathD
      const svgNs = 'http://www.w3.org/2000/svg';
      const tempPath = document.createElementNS(svgNs, 'path');
      tempPath.setAttribute('d', pathD);
      return tempPath;
    }
    return path;
  }, [pathD, path]);
  
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
      scenarioOrder,
      effectiveVisibleIds,
      visibleColourOrderIds.length > 0 ? visibleColourOrderIds : ['current'],
      scenarioColours,
      whatIfDSL,
      visibleStartOffset,
      getScenarioVisibilityMode
    );
    
    return beads;
  }, [
    edge.uuid || edge.id, // Stable edge identifier
    edge.p?.mean, // Probability value
    edge.p?.stdev, // Standard deviation
    // Basis fields for probability bead when in F or E mode
    edge.p?.forecast?.mean,
    edge.p?.forecast?.stdev,
    edge.p?.evidence?.mean,
    edge.p?.evidence?.stdev,
    edge.p?.mean_overridden, // Override flag for probability
    edge.p?.stdev_overridden, // Override flag for probability stdev
    edge.p?.distribution_overridden, // Override flag for probability distribution
    edge.p?.latency?.latency_parameter_overridden, // Override flag for latency enablement
    edge.p?.latency?.anchor_node_id_overridden, // Override flag for anchor node
    edge.p?.latency?.t95_overridden, // Override flag for t95
    edge.p?.latency?.path_t95_overridden, // Override flag for path_t95
    edge.cost_gbp?.mean, // GBP cost
    edge.cost_gbp?.mean_overridden, // Override flag for GBP cost
    (edge.cost_gbp as any)?.stdev_overridden, // Override flag for GBP cost stdev
    (edge.cost_gbp as any)?.distribution_overridden, // Override flag for GBP cost distribution
    edge.labour_cost?.mean, // Time cost
    edge.labour_cost?.mean_overridden, // Override flag for time cost
    (edge.labour_cost as any)?.stdev_overridden, // Override flag for time cost stdev
    (edge.labour_cost as any)?.distribution_overridden, // Override flag for time cost distribution
    edge.case_variant, // Case variant name
    edge.conditional_p?.length, // Conditional probabilities count
    JSON.stringify(edge.conditional_p ?? []), // Conditional entries (override flags / query overrides)
    edge.query_overridden, // Override flag for query
    (edge as any).n_query_overridden, // Override flag for n_query
    // IMPORTANT: Some override flags live on fields we don't explicitly list here (e.g. connection_overridden).
    // Include a compact override signature so EdgeBeads re-renders for ANY override changes.
    listOverriddenFlagPaths(edge).join('|'),
    hasAnyEdgeQueryOverride(edge),
    graph?.nodes?.length, // Graph structure indicator
    graph?.metadata?.updated_at, // Bump when graph data (e.g. case variants) changes
    // scenariosContext changes reference frequently - use stable indicators instead
    scenariosContext?.scenarios?.map(s => s.id).join(','), // Scenario IDs (stable string)
    JSON.stringify(scenariosContext?.baseParams?.edges?.[edge.uuid || edge.id || '']), // Edge-specific params
    scenarioOrder.join(','), // Scenario order (stable string)
    visibleScenarioIds.join(','), // Visible scenarios (stable string)
    visibleColourOrderIds.join(','), // Colour order (stable string)
    Array.from(scenarioColours.entries()).join(','), // Scenario colours (stable string)
    whatIfDSL, // What-If DSL
    visibleStartOffset, // Visible start offset
    visibilityModesKey, // Visibility modes (stable string)
  ]);

  
  // Get expansion state for a specific bead
  const getBeadExpanded = useCallback((bead: BeadDefinition): boolean => {
    const edgeId = edge.uuid || edge.id || '';
    const edgeState = beadStates.get(edgeId);
    if (!edgeState) {
      return bead.expanded; // Use default
    }
    const key = `${bead.type}-${bead.index}`;
    return edgeState[key] ?? bead.expanded;
  }, [beadStates, edge.uuid, edge.id]);
  
  // Toggle bead expansion
  const toggleBead = useCallback((bead: BeadDefinition) => {
    setBeadStates(prev => {
      const newMap = new Map(prev);
      const edgeId = edge.uuid || edge.id || '';
      const edgeState = newMap.get(edgeId) || {};
      const key = `${bead.type}-${bead.index}`;
      const newState = { ...edgeState };
      newState[key] = !getBeadExpanded(bead);
      newMap.set(edgeId, newState);
      return newMap;
    });
  }, [edge.uuid, edge.id, getBeadExpanded]);
  
  if (!computePath) {
    console.log('[EdgeBeads] No path element');
    return { svg: null, html: null };
  }
  
  if (beadDefinitions.length === 0) {
    console.log('[EdgeBeads] No bead definitions for edge', edge.uuid || edge.id);
    return { svg: null, html: null };
  }
  
  const pathLength = computePath.getTotalLength();
  if (!pathLength || pathLength <= 0) {
    console.log('[EdgeBeads] Invalid path length:', pathLength);
    return { svg: null, html: null };
  }
  
  // Get path ID for textPath reference (must be unique per edge)
  const pathId = `bead-path-${edge.uuid || edge.id}`;
  // Use pathD prop if provided, otherwise read from DOM element
  const pathDAttr = pathD || computePath.getAttribute('d') || '';
  
  // In Sankey view, beads follow the top edge spline of the ribbon
  // Apply a small inward offset to position beads just below the top line
  const VERTICAL_PADDING = 8; // Margin below the top edge
  let sankeyVerticalOffset = 0;
  
  if (useSankeyView && edgeWidth > 0) {
    // Offset beads inward from top edge: min(bead_height + vertical_padding, edge_width) / 2
    sankeyVerticalOffset = Math.min(BEAD_HEIGHT + VERTICAL_PADDING, edgeWidth) / 2;
  }
  
  const svgBeads: React.ReactNode[] = [];
  const htmlBeads: React.ReactNode[] = [];
  
  // Track current distance for left-aligned beads (probability / cost / etc.)
  // Right-aligned latency beads do NOT advance this cursor – they are positioned
  // relative to the target node.
  let currentDistance = visibleStartOffset  + BEAD_MARKER_DISTANCE;
  
  beadDefinitions.forEach((bead) => {
    const expanded = getBeadExpanded(bead);
    
    // We need bead length to position right-aligned beads correctly, so the
    // distance calculation happens inside the expanded/collapsed branches.
    if (expanded) {
      // Expanded bead: lozenge with text along spline using SVG textPath
      const hasPlug = bead.hasParameterConnection;
      const hasOverride = bead.isOverridden;
      
      // Get text content (without plug icon - will render separately)
      const textContent = typeof bead.displayText === 'string' 
        ? bead.displayText 
        : extractTextFromReactNode(bead.displayText);
      
      // Create unique path ID for this bead's textPath
      const beadPathId = `${pathId}-bead-${bead.index}`;
      
      // Calculate lozenge dimensions (BEAD_HEIGHT from constants)
      const LOZENGE_PADDING = 4; // Padding on each side (increased for larger text)
      const TEXT_TO_ICON_GAP = 8; // ← THIS controls spacing between text and first icon
      // Measure text width accurately using canvas
      const measuredTextWidth = measureTextWidth(textContent, BEAD_FONT_SIZE, '500');
      // Add space for icons (sized to match font)
      const plugIconWidth = hasPlug ? BEAD_FONT_SIZE : 0;
      const zapOffIconWidth = hasOverride ? BEAD_FONT_SIZE : 0;
      // Treat this as the FULL lozenge length along the path
      const lozengeLength = (measuredTextWidth + LOZENGE_PADDING * 2 + plugIconWidth + zapOffIconWidth) * 1;
      
      // Compute start distance along the path.
      // - Left-aligned: use currentDistance (cursor from source).
      // - Right-aligned: mirror pattern from path end using visibleEndOffset.
      let strokeStartDistance: number;
      if (bead.rightAligned) {
        // Right-aligned: position so RIGHT edge of lozenge clears target node.
        // visibleEndOffset accounts for target face geometry,
        // BEAD_ARRIVAL_FACE_OFFSET is an extra tweakable buffer (by eye).
        const bufferFromEnd = visibleEndOffset + BEAD_ARRIVAL_FACE_OFFSET;
        strokeStartDistance = pathLength - bufferFromEnd - lozengeLength;
      } else {
        // Left-aligned: use cursor from source
        strokeStartDistance = currentDistance;
      }
      
      const distance = strokeStartDistance;
      const textStartDistance = strokeStartDistance + LOZENGE_PADDING;
      const textEndDistance = strokeStartDistance + lozengeLength - LOZENGE_PADDING;
      
      // Calculate plug icon position (after text + gap)
      const plugIconDistance = strokeStartDistance + LOZENGE_PADDING + measuredTextWidth + TEXT_TO_ICON_GAP;
      const plugIconPoint = computePath.getPointAtLength(plugIconDistance);
      
      // Calculate tangent angle for icon rotation
      const iconAngle = plugIconPoint ? (() => {
        const beforePoint = computePath.getPointAtLength(Math.max(0, plugIconDistance - 1));
        const afterPoint = computePath.getPointAtLength(Math.min(pathLength, plugIconDistance + 1));
        return Math.atan2(afterPoint.y - beforePoint.y, afterPoint.x - beforePoint.x) * 180 / Math.PI;
      })() : 0;
      
      // Calculate text angle at start position to determine if text would be upside down
      const textAngle = (() => {
        const beforePoint = computePath.getPointAtLength(Math.max(0, textStartDistance - 1));
        const afterPoint = computePath.getPointAtLength(Math.min(pathLength, textStartDistance + 1));
        const angle = Math.atan2(afterPoint.y - beforePoint.y, afterPoint.x - beforePoint.x) * 180 / Math.PI;
        // Normalize to -180 to 180 range
        return angle;
      })();
      
      // Text is upside down if angle is between 90 and 270 degrees (or -90 to -270)
      const isTextUpsideDown = Math.abs(textAngle) > 90;
      
      // Get text colour for plug icon (use first coloured segment or default to white)
      const getTextColour = (): string => {
        if (typeof bead.displayText === 'string') {
          return '#FFFFFF';
        }
        // Extract first colour from ReactNode
        const extractFirstColour = (node: React.ReactNode): string => {
          if (typeof node === 'string' || typeof node === 'number') {
            return '#FFFFFF';
          } else if (React.isValidElement(node)) {
            if (node.type === 'span' && node.props.style?.color) {
              let colour = node.props.style.color;
              // Never use black - convert to white
              if (colour === '#000000' || colour === 'black' || colour === '#374151') {
                colour = '#FFFFFF';
              }
              return colour;
            }
            const children = React.Children.toArray(node.props.children);
            for (const child of children) {
              const colour = extractFirstColour(child);
              if (colour && colour !== '#FFFFFF') return colour;
            }
          } else if (Array.isArray(node)) {
            for (const item of node) {
              const colour = extractFirstColour(item);
              if (colour && colour !== '#FFFFFF') return colour;
            }
          }
          return '#FFFFFF';
        };
        return extractFirstColour(bead.displayText);
      };
      const plugIconColour = getTextColour();
      
      // Calculate perpendicular offset for Sankey view at bead position
      let transformOffset = '';
      const point = computePath.getPointAtLength(distance);
      if (!point || isNaN(point.x) || isNaN(point.y)) {
        console.warn('[EdgeBeads] Invalid point at distance', distance, 'for bead', bead.type);
        return;
      }
      if (sankeyVerticalOffset !== 0) {
        const delta = 1;
        const prevDist = Math.max(0, distance - delta);
        const nextDist = Math.min(pathLength, distance + delta);
        const prevPoint = computePath.getPointAtLength(prevDist);
        const nextPoint = computePath.getPointAtLength(nextDist);
        const dx = nextPoint.x - prevPoint.x;
        const dy = nextPoint.y - prevPoint.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          const perpX = -dy / len;
          const perpY = dx / len;
          const offsetX = perpX * sankeyVerticalOffset;
          const offsetY = perpY * sankeyVerticalOffset;
          transformOffset = `translate(${offsetX}, ${offsetY})`;
        }
      }
      
      // Render coloured text segments in SVG
      // SVG textPath can contain tspan elements for coloured text
      const renderColouredText = () => {
        if (typeof bead.displayText === 'string') {
          return bead.displayText;
        }
        
        // Default text colour: always use bright colours (white) on dark backgrounds, never black
        const defaultTextColour = '#FFFFFF';
        
        // Helper to lighten a colour (increase lightness) - but keep it saturated enough to be distinguishable
        const lightenColour = (colour: string): string => {
          // If already white or invalid, return as-is
          if (colour === '#FFFFFF' || colour === '#fff' || colour === 'white' || !colour.startsWith('#')) {
            return colour;
          }
          
          // Convert hex to RGB
          const hex = colour.replace('#', '');
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
          
          // Increase lightness, but slightly less aggressively so colours don't wash out
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
        
        // Extract text and colours from ReactNode
        const extractTextAndColours = (node: React.ReactNode): Array<{ text: string; colour: string }> => {
          const result: Array<{ text: string; colour: string }> = [];
          
          if (typeof node === 'string' || typeof node === 'number') {
            result.push({ text: String(node), colour: defaultTextColour });
          } else if (React.isValidElement(node)) {
            if (node.type === 'span') {
              // Use the span's color, but ensure it's bright (never black) and lighten it
              let colour = node.props.style?.color || defaultTextColour;
              // Never use black - convert to white
              if (colour === '#000000' || colour === 'black' || colour === '#374151') {
                colour = '#FFFFFF';
              } else {
                // Lighten the colour to make it brighter
                colour = lightenColour(colour);
              }
              const children = React.Children.toArray(node.props.children);
              children.forEach(child => {
                const extracted = extractTextAndColours(child);
                extracted.forEach(item => {
                  result.push({ text: item.text, colour });
                });
              });
            } else {
              const children = React.Children.toArray(node.props.children);
              children.forEach(child => {
                const extracted = extractTextAndColours(child);
                result.push(...extracted);
              });
            }
          } else if (Array.isArray(node)) {
            node.forEach(item => {
              const extracted = extractTextAndColours(item);
              result.push(...extracted);
            });
          }
          
          return result;
        };
        
        const segments = extractTextAndColours(bead.displayText);
        
        // Render as tspan elements within textPath
        return segments.map((seg, idx) => {
          const tspan = (
            <tspan key={idx} fill={seg.colour} dx={idx === 0 ? 0 : undefined}>
              {seg.text}
            </tspan>
          );
          return tspan;
        });
      };
      
      svgBeads.push(
        <g 
          key={`bead-expanded-${bead.type}-${bead.index}`}
          style={{ cursor: 'pointer', pointerEvents: 'painted' }}
          transform={transformOffset}
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
            <path id={beadPathId} d={pathDAttr} />
          </defs>
          
          {/* Background lozenge - rounded edges along path */}
          <use
            href={`#${beadPathId}`}
            stroke={bead.backgroundColor}
            strokeWidth={BEAD_HEIGHT}
            strokeLinecap="round"
            strokeDasharray={`${lozengeLength} ${pathLength}`}
            strokeDashoffset={-strokeStartDistance}
            fill="none"
            opacity={bead.backgroundColor === '#000000' ? '0.7' : '0.9'} // Slightly more opaque for readability
            style={{
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.15))',
              pointerEvents: 'painted', // Only capture events over painted (visible) stroke
            }}
          />
          
          {/* Text along the path - render with scenario colours using tspan */}
          {/* Calculate center point of text for rotation when upside down */}
          {(() => {
            // Get the midpoint of the text for rotation anchor
            const textMidDistance = (textStartDistance + textEndDistance) / 2;
            const textCenterPoint = computePath.getPointAtLength(textMidDistance);
            
            return (
              <g transform={isTextUpsideDown ? `rotate(180, ${textCenterPoint.x}, ${textCenterPoint.y})` : ''}>
                <text
                  style={{
                    fontSize: `${BEAD_FONT_SIZE}px`,
                    fontWeight: '500',
                    fill: '#FFFFFF', // Always white/bright text on dark grey or coloured backgrounds
                    pointerEvents: 'painted', // Only capture events over painted (visible) text, not the entire path
                  }}
                  dominantBaseline="middle"
                  dy="0"
                >
                  <textPath
                    href={`#${beadPathId}`}
                    startOffset={`${(textStartDistance / pathLength) * 100}%`}
                  >
                    {renderColouredText()}
                  </textPath>
                </text>
              </g>
            );
          })()}
          
          {/* Plug icon after text (if parameter connection exists) */}
          {hasPlug && plugIconPoint && (
            <g
              transform={`translate(${plugIconPoint.x}, ${plugIconPoint.y}) rotate(${isTextUpsideDown ? iconAngle + 180 : iconAngle})`}
              style={{ pointerEvents: 'none' }}
            >
              <foreignObject
                x={-BEAD_FONT_SIZE / 2}
                y={-BEAD_FONT_SIZE / 2}
                width={BEAD_FONT_SIZE}
                height={BEAD_FONT_SIZE}
                style={{ overflow: 'visible' }}
              >
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  width: `${BEAD_FONT_SIZE}px`,
                  height: `${BEAD_FONT_SIZE}px`
                }}>
                  <Plug 
                    size={BEAD_FONT_SIZE} 
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
          
          {/* ZapOff icon after plug (if overridden) */}
          {hasOverride && (() => {
            // Position ZapOff icon after plug (or after text if no plug)
            const zapOffDistance = hasPlug 
              ? plugIconDistance + plugIconWidth 
              : plugIconDistance;
            const zapOffPoint = computePath.getPointAtLength(zapOffDistance);
            
            // Calculate tangent angle for icon rotation
            const zapOffAngle = zapOffPoint ? (() => {
              const beforePoint = computePath.getPointAtLength(Math.max(0, zapOffDistance - 1));
              const afterPoint = computePath.getPointAtLength(Math.min(pathLength, zapOffDistance + 1));
              return Math.atan2(afterPoint.y - beforePoint.y, afterPoint.x - beforePoint.x) * 180 / Math.PI;
            })() : 0;
            
            return zapOffPoint && (
              <g
                transform={`translate(${zapOffPoint.x}, ${zapOffPoint.y}) rotate(${isTextUpsideDown ? zapOffAngle + 180 : zapOffAngle})`}
                style={{ pointerEvents: 'none' }}
              >
                <foreignObject
                  x={-BEAD_FONT_SIZE / 2}
                  y={-BEAD_FONT_SIZE / 2}
                  width={BEAD_FONT_SIZE}
                  height={BEAD_FONT_SIZE}
                  style={{ overflow: 'visible' }}
                >
                  <div
                    title={bead.overrideTooltip}
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center',
                      width: `${BEAD_FONT_SIZE}px`,
                      height: `${BEAD_FONT_SIZE}px`
                    }}
                  >
                    <ZapOff 
                      size={BEAD_FONT_SIZE} 
                      strokeWidth={2}
                      color="#FFFFFF"
                      style={{ 
                        filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.3))'
                      }}
                    />
                  </div>
                </foreignObject>
              </g>
            );
          })()}
        </g>
      );
      
      // Advance currentDistance based on this lozenge's end + spacing
      if (!bead.rightAligned) {
        const lozengeEndDistance = strokeStartDistance + lozengeLength;
        currentDistance = lozengeEndDistance + BEAD_SPACING;
      }
    } else {
      // Collapsed bead: use the SAME geometry path as lozenges, but with no content width.
      // Conceptually: WIDTH = BASE_WIDTH (caps + padding), CONTENT_WIDTH = 0.
      const LOZENGE_PADDING = 0;
      const beadPathId = `${pathId}-bead-collapsed-${bead.index}`;
      
      // Base width for a bead (no text): just padding on each side, scaled the same way
      const baseWidth = (LOZENGE_PADDING * 2) * 0.8;
      
      // Compute start distance along the path.
      // Same pattern as expanded beads.
      let strokeStartDistance: number;
      if (bead.rightAligned) {
        // Right-aligned: position so RIGHT edge clears target node.
        const bufferFromEnd = visibleEndOffset + BEAD_ARRIVAL_FACE_OFFSET;
        strokeStartDistance = pathLength - bufferFromEnd - baseWidth;
      } else {
        // Left-aligned: use cursor from source
        strokeStartDistance = currentDistance;
      }
      
      const distance = strokeStartDistance;
      const strokeLength = baseWidth;

      // Calculate perpendicular offset for Sankey view at bead position
      let transformOffset = '';
      const point = computePath.getPointAtLength(distance);
      if (!point || isNaN(point.x) || isNaN(point.y)) {
        console.warn('[EdgeBeads] Invalid point at distance', distance, 'for bead', bead.type);
        return;
      }
      if (sankeyVerticalOffset !== 0) {
        const delta = 1;
        const prevDist = Math.max(0, distance - delta);
        const nextDist = Math.min(pathLength, distance + delta);
        const prevPoint = computePath.getPointAtLength(prevDist);
        const nextPoint = computePath.getPointAtLength(nextDist);
        const dx = nextPoint.x - prevPoint.x;
        const dy = nextPoint.y - prevPoint.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          const perpX = -dy / len;
          const perpY = dx / len;
          const offsetX = perpX * sankeyVerticalOffset;
          const offsetY = perpY * sankeyVerticalOffset;
          transformOffset = `translate(${offsetX}, ${offsetY})`;
        }
      }
      
      svgBeads.push(
        <g 
          key={`bead-collapsed-${bead.type}-${bead.index}`}
          style={{ cursor: 'pointer', pointerEvents: 'painted' }}
          transform={transformOffset}
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
            <path id={beadPathId} d={pathDAttr} />
          </defs>
          
          {/* Collapsed bead: short lozenge segment with same stroke geometry as expanded ones */}
          <use
            href={`#${beadPathId}`}
            stroke={bead.backgroundColor}
            strokeWidth={BEAD_HEIGHT}
            strokeLinecap="round"
            strokeDasharray={`${strokeLength} ${pathLength}`}
            strokeDashoffset={-strokeStartDistance}
            fill="none"
            opacity={bead.backgroundColor === '#000000' ? '0.7' : '0.9'}
            style={{
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.15))',
              pointerEvents: 'painted', // Only capture events over painted (visible) stroke
            }}
          />
        </g>
      );
      
      // Advance currentDistance: bead occupies baseWidth along the path
      if (!bead.rightAligned) {
        currentDistance = strokeStartDistance + baseWidth + BEAD_SPACING;
      }
    }
  });
  
  return {
    svg: svgBeads.length > 0 ? (
      <g className="edge-beads-svg">
        <defs>
          <path id={pathId} d={pathDAttr} pointerEvents="none" />
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
export const EdgeBeadsRenderer = React.memo(function EdgeBeadsRenderer(props: EdgeBeadsProps & { visibleStartOffset?: number; visibleEndOffset?: number }) {
  const { path, pathD, visibleStartOffset = 0, visibleEndOffset = 0, ...restProps } = props;
  
  // Memoize the hook result to prevent unnecessary recalculations
  const beadsResult = useEdgeBeads({
    ...restProps,
    path,
    pathD,
    visibleStartOffset,
    visibleEndOffset
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
    prevProps.visibleColourOrderIds?.join(',') === nextProps.visibleColourOrderIds?.join(',') &&
    prevProps.whatIfDSL === nextProps.whatIfDSL &&
    // CRITICAL: scenario visibility modes (E/F/F+E) must trigger bead recompute
    prevProps.visibilityModesKey === nextProps.visibilityModesKey &&
    // Compare edge properties that matter
    prevProps.edge?.uuid === nextProps.edge?.uuid &&
    prevProps.edge?.p?.mean === nextProps.edge?.p?.mean &&
    prevProps.edge?.p?.stdev === nextProps.edge?.p?.stdev &&
    prevProps.edge?.p?.mean_overridden === nextProps.edge?.p?.mean_overridden &&
    prevProps.edge?.p?.stdev_overridden === nextProps.edge?.p?.stdev_overridden &&
    prevProps.edge?.p?.distribution_overridden === nextProps.edge?.p?.distribution_overridden &&
    prevProps.edge?.p?.latency?.latency_parameter_overridden === nextProps.edge?.p?.latency?.latency_parameter_overridden &&
    prevProps.edge?.p?.latency?.anchor_node_id_overridden === nextProps.edge?.p?.latency?.anchor_node_id_overridden &&
    prevProps.edge?.p?.latency?.t95_overridden === nextProps.edge?.p?.latency?.t95_overridden &&
    prevProps.edge?.p?.latency?.path_t95_overridden === nextProps.edge?.p?.latency?.path_t95_overridden &&
    prevProps.edge?.query_overridden === nextProps.edge?.query_overridden &&
    (prevProps.edge as any)?.n_query_overridden === (nextProps.edge as any)?.n_query_overridden &&
    prevProps.edge?.cost_gbp?.mean === nextProps.edge?.cost_gbp?.mean &&
    prevProps.edge?.cost_gbp?.mean_overridden === nextProps.edge?.cost_gbp?.mean_overridden &&
    (prevProps.edge?.cost_gbp as any)?.stdev_overridden === (nextProps.edge?.cost_gbp as any)?.stdev_overridden &&
    (prevProps.edge?.cost_gbp as any)?.distribution_overridden === (nextProps.edge?.cost_gbp as any)?.distribution_overridden &&
    prevProps.edge?.labour_cost?.mean === nextProps.edge?.labour_cost?.mean &&
    prevProps.edge?.labour_cost?.mean_overridden === nextProps.edge?.labour_cost?.mean_overridden &&
    (prevProps.edge?.labour_cost as any)?.stdev_overridden === (nextProps.edge?.labour_cost as any)?.stdev_overridden &&
    (prevProps.edge?.labour_cost as any)?.distribution_overridden === (nextProps.edge?.labour_cost as any)?.distribution_overridden &&
    prevProps.edge?.case_variant === nextProps.edge?.case_variant &&
    prevProps.edge?.conditional_p?.length === nextProps.edge?.conditional_p?.length &&
    JSON.stringify(prevProps.edge?.conditional_p ?? []) === JSON.stringify(nextProps.edge?.conditional_p ?? []) &&
    // Any override changes (including less-common flags like connection_overridden) must re-render
    listOverriddenFlagPaths(prevProps.edge).join('|') === listOverriddenFlagPaths(nextProps.edge).join('|') &&
    hasAnyEdgeQueryOverride(prevProps.edge) === hasAnyEdgeQueryOverride(nextProps.edge) &&
    // Graph structure and update timestamp - catches ALL graph changes
    prevProps.graph?.nodes?.length === nextProps.graph?.nodes?.length &&
    prevProps.graph?.metadata?.updated_at === nextProps.graph?.metadata?.updated_at &&
    // Bead positioning props (change with probability/edge width)
    prevProps.visibleStartOffset === nextProps.visibleStartOffset &&
    prevProps.visibleEndOffset === nextProps.visibleEndOffset &&
    prevProps.edgeWidth === nextProps.edgeWidth &&
    // CRITICAL: pathD determines bead positions - must re-render when path changes
    prevProps.pathD === nextProps.pathD
  );
});


