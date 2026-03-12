/**
 * CfpPopover — shared hover-reveal popover for toolbar "..." menus and dropdowns.
 *
 * Used by both AnalysisChartContainer (chart toolbar) and ExpressionToolbarTray
 * (cards/table toolbar) so actions appear in ONE consistent pattern everywhere.
 */

import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

export function CfpPopover({ icon, title, label, children, active, activeColour, onClick }: {
  icon: React.ReactNode;
  title: string;
  label?: string;
  children: React.ReactNode;
  active?: boolean;
  activeColour?: string;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setOpen(true);
  }, []);

  const scheduleHide = useCallback(() => {
    hideTimer.current = setTimeout(() => setOpen(false), 200);
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const anchor = wrapRef.current.getBoundingClientRect();
    const GAP = 4;
    const popH = popRef.current?.offsetHeight ?? 180;
    const popW = popRef.current?.offsetWidth ?? 180;
    const flipY = anchor.bottom + GAP + popH > window.innerHeight && anchor.top - GAP - popH > 0;
    const top = flipY ? anchor.top - GAP - popH : anchor.bottom + GAP;
    let left = anchor.right - popW;
    if (left < 4) left = 4;
    if (left + popW > window.innerWidth - 4) left = window.innerWidth - 4 - popW;
    setPos({ position: 'fixed', top, left, right: undefined, bottom: undefined });
  }, [open]);

  const isActive = active || open;

  return (
    <span
      ref={wrapRef}
      className="cfp-popover-anchor"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
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
      {open && createPortal(
        <div
          ref={popRef}
          className="cfp-popover"
          style={pos}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </span>
  );
}
