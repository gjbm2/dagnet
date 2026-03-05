import React, { useMemo } from 'react';
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
      label: `${colour === currentColour ? '● ' : ''}${CONTAINER_COLOUR_NAMES[colour] || colour}`,
      onClick: () => onUpdateColour(containerId, colour),
    }));

    const result: ContextMenuItem[] = [
      { label: 'Colour', onClick: () => {}, submenu: colourItems },
    ];

    if (containerCount > 1) {
      result.push(
        { label: '', onClick: () => {}, divider: true },
        { label: 'Bring to Front', onClick: () => onBringToFront(containerId) },
        { label: 'Bring Forward', onClick: () => onBringForward(containerId) },
        { label: 'Send Backward', onClick: () => onSendBackward(containerId) },
        { label: 'Send to Back', onClick: () => onSendToBack(containerId) },
      );
    }

    result.push(
      { label: '', onClick: () => {}, divider: true },
      { label: 'Copy', onClick: () => onCopy(containerId) },
      { label: 'Cut', onClick: () => onCut(containerId) },
      { label: 'Delete', onClick: () => onDelete(containerId) },
    );

    return result;
  }, [containerId, currentColour, containerCount, onUpdateColour, onBringToFront, onBringForward, onSendBackward, onSendToBack, onCopy, onCut, onDelete]);

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
