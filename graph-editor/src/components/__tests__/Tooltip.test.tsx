/**
 * Tooltip + GlossaryTooltip tests.
 *
 * Covers the Phase-0 tooltip infrastructure:
 *  - Tooltip shows/hides on hover with the configured delay
 *  - Tooltip suppression when a modal overlay is present
 *  - Tooltip suppression when content is empty (disableWhenEmpty)
 *  - ARIA wiring (role="tooltip", aria-describedby)
 *  - GlossaryTooltip renders registered term content
 *  - GlossaryTooltip falls back silently when term is unknown (dev warning)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import Tooltip from '../Tooltip';
import GlossaryTooltip from '../GlossaryTooltip';

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
  });

  it('shows after the configured delay on mouse enter and hides on leave', () => {
    render(
      <Tooltip content="Hello" delay={200}>
        <button>target</button>
      </Tooltip>
    );

    const trigger = screen.getByText('target');
    fireEvent.mouseEnter(trigger);

    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.getByRole('tooltip')).toHaveTextContent('Hello');

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('links aria-describedby from trigger to tooltip when visible', () => {
    render(
      <Tooltip content="Aria check" delay={0}>
        <button>target</button>
      </Tooltip>
    );

    const trigger = screen.getByText('target').parentElement!;
    fireEvent.mouseEnter(screen.getByText('target'));

    act(() => {
      vi.advanceTimersByTime(0);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(tooltip.id).toBeTruthy();
  });

  it('hides when Escape is pressed', () => {
    render(
      <Tooltip content="Dismiss me" delay={0}>
        <button>target</button>
      </Tooltip>
    );

    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not show when a modal overlay is present in the DOM', () => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);

    render(
      <Tooltip content="Suppressed" delay={0}>
        <button>target</button>
      </Tooltip>
    );

    fireEvent.mouseEnter(screen.getByText('target'));
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('suppresses the wrapper and listeners entirely when content is empty', () => {
    render(
      <Tooltip content={null} delay={0}>
        <button data-testid="bare">target</button>
      </Tooltip>
    );

    const button = screen.getByTestId('bare');
    // No .dagnet-tooltip-trigger wrapper around the child when suppressed
    expect(button.parentElement?.classList.contains('dagnet-tooltip-trigger')).toBe(false);

    fireEvent.mouseEnter(button);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('GlossaryTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
  });

  it('renders the registered title and description for a known term', () => {
    render(
      <GlossaryTooltip term="probability" delay={0}>
        <span>p</span>
      </GlossaryTooltip>
    );

    fireEvent.mouseEnter(screen.getByText('p'));
    act(() => {
      vi.advanceTimersByTime(0);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Probability (p)');
    expect(tooltip.textContent).toMatch(/chance of taking this edge/i);
  });

  it('falls back to rendering children bare for an unknown term', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <GlossaryTooltip term="definitely-not-a-real-term" delay={0}>
        <span>plain</span>
      </GlossaryTooltip>
    );

    fireEvent.mouseEnter(screen.getByText('plain'));
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
    warn.mockRestore();
  });

  it('allows overriding the description while using a registered title', () => {
    render(
      <GlossaryTooltip term="probability" description="Custom description." delay={0}>
        <span>p</span>
      </GlossaryTooltip>
    );

    fireEvent.mouseEnter(screen.getByText('p'));
    act(() => {
      vi.advanceTimersByTime(0);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Probability (p)');
    expect(tooltip).toHaveTextContent('Custom description.');
  });
});
