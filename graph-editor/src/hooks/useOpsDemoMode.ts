/**
 * Operations Demo Mode
 *
 * Activated by ?opsdemo URL parameter. Runs a scripted sequence of mock
 * operations through the registry so we can visually validate the
 * OperationsToast UI in all states.
 *
 * Scenarios exercised:
 *  1. Simple progress operation (batch fetch)
 *  2. Countdown → running transition
 *  3. Operation with sub-steps
 *  4. Cancellable operation (user can test cancel)
 *  5. Error outcome
 *  6. Multiple concurrent operations
 */

import { useEffect, useRef } from 'react';
import { operationRegistryService } from '../services/operationRegistryService';
import { countdownService } from '../services/countdownService';
import { bannerManagerService } from '../services/bannerManagerService';

function isOpsDemoEnabled(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('opsdemo');
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDemoSequence(signal: AbortSignal): Promise<void> {
  const log = (msg: string) => console.log(`[opsdemo] ${msg}`);

  log('Starting operations demo sequence…');
  await sleep(500);

  // ---- Scenario 0: Pending + cancellable ----------------------------------
  log('Scenario 0: Pending operation with cancel');
  const pendingId = 'demo:pending-fetch';
  let pendingCancelled = false;
  operationRegistryService.register({
    id: pendingId,
    kind: 'batch-fetch',
    label: 'Queued: fetch portfolio-equity',
    status: 'pending',
    cancellable: true,
    onCancel: () => {
      pendingCancelled = true;
      operationRegistryService.complete(pendingId, 'cancelled');
      log('Scenario 0 cancelled by user');
    },
  });

  // Sit in pending for 3 seconds, then transition to running.
  await sleep(3000);
  if (signal.aborted) return;
  if (!pendingCancelled) {
    operationRegistryService.setStatus(pendingId, 'running');
    operationRegistryService.setProgress(pendingId, { current: 0, total: 5, detail: 'Starting…' });
    for (let i = 1; i <= 5; i++) {
      if (signal.aborted || pendingCancelled) break;
      await sleep(400);
      operationRegistryService.setProgress(pendingId, { current: i, total: 5, detail: `Item ${i}/5` });
    }
    if (!pendingCancelled) {
      operationRegistryService.complete(pendingId, 'complete');
    }
    log('Scenario 0 complete');
    await sleep(1500);
  }

  // ---- Scenario 1: Simple progress operation ------------------------------
  log('Scenario 1: Simple progress (batch fetch)');
  const fetchId = 'demo:batch-fetch';
  operationRegistryService.register({
    id: fetchId,
    kind: 'batch-fetch',
    label: 'Fetching data\n12 items queued',
    status: 'running',
    progress: { current: 0, total: 12 },
  });

  for (let i = 1; i <= 12; i++) {
    if (signal.aborted) return;
    await sleep(400);
    operationRegistryService.setProgress(fetchId, {
      current: i,
      total: 12,
      detail: `Item ${i}/12: daily-cac-${i}`,
    });
    if (i === 6) {
      operationRegistryService.setLabel(fetchId, 'Fetching data\n6 cached, 6 remaining');
    }
  }

  operationRegistryService.complete(fetchId, 'complete');
  log('Scenario 1 complete');
  await sleep(2000);

  // ---- Scenario 2: Countdown → running -----------------------------------
  log('Scenario 2: Countdown → running');
  const pullId = 'demo:auto-pull';
  operationRegistryService.register({
    id: pullId,
    kind: 'auto-pull',
    label: 'Auto-pulling latest changes',
    status: 'countdown',
  });

  const countdownKey = 'op:demo:auto-pull';
  bannerManagerService.setBanner({
    id: pullId,
    priority: 100,
    label: 'Auto-pulling from repository in 5s…',
    detail: 'New data is available. Hover the toast to see details.',
    actionLabel: 'Cancel',
    onAction: () => {
      countdownService.cancelCountdown(countdownKey);
      bannerManagerService.clearBanner(pullId);
      operationRegistryService.complete(pullId, 'cancelled');
      log('Scenario 2 cancelled by user');
    },
    operationId: pullId,
  });

  // Drive countdown manually for demo (8 seconds — gives time to test pause).
  // Respects the registry's countdownPaused flag.
  operationRegistryService.setCountdown(pullId, 8);
  operationRegistryService.setCancellable(pullId, () => {
    bannerManagerService.clearBanner(pullId);
    operationRegistryService.complete(pullId, 'cancelled');
    log('Scenario 2 cancelled by user');
  });
  for (let tick = 0; tick < 80; tick++) {
    if (signal.aborted) return;
    const op = operationRegistryService.get(pullId);
    if (!op || op.status !== 'countdown') break;

    // Skip ticks while paused.
    if (!op.countdownPaused) {
      const next = (op.countdownSecondsRemaining ?? 1) - 1;
      if (next <= 0) break;
      operationRegistryService.setCountdown(pullId, next);
      bannerManagerService.setBanner({
        id: pullId,
        priority: 100,
        label: `Auto-pulling from repository in ${next}s…`,
        detail: 'New data is available. Hover the toast to see details.',
        actionLabel: 'Cancel',
        onAction: () => {
          bannerManagerService.clearBanner(pullId);
          operationRegistryService.complete(pullId, 'cancelled');
        },
        operationId: pullId,
      });
    }
    await sleep(1000);
  }

  // If not cancelled, transition to running.
  const pullOp = operationRegistryService.get(pullId);
  if (pullOp && pullOp.status === 'countdown') {
    bannerManagerService.clearBanner(pullId);
    operationRegistryService.setStatus(pullId, 'running');
    operationRegistryService.setProgress(pullId, { current: 0, total: 3, detail: 'Pulling…' });

    const steps = ['Pulling latest', 'Merging changes', 'Rebuilding index'];
    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) return;
      await sleep(800);
      operationRegistryService.setProgress(pullId, {
        current: i + 1,
        total: 3,
        detail: steps[i],
      });
    }
    operationRegistryService.complete(pullId, 'complete');
    log('Scenario 2 complete');
  }

  await sleep(2000);

  // ---- Scenario 3: Sub-steps ---------------------------------------------
  log('Scenario 3: Operation with sub-steps');
  const automationId = 'demo:automation';
  operationRegistryService.register({
    id: automationId,
    kind: 'automation',
    label: 'Daily retrieve-all — portfolio-main',
    status: 'running',
  });

  const subStepDefs = [
    { label: 'Git pull', duration: 600 },
    { label: 'Retrieve all slices', duration: 1500 },
    { label: 'Recompute horizons', duration: 400 },
    { label: 'Commit & push', duration: 800 },
  ];

  operationRegistryService.setSubSteps(
    automationId,
    subStepDefs.map((s) => ({ label: s.label, status: 'pending' as const }))
  );

  for (let i = 0; i < subStepDefs.length; i++) {
    if (signal.aborted) return;
    const steps = subStepDefs.map((s, j) => ({
      label: s.label,
      status: (j < i ? 'complete' : j === i ? 'running' : 'pending') as 'complete' | 'running' | 'pending',
      detail: j === i ? 'In progress…' : undefined,
    }));
    operationRegistryService.setSubSteps(automationId, steps);
    operationRegistryService.setProgress(automationId, {
      current: i,
      total: subStepDefs.length,
      detail: subStepDefs[i].label,
    });
    await sleep(subStepDefs[i].duration);
  }

  operationRegistryService.setSubSteps(
    automationId,
    subStepDefs.map((s) => ({ label: s.label, status: 'complete' as const }))
  );
  operationRegistryService.setProgress(automationId, {
    current: subStepDefs.length,
    total: subStepDefs.length,
  });
  operationRegistryService.complete(automationId, 'complete');
  log('Scenario 3 complete');
  await sleep(1500);

  // ---- Scenario 4: Cancellable operation ----------------------------------
  log('Scenario 4: Cancellable operation (cancel after 3 items)');
  const cancelId = 'demo:cancellable';
  let cancelled = false;
  operationRegistryService.register({
    id: cancelId,
    kind: 'batch-fetch',
    label: 'Fetching — cancellable demo',
    status: 'running',
    cancellable: true,
    onCancel: () => {
      cancelled = true;
      operationRegistryService.complete(cancelId, 'cancelled');
      log('Scenario 4 cancelled');
    },
    progress: { current: 0, total: 8 },
  });

  for (let i = 1; i <= 8; i++) {
    if (signal.aborted || cancelled) break;
    await sleep(600);
    if (cancelled) break;
    operationRegistryService.setProgress(cancelId, {
      current: i,
      total: 8,
      detail: `Processing item ${i}`,
    });
  }

  if (!cancelled) {
    operationRegistryService.complete(cancelId, 'complete');
  }
  await sleep(2000);

  // ---- Scenario 5: Error outcome ------------------------------------------
  log('Scenario 5: Error outcome');
  const errorId = 'demo:error';
  operationRegistryService.register({
    id: errorId,
    kind: 'index-rebuild',
    label: 'Rebuilding search index',
    status: 'running',
    progress: { current: 0, total: 5 },
  });

  for (let i = 1; i <= 3; i++) {
    if (signal.aborted) return;
    await sleep(500);
    operationRegistryService.setProgress(errorId, {
      current: i,
      total: 5,
      detail: `Processing shard ${i}`,
    });
  }

  operationRegistryService.complete(errorId, 'error', 'Shard 4 failed: connection timeout');
  log('Scenario 5 complete (error)');
  await sleep(2000);

  // ---- Scenario 6: Multiple concurrent operations -------------------------
  log('Scenario 6: Multiple concurrent operations');
  const concurrentIds = ['demo:concurrent-1', 'demo:concurrent-2', 'demo:concurrent-3'];
  const labels = ['Fetching portfolio-a', 'Fetching portfolio-b', 'Fetching portfolio-c'];
  const totals = [6, 10, 4];

  for (let i = 0; i < concurrentIds.length; i++) {
    operationRegistryService.register({
      id: concurrentIds[i],
      kind: 'batch-fetch',
      label: labels[i],
      status: 'running',
      cancellable: true,
      onCancel: () => operationRegistryService.complete(concurrentIds[i], 'cancelled'),
      progress: { current: 0, total: totals[i] },
    });
  }

  // Progress them at different rates.
  const cursors = [0, 0, 0];
  const speeds = [300, 200, 500]; // ms per item
  const done = [false, false, false];

  for (let tick = 0; tick < 40; tick++) {
    if (signal.aborted) return;
    await sleep(150);

    for (let i = 0; i < 3; i++) {
      if (done[i]) continue;
      if ((tick * 150) % speeds[i] < 150) {
        cursors[i]++;
        if (cursors[i] >= totals[i]) {
          cursors[i] = totals[i];
          done[i] = true;
          operationRegistryService.setProgress(concurrentIds[i], {
            current: cursors[i],
            total: totals[i],
          });
          operationRegistryService.complete(
            concurrentIds[i],
            i === 1 ? 'error' : 'complete',
            i === 1 ? '2 items failed' : undefined
          );
        } else {
          operationRegistryService.setProgress(concurrentIds[i], {
            current: cursors[i],
            total: totals[i],
            detail: `Item ${cursors[i]}/${totals[i]}`,
          });
        }
      }
    }

    if (done.every(Boolean)) break;
  }

  log('Scenario 6 complete');
  await sleep(3000);
  log('Demo sequence finished. All operations should be in recent list.');
}

export function useOpsDemoMode(): void {
  const hasRun = useRef(false);

  useEffect(() => {
    if (!isOpsDemoEnabled() || hasRun.current) return;
    hasRun.current = true;

    const controller = new AbortController();

    // Small delay so the app finishes initial render.
    const timeout = setTimeout(() => {
      void runDemoSequence(controller.signal);
    }, 1000);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);
}
