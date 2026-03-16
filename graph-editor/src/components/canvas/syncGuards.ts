/**
 * Sync Guard API — centralised guard state for the Graph↔ReactFlow sync engine.
 *
 * All guard refs are owned by this module. External code interacts with guards
 * through named transition functions rather than raw ref mutations. This
 * establishes single-owner semantics and provides a single point of control
 * for future improvements (dev-mode invariant checks, transition logging, etc.).
 *
 * Created as part of B1 sync engine extraction (Sub-phase 1).
 *
 * setTimeout delay catalogue (preserved from original GraphCanvas):
 *   0ms  — RF→Graph isSyncingRef clear (let React batch settle)
 *   0ms  — sankeyUpdatingRef clear (re-entrancy gate)
 *   0ms  — visualWhatIfUpdateRef clear (queue flush)
 *   100ms — Slow path isSyncingRef clear (cascading updates)
 *   150ms — sankeyLayoutInProgressRef clear (layout effects settle)
 *   250ms — Initial fitView (node population)
 */

import type { MutableRefObject } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InteractionKind = 'drag' | 'resize';

export interface SyncGuardRefs {
  isSyncingRef: MutableRefObject<boolean>;
  isDraggingNodeRef: MutableRefObject<boolean>;
  isResizingNodeRef: MutableRefObject<boolean>;
  sankeyLayoutInProgressRef: MutableRefObject<boolean>;
  effectsCooldownUntilRef: MutableRefObject<number>;
  skipSankeyNodeSizingRef: MutableRefObject<boolean>;
  recomputeInProgressRef: MutableRefObject<boolean>;
  visualWhatIfUpdateRef: MutableRefObject<boolean>;
  sankeyUpdatingRef: MutableRefObject<boolean>;
}

export interface SyncGuards {
  // --- External transitions (called by code outside the sync engine) ---

  /** Called by useNodeDrag.onNodeDragStart or handleResizeStart */
  beginInteraction: (kind: InteractionKind) => void;
  /** Called by useNodeDrag.onNodeDragStop or handleResizeEnd */
  endInteraction: (kind: InteractionKind) => void;

  /** Called by performSankeyLayout at layout start */
  beginLayoutTransaction: (cooldownMs: number) => void;
  /** Called by performSankeyLayout's setTimeout at layout end */
  endLayoutTransaction: (extendCooldownMs: number) => void;

  /** Called by performSankeyLayout after setting node sizes upstream */
  skipNextSankeyNodeSizing: () => void;

  // --- Query functions (called by external code to check guard state) ---

  /** True if layout transaction or effects cooldown is active */
  isBlocked: () => boolean;
  /** True if user is dragging or resizing */
  isInteracting: () => boolean;
  /** True if Graph→RF sync is in progress */
  isSyncing: () => boolean;
  /** True if timestamp-based cooldown is active */
  isEffectsCooldownActive: () => boolean;
  /** True if user is dragging a node */
  isDragging: () => boolean;
  /** True if user is resizing a node */
  isResizing: () => boolean;

  // --- Internal transitions (called within the sync engine) ---

  /** Set isSyncing true — Graph→RF sync beginning */
  beginSync: () => void;
  /** Clear isSyncing after delay — Graph→RF sync complete */
  endSync: (delayMs: number) => void;

  /** Set isSyncing true for RF→Graph direction (edge reconnection) */
  beginConnectionSync: () => void;
  /** Clear isSyncing after delay for RF→Graph direction */
  endConnectionSync: (delayMs: number) => void;

  /** Mark what-if recompute as in progress */
  beginWhatIfRecompute: () => void;
  /** Clear what-if recompute flag */
  endWhatIfRecompute: () => void;

  /** Mark current edge update as visual-only (what-if) */
  markVisualOnly: () => void;
  /** Clear visual-only flag after queue flush */
  clearVisualOnly: (delayMs: number) => void;
  /** Check if current update is visual-only */
  isVisualOnly: () => boolean;

  /** Mark Sankey node sizing as in progress */
  beginSankeyUpdate: () => void;
  /** Clear Sankey update flag */
  endSankeyUpdate: (delayMs: number) => void;
  /** Check if Sankey update is in progress */
  isSankeyUpdating: () => boolean;

  /** Check and consume skipSankeyNodeSizing flag (returns true and clears if set) */
  consumeSkipSankeyNodeSizing: () => boolean;

  /** Check if what-if recompute is already in progress */
  isRecomputeInProgress: () => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SyncGuards API wrapping the given refs.
 *
 * In Sub-phase 1 the refs are declared in GraphCanvas and passed in.
 * In Sub-phase 2 the refs will move into the useGraphSync hook and this
 * factory will be called there instead.
 */
export function createSyncGuards(refs: SyncGuardRefs): SyncGuards {
  const {
    isSyncingRef,
    isDraggingNodeRef,
    isResizingNodeRef,
    sankeyLayoutInProgressRef,
    effectsCooldownUntilRef,
    skipSankeyNodeSizingRef,
    recomputeInProgressRef,
    visualWhatIfUpdateRef,
    sankeyUpdatingRef,
  } = refs;

  // -- Query helpers (shared by transitions and public queries) --

  const isEffectsCooldownActive = (): boolean =>
    performance.now() < effectsCooldownUntilRef.current;

  // -- Public API --

  return {
    // External transitions
    beginInteraction(kind: InteractionKind) {
      if (kind === 'drag') {
        isDraggingNodeRef.current = true;
      } else {
        isResizingNodeRef.current = true;
      }
    },

    endInteraction(kind: InteractionKind) {
      if (kind === 'drag') {
        isDraggingNodeRef.current = false;
      } else {
        isResizingNodeRef.current = false;
      }
    },

    beginLayoutTransaction(cooldownMs: number) {
      sankeyLayoutInProgressRef.current = true;
      effectsCooldownUntilRef.current = performance.now() + cooldownMs;
    },

    endLayoutTransaction(extendCooldownMs: number) {
      sankeyLayoutInProgressRef.current = false;
      effectsCooldownUntilRef.current = performance.now() + extendCooldownMs;
    },

    skipNextSankeyNodeSizing() {
      skipSankeyNodeSizingRef.current = true;
    },

    // Query functions
    isBlocked: () =>
      sankeyLayoutInProgressRef.current || isEffectsCooldownActive(),

    isInteracting: () =>
      isDraggingNodeRef.current || isResizingNodeRef.current,

    isSyncing: () => isSyncingRef.current,

    isEffectsCooldownActive,

    isDragging: () => isDraggingNodeRef.current,

    isResizing: () => isResizingNodeRef.current,

    // Internal transitions — sync direction
    beginSync() {
      isSyncingRef.current = true;
    },

    endSync(delayMs: number) {
      setTimeout(() => {
        isSyncingRef.current = false;
      }, delayMs);
    },

    beginConnectionSync() {
      isSyncingRef.current = true;
    },

    endConnectionSync(delayMs: number) {
      setTimeout(() => {
        isSyncingRef.current = false;
      }, delayMs);
    },

    // Internal transitions — what-if recompute
    beginWhatIfRecompute() {
      recomputeInProgressRef.current = true;
    },

    endWhatIfRecompute() {
      recomputeInProgressRef.current = false;
    },

    isRecomputeInProgress: () => recomputeInProgressRef.current,

    // Internal transitions — visual-only marker
    markVisualOnly() {
      visualWhatIfUpdateRef.current = true;
    },

    clearVisualOnly(delayMs: number) {
      setTimeout(() => {
        visualWhatIfUpdateRef.current = false;
      }, delayMs);
    },

    isVisualOnly: () => visualWhatIfUpdateRef.current,

    // Internal transitions — Sankey update
    beginSankeyUpdate() {
      sankeyUpdatingRef.current = true;
    },

    endSankeyUpdate(delayMs: number) {
      setTimeout(() => {
        sankeyUpdatingRef.current = false;
      }, delayMs);
    },

    isSankeyUpdating: () => sankeyUpdatingRef.current,

    // Skip sizing — consume pattern (read and clear atomically)
    consumeSkipSankeyNodeSizing(): boolean {
      if (skipSankeyNodeSizingRef.current) {
        skipSankeyNodeSizingRef.current = false;
        return true;
      }
      return false;
    },
  };
}
