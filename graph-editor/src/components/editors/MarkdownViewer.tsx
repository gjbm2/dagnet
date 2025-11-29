import React, { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EditorProps } from '../../types';
import { useFileState, useTabContext } from '../../contexts/TabContext';
import './MarkdownViewer.css';

/**
 * Markdown Viewer Component
 * 
 * Read-only markdown viewer for documentation files.
 * Uses react-markdown with GitHub Flavored Markdown support.
 * 
 * Supports internal file links with format: dagnet:file/{fileId}
 * Example: [parameter-test](dagnet:file/parameter-test)
 */
export function MarkdownViewer({ fileId }: EditorProps) {
  const { data } = useFileState(fileId);
  const { operations } = useTabContext();

  // Open an internal file by ID
  // Handles both simple format (event-xxx) and workspace-prefixed format (repo-branch-event-xxx)
  const openInternalFile = useCallback((targetFileId: string) => {
    console.log('[MarkdownViewer] Opening internal file:', targetFileId);
    
    // Valid file types
    const fileTypes = ['graph', 'parameter', 'case', 'node', 'event', 'context'];
    
    // Find the type by looking for type keyword in the ID
    // Format could be: "event-xxx" or "repo-branch-event-xxx"
    let type = 'graph';
    let name = targetFileId;
    let actualFileId = targetFileId;
    
    for (const ft of fileTypes) {
      // Look for "-{type}-" pattern (workspace prefixed) or "^{type}-" pattern (simple)
      const prefixedPattern = new RegExp(`-${ft}-(.+)$`);
      const simplePattern = new RegExp(`^${ft}-(.+)$`);
      
      const prefixedMatch = targetFileId.match(prefixedPattern);
      const simpleMatch = targetFileId.match(simplePattern);
      
      if (simpleMatch) {
        // Simple format: event-xxx
        type = ft;
        name = simpleMatch[1];
        actualFileId = targetFileId;
        break;
      } else if (prefixedMatch) {
        // Workspace prefixed format: repo-branch-event-xxx
        type = ft;
        name = prefixedMatch[1];
        // Extract just the type-name part for the actual file ID
        actualFileId = `${ft}-${name}`;
        break;
      }
    }
    
    // Build path based on type
    let path: string;
    if (type === 'graph') {
      path = `graphs/${name}.json`;
    } else {
      path = `${type}s/${name}.yaml`;
    }
    
    console.log('[MarkdownViewer] Resolved:', { type, name, actualFileId, path });
    
    // Open the file in a new tab
    operations.openTab({
      id: actualFileId,
      name: name,
      type: type as any,
      path: path
    }, 'interactive', false);
  }, [operations]);

  if (!data) {
    return (
      <div className="markdown-viewer-loading">
        Loading markdown content...
      </div>
    );
  }

  const markdownContent = data.content || data.toString() || '# No Content';

  return (
    <div className="markdown-viewer">
      <div className="markdown-content">
        <ReactMarkdown 
          remarkPlugins={[remarkGfm]}
          components={{
            // Custom styling for better readability
            h1: ({ children }) => <h1 className="markdown-h1">{children}</h1>,
            h2: ({ children }) => <h2 className="markdown-h2">{children}</h2>,
            h3: ({ children }) => <h3 className="markdown-h3">{children}</h3>,
            code: ({ children, className }) => (
              <code className={`markdown-code ${className || ''}`}>{children}</code>
            ),
            pre: ({ children }) => <pre className="markdown-pre">{children}</pre>,
            table: ({ children }) => <table className="markdown-table">{children}</table>,
            th: ({ children }) => <th className="markdown-th">{children}</th>,
            td: ({ children }) => <td className="markdown-td">{children}</td>,
            // Links: internal links handled via onClick, external links open in new tab
            // Internal links use hash format: #dagnet-file/{fileId} to avoid browser stripping
            a: ({ href, children }) => {
              // Check for internal link pattern: #dagnet-file/{fileId}
              const isInternalLink = href?.startsWith('#dagnet-file/');
              
              if (isInternalLink && href) {
                const targetFileId = href.replace('#dagnet-file/', '');
                return (
                  <span
                    className="markdown-link internal-link"
                    data-file-id={targetFileId}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openInternalFile(targetFileId);
                    }}
                    style={{ cursor: 'pointer' }}
                    role="link"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openInternalFile(targetFileId);
                      }
                    }}
                  >
                    {children}
                  </span>
                );
              }
              
              return (
                <a 
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="markdown-link"
                >
                  {children}
                </a>
              );
            }
          }}
        >
          {markdownContent}
        </ReactMarkdown>
      </div>
    </div>
  );
}
