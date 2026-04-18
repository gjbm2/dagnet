import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

type Position = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  delay?: number;
  position?: Position;
  maxWidth?: number;
  className?: string;
  /**
   * Wrapper layout mode.
   *   "inline-block" (default) — preserves existing behaviour; safe inside flow and inline-flex parents.
   *   "contents"              — wrapper is layout-transparent. Use when the trigger is a flex/grid child
   *                              and the extra wrapper would disrupt layout. Known quirk: some older
   *                              browsers drop pointer events on `display: contents`, so only use when
   *                              the child itself handles pointer events correctly.
   */
  wrapper?: 'inline-block' | 'contents';
  /**
   * If the tooltip content is empty/null/undefined, render children without any wrapper or listeners.
   * Defaults to true — avoids attaching mouse handlers when there is nothing to show.
   */
  disableWhenEmpty?: boolean;
  /**
   * Render a visual cue on the trigger (dotted underline + help cursor) so the user
   * knows hover-help is available. Defaults to false for raw Tooltip; GlossaryTooltip
   * opts in to true.
   */
  hint?: boolean;
}

const OFFSET = 8;

export default function Tooltip({
  content,
  children,
  delay = 500,
  position = 'top',
  maxWidth = 300,
  className = '',
  wrapper = 'inline-block',
  disableWhenEmpty = true,
  hint = false,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [resolvedPosition, setResolvedPosition] = useState<Position>(position);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  const isEmpty = content == null || content === false || content === '';
  const suppress = disableWhenEmpty && isEmpty;

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  const showTooltip = useCallback(() => {
    if (suppress) return;
    if (document.querySelector('.modal-overlay')) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (document.querySelector('.modal-overlay')) return;
      setIsVisible(true);
    }, delay);
  }, [delay, suppress]);

  useEffect(() => {
    if (!isVisible) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element && node.classList.contains('modal-overlay')) {
            hideTooltip();
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isVisible, hideTooltip]);

  useEffect(() => {
    if (!isVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideTooltip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVisible, hideTooltip]);

  const computePlacement = useCallback(() => {
    if (!triggerRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tipW = tooltipRect?.width ?? 0;
    const tipH = tooltipRect?.height ?? 0;

    let effective: Position = position;
    if (tooltipRect) {
      if (position === 'top' && triggerRect.top - tipH - OFFSET < 0) effective = 'bottom';
      else if (position === 'bottom' && triggerRect.bottom + tipH + OFFSET > vh) effective = 'top';
      else if (position === 'left' && triggerRect.left - tipW - OFFSET < 0) effective = 'right';
      else if (position === 'right' && triggerRect.right + tipW + OFFSET > vw) effective = 'left';
    }

    let x = 0;
    let y = 0;
    switch (effective) {
      case 'top':
        x = triggerRect.left + triggerRect.width / 2;
        y = triggerRect.top;
        break;
      case 'bottom':
        x = triggerRect.left + triggerRect.width / 2;
        y = triggerRect.bottom;
        break;
      case 'left':
        x = triggerRect.left;
        y = triggerRect.top + triggerRect.height / 2;
        break;
      case 'right':
        x = triggerRect.right;
        y = triggerRect.top + triggerRect.height / 2;
        break;
    }

    setResolvedPosition(effective);
    setCoords({ x, y });
  }, [position]);

  useEffect(() => {
    if (!isVisible) return;
    computePlacement();
    const raf = requestAnimationFrame(computePlacement);
    return () => cancelAnimationFrame(raf);
  }, [isVisible, computePlacement]);

  useEffect(() => {
    if (!isVisible) return;
    const onScrollOrResize = () => computePlacement();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [isVisible, computePlacement]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const getTooltipStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      left: `${coords.x}px`,
      top: `${coords.y}px`,
      maxWidth: `${maxWidth}px`,
    };
    switch (resolvedPosition) {
      case 'top':
        return { ...base, transform: `translate(-50%, calc(-100% - ${OFFSET}px))` };
      case 'bottom':
        return { ...base, transform: `translate(-50%, ${OFFSET}px)` };
      case 'left':
        return { ...base, transform: `translate(calc(-100% - ${OFFSET}px), -50%)` };
      case 'right':
        return { ...base, transform: `translate(${OFFSET}px, -50%)` };
    }
  };

  const tooltipNode = isVisible ? (
    <div
      ref={tooltipRef}
      id={tooltipId}
      role="tooltip"
      className="dagnet-tooltip"
      style={getTooltipStyle()}
    >
      <div className={`dagnet-tooltip-body ${className}`.trim()}>{content}</div>
    </div>
  ) : null;

  if (suppress) {
    return <>{children}</>;
  }

  const triggerClass = [
    'dagnet-tooltip-trigger',
    wrapper === 'contents' ? 'dagnet-tooltip-trigger--contents' : '',
    hint ? 'dagnet-tooltip-trigger--hinted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <span
        ref={triggerRef}
        className={triggerClass}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        aria-describedby={isVisible ? tooltipId : undefined}
      >
        {children}
      </span>
      {tooltipNode && ReactDOM.createPortal(tooltipNode, document.body)}
    </>
  );
}
