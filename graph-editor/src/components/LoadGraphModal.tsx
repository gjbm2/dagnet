import React, { useState, useEffect, useMemo } from 'react';
import { graphGitService } from '../services/graphGitService';
import { gitConfig } from '../config/gitConfig';

interface GraphFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: 'file' | 'dir';
  lastModified?: string;
  lastModifiedRaw?: string | null;
  author?: string;
  commitMessage?: string;
}

interface LoadGraphModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadGraph: (graphName: string) => void;
  selectedBranch: string;
  isLoading: boolean;
}

type SortField = 'name' | 'size' | 'lastModified' | 'author';
type SortDirection = 'asc' | 'desc';

export default function LoadGraphModal({ 
  isOpen, 
  onClose, 
  onLoadGraph, 
  selectedBranch,
  isLoading 
}: LoadGraphModalProps) {
  const [graphs, setGraphs] = useState<GraphFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('lastModified');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [searchTerm, setSearchTerm] = useState('');

  // Load graphs when modal opens
  useEffect(() => {
    if (isOpen) {
      loadGraphs();
    }
  }, [isOpen, selectedBranch]);

  const loadGraphs = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await graphGitService.getAvailableGraphs(selectedBranch);
      if (result.success && result.data) {
        // Get additional metadata for each graph
        const graphsWithMetadata = await Promise.all(
          result.data.map(async (graph: any) => {
            console.log('Processing graph:', graph.name);
            try {
              // Get commit history for this file
              const historyResult = await graphGitService.getGraphHistory(graph.name, selectedBranch);
              console.log('History result for', graph.name, ':', historyResult);
              
              if (historyResult.success && historyResult.data && historyResult.data.length > 0) {
                const latestCommit = historyResult.data[0];
                console.log('Latest commit for', graph.name, ':', latestCommit);
                console.log('Commit structure:', latestCommit.commit);
                console.log('Author date from commit:', latestCommit.commit?.author?.date);
                
                // The GitHub API returns the author info in commit.author, not directly in author
                const authorInfo = latestCommit.commit?.author || latestCommit.author;
                const commitMessage = latestCommit.commit?.message || latestCommit.message;
                
                let formattedDate = 'Unknown';
                try {
                  const dateString = authorInfo?.date;
                  if (dateString) {
                    const date = new Date(dateString);
                    if (!isNaN(date.getTime())) {
                      formattedDate = date.toLocaleString();
                    }
                  }
                } catch (error) {
                  console.warn('Failed to parse date:', authorInfo?.date, error);
                }
                
                return {
                  ...graph,
                  lastModified: formattedDate,
                  lastModifiedRaw: authorInfo?.date, // Store raw date for sorting
                  author: authorInfo?.name || 'Unknown',
                  commitMessage: commitMessage || 'No commit message'
                };
              } else {
                console.warn('No history data for', graph.name, ':', historyResult);
              }
            } catch (error) {
              console.warn(`Failed to get history for ${graph.name}:`, error);
            }
            
            // Fallback with basic file info
            return {
              ...graph,
              lastModified: 'Unknown',
              lastModifiedRaw: null, // No raw date for fallback
              author: 'Unknown',
              commitMessage: 'No commit info'
            };
          })
        );
        setGraphs(graphsWithMetadata);
      } else {
        setError(result.error || 'Failed to load graphs');
      }
    } catch (error) {
      setError('Failed to load graphs');
    } finally {
      setLoading(false);
    }
  };

  // Filter and sort graphs
  const filteredAndSortedGraphs = useMemo(() => {
    let filtered = graphs;
    
    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = graphs.filter(graph => 
        graph.name.toLowerCase().includes(term) ||
        (graph.author && graph.author.toLowerCase().includes(term)) ||
        (graph.commitMessage && graph.commitMessage.toLowerCase().includes(term))
      );
    }

    // Sort
    return filtered.sort((a, b) => {
      let aValue: any, bValue: any;
      
      switch (sortField) {
        case 'name':
          aValue = a.name.toLowerCase();
          bValue = b.name.toLowerCase();
          break;
        case 'size':
          aValue = a.size;
          bValue = b.size;
          break;
        case 'lastModified':
          aValue = a.lastModifiedRaw ? new Date(a.lastModifiedRaw).getTime() : 0;
          bValue = b.lastModifiedRaw ? new Date(b.lastModifiedRaw).getTime() : 0;
          break;
        case 'author':
          aValue = (a.author || '').toLowerCase();
          bValue = (b.author || '').toLowerCase();
          break;
        default:
          return 0;
      }

      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [graphs, searchTerm, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Same field - toggle direction
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // Different field - set new field and toggle direction
      setSortField(field);
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return '↕️';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        background: 'white',
        borderRadius: '8px',
        padding: '20px',
        width: '800px',
        maxWidth: '90vw',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
          borderBottom: '1px solid #e9ecef',
          paddingBottom: '12px'
        }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '600' }}>
            📁 Load Graph
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              color: '#666'
            }}
          >
            ×
          </button>
        </div>

        {/* Search */}
        <div style={{ marginBottom: '16px' }}>
          <input
            type="text"
            placeholder="Search graphs by name, author, or commit message..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px',
              boxSizing: 'border-box'
            }}
          />
        </div>

        {/* Loading/Error States */}
        {loading && (
          <div style={{
            textAlign: 'center',
            padding: '40px',
            color: '#666',
            fontSize: '14px'
          }}>
            🔄 Loading graphs...
          </div>
        )}

        {error && (
          <div style={{
            background: '#f8d7da',
            color: '#721c24',
            padding: '12px',
            borderRadius: '4px',
            marginBottom: '16px',
            fontSize: '14px'
          }}>
            ❌ {error}
          </div>
        )}

        {/* Table */}
        {!loading && !error && (
          <div style={{
            flex: 1,
            overflow: 'auto',
            border: '1px solid #e9ecef',
            borderRadius: '4px'
          }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '13px'
            }}>
              <thead style={{
                background: '#f8f9fa',
                position: 'sticky',
                top: 0,
                zIndex: 1
              }}>
                <tr>
                  <th
                    onClick={() => handleSort('name')}
                    style={{
                      padding: '12px 8px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      userSelect: 'none',
                      borderBottom: '1px solid #e9ecef',
                      fontWeight: '600'
                    }}
                  >
                    Name {getSortIcon('name')}
                  </th>
                  <th
                    onClick={() => handleSort('size')}
                    style={{
                      padding: '12px 8px',
                      textAlign: 'right',
                      cursor: 'pointer',
                      userSelect: 'none',
                      borderBottom: '1px solid #e9ecef',
                      fontWeight: '600',
                      width: '80px'
                    }}
                  >
                    Size {getSortIcon('size')}
                  </th>
                  <th
                    onClick={() => handleSort('author')}
                    style={{
                      padding: '12px 8px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      userSelect: 'none',
                      borderBottom: '1px solid #e9ecef',
                      fontWeight: '600',
                      width: '120px'
                    }}
                  >
                    Author {getSortIcon('author')}
                  </th>
                  <th
                    onClick={() => handleSort('lastModified')}
                    style={{
                      padding: '12px 8px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      userSelect: 'none',
                      borderBottom: '1px solid #e9ecef',
                      fontWeight: '600',
                      width: '100px'
                    }}
                  >
                    Modified {getSortIcon('lastModified')}
                  </th>
                  <th style={{
                    padding: '12px 8px',
                    textAlign: 'center',
                    borderBottom: '1px solid #e9ecef',
                    fontWeight: '600',
                    width: '80px'
                  }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSortedGraphs.map((graph, index) => (
                  <tr
                    key={graph.sha}
                    style={{
                      borderBottom: '1px solid #f1f3f4',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#f8f9fa';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'white';
                    }}
                  >
                    <td style={{ padding: '12px 8px' }}>
                      <div style={{ fontWeight: '500' }}>
                        {graph.name.replace('.json', '')}
                      </div>
                      {graph.commitMessage && (
                        <div style={{
                          fontSize: '11px',
                          color: '#666',
                          marginTop: '2px',
                          maxWidth: '300px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}>
                          {graph.commitMessage}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', color: '#666' }}>
                      {formatFileSize(graph.size)}
                    </td>
                    <td style={{ padding: '12px 8px', color: '#666' }}>
                      {graph.author || 'Unknown'}
                    </td>
                    <td style={{ padding: '12px 8px', color: '#666' }}>
                      {graph.lastModified || 'Unknown'}
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                      <button
                        onClick={() => {
                          onLoadGraph(graph.name);
                          onClose();
                        }}
                        disabled={isLoading}
                        style={{
                          background: '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          padding: '6px 12px',
                          fontSize: '12px',
                          cursor: isLoading ? 'not-allowed' : 'pointer',
                          opacity: isLoading ? 0.6 : 1
                        }}
                      >
                        {isLoading ? 'Loading...' : 'Load'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            
            {filteredAndSortedGraphs.length === 0 && (
              <div style={{
                textAlign: 'center',
                padding: '40px',
                color: '#666',
                fontSize: '14px'
              }}>
                {searchTerm ? 'No graphs match your search' : 'No graphs found in this branch'}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginTop: '16px',
          paddingTop: '12px',
          borderTop: '1px solid #e9ecef'
        }}>
          <button
            onClick={onClose}
            style={{
              background: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 16px',
              fontSize: '14px',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
