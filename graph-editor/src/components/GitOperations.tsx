import React, { useState, useEffect } from 'react';
import { graphGitService, GraphFile, GraphOperationResult } from '../services/graphGitService';
import { gitConfig } from '../config/gitConfig';

interface GitOperationsProps {
  onGraphLoad: (graphData: any) => void;
  onGraphSave: (graphName: string, graphData: any) => Promise<boolean>;
  currentGraph?: any;
  currentGraphName?: string;
}

export default function GitOperations({ 
  onGraphLoad, 
  onGraphSave, 
  currentGraph,
  currentGraphName 
}: GitOperationsProps) {
  const [availableGraphs, setAvailableGraphs] = useState<GraphFile[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>(gitConfig.branch);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [showGraphList, setShowGraphList] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveGraphName, setSaveGraphName] = useState(currentGraphName || '');
  const [saveCommitMessage, setSaveCommitMessage] = useState('');

  // Load available graphs and branches on mount
  useEffect(() => {
    loadBranches();
    loadAvailableGraphs();
  }, []);

  // Update saveGraphName when currentGraphName changes (e.g., when a graph is loaded)
  useEffect(() => {
    if (currentGraphName) {
      setSaveGraphName(currentGraphName);
    }
  }, [currentGraphName]);

  const showMessage = (type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const loadBranches = async () => {
    setIsLoading(true);
    try {
      const result = await graphGitService.getBranches();
      if (result.success && result.data) {
        setBranches(result.data.map((branch: any) => branch.name));
      } else {
        showMessage('error', result.error || 'Failed to load branches');
      }
    } catch (error) {
      showMessage('error', 'Failed to load branches');
    } finally {
      setIsLoading(false);
    }
  };

  const loadAvailableGraphs = async () => {
    setIsLoading(true);
    try {
      const result = await graphGitService.getAvailableGraphs(selectedBranch);
      if (result.success && result.data) {
        setAvailableGraphs(result.data);
      } else {
        showMessage('error', result.error || 'Failed to load graphs');
      }
    } catch (error) {
      showMessage('error', 'Failed to load graphs');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBranchChange = (branch: string) => {
    setSelectedBranch(branch);
    loadAvailableGraphs();
  };

  const handleLoadGraph = async (graphName: string) => {
    setIsLoading(true);
    try {
      const result = await graphGitService.getGraph(graphName, selectedBranch);
      if (result.success && result.data) {
        onGraphLoad(result.data.content);
        showMessage('success', `Loaded graph ${graphName} from ${selectedBranch}`);
        setShowGraphList(false);
      } else {
        showMessage('error', result.error || 'Failed to load graph');
      }
    } catch (error) {
      showMessage('error', 'Failed to load graph');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveGraph = async () => {
    if (!currentGraph) {
      showMessage('error', 'No graph to save');
      return;
    }

    if (!saveGraphName.trim()) {
      showMessage('error', 'Please enter a graph name');
      return;
    }

    if (!saveCommitMessage.trim()) {
      showMessage('error', 'Please enter a commit message');
      return;
    }

    setIsLoading(true);
    try {
      const result = await graphGitService.saveGraph(
        saveGraphName,
        currentGraph,
        saveCommitMessage,
        selectedBranch
      );
      
      if (result.success) {
        showMessage('success', `Saved graph ${saveGraphName} to ${selectedBranch}`);
        setShowSaveDialog(false);
        setSaveGraphName('');
        setSaveCommitMessage('');
        loadAvailableGraphs(); // Refresh the list
      } else {
        showMessage('error', result.error || 'Failed to save graph');
      }
    } catch (error) {
      showMessage('error', 'Failed to save graph');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteGraph = async (graphName: string) => {
    if (!confirm(`Are you sure you want to delete graph ${graphName}?`)) {
      return;
    }

    setIsLoading(true);
    try {
      const result = await graphGitService.deleteGraph(
        graphName,
        `Delete graph ${graphName}`,
        selectedBranch
      );
      
      if (result.success) {
        showMessage('success', `Deleted graph ${graphName}`);
        loadAvailableGraphs(); // Refresh the list
      } else {
        showMessage('error', result.error || 'Failed to delete graph');
      }
    } catch (error) {
      showMessage('error', 'Failed to delete graph');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ 
      background: '#f8f9fa', 
      border: '1px solid #e9ecef', 
      borderRadius: '8px', 
      padding: '16px',
      marginBottom: '16px'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: '16px'
      }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>
          Git Operations
        </h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setShowGraphList(!showGraphList)}
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
            {showGraphList ? 'Hide' : 'Show'} Graphs
          </button>
          <button
            onClick={() => setShowSaveDialog(true)}
            disabled={!currentGraph || isLoading}
            style={{
              background: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              padding: '6px 12px',
              fontSize: '12px',
              cursor: (!currentGraph || isLoading) ? 'not-allowed' : 'pointer',
              opacity: (!currentGraph || isLoading) ? 0.6 : 1
            }}
          >
            Save Graph
          </button>
        </div>
      </div>

      {/* Branch Selection */}
      <div style={{ marginBottom: '12px' }}>
        <label style={{ 
          display: 'block', 
          fontSize: '12px', 
          fontWeight: '600', 
          marginBottom: '4px' 
        }}>
          Branch:
        </label>
        <select
          value={selectedBranch}
          onChange={(e) => handleBranchChange(e.target.value)}
          disabled={isLoading}
          style={{
            width: '100%',
            padding: '6px 8px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            fontSize: '12px',
            background: 'white'
          }}
        >
          {branches.map(branch => (
            <option key={branch} value={branch}>{branch}</option>
          ))}
        </select>
      </div>

      {/* Message Display */}
      {message && (
        <div style={{
          padding: '8px 12px',
          borderRadius: '4px',
          fontSize: '12px',
          marginBottom: '12px',
          background: message.type === 'error' ? '#f8d7da' : message.type === 'success' ? '#d4edda' : '#d1ecf1',
          color: message.type === 'error' ? '#721c24' : message.type === 'success' ? '#155724' : '#0c5460',
          border: `1px solid ${message.type === 'error' ? '#f5c6cb' : message.type === 'success' ? '#c3e6cb' : '#bee5eb'}`
        }}>
          {message.text}
        </div>
      )}

      {/* Graph List */}
      {showGraphList && (
        <div style={{ 
          background: 'white', 
          border: '1px solid #e9ecef', 
          borderRadius: '4px', 
          padding: '12px',
          maxHeight: '200px',
          overflowY: 'auto'
        }}>
          <div style={{ 
            fontSize: '12px', 
            fontWeight: '600', 
            marginBottom: '8px',
            color: '#666'
          }}>
            Available Graphs ({availableGraphs.length}):
          </div>
          {availableGraphs.length === 0 ? (
            <div style={{ fontSize: '11px', color: '#999', fontStyle: 'italic' }}>
              No graphs found in {selectedBranch}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {availableGraphs.map((graph, index) => (
                <div key={index} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 8px',
                  background: '#f8f9fa',
                  borderRadius: '3px',
                  fontSize: '11px'
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '500' }}>{graph.name}</div>
                    <div style={{ color: '#666', fontSize: '10px' }}>
                      {graph.size} bytes • {graph.lastModified}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      onClick={() => handleLoadGraph(graph.name)}
                      disabled={isLoading}
                      style={{
                        background: '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        padding: '2px 6px',
                        fontSize: '10px',
                        cursor: isLoading ? 'not-allowed' : 'pointer',
                        opacity: isLoading ? 0.6 : 1
                      }}
                    >
                      Load
                    </button>
                    <button
                      onClick={() => handleDeleteGraph(graph.name)}
                      disabled={isLoading}
                      style={{
                        background: '#dc3545',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        padding: '2px 6px',
                        fontSize: '10px',
                        cursor: isLoading ? 'not-allowed' : 'pointer',
                        opacity: isLoading ? 0.6 : 1
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Save Dialog */}
      {showSaveDialog && (
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
            width: '400px',
            maxWidth: '90vw'
          }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px' }}>Save Graph</h3>
            
            <div style={{ marginBottom: '12px' }}>
              <label style={{ 
                display: 'block', 
                fontSize: '12px', 
                fontWeight: '600', 
                marginBottom: '4px' 
              }}>
                Graph Name:
              </label>
              <input
                type="text"
                value={saveGraphName}
                onChange={(e) => setSaveGraphName(e.target.value)}
                placeholder={currentGraphName ? currentGraphName : "my-graph"}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '12px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ 
                display: 'block', 
                fontSize: '12px', 
                fontWeight: '600', 
                marginBottom: '4px' 
              }}>
                Commit Message:
              </label>
              <textarea
                value={saveCommitMessage}
                onChange={(e) => setSaveCommitMessage(e.target.value)}
                placeholder="Add new conversion funnel"
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '12px',
                  minHeight: '60px',
                  resize: 'vertical',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ 
              display: 'flex', 
              gap: '8px', 
              justifyContent: 'flex-end' 
            }}>
              <button
                onClick={() => setShowSaveDialog(false)}
                disabled={isLoading}
                style={{
                  background: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.6 : 1
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveGraph}
                disabled={isLoading || !saveGraphName.trim() || !saveCommitMessage.trim()}
                style={{
                  background: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: (isLoading || !saveGraphName.trim() || !saveCommitMessage.trim()) ? 'not-allowed' : 'pointer',
                  opacity: (isLoading || !saveGraphName.trim() || !saveCommitMessage.trim()) ? 0.6 : 1
                }}
              >
                {isLoading ? 'Saving...' : 'Save Graph'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}