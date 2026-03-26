import React, { useMemo } from 'react';
import { Palette, Type, ArrowUpToLine, ArrowUp, ArrowDown, ArrowDownToLine, Copy, Scissors, Trash2, Minimize2, Maximize2 } from 'lucide-react';
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
  onCopy: (id: string) => void;
  onCut: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  minimised?: boolean;
  onToggleMinimised?: (id: string) => void;
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

export function PostItContextMenu({ x, y, postitId, currentColour, currentFontSize, postitCount, onUpdateColour, onUpdateFontSize, onBringToFront, onBringForward, onSendBackward, onSendToBack, onCopy, onCut, onDelete, onClose, minimised, onToggleMinimised }: PostItContextMenuProps) {
  const items = useMemo((): ContextMenuItem[] => {
    const colourItems: ContextMenuItem[] = POSTIT_COLOURS.map((colour) => ({
      label: COLOUR_NAMES[colour] || colour,
      checked: colour === currentColour,
      onClick: () => onUpdateColour(postitId, colour),
    }));

    const fontSizeItems: ContextMenuItem[] = Object.entries(FONT_SIZE_LABELS).map(([key, label]) => ({
      label,
      checked: key === currentFontSize,
      onClick: () => onUpdateFontSize(postitId, key),
    }));

    const result: ContextMenuItem[] = [
      { label: 'Colour', icon: <Palette size={14} />, onClick: () => {}, submenu: colourItems },
      { label: 'Font Size', icon: <Type size={14} />, onClick: () => {}, submenu: fontSizeItems },
    ];

    if (postitCount > 1) {
      result.push(
        { label: '', onClick: () => {}, divider: true },
        { label: 'Bring to Front', icon: <ArrowUpToLine size={14} />, onClick: () => onBringToFront(postitId) },
        { label: 'Bring Forward', icon: <ArrowUp size={14} />, onClick: () => onBringForward(postitId) },
        { label: 'Send Backward', icon: <ArrowDown size={14} />, onClick: () => onSendBackward(postitId) },
        { label: 'Send to Back', icon: <ArrowDownToLine size={14} />, onClick: () => onSendToBack(postitId) },
      );
    }

    if (onToggleMinimised) {
      result.push(
        { label: '', onClick: () => {}, divider: true },
        {
          label: minimised ? 'Restore' : 'Minimise',
          icon: minimised ? <Maximize2 size={14} /> : <Minimize2 size={14} />,
          onClick: () => onToggleMinimised(postitId),
        },
      );
    }

    result.push(
      { label: '', onClick: () => {}, divider: true },
      { label: 'Copy', icon: <Copy size={14} />, onClick: () => onCopy(postitId) },
      { label: 'Cut', icon: <Scissors size={14} />, onClick: () => onCut(postitId) },
      { label: 'Delete', icon: <Trash2 size={14} />, onClick: () => onDelete(postitId) },
    );

    return result;
  }, [postitId, currentColour, currentFontSize, postitCount, minimised, onUpdateColour, onUpdateFontSize, onBringToFront, onBringForward, onSendBackward, onSendToBack, onCopy, onCut, onDelete, onToggleMinimised]);

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
