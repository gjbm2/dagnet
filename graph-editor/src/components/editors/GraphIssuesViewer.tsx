/**
 * Graph Issues Viewer
 * 
 * IDE-style linter view showing integrity issues grouped by file.
 * Features:
 * - Auto-updating via subscription to graphIssuesService
 * - Filter by search, severity, category, graph
 * - Collapsible file groups
 * - Click to navigate to file
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { graphIssuesService, GraphIssue, GraphIssuesState } from '../../services/graphIssuesService';
import { useTabContext } from '../../contexts/TabContext';
import toast from 'react-hot-toast';
import './GraphIssuesViewer.css';

type IssueSeverity = 'error' | 'warning' | 'info';
type IssueCategory = GraphIssue['category'];

/**
 * Extract clean display name from fileId, stripping workspace prefix if present.
 * Examples:
 * - "graph-myname" → "graph-myname"
 * - "repo-branch-graph-myname" → "graph-myname"
 * - "repo-branch-parameter-myparam" → "parameter-myparam"
 */
function getDisplayName(fileId: string): string {
  // Common prefixes that indicate the actual file type
  const typeMarkers = ['graph-', 'parameter-', 'case-', 'node-', 'edge-'];
  
  for (const marker of typeMarkers) {
    const idx = fileId.indexOf(marker);
    if (idx > 0) {
      // Found a type marker not at the start - strip the prefix
      return fileId.substring(idx);
    }
  }
  
  // No workspace prefix found, return as-is
  return fileId;
}

interface GraphIssuesViewerProps {
  fileId?: string;
}

export function GraphIssuesViewer({ fileId }: GraphIssuesViewerProps) {
  const { operations } = useTabContext();
  
  const [state, setState] = useState<GraphIssuesState>(graphIssuesService.getState());
  const [searchTerm, setSearchTerm] = useState('');
  const [graphFilter, setGraphFilter] = useState<string>('');
  const [includeReferencedFiles, setIncludeReferencedFiles] = useState(true);
  const [severityFilter, setSeverityFilter] = useState<Set<IssueSeverity>>(new Set(['error', 'warning', 'info']));
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [autoExpandErrors, setAutoExpandErrors] = useState(true);
  
  // Subscribe to service updates
  useEffect(() => {
    const unsubscribe = graphIssuesService.subscribe(setState);
    return unsubscribe;
  }, []);
  
  // Get graph names for filter dropdown.
  // IMPORTANT: include graphs from the workspace even if there are currently only info issues
  // on referenced files (i.e. nothing directly attached to the graph fileId).
  const graphNames = useMemo(
    () => graphIssuesService.getGraphNames({ includeWorkspaceGraphs: true }),
    // Note: graphNames depends on both issues and the workspace file set.
    // We don't have a direct subscription to FileRegistry changes here, so we at least
    // recompute whenever the integrity check result updates (totalFiles/lastUpdated).
    [state.issues, state.totalFiles, state.lastUpdated?.getTime()]
  );
  
  // Filter issues
  const filteredIssues = useMemo(() => {
    return graphIssuesService.getFilteredIssues({
      searchTerm: searchTerm || undefined,
      graphFilter: graphFilter || undefined,
      includeReferencedFiles: graphFilter ? includeReferencedFiles : undefined,
      severities: Array.from(severityFilter)
    });
  }, [state.issues, searchTerm, graphFilter, includeReferencedFiles, severityFilter]);
  
  // Group issues by display name (deduplicates workspace-prefixed and non-prefixed fileIds)
  const issuesByFile = useMemo(() => {
    // Group by display name, keeping track of original fileId for navigation
    const grouped = new Map<string, { fileId: string; issues: GraphIssue[] }>();
    
    for (const issue of filteredIssues) {
      const displayName = getDisplayName(issue.fileId);
      if (!grouped.has(displayName)) {
        grouped.set(displayName, { fileId: issue.fileId, issues: [] });
      }
      grouped.get(displayName)!.issues.push(issue);
    }
    
    // Sort files: errors first, then by count
    const sorted = Array.from(grouped.entries()).sort((a, b) => {
      const aErrors = a[1].issues.filter(i => i.severity === 'error').length;
      const bErrors = b[1].issues.filter(i => i.severity === 'error').length;
      if (aErrors !== bErrors) return bErrors - aErrors;
      return b[1].issues.length - a[1].issues.length;
    });
    
    // Return as [displayName, fileId, issues] tuples
    return sorted.map(([displayName, { fileId, issues }]) => 
      [displayName, fileId, issues] as [string, string, GraphIssue[]]
    );
  }, [filteredIssues]);
  
  // Auto-expand files with errors
  useEffect(() => {
    if (autoExpandErrors) {
      const filesWithErrors = new Set<string>();
      for (const issue of filteredIssues) {
        if (issue.severity === 'error') {
          filesWithErrors.add(getDisplayName(issue.fileId));
        }
      }
      setExpandedFiles(prev => new Set([...prev, ...filesWithErrors]));
    }
  }, [filteredIssues, autoExpandErrors]);
  
  // Toggle severity filter
  const toggleSeverity = useCallback((severity: IssueSeverity) => {
    setSeverityFilter(prev => {
      const next = new Set(prev);
      if (next.has(severity)) {
        next.delete(severity);
      } else {
        next.add(severity);
      }
      return next;
    });
  }, []);
  
  // Toggle file expansion
  const toggleFile = useCallback((fileId: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  }, []);
  
  // Expand/collapse all
  const expandAll = useCallback(() => {
    setExpandedFiles(new Set(issuesByFile.map(([displayName]) => displayName)));
  }, [issuesByFile]);
  
  const collapseAll = useCallback(() => {
    setExpandedFiles(new Set());
  }, []);
  
  // Navigate to file (optionally with deep linking to node/edge)
  const handleNavigateToFile = useCallback(async (fileId: string, nodeUuid?: string, edgeUuid?: string) => {
    try {
      // Extract type from fileId (e.g., "graph-myname" -> "graph")
      const displayName = getDisplayName(fileId);
      const typePart = displayName.split('-')[0] as 'graph' | 'parameter' | 'case' | 'node' | 'event' | 'context';
      const namePart = displayName.replace(`${typePart}-`, '');
      
      // Construct a RepositoryItem for openTab
      // Note: item.id should be just the name, not the full fileId (e.g., "myname" not "graph-myname")
      const item = {
        id: namePart,
        name: namePart,
        type: typePart,
        path: `${typePart}s/${namePart}.yaml`
      };
      
      // For graph files, pass initial selection if we have node/edge UUIDs
      const initialEditorState = (typePart === 'graph' && (nodeUuid || edgeUuid))
        ? { selectedNodeId: nodeUuid || null, selectedEdgeId: edgeUuid || null }
        : undefined;
      
      console.log('[GraphIssuesViewer] Navigating to:', { fileId, displayName, typePart, namePart, nodeUuid, edgeUuid, initialEditorState });
      
      await operations.openTab(item, 'interactive', false, initialEditorState);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  }, [operations]);
  
  // Force refresh
  const handleRefresh = useCallback(() => {
    graphIssuesService.forceCheck();
  }, []);

  const handleCopyAll = useCallback(async () => {
    try {
      const text = graphIssuesService.exportIssuesForClipboard({
        issues: filteredIssues,
        context: {
          searchTerm,
          graphFilter,
          includeReferencedFiles,
          severities: Array.from(severityFilter),
        },
      });
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${filteredIssues.length} issue${filteredIssues.length === 1 ? '' : 's'}`);
    } catch (error) {
      console.error('Failed to copy issues:', error);
      toast.error('Failed to copy issues');
    }
  }, [filteredIssues, searchTerm, graphFilter, includeReferencedFiles, severityFilter]);
  
  // Summary counts
  const errorCount = useMemo(() => 
    filteredIssues.filter(i => i.severity === 'error').length, [filteredIssues]);
  const warningCount = useMemo(() => 
    filteredIssues.filter(i => i.severity === 'warning').length, [filteredIssues]);
  const infoCount = useMemo(() => 
    filteredIssues.filter(i => i.severity === 'info').length, [filteredIssues]);
  
  return (
    <div className="graph-issues-viewer">
      {/* Toolbar */}
      <div className="issues-toolbar">
        <input
          type="text"
          placeholder="Search issues..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="issues-search"
        />
        
        <select
          value={graphFilter}
          onChange={(e) => setGraphFilter(e.target.value)}
          className="issues-graph-filter"
        >
          <option value="">All graphs</option>
          {graphNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        
        {graphFilter && (
          <label className="issues-include-refs" title="Include issues from files referenced by this graph">
            <input
              type="checkbox"
              checked={includeReferencedFiles}
              onChange={(e) => setIncludeReferencedFiles(e.target.checked)}
            />
            Include refs
          </label>
        )}
        
        <div className="issues-severity-toggles">
          <button
            className={`severity-toggle severity-error ${severityFilter.has('error') ? 'active' : ''}`}
            onClick={() => toggleSeverity('error')}
            title="Toggle errors"
          >
            ❌ {errorCount}
          </button>
          <button
            className={`severity-toggle severity-warning ${severityFilter.has('warning') ? 'active' : ''}`}
            onClick={() => toggleSeverity('warning')}
            title="Toggle warnings"
          >
            ⚠️ {warningCount}
          </button>
          <button
            className={`severity-toggle severity-info ${severityFilter.has('info') ? 'active' : ''}`}
            onClick={() => toggleSeverity('info')}
            title="Toggle info"
          >
            ℹ️ {infoCount}
          </button>
        </div>
        
        <div className="issues-toolbar-actions">
          <button
            onClick={handleCopyAll}
            className="issues-btn"
            title="Copy all filtered issues"
            disabled={filteredIssues.length === 0}
          >
            ⧉
          </button>
          <button onClick={expandAll} className="issues-btn" title="Expand all">
            ⊕
          </button>
          <button onClick={collapseAll} className="issues-btn" title="Collapse all">
            ⊖
          </button>
          <button 
            onClick={handleRefresh} 
            className={`issues-btn ${state.isLoading ? 'loading' : ''}`}
            title="Refresh"
            disabled={state.isLoading}
          >
            {state.isLoading ? '⟳' : '↻'}
          </button>
        </div>
      </div>
      
      {/* Status bar */}
      <div className="issues-status">
        {state.isLoading ? (
          <span className="status-loading">Scanning workspace...</span>
        ) : state.error ? (
          <span className="status-error">Error: {state.error}</span>
        ) : (
          <span className="status-info">
            {filteredIssues.length} issue{filteredIssues.length !== 1 ? 's' : ''} in {issuesByFile.length} file{issuesByFile.length !== 1 ? 's' : ''}
            {state.lastUpdated && (
              <span className="status-time"> · Updated {formatTime(state.lastUpdated)}</span>
            )}
          </span>
        )}
      </div>
      
      {/* Issues list */}
      <div className="issues-list">
        {issuesByFile.length === 0 ? (
          <div className="issues-empty">
            {state.isLoading ? (
              'Scanning...'
            ) : filteredIssues.length === 0 && state.issues.length > 0 ? (
              'No issues match current filters'
            ) : (
              '✅ No issues found'
            )}
          </div>
        ) : (
          issuesByFile.map(([displayName, fileId, issues]) => (
            <FileIssueGroup
              key={displayName}
              displayName={displayName}
              fileId={fileId}
              issues={issues}
              expanded={expandedFiles.has(displayName)}
              onToggle={() => toggleFile(displayName)}
              onNavigate={() => handleNavigateToFile(fileId)}
              onNavigateToIssue={(issue) => handleNavigateToFile(issue.fileId, issue.nodeUuid, issue.edgeUuid)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface FileIssueGroupProps {
  displayName: string;  // Clean name for display
  fileId: string;       // Original fileId for navigation
  issues: GraphIssue[];
  expanded: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  onNavigateToIssue: (issue: GraphIssue) => void;
}

function FileIssueGroup({ displayName, fileId, issues, expanded, onToggle, onNavigate, onNavigateToIssue }: FileIssueGroupProps) {
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount = issues.filter(i => i.severity === 'info').length;
  
  const typeIcon = getTypeIcon(issues[0]?.type || 'system');
  
  return (
    <div className={`file-issue-group ${expanded ? 'expanded' : ''}`}>
      <div className="file-header" onClick={onToggle}>
        <span className="expand-icon">{expanded ? '▼' : '▶'}</span>
        <span className="file-icon">{typeIcon}</span>
        <span className="file-name" onClick={(e) => { e.stopPropagation(); onNavigate(); }}>
          {displayName}
        </span>
        <span className="issue-counts">
          {errorCount > 0 && <span className="count-error">❌ {errorCount}</span>}
          {warningCount > 0 && <span className="count-warning">⚠️ {warningCount}</span>}
          {infoCount > 0 && <span className="count-info">ℹ️ {infoCount}</span>}
        </span>
      </div>
      
      {expanded && (
        <div className="file-issues">
          {issues.map(issue => (
            <IssueRow 
              key={issue.id} 
              issue={issue} 
              onNavigate={() => onNavigateToIssue(issue)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface IssueRowProps {
  issue: GraphIssue;
  onNavigate?: () => void;
}

function IssueRow({ issue, onNavigate }: IssueRowProps) {
  const severityIcon = getSeverityIcon(issue.severity);
  const categoryIcon = getCategoryIcon(issue.category);
  const isClickable = onNavigate && (issue.nodeUuid || issue.edgeUuid);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);
  
  const handleCopyObject = useCallback(async () => {
    const objectData = {
      fileId: issue.fileId,
      severity: issue.severity,
      category: issue.category,
      message: issue.message,
      field: issue.field,
      suggestion: issue.suggestion,
      details: issue.details,
      nodeUuid: issue.nodeUuid,
      edgeUuid: issue.edgeUuid
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(objectData, null, 2));
    } catch (err) {
      console.error('Failed to copy:', err);
    }
    setShowContextMenu(false);
  }, [issue]);
  
  // Close context menu on click outside
  useEffect(() => {
    if (showContextMenu) {
      const handleClick = () => setShowContextMenu(false);
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [showContextMenu]);
  
  return (
    <>
      <div 
        className={`issue-row severity-${issue.severity} ${isClickable ? 'clickable' : ''}`}
        onClick={isClickable ? onNavigate : undefined}
        onContextMenu={handleContextMenu}
        title={isClickable ? 'Click to navigate to this element' : undefined}
      >
        <span className="issue-severity-icon">{severityIcon}</span>
        <span className="issue-category" title={issue.category}>{categoryIcon}</span>
        <div className="issue-content">
          <span className="issue-message">{issue.message}</span>
          {issue.field && (
            <span className="issue-field">Field: <code>{issue.field}</code></span>
          )}
          {issue.suggestion && (
            <span className="issue-suggestion">💡 {issue.suggestion}</span>
          )}
          {issue.details && (
            <span className="issue-details">{issue.details}</span>
          )}
        </div>
        {isClickable && <span className="issue-link-icon">→</span>}
      </div>
      {showContextMenu && (
        <div 
          className="issue-context-menu"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
        >
          <button onClick={handleCopyObject}>Copy object</button>
        </div>
      )}
    </>
  );
}

function getSeverityIcon(severity: IssueSeverity): string {
  switch (severity) {
    case 'error': return '❌';
    case 'warning': return '⚠️';
    case 'info': return 'ℹ️';
  }
}

function getTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    'graph': '📊',
    'parameter': '📐',
    'case': '📁',
    'node': '🔘',
    'event': '⚡',
    'context': '🌐',
    'connections': '🔗',
    'system': '⚙️'
  };
  return icons[type] || '📄';
}

function getCategoryIcon(category: IssueCategory): string {
  const icons: Record<string, string> = {
    'schema': '📋',
    'id-format': '🔤',
    'reference': '🔗',
    'graph-structure': '🕸️',
    'registry': '📇',
    'connection': '🔌',
    'credentials': '🔐',
    'value': '🔢',
    'orphan': '👻',
    'duplicate': '♊',
    'naming': '🏷️',
    'metadata': '📎',
    'sync': '🔄',
    'image': '🖼️'
  };
  return icons[category] || '•';
}

function formatTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  
  return date.toLocaleTimeString();
}

export default GraphIssuesViewer;

