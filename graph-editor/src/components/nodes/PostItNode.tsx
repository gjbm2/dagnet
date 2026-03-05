import React, { useState, useRef, useEffect, useCallback } from 'react';
import { NodeProps, NodeResizer } from 'reactflow';
import type { GraphData } from '@/types';
import { PostItEditor } from './PostItEditor';
import { useElementTool } from '../../contexts/ElementToolContext';

type PostItType = NonNullable<GraphData['postits']>[number];

export const POSTIT_COLOURS = [
  '#FFF475', '#F4BFDB', '#B6E3E9', '#CEED9D', '#FFD59D', '#D3BFEE',
];

const FONT_SIZES: Record<string, number> = { S: 6, M: 9, L: 13, XL: 18 };

interface PostItNodeData {
  postit: PostItType;
  onUpdate: (id: string, updates: Partial<PostItType>) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  autoEdit?: boolean;
}

export default function PostItNode({ data, selected }: NodeProps<PostItNodeData>) {
  const { postit, onUpdate, onDelete } = data;
  const { activeElementTool } = useElementTool();
  const interactionDisabled = activeElementTool === 'pan';
  const [editing, setEditing] = useState(false);
  const [focusAt, setFocusAt] = useState<{ x: number; y: number } | null>(null);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const didMoveRef = useRef(false);
  const fontSize = FONT_SIZES[postit.fontSize || 'M'];

  useEffect(() => {
    return () => { if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current); };
  }, []);

  const pendingAutoEditRef = useRef(false);

  useEffect(() => {
    if (data.autoEdit) {
      console.log(`[PostItNode ${postit.id.slice(0,8)}] autoEdit flag received`);
      pendingAutoEditRef.current = true;
    }
  }, [data.autoEdit, postit.id]);

  useEffect(() => {
    console.log(`[PostItNode ${postit.id.slice(0,8)}] selection effect: pending=${pendingAutoEditRef.current}, selected=${selected}, editing=${editing}`);
    if (pendingAutoEditRef.current && selected && !editing) {
      console.log(`[PostItNode ${postit.id.slice(0,8)}] → entering edit mode`);
      pendingAutoEditRef.current = false;
      setEditing(true);
    } else if ((!selected || interactionDisabled) && editing) {
      setEditing(false);
    }
  }, [selected, editing, interactionDisabled]);

  const pendingTextRef = useRef<string | null>(null);

  const handleChange = useCallback((md: string) => {
    pendingTextRef.current = md;
  }, []);

  const handleTextCommit = useCallback(() => {
    if (pendingTextRef.current !== null && pendingTextRef.current !== postit.text) {
      onUpdate(postit.id, { text: pendingTextRef.current });
    }
    pendingTextRef.current = null;
  }, [postit.id, postit.text, onUpdate]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (editing || interactionDisabled) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;

    const target = e.target as HTMLElement | null;
    if (target?.closest('button')) return;

    pointerDownRef.current = { x: e.clientX, y: e.clientY, active: true };
    didMoveRef.current = false;
  }, [editing, interactionDisabled]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (editing || interactionDisabled) return;
    if (!pointerDownRef.current.active) return;

    const dx = e.clientX - pointerDownRef.current.x;
    const dy = e.clientY - pointerDownRef.current.y;
    if ((dx * dx + dy * dy) > 9) {
      didMoveRef.current = true;
    }
  }, [editing, interactionDisabled]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (editing || interactionDisabled) return;
    if (!pointerDownRef.current.active) return;

    pointerDownRef.current.active = false;

    if (didMoveRef.current) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;

    const target = e.target as HTMLElement | null;
    if (target?.closest('button')) return;

    setFocusAt({ x: e.clientX, y: e.clientY });
    setEditing(true);
  }, [editing, interactionDisabled]);

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={150}
        minHeight={80}
        lineStyle={{ display: 'none' }}
        handleStyle={{
          width: '8px', height: '8px', borderRadius: '2px',
          backgroundColor: '#3b82f6', border: '1px solid #fff',
        }}
        onResize={(_event, params) => {
          if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
          resizeTimeoutRef.current = setTimeout(() => {
            onUpdate(postit.id, { width: Math.round(params.width), height: Math.round(params.height) });
          }, 50);
        }}
      />

      {selected && (
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); onDelete(postit.id); }}
          title="Delete post-it"
          style={{
            position: 'absolute', top: -10, right: -10, width: '20px', height: '20px',
            borderRadius: '50%', border: '1px solid rgba(0,0,0,0.15)', background: '#fff',
            color: '#dc3545', fontSize: '12px', lineHeight: '18px', textAlign: 'center',
            cursor: 'pointer', zIndex: 10, padding: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          }}
        >
          ×
        </button>
      )}

      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          width: '100%', height: '100%', backgroundColor: postit.colour,
          boxShadow: '0 0px 1px rgba(0,0,0,0.04), 0 2px 4px rgba(0,0,0,0.06), 0 6px 12px rgba(0,0,0,0.08)',
          fontFamily: 'inherit', padding: '10px 12px', borderRadius: '1px',
          border: selected ? '1.5px solid rgba(0,0,0,0.15)' : '1px solid rgba(0,0,0,0.04)',
          position: 'relative', boxSizing: 'border-box', cursor: editing ? 'text' : 'default',
        }}
      >
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: '1px',
          background: 'linear-gradient(to bottom, transparent 60%, rgba(0,0,0,0.03) 100%)',
        }} />
        <div style={{
          position: 'absolute', bottom: 0, right: 0, width: '16px', height: '16px',
          background: 'linear-gradient(315deg, rgba(0,0,0,0.08) 0%, transparent 50%)',
          pointerEvents: 'none',
        }} />

        <PostItEditor
          content={postit.text}
          fontSize={fontSize}
          editing={editing}
          focusAt={focusAt}
          onFocusAtApplied={() => setFocusAt(null)}
          onEditingChange={(isEditing) => {
            if (!isEditing) handleTextCommit();
            setEditing(isEditing);
          }}
          onChange={handleChange}
        />
      </div>
    </>
  );
}
