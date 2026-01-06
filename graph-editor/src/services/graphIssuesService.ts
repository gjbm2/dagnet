/**
 * Graph Issues Service
 * 
 * Provides a reactive, debounced integrity check for the workspace.
 * Automatically re-runs validation when files change, updating subscribers.
 * 
 * Pattern: Similar to sessionLogService but for integrity issues.
 */

import { IntegrityCheckService } from './integrityCheckService';
import { fileRegistry } from '../contexts/TabContext';
import type { ObjectType, TabState } from '../types';
import { formatIssuesForClipboard } from './graphIssuesClipboardExport';
import { sessionLogService } from './sessionLogService';

type IssueSeverity = 'error' | 'warning' | 'info';

type IssueCategory = 
  | 'schema'
  | 'id-format'
  | 'reference'
  | 'graph-structure'
  | 'registry'
  | 'connection'
  | 'credentials'
  | 'value'
  | 'semantic'
  | 'orphan'
  | 'duplicate'
  | 'naming'
  | 'metadata'
  | 'sync'
  | 'image';

export interface GraphIssue {
  id: string;
  fileId: string;
  type: ObjectType | 'system';
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  field?: string;
  suggestion?: string;
  details?: string;
  // Deep linking: node/edge identifiers for graph issues
  nodeUuid?: string;
  edgeUuid?: string;
}

export interface IssuesSummary {
  errors: number;
  warnings: number;
  info: number;
  byCategory: Record<IssueCategory, number>;
}

export interface GraphIssuesState {
  issues: GraphIssue[];
  summary: IssuesSummary;
  totalFiles: number;
  lastUpdated: Date | null;
  isLoading: boolean;
  error: string | null;
}

type Subscriber = (state: GraphIssuesState) => void;

const DEBOUNCE_MS = 2000;
const FILE_ID = 'graph-issues';
const SELECT_GRAPH_EVENT = 'dagnet:graphIssuesSelectGraph';

class GraphIssuesService {
  private state: GraphIssuesState = {
    issues: [],
    summary: {
      errors: 0,
      warnings: 0,
      info: 0,
      byCategory: {} as Record<IssueCategory, number>
    },
    totalFiles: 0,
    lastUpdated: null,
    isLoading: false,
    error: null
  };
  
  private subscribers: Set<Subscriber> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isInitialised = false;
  private periodicCheckInterval: ReturnType<typeof setInterval> | null = null;
  private pendingGraphSelectionByTabId = new Map<string, { graphName: string; t0: number }>();

  private findGraphFileByName(graphName: string): { fileId: string; data: any } | null {
    const allFiles = fileRegistry.getAllFiles();

    // Prefer loaded graph files with data.
    for (const file of allFiles) {
      if (!file?.fileId) continue;
      if (!file.fileId.includes('graph-')) continue;
      const name = this.extractGraphName(file.fileId);
      if (name !== graphName) continue;
      if (!file.data) continue;
      return { fileId: file.fileId, data: file.data };
    }

    // If we can't find the file data, still return a matching fileId if present (toggle may be disabled upstream).
    for (const file of allFiles) {
      if (!file?.fileId) continue;
      if (!file.fileId.includes('graph-')) continue;
      const name = this.extractGraphName(file.fileId);
      if (name !== graphName) continue;
      return { fileId: file.fileId, data: file.data };
    }

    return null;
  }
  
  /**
   * Initialise the service (called lazily on first subscription or tab open)
   */
  private initialise(): void {
    if (this.isInitialised) return;
    this.isInitialised = true;
    
    // Set up periodic check (every 30s as fallback)
    this.periodicCheckInterval = setInterval(() => {
      // Only run if we have subscribers (tab is open)
      if (this.subscribers.size > 0) {
        this.scheduleCheck();
      }
    }, 30000);
    
    console.log('[GraphIssuesService] Initialised');
  }
  
  /**
   * Schedule a debounced integrity check
   */
  scheduleCheck(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.runCheck();
    }, DEBOUNCE_MS);
  }
  
  /**
   * Force an immediate check (bypasses debounce)
   */
  async forceCheck(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.runCheck();
  }
  
  /**
   * Run the integrity check
   */
  private async runCheck(): Promise<void> {
    // Update loading state
    this.state = { ...this.state, isLoading: true, error: null };
    this.notifySubscribers();

    let opId: string | null = null;
    try {
      opId = sessionLogService.startOperation('info', 'integrity', 'GRAPH_ISSUES_CHECK', 'Running graph integrity check');
      const startTime = performance.now();
      
      // Run integrity check with a mock tabOperations (we don't need tab opening here)
      const mockTabOps = {
        tabs: [],
        openFile: async () => {},
        setActiveTab: () => {},
        closeTab: () => {}
      };
      
      const result = await IntegrityCheckService.checkIntegrity(mockTabOps as any, false);
      
      const elapsed = performance.now() - startTime;
      console.log(`[GraphIssuesService] Check completed in ${elapsed.toFixed(0)}ms: ${result.issues.length} issues`);
      sessionLogService.endOperation(opId, 'success', `Integrity check complete (${result.issues.length} issues)`);
      
      // Convert to our issue format with unique IDs
      const issues: GraphIssue[] = result.issues.map((issue, idx) => ({
        id: `issue-${Date.now()}-${idx}`,
        fileId: issue.fileId,
        type: issue.type,
        severity: issue.severity,
        category: issue.category,
        message: issue.message,
        field: issue.field,
        suggestion: issue.suggestion,
        details: issue.details,
        nodeUuid: issue.nodeUuid,
        edgeUuid: issue.edgeUuid
      }));
      
      this.state = {
        issues,
        summary: result.summary,
        totalFiles: result.totalFiles,
        lastUpdated: new Date(),
        isLoading: false,
        error: null
      };
      
    } catch (error) {
      console.error('[GraphIssuesService] Check failed:', error);
      if (opId) {
        try {
          sessionLogService.endOperation(opId, 'error', 'Integrity check failed');
        } catch {
          // Ignore
        }
      }
      try {
        sessionLogService.error('integrity', 'GRAPH_ISSUES_CHECK_ERROR', `Integrity check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } catch {
        // Never fail the check due to logging issues.
      }
      this.state = {
        ...this.state,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
    
    this.notifySubscribers();
  }
  
  /**
   * Subscribe to state changes
   */
  subscribe(callback: Subscriber): () => void {
    // Initialise service on first subscription
    this.initialise();
    
    this.subscribers.add(callback);
    
    // Immediately call with current state
    callback(this.state);
    
    // If this is first subscriber, trigger a check
    if (this.subscribers.size === 1 && this.state.lastUpdated === null) {
      this.scheduleCheck();
    }
    
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Public helper: extract clean graph name from a (possibly workspace-prefixed) fileId.
   */
  getGraphNameFromFileId(fileId: string): string | null {
    return this.extractGraphName(fileId);
  }

  /**
   * Compute severity counts for a specific graph, optionally including referenced files.
   */
  getSeverityCountsForGraph(options: { graphName: string; includeReferencedFiles?: boolean }): { errors: number; warnings: number; info: number; total: number } {
    const issues = this.getFilteredIssues({
      graphFilter: options.graphName,
      includeReferencedFiles: options.includeReferencedFiles !== false,
      severities: ['error', 'warning', 'info'],
    });

    let errors = 0;
    let warnings = 0;
    let info = 0;
    for (const issue of issues) {
      if (issue.severity === 'error') errors++;
      else if (issue.severity === 'warning') warnings++;
      else info++;
    }
    return { errors, warnings, info, total: issues.length };
  }

  /**
   * Get issues for a graph filtered by severity, optionally including referenced files.
   */
  getIssuesForGraphSeverity(options: { graphName: string; severity: IssueSeverity; includeReferencedFiles?: boolean }): GraphIssue[] {
    return this.getFilteredIssues({
      graphFilter: options.graphName,
      includeReferencedFiles: options.includeReferencedFiles !== false,
      severities: [options.severity],
    });
  }

  /**
   * Build tooltip text (multiline) listing issues for a graph + severity.
   */
  getSeverityTooltipText(options: {
    graphName: string;
    severity: IssueSeverity;
    includeReferencedFiles?: boolean;
    maxItems?: number;
  }): string {
    const maxItems = options.maxItems ?? 10;
    const issues = this.getIssuesForGraphSeverity({
      graphName: options.graphName,
      severity: options.severity,
      includeReferencedFiles: options.includeReferencedFiles,
    });

    const label = options.severity === 'error' ? 'Errors' : options.severity === 'warning' ? 'Warnings' : 'Info';
    if (issues.length === 0) return `${label}: none`;

    const lines: string[] = [];
    lines.push(`${label} (${issues.length}):`);

    const shown = issues.slice(0, Math.max(0, maxItems));
    for (const issue of shown) {
      // Keep it compact for native tooltips.
      const where = issue.fileId;
      lines.push(`- ${where}: ${issue.message}`);
    }
    if (issues.length > shown.length) {
      lines.push(`… +${issues.length - shown.length} more`);
    }

    return lines.join('\n');
  }

  /**
   * Get the current `debugging` flag for a graph (best-effort; returns null if the graph file isn't loaded).
   */
  getGraphDebugging(graphName: string): boolean | null {
    const match = this.findGraphFileByName(graphName);
    if (!match?.data) return null;
    return !!(match.data as any).debugging;
  }

  /**
   * Set the `debugging` flag for a graph (requires the graph file to be loaded in FileRegistry).
   */
  async setGraphDebugging(graphName: string, enabled: boolean): Promise<{ success: boolean; reason?: string }> {
    const match = this.findGraphFileByName(graphName);
    if (!match) return { success: false, reason: `Graph "${graphName}" not found in workspace` };
    if (!match.data) return { success: false, reason: `Graph "${graphName}" is not loaded (open it to edit)` };

    const opId = sessionLogService.startOperation('info', 'file', 'GRAPH_SET_DEBUGGING', `Setting debugging=${enabled} for graph ${graphName}`);
    try {
      const next = { ...(match.data as any), debugging: enabled };
      await fileRegistry.updateFile(match.fileId, next);
      sessionLogService.endOperation(opId, 'success', `Updated graph ${graphName} debugging=${enabled}`);
      return { success: true };
    } catch (error) {
      sessionLogService.endOperation(opId, 'error', `Failed to update graph ${graphName} debugging flag`);
      return { success: false, reason: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
  
  /**
   * Get current state
   */
  getState(): GraphIssuesState {
    return this.state;
  }

  exportIssuesForClipboard(args: {
    issues: GraphIssue[];
    context?: {
      searchTerm?: string;
      graphFilter?: string;
      includeReferencedFiles?: boolean;
      severities?: IssueSeverity[];
      categories?: IssueCategory[];
    };
  }): string {
    return formatIssuesForClipboard({
      issues: args.issues,
      context: { ...args.context, generatedAt: new Date().toISOString() },
    });
  }
  
  /**
   * Get issues filtered by criteria
   */
  getFilteredIssues(options: {
    searchTerm?: string;
    graphFilter?: string;
    includeReferencedFiles?: boolean;
    severities?: IssueSeverity[];
    categories?: IssueCategory[];
  }): GraphIssue[] {
    let filtered = this.state.issues;
    
    // Filter by search term
    if (options.searchTerm) {
      const term = options.searchTerm.toLowerCase();
      filtered = filtered.filter(issue =>
        issue.message.toLowerCase().includes(term) ||
        issue.fileId.toLowerCase().includes(term) ||
        issue.field?.toLowerCase().includes(term) ||
        issue.details?.toLowerCase().includes(term)
      );
    }
    
    // Filter by graph (match extracted graph name)
    if (options.graphFilter) {
      const graphName = options.graphFilter;
      
      // Get the set of allowed file IDs
      const allowedFileIds = new Set<string>();
      
      // Always include the graph itself
      for (const issue of this.state.issues) {
        const issueGraphName = this.extractGraphName(issue.fileId);
        if (issueGraphName === graphName) {
          allowedFileIds.add(issue.fileId);
        }
      }
      
      // If including referenced files, find and add them
      if (options.includeReferencedFiles !== false) {
        const referencedIds = this.getReferencedFileIds(graphName);
        for (const refId of referencedIds) {
          // Match against issues that contain this reference ID
          for (const issue of this.state.issues) {
            if (issue.fileId.includes(refId)) {
              allowedFileIds.add(issue.fileId);
            }
          }
        }
      }
      
      filtered = filtered.filter(issue => allowedFileIds.has(issue.fileId));
    }
    
    // Filter by severity
    if (options.severities && options.severities.length > 0) {
      filtered = filtered.filter(issue => options.severities!.includes(issue.severity));
    }
    
    // Filter by category
    if (options.categories) {
      // IMPORTANT: Explicit empty selection means "show none" (not "no filter").
      if (options.categories.length === 0) return [];
      filtered = filtered.filter(issue => options.categories!.includes(issue.category));
    }
    
    return filtered;
  }
  
  /**
   * Get file IDs referenced by a graph (events, cases, parameters, contexts, nodes).
   */
  private getReferencedFileIds(graphName: string): Set<string> {
    const referenced = new Set<string>();
    
    // Try to get graph data from fileRegistry
    const graphFileId = `graph-${graphName}`;
    const graphFile = fileRegistry.getFile(graphFileId);
    
    if (!graphFile?.data) {
      // Also try with workspace prefix pattern
      const allFiles = fileRegistry.getAllFiles();
      for (const file of allFiles) {
        if (file.fileId.includes(`graph-${graphName}`) && file.data) {
          this.extractReferencesFromGraph(file.data, referenced);
          break;
        }
      }
    } else {
      this.extractReferencesFromGraph(graphFile.data, referenced);
    }
    
    return referenced;
  }
  
  /**
   * Extract all file references from a graph's data.
   */
  private extractReferencesFromGraph(graphData: any, referenced: Set<string>): void {
    const nodes = graphData.nodes || [];
    const edges = graphData.edges || [];
    
    // Extract node references
    for (const node of nodes) {
      if (node.event_id) {
        referenced.add(`event-${node.event_id}`);
      }
      if (node.case?.id) {
        referenced.add(`case-${node.case.id}`);
      }
      if (node.context?.id) {
        referenced.add(`context-${node.context.id}`);
      }
      // Node file reference (if it references an external node file)
      if (node.node_id) {
        referenced.add(`node-${node.node_id}`);
      }
    }
    
    // Extract edge references
    for (const edge of edges) {
      if (edge.p?.id) {
        referenced.add(`parameter-${edge.p.id}`);
      }
      if (edge.cost_gbp?.id) {
        referenced.add(`parameter-${edge.cost_gbp.id}`);
      }
      if (edge.labour_cost?.id) {
        referenced.add(`parameter-${edge.labour_cost.id}`);
      }
    }
  }
  
  /**
   * Extract clean graph name from fileId, stripping workspace prefix if present.
   * FileId formats:
   * - "graph-myname" → "myname"
   * - "repo-branch-graph-myname" → "myname"
   */
  private extractGraphName(fileId: string): string | null {
    // Look for 'graph-' anywhere in the fileId
    const graphIdx = fileId.indexOf('graph-');
    if (graphIdx === -1) return null;
    
    // Extract everything after 'graph-'
    return fileId.substring(graphIdx + 6);
  }
  
  /**
   * Get unique graph names from issues for filter dropdown.
   * Returns clean names without workspace prefixes.
   */
  getGraphNames(options?: { includeWorkspaceGraphs?: boolean }): string[] {
    const graphSet = new Set<string>();
    
    const includeWorkspaceGraphs = options?.includeWorkspaceGraphs !== false;
    
    for (const issue of this.state.issues) {
      if (issue.type === 'graph' || issue.fileId.includes('graph-')) {
        const name = this.extractGraphName(issue.fileId);
        if (name) {
          graphSet.add(name);
        }
      }
    }

    // Also include all graph files present in the workspace (even if there are currently only
    // info issues on referenced files, or no issues at all for the graph file itself).
    if (includeWorkspaceGraphs) {
      const allFiles = fileRegistry.getAllFiles();
      for (const file of allFiles) {
        if (!file?.fileId) continue;
        if (!file.fileId.includes('graph-')) continue;
        const name = this.extractGraphName(file.fileId);
        if (name) {
          graphSet.add(name);
        }
      }
    }
    
    return Array.from(graphSet).sort();
  }
  
  /**
   * Open the issues tab
   */
  async openIssuesTab(): Promise<string | null> {
    try {
      const timestamp = Date.now();
      
      // Create or update the file in fileRegistry
      const existingFile = fileRegistry.getFile(FILE_ID);
      
      if (!existingFile) {
        // Create file in registry with 'issues' type
        await fileRegistry.getOrCreateFile(
          FILE_ID,
          'issues' as any,
          {
            repository: 'temporary',
            path: 'graph-issues',
            branch: 'main'
          },
          { issues: this.state.issues }
        );
      }
      
      // Check if tab already exists
      const file = fileRegistry.getFile(FILE_ID);
      if (file && file.viewTabs && file.viewTabs.length > 0) {
        // Tab exists, dispatch event to switch to it
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { 
          detail: { tabId: file.viewTabs[0] } 
        }));
        return file.viewTabs[0];
      }
      
      // Create tab
      const tabId = `tab-graph-issues-${timestamp}`;
      
      const newTab: TabState = {
        id: tabId,
        fileId: FILE_ID,
        viewMode: 'interactive',
        title: 'Graph Issues',
        icon: '',
        closable: true,
        group: 'main-content'
      };
      
      // Add to registry
      await fileRegistry.addViewTab(FILE_ID, tabId);
      
      // Dispatch event for TabContext to handle
      window.dispatchEvent(new CustomEvent('dagnet:openTemporaryTab', { 
        detail: { tab: newTab } 
      }));
      
      // Initialise service if not already
      this.initialise();
      
      // Trigger initial check
      this.scheduleCheck();
      
      return tabId;
    } catch (error) {
      console.error('[GraphIssuesService] Failed to open issues tab:', error);
      return null;
    }
  }

  /**
   * Open the issues tab and select a specific graph in the dropdown.
   * This is the single, shared code path for "open issues for graph" UX affordances.
   */
  async openIssuesTabForGraph(graphName: string): Promise<string | null> {
    const tabId = await this.openIssuesTab();
    if (!tabId) return null;

    this.pendingGraphSelectionByTabId.set(tabId, { graphName, t0: Date.now() });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SELECT_GRAPH_EVENT, { detail: { tabId, graphName } }));
    }
    return tabId;
  }

  /**
   * If a graph selection was requested before the Issues tab mounted, the viewer can pull it on mount.
   */
  getPendingGraphSelection(tabId: string): string | null {
    return this.pendingGraphSelectionByTabId.get(tabId)?.graphName ?? null;
  }

  clearPendingGraphSelection(tabId: string): void {
    this.pendingGraphSelectionByTabId.delete(tabId);
  }
  
  /**
   * Notify all subscribers of state change
   */
  private notifySubscribers(): void {
    for (const callback of this.subscribers) {
      try {
        callback(this.state);
      } catch (error) {
        console.error('[GraphIssuesService] Subscriber error:', error);
      }
    }
  }
  
  /**
   * Cleanup
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.periodicCheckInterval) {
      clearInterval(this.periodicCheckInterval);
    }
    this.subscribers.clear();
    this.isInitialised = false;
  }
}

// Singleton export
export const graphIssuesService = new GraphIssuesService();

// Debug exposure for console access
if (typeof window !== 'undefined') {
  (window as any).graphIssuesService = graphIssuesService;
}

