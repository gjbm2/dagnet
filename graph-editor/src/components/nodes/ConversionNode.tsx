import React, { useState, useCallback } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

interface ConversionNodeData {
  id: string;
  label: string;
  slug: string;
  absorbing: boolean;
  outcome_type?: string;
  description?: string;
  entry?: { is_start?: boolean; entry_weight?: number };
  onUpdate: (id: string, data: Partial<ConversionNodeData>) => void;
  onDelete: (id: string) => void;
}

export default function ConversionNode({ data, selected }: NodeProps<ConversionNodeData>) {
  const [isEditing, setIsEditing] = useState(false);
  const [label, setLabel] = useState(data.label);

  const handleLabelChange = useCallback((newLabel: string) => {
    setLabel(newLabel);
    data.onUpdate(data.id, { label: newLabel });
  }, [data]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      setIsEditing(false);
    }
    if (e.key === 'Escape') {
      setLabel(data.label);
      setIsEditing(false);
    }
  }, [data.label]);

  const handleDoubleClick = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleDelete = useCallback(() => {
    if (confirm('Delete this node?')) {
      data.onDelete(data.id);
    }
  }, [data]);

  return (
    <div 
      className={`conversion-node ${selected ? 'selected' : ''} ${data.absorbing ? 'absorbing' : ''}`}
      style={{
        padding: '12px',
        border: selected ? '2px solid #007bff' : '2px solid #ddd',
        borderRadius: '8px',
        background: data.absorbing ? '#ffebee' : '#fff',
        minWidth: '120px',
        textAlign: 'center',
        cursor: 'pointer',
        boxShadow: selected ? '0 4px 8px rgba(0,123,255,0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
        transition: 'all 0.2s ease'
      }}
    >
      {/* Input handles - all sides */}
      <Handle 
        type="target" 
        position={Position.Left} 
        id="left" 
        style={{ background: '#555', width: '8px', height: '8px' }} 
      />
      <Handle 
        type="target" 
        position={Position.Top} 
        id="top" 
        style={{ background: '#555', width: '8px', height: '8px' }} 
      />
      <Handle 
        type="target" 
        position={Position.Right} 
        id="right" 
        style={{ background: '#555', width: '8px', height: '8px' }} 
      />
      <Handle 
        type="target" 
        position={Position.Bottom} 
        id="bottom" 
        style={{ background: '#555', width: '8px', height: '8px' }} 
      />
      
      {isEditing ? (
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            handleLabelChange(label);
            setIsEditing(false);
          }}
          onKeyDown={handleKeyPress}
          style={{
            border: 'none',
            background: 'transparent',
            textAlign: 'center',
            fontWeight: 'bold',
            width: '100%',
            outline: 'none',
            fontSize: '14px'
          }}
          autoFocus
        />
      ) : (
        <div 
          style={{ fontWeight: 'bold', marginBottom: '4px', fontSize: '14px' }}
          onDoubleClick={handleDoubleClick}
        >
          {label}
        </div>
      )}
      
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
      
      {/* Output handles - all sides */}
      <Handle 
        type="source" 
        position={Position.Left} 
        id="left-out" 
        style={{ background: '#007bff', width: '8px', height: '8px' }} 
      />
      <Handle 
        type="source" 
        position={Position.Top} 
        id="top-out" 
        style={{ background: '#007bff', width: '8px', height: '8px' }} 
      />
      <Handle 
        type="source" 
        position={Position.Right} 
        id="right-out" 
        style={{ background: '#007bff', width: '8px', height: '8px' }} 
      />
      <Handle 
        type="source" 
        position={Position.Bottom} 
        id="bottom-out" 
        style={{ background: '#007bff', width: '8px', height: '8px' }} 
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
  );
}
