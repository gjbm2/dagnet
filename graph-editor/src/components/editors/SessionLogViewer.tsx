/**
 * Session Log Viewer
 * 
 * Displays hierarchical session logs with:
 * - Expand/collapse for composite operations
 * - Search filtering
 * - Tail mode (auto-scroll to latest)
 * - Context details for data operations
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { sessionLogService, LogEntry, LogLevel, OperationContext } from '../../services/sessionLogService';
import './SessionLogViewer.css';

interface SessionLogViewerProps {
  fileId?: string;
}

export function SessionLogViewer({ fileId }: SessionLogViewerProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [tailMode, setTailMode] = useState(true);
  const [showContext, setShowContext] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: LogEntry } | null>(null);

  // Subscribe to log updates
  useEffect(() => {
    const unsubscribe = sessionLogService.subscribe((newEntries) => {
      setEntries([...newEntries]);
    });
    
    // Initialize with current entries
    setEntries(sessionLogService.getEntries());
    
    return unsubscribe;
  }, []);

  // Auto-scroll when in tail mode
  useEffect(() => {
    if (tailMode && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, tailMode]);

  // Track scroll position to disable tail mode on manual scroll
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    
    if (wasAtBottomRef.current && !atBottom) {
      // User scrolled up - disable tail mode
      setTailMode(false);
    } else if (!wasAtBottomRef.current && atBottom) {
      // User scrolled back to bottom - enable tail mode
      setTailMode(true);
    }
    
    wasAtBottomRef.current = atBottom;
  }, []);

  const filteredEntries = searchTerm 
    ? sessionLogService.getFilteredEntries(searchTerm)
    : entries;

  const handleToggleExpand = (id: string) => {
    sessionLogService.toggleExpanded(id);
  };

  const handleExpandAll = () => {
    sessionLogService.expandAll();
  };

  const handleCollapseAll = () => {
    sessionLogService.collapseAll();
  };

  const jumpToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setTailMode(true);
    }
  };

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, entry: LogEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const handleCopyEntry = useCallback(async () => {
    if (!contextMenu?.entry) return;
    
    try {
      // Create a clean copy without circular references and with serialized dates
      const cleanEntry = JSON.parse(JSON.stringify(contextMenu.entry, (key, value) => {
        if (value instanceof Date) {
          return value.toISOString();
        }
        return value;
      }));
      
      await navigator.clipboard.writeText(JSON.stringify(cleanEntry, null, 2));
      // Could show a toast here, but keeping it simple
    } catch (err) {
      console.error('Failed to copy log entry:', err);
    }
    setContextMenu(null);
  }, [contextMenu]);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleClearLogs = useCallback(() => {
    sessionLogService.clear();
  }, []);

  // Close context menu when clicking outside
  useEffect(() => {
    if (contextMenu) {
      const handleClick = () => setContextMenu(null);
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  return (
    <div className="session-log-viewer">
      <div className="log-toolbar">
        <input
          type="text"
          placeholder="Search logs..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="log-search"
        />
        
        <div className="log-toolbar-actions">
          <button onClick={handleClearLogs} className="log-btn" title="Clear all logs">
            🗑
          </button>
          <button onClick={handleExpandAll} className="log-btn" title="Expand all">
            ⊕
          </button>
          <button onClick={handleCollapseAll} className="log-btn" title="Collapse all">
            ⊖
          </button>
          
          <label className="log-checkbox" title="Show operation context details">
            <input
              type="checkbox"
              checked={showContext}
              onChange={(e) => setShowContext(e.target.checked)}
            />
            Context
          </label>
          
          <label className="log-checkbox" title="Auto-scroll to latest entries">
            <input
              type="checkbox"
              checked={tailMode}
              onChange={(e) => setTailMode(e.target.checked)}
            />
            Tail
          </label>
          
          {!tailMode && (
            <button onClick={jumpToBottom} className="log-btn log-btn-primary">
              ↓ Jump to Latest
            </button>
          )}
        </div>
      </div>
      
      <div 
        className="log-entries" 
        ref={containerRef}
        onScroll={handleScroll}
      >
        {filteredEntries.length === 0 ? (
          <div className="log-empty">
            {searchTerm ? 'No matching log entries' : 'No log entries yet'}
          </div>
        ) : (
          filteredEntries.map((entry) => (
            <LogEntryRow 
              key={entry.id} 
              entry={entry} 
              depth={0}
              showContext={showContext}
              onToggleExpand={handleToggleExpand}
              onContextMenu={handleContextMenu}
            />
          ))
        )}
      </div>
      
      {/* Context Menu */}
      {contextMenu && (
        <div 
          className="log-context-menu"
          style={{ 
            position: 'fixed', 
            left: contextMenu.x, 
            top: contextMenu.y,
            zIndex: 10000
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="log-context-menu-item"
            onClick={handleCopyEntry}
          >
            Copy as JSON
          </button>
        </div>
      )}
    </div>
  );
}

interface LogEntryRowProps {
  entry: LogEntry;
  depth: number;
  showContext: boolean;
  onToggleExpand: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: LogEntry) => void;
}

function LogEntryRow({ entry, depth, showContext, onToggleExpand, onContextMenu }: LogEntryRowProps) {
  const hasChildren = entry.children && entry.children.length > 0;
  const isExpanded = entry.expanded;
  
  const levelIcon = getLevelIcon(entry.level);
  const levelClass = `log-level-${entry.level}`;
  
  return (
    <div 
      className={`log-entry-container ${levelClass}`}
      onContextMenu={(e) => onContextMenu(e, entry)}
    >
      <div 
        className={`log-entry ${hasChildren ? 'log-entry-expandable' : ''}`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => hasChildren && onToggleExpand(entry.id)}
      >
        {hasChildren && (
          <span className="log-expand-icon">
            {isExpanded ? '▼' : '▶'}
          </span>
        )}
        
        <span className="log-time">
          {entry.timestamp.toLocaleTimeString()}
        </span>
        
        <span className="log-icon">{levelIcon}</span>
        
        <span className="log-operation">[{entry.operation}]</span>
        
        <span className="log-message">{entry.message}</span>
        
        {hasChildren && (
          <span className="log-child-count">
            ({entry.children!.length})
          </span>
        )}
        
        {entry.context?.duration && (
          <span className="log-duration">
            {entry.context.duration.toFixed(0)}ms
          </span>
        )}
      </div>
      
      {entry.details && (
        <div 
          className="log-details"
          style={{ paddingLeft: `${depth * 20 + 32}px` }}
        >
          {entry.details}
        </div>
      )}
      
      {showContext && entry.context && (
        <ContextDetails context={entry.context} depth={depth} />
      )}
      
      {hasChildren && isExpanded && (
        <div className="log-children">
          {entry.children!.map((child) => (
            <LogEntryRow
              key={child.id}
              entry={child}
              depth={depth + 1}
              showContext={showContext}
              onToggleExpand={onToggleExpand}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ContextDetailsProps {
  context: OperationContext;
  depth: number;
}

function ContextDetails({ context, depth }: ContextDetailsProps) {
  // Filter out empty/null values and internal fields
  const relevantFields = Object.entries(context).filter(([key, value]) => {
    if (value === null || value === undefined) return false;
    if (key === 'duration') return false; // Already shown inline
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === 'object' && Object.keys(value).length === 0) return false;
    return true;
  });
  
  if (relevantFields.length === 0) return null;
  
  return (
    <div 
      className="log-context"
      style={{ paddingLeft: `${depth * 20 + 32}px` }}
    >
      {relevantFields.map(([key, value]) => (
        <ContextField key={key} fieldKey={key} value={value} />
      ))}
    </div>
  );
}

interface ContextFieldProps {
  fieldKey: string;
  value: any;
}

function ContextField({ fieldKey, value }: ContextFieldProps) {
  const label = formatFieldLabel(fieldKey);
  
  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    
    // Special handling for parametersGenerated
    if (fieldKey === 'parametersGenerated') {
      return (
        <div className="context-field context-field-array">
          <span className="context-label">{label}:</span>
          <div className="context-params">
            {value.map((param: any, idx: number) => (
              <div key={idx} className={`context-param ${param.changed ? 'context-param-changed' : ''}`}>
                <span className="param-id">{param.paramId}</span>
                <span className="param-location">{param.location}</span>
                {param.query && (
                  <code className="param-query">{truncate(param.query, 60)}</code>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    }
    
    // Generic array
    return (
      <div className="context-field">
        <span className="context-label">{label}:</span>
        <span className="context-value">{value.join(', ')}</span>
      </div>
    );
  }
  
  // Handle objects (valuesBefore, valuesAfter)
  if (typeof value === 'object') {
    return (
      <div className="context-field context-field-object">
        <span className="context-label">{label}:</span>
        <code className="context-value-object">
          {JSON.stringify(value, null, 2)}
        </code>
      </div>
    );
  }
  
  // Simple values
  return (
    <div className="context-field">
      <span className="context-label">{label}:</span>
      <span className="context-value">{String(value)}</span>
    </div>
  );
}

function getLevelIcon(level: LogLevel): string {
  switch (level) {
    case 'success': return '✅';
    case 'warning': return '⚠️';
    case 'error': return '❌';
    default: return '📝';
  }
}

function formatFieldLabel(key: string): string {
  // Convert camelCase to Title Case
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim();
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

export default SessionLogViewer;
