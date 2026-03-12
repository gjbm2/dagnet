/**
 * Tests for legend merged toggle+position control in settingPillRenderer.
 *
 * The legend group merges show_legend (checkbox) and legend_position (radio)
 * into a single pill group with arrow icons. Behaviour:
 * - Clicking inactive position → turns legend on + sets position (batch)
 * - Clicking active position → toggles legend off
 * - Only the active position pill has the 'active' class
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderTraySettings } from '../settingPillRenderer';
import type { DisplaySettingDef } from '../../../lib/analysisDisplaySettingsRegistry';
import { CHART_DISPLAY_SETTINGS } from '../../../lib/analysisDisplaySettingsRegistry';

/** Extract the legend settings from any chart kind that has them. */
function getLegendSettings(): DisplaySettingDef[] {
  const kind = CHART_DISPLAY_SETTINGS['time_series'];
  return kind.filter(s => s.group === 'legend');
}

/** Render only the legend group and return the container. */
function renderLegend(
  display: Record<string, unknown> | undefined,
  onChange: (keyOrBatch: string | Record<string, any>, val?: any) => void,
) {
  const settings = getLegendSettings();
  const elements = renderTraySettings(settings, display, onChange);
  return render(<div data-testid="legend-container">{elements}</div>);
}

describe('legend merged control', () => {
  it('renders position buttons for all legend_position options', () => {
    const onChange = vi.fn();
    renderLegend({ show_legend: true, legend_position: 'top' }, onChange);

    expect(screen.getByTitle('Hide legend')).toBeTruthy();
    expect(screen.getByTitle('Legend: Bottom')).toBeTruthy();
    expect(screen.getByTitle('Legend: Left')).toBeTruthy();
    expect(screen.getByTitle('Legend: Right')).toBeTruthy();
  });

  it('marks only the active position as active', () => {
    const onChange = vi.fn();
    renderLegend({ show_legend: true, legend_position: 'bottom' }, onChange);

    const bottomBtn = screen.getByTitle('Hide legend');
    const topBtn = screen.getByTitle('Legend: Top');
    const rightBtn = screen.getByTitle('Legend: Right');
    const leftBtn = screen.getByTitle('Legend: Left');

    expect(bottomBtn.className).toContain('active');
    expect(topBtn.className).not.toContain('active');
    expect(rightBtn.className).not.toContain('active');
    expect(leftBtn.className).not.toContain('active');
  });

  it('no pills are active when legend is off', () => {
    const onChange = vi.fn();
    const { container } = renderLegend({ show_legend: false, legend_position: 'top' }, onChange);

    const activePills = container.querySelectorAll('.cfp-pill.active');
    expect(activePills.length).toBe(0);
  });

  it('clicking inactive position emits batch { show_legend: true, legend_position }', () => {
    const onChange = vi.fn();
    renderLegend({ show_legend: false, legend_position: 'top' }, onChange);

    fireEvent.click(screen.getByTitle('Legend: Bottom'));

    // Should be a single batch call, NOT two separate calls
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ show_legend: true, legend_position: 'bottom' });
  });

  it('clicking active position emits show_legend: false', () => {
    const onChange = vi.fn();
    renderLegend({ show_legend: true, legend_position: 'right' }, onChange);

    fireEvent.click(screen.getByTitle('Hide legend'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('show_legend', false);
  });

  it('clicking a different position when legend is already on emits batch', () => {
    const onChange = vi.fn();
    renderLegend({ show_legend: true, legend_position: 'top' }, onChange);

    fireEvent.click(screen.getByTitle('Legend: Left'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ show_legend: true, legend_position: 'left' });
  });

  it('default legend_position is top when display is undefined', () => {
    const onChange = vi.fn();
    renderLegend(undefined, onChange);

    // Default: show_legend=true, legend_position=top → top is active
    const topBtn = screen.getByTitle('Hide legend');
    expect(topBtn.className).toContain('active');
  });
});
