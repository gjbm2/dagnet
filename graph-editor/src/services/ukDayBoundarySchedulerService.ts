/**
 * UK Day Boundary Scheduler
 *
 * Fires at midnight UK time and notifies subscribers. Used by ScenariosContext
 * to invalidate dynamic DSLs on day change.
 *
 * Timer management is delegated to jobSchedulerService (deadline pattern).
 * This module is a thin adapter that preserves the existing subscribe API.
 */

import { ukReferenceDayService } from './ukReferenceDayService';
import { jobSchedulerService } from './jobSchedulerService';

type Subscription = (dayUK: string) => void;

let lastDayUK: string | null = null;
let jobRegistered = false;
const subs = new Set<Subscription>();

function registerJobIfNeeded(): void {
  if (jobRegistered) return;
  jobRegistered = true;

  lastDayUK = ukReferenceDayService.getReferenceDayUK();

  jobSchedulerService.registerJob({
    id: 'uk-day-boundary',
    schedule: {
      type: 'deadline',
      getNextDeadlineMs: () => ukReferenceDayService.getNextDayBoundaryMs() + 500,
    },
    bootGated: false,
    presentation: 'silent',
    runFn: async () => {
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
    },
  });
}

export const ukDayBoundarySchedulerService = {
  start(): void {
    registerJobIfNeeded();
  },

  stop(): void {
    // No-op: lifecycle is owned by the scheduler.
    // Kept for API compatibility.
  },

  subscribe(fn: Subscription): () => void {
    subs.add(fn);
    registerJobIfNeeded();
    return () => {
      subs.delete(fn);
    };
  },
};






