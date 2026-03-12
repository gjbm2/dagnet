/**
 * Tests for toolbar zoom clamp logic.
 *
 * The floating toolbar (ChartFloatingIcon) applies CSS `zoom: cssZoom`
 * so it stays at constant screen-pixel size regardless of canvas zoom.
 *
 * Visual scale on screen = cssZoom × canvasZoom.
 * Goal: visual ≈ 1.0 (constant size), clamped:
 *  - maxScale: toolbar doesn't overflow container (zoomed out, wide toolbar)
 *  - MIN_VISUAL_SCALE (0.8): toolbar never appears below 80% of natural
 *    screen size — readability wins over overflow prevention.
 */

import { describe, it, expect } from 'vitest';
import { computeToolbarInvScale } from '../ChartInlineSettingsFloating';

// HANDLE_W = 32, so maxScale denominator is 32 + 200 = 232
// MIN_VISUAL_SCALE = 0.8

/** Helper: visual scale = cssZoom × canvasZoom */
function visualScale(cssZoom: number | undefined, canvasZoom: number): number {
  return (cssZoom ?? 1) * canvasZoom;
}

describe('computeToolbarInvScale', () => {
  // --- Returns undefined (no zoom compensation) ---

  it('returns undefined when canvasZoom is undefined', () => {
    expect(computeToolbarInvScale(undefined, 400)).toBeUndefined();
  });

  it('returns undefined when canvasZoom is 0 (falsy)', () => {
    expect(computeToolbarInvScale(0, 400)).toBeUndefined();
  });

  it('returns undefined when canvasZoom is 1 (no scaling needed)', () => {
    expect(computeToolbarInvScale(1, 400)).toBeUndefined();
  });

  // --- Perfect compensation (moderate zoom, wide container) ---

  it('returns 1/zoom when container is wide enough', () => {
    // zoom=0.5, container=1000px: raw=2.0, maxScale=4.31 → unclamped
    const result = computeToolbarInvScale(0.5, 1000);
    expect(result).toBeCloseTo(2.0);
    expect(visualScale(result, 0.5)).toBeCloseTo(1.0); // constant screen size
  });

  it('returns 1/zoom at moderate zoom-in', () => {
    // zoom=1.5: raw=0.667, visual=1.0 — perfect compensation
    const result = computeToolbarInvScale(1.5, 400);
    expect(result).toBeCloseTo(1 / 1.5);
    expect(visualScale(result, 1.5)).toBeCloseTo(1.0);
  });

  // --- Upper clamp (zoomed out, toolbar would overflow if unclamped) ---

  it('clamps to maxScale when raw would overflow, but visual stays above 0.8', () => {
    // zoom=0.5, container=400px: raw=2.0, maxScale=400/232≈1.72
    // visual = 0.5 × 1.72 = 0.86 → above 0.8, so maxScale wins
    const result = computeToolbarInvScale(0.5, 400);
    expect(result).toBeCloseTo(400 / 232);
    expect(visualScale(result, 0.5)).toBeGreaterThanOrEqual(0.8);
  });

  // --- Min visual clamp (zoomed out far, maxScale too aggressive) ---

  it('overrides maxScale to maintain minimum visual size when zoomed out far', () => {
    // zoom=0.2, container=300px: raw=5.0, maxScale=1.29
    // maxScale visual = 0.2 × 1.29 = 0.258 — TOO SMALL
    // minCssZoom = 0.8 / 0.2 = 4.0 → visual = 0.2 × 4.0 = 0.8
    const result = computeToolbarInvScale(0.2, 300);
    expect(result).toBeCloseTo(0.8 / 0.2);
    expect(visualScale(result, 0.2)).toBeCloseTo(0.8);
  });

  it('overrides maxScale on very narrow container when zoomed out', () => {
    // zoom=0.3, container=100px: maxScale=1, raw=3.33
    // maxScale visual = 0.3 × 1.0 = 0.3 — too small
    // minCssZoom = 0.8 / 0.3 = 2.667 → visual = 0.8
    const result = computeToolbarInvScale(0.3, 100);
    expect(result).toBeCloseTo(0.8 / 0.3);
    expect(visualScale(result, 0.3)).toBeCloseTo(0.8);
  });

  // --- Zoom-in: perfect 1/zoom (no clamp needed) ---

  it('returns 1/zoom when zoomed in — visual stays at 1.0', () => {
    // zoom=3.0: raw=0.333, minCssZoom=0.8/3=0.267
    // raw > minCssZoom, so raw wins → visual = 1.0
    const result = computeToolbarInvScale(3.0, 400);
    expect(result).toBeCloseTo(1 / 3);
    expect(visualScale(result, 3.0)).toBeCloseTo(1.0);
  });

  it('returns 1/zoom when zoomed in very far', () => {
    // zoom=5.0: raw=0.2, minCssZoom=0.8/5=0.16
    // raw > minCssZoom → raw wins → visual = 1.0
    const result = computeToolbarInvScale(5.0, 400);
    expect(result).toBeCloseTo(1 / 5);
    expect(visualScale(result, 5.0)).toBeCloseTo(1.0);
  });

  // --- Visual scale never drops below 0.8 ---

  it('visual scale is always >= 0.8 across a range of zoom-out levels', () => {
    const zoomLevels = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
    const containerWidths = [100, 200, 300, 400, 600];
    for (const z of zoomLevels) {
      for (const w of containerWidths) {
        const result = computeToolbarInvScale(z, w);
        const vs = visualScale(result, z);
        expect(vs).toBeGreaterThanOrEqual(0.8 - 1e-9); // float tolerance
      }
    }
  });

  // --- Edge cases ---

  it('falls back to maxScale=2 when container width is 0', () => {
    // zoom=0.5: raw=2.0, maxScale=2, minCssZoom=1.6
    // max(1.6, min(2.0, 2)) = max(1.6, 2.0) = 2.0
    const result = computeToolbarInvScale(0.5, 0);
    expect(result).toBeCloseTo(2.0);
  });
});
