/**
 * Session Log Service
 * 
 * Provides session-wide logging for user-facing operations with HIERARCHICAL support.
 * 
 * Key features:
 * - Composite operations (MSMDC, bulk updates, git ops) with expandable children
 * - Structured context data per operation type
 * - Auto-expand on warnings/errors
 * - Search/filter across all levels
 * 
 * This is NOT a console/debug log. It's designed for users to:
 * - Track what operations were attempted
 * - See what succeeded or failed  
 * - Drill into details of composite operations
 * - Debug data flow issues
 */

import { fileRegistry } from '../contexts/TabContext';
import type { TabState } from '../types';
import { DIAGNOSTIC_LOG as DIAGNOSTIC_LOG_DEFAULT } from '../constants/latency';
import { db } from '../db/appDatabase';

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export type OperationType = 
  | 'session'
  | 'git'
  | 'file'
  | 'workspace'
  | 'msmdc'
  | 'data-fetch'
  | 'data-update'
  | 'graph'
  | 'index'
  | 'merge'
  | 'integrity'
  | 'amplitude'
  | 'bayes';

/**
 * Structured context for different operation types
 */
export interface OperationContext {
  // Common fields
  duration?: number;
  
  // Git operations
  repository?: string;
  branch?: string;
  filesAffected?: string[];
  conflicts?: string[];
  
  // MSMDC operations
  parametersGenerated?: Array<{
    paramId: string;
    query: string;
    location: string;
    changed: boolean;
  }>;
  nodesAffected?: string[];
  edgesAffected?: string[];
  
  // Data operations
  sourceType?: string;
  sourceId?: string;
  targetId?: string;
  valuesBefore?: Record<string, any>;
  valuesAfter?: Record<string, any>;
  rowCount?: number;
  
  // File operations
  fileId?: string;
  filePath?: string;
  fileType?: string;
  
  // Index operations
  added?: number;
  updated?: number;
  skipped?: number;
  errors?: number;
  
  // Generic key-value for extensibility
  [key: string]: any;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  category: OperationType;
  operation: string;
  message: string;
  details?: string;
  context?: OperationContext;
  
  // Hierarchy
  parentId?: string;
  children?: LogEntry[];
  
  // UI state
  expanded?: boolean;
}

interface ActiveOperation {
  entry: LogEntry;
  startTime: number;
}

/**
 * Options for log calls that support diagnostic gating.
 * When diagnostic logging is off:
 *
 *  `diagnostic: true` — the entire operation (parent + children) is buffered.
 *    If any child is a warning/error, the whole tree is promoted to the real log.
 *    Otherwise it is silently discarded at endOperation.
 *
 *  `diagnosticChildren: true` — the parent is logged normally (always visible),
 *    but its children are buffered. If a warning/error child arrives, all buffered
 *    siblings are flushed so the user sees full context around the problem.
 *    Otherwise children are quietly discarded at endOperation.
 *    Use this for per-item completion records where the parent is meaningful
 *    but the detail children are noise.
 *
 *  Standalone calls (info/success) with `diagnostic: true` are silently dropped.
 *  Warnings and errors are NEVER suppressed regardless of these flags.
 */
export interface DiagnosticOptions {
  diagnostic?: boolean;
  diagnosticChildren?: boolean;
}

interface DiagnosticBuffer {
  entry: LogEntry;
  startTime: number;
  promoted: boolean;
}

class SessionLogService {
  private static instance: SessionLogService;
  private entries: LogEntry[] = [];
  private entriesById: Map<string, LogEntry> = new Map();
  private activeOperations: Map<string, ActiveOperation> = new Map();
  private diagnosticBuffers: Map<string, DiagnosticBuffer> = new Map();
  private fileId = 'session-log';
  private listeners: Set<(entries: LogEntry[]) => void> = new Set();
  private settingsListeners: Set<() => void> = new Set();
  private isInitialized = false;
  private operationCounter = 0;
  private diagnosticLoggingEnabled = DIAGNOSTIC_LOG_DEFAULT;

  private constructor() {}

  static getInstance(): SessionLogService {
    if (!SessionLogService.instance) {
      SessionLogService.instance = new SessionLogService();
    }
    return SessionLogService.instance;
  }

  /**
   * Initialize the session log service
   * Called early in app startup
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    this.isInitialized = true;
    // IMPORTANT:
    // In React, child useEffect() hooks can run before parent useEffect() hooks.
    // Live share boot (and other early flows) can legitimately emit session logs before
    // AppShell has a chance to call initialize(). We must NEVER wipe those pre-init logs.
    //
    // If there are no pre-init entries, we start with a clean slate.
    const hasPreInitEntries =
      this.entries.length > 0 || this.entriesById.size > 0 || this.activeOperations.size > 0;
    if (!hasPreInitEntries) {
      this.entries = [];
      this.entriesById.clear();
      this.activeOperations.clear();
    }
    
    // Log initialization
    this.log('info', 'session', 'SESSION_START', 'Session started', 
      `DagNet v${(import.meta as any).env?.VITE_APP_VERSION || '0.9x'}`);
    
    console.log('[SessionLogService] Initialized');
  }

  /**
   * Runtime control: whether verbose diagnostic data should be included in session logs.
   * Defaults from constants/latency.ts but can be toggled via UI.
   */
  getDiagnosticLoggingEnabled(): boolean {
    return this.diagnosticLoggingEnabled;
  }

  setDiagnosticLoggingEnabled(enabled: boolean): void {
    const next = !!enabled;
    if (this.diagnosticLoggingEnabled === next) return;
    this.diagnosticLoggingEnabled = next;
    this.notifySettingsListeners();
  }

  subscribeSettings(listener: () => void): () => void {
    this.settingsListeners.add(listener);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  private notifySettingsListeners(): void {
    for (const l of this.settingsListeners) {
      try {
        l();
      } catch (e) {
        console.warn('[SessionLogService] settings listener threw:', e);
      }
    }
  }

  private generateId(): string {
    return `log-${Date.now()}-${++this.operationCounter}`;
  }

  /**
   * Start a composite operation that will have children
   * Returns operation ID to use with addChild() and endOperation()
   *
   * When `options.diagnostic` is true and diagnostic logging is off, the operation
   * is buffered in memory rather than written to the log. If any child warning/error
   * arrives, the entire operation (with all children) is promoted to the real log.
   * Otherwise it is silently discarded at endOperation().
   */
  startOperation(
    level: LogLevel,
    category: OperationType,
    operation: string,
    message: string,
    context?: OperationContext,
    options?: DiagnosticOptions
  ): string {
    const id = this.generateId();

    const entry: LogEntry = {
      id,
      timestamp: new Date(),
      level,
      category,
      operation,
      message,
      context,
      children: [],
      expanded: level === 'warning' || level === 'error' // Auto-expand warnings/errors
    };

    // Buffer diagnostic operations when diagnostic logging is off
    // (warnings/errors are never buffered)
    if (!this.diagnosticLoggingEnabled && level !== 'warning' && level !== 'error') {
      if (options?.diagnostic) {
        // Fully buffered — parent + children suppressed unless promoted
        this.diagnosticBuffers.set(id, { entry, startTime: performance.now(), promoted: false });
        this.activeOperations.set(id, { entry, startTime: performance.now() });
        return id;
      }
      if (options?.diagnosticChildren) {
        // Parent visible, children buffered — create buffer but also write parent to log
        this.diagnosticBuffers.set(id, { entry, startTime: performance.now(), promoted: false });
      }
    }

    this.entries.push(entry);
    this.entriesById.set(id, entry);
    this.activeOperations.set(id, { entry, startTime: performance.now() });

    this.notifyListeners();
    return id;
  }

  /**
   * Add a child entry to an active operation.
   *
   * If the parent is a buffered diagnostic operation:
   *  - info/success children are appended to the buffer silently.
   *  - warning/error children trigger promotion: the entire operation
   *    (parent + all buffered children) is flushed to the real log,
   *    and all subsequent children are logged normally.
   */
  addChild(
    parentId: string,
    level: LogLevel,
    operation: string,
    message: string,
    details?: string,
    context?: OperationContext
  ): string {
    // Check if parent is in the diagnostic buffer
    const buffered = this.diagnosticBuffers.get(parentId);
    if (buffered && !buffered.promoted) {
      if (level === 'warning' || level === 'error') {
        // Promote the entire operation to the real log
        this.promoteDiagnosticOperation(parentId);
        // Fall through to normal addChild logic below
      } else {
        // Still buffered — accumulate silently
        const id = this.generateId();
        const childEntry: LogEntry = {
          id,
          timestamp: new Date(),
          level,
          category: buffered.entry.category,
          operation,
          message,
          details,
          context,
          parentId
        };
        buffered.entry.children = buffered.entry.children || [];
        buffered.entry.children.push(childEntry);
        return id;
      }
    }

    const parent = this.entriesById.get(parentId);
    if (!parent) {
      console.warn(`[SessionLogService] Parent operation not found: ${parentId}`);
      // Fall back to top-level log
      return this.log(level, 'data-update', operation, message, details, context);
    }

    const id = this.generateId();

    const childEntry: LogEntry = {
      id,
      timestamp: new Date(),
      level,
      category: parent.category,
      operation,
      message,
      details,
      context,
      parentId
    };

    parent.children = parent.children || [];
    parent.children.push(childEntry);
    this.entriesById.set(id, childEntry);

    // Auto-expand parent if child has warning/error
    if (level === 'warning' || level === 'error') {
      parent.expanded = true;
      // Escalate parent level if needed
      if (level === 'error' && parent.level !== 'error') {
        parent.level = 'error';
      } else if (level === 'warning' && parent.level === 'info') {
        parent.level = 'warning';
      }
    }

    this.notifyListeners();
    return id;
  }

  /**
   * End an active operation with summary.
   *
   * If the operation is a buffered diagnostic that was never promoted,
   * it is silently discarded (nothing interesting happened).
   * If endOperation itself escalates to warning/error, the operation
   * is promoted first.
   */
  endOperation(
    operationId: string,
    level?: LogLevel,
    summaryMessage?: string,
    context?: OperationContext
  ): void {
    const buffered = this.diagnosticBuffers.get(operationId);

    // If ending with a warning/error, promote a buffered operation first
    if (buffered && !buffered.promoted && (level === 'warning' || level === 'error')) {
      this.promoteDiagnosticOperation(operationId);
    }

    if (buffered && !buffered.promoted) {
      const parentInLog = this.entriesById.has(operationId);
      if (parentInLog) {
        // diagnosticChildren mode: parent is in log, discard buffered children
        buffered.entry.children = [];
        this.diagnosticBuffers.delete(operationId);
        // Fall through to normal endOperation (update duration, summary, etc.)
      } else {
        // Fully diagnostic mode: silently discard entire operation
        this.diagnosticBuffers.delete(operationId);
        this.activeOperations.delete(operationId);
        return;
      }
    }

    // Clean up buffer tracking for promoted operations
    if (buffered) {
      this.diagnosticBuffers.delete(operationId);
    }

    const active = this.activeOperations.get(operationId);
    if (!active) {
      console.warn(`[SessionLogService] Active operation not found: ${operationId}`);
      return;
    }

    const { entry, startTime } = active;
    const duration = performance.now() - startTime;

    // Update entry
    if (level) entry.level = level;
    if (summaryMessage) entry.message = summaryMessage;

    entry.context = {
      ...entry.context,
      ...context,
      duration
    };

    // Auto-expand if has errors/warnings or many children
    if (entry.children && entry.children.length > 0) {
      const hasIssues = entry.children.some(c => c.level === 'error' || c.level === 'warning');
      if (hasIssues) {
        entry.expanded = true;
      }
    }

    this.activeOperations.delete(operationId);
    this.notifyListeners();
  }

  /**
   * Promote a buffered diagnostic operation to the real log.
   * Called when a warning/error child arrives — flushes the parent
   * and all previously buffered children so the user sees the full context.
   */
  private promoteDiagnosticOperation(opId: string): void {
    const buffered = this.diagnosticBuffers.get(opId);
    if (!buffered) return;

    // For fully-diagnostic parents, move entry to real log.
    // For diagnosticChildren parents, the entry is already in the log —
    // we just need to register the buffered children.
    const alreadyInLog = this.entriesById.has(opId);
    if (!alreadyInLog) {
      this.entries.push(buffered.entry);
      this.entriesById.set(opId, buffered.entry);
    }

    // Register all buffered children in entriesById
    if (buffered.entry.children) {
      for (const child of buffered.entry.children) {
        this.entriesById.set(child.id, child);
      }
    }

    // Mark as promoted — future addChild calls go through the normal path
    buffered.promoted = true;

    // Auto-expand since we're promoting due to a warning/error
    buffered.entry.expanded = true;

    this.notifyListeners();
  }

  /**
   * Add a simple log entry (no hierarchy)
   */
  log(
    level: LogLevel, 
    category: OperationType, 
    operation: string,
    message: string, 
    details?: string,
    context?: OperationContext
  ): string {
    const id = this.generateId();
    
    const entry: LogEntry = {
      id,
      timestamp: new Date(),
      level,
      category,
      operation,
      message,
      details,
      context
    };
    
    this.entries.push(entry);
    this.entriesById.set(id, entry);
    
    this.updateLogFile();
    this.notifyListeners();
    
    return id;
  }

  /**
   * Convenience methods for different log levels.
   * info() and success() accept DiagnosticOptions — when diagnostic is true
   * and diagnostic logging is off, the entry is silently dropped.
   * warning() and error() never accept DiagnosticOptions and are always logged.
   */
  info(category: OperationType, operation: string, message: string, details?: string, context?: OperationContext, options?: DiagnosticOptions): string {
    if (options?.diagnostic && !this.diagnosticLoggingEnabled) return '';
    return this.log('info', category, operation, message, details, context);
  }

  success(category: OperationType, operation: string, message: string, details?: string, context?: OperationContext, options?: DiagnosticOptions): string {
    if (options?.diagnostic && !this.diagnosticLoggingEnabled) return '';
    return this.log('success', category, operation, message, details, context);
  }

  warning(category: OperationType, operation: string, message: string, details?: string, context?: OperationContext): string {
    return this.log('warning', category, operation, message, details, context);
  }

  error(category: OperationType, operation: string, message: string, details?: string, context?: OperationContext): string {
    return this.log('error', category, operation, message, details, context);
  }

  /**
   * Legacy support: addLogEntry for existing callers
   */
  addLogEntry(entry: {
    level: LogLevel;
    message: string;
    operation?: string;
    details?: string;
    fileId?: string;
    repo?: string;
    branch?: string;
  }): string {
    const category = this.inferCategory(entry.operation || '');
    return this.log(
      entry.level,
      category,
      entry.operation || 'UNKNOWN',
      entry.message,
      entry.details,
      {
        fileId: entry.fileId,
        repository: entry.repo,
        branch: entry.branch
      }
    );
  }

  private inferCategory(operation: string): OperationType {
    if (operation.startsWith('GIT_') || operation.startsWith('WORKSPACE_')) return 'git';
    if (operation.startsWith('FILE_')) return 'file';
    if (operation.startsWith('MSMDC') || operation.startsWith('GRAPH_')) return 'msmdc';
    if (operation.startsWith('DATA_')) return 'data-fetch';
    if (operation.startsWith('INDEX_')) return 'index';
    if (operation.startsWith('MERGE_')) return 'merge';
    return 'session';
  }

  /**
   * Get all log entries (top-level only)
   */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Get entry by ID (including children)
   */
  getEntry(id: string): LogEntry | undefined {
    return this.entriesById.get(id);
  }

  /**
   * Toggle expanded state of an entry
   */
  toggleExpanded(id: string): void {
    const entry = this.entriesById.get(id);
    if (entry && entry.children && entry.children.length > 0) {
      entry.expanded = !entry.expanded;
      this.notifyListeners();
    }
  }

  /**
   * Expand all entries
   */
  expandAll(): void {
    for (const entry of this.entries) {
      if (entry.children && entry.children.length > 0) {
        entry.expanded = true;
      }
    }
    this.notifyListeners();
  }

  /**
   * Collapse all entries
   */
  collapseAll(): void {
    for (const entry of this.entries) {
      entry.expanded = false;
    }
    this.notifyListeners();
  }

  /**
   * Get filtered log entries (searches all levels)
   */
  getFilteredEntries(searchTerm?: string): LogEntry[] {
    if (!searchTerm || searchTerm.trim() === '') {
      return this.getEntries();
    }
    
    const term = searchTerm.toLowerCase();
    
    const matchesEntry = (entry: LogEntry): boolean => {
      return (
        entry.category.toLowerCase().includes(term) ||
        entry.operation.toLowerCase().includes(term) ||
        entry.message.toLowerCase().includes(term) ||
        (entry.details?.toLowerCase().includes(term) ?? false) ||
        (entry.context?.fileId?.toLowerCase().includes(term) ?? false) ||
        (entry.context?.filePath?.toLowerCase().includes(term) ?? false)
      );
    };
    
    const filterEntries = (entries: LogEntry[]): LogEntry[] => {
      return entries.filter(entry => {
        // Check if this entry matches
        if (matchesEntry(entry)) return true;
        
        // Check if any children match
        if (entry.children) {
          return entry.children.some(child => matchesEntry(child));
        }
        
        return false;
      }).map(entry => {
        // If entry has children, filter them too but keep parent if any child matches
        if (entry.children) {
          const matchingChildren = entry.children.filter(child => matchesEntry(child));
          if (matchingChildren.length > 0 || matchesEntry(entry)) {
            return {
              ...entry,
              children: matchingChildren.length > 0 ? matchingChildren : entry.children,
              expanded: matchingChildren.length > 0 ? true : entry.expanded
            };
          }
        }
        return entry;
      });
    };
    
    return filterEntries(this.entries);
  }

  /**
   * Subscribe to log updates
   */
  subscribe(listener: (entries: LogEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const entries = this.getEntries();
    this.listeners.forEach(listener => listener(entries));
  }

  /**
   * Format entries as markdown (for export)
   */
  formatAsMarkdown(entries?: LogEntry[]): string {
    const entriesToFormat = entries || this.entries;
    const lines: string[] = [];
    
    lines.push('# Session Log');
    lines.push('');
    lines.push(`_Session started: ${this.entries[0]?.timestamp.toLocaleString() || 'N/A'}_`);
    lines.push('');
    lines.push('---');
    lines.push('');
    
    const formatEntry = (entry: LogEntry, indent: number = 0): void => {
      const prefix = '  '.repeat(indent);
      const icon = this.getLevelIcon(entry.level);
      const timeStr = entry.timestamp.toLocaleTimeString();
      
      lines.push(`${prefix}- \`${timeStr}\` ${icon} **[${entry.operation}]** ${entry.message}`);
      
      if (entry.details) {
        lines.push(`${prefix}  - _${entry.details}_`);
      }
      
      if (entry.context) {
        const contextSummary = this.formatContextSummary(entry.context);
        if (contextSummary) {
          lines.push(`${prefix}  - ${contextSummary}`);
        }
      }
      
      if (entry.children) {
        for (const child of entry.children) {
          formatEntry(child, indent + 1);
        }
      }
    };
    
    for (const entry of entriesToFormat) {
      formatEntry(entry);
    }
    
    if (entriesToFormat.length === 0) {
      lines.push('_No log entries yet._');
    }
    
    return lines.join('\n');
  }

  private formatContextSummary(context: OperationContext): string {
    const parts: string[] = [];
    
    if (context.duration) {
      parts.push(`${context.duration.toFixed(0)}ms`);
    }
    if (context.filesAffected?.length) {
      parts.push(`${context.filesAffected.length} files`);
    }
    if (context.parametersGenerated?.length) {
      const changed = context.parametersGenerated.filter(p => p.changed).length;
      parts.push(`${changed}/${context.parametersGenerated.length} params changed`);
    }
    if (context.rowCount !== undefined) {
      parts.push(`${context.rowCount} rows`);
    }
    if (context.added || context.updated || context.errors) {
      parts.push(`+${context.added || 0} ~${context.updated || 0} !${context.errors || 0}`);
    }
    
    return parts.join(' | ');
  }

  private getLevelIcon(level: LogLevel): string {
    switch (level) {
      case 'success': return '✅';
      case 'warning': return '⚠️';
      case 'error': return '❌';
      default: return '📝';
    }
  }

  /**
   * Update the in-memory log file
   */
  private updateLogFile(): void {
    const file = fileRegistry.getFile(this.fileId);
    if (file) {
      file.data = { entries: this.entries };
      (fileRegistry as any).notifyListeners(this.fileId, file);
    }
  }

  /**
   * Open session log in a new tab
   */
  async openLogTab(): Promise<string | null> {
    try {
      const timestamp = Date.now();

      const reassertDockAndFocus = (tabId: string): void => {
        // rc-dock listeners/layout can come up slightly after we dispatch the initial events
        // (especially during cold boot or URL-driven automation). Reassert a few times.
        const delaysMs = [0, 50, 200, 750, 2000, 5000];
        for (const d of delaysMs) {
          setTimeout(() => {
            try {
              window.dispatchEvent(new CustomEvent('dagnet:dockTabRightOfMain', { detail: { tabId } }));
              window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId } }));
            } catch {
              // Best-effort only
            }
          }, d);
        }
      };
      
      // Create or update the log file in fileRegistry
      const existingFile = fileRegistry.getFile(this.fileId);
      
      if (!existingFile) {
        // Use 'session-log' type for SessionLogViewer component
        await fileRegistry.getOrCreateFile(
          this.fileId,
          'session-log' as any, // Custom type for SessionLogViewer
          {
            repository: 'temporary',
            path: 'session-log.md',
            branch: 'main'
          },
          { entries: this.entries }
        );
      }

      // Check if tab already exists
      const file = fileRegistry.getFile(this.fileId);
      if (file && file.viewTabs && file.viewTabs.length > 0) {
        const existingTabId = file.viewTabs[0];

        // Guard: viewTabs can be stale (tab closed, but file viewTabs not cleaned for some reason).
        // If the tab no longer exists, clear the stale reference and fall through to create a new tab.
        const tabStillExists = await db.tabs.get(existingTabId);
        if (!tabStillExists) {
          try {
            file.viewTabs = [];
            await db.files.put(file as any);
          } catch {
            // Best-effort only
          }
        } else {
          // Tab exists, dispatch event to switch to it
          // Right-dock it (without a permanent right-dock panel) by splitting main panel at open-time.
          reassertDockAndFocus(existingTabId);
          return existingTabId;
        }
      }

      // Create tab
      const tabId = `tab-session-log-${timestamp}`;
      
      const newTab: TabState = {
        id: tabId,
        fileId: this.fileId,
        viewMode: 'interactive',
        title: 'Session Log',
        icon: '', // Icon handled by objectTypeTheme via AppShell
        closable: true,
        group: 'main-content'
      };

      // Add to registry
      await fileRegistry.addViewTab(this.fileId, tabId);
      
      // Dispatch event for TabContext to handle
      window.dispatchEvent(new CustomEvent('dagnet:openTemporaryTab', { 
        detail: { tab: newTab } 
      }));

      // Right-dock it (without a permanent right-dock panel) by splitting main panel at open-time.
      reassertDockAndFocus(tabId);

      return tabId;
    } catch (error) {
      console.error('[SessionLogService] Failed to open log tab:', error);
      return null;
    }
  }

  /**
   * Get the log file ID
   */
  getFileId(): string {
    return this.fileId;
  }

  /**
   * Clear the session log (for testing)
   */
  clear(): void {
    this.entries = [];
    this.entriesById.clear();
    this.activeOperations.clear();
    this.notifyListeners();
  }
}

// Export singleton instance
export const sessionLogService = SessionLogService.getInstance();
