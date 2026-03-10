import React, { useMemo } from 'react';
import { Palette, ArrowUpToLine, ArrowUp, ArrowDown, ArrowDownToLine, Copy, Scissors, Trash2 } from 'lucide-react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { CONTAINER_COLOURS, CONTAINER_COLOUR_NAMES } from './nodes/ContainerNode';

interface ContainerContextMenuProps {
  x: number;
  y: number;
  containerId: string;
  currentColour: string;
  containerCount: number;
  onUpdateColour: (id: string, colour: string) => void;
  onBringToFront: (id: string) => void;
  onBringForward: (id: string) => void;
  onSendBackward: (id: string) => void;
  onSendToBack: (id: string) => void;
  onCopy: (id: string) => void;
  onCut: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function ContainerContextMenu({ x, y, containerId, currentColour, containerCount, onUpdateColour, onBringToFront, onBringForward, onSendBackward, onSendToBack, onCopy, onCut, onDelete, onClose }: ContainerContextMenuProps) {
  const items = useMemo((): ContextMenuItem[] => {
    const colourItems: ContextMenuItem[] = CONTAINER_COLOURS.map((colour) => ({
      label: CONTAINER_COLOUR_NAMES[colour] || colour,
      checked: colour === currentColour,
      onClick: () => onUpdateColour(containerId, colour),
    }));

    const result: ContextMenuItem[] = [
      { label: 'Colour', icon: <Palette size={14} />, onClick: () => {}, submenu: colourItems },
    ];

    if (containerCount > 1) {
      result.push(
        { label: '', onClick: () => {}, divider: true },
        { label: 'Bring to Front', icon: <ArrowUpToLine size={14} />, onClick: () => onBringToFront(containerId) },
        { label: 'Bring Forward', icon: <ArrowUp size={14} />, onClick: () => onBringForward(containerId) },
        { label: 'Send Backward', icon: <ArrowDown size={14} />, onClick: () => onSendBackward(containerId) },
        { label: 'Send to Back', icon: <ArrowDownToLine size={14} />, onClick: () => onSendToBack(containerId) },
      );
    }

    result.push(
      { label: '', onClick: () => {}, divider: true },
      { label: 'Copy', icon: <Copy size={14} />, onClick: () => onCopy(containerId) },
      { label: 'Cut', icon: <Scissors size={14} />, onClick: () => onCut(containerId) },
      { label: 'Delete', icon: <Trash2 size={14} />, onClick: () => onDelete(containerId) },
    );

    return result;
  }, [containerId, currentColour, containerCount, onUpdateColour, onBringToFront, onBringForward, onSendBackward, onSendToBack, onCopy, onCut, onDelete]);

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
