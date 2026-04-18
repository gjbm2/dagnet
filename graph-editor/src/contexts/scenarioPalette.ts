/**
 * Scenario colour palettes and palette helpers.
 *
 * Extracted from ScenariosContext so the context file can export only
 * React components (required for Vite Fast Refresh).
 */

export type ScenarioColourPalette = 'standard' | 'rainbow' | 'green-amber-red' | 'blue-yellow' | 'black-white';

export const SCENARIO_PALETTE_OPTIONS: Array<{ value: ScenarioColourPalette; label: string; stops: string[] }> = [
  { value: 'standard',        label: 'Standard',        stops: ['#EC4899', '#F59E0B', '#10B981', '#8B5CF6', '#EF4444', '#06B6D4'] },
  { value: 'rainbow',         label: 'Rainbow',         stops: ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'] },
  { value: 'green-amber-red', label: 'Green–Amber–Red', stops: ['#22c55e', '#eab308', '#ef4444'] },
  { value: 'blue-yellow',     label: 'Blue–Yellow',     stops: ['#3b82f6', '#eab308'] },
  { value: 'black-white',     label: 'Black–White',     stops: ['#333333', '#dddddd'] },
];

/** Interpolate a hex colour between two hex stops at fraction t ∈ [0,1]. */
function lerpColour(a: string, b: string, t: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

/** Generate N colours along a multi-stop gradient. */
export function generatePaletteColours(palette: ScenarioColourPalette, count: number): string[] {
  if (palette === 'standard' || count <= 0) return [];
  const def = SCENARIO_PALETTE_OPTIONS.find(p => p.value === palette);
  if (!def || def.stops.length === 0) return [];
  const stops = def.stops;
  if (count === 1) return [stops[0]];
  const colours: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const segPos = t * (stops.length - 1);
    const segIdx = Math.min(Math.floor(segPos), stops.length - 2);
    const segT = segPos - segIdx;
    colours.push(lerpColour(stops[segIdx], stops[segIdx + 1], segT));
  }
  return colours;
}

// Scenario colour palette (user scenarios cycle through these)
// Using more saturated, vibrant colours for better visibility
export const SCENARIO_PALETTE = [
  '#EC4899', // Hot Pink
  '#F59E0B', // Amber
  '#10B981', // Emerald
  '#8B5CF6', // Violet
  '#EF4444', // Red
  '#06B6D4', // Cyan
  '#F97316', // Orange
  '#A855F7', // Purple
  '#14B8A6', // Teal
  '#F43F5E', // Rose
  '#84CC16', // Lime
  '#6366F1', // Indigo
  '#D946EF', // Fuchsia
  '#0EA5E9', // Sky Blue
  '#FB923C', // Orange (lighter)
  '#22C55E', // Green
];
