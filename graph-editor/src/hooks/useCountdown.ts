import { useSyncExternalStore } from 'react';
import { countdownService, type CountdownState } from '../services/countdownService';

export function useCountdown(key: string | undefined): CountdownState | undefined {
  return useSyncExternalStore(
    (cb) => countdownService.subscribe(cb),
    () => (key ? countdownService.getState(key) : undefined),
    () => undefined
  );
}

