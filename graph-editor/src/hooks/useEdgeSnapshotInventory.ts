/**
 * useEdgeSnapshotInventory Hook
 * 
 * Provides snapshot inventory data for edge tooltips.
 * Handles caching to avoid redundant API calls.
 * 
 * This centralises the inventory fetch logic that was previously
 * in ConversionEdge.tsx (violating "no logic in UI files" rule).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { getBatchInventoryV2, type SnapshotInventory, type SnapshotInventoryV2Param } from '../services/snapshotWriteService';
import { sessionLogService } from '../services/sessionLogService';

// Module-level cache to avoid refetching across component instances
const inventoryCache = new Map<string, SnapshotInventory>();
const pendingFetches = new Map<string, Promise<SnapshotInventory>>();

function toLegacyInventory(dbParamId: string, inv: SnapshotInventoryV2Param | undefined): SnapshotInventory {
  const overallAll = inv?.overall_all_families;
  if (!overallAll) {
    return {
      has_data: false,
      param_id: dbParamId,
      earliest: null,
      latest: null,
      row_count: 0,
      unique_days: 0,
      unique_slices: 0,
      unique_hashes: 0,
      unique_retrievals: 0,
      unique_retrieved_days: 0,
    };
  }

  // Prefer matched family when available.
  const matchedFamilyId = inv?.current?.matched_family_id || null;
  const families = Array.isArray(inv?.families) ? inv!.families : [];
  const matchedFamily = matchedFamilyId ? families.find((f) => f.family_id === matchedFamilyId) : undefined;
  const source = matchedFamily?.overall ?? overallAll;

  return {
    has_data: source.row_count > 0,
    param_id: dbParamId,
    // Show retrieved_at range, not anchor_day range.
    earliest: source.earliest_retrieved_at,
    latest: source.latest_retrieved_at,
    row_count: source.row_count,
    unique_days: source.unique_anchor_days,
    unique_slices: 0,
    unique_hashes: 0,
    unique_retrievals: source.unique_retrievals,
    unique_retrieved_days: source.unique_retrieved_days,
  };
}

export interface UseEdgeSnapshotInventoryResult {
  /** Snapshot inventory for this edge (null if not yet fetched or no data) */
  inventory: SnapshotInventory | null;
  /** Trigger a fetch (call on hover) */
  fetchInventory: () => void;
}

/**
 * Hook to get snapshot inventory for an edge.
 * 
 * @param edgeId - The edge ID (e.g., 'A-B')
 * @returns Object with inventory and fetchInventory function
 * 
 * @example
 * ```tsx
 * const { inventory, fetchInventory } = useEdgeSnapshotInventory('A-B');
 * 
 * const handleMouseEnter = () => {
 *   fetchInventory(); // Triggers fetch if not cached
 * };
 * 
 * // Use inventory in tooltip
 * if (inventory && inventory.row_count > 0) {
 *   // Show snapshot info
 * }
 * ```
 */
export function useEdgeSnapshotInventory(edgeId: string | undefined): UseEdgeSnapshotInventoryResult {
  const [inventory, setInventory] = useState<SnapshotInventory | null>(null);
  const fetchedRef = useRef<string | null>(null);
  
  const navigatorContext = useNavigatorContext();
  const { selectedRepo, selectedBranch } = navigatorContext?.state || { selectedRepo: '', selectedBranch: '' };
  
  // Build the database param ID
  const dbParamId = selectedRepo && selectedBranch && edgeId
    ? `${selectedRepo}-${selectedBranch}-e.${edgeId}.p`
    : null;
  
  // Check cache on mount/change
  useEffect(() => {
    if (dbParamId && inventoryCache.has(dbParamId)) {
      const cached = inventoryCache.get(dbParamId)!;
      if (cached.row_count > 0) {
        setInventory(cached);
      }
    }
  }, [dbParamId]);
  
  const fetchInventory = useCallback(() => {
    if (!dbParamId) return;
    if (fetchedRef.current === dbParamId) return; // Already fetched this one
    
    // Check cache first
    if (inventoryCache.has(dbParamId)) {
      const cached = inventoryCache.get(dbParamId)!;
      if (cached.row_count > 0) {
        setInventory(cached);
      }
      fetchedRef.current = dbParamId;
      return;
    }
    
    // Check if fetch is already in progress
    if (pendingFetches.has(dbParamId)) {
      pendingFetches.get(dbParamId)!.then(inv => {
        if (inv && inv.row_count > 0) {
          setInventory(inv);
        }
      });
      fetchedRef.current = dbParamId;
      return;
    }
    
    // Start new fetch
    fetchedRef.current = dbParamId;
    const fetchPromise = (async (): Promise<SnapshotInventory> => {
      const invByParam = await getBatchInventoryV2([dbParamId], { include_equivalents: true });
      return toLegacyInventory(dbParamId, invByParam[dbParamId]);
    })();
    pendingFetches.set(dbParamId, fetchPromise);
    
    fetchPromise
      .then(inv => {
        inventoryCache.set(dbParamId, inv);
        pendingFetches.delete(dbParamId);
        if (inv && inv.row_count > 0) {
          setInventory(inv);
        }
      })
      .catch((error) => {
        pendingFetches.delete(dbParamId);
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[useEdgeSnapshotInventory] Failed to fetch inventory:', errorMessage);
        sessionLogService.warning(
          'data-fetch',
          'SNAPSHOT_INVENTORY_EDGE_ERROR',
          `Failed to fetch snapshot inventory for ${dbParamId}`,
          errorMessage,
          { dbParamId }
        );
      });
  }, [dbParamId]);
  
  return { inventory, fetchInventory };
}

/**
 * Clear the inventory cache.
 * Call this after deleting snapshots to ensure fresh data.
 */
export function clearInventoryCache(): void {
  inventoryCache.clear();
}

/**
 * Invalidate a specific param from the cache.
 */
export function invalidateInventoryCache(dbParamId: string): void {
  inventoryCache.delete(dbParamId);
}
