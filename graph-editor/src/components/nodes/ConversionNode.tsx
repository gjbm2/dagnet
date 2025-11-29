import * as React from 'react';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { Handle, Position, NodeProps, useReactFlow, useStore } from 'reactflow';
import { useTabContext } from '../../contexts/TabContext';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import toast from 'react-hot-toast';
import { validateConditionalProbabilities } from '@/lib/conditionalValidation';
import { computeEffectiveEdgeProbability } from '@/lib/whatIf';
import Tooltip from '@/components/Tooltip';
import { getObjectTypeTheme } from '@/theme/objectTypeTheme';
import { fileRegistry } from '@/contexts/TabContext';
import { ExternalLink, ZapOff } from 'lucide-react';
import { countNodeOverrides } from '../../hooks/useRemoveOverrides';
import { ImageStackIndicator } from '../ImageStackIndicator';
import { ImageHoverPreview } from '../ImageHoverPreview';
import { ImageLoupeView } from '../ImageLoupeView';
import { ImageUploadModal } from '../ImageUploadModal';
import { imageOperationsService } from '../../services/imageOperationsService';
import { CONVEX_DEPTH, CONCAVE_DEPTH, HALO_WIDTH, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT, NODE_LABEL_FONT_SIZE, NODE_SECONDARY_FONT_SIZE, NODE_SMALL_FONT_SIZE, CASE_NODE_FONT_SIZE, CONVEX_HANDLE_OFFSET_MULTIPLIER, CONCAVE_HANDLE_OFFSET_MULTIPLIER, FLAT_HANDLE_OFFSET_MULTIPLIER } from '@/lib/nodeEdgeConstants';

interface ConversionNodeData {
  uuid: string;
  label: string;
  id: string;
  absorbing: boolean;
  outcome_type?: string;
  description?: string;
  entry?: { is_start?: boolean; entry_weight?: number };
  type?: 'normal' | 'case';
  url?: string;
  images?: Array<{
    image_id: string;
    caption: string;
    file_extension: 'png' | 'jpg' | 'jpeg';
    caption_overridden?: boolean;
  }>;
  case?: {
    id: string;
    status: 'active' | 'paused' | 'completed';
    variants: Array<{
      name: string;
      weight: number;
      description?: string;
    }>;
  };
  layout?: {
    x?: number;
    y?: number;
    rank?: number;
    group?: string;
    colour?: string;
  };
  event_id?: string;
  event_id_overridden?: boolean;
  sankeyWidth?: number;
  sankeyHeight?: number;
  useSankeyView?: boolean;
  faceDirections?: {
    left: 'flat' | 'convex' | 'concave';
    right: 'flat' | 'convex' | 'concave';
    top: 'flat' | 'convex' | 'concave';
    bottom: 'flat' | 'convex' | 'concave';
  };
  onUpdate: (id: string, data: Partial<ConversionNodeData>) => void;
  onDelete: (id: string) => void;
  onDoubleClick?: (id: string, field: string) => void;
}

export default function ConversionNode({ data, selected }: NodeProps<ConversionNodeData>) {
  const { getEdges, getNodes, setNodes } = useReactFlow();
  const { activeTabId, operations, tabs } = useTabContext();
  const { graph, setGraph, saveHistoryState } = useGraphStore();
  
  // Get current tab's what-if analysis state (NEW: unified DSL)
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const whatIfAnalysis = activeTab?.editorState?.whatIfAnalysis;
  const whatIfDSL = activeTab?.editorState?.whatIfDSL;
  
  // Track hover state
  const [isHovered, setIsHovered] = useState(false);
  
  // Image preview/loupe state
  const [showImagePreview, setShowImagePreview] = useState(false);
  const [showImageLoupe, setShowImageLoupe] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [imagePreviewPosition, setImagePreviewPosition] = useState({ x: 0, y: 0 });
  
  // Check if user is currently connecting (creating a new edge)
  const isConnecting = useStore((state) => state.connectionNodeId !== null);

  const handleDoubleClick = useCallback(() => {
    // Programmatically select this node to focus the properties panel
    setNodes((nodes) => 
      nodes.map((node) => ({
        ...node,
        selected: node.id === data.id
      }))
    );
    
    // Open Properties Panel and focus the label field
    window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
    window.dispatchEvent(new CustomEvent('dagnet:focusField', { detail: { field: 'label' } }));
    
    console.log('Node double-clicked and selected:', data.id);
  }, [data.id, setNodes]);

  const handleDelete = useCallback(() => {
    data.onDelete(data.uuid);
  }, [data]);

  // Image upload handler - using shared service
  const handleImageUpload = useCallback(async (imageData: Uint8Array, extension: string, source: string, caption?: string) => {
    if (!graph) return;
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    
    await imageOperationsService.uploadImage(graph, imageData, extension, source, {
      onGraphUpdate: setGraph,
      onHistorySave: saveHistoryState,
      getNodeId: () => data.uuid || data.id,
      getGraphFileId: () => activeTab?.fileId
    }, caption);
  }, [graph, data.uuid, data.id, setGraph, saveHistoryState, tabs, activeTabId]);

  // Calculate probability mass for outgoing edges
  // PMF validation ONLY applies to 'current' layer (live editable graph), not to snapshots
  const getProbabilityMass = useCallback(() => {
    const edges = getEdges();
    const nodes = getNodes();
    // edge.source could be uuid or human-readable id, check both
    const outgoingEdges = edges.filter(edge => edge.source === data.uuid || edge.source === data.id);
    
    if (outgoingEdges.length === 0) return null;
    if (!graph) return null;
    
    const totalProbability = outgoingEdges.reduce((sum, edge) => {
      // Use unified What-If logic to compute effective probability
      // This includes case variant overrides, conditional overrides, and path-based logic
      const edgeId = edge.id || `${edge.source}->${edge.target}`;
      const effectiveProb = computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
      
      return sum + effectiveProb;
    }, 0);
    
    return {
      total: totalProbability,
      missing: 1.0 - totalProbability,
      isComplete: Math.abs(totalProbability - 1.0) < 0.001,
      edgeCount: outgoingEdges.length
    };
  }, [data.id, data.uuid, getEdges, getNodes, whatIfDSL, graph]);

  const probabilityMass = getProbabilityMass();
  const isCaseNode = data.type === 'case';
  const isStartNode = data.entry?.is_start || false;
  const isTerminalNode = data.absorbing || false;
  
  // Count overrides on this node to show indicator
  const nodeOverrideCount = useMemo(() => {
    if (!graph) return 0;
    const graphNode = graph.nodes.find(n => n.uuid === data.uuid || n.id === data.id);
    return graphNode ? countNodeOverrides(graphNode) : 0;
  }, [graph, data.uuid, data.id]);
  
  // For case nodes, check PMF for each variant
  const getCaseVariantProbabilityMass = useCallback(() => {
    if (!isCaseNode || !data.case) return null;
    
    const outgoingEdges = getEdges().filter(edge => 
      edge.source === data.id || edge.source === data.uuid
    );
    
    if (outgoingEdges.length === 0) return null;
    if (!graph) return null;
    
    // Group edges by variant
    const variantEdges = new Map<string, any[]>();
    data.case.variants.forEach(variant => {
      variantEdges.set(variant.name, []);
    });
    
    outgoingEdges.forEach(edge => {
      const edgeData = graph.edges?.find((e: any) => 
        (e.id && e.id === edge.id) || 
        (e.uuid && e.uuid === edge.id) ||
        `${e.from}->${e.to}` === edge.id
      );
      
      const variantName = edgeData?.case_variant;
      if (variantName && variantEdges.has(variantName)) {
        variantEdges.get(variantName)!.push(edge);
      }
    });
    
    // Calculate PMF for each variant
    const variantResults: Array<{
      variantName: string;
      total: number;
      missing: number;
      isComplete: boolean;
      edgeCount: number;
    }> = [];
    
    data.case.variants.forEach(variant => {
      const edges = variantEdges.get(variant.name) || [];
      const totalProbability = edges.reduce((sum, edge) => {
        // For PMF validation, use raw edge probability (not variant-weighted)
        // Find the edge data in the graph
        const edgeData = graph.edges?.find((e: any) => 
          (e.id && e.id === edge.id) || 
          (e.uuid && e.uuid === edge.id) ||
          `${e.from}->${e.to}` === edge.id
        );
        
        // Use raw edge probability for PMF check
        const edgeProb = edgeData?.p?.mean ?? 0;
        return sum + edgeProb;
      }, 0);
      
      variantResults.push({
        variantName: variant.name,
        total: totalProbability,
        missing: 1.0 - totalProbability,
        isComplete: Math.abs(totalProbability - 1.0) < 0.001,
        edgeCount: edges.length
      });
    });
    
    return {
      variants: variantResults,
      hasAnyIncomplete: variantResults.some(v => !v.isComplete && v.edgeCount > 0)
    };
  }, [isCaseNode, data.case, data.id, data.uuid, getEdges, graph]);
  
  const caseVariantProbabilityMass = getCaseVariantProbabilityMass();
  
  // Check for conditional probability conservation errors with debouncing to prevent flashing during CTRL+drag
  const [debouncedValidation, setDebouncedValidation] = useState<any>(null);
  const [isActiveDrag, setIsActiveDrag] = useState(false);
  
  // Track CTRL+drag state to prevent validation during active operations
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' && e.ctrlKey) {
        setIsActiveDrag(true);
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        // Delay clearing the drag state to allow for rapid CTRL+drag operations
        setTimeout(() => setIsActiveDrag(false), 300);
      }
    };
    
    const handleMouseUp = () => {
      // Clear drag state when mouse is released
      setTimeout(() => setIsActiveDrag(false), 300);
    };
    
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);
  
  useEffect(() => {
    if (!graph) {
      setDebouncedValidation(null);
      return;
    }
    
    // Don't run validation during active CTRL+drag operations
    if (isActiveDrag) {
      return;
    }
    
    // Clear any existing timeout
    const timeoutId = setTimeout(() => {
      const validation = validateConditionalProbabilities(graph as any);
      // Find errors for this specific node
      const nodeErrors = validation.errors.filter(err => err.nodeId === data.id);
      const nodeWarnings = validation.warnings.filter(warn => warn.nodeId === data.id);
      
      // Check if there are CONDITIONAL probability sum errors (not base case)
      // Base case has condition='base', conditional cases have actual node IDs or 'variant_X'
      const hasConditionalProbSumError = nodeErrors.some(err => 
        err.type === 'probability_sum' && err.condition !== 'base' && !err.condition?.startsWith('variant_')
      );
      
      setDebouncedValidation({
        hasErrors: nodeErrors.length > 0,
        hasProbSumError: hasConditionalProbSumError,
        errors: nodeErrors,
        warnings: nodeWarnings
      });
    }, 200); // 200ms delay to prevent flashing during rapid changes
    
    return () => clearTimeout(timeoutId);
  }, [graph, data.id, isActiveDrag]);
  
  const conditionalValidation = debouncedValidation;
  
  // Generate tooltip content
  const getTooltipContent = useCallback(() => {
    const lines: string[] = [];
    
    // Basic node info
    lines.push(`Node: ${data.label || data.id}`);
    lines.push(`Type: ${data.type || 'normal'}`);
    lines.push(`Absorbing: ${data.absorbing ? 'Yes' : 'No'}`);
    
    if (data.id) {
      lines.push(`ID: ${data.id}`);
    }
    
    if (data.outcome_type) {
      lines.push(`Outcome Type: ${data.outcome_type}`);
    }
    
    // Case node specific info
    if (data.type === 'case' && data.case) {
      lines.push(`\nCase Info:`);
      lines.push(`  Status: ${data.case.status}`);
      lines.push(`  Variants:`);
      data.case.variants.forEach(variant => {
        lines.push(`    • ${variant.name}: ${(variant.weight * 100).toFixed(1)}%`);
        if (variant.description) {
          lines.push(`      ${variant.description}`);
        }
      });
    }
    
    // Entry info
    if (data.entry) {
      lines.push(`\nEntry Info:`);
      if (data.entry.is_start) {
        lines.push(`  Start Node: Yes`);
      }
      if (data.entry.entry_weight !== undefined) {
        lines.push(`  Entry Weight: ${data.entry.entry_weight}`);
      }
    }
    
    // Description
    if (data.description) {
      lines.push(`\nDescription: ${data.description}`);
    }
    
    // Conditional probability errors
    if (conditionalValidation?.errors && conditionalValidation.errors.length > 0) {
      lines.push(`\n⚠️ Conditional Probability Errors:`);
      conditionalValidation.errors.forEach(err => {
        lines.push(`  • ${err.message}`);
      });
    }
    
    // Conditional probability warnings
    if (conditionalValidation?.warnings && conditionalValidation.warnings.length > 0) {
      lines.push(`\n⚠️ Conditional Probability Warnings:`);
      conditionalValidation.warnings.forEach(warn => {
        lines.push(`  • ${warn.message}`);
      });
    }
    
    return lines.join('\n');
  }, [data, conditionalValidation]);
  
  // Determine node shape based on type
  const getNodeShape = () => {
    // Use Sankey dimensions if provided, otherwise default
    // Keep nominal dimensions - do NOT add padding (breaks ReactFlow handle positioning)
    const nominalWidth = data.sankeyWidth || DEFAULT_NODE_WIDTH;
    const nominalHeight = data.sankeyHeight || DEFAULT_NODE_HEIGHT;
    
    return {
      borderRadius: '0px', // Square corners for all nodes (for now)
      width: `${nominalWidth}px`,
      height: `${nominalHeight}px`
    };
  };
  
  const nodeShape = getNodeShape();
  
  // Extract face directions for use in handles and outline
  const faces = data.faceDirections ?? {
    left: 'flat' as const,
    right: 'flat' as const,
    top: 'flat' as const,
    bottom: 'flat' as const,
  };
  
  // Compute curved outline path for non-Sankey nodes
  const outlinePathD = useMemo(() => {
    if (data.useSankeyView) return null; // Sankey uses CSS rendering
    
    // Use nominal dimensions (before padding)
    const nominalW = data.sankeyWidth || DEFAULT_NODE_WIDTH;
    const nominalH = data.sankeyHeight || DEFAULT_NODE_HEIGHT;
    const w = nominalW;
    const h = nominalH;
    
    const buildFaceSegment = (face: 'left' | 'right' | 'top' | 'bottom', direction: 'flat' | 'convex' | 'concave'): string => {
      if (direction === 'flat') {
        // Straight line to the next corner
        if (face === 'left') return `L 0,${h}`; // top-left to bottom-left
        if (face === 'bottom') return `L ${w},${h}`; // bottom-left to bottom-right
        if (face === 'right') return `L ${w},0`; // bottom-right to top-right
        if (face === 'top') return `L 0,0`; // top-right to top-left
      }
      
      const depth = direction === 'convex' ? CONVEX_DEPTH : -CONCAVE_DEPTH;
      
      // Quadratic Bezier: control point is midway along the face, offset by depth perpendicular to face
      if (face === 'left') {
        // From (0, 0) to (0, h), control at (-depth, h/2)
        return `Q ${-depth},${h/2} 0,${h}`;
      }
      if (face === 'bottom') {
        // From (0, h) to (w, h), control at (w/2, h + depth)
        return `Q ${w/2},${h + depth} ${w},${h}`;
      }
      if (face === 'right') {
        // From (w, h) to (w, 0), control at (w + depth, h/2)
        return `Q ${w + depth},${h/2} ${w},0`;
      }
      if (face === 'top') {
        // From (w, 0) to (0, 0), control at (w/2, -depth)
        return `Q ${w/2},${-depth} 0,0`;
      }
      
      return '';
    };
    
    // Build full path: start top-left, clockwise
    let path = `M 0,0`;
    path += ' ' + buildFaceSegment('left', faces.left);
    path += ' ' + buildFaceSegment('bottom', faces.bottom);
    path += ' ' + buildFaceSegment('right', faces.right);
    path += ' ' + buildFaceSegment('top', faces.top);
    path += ' Z';
    
    return path;
  }, [data.useSankeyView, data.faceDirections, nodeShape.width, nodeShape.height]);
  
  // Case node styling - suppressed colouration (neutral gray)
  // Store colour for bead use, but don't apply to node itself
  const caseNodeColourForBeads = isCaseNode ? (data.layout?.colour || null) : null;

  // Determine if handles should be visible
  const showHandles = isHovered || isConnecting;

  // Determine file connection status for node/case/event
  const nodeFileId = data.id ? `node-${data.id}` : null;
  const caseFileId = data.case?.id ? `case-${data.case.id}` : null;
  const eventFileId = data.event_id ? `event-${data.event_id}` : null;

  const nodeFile = nodeFileId ? fileRegistry.getFile(nodeFileId) : null;
  const caseFile = caseFileId ? fileRegistry.getFile(caseFileId) : null;
  const eventFile = eventFileId ? fileRegistry.getFile(eventFileId) : null;

  const nodeTheme = getObjectTypeTheme('node');
  const caseTheme = getObjectTypeTheme('case');
  const eventTheme = getObjectTypeTheme('event');

  return (
    <Tooltip content={getTooltipContent()} position="top" delay={800}>
      <div 
        className={`conversion-node ${selected ? 'selected' : ''} ${data.absorbing ? 'absorbing' : ''} ${isCaseNode ? 'case-node' : ''}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      style={{
        position: 'relative',
        padding: '8px',
        border: outlinePathD ? 'none' : (selected ? '5px solid #333' : // Thick dark grey border for all selected nodes
                ((probabilityMass && !probabilityMass.isComplete) || (conditionalValidation?.hasProbSumError)) ? '2px solid #ff6b6b' : // Red border for probability conservation errors
                '2px solid #ddd'),
        ...nodeShape, // Apply shape-specific styles
        background: outlinePathD ? 'transparent' : '#fff', // Same white for all nodes
        color: '#333', // Same text color for all nodes
        textAlign: 'center',
        cursor: 'pointer',
        boxShadow: outlinePathD ? 'none' : (() => {
          // Canvas background colour from GraphCanvas ReactFlow style
          const canvasColour = '#f8fafc';

          // Outer "halo" in canvas colour to act as a pseudo-clip for edges
          // This renders behind the node but above edges, hiding edge segments near the node boundary.
          const outerHalo = `0 0 0 5px ${canvasColour}`;

          // Base shadow for depth
          const baseShadow = selected ? '0 4px 8px rgba(51,51,51,0.4)' : '0 2px 4px rgba(0,0,0,0.1)';
          
          // Inner border for start/end nodes (only used for non-SVG Sankey view)
          let innerBorder = '';
          if (isStartNode) {
            innerBorder = 'inset 0 0 20px 0px rgba(191, 219, 254, 0.6)';
          } else if (isTerminalNode) {
            if (data.outcome_type === 'success') {
              innerBorder = 'inset 0 0 20px 0px rgba(187, 247, 208, 0.6)';
            } else if (data.outcome_type === 'failure') {
              innerBorder = 'inset 0 0 20px 0px rgba(254, 202, 202, 0.6)';
            } else {
              innerBorder = 'inset 0 0 20px 0px rgba(229, 231, 235, 0.6)';
            }
          }
          
          // Error shadow
          if ((probabilityMass && !probabilityMass.isComplete) || (conditionalValidation?.hasProbSumError)) {
            const errorShadow = '0 2px 4px rgba(255,107,107,0.3)';
            return innerBorder
              ? `${outerHalo}, ${errorShadow}, ${innerBorder}`
              : `${outerHalo}, ${errorShadow}`;
          }
          
          // Normal case: outer halo + base + optional inner border
          return innerBorder
            ? `${outerHalo}, ${baseShadow}, ${innerBorder}`
            : `${outerHalo}, ${baseShadow}`;
        })(),
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        boxSizing: 'border-box'
      }}
    >
      {/* SVG overlay for curved outline (non-Sankey view only) */}
      {outlinePathD && (() => {
        const w = parseFloat(nodeShape.width) || DEFAULT_NODE_WIDTH;
        const h = parseFloat(nodeShape.height) || DEFAULT_NODE_HEIGHT;
        const SHADOW_BLUR = selected ? 4 : 2;
        const SHADOW_OFFSET = selected ? 4 : 2;
        // Extend viewBox to accommodate convex bulges and drop shadow
        const padding = CONVEX_DEPTH + SHADOW_BLUR + SHADOW_OFFSET;
        const viewBoxX = -padding;
        const viewBoxY = -padding;
        const viewBoxW = w + 2 * padding;
        const viewBoxH = h + 2 * padding;
        return (
          <svg
            width={`${w}px`}
            height={`${h}px`}
            viewBox={`${viewBoxX} ${viewBoxY} ${viewBoxW} ${viewBoxH}`}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              zIndex: 0,
              overflow: 'visible',
            }}
          >
          <defs>
            <filter id={`node-shadow-${data.id}`}>
              <feDropShadow
                dx="0"
                dy={selected ? 4 : 2}
                stdDeviation={selected ? 4 : 2}
                floodColor={
                  (probabilityMass && !probabilityMass.isComplete) || conditionalValidation?.hasProbSumError
                    ? 'rgba(255,107,107,0.3)'
                    : selected
                      ? 'rgba(51,51,51,0.4)'
                      : 'rgba(0,0,0,0.1)'
                }
              />
            </filter>
            {/* Clip path to constrain glow to interior of node */}
            <clipPath id={`node-interior-${data.id}`}>
              <path d={outlinePathD} />
            </clipPath>
            {/* Blur filter for soft inner edge glow */}
            <filter id={`inner-glow-blur-${data.id}`}>
              <feGaussianBlur in="SourceGraphic" stdDeviation="10" />
            </filter>
          </defs>
          
          {/* Halo (edge masking) - drawn first as clipping mask for edges */}
          <path
            d={outlinePathD}
            fill="none"
            stroke="#f8fafc"
            strokeWidth={HALO_WIDTH}
          />
          
          {/* Shadow group: fill + inner glow + border (casts shadow from the actual outline, on top of halo) */}
          <g filter={`url(#node-shadow-${data.id})`}>
            {/* Fill */}
            <path
              d={outlinePathD}
              fill='#fff' // Same white for all nodes
            />
            
            {/* Inner edge glow - blurred stroke clipped to INSIDE the node face only */}
            {isStartNode && (
              <path
                d={outlinePathD}
                fill="none"
                stroke="#3B82F6"
                strokeWidth="8"
                strokeOpacity="0.25"
                filter={`url(#inner-glow-blur-${data.id})`}
                clipPath={`url(#node-interior-${data.id})`}
              />
            )}
            {isTerminalNode && (
              <path
                d={outlinePathD}
                fill="none"
                stroke={
                  data.outcome_type === 'success' ? '#10B981'
                    : data.outcome_type === 'failure' ? '#EF4444'
                    : '#6B7280'
                }
                strokeWidth="8"
                strokeOpacity="0.25"
                filter={`url(#inner-glow-blur-${data.id})`}
                clipPath={`url(#node-interior-${data.id})`}
              />
            )}
            
            {/* Border */}
            <path
              d={outlinePathD}
              fill="none"
              stroke={
                selected ? '#333'
                  : (probabilityMass && !probabilityMass.isComplete) || conditionalValidation?.hasProbSumError
                    ? '#ff6b6b'
                    : '#ddd'
              }
              strokeWidth={selected ? 5 : 2}
            />
          </g>
          </svg>
        );
      })()}
      
      {/* Input handles - all sides (or only left/right in Sankey view) */}
      {/* Adjust handle positions for curved faces (at center of face, perpendicular offset = depth * 0.5) */}
      <Handle 
        type="target" 
        position={Position.Left} 
        id="left" 
        style={{ 
          background: '#555', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease',
          zIndex: 10,
          pointerEvents: 'auto',
          // Offset for curved face (convex bulges out, concave indents in, flat moves slightly inward)
          left: faces.left === 'convex' ? `${-CONVEX_DEPTH * CONVEX_HANDLE_OFFSET_MULTIPLIER}px` : 
                faces.left === 'concave' ? `${CONCAVE_DEPTH * CONCAVE_HANDLE_OFFSET_MULTIPLIER}px` : 
                `${CONVEX_DEPTH * FLAT_HANDLE_OFFSET_MULTIPLIER}px`
        }} 
      />
      {!data.useSankeyView && (
        <Handle 
          type="target" 
          position={Position.Top} 
          id="top" 
          style={{ 
            background: '#555', 
            width: '8px', 
            height: '8px',
            opacity: showHandles ? 1 : 0,
            transition: 'opacity 0.2s ease',
            zIndex: 10,
            pointerEvents: 'auto',
            // Offset for curved face
            top: faces.top === 'convex' ? `${-CONVEX_DEPTH * CONVEX_HANDLE_OFFSET_MULTIPLIER}px` : 
                 faces.top === 'concave' ? `${CONCAVE_DEPTH * CONCAVE_HANDLE_OFFSET_MULTIPLIER}px` : 
                 `${CONVEX_DEPTH * FLAT_HANDLE_OFFSET_MULTIPLIER}px`
          }} 
        />
      )}
      <Handle 
        type="target" 
        position={Position.Right} 
        id="right" 
        style={{ 
          background: '#555', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease',
          zIndex: 10,
          pointerEvents: 'auto',
          // Offset for curved face
          right: faces.right === 'convex' ? `${-CONVEX_DEPTH * CONVEX_HANDLE_OFFSET_MULTIPLIER}px` : 
                 faces.right === 'concave' ? `${CONCAVE_DEPTH * CONCAVE_HANDLE_OFFSET_MULTIPLIER}px` : 
                 `${CONVEX_DEPTH * FLAT_HANDLE_OFFSET_MULTIPLIER}px`
        }} 
      />
      {!data.useSankeyView && (
        <Handle 
          type="target" 
          position={Position.Bottom} 
          id="bottom" 
          style={{ 
            background: '#555', 
            width: '8px', 
            height: '8px',
            opacity: showHandles ? 1 : 0,
            transition: 'opacity 0.2s ease',
            zIndex: 10,
            pointerEvents: 'auto',
            // Offset for curved face
            bottom: faces.bottom === 'convex' ? `${-CONVEX_DEPTH * CONVEX_HANDLE_OFFSET_MULTIPLIER}px` : 
                    faces.bottom === 'concave' ? `${CONCAVE_DEPTH * CONCAVE_HANDLE_OFFSET_MULTIPLIER}px` : 
                    `${CONVEX_DEPTH * FLAT_HANDLE_OFFSET_MULTIPLIER}px`
          }} 
        />
      )}
      
      {/* Content wrapper */}
      <div style={{
        position: 'relative',
        zIndex: 10, // Above images (z-index 5) so PMF warnings show on top
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        pointerEvents: 'none' // Allow handles to be clickable
      }}>
        {/* Terminal state symbols */}
        
        <div 
          style={{ 
            fontWeight: 'bold', 
            marginBottom: '4px', 
            fontSize: `${NODE_LABEL_FONT_SIZE}px`, 
            cursor: 'pointer',
            lineHeight: '1.2',
            wordWrap: 'break-word',
            overflowWrap: 'break-word',
            hyphens: 'auto',
            maxWidth: '100%',
            paddingLeft: '12px',
            paddingRight: '12px',
            textAlign: 'center',
            pointerEvents: 'auto' // Re-enable pointer events for interactive content
          }}
          onDoubleClick={handleDoubleClick}
          title="Double-click to edit in properties panel"
        >
          {data.label}
          {nodeOverrideCount > 0 && (
            <span title={`${nodeOverrideCount} override${nodeOverrideCount > 1 ? 's' : ''} (auto-sync disabled)`}>
              <ZapOff 
                size={10} 
                strokeWidth={2}
                color="#000000"
                style={{ 
                  display: 'inline-block',
                  verticalAlign: 'middle',
                  marginLeft: '3px'
                }}
              />
            </span>
          )}
        </div>
        
        {data.absorbing && !isCaseNode && !data.outcome_type && (
          <div style={{ fontSize: `${NODE_SECONDARY_FONT_SIZE}px`, color: '#666', marginTop: '4px' }}>
            TERMINAL
          </div>
        )}

        {data.entry?.is_start && !isCaseNode && (
          <div style={{ fontSize: `${NODE_SECONDARY_FONT_SIZE}px`, color: '#16a34a', marginTop: '2px', fontWeight: 'bold' }}>
            START
          </div>
        )}

        {/* Case node variant info */}
        {isCaseNode && data.case && (
          <div style={{ 
            fontSize: `${NODE_SMALL_FONT_SIZE}px`, 
            color: '#666', // Same secondary color as other nodes
            marginTop: '2px',
            opacity: 0.9
          }}>
            {data.case.variants.length} variant{data.case.variants.length > 1 ? 's' : ''}
          </div>
        )}

        {/* Probability mass warning */}
        {probabilityMass && !probabilityMass.isComplete && !isCaseNode && !isActiveDrag && (
          <div style={{ 
            fontSize: `${NODE_SMALL_FONT_SIZE}px`, 
            color: '#ff6b6b', 
            marginTop: '2px',
            background: '#fff5f5',
            padding: '2px 4px',
            borderRadius: '3px',
            border: '1px solid #ff6b6b',
            fontWeight: 'bold'
          }}>
            ⚠️ Missing {Math.round(probabilityMass.missing * 100)}%
          </div>
        )}
        
        {/* Case node variant PMF warnings */}
        {isCaseNode && caseVariantProbabilityMass?.hasAnyIncomplete && !isActiveDrag && (
          <div style={{ 
            fontSize: `${NODE_SMALL_FONT_SIZE}px`, 
            color: '#ff6b6b', 
            marginTop: '2px',
            background: '#fff5f5',
            padding: '2px 4px',
            borderRadius: '3px',
            border: '1px solid #ff6b6b',
            fontWeight: 'bold'
          }}>
            {caseVariantProbabilityMass.variants
              .filter(v => !v.isComplete && v.edgeCount > 0)
              .map((v, idx, arr) => (
                <div key={v.variantName}>
                  ⚠️ {v.variantName}: Missing {Math.round(v.missing * 100)}%
                </div>
              ))
            }
          </div>
        )}
        
        {/* Conditional probability conservation warning */}
        {conditionalValidation?.hasProbSumError && !isActiveDrag && (
          <div style={{ 
            fontSize: `${NODE_SMALL_FONT_SIZE}px`, 
            color: '#ff6b6b', 
            marginTop: '2px',
            background: '#fff5f5',
            padding: '2px 4px',
            borderRadius: '3px',
            border: '1px solid #ff6b6b',
            fontWeight: 'bold'
          }}>
            ⚠️ Conditional P not conserved
          </div>
        )}
      </div>

      {/* Bottom-left connection status icons for node/case/event files */}
      <div
        style={{
          position: 'absolute',
          left: data.useSankeyView ? 10 : 20,
          bottom: data.useSankeyView ? 10 : 20,
          display: 'flex',
          gap: 2,
          alignItems: 'center',
          pointerEvents: 'auto',
        }}
      >
        {nodeFile && (
          <Tooltip content={`Node file connected (${data.id})`} position="top" delay={200}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 12,
                height: 12,
                borderRadius: 3,
                backgroundColor: nodeTheme.lightColour,
                border: `1px solid ${nodeTheme.accentColour}`,
              }}
            >
              <nodeTheme.icon size={8} strokeWidth={2} style={{ color: nodeTheme.accentColour }} />
            </span>
          </Tooltip>
        )}
        {caseFile && (
          <Tooltip content={`Case file connected (${data.case?.id})`} position="top" delay={200}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 12,
                height: 12,
                borderRadius: 3,
                backgroundColor: caseTheme.lightColour,
                border: `1px solid ${caseTheme.accentColour}`,
              }}
            >
              <caseTheme.icon size={8} strokeWidth={2} style={{ color: caseTheme.accentColour }} />
            </span>
          </Tooltip>
        )}
        {eventFile && (
          <Tooltip content={`Event file connected (${data.event_id})`} position="top" delay={200}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 12,
                height: 12,
                borderRadius: 3,
                backgroundColor: eventTheme.lightColour,
                border: `1px solid ${eventTheme.accentColour}`,
              }}
            >
              <eventTheme.icon size={8} strokeWidth={2} style={{ color: eventTheme.accentColour }} />
            </span>
          </Tooltip>
        )}
      </div>

      {/* Bottom-right URL icon and image preview */}
      <div
        style={{
          position: 'absolute',
          right: data.useSankeyView ? 10 : 20,
          bottom: data.useSankeyView ? 10 : 20,
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          pointerEvents: 'auto',
          zIndex: 5 // Below PMF warning (z-index 10) and case status indicator (z-index 15)
        }}
      >
        {/* URL icon (left of images) */}
        {data.url && (
          <Tooltip content={data.url} position="top" delay={200}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const url = data.url?.startsWith('http://') || data.url?.startsWith('https://') 
                  ? data.url 
                  : `https://${data.url}`;
                window.open(url, '_blank', 'noopener,noreferrer');
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 12,
                height: 12,
                borderRadius: 3,
                backgroundColor: '#f8fafc',
                border: '1px solid #94a3b8',
                cursor: 'pointer',
                padding: 0,
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#e2e8f0';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#f8fafc';
              }}
              title={data.url}
            >
              <ExternalLink size={8} strokeWidth={2} style={{ color: '#64748b' }} />
            </button>
          </Tooltip>
        )}
        
        {/* Image preview (right of URL) */}
        {data.images && data.images.length > 0 && (
          <div
            style={{ 
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 12,
              height: 12
            }}
            onClick={(e) => {
              e.stopPropagation();
              setShowImageLoupe(true);
            }}
            onMouseEnter={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              // Position preview above the indicator, centered horizontally
              setImagePreviewPosition({ 
                x: rect.left + rect.width / 2, 
                y: rect.top 
              });
              setShowImagePreview(true);
            }}
            onMouseMove={(e) => {
              e.stopPropagation();
              // Update position to follow mouse, but keep it above
              const rect = e.currentTarget.getBoundingClientRect();
              setImagePreviewPosition({ 
                x: e.clientX, 
                y: rect.top 
              });
            }}
            onMouseLeave={(e) => {
              e.stopPropagation();
              setShowImagePreview(false);
            }}
          >
            <ImageStackIndicator images={data.images} />
          </div>
        )}
      </div>

      {/* Case node status indicator - outside content wrapper to avoid rotation (well inside visible node area) */}
      {isCaseNode && data.case && (
        <div style={{ 
          position: 'absolute',
          top: data.useSankeyView ? '10px' : '20px',
          right: data.useSankeyView ? '10px' : '20px',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: caseNodeColourForBeads || '#8B5CF6', // Use stored color for indicator
          border: '1px solid #FFFFFF',
          zIndex: 15,
          pointerEvents: 'none'
        }} title={`Status: ${data.case.status}`} />
      )}

      {/* What-If Analysis Indicator - outside content wrapper (well inside visible node area) */}
      {isCaseNode && whatIfAnalysis && whatIfAnalysis.caseNodeId === data.id && (
        <div style={{
          position: 'absolute',
          top: data.useSankeyView ? '10px' : '20px',
          left: data.useSankeyView ? '10px' : '20px',
          fontSize: '16px',
          animation: 'pulse 2s infinite',
          zIndex: 15,
          pointerEvents: 'none'
        }} title={`What-If Mode: ${whatIfAnalysis.selectedVariant} @ 100%`}>
          🔬
        </div>
      )}
      
      {/* Start node badge - top-left corner (well inside visible node area) */}
      {isStartNode && (
        <div style={{
          position: 'absolute',
          top: data.useSankeyView ? '10px' : '20px',
          left: data.useSankeyView ? '10px' : '20px',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: '#3b82f6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: `${NODE_SMALL_FONT_SIZE - 1}px`,
          color: '#fff',
          fontWeight: 'bold',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          zIndex: 15,
          pointerEvents: 'none',
          paddingLeft: '1px' // Slight offset to visually center the play triangle
        }} title="Start Node">
          ▶
        </div>
      )}
      
      {/* End node badge - top-left corner (below start badge if both, well inside visible node area) */}
      {isTerminalNode && (
        <div style={{
          position: 'absolute',
          top: isStartNode ? (data.useSankeyView ? '30px' : '40px') : (data.useSankeyView ? '10px' : '20px'),
          left: data.useSankeyView ? '10px' : '20px',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: data.outcome_type === 'success' ? '#10b981' : data.outcome_type === 'failure' ? '#ef4444' : '#6b7280',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: `${NODE_SECONDARY_FONT_SIZE - 1}px`,
          color: '#fff',
          fontWeight: 'bold',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          zIndex: 15,
          pointerEvents: 'none'
        }} title={`End Node: ${data.outcome_type || 'unknown'}`}>
          ■
        </div>
      )}
      
  {/* Output handles - all sides (or only left/right in Sankey view) */}
  {/* Adjust handle positions for curved faces (at center of face, perpendicular offset = depth * 0.5) */}
  <Handle 
    type="source" 
    position={Position.Left} 
    id="left-out" 
    style={{ 
      background: '#000', 
      width: '8px', 
      height: '8px',
      opacity: showHandles ? 1 : 0,
      transition: 'opacity 0.2s ease',
      zIndex: 10,
      pointerEvents: 'auto',
      // Offset for curved face (convex bulges out, concave indents in, flat moves slightly inward)
      left: faces.left === 'convex' ? `${-CONVEX_DEPTH * CONVEX_HANDLE_OFFSET_MULTIPLIER}px` : 
            faces.left === 'concave' ? `${CONCAVE_DEPTH * CONCAVE_HANDLE_OFFSET_MULTIPLIER}px` : 
            `${CONVEX_DEPTH * FLAT_HANDLE_OFFSET_MULTIPLIER}px`
    }} 
  />
  {!data.useSankeyView && (
    <Handle 
      type="source" 
      position={Position.Top} 
      id="top-out" 
      style={{ 
        background: '#000', 
        width: '8px', 
        height: '8px',
        opacity: showHandles ? 1 : 0,
        transition: 'opacity 0.2s ease',
        zIndex: 10,
        pointerEvents: 'auto',
        // Offset for curved face
        top: faces.top === 'convex' ? `${-CONVEX_DEPTH * CONVEX_HANDLE_OFFSET_MULTIPLIER}px` : 
             faces.top === 'concave' ? `${CONCAVE_DEPTH * CONCAVE_HANDLE_OFFSET_MULTIPLIER}px` : 
             `${CONVEX_DEPTH * FLAT_HANDLE_OFFSET_MULTIPLIER}px`
      }} 
    />
  )}
  <Handle 
    type="source" 
    position={Position.Right} 
    id="right-out" 
    style={{ 
      background: '#000', 
      width: '8px', 
      height: '8px',
      opacity: showHandles ? 1 : 0,
      transition: 'opacity 0.2s ease',
      zIndex: 10,
      pointerEvents: 'auto',
      // Offset for curved face
      right: faces.right === 'convex' ? `${-CONVEX_DEPTH * CONVEX_HANDLE_OFFSET_MULTIPLIER}px` : 
             faces.right === 'concave' ? `${CONCAVE_DEPTH * CONCAVE_HANDLE_OFFSET_MULTIPLIER}px` : 
             `${CONVEX_DEPTH * FLAT_HANDLE_OFFSET_MULTIPLIER}px`
    }} 
  />
  {!data.useSankeyView && (
    <Handle 
      type="source" 
      position={Position.Bottom} 
      id="bottom-out" 
      style={{ 
        background: '#000', 
        width: '8px', 
        height: '8px',
        opacity: showHandles ? 1 : 0,
        transition: 'opacity 0.2s ease',
        zIndex: 10,
        pointerEvents: 'auto',
        // Offset for curved face
        bottom: faces.bottom === 'convex' ? `${-CONVEX_DEPTH * CONVEX_HANDLE_OFFSET_MULTIPLIER}px` : 
                faces.bottom === 'concave' ? `${CONCAVE_DEPTH * CONCAVE_HANDLE_OFFSET_MULTIPLIER}px` : 
                `${CONVEX_DEPTH * FLAT_HANDLE_OFFSET_MULTIPLIER}px`
      }} 
    />
  )}
      
      {selected && (
        <div 
          style={{
            position: 'absolute',
            top: '-8px',
            right: '-8px',
            background: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '50%',
            width: '20px',
            height: '20px',
            cursor: 'pointer',
            fontSize: `${NODE_LABEL_FONT_SIZE}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20, // Above handles
            pointerEvents: 'auto'
          }}
          onClick={handleDelete}
          title="Delete node"
        >
          ×
        </div>
      )}
    </div>
    {/* Hover preview popup */}
    {showImagePreview && data.images && data.images[0] && (
      <ImageHoverPreview
        image={data.images[0]}
        position={imagePreviewPosition}
      />
    )}

    {/* Full loupe view modal */}
    {showImageLoupe && data.images && data.images.length > 0 && (
      <ImageLoupeView
        images={data.images}
        onClose={() => setShowImageLoupe(false)}
        onAddImage={() => {
          setShowImageLoupe(false);
          setShowUploadModal(true);
        }}
        onDelete={async (imageId) => {
          if (!graph) return;
          const activeTab = tabs.find(tab => tab.id === activeTabId);
          
          await imageOperationsService.deleteImage(graph, imageId, {
            onGraphUpdate: (updatedGraph) => {
              setGraph(updatedGraph);
              // Close loupe if no images left
              const node = updatedGraph.nodes.find((n: any) => n.uuid === data.uuid || n.id === data.id);
              if (node && (!node.images || node.images.length === 0)) {
                setShowImageLoupe(false);
              }
            },
            onHistorySave: saveHistoryState,
            getNodeId: () => data.uuid || data.id,
            getGraphFileId: () => activeTab?.fileId
          });
        }}
        onCaptionEdit={async (imageId, newCaption) => {
          if (!graph) return;
          const activeTab = tabs.find(tab => tab.id === activeTabId);
          
          await imageOperationsService.editCaption(graph, imageId, newCaption, {
            onGraphUpdate: setGraph,
            onHistorySave: saveHistoryState,
            getNodeId: () => data.uuid || data.id,
            getGraphFileId: () => activeTab?.fileId
          });
        }}
      />
    )}
    
    {/* Image Upload Modal */}
    {showUploadModal && (
      <ImageUploadModal
        onClose={() => setShowUploadModal(false)}
        onUpload={handleImageUpload}
      />
    )}
    </Tooltip>
  );
}
