/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

import { sessionLogService } from '../../../services/sessionLogService';
import { SessionLogViewer } from '../SessionLogViewer';

describe('SessionLogViewer tail mode', () => {
  beforeEach(() => {
    sessionLogService.clear();
  });

  it('keeps tail enabled and scrolls to bottom when new entries arrive', async () => {
    // Make requestAnimationFrame run immediately in tests.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0 as any;
    });

    const { container } = render(<SessionLogViewer />);

    const entriesEl = container.querySelector('.log-entries') as HTMLDivElement | null;
    expect(entriesEl).toBeTruthy();
    if (!entriesEl) return;

    // Fake a scrollable container.
    Object.defineProperty(entriesEl, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(entriesEl, 'scrollHeight', { value: 1000, configurable: true });
    entriesEl.scrollTop = 0;

    await act(async () => {
      sessionLogService.info('session', 'T1', 'First');
    });

    // Tail should have scrolled us to the bottom.
    expect(entriesEl.scrollTop).toBe(1000);

    // User scrolls up: tail preference should remain enabled, but we should offer "Latest".
    entriesEl.scrollTop = 0;
    await act(async () => {
      entriesEl.dispatchEvent(new Event('scroll'));
    });

    const tailCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(tailCheckbox).toBeTruthy();
    expect(tailCheckbox?.checked).toBe(true);

    expect(container.textContent).toContain('Latest');

    // Add more entries; scrollHeight increases; should scroll again and remain tailing.
    Object.defineProperty(entriesEl, 'scrollHeight', { value: 2000, configurable: true });

    await act(async () => {
      sessionLogService.info('session', 'T2', 'Second');
    });

    // Because user scrolled up, we do NOT auto-scroll; we keep position until they jump.
    expect(entriesEl.scrollTop).toBe(0);
  });
});


