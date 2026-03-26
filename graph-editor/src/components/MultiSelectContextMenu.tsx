/**
 * Multi-Select Context Menu
 *
 * Shown when 2+ canvas objects are selected and the selection includes
 * any canvas objects (post-its, containers, analyses) or is mixed-type.
 *
 * For nodes-only multi-select, NodeContextMenu handles it (with alignment
 * items appended).
 *
 * Provides type-agnostic operations: align, distribute, equal size, delete.
 */

import React from 'react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import {
  AlignStartVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignEndHorizontal,
  AlignCenterVertical,
  AlignCenterHorizontal,
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  RulerDimensionLine,
  LayoutGrid,
  Minimize2,
  Maximize2,
  Trash2,
} from 'lucide-react';
import type { AlignCommand, DistributeCommand, EqualSizeCommand } from '../services/alignmentService';

interface MultiSelectContextMenuProps {
  x: number;
  y: number;
  selectedCount: number;
  onAlign: (command: AlignCommand) => void;
  onDistribute: (command: DistributeCommand) => void;
  onEqualSize: (command: EqualSizeCommand) => void;
  onDeleteSelected: () => void;
  onClose: () => void;
}

export function MultiSelectContextMenu({
  x,
  y,
  selectedCount,
  onAlign,
  onDistribute,
  onEqualSize,
  onDeleteSelected,
  onClose,
}: MultiSelectContextMenuProps) {
  const canAlign = selectedCount >= 2;
  const canDistribute = selectedCount >= 3;

  const items: ContextMenuItem[] = [];

  if (canAlign) {
    items.push({
      label: 'Align',
      onClick: () => {},
      submenu: [
        { label: 'Align Left Edges', onClick: () => onAlign('align-left'), icon: <AlignStartVertical size={14} /> },
        { label: 'Align Right Edges', onClick: () => onAlign('align-right'), icon: <AlignEndVertical size={14} /> },
        { label: 'Align Top Edges', onClick: () => onAlign('align-top'), icon: <AlignStartHorizontal size={14} /> },
        { label: 'Align Bottom Edges', onClick: () => onAlign('align-bottom'), icon: <AlignEndHorizontal size={14} /> },
        { label: '', onClick: () => {}, divider: true },
        { label: 'Align Centre Horizontally', onClick: () => onAlign('align-centre-horizontal'), icon: <AlignCenterVertical size={14} /> },
        { label: 'Align Centre Vertically', onClick: () => onAlign('align-centre-vertical'), icon: <AlignCenterHorizontal size={14} /> },
        ...(canDistribute
          ? [
              { label: '', onClick: () => {}, divider: true } as ContextMenuItem,
              { label: 'Distribute Horizontally', onClick: () => onDistribute('distribute-horizontal'), icon: <AlignHorizontalSpaceAround size={14} /> } as ContextMenuItem,
              { label: 'Distribute Vertically', onClick: () => onDistribute('distribute-vertical'), icon: <AlignVerticalSpaceAround size={14} /> } as ContextMenuItem,
            ]
          : []),
        { label: '', onClick: () => {}, divider: true },
        { label: 'Make Equal Width', onClick: () => onEqualSize('equal-width'), icon: <RulerDimensionLine size={14} /> },
        { label: 'Make Equal Height', onClick: () => onEqualSize('equal-height'), icon: <RulerDimensionLine size={14} style={{ transform: 'rotate(90deg)' }} /> },
      ],
    });

    items.push({ label: '', onClick: () => {}, divider: true });
  }

  if (selectedCount >= 2) {
    items.push({
      label: 'Auto Layout',
      icon: <LayoutGrid size={14} />,
      onClick: () => {},
      submenu: [
        { label: 'Left-to-right', onClick: () => window.dispatchEvent(new CustomEvent('dagnet:autoLayout', { detail: { direction: 'LR' } })) },
        { label: 'Right-to-left', onClick: () => window.dispatchEvent(new CustomEvent('dagnet:autoLayout', { detail: { direction: 'RL' } })) },
        { label: 'Top-to-bottom', onClick: () => window.dispatchEvent(new CustomEvent('dagnet:autoLayout', { detail: { direction: 'TB' } })) },
        { label: 'Bottom-to-top', onClick: () => window.dispatchEvent(new CustomEvent('dagnet:autoLayout', { detail: { direction: 'BT' } })) },
      ],
    });
    items.push({ label: '', onClick: () => {}, divider: true });
  }

  items.push({
    label: 'Minimise Selected',
    icon: <Minimize2 size={14} />,
    onClick: () => window.dispatchEvent(new CustomEvent('dagnet:minimiseSelected')),
  });
  items.push({
    label: 'Restore Selected',
    icon: <Maximize2 size={14} />,
    onClick: () => window.dispatchEvent(new CustomEvent('dagnet:restoreSelected')),
  });

  items.push({ label: '', onClick: () => {}, divider: true });

  items.push({
    label: `Delete ${selectedCount} selected`,
    onClick: onDeleteSelected,
    icon: <Trash2 size={14} />,
  });

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
