/**
 * CfpPopover — shared hover-reveal popover for toolbar "..." menus and dropdowns.
 *
 * Used by both AnalysisChartContainer (chart toolbar) and ExpressionToolbarTray
 * (cards/table toolbar) so actions appear in ONE consistent pattern everywhere.
 */

import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

export function CfpPopover({ icon, title, label, children, active, activeColour, onClick, trigger, sticky, popoverClassName }: {
  icon: React.ReactNode;
  title: string;
  label?: string;
  children: React.ReactNode;
  active?: boolean;
  activeColour?: string;
  onClick?: () => void;
  /** Custom trigger element — replaces the default pill button entirely. */
  trigger?: React.ReactNode;
  /** When true, clicking inside the popover pins it open; closes on outside click or Escape. */
  sticky?: boolean;
  /** Extra class(es) appended to the popover container div. */
  popoverClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  /** Delay before popover appears on hover (ms). Prevents accidental reveals
   *  when moving the mouse across the toolbar. */
  const HOVER_DELAY = 380;

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    showTimer.current = setTimeout(() => { showTimer.current = null; setOpen(true); }, HOVER_DELAY);
  }, []);

  const scheduleHide = useCallback(() => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    if (pinned) return;
    hideTimer.current = setTimeout(() => setOpen(false), 200);
  }, [pinned]);

  const close = useCallback(() => {
    setPinned(false);
    setOpen(false);
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (showTimer.current) clearTimeout(showTimer.current);
  }, []);

  // Close on outside click or Escape when pinned
  useEffect(() => {
    if (!pinned) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const handleClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node) &&
          wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => { document.removeEventListener('keydown', handleKey); document.removeEventListener('mousedown', handleClick); };
  }, [pinned, close]);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const anchor = wrapRef.current.getBoundingClientRect();

    // Compute the effective visual scale of the anchor element.
    // The toolbar lives inside the ReactFlow canvas (transform: scale)
    // plus a CSS zoom on the floating palette (invScale from
    // ChartInlineSettingsFloating). The portal at document.body has
    // neither, so we apply both to match pill sizes.
    let cssZoom = 1;
    let canvasScale = 1;
    let el: HTMLElement | null = wrapRef.current;
    while (el && el !== document.body) {
      const inlineZ = el.style.zoom;
      if (inlineZ && inlineZ !== '' && inlineZ !== '1' && inlineZ !== 'normal') {
        cssZoom *= parseFloat(inlineZ);
      }
      if (el.classList?.contains('react-flow__viewport')) {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        if (m.a !== 1) canvasScale = m.a;
      }
      el = el.parentElement;
    }
    const z = canvasScale * cssZoom;
    const applyZoom = z !== 1 && Number.isFinite(z) && z > 0.1;

    // Position in screen coordinates first, then convert to zoomed space.
    const GAP = 4;
    // Estimate visual popover size (layout size × zoom)
    const rawPopH = popRef.current?.offsetHeight ?? 180;
    const rawPopW = popRef.current?.offsetWidth ?? 180;
    const visPopH = applyZoom ? rawPopH * z : rawPopH;
    const visPopW = applyZoom ? rawPopW * z : rawPopW;

    const flipY = anchor.bottom + GAP + visPopH > window.innerHeight && anchor.top - GAP - visPopH > 0;
    const screenTop = flipY ? anchor.top - GAP - visPopH : anchor.bottom + GAP;
    let screenLeft = anchor.right - visPopW;
    if (screenLeft < 4) screenLeft = 4;
    if (screenLeft + visPopW > window.innerWidth - 4) screenLeft = window.innerWidth - 4 - visPopW;

    setPos({
      position: 'fixed',
      top: applyZoom ? screenTop / z : screenTop,
      left: applyZoom ? screenLeft / z : screenLeft,
      right: undefined,
      bottom: undefined,
      ...(applyZoom ? { zoom: z } as any : {}),
    });
  }, [open]);

  const isActive = active || open;
  const popCls = ['cfp-popover', popoverClassName].filter(Boolean).join(' ');

  return (
    <span
      ref={wrapRef}
      className="cfp-popover-anchor"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      {trigger || (
        <button
          type="button"
          className={`cfp-pill${isActive ? ' active' : ''}`}
          style={activeColour ? { color: activeColour } : undefined}
          title={title}
          onClick={onClick}
        >
          {icon}
          {label && <span className="cfp-group-label" style={{ padding: '0 0 0 2px' }}>{label}</span>}
        </button>
      )}
      {open && createPortal(
        <div
          ref={popRef}
          className={popCls}
          style={pos}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => { e.stopPropagation(); if (sticky && !pinned) setPinned(true); }}
        >
          {children}
        </div>,
        document.body,
      )}
    </span>
  );
}
