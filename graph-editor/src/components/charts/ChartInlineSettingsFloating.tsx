/**
 * Floating palette that snaps to 4 corners or top toolbar.
 * Handle (icon) stays pinned at the anchor; tray expands inward on hover.
 * In 'top' mode the palette becomes a full-width toolbar and the chart shrinks.
 * Tray collapses when dragging. Chart pointer-events suppressed during drag.
 */

import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';

const INSET = 10;
const HANDLE_W = 32;
const HANDLE_H = 28;
const TOP_ZONE_H = 40;

type Anchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top';

function anchorXY(a: Anchor, cw: number, ch: number) {
  if (a === 'top') return { x: 0, y: 0 };
  return {
    x: a.includes('left') ? INSET : cw - HANDLE_W - INSET,
    y: a.includes('top') ? INSET : ch - HANDLE_H - INSET,
  };
}

function anchorCSS(a: Anchor): React.CSSProperties {
  if (a === 'top') return {};
  const s: React.CSSProperties = { position: 'absolute' };
  if (a.includes('left')) s.left = INSET; else s.right = INSET;
  if (a.includes('top')) s.top = INSET; else s.bottom = INSET;
  return s;
}

function nearestAnchor(x: number, y: number, cw: number, ch: number): Anchor {
  if (y < TOP_ZONE_H && x > INSET && x < cw - HANDLE_W - INSET) return 'top';
  const midX = x + HANDLE_W / 2;
  const midY = y + HANDLE_H / 2;
  if (midY < ch / 2) return midX < cw / 2 ? 'top-left' : 'top-right';
  return midX < cw / 2 ? 'bottom-left' : 'bottom-right';
}

export interface ChartFloatingIconProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  tray?: React.ReactNode;
  /** Current canvas zoom level; toolbar scales at 1/zoom so it stays constant screen size. */
  canvasZoom?: number;
}

export function ChartFloatingIcon({ containerRef, tray, canvasZoom }: ChartFloatingIconProps) {
  const [anchor, setAnchor] = useState<Anchor>('top-right');
  const [drag, setDrag] = useState<{ x: number; y: number; snap: Anchor } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [box, setBox] = useState({ w: 200, h: 200 });
  const posRef = useRef({ x: 0, y: 0 });
  const teardownRef = useRef<(() => void) | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    teardownRef.current?.();
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => setBox({ w: el.offsetWidth, h: el.offsetHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const block = useCallback((e: React.SyntheticEvent) => { e.stopPropagation(); }, []);

  useEffect(() => {
    if (!drag) return;
    const ct = containerRef.current;
    if (!ct) return;
    const chart = ct.querySelector('.echarts-for-react') as HTMLElement | null;
    if (!chart) return;
    chart.style.pointerEvents = 'none';
    return () => { chart.style.pointerEvents = ''; };
  }, [drag, containerRef]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const ct = containerRef.current;
    if (!ct) return;

    const cw = ct.offsetWidth;
    const ch = ct.offsetHeight;
    const cr = ct.getBoundingClientRect();
    const scaleX = cr.width / cw || 1;
    const scaleY = cr.height / ch || 1;

    const { x: startX, y: startY } = anchorXY(anchor, cw, ch);
    const startClientX = e.clientX;
    const startClientY = e.clientY;

    posRef.current = { x: startX, y: startY };
    setHovered(false);
    setDrag({ x: startX, y: startY, snap: nearestAnchor(startX, startY, cw, ch) });

    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startClientX) / scaleX;
      const dy = (ev.clientY - startClientY) / scaleY;
      const nx = Math.max(0, Math.min(cw - HANDLE_W, startX + dx));
      const ny = Math.max(0, Math.min(ch - HANDLE_H, startY + dy));
      posRef.current = { x: nx, y: ny };
      setDrag({ x: nx, y: ny, snap: nearestAnchor(nx, ny, cw, ch) });
    };

    const onUp = () => {
      td();
      const el = containerRef.current;
      const w = el?.offsetWidth ?? box.w;
      const h = el?.offsetHeight ?? box.h;
      setAnchor(nearestAnchor(posRef.current.x, posRef.current.y, w, h));
      setDrag(null);
    };

    const td = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      teardownRef.current = null;
    };
    teardownRef.current = td;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [containerRef, box, anchor]);

  const isDragging = !!drag;
  const isTop = !isDragging && anchor === 'top';
  const isRight = !isDragging && !isTop && anchor.includes('right');
  const isBottom = !isDragging && !isTop && anchor.includes('bottom');
  const expanded = (hovered && !isDragging && !!tray) || isTop;

  const isGhostTop = drag?.snap === 'top';

  // Inverse-scale so the toolbar stays at constant screen-pixel size regardless of canvas zoom.
  // Skip in 'top' mode where the palette is position:relative and acts as a layout element.
  // Clamp: don't scale beyond what the container can fit (max 50% of container width for the tray).
  // Use CSS `zoom` instead of `transform: scale()` so that layout (flex-wrap, width)
  // recalculates at the scaled size — transform is visual-only and doesn't affect layout.
  const rawInvScale = canvasZoom && canvasZoom !== 1 && anchor !== 'top' ? 1 / canvasZoom : undefined;
  const maxScale = box.w > 0 ? Math.max(1, box.w / (HANDLE_W + 200)) : 2;
  const invScale = rawInvScale ? Math.min(rawInvScale, maxScale) : undefined;

  const zoomDiv = invScale ?? 1;
  const positionStyle: React.CSSProperties = drag
    ? { position: 'absolute', left: drag.x / zoomDiv, top: drag.y / zoomDiv }
    : anchorCSS(anchor);

  return (
    <>
      {drag && (
        <div
          className={`chart-floating-icon-ghost${isGhostTop ? ' ghost-top' : ''}`}
          style={{
            position: 'absolute',
            ...(isGhostTop ? { left: 0, top: 0 } : anchorCSS(drag.snap)),
            width: isGhostTop ? '100%' : HANDLE_W,
            height: HANDLE_H,
            zIndex: 9,
            transition: 'left 150ms ease, top 150ms ease, right 150ms ease, bottom 150ms ease, width 150ms ease',
            pointerEvents: 'none',
            ...(invScale && !isGhostTop ? { zoom: invScale } : undefined),
          }}
        />
      )}
      <div
        className={
          'nodrag nopan nowheel chart-floating-palette'
          + (isDragging ? ' dragging' : '')
          + (expanded ? ' expanded' : '')
          + (isTop ? ' pos-top' : '')
          + (isRight ? ' anchor-right' : '')
          + (!isDragging && !isTop && !isRight ? ' anchor-left' : '')
          + (isBottom ? ' anchor-bottom' : '')
        }
        style={{
          ...positionStyle,
          zIndex: drag ? 20 : 10,
          ...(invScale ? { zoom: invScale } : undefined),
        }}
        onMouseEnter={() => {
          if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
          if (!isDragging) setHovered(true);
        }}
        onMouseLeave={() => {
          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = setTimeout(() => { setHovered(false); hoverTimerRef.current = null; }, 320);
        }}
        onPointerDown={block}
        onClick={block}
      >
        <div className="chart-floating-palette__handle" onMouseDown={onMouseDown}>
          <SlidersHorizontal size={14} />
        </div>
        {tray && (
          <div className="chart-floating-palette__tray">
            {tray}
          </div>
        )}
      </div>
    </>
  );
}
