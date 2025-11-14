/**
 * ColorAssigner
 * 
 * Assigns colors to visible scenarios based on activation order.
 * Color assignment rules:
 * - 1 visible: grey
 * - 2 visible: complementary colors (blue/pink)
 * - N visible: evenly distributed hues around color wheel
 */

/**
 * Assign colors to scenarios based on visibility and activation order
 * 
 * @param visibleIds - IDs of visible scenarios (in any order)
 * @param activationOrder - IDs in activation order (determines color assignment)
 * @returns Map of scenario ID to color (hex string)
 */
export function assignColors(
  visibleIds: string[],
  activationOrder: string[]
): Map<string, string> {
  const colorMap = new Map<string, string>();
  
  // Filter activation order to only include visible scenarios
  const visibleInActivationOrder = activationOrder.filter(id => 
    visibleIds.includes(id)
  );
  
  const count = visibleInActivationOrder.length;
  
  if (count === 0) {
    return colorMap;
  }
  
  if (count === 1) {
    // Single scenario: grey
    colorMap.set(visibleInActivationOrder[0], '#808080');
    return colorMap;
  }
  
  if (count === 2) {
    // Two scenarios: complementary colors (blue and pink)
    colorMap.set(visibleInActivationOrder[0], '#4A90E2'); // Blue
    colorMap.set(visibleInActivationOrder[1], '#E24A90'); // Pink
    return colorMap;
  }
  
  // N scenarios: evenly distributed hues
  visibleInActivationOrder.forEach((id, index) => {
    const hue = (index * 360) / count;
    const color = hslToHex(hue, 65, 55); // 65% saturation, 55% lightness
    colorMap.set(id, color);
  });
  
  return colorMap;
}

/**
 * Convert HSL to hex color
 * 
 * @param h - Hue (0-360)
 * @param s - Saturation (0-100)
 * @param l - Lightness (0-100)
 * @returns Hex color string (e.g., "#4A90E2")
 */
function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;
  
  let r = 0, g = 0, b = 0;
  
  if (h >= 0 && h < 60) {
    r = c; g = x; b = 0;
  } else if (h >= 60 && h < 120) {
    r = x; g = c; b = 0;
  } else if (h >= 120 && h < 180) {
    r = 0; g = c; b = x;
  } else if (h >= 180 && h < 240) {
    r = 0; g = x; b = c;
  } else if (h >= 240 && h < 300) {
    r = x; g = 0; b = c;
  } else if (h >= 300 && h < 360) {
    r = c; g = 0; b = x;
  }
  
  const rHex = Math.round((r + m) * 255).toString(16).padStart(2, '0');
  const gHex = Math.round((g + m) * 255).toString(16).padStart(2, '0');
  const bHex = Math.round((b + m) * 255).toString(16).padStart(2, '0');
  
  return `#${rHex}${gHex}${bHex}`;
}

/**
 * Get a default color for a new scenario (before it's made visible)
 */
export function getDefaultScenarioColor(): string {
  return '#808080'; // Grey
}



