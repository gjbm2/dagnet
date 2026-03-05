import React, { useMemo } from 'react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { POSTIT_COLOURS } from './nodes/PostItNode';

interface PostItContextMenuProps {
  x: number;
  y: number;
  postitId: string;
  currentColour: string;
  currentFontSize: string;
  postitCount: number;
  onUpdateColour: (id: string, colour: string) => void;
  onUpdateFontSize: (id: string, fontSize: string) => void;
  onBringToFront: (id: string) => void;
  onBringForward: (id: string) => void;
  onSendBackward: (id: string) => void;
  onSendToBack: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const COLOUR_NAMES: Record<string, string> = {
  '#FFF475': 'Canary Yellow',
  '#F4BFDB': 'Power Pink',
  '#B6E3E9': 'Aqua Splash',
  '#CEED9D': 'Limeade',
  '#FFD59D': 'Neon Orange',
  '#D3BFEE': 'Iris',
};

const FONT_SIZE_LABELS: Record<string, string> = {
  S: 'Small',
  M: 'Medium',
  L: 'Large',
  XL: 'Extra Large',
};

export function PostItContextMenu({ x, y, postitId, currentColour, currentFontSize, postitCount, onUpdateColour, onUpdateFontSize, onBringToFront, onBringForward, onSendBackward, onSendToBack, onDelete, onClose }: PostItContextMenuProps) {
  const items = useMemo((): ContextMenuItem[] => {
    const colourItems: ContextMenuItem[] = POSTIT_COLOURS.map((colour) => ({
      label: `${colour === currentColour ? '● ' : ''}${COLOUR_NAMES[colour] || colour}`,
      onClick: () => onUpdateColour(postitId, colour),
    }));

    const fontSizeItems: ContextMenuItem[] = Object.entries(FONT_SIZE_LABELS).map(([key, label]) => ({
      label: `${key === currentFontSize ? '● ' : ''}${label}`,
      onClick: () => onUpdateFontSize(postitId, key),
    }));

    const result: ContextMenuItem[] = [
      { label: 'Colour', onClick: () => {}, submenu: colourItems },
      { label: 'Font Size', onClick: () => {}, submenu: fontSizeItems },
    ];

    if (postitCount > 1) {
      result.push(
        { label: '', onClick: () => {}, divider: true },
        { label: 'Bring to Front', onClick: () => onBringToFront(postitId) },
        { label: 'Bring Forward', onClick: () => onBringForward(postitId) },
        { label: 'Send Backward', onClick: () => onSendBackward(postitId) },
        { label: 'Send to Back', onClick: () => onSendToBack(postitId) },
      );
    }

    result.push(
      { label: '', onClick: () => {}, divider: true },
      { label: 'Delete', onClick: () => onDelete(postitId) },
    );

    return result;
  }, [postitId, currentColour, currentFontSize, postitCount, onUpdateColour, onUpdateFontSize, onBringToFront, onBringForward, onSendBackward, onSendToBack, onDelete]);

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
