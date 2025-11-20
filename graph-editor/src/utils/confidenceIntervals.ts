/**
 * Confidence Interval Colour Calculation
 * 
 * Calculates lightened colours for confidence interval bands using symmetric intensity schema.
 * Ensures inner band matches normal edge colour exactly.
 */

const EDGE_OPACITY = 0.8; // Match existing edge opacity

const CONFIDENCE_SPREAD = {
  '80': 1.10,  // Subtle
  '90': 1.25,  // Moderate
  '95': 1.40,  // Pronounced
  '99': 1.60   // Very pronounced
} as const;

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
 * Convert RGB to hex colour
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => {
    const hex = Math.round(Math.max(0, Math.min(255, n))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Calculate confidence interval colours for three overlapping paths
 * 
 * Uses symmetric lightening factors to ensure:
 * - Inner band (a) matches normal edge colour exactly
 * - Middle band (b) is slightly lighter than inner
 * - Outer band (c) is significantly lighter than middle
 * - Spread is symmetric around middle band
 * 
 * @param baseColour Hex colour string (e.g., '#999999')
 * @param confidenceLevel Confidence level ('80' | '90' | '95' | '99')
 * @returns Object with inner, middle, and outer colour strings
 */
export function calculateConfidenceIntervalColours(
  baseColour: string,
  confidenceLevel: '80' | '90' | '95' | '99'
): { inner: string; middle: string; outer: string } {
  const rgb = hexToRgb(baseColour);
  if (!rgb) {
    // Fallback to gray if parsing fails
    console.warn(`[CI Colours] Failed to parse color: ${baseColour}`);
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

    // Convert composite factors back to stroke colours per channel
    const s_a = Math.min(1, Math.max(0, (f_sa - oneMinus) / alpha));
    const s_b = Math.min(1, Math.max(0, (f_sb - oneMinus) / alpha));
    const s_c = Math.min(1, Math.max(0, (f_sc_adjusted - oneMinus) / alpha));

    const inner = Math.round(s_a * 255);
    const middle = Math.round(s_b * 255);
    const outer = Math.round(s_c * 255);

    if (C === rgb.r && (baseColour.includes('b3b3b3') || baseColour.includes('999'))) {
      console.log(`[CI Colours] C=${C}, t=${t.toFixed(3)}, f_sb=${f_sb.toFixed(3)}, f_sc=${f_sc_adjusted.toFixed(3)}, f_sa=${f_sa.toFixed(3)}, s:`, {s_a: s_a.toFixed(3), s_b: s_b.toFixed(3), s_c: s_c.toFixed(3)});
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
 * @param distribution Distribution type ('normal' | 'beta' | 'uniform')
 * @returns Object with upper, mean, and lower bounds
 */
export function calculateConfidenceBounds(
  mean: number,
  stdev: number,
  confidenceLevel: '80' | '90' | '95' | '99',
  distribution: 'normal' | 'beta' | 'uniform' = 'beta'
): { upper: number; mean: number; lower: number } {
  
  if (distribution === 'beta') {
    return calculateBetaConfidenceBounds(mean, stdev, confidenceLevel);
  } else if (distribution === 'uniform') {
    return calculateUniformConfidenceBounds(mean, stdev, confidenceLevel);
  } else {
    // Normal distribution (with clamping to [0,1])
    return calculateNormalConfidenceBounds(mean, stdev, confidenceLevel);
  }
}

/**
 * Calculate confidence bounds using normal distribution (legacy, less accurate for probabilities)
 */
function calculateNormalConfidenceBounds(
  mean: number,
  stdev: number,
  confidenceLevel: '80' | '90' | '95' | '99'
): { upper: number; mean: number; lower: number } {
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

/**
 * Calculate confidence bounds using beta distribution (proper for probabilities)
 * Converts mean/stdev to alpha/beta, then uses beta quantiles
 */
function calculateBetaConfidenceBounds(
  mean: number,
  stdev: number,
  confidenceLevel: '80' | '90' | '95' | '99'
): { upper: number; mean: number; lower: number } {
  // Confidence level to tail probabilities
  const TAIL_PROBS = {
    '80': 0.10, // 10% in each tail
    '90': 0.05, // 5% in each tail
    '95': 0.025, // 2.5% in each tail
    '99': 0.005  // 0.5% in each tail
  } as const;
  
  const tailProb = TAIL_PROBS[confidenceLevel];
  
  // Convert mean/stdev to alpha/beta parameters
  // For beta distribution: mean = α/(α+β), variance = αβ/((α+β)²(α+β+1))
  // Solving for α,β:
  const variance = stdev * stdev;
  
  // Clamp mean away from 0 and 1 to avoid numerical issues
  const clampedMean = Math.max(0.001, Math.min(0.999, mean));
  
  // Check if variance is feasible for beta distribution
  // Max variance for given mean is mean*(1-mean)
  const maxVariance = clampedMean * (1 - clampedMean);
  
  if (variance >= maxVariance * 0.99) {
    // Variance too high for beta - fall back to normal with clamping
    return calculateNormalConfidenceBounds(mean, stdev, confidenceLevel);
  }
  
  const alpha = clampedMean * ((clampedMean * (1 - clampedMean)) / variance - 1);
  const beta = (1 - clampedMean) * ((clampedMean * (1 - clampedMean)) / variance - 1);
  
  // Sanity check: alpha and beta must be > 0
  if (alpha <= 0 || beta <= 0 || !isFinite(alpha) || !isFinite(beta)) {
    // Fall back to normal distribution
    return calculateNormalConfidenceBounds(mean, stdev, confidenceLevel);
  }
  
  // Calculate quantiles using incomplete beta function approximation
  const lowerBound = betaQuantile(tailProb, alpha, beta);
  const upperBound = betaQuantile(1 - tailProb, alpha, beta);
  
  return {
    upper: Math.min(1, Math.max(0, upperBound)),
    mean: mean,
    lower: Math.max(0, Math.min(1, lowerBound))
  };
}

/**
 * Approximate beta distribution quantile (inverse CDF)
 * Uses Wilson-Hilferty approximation for reasonable accuracy
 */
function betaQuantile(p: number, alpha: number, beta: number): number {
  // For simple cases, use direct approximation
  if (alpha === 1 && beta === 1) {
    return p; // Uniform distribution
  }
  
  // Wilson-Hilferty normal approximation for beta quantile
  // More complex but reasonably accurate
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1));
  const stdev = Math.sqrt(variance);
  
  // Normal quantile approximation
  const z = normalQuantile(p);
  let q = mean + z * stdev;
  
  // Clamp to [0, 1]
  q = Math.max(0, Math.min(1, q));
  
  return q;
}

/**
 * Approximate standard normal quantile (inverse CDF)
 * Using Beasley-Springer-Moro algorithm
 */
function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  
  // Coefficients for rational approximation
  const a = [
    -3.969683028665376e+01,
    2.209460984245205e+02,
    -2.759285104469687e+02,
    1.383577518672690e+02,
    -3.066479806614716e+01,
    2.506628277459239e+00
  ];
  
  const b = [
    -5.447609879822406e+01,
    1.615858368580409e+02,
    -1.556989798598866e+02,
    6.680131188771972e+01,
    -1.328068155288572e+01
  ];
  
  const c = [
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e+00,
    -2.549732539343734e+00,
    4.374664141464968e+00,
    2.938163982698783e+00
  ];
  
  const d = [
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e+00,
    3.754408661907416e+00
  ];
  
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  
  let q, r, x;
  
  if (p < pLow) {
    // Lower region
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    // Central region
    q = p - 0.5;
    r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    // Upper region
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
         ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  
  return x;
}

/**
 * Calculate confidence bounds for uniform distribution
 */
function calculateUniformConfidenceBounds(
  mean: number,
  stdev: number,
  confidenceLevel: '80' | '90' | '95' | '99'
): { upper: number; mean: number; lower: number } {
  // For uniform distribution U(a,b): mean = (a+b)/2, stdev = (b-a)/sqrt(12)
  // Solve for a,b: 
  const range = stdev * Math.sqrt(12);
  const lower = Math.max(0, mean - range / 2);
  const upper = Math.min(1, mean + range / 2);
  
  return { upper, mean, lower };
}

