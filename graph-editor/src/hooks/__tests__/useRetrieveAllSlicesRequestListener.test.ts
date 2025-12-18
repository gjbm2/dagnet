/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  requestRetrieveAllSlices,
  useRetrieveAllSlicesRequestListener,
} from '../useRetrieveAllSlicesRequestListener';

describe('useRetrieveAllSlicesRequestListener', () => {
  it('should call onRequest when requestRetrieveAllSlices is dispatched', () => {
    const onRequest = vi.fn();
    renderHook(() => useRetrieveAllSlicesRequestListener(onRequest));

    requestRetrieveAllSlices();
    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});


