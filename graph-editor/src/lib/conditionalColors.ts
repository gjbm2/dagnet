// Color palette and utilities for conditional edges
import { Graph, GraphEdge } from '../types';

// Color palette for conditional edges (DARK - 600-700 level for better contrast)
// Avoids blue (#007bff - reserved for selections) and purple (#C4B5FD, #8b5cf6 - reserved for cases)
// Using darker colors to ensure contrast with pastel scenario text colors
export const CONDITIONAL_COLOR_PALETTE = [
  '#16a34a', // green-600 (was green-400)
  '#dc2626', // red-600 (was red-400)
  '#d97706', // amber-600 (was amber-400)
  '#059669', // emerald-600 (was emerald-400)
  '#ea580c', // orange-600 (was orange-400)
  '#0284c7', // sky-600 (was sky-400)
  '#db2777', // pink-600 (was pink-400)
  '#9333ea', // violet-600 (was violet-400)
  '#ca8a04', // yellow-600 (was yellow-400)
  '#0d9488', // teal-600 (was teal-400)
  '#e11d48', // rose-600 (was rose-400)
  '#4f46e5', // indigo-600 (was indigo-400)
];

/**
 * Simple hash function for strings
 * Used to deterministically assign colors based on condition signature
 */
export function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Get the condition signature for an edge
 * This creates a deterministic string representation of all conditions
 */
export function getConditionSignature(edge: GraphEdge): string {
  if (!edge.conditional_p || edge.conditional_p.length === 0) {
    return '';
  }
  
  // Sort conditions to ensure same signature for same set of conditions
  // Use condition strings directly (already normalized)
  const signatures = edge.conditional_p
    .map(cp => {
      if (typeof cp.condition === 'string') {
        return cp.condition;
      }
      // Skip old format
      console.warn('Old format condition detected in getConditionSignature');
      return '';
    })
    .filter(s => s !== '')
    .sort()
    .join('||');
  
  return signatures;
}

/**
 * Get the color for a conditional edge
 * Priority:
 * 1. First condition with a user-set color (condition.color)
 * 2. Generated from condition signature
 * 
 * Note: Colors are now stored per-condition, not per-edge.
 * If multiple conditions have colors, we use the first one.
 */
export function getConditionalColor(edge: GraphEdge): string | null {
  // Check if edge has conditional probabilities
  if (!edge.conditional_p || edge.conditional_p.length === 0) {
    return null;
  }
  
  // Priority 1: Check for user-set color on any condition
  // Use the first condition that has a color set
  for (const cp of edge.conditional_p) {
    if (cp.color) {
      return cp.color;
    }
  }
  
  // Priority 2: Generate from condition signature (fallback)
  const signature = getConditionSignature(edge);
  if (!signature) {
    return null;
  }
  
  const hash = simpleHash(signature);
  const paletteIndex = hash % CONDITIONAL_COLOR_PALETTE.length;
  
  return CONDITIONAL_COLOR_PALETTE[paletteIndex];
}

/**
 * Get the color for a specific conditional probability entry
 * Priority:
 * 1. User-set color on this specific condition (cp.color)
 * 2. Generated color based on this condition's signature
 * 
 * This ensures each condition gets its own color, not shared across conditions.
 */
export function getConditionalProbabilityColor(cp: { condition: string; color?: string }): string {
  // Priority 1: Use user-set color if present
  if (cp.color) {
    return cp.color;
  }
  
  // Priority 2: Generate color from this specific condition's signature
  const conditionStr = typeof cp.condition === 'string' ? cp.condition : '';
  if (conditionStr) {
    const hash = simpleHash(conditionStr);
    const paletteIndex = hash % CONDITIONAL_COLOR_PALETTE.length;
    return CONDITIONAL_COLOR_PALETTE[paletteIndex];
  }
  
  // Fallback: default green
  return '#4ade80';
}

/**
 * Check if an edge is a conditional edge (has conditional probabilities)
 */
export function isConditionalEdge(edge: GraphEdge): boolean {
  return !!(edge.conditional_p && edge.conditional_p.length > 0);
}

/**
 * Get a lighter shade of a color (for hover/selection states)
 */
export function lightenColor(color: string, amount: number = 0.2): string {
  // Parse hex color
  const hex = color.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  
  // Lighten
  const newR = Math.min(255, Math.round(r + (255 - r) * amount));
  const newG = Math.min(255, Math.round(g + (255 - g) * amount));
  const newB = Math.min(255, Math.round(b + (255 - b) * amount));
  
  // Convert back to hex
  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
}

/**
 * Get a darker shade of a color
 */
export function darkenColor(color: string, amount: number = 0.2): string {
  // Parse hex color
  const hex = color.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  
  // Darken
  const newR = Math.max(0, Math.round(r * (1 - amount)));
  const newG = Math.max(0, Math.round(g * (1 - amount)));
  const newB = Math.max(0, Math.round(b * (1 - amount)));
  
  // Convert back to hex
  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
}

/**
 * Darken a case variant color for bead background
 * Reduces lightness by ~50% to ensure contrast with pastel scenario text colors
 */
export function darkenCaseColor(color: string): string {
  // Convert hex to HSL
  const hex = color.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16) / 255;
  const g = parseInt(hex.substr(2, 2), 16) / 255;
  const b = parseInt(hex.substr(4, 2), 16) / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  
  // Reduce lightness by 50% (minimum 15% for better contrast)
  l = Math.max(0.15, l * 0.5);
  
  // Convert HSL back to RGB
  let newR, newG, newB;
  if (s === 0) {
    newR = newG = newB = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    newR = hue2rgb(p, q, h + 1/3);
    newG = hue2rgb(p, q, h);
    newB = hue2rgb(p, q, h - 1/3);
  }
  
  return `#${Math.round(newR * 255).toString(16).padStart(2, '0')}${Math.round(newG * 255).toString(16).padStart(2, '0')}${Math.round(newB * 255).toString(16).padStart(2, '0')}`;
}

/**
 * Ensure a color is dark enough for bead background (for conditional_p user-set colors)
 * If lightness > 20%, darken to 20% for better contrast with pastel scenario text
 */
export function ensureDarkBeadColor(color: string): string {
  // Convert hex to HSL
  const hex = color.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16) / 255;
  const g = parseInt(hex.substr(2, 2), 16) / 255;
  const b = parseInt(hex.substr(4, 2), 16) / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  
  // If lightness > 20%, darken to 20% for better contrast
  if (l > 0.2) {
    l = 0.2;
  }
  
  // Convert HSL back to RGB
  let newR, newG, newB;
  if (s === 0) {
    newR = newG = newB = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    newR = hue2rgb(p, q, h + 1/3);
    newG = hue2rgb(p, q, h);
    newB = hue2rgb(p, q, h - 1/3);
  }
  
  return `#${Math.round(newR * 255).toString(16).padStart(2, '0')}${Math.round(newG * 255).toString(16).padStart(2, '0')}${Math.round(newB * 255).toString(16).padStart(2, '0')}`;
}

/**
 * Get all colors currently used in the graph (case nodes + conditional edges)
 */
export function getUsedColors(graph: Graph | null): Set<string> {
  const used = new Set<string>();
  
  if (!graph) return used;
  
  // Get colors from case nodes
  for (const node of graph.nodes) {
    if (node.type === 'case' && node.layout?.color) {
      used.add(node.layout.color.toLowerCase());
    }
  }
  
  // Get colors from conditional edges
  for (const edge of graph.edges) {
    if (edge.display?.conditional_color) {
      used.add(edge.display.conditional_color.toLowerCase());
    }
  }
  
  return used;
}

/**
 * Get the next available color from the palette that isn't already used
 */
export function getNextAvailableColor(graph: Graph | null): string {
  const used = getUsedColors(graph);
  
  // Find first unused color
  for (const color of CONDITIONAL_COLOR_PALETTE) {
    if (!used.has(color.toLowerCase())) {
      return color;
    }
  }
  
  // If all colors are used, cycle back to the beginning
  return CONDITIONAL_COLOR_PALETTE[0];
}

/**
 * Get all sibling edges (edges from the same source node)
 */
export function getSiblingEdges(edge: GraphEdge, graph: Graph | null): GraphEdge[] {
  if (!graph) return [];
  
  return graph.edges.filter(e => e.from === edge.from);
}

/**
 * Get the shared condition signature for a set of edges
 * Returns the condition signature if edges share conditional logic, empty string otherwise
 */
export function getSharedConditionSignature(edges: GraphEdge[]): string {
  if (edges.length === 0) return '';
  
  // Get signatures for all edges that have conditions
  const signatures = edges
    .filter(e => e.conditional_p && e.conditional_p.length > 0)
    .map(e => getConditionSignature(e))
    .filter(s => s !== '');
  
  if (signatures.length === 0) return '';
  
  // For now, just return the first signature
  // In the future, we might want to check if siblings have matching conditions
  return signatures[0];
}

/**
 * Assign a color to an edge and its siblings with the same conditional logic
 * Returns the assigned color
 */
export function assignColorToConditionalEdge(
  edge: GraphEdge,
  graph: Graph | null,
  customColor?: string
): string {
  // Use custom color if provided, otherwise get next available
  const color = customColor || getNextAvailableColor(graph);
  
  // Update the edge's color
  if (!edge.display) {
    edge.display = {};
  }
  edge.display.conditional_color = color;
  
  return color;
}
