import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EditorProps } from '../../types';
import { useFileState } from '../../contexts/TabContext';
import './MarkdownViewer.css';

/**
 * Markdown Viewer Component
 * 
 * Read-only markdown viewer for documentation files.
 * Uses react-markdown with GitHub Flavored Markdown support.
 */
export function MarkdownViewer({ fileId }: EditorProps) {
  const { data } = useFileState(fileId);

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
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" className="markdown-link">
                {children}
              </a>
            )
          }}
        >
          {markdownContent}
        </ReactMarkdown>
      </div>
    </div>
  );
}
