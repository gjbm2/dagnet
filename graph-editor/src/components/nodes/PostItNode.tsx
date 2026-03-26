import React, { useState, useRef, useEffect, useCallback } from 'react';
import { NodeProps, NodeResizer, useViewport } from 'reactflow';
import { getLastSnappedResize, clearLastSnappedResize } from '../../services/snapService';
import { groupResizeStart, groupResize, groupResizeEnd } from '../canvas/useGroupResize';
import { beginResizeGuard, endResizeGuard } from '../canvas/syncGuards';
import type { GraphData } from '@/types';
import { PostItEditor } from './PostItEditor';
import { useElementTool } from '../../contexts/ElementToolContext';
import { useTheme } from '../../contexts/ThemeContext';
import { MinimiseCornerArrows, CORNER_ORIGINS } from '../canvas/MinimiseCornerArrows';
import type { AnchorCorner } from '../canvas/MinimiseCornerArrows';

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

/** Format an ISO timestamp as a human-readable relative string. */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Build the attribution string shown beneath / on hover of a post-it. */
function postitAttribution(postit: PostItType): string | null {
  const parts: string[] = [];
  if (postit.createdBy) parts.push(`@${postit.createdBy}`);
  if (postit.createdAt) {
    const rel = formatRelativeTime(postit.createdAt);
    if (rel) parts.push(rel);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

interface PostItNodeData {
  postit: PostItType;
  onUpdate: (id: string, updates: Partial<PostItType>) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  autoEdit?: boolean;
}

export default function PostItNode({ data, selected, dragging }: NodeProps<PostItNodeData>) {
  const { postit, onUpdate, onDelete } = data;
  const { zoom } = useViewport();
  const { activeElementTool } = useElementTool();
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const interactionDisabled = activeElementTool === 'pan';
  const minimised = !!postit.minimised;
  const prevMinimisedRef = useRef(minimised);
  const prevAnchorRef = useRef<string | undefined>((postit as any).minimised_anchor);
  const restoreAnimUntilRef = useRef(0);
  const restoredAnchorStash = useRef('tl');
  const [, forceRender] = useState(0);
  if (prevMinimisedRef.current && !minimised) {
    restoreAnimUntilRef.current = Date.now() + 180;
    restoredAnchorStash.current = prevAnchorRef.current || 'tl';
  }
  prevMinimisedRef.current = minimised;
  prevAnchorRef.current = (postit as any).minimised_anchor;
  const justRestored = Date.now() < restoreAnimUntilRef.current;
  const restoredAnchor = justRestored ? restoredAnchorStash.current : undefined;
  useEffect(() => {
    if (!justRestored) return;
    const remaining = restoreAnimUntilRef.current - Date.now();
    if (remaining <= 0) return;
    const t = setTimeout(() => forceRender(n => n + 1), remaining);
    return () => clearTimeout(t);
  }, [justRestored]);
  const [editing, setEditing] = useState(false);
  const [focusAt, setFocusAt] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [iconHovered, setIconHovered] = useState(false);
  const hoverOffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOn = useCallback(() => { if (hoverOffTimer.current) { clearTimeout(hoverOffTimer.current); hoverOffTimer.current = null; } setHovered(true); setIconHovered(true); }, []);
  const hoverOff = useCallback(() => { setIconHovered(false); hoverOffTimer.current = setTimeout(() => setHovered(false), 800); }, []);
  const [cornerHint, setCornerHint] = useState<AnchorCorner | null>(null);
  const lastCornerRef = useRef<AnchorCorner | null>((postit as any).minimised_anchor ?? null);
  if (cornerHint) lastCornerRef.current = cornerHint;
  else if (!lastCornerRef.current && (postit as any).minimised_anchor) lastCornerRef.current = (postit as any).minimised_anchor;
  const hintSuppressedUntil = useRef(0);
  const setCornerHintGuarded = useCallback((c: AnchorCorner | null) => {
    if (c && Date.now() < hintSuppressedUntil.current) return;
    setCornerHint(c);
  }, []);
  const suppressHint = useCallback(() => { hintSuppressedUntil.current = Date.now() + 500; setCornerHint(null); }, []);
  if (dragging && cornerHint) setCornerHint(null);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const didMoveRef = useRef(false);
  const fontSize = FONT_SIZES[postit.fontSize || 'M'];

  // Store callbacks in refs so NodeResizer's d3-drag useEffect deps stay stable.
  // Without this, every parent re-render creates new inline closures →
  // NodeResizer's useEffect re-runs → d3-drag is torn down mid-resize.
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  // onResizeStart/onResizeEnd from data are no longer used — guard is called
  // directly via module-level singleton (beginResizeGuard/endResizeGuard).
  const postitIdRef = useRef(postit.id);
  postitIdRef.current = postit.id;

  useEffect(() => {
    return () => { if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current); };
  }, []);

  const stableResizeStart = useCallback(() => {
    beginResizeGuard();
    groupResizeStart(`postit-${postitIdRef.current}`);
  }, []);
  const stableResize = useCallback((_event: any, params: { x: number; y: number; width: number; height: number }) => {
    groupResize(`postit-${postitIdRef.current}`, params.width, params.height);
    // No mid-drag onUpdate — saving to graph store during resize triggers the
    // sync effect which applies stale positions from React state, causing the
    // node to bounce. stableResizeEnd saves the final state instead.
  }, []);
  const stableResizeEnd = useCallback((_event: any, params: { x: number; y: number; width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    // Use snapped dimensions if available — d3-drag doesn't know about
    // snap adjustments, so its params would cause a "bounce" on release.
    const snap = getLastSnappedResize();
    const rfNodeId = `postit-${postitIdRef.current}`;
    const useSnap = snap && snap.nodeId === rfNodeId;
    if (import.meta.env.DEV) {
      console.log('[PostIt] stableResizeEnd', {
        nodeId: postitIdRef.current,
        snap,
        useSnap,
        d3Params: params,
        willWrite: useSnap
          ? { x: Math.round(snap!.x), y: Math.round(snap!.y), w: Math.round(snap!.width), h: Math.round(snap!.height) }
          : { x: Math.round(params.x), y: Math.round(params.y), w: Math.round(params.width), h: Math.round(params.height) },
      });
    }
    const finalW = Math.round(useSnap ? snap!.width : params.width);
    const finalH = Math.round(useSnap ? snap!.height : params.height);
    onUpdateRef.current(postitIdRef.current, {
      x: Math.round(useSnap ? snap!.x : params.x),
      y: Math.round(useSnap ? snap!.y : params.y),
      width: finalW,
      height: finalH,
    });
    clearLastSnappedResize();
    groupResizeEnd(`postit-${postitIdRef.current}`, finalW, finalH);
    endResizeGuard();
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

  const bgColour = dark ? (POSTIT_COLOURS_DARK[postit.colour] || postit.colour) : postit.colour;

  const minimisedAnchor = (postit as any).minimised_anchor as 'tl' | 'tr' | 'bl' | 'br' | undefined;

  const handleMinimise = useCallback((anchor: 'tl' | 'tr' | 'bl' | 'br') => {
    suppressHint();
    window.dispatchEvent(new Event('dagnet:hideConnectors'));
    const mw = 32, mh = 32;
    const dx = (anchor === 'tr' || anchor === 'br') ? postit.width - mw : 0;
    const dy = (anchor === 'bl' || anchor === 'br') ? postit.height - mh : 0;
    onUpdate(postit.id, {
      minimised: true, minimised_anchor: anchor,
      x: postit.x + dx, y: postit.y + dy,
    } as any);
  }, [postit.id, postit.x, postit.y, postit.width, postit.height, onUpdate, suppressHint]);

  const handleRestore = useCallback(() => {
    suppressHint();
    window.dispatchEvent(new Event('dagnet:hideConnectors'));
    const anchor = minimisedAnchor || 'tl';
    const mw = 32, mh = 32;
    const dx = (anchor === 'tr' || anchor === 'br') ? postit.width - mw : 0;
    const dy = (anchor === 'bl' || anchor === 'br') ? postit.height - mh : 0;
    onUpdate(postit.id, {
      minimised: false,
      x: postit.x - dx, y: postit.y - dy,
    } as any);
  }, [postit.id, postit.x, postit.y, postit.width, postit.height, minimisedAnchor, onUpdate, suppressHint]);

  // Auto-dismiss hover label after 5s to prevent stale labels
  useEffect(() => {
    if (!hovered || !minimised) return;
    const t = setTimeout(() => hoverOff(), 5000);
    return () => clearTimeout(t);
  }, [hovered, minimised]);

  // ── Minimised rendering ──────────────────────────────────────────────
  if (minimised) {
    const attr = postitAttribution(postit);
    const minimisedLabel = attr || (postit.text || '').split('\n')[0].slice(0, 40) || 'Post-it';
    return (
      <>
        <MinimiseCornerArrows
          minimisedAnchor={minimisedAnchor || 'tl'}
          visible={hovered}
          disabled={dragging || selected}
          zoom={zoom}
          nodeWidth={32}
          nodeHeight={32}
          colour={dark ? '#e0e0e0' : '#555'}
          onMinimise={handleMinimise}
          onRestore={handleRestore}
          onMouseEnter={hoverOn}
          onMouseLeave={hoverOff}
          onCornerHover={setCornerHintGuarded}
        />

        {/* Selection UI: delete button */}
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

        {/* Ghost outline showing full-size bounds on hover */}
        {(() => {
          const anchor = minimisedAnchor || 'tl';
          const ghostLeft = (anchor === 'tr' || anchor === 'br') ? -(postit.width - 32) : 0;
          const ghostTop = (anchor === 'bl' || anchor === 'br') ? -(postit.height - 32) : 0;
          const originX = (anchor === 'tr' || anchor === 'br') ? 'right' : 'left';
          const originY = (anchor === 'bl' || anchor === 'br') ? 'bottom' : 'top';
          return (
            <div
              className={iconHovered ? 'minimised-ghost-expand' : 'minimised-ghost-collapse'}
              style={{
                position: 'absolute', left: ghostLeft, top: ghostTop,
                width: postit.width, height: postit.height,
                border: `1.5px dashed ${dark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.18)'}`,
                borderRadius: '1px',
                pointerEvents: 'none',
                transformOrigin: `${originY} ${originX}`,
              }}
            />
          );
        })()}

        <div
          className="canvas-annotation-minimised"
          data-anchor={minimisedAnchor || 'tl'}
          onClick={(e) => {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.stopPropagation();
              suppressHint();
              window.dispatchEvent(new Event('dagnet:hideConnectors'));
              const anchor = minimisedAnchor || 'tl';
              const mw = 32, mh = 32;
              const dx = (anchor === 'tr' || anchor === 'br') ? postit.width - mw : 0;
              const dy = (anchor === 'bl' || anchor === 'br') ? postit.height - mh : 0;
              const rid = postit.id, rx = postit.x - dx, ry = postit.y - dy;
              requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
                onUpdate(rid, { minimised: false, x: rx, y: ry } as any);
              })));
            }
          }}
          onMouseEnter={() => { hoverOn(); }}
          onMouseLeave={() => { hoverOff(); }}
          style={{
            width: 32, height: 32,
            backgroundColor: bgColour,
            borderRadius: '1px',
            border: selected ? '2px solid #3b82f6' : '1px solid rgba(0,0,0,0.04)',
            boxShadow: selected
              ? '0 0 0 1px #3b82f6, 0 1px 3px rgba(0,0,0,0.15)'
              : '0 0px 1px rgba(0,0,0,0.04), 0 2px 4px rgba(0,0,0,0.06)',
            boxSizing: 'border-box',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Folded corner */}
          <svg style={{ position: 'absolute', bottom: 0, right: 0 }} width="12" height="12" viewBox="0 0 12 12">
            <path d="M12 0 L12 12 L0 12 Z" fill={dark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.1)'} />
            <path d="M12 0 L0 12 L0 0 Z" fill={dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.4)'} />
          </svg>
        </div>

        {/* Hover label — vertically centred with icon */}
        {hovered && (
          <div className="nodrag nopan" style={{
            position: 'absolute',
            ...((minimisedAnchor === 'tr' || minimisedAnchor === 'br') ? { right: 34 } : { left: 34 }),
            top: 0, height: 32,
            display: 'flex', alignItems: 'center',
            fontSize: 12 / zoom, lineHeight: 1,
            color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)',
            whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
            background: dark ? 'rgba(30,30,30,0.7)' : 'rgba(255,255,255,0.7)',
            backdropFilter: 'blur(6px)',
            borderRadius: 4 / zoom, padding: `${2 / zoom}px ${6 / zoom}px`,
            transition: 'left 300ms cubic-bezier(0.25, 0.1, 0.25, 1) 80ms',
          }}>
            {minimisedLabel}
          </div>
        )}
      </>
    );
  }

  // ── Normal rendering ─────────────────────────────────────────────────
  return (
    <>
      <MinimiseCornerArrows
        visible={hovered && !dragging && !selected}
        zoom={zoom}
        nodeWidth={postit.width}
        nodeHeight={postit.height}
        colour={dark ? '#e0e0e0' : '#555'}
        onMinimise={handleMinimise}
        onRestore={handleRestore}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
        onCornerHover={setCornerHintGuarded}
      />
      {/* Ghost outline — original bounds while shrinking */}
      <div style={{
        position: 'absolute', inset: 0,
        border: `1.5px dashed ${dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)'}`,
        borderRadius: '1px',
        opacity: cornerHint ? 1 : 0,
        transition: cornerHint
          ? 'opacity 300ms ease 200ms'
          : 'opacity 200ms ease',
        pointerEvents: 'none',
      }} />
      <div
        className={justRestored ? 'canvas-annotation-normal' : undefined}
        {...(restoredAnchor ? { 'data-anchor': restoredAnchor } : {})}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
        style={{
          position: 'relative', width: '100%', height: '100%',
          transform: cornerHint
            ? `scale(${(postit.width - 12) / postit.width}, ${(postit.height - 12) / postit.height})`
            : undefined,
          transformOrigin: CORNER_ORIGINS[cornerHint ?? lastCornerRef.current ?? 'tl'],
          transition: 'transform 300ms cubic-bezier(0.25, 0.1, 0.25, 1) 200ms',
        }}
      >

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
          backgroundColor: bgColour,
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
        <svg style={{ position: 'absolute', bottom: 0, right: 0, pointerEvents: 'none' }} width="20" height="20" viewBox="0 0 20 20">
          <path d="M20 0 L20 20 L0 20 Z" fill={dark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.1)'} />
          <path d="M20 0 L0 20 L0 0 Z" fill={dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.4)'} />
        </svg>

        <PostItEditor
          content={postit.text}
          fontSize={fontSize}
          fontSizeKey={postit.fontSize || 'M'}
          colour={postit.colour}
          editing={editing}
          zoom={zoom}
          focusAt={focusAt}
          onFocusAtApplied={() => setFocusAt(null)}
          onEditingChange={(isEditing) => {
            if (!isEditing) handleTextCommit();
            setEditing(isEditing);
          }}
          onChange={handleChange}
          onFontSizeChange={(key) => onUpdate(postit.id, { fontSize: key as 'S' | 'M' | 'L' | 'XL' })}
          onColourChange={(hex) => onUpdate(postit.id, { colour: hex })}
        />
      </div>

      {/* Attribution line below the post-it */}
      {!editing && (hovered || selected) && (() => {
        const attr = postitAttribution(postit);
        return attr ? (
          <div className="nodrag nopan" style={{
            position: 'absolute', bottom: -18 / zoom, left: 2 / zoom,
            fontSize: 11 / zoom, lineHeight: 1,
            color: dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.32)',
            whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
          }}>
            {attr}
          </div>
        ) : null;
      })()}
      </div>
    </>
  );
}
