/**
 * Batch mode state management and toast suppression.
 *
 * When batch mode is active, individual per-item toasts are buffered and
 * replaced with a single summary toast when the batch completes.
 *
 * Extracted from dataOperationsService.ts (Cluster A) during slimdown.
 */

import toast from 'react-hot-toast';
import { sessionLogService } from '../sessionLogService';

/**
 * Batch mode flag - when true, suppresses individual toasts during batch operations
 * Set this before starting a batch operation and reset it after
 */
let batchModeActive = false;

/** Enable batch mode to suppress individual toasts */
export function setBatchMode(active: boolean): void {
  // When ending a batch, flush the aggregated toast + session log summary once.
  if (batchModeActive && !active) {
    // Ensure any lingering "data fetch" spinner toast is closed out at the end of a batch.
    // In batch mode, some paths may show a toast.loading with a fixed id (e.g. 'das-fetch'),
    // while success/error toasts are suppressed/buffered. Without this, the spinner can stick.
    try {
      const t: any = toast as any;
      if (typeof t?.dismiss === 'function') {
        t.dismiss('das-fetch');
      }
    } catch {
      // ignore
    }
    flushBatchToasts();
  }
  batchModeActive = active;
}

/** Check if batch mode is active */
export function isBatchMode(): boolean {
  return batchModeActive;
}

/**
 * Deactivate batch mode and discard all buffered toasts without flushing.
 *
 * Intended for callers that suppress the batch progress toast (suppressBatchToast)
 * but still need batch mode active to prevent individual per-item toast spam.
 * The caller owns its own progress UI, so neither individual nor summary toasts are wanted.
 */
export function discardBatchMode(): void {
  batchToastBuffer = [];
  batchModeActive = false;
}

type BatchToastKind = 'success' | 'error' | 'info';
type BatchToastEntry = { kind: BatchToastKind; message: string };

let batchToastBuffer: BatchToastEntry[] = [];

function recordBatchToast(kind: BatchToastKind, message: string): void {
  batchToastBuffer.push({ kind, message });
}

function flushBatchToasts(): void {
  if (!batchToastBuffer.length) return;

  const entries = batchToastBuffer;
  batchToastBuffer = [];

  const successes = entries.filter(e => e.kind === 'success').map(e => e.message);
  const errors = entries.filter(e => e.kind === 'error').map(e => e.message);
  const infos = entries.filter(e => e.kind === 'info').map(e => e.message);

  const successCount = successes.length;
  const errorCount = errors.length;
  const infoCount = infos.length;

  // Single toast summary for the whole batch.
  if (errorCount > 0) {
    toast.error(`Updated ${successCount} item${successCount === 1 ? '' : 's'}; ${errorCount} failed`);
  } else if (successCount > 0) {
    toast.success(`Updated ${successCount} item${successCount === 1 ? '' : 's'}`);
  } else {
    toast.success(`Batch complete (${infoCount} update${infoCount === 1 ? '' : 's'})`);
  }

  // Mirror detail into session log (so details are not lost when we suppress per-item toasts).
  // Keep the detail compact; session log can store a multi-line payload.
  const detailLines: string[] = [];
  if (successCount) {
    detailLines.push('Updated:');
    detailLines.push(...successes.map(s => `- ${s}`));
  }
  if (errorCount) {
    detailLines.push('Failed:');
    detailLines.push(...errors.map(s => `- ${s}`));
  }
  if (infoCount && !successCount && !errorCount) {
    detailLines.push('Info:');
    detailLines.push(...infos.map(s => `- ${s}`));
  }
  sessionLogService.success(
    'file',
    'BATCH_FILE_UPDATES',
    `Batch updates: ${successCount} updated, ${errorCount} failed`,
    detailLines.join('\n'),
    { successCount, errorCount, infoCount }
  );
}

/** Wrapper for toast that respects batch mode */
export function batchableToast(message: string, options?: any): string | void {
  if (batchModeActive) {
    recordBatchToast('info', message);
    return;
  }
  return toast(message, options);
}

/** Wrapper for toast.success that respects batch mode */
export function batchableToastSuccess(message: string, options?: any): string | void {
  if (batchModeActive) {
    recordBatchToast('success', message);
    return;
  }
  return toast.success(message, options);
}

/** Wrapper for toast.error that respects batch mode */
export function batchableToastError(message: string, options?: any): string | void {
  if (batchModeActive) {
    recordBatchToast('error', message);
    return;
  }
  return toast.error(message, options);
}
