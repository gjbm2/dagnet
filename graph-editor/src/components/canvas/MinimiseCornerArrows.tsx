import React, { useState } from 'react';
import { ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight } from 'lucide-react';

export type AnchorCorner = 'tl' | 'tr' | 'bl' | 'br';

/** CSS transform-origin value for each corner. */
export const CORNER_ORIGINS: Record<AnchorCorner, string> = {
  tl: 'top left',
  tr: 'top right',
  bl: 'bottom left',
  br: 'bottom right',
};

interface MinimiseCornerArrowsProps {
  /** When falsy the node is normal-sized and all four inward arrows show on hover.
   *  When set, the node is minimised and only the restore arrow at the anchor shows. */
  minimisedAnchor?: AnchorCorner | null;
  visible: boolean;
  zoom: number;
  /** Node dimensions in canvas px (used for positioning corners). */
  nodeWidth: number;
  nodeHeight: number;
  colour?: string;
  onMinimise: (anchor: AnchorCorner) => void;
  onRestore: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Fires when pointer enters/leaves a specific corner arrow (null = left all). */
  onCornerHover?: (corner: AnchorCorner | null) => void;
  /** When true, arrows are hidden AND non-interactive (selected/dragging). */
  disabled?: boolean;
}

// Minimise icons: point TOWARD the anchor corner (collapse to here).
const MINIMISE_ICONS: Record<AnchorCorner, typeof ArrowDownLeft> = {
  tl: ArrowUpLeft,
  tr: ArrowUpRight,
  bl: ArrowDownLeft,
  br: ArrowDownRight,
};

// Restore icons: point AWAY from the anchor corner (expand from here).
const RESTORE_ICONS: Record<AnchorCorner, typeof ArrowDownLeft> = {
  tl: ArrowDownRight,
  tr: ArrowDownLeft,
  bl: ArrowUpRight,
  br: ArrowUpLeft,
};

/**
 * Four hover arrows at each corner of a canvas annotation.
 *
 * Normal state: all four show on hover, each pointing toward its corner. Click → minimise anchoring from that corner.
 * Minimised state: one arrow at the anchor corner pointing outward. Click → restore.
 */
export function MinimiseCornerArrows({
  minimisedAnchor, visible, zoom, nodeWidth, nodeHeight, colour = '#666',
  onMinimise, onRestore, onMouseEnter, onMouseLeave, onCornerHover, disabled,
}: MinimiseCornerArrowsProps) {
  if (disabled) return null;
  const btnSize = 20 / zoom;
  const iconSize = 15 / zoom;
  const gap = 1 / zoom;
  const isMinimised = !!minimisedAnchor;
  const [hoveredCorner, setHoveredCorner] = useState<AnchorCorner | null>(null);

  const cornerPositions: Record<AnchorCorner, { left: number; top: number }> = {
    tl: { left: -btnSize - gap, top: -btnSize - gap },
    tr: { left: nodeWidth + gap, top: -btnSize - gap },
    bl: { left: -btnSize - gap, top: nodeHeight + gap },
    br: { left: nodeWidth + gap, top: nodeHeight + gap },
  };

  const corners: AnchorCorner[] = isMinimised ? [minimisedAnchor!] : ['tl', 'tr', 'bl', 'br'];

  return (
    <>
      {corners.map(corner => {
        const pos = cornerPositions[corner];
        const Icon = isMinimised ? RESTORE_ICONS[corner] : MINIMISE_ICONS[corner];
        return (
          <button
            key={corner}
            className={`nodrag nopan nowheel corner-arrow-btn corner-${corner}${isMinimised ? ' corner-restore' : ''}`}
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (isMinimised) onRestore();
              else onMinimise(corner);
            }}
            onMouseEnter={() => { setHoveredCorner(corner); onCornerHover?.(corner); onMouseEnter?.(); }}
            onMouseLeave={() => { setHoveredCorner(null); onCornerHover?.(null); onMouseLeave?.(); }}
            style={{
              position: 'absolute',
              left: pos.left,
              top: pos.top,
              width: btnSize,
              height: btnSize,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              opacity: !visible ? 0
                : hoveredCorner === corner ? 0.85
                : hoveredCorner != null ? 0.15
                : 0.45,
              transition: 'opacity 450ms ease',
              pointerEvents: visible ? 'auto' : 'none',
              zIndex: 10,
            }}
            title={isMinimised ? 'Restore' : 'Minimise'}
          >
            <Icon size={iconSize} strokeWidth={2} color={colour} />
          </button>
        );
      })}
    </>
  );
}
