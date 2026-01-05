import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { requestPutToBase, usePutToBaseRequestListener } from '../usePutToBaseRequestListener';

describe('usePutToBaseRequestListener', () => {
  it('should call onRequest only for matching tabId', () => {
    const onRequest = vi.fn();
    renderHook(() => usePutToBaseRequestListener('tab-1', onRequest));

    requestPutToBase('tab-2');
    expect(onRequest).toHaveBeenCalledTimes(0);

    requestPutToBase('tab-1');
    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});


