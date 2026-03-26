import React from 'react';

interface MinimiseChevronProps {
  minimised: boolean;
  visible: boolean;
  zoom: number;
  onClick: (e: React.MouseEvent) => void;
  /** Offset from node top edge to vertical centre of the title/first-line area (canvas px). */
  titleCentreY?: number;
  /** Keep parent hover state in sync when pointer enters the chevron area. */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Arrow fill colour — caller should pass a dark-mode-aware value. */
  colour?: string;
}

/**
 * Solid filled triangle arrow positioned outside the left edge of a canvas annotation.
 *
 * - ▾ pointing down when normal → click to minimise
 * - ▸ pointing right when minimised → click to restore
 *
 * Fades in/out via CSS transition on opacity (controlled by `visible` prop).
 * Rendered as a sibling of the main node content (not inside it) so it sits
 * outside ReactFlow's d3-drag capture zone.
 */
export function MinimiseChevron({ minimised, visible, zoom, onClick, titleCentreY = 20, onMouseEnter, onMouseLeave, colour = '#666' }: MinimiseChevronProps) {
  const hitSize = 22 / zoom;
  const arrowSize = 10 / zoom;

  return (
    <button
      className="nodrag nopan nowheel"
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClick(e); }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'absolute',
        left: -(hitSize + 4 / zoom),
        top: (titleCentreY - hitSize / 2),
        width: hitSize,
        height: hitSize,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        opacity: visible ? 0.85 : 0,
        transition: 'opacity 180ms ease',
        pointerEvents: 'auto',
        zIndex: 10,
      }}
      title={minimised ? 'Restore' : 'Minimise'}
    >
      {/* Solid SVG triangle — colour passed explicitly by caller */}
      <svg width={arrowSize} height={arrowSize} viewBox="0 0 10 10">
        {minimised
          ? <polygon points="0,0 10,5 0,10" fill={colour} />   /* ▸ right */
          : <polygon points="0,0 10,0 5,10" fill={colour} />   /* ▾ down */
        }
      </svg>
    </button>
  );
}
