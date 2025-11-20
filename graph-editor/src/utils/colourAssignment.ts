/**
 * Colour Assignment Service
 * 
 * Provides utilities for auto-assigning distinct colours across:
 * - Case Node Variants
 * - Conditional Probabilities on Edges
 * 
 * Ensures assigned colours are visually distinct from existing colours in the graph.
 */

import { GraphData } from '../types';

/**
 * Predefined colour palette with good contrast and accessibility
 * Colours are chosen to be:
 * - Visually distinct from each other
 * - Accessible (good contrast ratios)
 * - Professional looking
 */
export const COLOUR_PALETTE = [
  '#3B82F6', // Blue
  '#10B981', // Green
  '#F59E0B', // Amber
  '#EF4444', // Red
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#14B8A6', // Teal
  '#F97316', // Orange
  '#6366F1', // Indigo
  '#84CC16', // Lime
  '#F43F5E', // Rose
  '#06B6D4', // Cyan
  '#A855F7', // Violet
  '#EAB308', // Yellow
  '#22C55E', // Emerald
  '#DC2626', // Dark Red
  '#7C3AED', // Deep Purple
  '#0EA5E9', // Sky Blue
  '#65A30D', // Olive
  '#DB2777', // Fuchsia
];

/**
 * Get all colours currently in use in the graph
 * Extracts colours from:
 * - Node layouts (node.layout.colour)
 * - Case node variants (node.case.variants[].colour)
 * - Edge conditional probabilities (edge.conditional_p[].colour)
 * - Edge display colours (edge.display.conditional_colour)
 */
export function getUsedColours(graph: GraphData): string[] {
  const usedColours = new Set<string>();

  // Get colours from node layouts
  graph.nodes.forEach(node => {
    if (node.layout?.colour) {
      usedColours.add(node.layout.colour.toUpperCase());
    }

    // Get colours from case node variants
    if (node.case?.variants) {
      node.case.variants.forEach((variant: any) => {
        if (variant.colour) {
          usedColours.add(variant.colour.toUpperCase());
        }
      });
    }
  });

  // Get colours from edges (conditional_colour in display)
  graph.edges.forEach(edge => {
    if (edge.display?.conditional_colour) {
      usedColours.add(edge.display.conditional_colour.toUpperCase());
    }
  });

  return Array.from(usedColours);
}

/**
 * Calculate colour distance using simple RGB Euclidean distance
 * Range: 0 (identical) to ~442 (max distance in RGB space)
 */
function colourDistance(colour1: string, colour2: string): number {
  const rgb1 = hexToRgb(colour1);
  const rgb2 = hexToRgb(colour2);

  if (!rgb1 || !rgb2) return 0;

  const rDiff = rgb1.r - rgb2.r;
  const gDiff = rgb1.g - rgb2.g;
  const bDiff = rgb1.b - rgb2.b;

  return Math.sqrt(rDiff * rDiff + gDiff * gDiff + bDiff * bDiff);
}

/**
 * Convert hex colour to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  // Remove # if present
  hex = hex.replace(/^#/, '');

  // Handle 3-digit hex
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }

  if (hex.length !== 6) return null;

  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  return { r, g, b };
}

/**
 * Assign a new distinct colour from the palette
 * 
 * Strategy:
 * 1. Try colours from palette in order
 * 2. Skip colours that are too similar to used colours
 * 3. If all palette colours are used, pick the one with maximum minimum distance
 * 
 * @param usedColours Array of hex colour strings currently in use
 * @param minDistance Minimum distance threshold (default: 80, which is ~18% of max distance)
 * @returns A hex colour string from the palette
 */
export function assignDistinctColour(
  usedColours: string[],
  minDistance: number = 80
): string {
  // Normalize used colours to uppercase
  const normalizedUsed = usedColours.map(c => c.toUpperCase());

  // If no colours are used, return the first from palette
  if (normalizedUsed.length === 0) {
    return COLOUR_PALETTE[0];
  }

  // Try each colour in palette
  let bestColour = COLOUR_PALETTE[0];
  let bestMinDistance = 0;

  for (const paletteColour of COLOUR_PALETTE) {
    // Calculate minimum distance to all used colours
    let minDistToUsed = Infinity;

    for (const usedColour of normalizedUsed) {
      const dist = colourDistance(paletteColour, usedColour);
      minDistToUsed = Math.min(minDistToUsed, dist);
    }

    // If this colour is far enough from all used colours, return it immediately
    if (minDistToUsed >= minDistance) {
      return paletteColour;
    }

    // Track the colour with the best (maximum) minimum distance
    if (minDistToUsed > bestMinDistance) {
      bestMinDistance = minDistToUsed;
      bestColour = paletteColour;
    }
  }

  // Return the colour with maximum minimum distance (best we can do)
  return bestColour;
}

/**
 * Get a distinct colour for a new element in the graph
 * Convenience function that combines getUsedColours and assignDistinctColour
 * 
 * @param graph The current graph data
 * @param minDistance Optional minimum distance threshold
 * @returns A hex colour string that is distinct from existing colours
 */
export function getDistinctColourForGraph(
  graph: GraphData,
  minDistance?: number
): string {
  const usedColours = getUsedColours(graph);
  return assignDistinctColour(usedColours, minDistance);
}

