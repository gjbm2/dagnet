import React, { useState, useRef, useEffect, useCallback } from 'react';
import { NodeProps, NodeResizer, useViewport } from 'reactflow';
import type { GraphData } from '@/types';
import { PostItEditor } from './PostItEditor';
import { useElementTool } from '../../contexts/ElementToolContext';
import { useTheme } from '../../contexts/ThemeContext';

type PostItType = NonNullable<GraphData['postits']>[number];

export const POSTIT_COLOURS = [
  '#FFF475', '#F4BFDB', '#B6E3E9', '#CEED9D', '#FFD59D', '#D3BFEE',
];

export const POSTIT_COLOURS_DARK: Record<string, string> = {
  '#FFF475': '#6B6328',
  '#F4BFDB': '#7A4060',
  '#B6E3E9': '#3A6B75',
  '#CEED9D': '#4A6530',
  '#FFD59D': '#7A5530',
  '#D3BFEE': '#5A4478',
};

const FONT_SIZES: Record<string, number> = { S: 6, M: 9, L: 13, XL: 18 };

interface PostItNodeData {
  postit: PostItType;
  onUpdate: (id: string, updates: Partial<PostItType>) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  autoEdit?: boolean;
}

export default function PostItNode({ data, selected }: NodeProps<PostItNodeData>) {
  const { postit, onUpdate, onDelete, onResizeStart, onResizeEnd } = data;
  const { zoom } = useViewport();
  const { activeElementTool } = useElementTool();
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const interactionDisabled = activeElementTool === 'pan';
  const [editing, setEditing] = useState(false);
  const [focusAt, setFocusAt] = useState<{ x: number; y: number } | null>(null);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const didMoveRef = useRef(false);
  const fontSize = FONT_SIZES[postit.fontSize || 'M'];

  // Store callbacks in refs so NodeResizer's d3-drag useEffect deps stay stable.
  // Without this, every parent re-render creates new inline closures →
  // NodeResizer's useEffect re-runs → d3-drag is torn down mid-resize.
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onResizeStartRef = useRef(onResizeStart);
  onResizeStartRef.current = onResizeStart;
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;
  const postitIdRef = useRef(postit.id);
  postitIdRef.current = postit.id;

  useEffect(() => {
    return () => { if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current); };
  }, []);

  const stableResizeStart = useCallback(() => { onResizeStartRef.current?.(); }, []);
  const stableResize = useCallback((_event: any, params: { width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      onUpdateRef.current(postitIdRef.current, { width: Math.round(params.width), height: Math.round(params.height) });
    }, 50);
  }, []);
  const stableResizeEnd = useCallback((_event: any, params: { width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    onUpdateRef.current(postitIdRef.current, { width: Math.round(params.width), height: Math.round(params.height) });
    onResizeEndRef.current?.();
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
          width: 8 / zoom, height: 8 / zoom, borderRadius: '2px',
          backgroundColor: '#3b82f6', border: '1px solid var(--bg-primary)',
        }}
        onResizeStart={stableResizeStart}
        onResize={stableResize}
        onResizeEnd={stableResizeEnd}
      />

      {selected && (
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); onDelete(postit.id); }}
          title="Delete post-it"
          style={{
            position: 'absolute', top: -24 / zoom, right: -24 / zoom, width: 20 / zoom, height: 20 / zoom,
            borderRadius: '50%', border: '1px solid var(--border-primary)', background: 'var(--bg-primary)',
            color: 'var(--color-danger)', fontSize: 12 / zoom, lineHeight: `${18 / zoom}px`, textAlign: 'center',
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
          width: '100%', height: '100%',
          backgroundColor: dark ? (POSTIT_COLOURS_DARK[postit.colour] || postit.colour) : postit.colour,
          color: dark ? '#e8e0d0' : '#333',
          boxShadow: selected
            ? '0 2px 4px rgba(0,0,0,0.06), 0 8px 16px rgba(0,0,0,0.12), 0 16px 32px rgba(0,0,0,0.08)'
            : '0 0px 1px rgba(0,0,0,0.04), 0 2px 4px rgba(0,0,0,0.06), 0 6px 12px rgba(0,0,0,0.08)',
          fontFamily: 'inherit', padding: '10px 12px', borderRadius: '1px',
          border: selected ? '1.5px solid rgba(0,0,0,0.15)' : '1px solid rgba(0,0,0,0.04)',
          position: 'relative', boxSizing: 'border-box', cursor: editing ? 'text' : 'default',
          transition: 'box-shadow 0.15s ease-out',
        }}
      >
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: '1px',
          background: dark
            ? 'linear-gradient(to bottom, rgba(255,255,255,0.03) 0%, transparent 40%)'
            : 'linear-gradient(to bottom, transparent 60%, rgba(0,0,0,0.03) 100%)',
        }} />
        <div style={{
          position: 'absolute', bottom: 0, right: 0, width: '16px', height: '16px',
          background: dark
            ? 'linear-gradient(315deg, rgba(0,0,0,0.15) 0%, transparent 50%)'
            : 'linear-gradient(315deg, rgba(0,0,0,0.08) 0%, transparent 50%)',
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
