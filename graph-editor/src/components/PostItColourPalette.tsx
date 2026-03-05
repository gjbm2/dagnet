import React from 'react';
import { POSTIT_COLOURS } from './nodes/PostItNode';

interface PostItColourPaletteProps {
  selectedColour: string;
  onSelectColour: (colour: string) => void;
}

export function PostItColourPalette({ selectedColour, onSelectColour }: PostItColourPaletteProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '4px' }}>
      {POSTIT_COLOURS.map((colour) => (
        <div
          key={colour}
          onClick={() => onSelectColour(colour)}
          style={{
            width: '28px',
            height: '28px',
            backgroundColor: colour,
            border: selectedColour === colour ? '2px solid #333' : '1px solid #ddd',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        />
      ))}
    </div>
  );
}
