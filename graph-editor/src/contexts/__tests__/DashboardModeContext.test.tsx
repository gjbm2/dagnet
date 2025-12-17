import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { DashboardModeProvider } from '../DashboardModeContext';
import { useDashboardMode } from '../../hooks/useDashboardMode';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DashboardModeProvider>{children}</DashboardModeProvider>;
}

describe('DashboardModeContext', () => {
  it('should bootstrap from ?dashboard URL parameter', async () => {
    window.history.replaceState({}, document.title, '/?dashboard');

    const { result } = renderHook(() => useDashboardMode(), { wrapper });

    await waitFor(() => {
      expect(result.current.isDashboardMode).toBe(true);
    });
  });

  it('should update URL when toggling dashboard mode', async () => {
    window.history.replaceState({}, document.title, '/');

    const { result } = renderHook(() => useDashboardMode(), { wrapper });

    await waitFor(() => {
      expect(result.current.isDashboardMode).toBe(false);
    });

    act(() => {
      result.current.toggleDashboardMode({ updateUrl: true });
    });

    await waitFor(() => {
      expect(result.current.isDashboardMode).toBe(true);
      expect(new URLSearchParams(window.location.search).has('dashboard')).toBe(true);
    });

    act(() => {
      result.current.toggleDashboardMode({ updateUrl: true });
    });

    await waitFor(() => {
      expect(result.current.isDashboardMode).toBe(false);
      expect(new URLSearchParams(window.location.search).has('dashboard')).toBe(false);
    });
  });
});


