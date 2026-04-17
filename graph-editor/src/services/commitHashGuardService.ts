/**
 * Commit Hash Guard Service
 *
 * Detects hash-breaking changes in event/context files at commit time,
 * traces the dependency tree to find affected parameters, and computes
 * old/new core_hash pairs for hash-mappings.json entries.
 *
 * This service contains only the detection and computation logic.
 * The UI (tree-checkbox modal) is a separate component.
 *
 * @see docs/current/project-contexts/VARIANT_CONTEXTS_DESIGN.md
 */

import { db } from '../db/appDatabase';
import { computeQuerySignature } from './dataOperations/querySignature';
import { computeShortCoreHash } from './coreHashService';
import { sessionLogService } from './sessionLogService';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HashChangeItem {
  /** Parameter display name (edge from → to) */
  paramLabel: string;
  /** Parameter file ID */
  paramId: string;
  /** Graph name this parameter belongs to */
  graphName: string;
  /** Graph file ID */
  graphFileId: string;
  /** The changed file that caused this hash change */
  changedFile: string;
  /** Old core_hash (from stored query_signature) */
  oldCoreHash: string;
  /** New core_hash (recomputed with updated definitions) */
  newCoreHash: string;
}

export interface HashGuardResult {
  /** Changed files grouped by file → graph → parameters */
  changedFiles: Array<{
    fileId: string;
    fileName: string;
    fileType: 'event' | 'context';
    graphs: Array<{
      graphName: string;
      graphFileId: string;
      items: HashChangeItem[];
    }>;
  }>;
  /** Total number of hash mapping entries that would be created */
  totalMappings: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

class CommitHashGuardService {

  /**
   * Detect hash-breaking changes in the commit changeset.
   *
   * @param committedFiles - Files being committed (from the commit modal)
   * @param getOldFileContent - Callback to fetch the git HEAD version of a file
   * @param workspace - Current workspace (repository + branch)
   * @returns HashGuardResult with affected parameters, or null if no hash changes
   */
  async detectHashChanges(
    committedFiles: Array<{ fileId: string; type: string; data: any; source?: { path?: string } }>,
    getOldFileContent: (path: string, branch: string) => Promise<any | null>,
    workspace: { repository: string; branch: string },
  ): Promise<HashGuardResult | null> {

    // Step 1: Identify event/context files in the changeset
    const hashAffectingFiles = committedFiles.filter(f =>
      f.type === 'event' || f.type === 'context'
    );

    if (hashAffectingFiles.length === 0) return null;

    const logOpId = sessionLogService.startOperation(
      'info', 'integrity', 'HASH_GUARD',
      `Checking ${hashAffectingFiles.length} event/context file(s) for hash changes`
    );

    const changedFiles: HashGuardResult['changedFiles'] = [];
    let totalMappings = 0;

    for (const file of hashAffectingFiles) {
      const filePath = file.source?.path;
      if (!filePath) continue;

      // Step 2: Get old version from git
      const oldContent = await getOldFileContent(filePath, workspace.branch);
      if (oldContent === null) {
        // New file — no old hash to compare
        sessionLogService.addChild(logOpId, 'info', 'HASH_GUARD_NEW_FILE',
          `${file.fileId}: new file, skipping hash comparison`);
        continue;
      }

      // Step 3: Parse old content
      const oldData = typeof oldContent === 'string' ? JSON.parse(oldContent) : oldContent;
      const newData = file.data;

      // Step 4: Find affected parameters
      const fileType = file.type as 'event' | 'context';
      const affectedParams = await this.findAffectedParameters(
        file.fileId, fileType, oldData, newData, workspace
      );

      if (affectedParams.length === 0) continue;

      // Step 5: Group by graph
      const graphMap = new Map<string, { graphName: string; graphFileId: string; items: HashChangeItem[] }>();

      for (const param of affectedParams) {
        const key = param.graphFileId;
        if (!graphMap.has(key)) {
          graphMap.set(key, {
            graphName: param.graphName,
            graphFileId: param.graphFileId,
            items: [],
          });
        }
        graphMap.get(key)!.items.push({
          ...param,
          changedFile: file.fileId,
        });
      }

      const graphs = Array.from(graphMap.values());
      const fileItemCount = graphs.reduce((sum, g) => sum + g.items.length, 0);
      totalMappings += fileItemCount * 2; // window + cohort per parameter

      changedFiles.push({
        fileId: file.fileId,
        fileName: filePath.split('/').pop() || file.fileId,
        fileType,
        graphs,
      });

      sessionLogService.addChild(logOpId, 'info', 'HASH_GUARD_FILE',
        `${file.fileId}: ${fileItemCount} params affected across ${graphs.length} graph(s)`);
    }

    if (changedFiles.length === 0) {
      sessionLogService.endOperation(logOpId, 'success', 'No hash-breaking changes detected');
      return null;
    }

    sessionLogService.endOperation(logOpId, 'warning',
      `${totalMappings} hash mappings needed across ${changedFiles.length} file(s)`);

    return { changedFiles, totalMappings };
  }

  /**
   * Find all parameters affected by a changed event/context file.
   */
  private async findAffectedParameters(
    fileId: string,
    fileType: 'event' | 'context',
    oldData: any,
    newData: any,
    workspace: { repository: string; branch: string },
  ): Promise<Array<Omit<HashChangeItem, 'changedFile'>>> {

    // Load all graphs in the workspace
    const allFiles = await db.files.where('type').equals('graph').toArray();
    const graphFiles = allFiles.filter(f =>
      f.source?.repository === workspace.repository &&
      f.source?.branch === workspace.branch
    );

    const results: Array<Omit<HashChangeItem, 'changedFile'>> = [];
    const seenParams = new Set<string>(); // Deduplicate

    for (const graphFile of graphFiles) {
      const graph = graphFile.data as any;
      if (!graph?.nodes || !graph?.edges) continue;

      let affectedEdges: any[];

      if (fileType === 'event') {
        // Event change: find nodes with this event_id, then edges referencing those nodes
        const eventId = newData.id || oldData.id;
        const affectedNodeIds = (graph.nodes as any[])
          .filter((n: any) => n.event_id === eventId)
          .map((n: any) => n.id);

        if (affectedNodeIds.length === 0) continue;

        affectedEdges = (graph.edges as any[]).filter((edge: any) => {
          if (!edge.query) return false;
          return affectedNodeIds.some((nodeId: string) => edge.query.includes(nodeId));
        });
      } else {
        // Context change: find graphs whose dataInterestsDSL references this context
        const contextId = newData.id || oldData.id;
        const dsl = graph.dataInterestsDSL || '';
        if (!dsl.includes(`context(${contextId}`) && !dsl.includes(`context(${contextId}:`)) {
          continue;
        }
        // All edges in this graph are affected
        affectedEdges = (graph.edges as any[]).filter((edge: any) => !!edge.query);
      }

      for (const edge of affectedEdges) {
        // Find the parameter for this edge
        const paramId = this.resolveParamId(edge, graph);
        if (!paramId) continue;
        if (seenParams.has(paramId)) continue;
        seenParams.add(paramId);

        // Get old core_hash from stored query_signature
        const oldCoreHash = await this.getStoredCoreHash(paramId, workspace);
        if (!oldCoreHash) continue; // Never fetched — nothing to preserve

        // Compute new core_hash with updated definitions
        const newCoreHash = await this.computeNewCoreHash(
          edge, graph, fileId, fileType, newData, workspace
        );
        if (!newCoreHash) continue;

        // Only include if hash actually changed
        if (oldCoreHash === newCoreHash) continue;

        const fromNode = graph.nodes?.find((n: any) => edge.query?.includes(`from(${n.id})`));
        const toNode = graph.nodes?.find((n: any) => edge.query?.includes(`to(${n.id})`));
        const paramLabel = `${fromNode?.id || '?'} → ${toNode?.id || '?'}`;

        results.push({
          paramLabel,
          paramId,
          graphName: graph.metadata?.name || graph.name || graphFile.fileId,
          graphFileId: graphFile.fileId,
          oldCoreHash,
          newCoreHash,
        });
      }
    }

    return results;
  }

  /**
   * Resolve the parameter ID for an edge.
   */
  private resolveParamId(edge: any, _graph: any): string | undefined {
    // Check common locations where parameter ID is stored on edges
    if (edge.p?.id) return edge.p.id;
    if (edge.paramId) return edge.paramId;

    // Fall back to deriving from from/to node IDs in the query
    const fromMatch = edge.query?.match(/from\(([^)]+)\)/);
    const toMatch = edge.query?.match(/to\(([^)]+)\)/);
    if (fromMatch && toMatch) {
      return `${fromMatch[1]}-to-${toMatch[1]}`;
    }

    return undefined;
  }

  /**
   * Get the stored core_hash from a parameter's query_signature in IDB.
   */
  private async getStoredCoreHash(
    paramId: string,
    workspace: { repository: string; branch: string },
  ): Promise<string | null> {
    // Try multiple ID patterns used in IDB
    const candidates = [
      `${workspace.repository}-${workspace.branch}-${paramId}`,  // workspace-prefixed
      paramId,                                                     // bare
      `parameter-${paramId}`,                                      // type-prefixed
      `${workspace.repository}-${workspace.branch}-parameter-${paramId}`, // both
    ];

    let paramFile: any = null;
    for (const id of candidates) {
      paramFile = await db.files.get(id);
      if (paramFile?.data) break;
    }

    // Fallback: scan all parameter files for matching id in data
    if (!paramFile?.data) {
      const allParams = await db.files.where('type').equals('parameter').toArray();
      const scoped = allParams.filter(f =>
        f.source?.repository === workspace.repository &&
        f.source?.branch === workspace.branch
      );
      paramFile = scoped.find(f => (f.data as any)?.id === paramId);
    }

    if (!paramFile?.data) return null;

    // Find a value with query_signature and compute the short core_hash
    // (same format used by the snapshot DB)
    const values = (paramFile.data as any).values;
    if (!Array.isArray(values)) return null;

    for (const val of values) {
      if (val.query_signature) {
        try {
          return await computeShortCoreHash(val.query_signature);
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  /**
   * Compute new core_hash with updated event/context definition.
   */
  private async computeNewCoreHash(
    edge: any,
    graph: any,
    changedFileId: string,
    fileType: 'event' | 'context',
    newData: any,
    workspace: { repository: string; branch: string },
  ): Promise<string | null> {
    try {
      // Build event definitions map
      const eventDefs = await this.loadEventDefinitions(workspace);

      // If the changed file is an event, substitute the new version
      if (fileType === 'event') {
        const eventId = newData.id;
        if (eventId) {
          eventDefs[eventId] = newData;
        }
      }

      // Extract context keys
      const contextKeys: string[] = [];
      const dsl = graph.dataInterestsDSL || '';
      for (const m of dsl.matchAll(/context\(([^):]+)/g)) {
        contextKeys.push(m[1]);
      }
      if (edge.query) {
        for (const m of edge.query.matchAll(/context\(([^):]+)/g)) {
          contextKeys.push(m[1]);
        }
      }

      const connectionName = edge.p?.connection || graph?.defaultConnection || 'amplitude';
      const signature = await computeQuerySignature(
        { context: contextKeys.map(k => ({ key: k })), event_filters: {}, case: [] },
        connectionName,
        graph,
        edge,
        [...new Set(contextKeys)].sort(),
        workspace,
        eventDefs,
      );

      return computeShortCoreHash(signature);
    } catch (err) {
      console.warn(`[CommitHashGuard] Failed to compute new hash for edge ${edge.id}:`, err);
      return null;
    }
  }

  /**
   * Load all event definitions from IDB for the workspace.
   */
  private async loadEventDefinitions(
    workspace: { repository: string; branch: string },
  ): Promise<Record<string, any>> {
    const defs: Record<string, any> = {};
    try {
      const eventFiles = await db.files.where('type').equals('event').toArray();
      const scoped = eventFiles.filter(f =>
        f.source?.repository === workspace.repository &&
        f.source?.branch === workspace.branch
      );
      for (const f of scoped) {
        const data = f.data as any;
        if (data?.id) {
          defs[data.id] = data;
        }
      }
    } catch (err) {
      console.warn('[CommitHashGuard] Failed to load event definitions:', err);
    }
    return defs;
  }
}

export const commitHashGuardService = new CommitHashGuardService();
