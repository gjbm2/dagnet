/**
 * Daily Fetch Service
 * 
 * Service layer for managing dailyFetch flags on graphs.
 * Handles bulk updates, IDB operations, and sync to open tabs/stores.
 */

import { db } from '../db/appDatabase';
import { fileRegistry } from '../contexts/TabContext';
import { getGraphStore } from '../contexts/GraphStoreContext';
import type { GraphData } from '../types';
import toast from 'react-hot-toast';

export interface DailyFetchChange {
  graphFileId: string;
  dailyFetch: boolean;
}

export interface GraphListItem {
  fileId: string;
  name: string;
  dailyFetch: boolean;
  hasPinnedQuery: boolean;
}

class DailyFetchService {
  private static instance: DailyFetchService;

  static getInstance(): DailyFetchService {
    if (!DailyFetchService.instance) {
      DailyFetchService.instance = new DailyFetchService();
    }
    return DailyFetchService.instance;
  }

  /**
   * Get all graphs from IDB for the specified workspace.
   * Returns deduplicated list (handles prefixed/unprefixed variants).
   */
  async getGraphsForWorkspace(workspace: { repository: string; branch: string }): Promise<GraphListItem[]> {
    const allGraphFiles = await db.files
      .where('type')
      .equals('graph')
      .toArray();

    // Filter to workspace and dedupe prefixed vs unprefixed variants
    const seenCanonical = new Map<string, { fileId: string; data: GraphData | null }>();

    for (const file of allGraphFiles) {
      // Only files from this workspace
      if (file.source?.repository !== workspace.repository || file.source?.branch !== workspace.branch) {
        continue;
      }

      // Extract canonical name (handle both prefixed and unprefixed)
      let canonicalName: string;
      if (file.fileId.includes('-graph-')) {
        // Workspace-prefixed: 'repo-branch-graph-<name>'
        const parts = file.fileId.split('-graph-');
        canonicalName = parts[parts.length - 1];
      } else if (file.fileId.startsWith('graph-')) {
        // Unprefixed: 'graph-<name>'
        canonicalName = file.fileId.slice(6);
      } else {
        canonicalName = file.fileId;
      }

      const existing = seenCanonical.get(canonicalName);
      // Prefer workspace-prefixed variant if both exist
      if (!existing || file.fileId.includes('-graph-')) {
        seenCanonical.set(canonicalName, { 
          fileId: file.fileId, 
          data: file.data as GraphData | null 
        });
      }
    }

    // Convert to list items
    const items: GraphListItem[] = [];
    for (const [name, { fileId, data }] of seenCanonical) {
      items.push({
        fileId,
        name,
        dailyFetch: data?.dailyFetch ?? false,
        hasPinnedQuery: !!(data?.dataInterestsDSL),
      });
    }

    // Sort alphabetically
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Apply dailyFetch changes to multiple graphs.
   * Updates IDB, marks files dirty, and syncs to open FileRegistry/GraphStore.
   */
  async applyChanges(changes: DailyFetchChange[]): Promise<void> {
    if (changes.length === 0) return;

    for (const { graphFileId, dailyFetch } of changes) {
      const file = await db.files.get(graphFileId);
      if (!file || file.type !== 'graph') {
        console.warn(`[dailyFetchService] File not found or not a graph: ${graphFileId}`);
        continue;
      }

      const data = file.data as GraphData;
      const updatedData = { ...data, dailyFetch };

      // Update IDB (the prefixed or unprefixed variant we found)
      await db.files.update(graphFileId, {
        data: updatedData,
        isDirty: true,
        lastModified: Date.now(),
      });

      // Extract canonical (unprefixed) fileId for FileRegistry/GraphStore sync
      // IDB may have prefixed fileId, but tabs use unprefixed
      let canonicalFileId: string;
      if (graphFileId.includes('-graph-')) {
        // Workspace-prefixed: 'repo-branch-graph-<name>' -> 'graph-<name>'
        const parts = graphFileId.split('-graph-');
        canonicalFileId = `graph-${parts[parts.length - 1]}`;
      } else {
        canonicalFileId = graphFileId;
      }

      // Also update the unprefixed variant in IDB if it exists and differs
      if (canonicalFileId !== graphFileId) {
        const unprefixedFile = await db.files.get(canonicalFileId);
        if (unprefixedFile && unprefixedFile.type === 'graph') {
          const unprefixedData = unprefixedFile.data as GraphData;
          await db.files.update(canonicalFileId, {
            data: { ...unprefixedData, dailyFetch },
            isDirty: true,
            lastModified: Date.now(),
          });
        }
      }

      // Sync to FileRegistry using canonical (unprefixed) fileId
      const registryFile = fileRegistry.getFile(canonicalFileId);
      if (registryFile) {
        // FileRegistry.updateFile expects the *file data*, not a FileState-shaped wrapper.
        // Passing a wrapper would corrupt the in-memory graph shape and break UI reads (e.g. dailyFetch checkbox).
        fileRegistry.updateFile(canonicalFileId, updatedData);
      }

      // Sync to GraphStore using canonical (unprefixed) fileId
      const store = getGraphStore(canonicalFileId);
      if (store) {
        store.getState().setGraph(updatedData);
      }
    }

    toast.success(`Updated ${changes.length} graph(s)`);
  }
}

export const dailyFetchService = DailyFetchService.getInstance();
