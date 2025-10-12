import React, { useState, useCallback } from 'react';
import { EdgeProps, getBezierPath, EdgeLabelRenderer, useReactFlow, MarkerType, Handle, Position, getSmoothStepPath } from 'reactflow';

interface ConversionEdgeData {
  id: string;
  probability: number;
  stdev?: number;
  locked?: boolean;
  description?: string;
  costs?: {
    monetary?: number;
    time?: number;
    units?: string;
  };
  weight_default?: number;
  onUpdate: (id: string, data: Partial<ConversionEdgeData>) => void;
  onDelete: (id: string) => void;
  onReconnect?: (id: string, newSource?: string, newTarget?: string) => void;
  onDoubleClick?: (id: string, field: string) => void;
  onSelect?: (id: string) => void;
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
  const { deleteElements, setEdges } = useReactFlow();


  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });




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
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M0,0 L0,6 L9,3 z"
            fill={selected ? '#007bff' : (data?.probability === undefined || data?.probability === null) ? '#ff6b6b' : '#999'}
          />
        </marker>
      </defs>
      
      <path
        id={id}
        style={{
          stroke: selected ? '#007bff' : (data?.probability === undefined || data?.probability === null) ? '#ff6b6b' : '#999',
          strokeWidth: selected ? 3 : (data?.probability === undefined || data?.probability === null) ? 3 : 2,
          fill: 'none',
          cursor: 'pointer',
          zIndex: selected ? 1000 : 1,
          strokeDasharray: (data?.probability === undefined || data?.probability === null) ? '5,5' : 'none',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={`url(#arrow-${id})`}
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
      
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: selected ? '#007bff' : '#fff',
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
                  <div>£{data.costs.monetary}{data.costs.units && ` ${data.costs.units}`}</div>
                )}
                {data.costs.time && (
                  <div>{data.costs.time}h{data.costs.units && ` ${data.costs.units}`}</div>
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
              left: sourceX - 6,
              top: sourceY - 6,
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
              left: targetX - 6,
              top: targetY - 6,
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
