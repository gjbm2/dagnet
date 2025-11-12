/**
 * Confidence Interval Color Calculation
 * 
 * Calculates lightened colors for confidence interval bands using symmetric intensity schema.
 * Ensures inner band matches normal edge color exactly.
 */

const EDGE_OPACITY = 0.8; // Match existing edge opacity

const CONFIDENCE_SPREAD = {
  '80': 1.10,  // Subtle
  '90': 1.25,  // Moderate
  '95': 1.40,  // Pronounced
  '99': 1.60   // Very pronounced
} as const;

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
 * Convert RGB to hex color
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => {
    const hex = Math.round(Math.max(0, Math.min(255, n))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Calculate confidence interval colors for three overlapping paths
 * 
 * Uses symmetric lightening factors to ensure:
 * - Inner band (a) matches normal edge color exactly
 * - Middle band (b) is slightly lighter than inner
 * - Outer band (c) is significantly lighter than middle
 * - Spread is symmetric around middle band
 * 
 * @param baseColor Hex color string (e.g., '#999999')
 * @param confidenceLevel Confidence level ('80' | '90' | '95' | '99')
 * @returns Object with inner, middle, and outer color strings
 */
export function calculateConfidenceIntervalColors(
  baseColor: string,
  confidenceLevel: '80' | '90' | '95' | '99'
): { inner: string; middle: string; outer: string } {
  const rgb = hexToRgb(baseColor);
  if (!rgb) {
    // Fallback to gray if parsing fails
    console.warn(`[CI Colors] Failed to parse color: ${baseColor}`);
    return { inner: '#999999', middle: '#999999', outer: '#999999' };
  }

  // Calculate per RGB channel (factor algebra to keep middle constant and inner match single-stroke)
  const calculateChannel = (channelValue: number): { inner: number; middle: number; outer: number } => {
    const C = channelValue;
    if (C <= 0) return { inner: 0, middle: 0, outer: 0 };

    // Normalize to [0,1]
    const e = C / 255;
    const alpha = EDGE_OPACITY;
    const oneMinus = 1 - alpha;

    // Target single-stroke composite factor (must hold for inner triple-overlap)
    const t = oneMinus + alpha * e; // ∈ [oneMinus, 1]

    // Choose a CI-dependent outer composite factor f_sc in [t, 1]
    // Map CI spread r to a proportion p ∈ (0,1]: higher r → closer to 1 (lighter)
    const r = CONFIDENCE_SPREAD[confidenceLevel];
    const p = (r - 1.10) / (1.60 - 1.10); // 80%→0, 99%→1
    const f_sc_raw = 1 - (0.35 + 0.4 * p) * (1 - t); // 80%: ~0.65 toward 1; 99%: ~0.45 toward 1
    const f_sc = Math.min(1, Math.max(oneMinus + 0.01, f_sc_raw));

    // Keep middle composite factor f_sb constant across CI (visual invariance of middle stroke)
    // Choose f_sb high enough to avoid forcing inner above 1; clamp to [t, 0.98]
    const f_sb = Math.min(0.95, Math.max(t, Math.sqrt(t)));

    // Solve for inner composite factor to keep triple product equal to t
    // f_sa = t / (f_sb * f_sc)
    let f_sa = t / (f_sb * f_sc);
    if (f_sa > 0.98) {
      // If inner would exceed 1, pull outer back to satisfy constraint
      f_sa = 0.98;
    }
    const f_sc_adjusted = Math.min(1, Math.max(oneMinus + 0.01, t / (f_sb * f_sa)));

    // Convert composite factors back to stroke colors per channel
    const s_a = Math.min(1, Math.max(0, (f_sa - oneMinus) / alpha));
    const s_b = Math.min(1, Math.max(0, (f_sb - oneMinus) / alpha));
    const s_c = Math.min(1, Math.max(0, (f_sc_adjusted - oneMinus) / alpha));

    const inner = Math.round(s_a * 255);
    const middle = Math.round(s_b * 255);
    const outer = Math.round(s_c * 255);

    if (C === rgb.r && (baseColor.includes('b3b3b3') || baseColor.includes('999'))) {
      console.log(`[CI Colors] C=${C}, t=${t.toFixed(3)}, f_sb=${f_sb.toFixed(3)}, f_sc=${f_sc_adjusted.toFixed(3)}, f_sa=${f_sa.toFixed(3)}, s:`, {s_a: s_a.toFixed(3), s_b: s_b.toFixed(3), s_c: s_c.toFixed(3)});
    }

    return { inner, middle, outer };
  };

  const rChannels = calculateChannel(rgb.r);
  const gChannels = calculateChannel(rgb.g);
  const bChannels = calculateChannel(rgb.b);

  return {
    inner: rgbToHex(rChannels.inner, gChannels.inner, bChannels.inner),
    middle: rgbToHex(rChannels.middle, gChannels.middle, bChannels.middle),
    outer: rgbToHex(rChannels.outer, gChannels.outer, bChannels.outer)
  };
}

/**
 * Calculate confidence interval bounds (upper, mean, lower) from mean and stdev
 * 
 * @param mean Mean probability value
 * @param stdev Standard deviation
 * @param confidenceLevel Confidence level ('80' | '90' | '95' | '99')
 * @returns Object with upper, mean, and lower bounds
 */
export function calculateConfidenceBounds(
  mean: number,
  stdev: number,
  confidenceLevel: '80' | '90' | '95' | '99'
): { upper: number; mean: number; lower: number } {
  // Z-scores for confidence levels
  const Z_SCORES = {
    '80': 1.282,
    '90': 1.645,
    '95': 1.960,
    '99': 2.576
  } as const;

  const z = Z_SCORES[confidenceLevel];
  const margin = z * stdev;

  return {
    upper: Math.min(1, Math.max(0, mean + margin)),
    mean: mean,
    lower: Math.max(0, Math.min(1, mean - margin))
  };
}

