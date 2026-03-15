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
  const [pos, setPos] = useState<React.CSSProperties>({});

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setOpen(true);
  }, []);

  const scheduleHide = useCallback(() => {
    if (pinned) return;
    hideTimer.current = setTimeout(() => setOpen(false), 200);
  }, [pinned]);

  const close = useCallback(() => {
    setPinned(false);
    setOpen(false);
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

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
