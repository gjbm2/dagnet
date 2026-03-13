import React, { useRef, useEffect, useCallback } from 'react';
import { NodeProps, NodeResizer, useViewport } from 'reactflow';
import type { Container } from '@/types';
import { InlineEditableLabel } from '../InlineEditableLabel';

export const CONTAINER_COLOURS = [
  '#94A3B8', '#86EFAC', '#7DD3FC', '#FCD34D', '#FDA4AF', '#C4B5FD',
];

const CONTAINER_COLOUR_NAMES: Record<string, string> = {
  '#94A3B8': 'Slate',
  '#86EFAC': 'Sage',
  '#7DD3FC': 'Sky',
  '#FCD34D': 'Amber',
  '#FDA4AF': 'Rose',
  '#C4B5FD': 'Violet',
};

interface ContainerNodeData {
  container: Container;
  onUpdate: (id: string, updates: Partial<Container>) => void;
  onDelete: (id: string) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export default function ContainerNode({ data, selected }: NodeProps<ContainerNodeData>) {
  const { container, onUpdate, onDelete, onResizeStart, onResizeEnd } = data;
  const { zoom } = useViewport();
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Store callbacks in refs so NodeResizer's d3-drag useEffect deps stay stable.
  // Without this, every parent re-render creates new inline closures →
  // NodeResizer's useEffect re-runs → d3-drag is torn down mid-resize.
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onResizeStartRef = useRef(onResizeStart);
  onResizeStartRef.current = onResizeStart;
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;
  const containerIdRef = useRef(container.id);
  containerIdRef.current = container.id;

  useEffect(() => {
    return () => { if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current); };
  }, []);

  const handleResizeStart = useCallback(() => {
    onResizeStartRef.current?.();
  }, []);

  const handleResize = useCallback((_event: any, params: { x: number; y: number; width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      onUpdateRef.current(containerIdRef.current, {
        x: Math.round(params.x), y: Math.round(params.y),
        width: Math.round(params.width), height: Math.round(params.height),
      });
    }, 50);
  }, []);

  const handleResizeEnd = useCallback((_event: any, params: { x: number; y: number; width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    onUpdateRef.current(containerIdRef.current, {
      x: Math.round(params.x), y: Math.round(params.y),
      width: Math.round(params.width), height: Math.round(params.height),
    });
    onResizeEndRef.current?.();
  }, []);

  const [r, g, b] = hexToRgb(container.colour);
  const fillBg = `rgba(${r}, ${g}, ${b}, 0.08)`;
  const borderColour = `rgba(${r}, ${g}, ${b}, 0.5)`;
  const labelBg = `rgba(${r}, ${g}, ${b}, 0.15)`;

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={120}
        lineStyle={{ display: 'none' }}
        handleStyle={{
          width: 8 / zoom, height: 8 / zoom, borderRadius: '2px',
          backgroundColor: container.colour, border: '1px solid var(--bg-primary)',
        }}
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
      />

      {selected && (
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); onDelete(container.id); }}
          title="Delete container"
          style={{
            position: 'absolute', top: -24 / zoom, right: -24 / zoom, width: 20 / zoom, height: 20 / zoom,
            borderRadius: '50%', border: '1px solid var(--border-primary)', background: 'var(--bg-primary)',
            color: 'var(--color-danger)', fontSize: 12 / zoom, lineHeight: `${18 / zoom}px`, textAlign: 'center',
            cursor: 'pointer', zIndex: 10, padding: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
            pointerEvents: 'auto',
          }}
        >
          ×
        </button>
      )}

      <div
        style={{
          width: '100%', height: '100%',
          backgroundColor: fillBg,
          border: `1.5px dashed ${borderColour}`,
          borderRadius: '4px',
          boxSizing: 'border-box',
          position: 'relative',
          boxShadow: selected
            ? `0 0 0 1px ${container.colour}, 0 2px 8px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06)`
            : 'none',
          transition: 'box-shadow 0.15s ease-out',
        }}
      >
        {/* Label bar — pointer-events: auto so it remains clickable
           even though the wrapper has pointer-events: none (for edge passthrough) */}
        <div
          style={{
            padding: '4px 8px',
            backgroundColor: labelBg,
            borderBottom: `1px solid ${borderColour}`,
            borderRadius: '3px 3px 0 0',
            fontSize: '8px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            minHeight: '20px',
            display: 'flex',
            alignItems: 'center',
            pointerEvents: 'auto',
          }}
        >
          <InlineEditableLabel
            value={container.label}
            placeholder="Group"
            selected={!!selected}
            onCommit={(v) => onUpdate(container.id, { label: v })}
          />
        </div>
      </div>
    </>
  );
}

export { CONTAINER_COLOUR_NAMES };
