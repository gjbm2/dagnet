import React, { useState, useRef, useEffect, useCallback } from 'react';

interface InlineEditableLabelProps {
  value: string;
  placeholder?: string;
  /** Whether the parent node is currently selected (controls edit eligibility) */
  selected: boolean;
  onCommit: (newValue: string) => void;
  /** Style applied to both display and edit states */
  style?: React.CSSProperties;
  /** Extra style merged only during display (span) */
  displayStyle?: React.CSSProperties;
  /** Extra style merged only during edit (input) */
  editStyle?: React.CSSProperties;
}

/**
 * Inline-editable label shared across all canvas object types.
 *
 * Interaction contract:
 *  - Click on label of an already-selected node → enter edit mode (text selected)
 *  - Click on label of unselected node → just selects (ReactFlow default)
 *  - Pointer movement > 3 px suppresses edit (allows drag)
 *  - Enter → commit
 *  - Escape → cancel (revert to original)
 *  - Blur or node deselection → commit
 *  - className "nodrag nowheel" on input prevents ReactFlow interference
 */
export function InlineEditableLabel({
  value,
  placeholder = 'Untitled',
  selected,
  onCommit,
  style,
  displayStyle,
  editStyle,
}: InlineEditableLabelProps) {
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasSelectedRef = useRef(false);
  const pointerDownPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!editing) setLocalValue(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Mark the ReactFlow node wrapper so CSS can suppress resize handles during editing
  useEffect(() => {
    if (!editing || !inputRef.current) return;
    const nodeEl = inputRef.current.closest('.react-flow__node');
    if (!nodeEl) return;
    nodeEl.classList.add('dagnet-inline-editing');
    return () => { nodeEl.classList.remove('dagnet-inline-editing'); };
  }, [editing]);

  // Commit and exit edit mode when node is deselected
  useEffect(() => {
    if (!selected && editing) {
      setEditing(false);
      const trimmed = localValue.trim() || placeholder;
      if (trimmed !== value) {
        onCommit(trimmed);
      }
    }
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = localValue.trim() || placeholder;
    if (trimmed !== value) {
      onCommit(trimmed);
    }
  }, [localValue, value, placeholder, onCommit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { setEditing(false); setLocalValue(value); }
  }, [commit, value]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    wasSelectedRef.current = selected;
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
  }, [selected]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (editing) return;
    if (!wasSelectedRef.current) return;
    const dx = e.clientX - pointerDownPos.current.x;
    const dy = e.clientY - pointerDownPos.current.y;
    if (dx * dx + dy * dy > 9) return;
    e.stopPropagation();
    setEditing(true);
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="nodrag nowheel"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        style={{
          position: 'relative',
          zIndex: 10000,
          width: '100%',
          border: '1px solid var(--border-primary)',
          borderRadius: 2,
          background: 'var(--bg-input)',
          boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
          outline: 'none',
          padding: '3px 5px',
          margin: '-4px -6px',
          font: 'inherit',
          color: 'var(--text-primary)',
          ...style,
          ...editStyle,
        }}
      />
    );
  }

  return (
    <span
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      style={{
        cursor: 'default',
        userSelect: 'none',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        ...style,
        ...displayStyle,
      }}
      title="Click to edit"
    >
      {value || placeholder}
    </span>
  );
}
