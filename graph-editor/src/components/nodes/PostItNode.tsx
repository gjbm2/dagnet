import React, { useState, useRef, useEffect, useCallback } from 'react';
import { NodeProps, NodeResizer } from 'reactflow';
import { GraphData } from '@/types';

type PostItType = NonNullable<GraphData['postits']>[number];

// Traditional Post-it Note Colours
const POSTIT_COLOURS = [
  '#FFF59D', // Canary Yellow (classic Post-it)
  '#FFB3D9', // Pink
  '#AED6F1', // Sky Blue
  '#A8E6CF', // Mint Green
  '#FFCCBC', // Peach/Apricot
  '#E1BEE7', // Lavender
];

interface PostItNodeData {
  postit: PostItType;
  onUpdate: (id: string, updates: Partial<PostItType>) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}

export default function PostItNode({ data, selected }: NodeProps<PostItNodeData>) {
  const { postit, onUpdate, onDelete, onSelect } = data;
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState(postit.text);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-focus when editing starts
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  // Cleanup resize timeout on unmount
  useEffect(() => {
    return () => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    if (text !== postit.text) {
      onUpdate(postit.id, { text });
    }
  }, [text, postit.text, postit.id, onUpdate]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowContextMenu(true);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    onSelect(postit.id);
  }, [onSelect, postit.id]);

  useEffect(() => {
    const handleClickOutside = () => setShowContextMenu(false);
    if (showContextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showContextMenu]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(postit.id);
  }, [onSelect, postit.id]);

  // Helper to darken colour for folded corner
  const adjustColourBrightness = (colour: string, amount: number): string => {
    const hex = colour.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substring(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substring(2, 4), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substring(4, 6), 16) + amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  };

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={150}
        minHeight={100}
        onResize={(event, params) => {
          // Debounce updates during resize to prevent infinite loops
          if (resizeTimeoutRef.current) {
            clearTimeout(resizeTimeoutRef.current);
          }
          
          resizeTimeoutRef.current = setTimeout(() => {
            onUpdate(postit.id, { 
              width: params.width,
              height: params.height 
            });
          }, 50); // Update after 50ms of no resize events
        }}
      />
      
      <div
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        style={{
          width: `${postit.width}px`,
          height: `${postit.height}px`,
          backgroundColor: postit.colour,
          boxShadow: selected ? '0 4px 12px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.15)',
          cursor: isEditing ? 'text' : 'pointer',
          fontFamily: 'Comic Sans MS, cursive, sans-serif',
          padding: '12px',
          userSelect: isEditing ? 'text' : 'none',
          clipPath: 'polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 0 100%)',
          border: selected ? '2px solid rgba(0,0,0,0.2)' : 'none',
          transition: 'box-shadow 0.2s ease',
          position: 'relative',
        }}
      >
        {/* Folded corner */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 0,
            height: 0,
            borderStyle: 'solid',
            borderWidth: '0 20px 20px 0',
            borderColor: `transparent ${adjustColourBrightness(postit.colour, -20)} transparent transparent`,
            pointerEvents: 'none',
          }}
        />
        
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.currentTarget.blur();
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              background: 'transparent',
              fontFamily: 'inherit',
              fontSize: '14px',
              resize: 'none',
              outline: 'none',
              color: '#333',
            }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              fontSize: '14px',
              color: '#333',
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word',
              overflow: 'hidden',
            }}
          >
            {postit.text || 'Double-click to edit...'}
          </div>
        )}
      </div>

      {/* Context menu */}
      {showContextMenu && (
        <div
          style={{
            position: 'fixed',
            left: `${contextMenuPos.x}px`,
            top: `${contextMenuPos.y}px`,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 10003,
            minWidth: '160px',
            padding: '4px 0',
          }}
        >
          <div style={{ padding: '8px 12px', fontSize: '12px', fontWeight: '600', color: '#666' }}>
            Colour
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px', padding: '4px 12px' }}>
            {POSTIT_COLOURS.map((colour) => (
              <div
                key={colour}
                onClick={() => {
                  onUpdate(postit.id, { colour });
                  setShowContextMenu(false);
                }}
                style={{
                  width: '32px',
                  height: '32px',
                  backgroundColor: colour,
                  border: postit.colour === colour ? '2px solid #333' : '1px solid #ddd',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
          <div style={{ borderTop: '1px solid #eee', margin: '4px 0' }} />
          <div
            onClick={() => {
              onDelete(postit.id);
              setShowContextMenu(false);
            }}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#dc3545',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Delete Post-It
          </div>
        </div>
      )}
    </>
  );
}

