import React from 'react';
import { POSTIT_COLOURS, POSTIT_COLOURS_DARK } from './nodes/PostItNode';
import { useTheme } from '../contexts/ThemeContext';

interface PostItColourPaletteProps {
  selectedColour: string;
  onSelectColour: (colour: string) => void;
}

export function PostItColourPalette({ selectedColour, onSelectColour }: PostItColourPaletteProps) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '4px' }}>
      {POSTIT_COLOURS.map((colour) => (
        <div
          key={colour}
          onClick={() => onSelectColour(colour)}
          style={{
            width: '28px',
            height: '28px',
            backgroundColor: dark ? (POSTIT_COLOURS_DARK[colour] || colour) : colour,
            border: selectedColour === colour
              ? `2px solid ${dark ? '#e0e0e0' : '#333'}`
              : `1px solid ${dark ? '#555' : '#ddd'}`,
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        />
      ))}
    </div>
  );
}
