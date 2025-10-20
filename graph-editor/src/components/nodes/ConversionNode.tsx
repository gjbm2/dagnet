import React, { useState, useCallback, useEffect } from 'react';
import { Handle, Position, NodeProps, useReactFlow, useStore } from 'reactflow';
import { useGraphStore } from '@/lib/useGraphStore';
import Tooltip from '@/components/Tooltip';

interface ConversionNodeData {
  id: string;
  label: string;
  slug: string;
  absorbing: boolean;
  outcome_type?: string;
  description?: string;
  entry?: { is_start?: boolean; entry_weight?: number };
  type?: 'normal' | 'case';
  case?: {
    id: string;
    parameter_id?: string;
    status: 'active' | 'paused' | 'completed';
    variants: Array<{
      name: string;
      weight: number;
      description?: string;
    }>;
  };
  onUpdate: (id: string, data: Partial<ConversionNodeData>) => void;
  onDelete: (id: string) => void;
  onDoubleClick?: (id: string, field: string) => void;
}

export default function ConversionNode({ data, selected }: NodeProps<ConversionNodeData>) {
  const { getEdges, getNodes, setNodes } = useReactFlow();
  const { whatIfAnalysis } = useGraphStore();
  
  // Track hover state
  const [isHovered, setIsHovered] = useState(false);
  
  // Check if user is currently connecting (creating a new edge)
  const isConnecting = useStore((state) => state.connectionNodeId !== null);

  // Generate tooltip content
  const getTooltipContent = () => {
    const lines: string[] = [];
    
    // Basic node info
    lines.push(`Node: ${data.label || data.id}`);
    lines.push(`Type: ${data.type || 'normal'}`);
    lines.push(`Absorbing: ${data.absorbing ? 'Yes' : 'No'}`);
    
    if (data.slug) {
      lines.push(`Slug: ${data.slug}`);
    }
    
    if (data.outcome_type) {
      lines.push(`Outcome Type: ${data.outcome_type}`);
    }
    
    // Case node specific info
    if (data.type === 'case' && data.case) {
      lines.push(`\nCase Info:`);
      lines.push(`  Status: ${data.case.status}`);
      if (data.case.parameter_id) {
        lines.push(`  Parameter ID: ${data.case.parameter_id}`);
      }
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
    
    return lines.join('\n');
  };


  const handleDoubleClick = useCallback(() => {
    // Programmatically select this node to focus the properties panel
    setNodes((nodes) => 
      nodes.map((node) => ({
        ...node,
        selected: node.id === data.id
      }))
    );
    
    // Trigger the double-click callback to focus and select text in the label field
    if (data.onDoubleClick) {
      data.onDoubleClick(data.id, 'label');
    }
    
    console.log('Node double-clicked and selected:', data.id);
  }, [data.id, data.onDoubleClick, setNodes]);

  const handleDelete = useCallback(() => {
    if (confirm('Delete this node?')) {
      data.onDelete(data.id);
    }
  }, [data]);

  // Calculate probability mass for outgoing edges
  const getProbabilityMass = useCallback(() => {
    const edges = getEdges();
    const nodes = getNodes();
    const outgoingEdges = edges.filter(edge => edge.source === data.id);
    
    if (outgoingEdges.length === 0) return null;
    
    const totalProbability = outgoingEdges.reduce((sum, edge) => {
      // For case edges, calculate effective probability (variant weight × sub-route probability)
      if (edge.data?.case_id && edge.data?.case_variant) {
        const caseNode = nodes.find((n: any) => n.data?.case?.id === edge.data.case_id);
        if (caseNode) {
          const variant = caseNode.data?.case?.variants?.find((v: any) => v.name === edge.data.case_variant);
          if (variant) {
            let variantWeight = variant.weight || 0;
            
            // Apply what-if analysis override
            if (whatIfAnalysis && whatIfAnalysis.caseNodeId === caseNode.id) {
              variantWeight = edge.data.case_variant === whatIfAnalysis.selectedVariant ? 1.0 : 0.0;
            }
            
            const subRouteProbability = edge.data?.probability ?? 1.0;
            return sum + (variantWeight * subRouteProbability);
          }
        }
        return sum;
      }
      
      // For normal edges, use probability as-is
      const prob = edge.data?.probability;
      return sum + (typeof prob === 'number' ? prob : 0);
    }, 0);
    
    return {
      total: totalProbability,
      missing: 1.0 - totalProbability,
      isComplete: Math.abs(totalProbability - 1.0) < 0.001,
      edgeCount: outgoingEdges.length
    };
  }, [data.id, getEdges, getNodes, whatIfAnalysis]);

  const probabilityMass = getProbabilityMass();
  const isCaseNode = data.type === 'case';
  
  // Case node styling
  const caseNodeStyle = isCaseNode ? {
    width: '96px', // 80% of normal size
    height: '96px',
    background: '#8B5CF6', // purple-500
    border: selected ? '2px solid #7C3AED' : '2px solid #7C3AED', // purple-600
    color: '#FFFFFF', // white text
    fontSize: '11px' // slightly smaller font
  } : {};

  // Status indicator color for case nodes
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return '#10B981'; // green-500
      case 'paused': return '#F59E0B'; // yellow-500
      case 'completed': return '#6B7280'; // gray-500
      default: return '#6B7280';
    }
  };

  // Determine if handles should be visible
  const showHandles = isHovered || isConnecting;

  return (
    <Tooltip content={getTooltipContent()} position="top" delay={300}>
      <div 
        className={`conversion-node ${selected ? 'selected' : ''} ${data.absorbing ? 'absorbing' : ''} ${isCaseNode ? 'case-node' : ''}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      style={{
        padding: '8px',
        border: isCaseNode ? (selected ? '2px solid #7C3AED' : '2px solid #7C3AED') :
                selected ? '2px solid #007bff' : 
                (probabilityMass && !probabilityMass.isComplete) ? '2px solid #ff6b6b' : 
                '2px solid #ddd',
        borderRadius: '8px',
        background: isCaseNode ? '#8B5CF6' : 
                    (data.outcome_type?.toUpperCase() === 'SUCCESS' ? '#d4f4dd' : // light green for SUCCESS
                    (data.entry?.is_start ? '#fff9c4' : // light yellow for START
                    (data.absorbing ? '#ffebee' : '#fff'))), // light pink for other absorbing, white for normal
        width: isCaseNode ? '96px' : '120px',
        height: isCaseNode ? '96px' : '120px',
        textAlign: 'center',
        cursor: 'pointer',
        boxShadow: selected ? '0 4px 8px rgba(0,123,255,0.3)' : 
                   (probabilityMass && !probabilityMass.isComplete) ? '0 2px 4px rgba(255,107,107,0.3)' :
                   '0 2px 4px rgba(0,0,0,0.1)',
        transition: 'all 0.2s ease',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        boxSizing: 'border-box',
        color: isCaseNode ? '#FFFFFF' : 'inherit',
        fontSize: isCaseNode ? '11px' : 'inherit'
      }}
    >
      {/* Input handles - all sides */}
      <Handle 
        type="target" 
        position={Position.Left} 
        id="left" 
        style={{ 
          background: '#555', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }} 
      />
      <Handle 
        type="target" 
        position={Position.Top} 
        id="top" 
        style={{ 
          background: '#555', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }} 
      />
      <Handle 
        type="target" 
        position={Position.Right} 
        id="right" 
        style={{ 
          background: '#555', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }} 
      />
      <Handle 
        type="target" 
        position={Position.Bottom} 
        id="bottom" 
        style={{ 
          background: '#555', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }} 
      />
      
      <div 
        style={{ 
          fontWeight: 'bold', 
          marginBottom: '4px', 
          fontSize: '12px', 
          cursor: 'pointer',
          lineHeight: '1.2',
          wordWrap: 'break-word',
          overflowWrap: 'break-word',
          hyphens: 'auto',
          maxWidth: '100%',
          textAlign: 'center'
        }}
        onDoubleClick={handleDoubleClick}
        title="Double-click to edit in properties panel"
      >
        {data.label}
      </div>
      
      {data.absorbing && (
        <div style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
          TERMINAL
        </div>
      )}
      
      {data.outcome_type && (
        <div style={{ fontSize: '10px', color: '#007bff', marginTop: '2px' }}>
          {data.outcome_type.toUpperCase()}
        </div>
      )}

      {data.entry?.is_start && (
        <div style={{ fontSize: '10px', color: '#16a34a', marginTop: '2px', fontWeight: 'bold' }}>
          START
        </div>
      )}

      {/* Case node status indicator */}
      {isCaseNode && data.case && (
        <div style={{ 
          position: 'absolute',
          top: '4px',
          right: '4px',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: getStatusColor(data.case.status),
          border: '1px solid #FFFFFF'
        }} title={`Status: ${data.case.status}`} />
      )}

      {/* Case node variant info */}
      {isCaseNode && data.case && (
        <div style={{ 
          fontSize: '9px', 
          color: '#FFFFFF', 
          marginTop: '2px',
          opacity: 0.9
        }}>
          {data.case.variants.length} variant{data.case.variants.length > 1 ? 's' : ''}
        </div>
      )}

      {/* What-If Analysis Indicator */}
      {isCaseNode && whatIfAnalysis && whatIfAnalysis.caseNodeId === data.id && (
        <div style={{
          position: 'absolute',
          top: '4px',
          left: '4px',
          fontSize: '16px',
          animation: 'pulse 2s infinite'
        }} title={`What-If Mode: ${whatIfAnalysis.selectedVariant} @ 100%`}>
          🔬
        </div>
      )}

      {/* Probability mass warning */}
      {probabilityMass && !probabilityMass.isComplete && (
        <div style={{ 
          fontSize: '9px', 
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
      
      {/* Output handles - all sides */}
      <Handle 
        type="source" 
        position={Position.Left} 
        id="left-out" 
        style={{ 
          background: '#007bff', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }} 
      />
      <Handle 
        type="source" 
        position={Position.Top} 
        id="top-out" 
        style={{ 
          background: '#007bff', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }} 
      />
      <Handle 
        type="source" 
        position={Position.Right} 
        id="right-out" 
        style={{ 
          background: '#007bff', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }} 
      />
      <Handle 
        type="source" 
        position={Position.Bottom} 
        id="bottom-out" 
        style={{ 
          background: '#007bff', 
          width: '8px', 
          height: '8px',
          opacity: showHandles ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }} 
      />
      
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
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={handleDelete}
          title="Delete node"
        >
          ×
        </div>
      )}
    </div>
    </Tooltip>
  );
}
