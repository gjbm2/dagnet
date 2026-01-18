import { ukReferenceDayService } from './ukReferenceDayService';

type Subscription = (dayUK: string) => void;

let timer: number | null = null;
let lastDayUK: string | null = null;
const subs = new Set<Subscription>();

function tick(): void {
  const dayUK = ukReferenceDayService.getReferenceDayUK();
  if (lastDayUK === null) lastDayUK = dayUK;
  if (dayUK !== lastDayUK) {
    lastDayUK = dayUK;
    for (const fn of subs) {
      try {
        fn(dayUK);
      } catch {
        // best-effort subscribers only
      }
    }
  }

  const nextMs = ukReferenceDayService.getNextDayBoundaryMs();
  const delay = Math.max(10_000, Math.min(6 * 60 * 60 * 1000, nextMs - Date.now() + 500));
  timer = window.setTimeout(tick, delay);
}

export const ukDayBoundarySchedulerService = {
  start(): void {
    if (timer) return;
    lastDayUK = ukReferenceDayService.getReferenceDayUK();
    timer = window.setTimeout(tick, Math.max(10_000, ukReferenceDayService.getNextDayBoundaryMs() - Date.now() + 500));
  },

  stop(): void {
    if (timer) window.clearTimeout(timer);
    timer = null;
    lastDayUK = null;
  },

  subscribe(fn: Subscription): () => void {
    subs.add(fn);
    // ensure scheduler is running when at least one subscriber exists
    this.start();
    return () => {
      subs.delete(fn);
      if (subs.size === 0) this.stop();
    };
  },
};


