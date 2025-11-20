// Colour palette and utilities for conditional edges
import { Graph, GraphEdge } from '../types';

// Colour palette for conditional edges (DARK - 600-700 level for better contrast)
// Avoids blue (#007bff - reserved for selections) and purple (#C4B5FD, #8b5cf6 - reserved for cases)
// Using darker colours to ensure contrast with pastel scenario text colours
export const CONDITIONAL_COLOUR_PALETTE = [
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
 * Used to deterministically assign colours based on condition signature
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
 * Get the colour for a conditional edge
 * Priority:
 * 1. First condition with a user-set colour (condition.colour)
 * 2. Generated from condition signature
 * 
 * Note: Colours are now stored per-condition, not per-edge.
 * If multiple conditions have colours, we use the first one.
 */
export function getConditionalColour(edge: GraphEdge): string | null {
  // Check if edge has conditional probabilities
  if (!edge.conditional_p || edge.conditional_p.length === 0) {
    return null;
  }
  
  // Priority 1: Check for user-set colour on any condition
  // Use the first condition that has a colour set
  for (const cp of edge.conditional_p) {
    if (cp.colour) {
      return cp.colour;
    }
  }
  
  // Priority 2: Generate from condition signature (fallback)
  const signature = getConditionSignature(edge);
  if (!signature) {
    return null;
  }
  
  const hash = simpleHash(signature);
  const paletteIndex = hash % CONDITIONAL_COLOUR_PALETTE.length;
  
  return CONDITIONAL_COLOUR_PALETTE[paletteIndex];
}

/**
 * Get the colour for a specific conditional probability entry
 * Priority:
 * 1. User-set colour on this specific condition (cp.colour)
 * 2. Generated colour based on this condition's signature
 * 
 * This ensures each condition gets its own colour, not shared across conditions.
 */
export function getConditionalProbabilityColour(cp: { condition: string; colour?: string }): string {
  // Priority 1: Use user-set colour if present
  if (cp.colour) {
    return cp.colour;
  }
  
  // Priority 2: Generate colour from this specific condition's signature
  const conditionStr = typeof cp.condition === 'string' ? cp.condition : '';
  if (conditionStr) {
    const hash = simpleHash(conditionStr);
    const paletteIndex = hash % CONDITIONAL_COLOUR_PALETTE.length;
    return CONDITIONAL_COLOUR_PALETTE[paletteIndex];
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
 * Get a lighter shade of a colour (for hover/selection states)
 */
export function lightenColour(colour: string, amount: number = 0.2): string {
  // Parse hex colour
  const hex = colour.replace('#', '');
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
 * Get a darker shade of a colour
 */
export function darkenColour(colour: string, amount: number = 0.2): string {
  // Parse hex colour
  const hex = colour.replace('#', '');
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
 * Darken a case variant colour for bead background
 * Reduces lightness by ~50% to ensure contrast with pastel scenario text colours
 */
export function darkenCaseColour(colour: string): string {
  // Convert hex to HSL
  const hex = colour.replace('#', '');
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
 * Ensure a colour is dark enough for bead background (for conditional_p user-set colours)
 * If lightness > 20%, darken to 20% for better contrast with pastel scenario text
 */
export function ensureDarkBeadColour(colour: string): string {
  // Convert hex to HSL
  const hex = colour.replace('#', '');
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
 * Get all colours currently used in the graph (case nodes + conditional edges)
 */
export function getUsedColours(graph: Graph | null): Set<string> {
  const used = new Set<string>();
  
  if (!graph) return used;
  
  // Get colours from case nodes
  for (const node of graph.nodes) {
    if (node.type === 'case' && node.layout?.colour) {
      used.add(node.layout.colour.toLowerCase());
    }
  }
  
  // Get colours from conditional edges
  for (const edge of graph.edges) {
    if (edge.display?.conditional_colour) {
      used.add(edge.display.conditional_colour.toLowerCase());
    }
  }
  
  return used;
}

/**
 * Get the next available colour from the palette that isn't already used
 */
export function getNextAvailableColour(graph: Graph | null): string {
  const used = getUsedColours(graph);
  
  // Find first unused colour
  for (const colour of CONDITIONAL_COLOUR_PALETTE) {
    if (!used.has(colour.toLowerCase())) {
      return colour;
    }
  }
  
  // If all colours are used, cycle back to the beginning
  return CONDITIONAL_COLOUR_PALETTE[0];
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
 * Assign a colour to an edge and its siblings with the same conditional logic
 * Returns the assigned colour
 */
export function assignColourToConditionalEdge(
  edge: GraphEdge,
  graph: Graph | null,
  customColour?: string
): string {
  // Use custom colour if provided, otherwise get next available
  const colour = customColour || getNextAvailableColour(graph);
  
  // Update the edge's colour
  if (!edge.display) {
    edge.display = {};
  }
  edge.display.conditional_colour = colour;
  
  return colour;
}
