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
  | 'merge';

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

class SessionLogService {
  private static instance: SessionLogService;
  private entries: LogEntry[] = [];
  private entriesById: Map<string, LogEntry> = new Map();
  private activeOperations: Map<string, ActiveOperation> = new Map();
  private fileId = 'session-log';
  private listeners: Set<(entries: LogEntry[]) => void> = new Set();
  private isInitialized = false;
  private operationCounter = 0;

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
    this.entries = [];
    this.entriesById.clear();
    this.activeOperations.clear();
    
    // Log initialization
    this.log('info', 'session', 'SESSION_START', 'Session started', 
      `DagNet v${(import.meta as any).env?.VITE_APP_VERSION || '0.9x'}`);
    
    console.log('[SessionLogService] Initialized');
  }

  private generateId(): string {
    return `log-${Date.now()}-${++this.operationCounter}`;
  }

  /**
   * Start a composite operation that will have children
   * Returns operation ID to use with addChild() and endOperation()
   */
  startOperation(
    level: LogLevel,
    category: OperationType,
    operation: string,
    message: string,
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
      context,
      children: [],
      expanded: level === 'warning' || level === 'error' // Auto-expand warnings/errors
    };
    
    this.entries.push(entry);
    this.entriesById.set(id, entry);
    this.activeOperations.set(id, { entry, startTime: performance.now() });
    
    this.notifyListeners();
    return id;
  }

  /**
   * Add a child entry to an active operation
   */
  addChild(
    parentId: string,
    level: LogLevel,
    operation: string,
    message: string,
    details?: string,
    context?: OperationContext
  ): string {
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
   * End an active operation with summary
   */
  endOperation(
    operationId: string, 
    level?: LogLevel, 
    summaryMessage?: string,
    context?: OperationContext
  ): void {
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
   * Convenience methods for different log levels
   */
  info(category: OperationType, operation: string, message: string, details?: string, context?: OperationContext): string {
    return this.log('info', category, operation, message, details, context);
  }

  success(category: OperationType, operation: string, message: string, details?: string, context?: OperationContext): string {
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
        // Tab exists, dispatch event to switch to it
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { 
          detail: { tabId: file.viewTabs[0] } 
        }));
        return file.viewTabs[0];
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
