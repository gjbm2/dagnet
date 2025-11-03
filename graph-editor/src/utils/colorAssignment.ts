/**
 * Color Assignment Service
 * 
 * Provides utilities for auto-assigning distinct colors across:
 * - Case Node Variants
 * - Conditional Probabilities on Edges
 * 
 * Ensures assigned colors are visually distinct from existing colors in the graph.
 */

import { GraphData } from '../types';

/**
 * Predefined color palette with good contrast and accessibility
 * Colors are chosen to be:
 * - Visually distinct from each other
 * - Accessible (good contrast ratios)
 * - Professional looking
 */
export const COLOR_PALETTE = [
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
 * Get all colors currently in use in the graph
 * Extracts colors from:
 * - Node layouts (node.layout.color)
 * - Case node variants (node.case.variants[].color)
 * - Edge conditional probabilities (edge.conditional_p[].color)
 * - Edge display colors (edge.display.conditional_color)
 */
export function getUsedColors(graph: GraphData): string[] {
  const usedColors = new Set<string>();

  // Get colors from node layouts
  graph.nodes.forEach(node => {
    if (node.layout?.color) {
      usedColors.add(node.layout.color.toUpperCase());
    }

    // Get colors from case node variants
    if (node.case?.variants) {
      node.case.variants.forEach((variant: any) => {
        if (variant.color) {
          usedColors.add(variant.color.toUpperCase());
        }
      });
    }
  });

  // Get colors from edges (conditional_color in display)
  graph.edges.forEach(edge => {
    if (edge.display?.conditional_color) {
      usedColors.add(edge.display.conditional_color.toUpperCase());
    }
  });

  return Array.from(usedColors);
}

/**
 * Calculate color distance using simple RGB Euclidean distance
 * Range: 0 (identical) to ~442 (max distance in RGB space)
 */
function colorDistance(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  if (!rgb1 || !rgb2) return 0;

  const rDiff = rgb1.r - rgb2.r;
  const gDiff = rgb1.g - rgb2.g;
  const bDiff = rgb1.b - rgb2.b;

  return Math.sqrt(rDiff * rDiff + gDiff * gDiff + bDiff * bDiff);
}

/**
 * Convert hex color to RGB
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
 * Assign a new distinct color from the palette
 * 
 * Strategy:
 * 1. Try colors from palette in order
 * 2. Skip colors that are too similar to used colors
 * 3. If all palette colors are used, pick the one with maximum minimum distance
 * 
 * @param usedColors Array of hex color strings currently in use
 * @param minDistance Minimum distance threshold (default: 80, which is ~18% of max distance)
 * @returns A hex color string from the palette
 */
export function assignDistinctColor(
  usedColors: string[],
  minDistance: number = 80
): string {
  // Normalize used colors to uppercase
  const normalizedUsed = usedColors.map(c => c.toUpperCase());

  // If no colors are used, return the first from palette
  if (normalizedUsed.length === 0) {
    return COLOR_PALETTE[0];
  }

  // Try each color in palette
  let bestColor = COLOR_PALETTE[0];
  let bestMinDistance = 0;

  for (const paletteColor of COLOR_PALETTE) {
    // Calculate minimum distance to all used colors
    let minDistToUsed = Infinity;

    for (const usedColor of normalizedUsed) {
      const dist = colorDistance(paletteColor, usedColor);
      minDistToUsed = Math.min(minDistToUsed, dist);
    }

    // If this color is far enough from all used colors, return it immediately
    if (minDistToUsed >= minDistance) {
      return paletteColor;
    }

    // Track the color with the best (maximum) minimum distance
    if (minDistToUsed > bestMinDistance) {
      bestMinDistance = minDistToUsed;
      bestColor = paletteColor;
    }
  }

  // Return the color with maximum minimum distance (best we can do)
  return bestColor;
}

/**
 * Get a distinct color for a new element in the graph
 * Convenience function that combines getUsedColors and assignDistinctColor
 * 
 * @param graph The current graph data
 * @param minDistance Optional minimum distance threshold
 * @returns A hex color string that is distinct from existing colors
 */
export function getDistinctColorForGraph(
  graph: GraphData,
  minDistance?: number
): string {
  const usedColors = getUsedColors(graph);
  return assignDistinctColor(usedColors, minDistance);
}

