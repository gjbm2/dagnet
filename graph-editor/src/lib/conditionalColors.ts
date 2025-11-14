// Color palette and utilities for conditional edges
import { Graph, GraphEdge } from '../types';

// Color palette for conditional edges
// Avoids blue (#007bff - reserved for selections) and purple (#C4B5FD, #8b5cf6 - reserved for cases)
export const CONDITIONAL_COLOR_PALETTE = [
  '#4ade80', // green-400
  '#f87171', // red-400
  '#fbbf24', // amber-400
  '#34d399', // emerald-400
  '#fb923c', // orange-400
  '#60a5fa', // sky-400 (different from selection blue)
  '#f472b6', // pink-400
  '#a78bfa', // violet-400 (different from case purple)
  '#facc15', // yellow-400
  '#2dd4bf', // teal-400
  '#fb7185', // rose-400
  '#818cf8', // indigo-400
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
