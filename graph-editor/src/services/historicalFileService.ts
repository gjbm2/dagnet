/**
 * Historical File Service
 *
 * Reusable service for viewing historical versions of files from git.
 * Works for all file types (graphs, parameters, cases, events, nodes, contexts).
 *
 * User flow:
 *   1. User triggers "Open Historical Version" (via @ icon on navigator hover, or context menu)
 *   2. Service fetches git commit dates for the file
 *   3. Calendar picker shows dates with commits highlighted
 *   4. User clicks a date → service opens a temporary tab with the file at that commit
 *   5. Tab title uses .asat() DSL convention: e.g., "conversion-flow.asat(10-Jan-25)"
 *   6. On tab close, the temporary file is cleaned up from IDB
 */

import { fileRegistry } from '../contexts/TabContext';
import { gitService } from './gitService';
import { credentialsManager } from '../lib/credentials';
import { sessionLogService } from './sessionLogService';
import { formatDateUK } from '../lib/dateFormat';
import type { TabState, ObjectType } from '../types';

export interface HistoricalCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;       // ISO date-time string from git
  dateISO: string;     // Just the date portion: YYYY-MM-DD (for calendar grouping)
  dateUK: string;      // d-MMM-yy format (for display / tab title)
}

/**
 * Map of ISO date string (YYYY-MM-DD) → commits on that date.
 * Used by the calendar picker to highlight dates and to handle multiple commits per day.
 */
export type CommitDateMap = Map<string, HistoricalCommit[]>;

class HistoricalFileService {
  private static instance: HistoricalFileService;

  static getInstance(): HistoricalFileService {
    if (!HistoricalFileService.instance) {
      HistoricalFileService.instance = new HistoricalFileService();
    }
    return HistoricalFileService.instance;
  }

  /**
   * Check whether a file can have historical versions opened.
   * Requires a git path, not local-only, and has been synced (has a SHA).
   */
  canOpenHistorical(fileId: string): boolean {
    const file = fileRegistry.getFile(fileId);
    if (!file) {
      console.log(`[HistoricalFileService.canOpenHistorical] ${fileId} → false (file not in registry)`);
      return false;
    }
    const result = !!(file.source?.path && !file.isLocal && file.sha);
    if (!result) {
      console.log(`[HistoricalFileService.canOpenHistorical] ${fileId} → false`, {
        hasPath: !!file.source?.path,
        isLocal: file.isLocal,
        hasSha: !!file.sha,
      });
    }
    return result;
  }

  /**
   * Set up git credentials for the given repository.
   * Mirrors the pattern from useViewHistory.ts.
   */
  async setupCredentials(selectedRepo: string): Promise<boolean> {
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success || !credsResult.credentials) {
      console.error('[HistoricalFileService] No credentials available');
      return false;
    }

    const gitCreds = credsResult.credentials.git?.find(
      (g: any) => g.name === selectedRepo
    );

    if (!gitCreds) {
      console.error(`[HistoricalFileService] Repository "${selectedRepo}" not found in credentials`);
      return false;
    }

    const fullCredentials = {
      git: [gitCreds],
      defaultGitRepo: selectedRepo,
    };
    gitService.setCredentials(fullCredentials);
    return true;
  }

  /**
   * Fetch commit history for a file and return a date-grouped map.
   *
   * @param fileId - the file ID (e.g., "graph-my-graph")
   * @param selectedRepo - current repo name from NavigatorContext
   * @param selectedBranch - current branch from NavigatorContext
   * @returns CommitDateMap keyed by ISO date (YYYY-MM-DD)
   */
  async getCommitDates(
    fileId: string,
    selectedRepo: string,
    selectedBranch: string,
  ): Promise<CommitDateMap> {
    const file = fileRegistry.getFile(fileId);
    if (!file?.source?.path) {
      console.error('[HistoricalFileService] File has no remote path:', fileId);
      return new Map();
    }

    const filePath = file.source.path;

    // Ensure credentials are configured
    const credsOk = await this.setupCredentials(selectedRepo);
    if (!credsOk) return new Map();

    sessionLogService.info(
      'git',
      'HISTORICAL_LOAD_DATES',
      `Loading commit dates for ${fileId}`,
      undefined,
      { fileId, filePath },
    );

    const result = await gitService.getFileHistory(filePath, selectedBranch);
    if (!result.success || !result.data) {
      sessionLogService.error(
        'git',
        'HISTORICAL_LOAD_DATES_ERROR',
        `Failed to load commit dates for ${fileId}: ${result.error || 'unknown'}`,
      );
      return new Map();
    }

    const commits: any[] = result.data;
    const dateMap: CommitDateMap = new Map();

    for (const commit of commits) {
      const commitData = commit.commit || commit;
      const rawDate = commitData.author?.date || commitData.committer?.date || '';
      if (!rawDate) continue;

      const d = new Date(rawDate);
      if (isNaN(d.getTime())) continue;

      const isoDate = d.toISOString().split('T')[0]; // YYYY-MM-DD

      const entry: HistoricalCommit = {
        sha: commit.sha,
        shortSha: commit.sha.substring(0, 7),
        message: (commitData.message || 'No message').split('\n')[0],
        author: commitData.author?.name || commit.author?.login || 'Unknown',
        date: rawDate,
        dateISO: isoDate,
        dateUK: formatDateUK(d),
      };

      const existing = dateMap.get(isoDate);
      if (existing) {
        existing.push(entry);
      } else {
        dateMap.set(isoDate, [entry]);
      }
    }

    sessionLogService.success(
      'git',
      'HISTORICAL_LOAD_DATES_OK',
      `Loaded ${commits.length} commits across ${dateMap.size} dates for ${fileId}`,
    );

    return dateMap;
  }

  /**
   * Fetch and parse a file's content at a specific git commit.
   *
   * @returns parsed data (JSON object for graphs, YAML-parsed object for others)
   */
  async getFileAtCommit(
    fileId: string,
    commitSha: string,
    selectedRepo: string,
  ): Promise<{ data: any; rawContent: string } | null> {
    const file = fileRegistry.getFile(fileId);
    if (!file?.source?.path) return null;

    const filePath = file.source.path;

    // Ensure credentials
    const credsOk = await this.setupCredentials(selectedRepo);
    if (!credsOk) return null;

    const result = await gitService.getFile(filePath, commitSha);
    if (!result.success || !result.data) {
      console.error(`[HistoricalFileService] Failed to fetch ${filePath} at ${commitSha}:`, result.error);
      return null;
    }

    // Decode base64 content
    const gitFile = result.data;
    let rawContent: string;
    if (gitFile.content && gitFile.encoding === 'base64') {
      // Use fetch data-URL approach for proper UTF-8 decoding (same as gitService.getBlobContent)
      try {
        const base64 = gitFile.content.replace(/[\s\r\n]/g, '');
        const response = await fetch(`data:text/plain;base64,${base64}`);
        rawContent = await response.text();
      } catch {
        rawContent = atob(gitFile.content);
      }
    } else {
      rawContent = gitFile.content || '';
    }

    // Parse based on file type
    let data: any;
    try {
      if (file.type === 'graph') {
        data = JSON.parse(rawContent);
      } else {
        const yaml = await import('yaml');
        data = yaml.parse(rawContent);
      }
    } catch (parseError) {
      console.error(`[HistoricalFileService] Failed to parse ${filePath} at ${commitSha}:`, parseError);
      return null;
    }

    return { data, rawContent };
  }

  /**
   * Open a historical version of a file as a temporary tab.
   *
   * The tab title uses the .asat() DSL convention: e.g., "conversion-flow.asat(10-Jan-25)".
   * The file is created with repository: 'temporary' and auto-cleaned on tab close.
   *
   * @param fileId - original file ID (e.g., "graph-my-graph")
   * @param commit - the historical commit to open
   * @param selectedRepo - current repo name
   * @returns tab ID if successful, null on failure
   */
  async openHistoricalVersion(
    fileId: string,
    commit: HistoricalCommit,
    selectedRepo: string,
  ): Promise<string | null> {
    const file = fileRegistry.getFile(fileId);
    if (!file) {
      console.error('[HistoricalFileService] File not found:', fileId);
      return null;
    }

    sessionLogService.info(
      'git',
      'HISTORICAL_OPEN',
      `Opening historical version of ${fileId} at ${commit.shortSha} (${commit.dateUK})`,
      undefined,
      { fileId, commitSha: commit.sha, dateUK: commit.dateUK },
    );

    // Fetch and parse the file at the commit
    const result = await this.getFileAtCommit(fileId, commit.sha, selectedRepo);
    if (!result) {
      sessionLogService.error(
        'git',
        'HISTORICAL_OPEN_ERROR',
        `Failed to open historical version of ${fileId} at ${commit.shortSha}`,
      );
      return null;
    }

    // Build the display name and temporary file ID
    const displayName = file.name || fileId.replace(/^(graph|parameter|case|event|node|context)-/, '');
    const tabTitle = `${displayName}.asat(${commit.dateUK})`;
    const tempFileId = `temp-historical-${file.type}-${displayName}-${commit.shortSha}`;

    // Check if this exact historical version is already open
    const existingFile = fileRegistry.getFile(tempFileId);
    if (existingFile) {
      const viewTabs = (existingFile as any).viewTabs;
      if (Array.isArray(viewTabs) && viewTabs.length > 0) {
        // Switch to existing tab
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId: viewTabs[0] } }));
        return viewTabs[0];
      }
    }

    // Create temporary file in fileRegistry
    await fileRegistry.getOrCreateFile(
      tempFileId,
      file.type as ObjectType,
      { repository: 'temporary', path: file.source?.path || '', branch: '' },
      result.data,
    );

    // Create and open the tab
    const timestamp = Date.now();
    const tabId = `tab-historical-${commit.shortSha}-${timestamp}`;

    // For graph files, include the standard default editorState so that
    // the graph opens with the current layer visible and all panels initialised.
    const defaultGraphEditorState = file.type === 'graph' ? {
      useUniformScaling: false,
      massGenerosity: 0.5,
      autoReroute: true,
      useSankeyView: false,
      sidebarOpen: true,
      whatIfOpen: false,
      propertiesOpen: true,
      jsonOpen: false,
      selectedNodeId: null,
      selectedEdgeId: null,
      scenarioState: {
        scenarioOrder: ['current'],
        visibleScenarioIds: ['current'],
        visibleColourOrderIds: ['current'],
        selectedScenarioId: undefined,
      },
    } : undefined;

    const newTab: TabState = {
      id: tabId,
      fileId: tempFileId,
      viewMode: 'interactive',
      title: tabTitle,
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: defaultGraphEditorState,
    };

    await fileRegistry.addViewTab(tempFileId, tabId);
    window.dispatchEvent(new CustomEvent('dagnet:openTemporaryTab', { detail: { tab: newTab } }));

    sessionLogService.success(
      'git',
      'HISTORICAL_OPEN_OK',
      `Opened ${tabTitle} (${commit.shortSha})`,
      undefined,
      { fileId, tempFileId, tabId, commitSha: commit.sha },
    );

    return tabId;
  }

  /**
   * Find the commit closest to (but not after) a given ISO date-time string.
   * Useful for the Signature Links viewer which needs "the graph as it was at created_at_min".
   *
   * @param commitDates - a CommitDateMap from getCommitDates()
   * @param targetDateTime - ISO date-time string (e.g., "2025-01-15T10:30:00Z")
   * @returns the closest commit, or null if no commits exist
   */
  findCommitAtOrBefore(commitDates: CommitDateMap, targetDateTime: string): HistoricalCommit | null {
    const target = new Date(targetDateTime).getTime();
    if (isNaN(target)) return null;

    let best: HistoricalCommit | null = null;
    let bestDiff = Infinity;

    for (const commits of commitDates.values()) {
      for (const commit of commits) {
        const commitTime = new Date(commit.date).getTime();
        if (isNaN(commitTime)) continue;

        // Only consider commits at or before the target
        if (commitTime <= target) {
          const diff = target - commitTime;
          if (diff < bestDiff) {
            bestDiff = diff;
            best = commit;
          }
        }
      }
    }

    return best;
  }
}

export const historicalFileService = HistoricalFileService.getInstance();
