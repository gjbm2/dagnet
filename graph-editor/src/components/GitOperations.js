import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { graphGitService } from '../services/graphGitService';
import { gitConfig } from '../config/gitConfig';
export default function GitOperations({ onGraphLoad, onGraphSave, currentGraph, currentGraphName }) {
    const [availableGraphs, setAvailableGraphs] = useState([]);
    const [branches, setBranches] = useState([]);
    const [selectedBranch, setSelectedBranch] = useState(gitConfig.branch);
    const [isLoading, setIsLoading] = useState(false);
    const [message, setMessage] = useState(null);
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
    const showMessage = (type, text) => {
        setMessage({ type, text });
        setTimeout(() => setMessage(null), 5000);
    };
    const loadBranches = async () => {
        setIsLoading(true);
        try {
            const result = await graphGitService.getBranches();
            if (result.success && result.data) {
                setBranches(result.data.map((branch) => branch.name));
            }
            else {
                showMessage('error', result.error || 'Failed to load branches');
            }
        }
        catch (error) {
            showMessage('error', 'Failed to load branches');
        }
        finally {
            setIsLoading(false);
        }
    };
    const loadAvailableGraphs = async () => {
        setIsLoading(true);
        try {
            const result = await graphGitService.getAvailableGraphs(selectedBranch);
            if (result.success && result.data) {
                setAvailableGraphs(result.data);
            }
            else {
                showMessage('error', result.error || 'Failed to load graphs');
            }
        }
        catch (error) {
            showMessage('error', 'Failed to load graphs');
        }
        finally {
            setIsLoading(false);
        }
    };
    const handleBranchChange = (branch) => {
        setSelectedBranch(branch);
        loadAvailableGraphs();
    };
    const handleLoadGraph = async (graphName) => {
        setIsLoading(true);
        try {
            const result = await graphGitService.getGraph(graphName, selectedBranch);
            if (result.success && result.data) {
                // Add the graph name to the metadata
                const graphData = {
                    ...result.data.content,
                    metadata: {
                        ...result.data.content.metadata,
                        name: graphName,
                        source: 'git',
                        branch: selectedBranch
                    }
                };
                onGraphLoad(graphData);
                showMessage('success', `Loaded graph ${graphName} from ${selectedBranch}`);
                setShowGraphList(false);
            }
            else {
                showMessage('error', result.error || 'Failed to load graph');
            }
        }
        catch (error) {
            showMessage('error', 'Failed to load graph');
        }
        finally {
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
            const result = await graphGitService.saveGraph(saveGraphName, currentGraph, saveCommitMessage, selectedBranch);
            if (result.success) {
                showMessage('success', `Saved graph ${saveGraphName} to ${selectedBranch}`);
                setShowSaveDialog(false);
                // Keep the values for next save instead of clearing them
                // setSaveGraphName('');
                // setSaveCommitMessage('');
                loadAvailableGraphs(); // Refresh the list
            }
            else {
                showMessage('error', result.error || 'Failed to save graph');
            }
        }
        catch (error) {
            showMessage('error', 'Failed to save graph');
        }
        finally {
            setIsLoading(false);
        }
    };
    const handleDeleteGraph = async (graphName) => {
        if (!confirm(`Are you sure you want to delete graph ${graphName}?`)) {
            return;
        }
        setIsLoading(true);
        try {
            const result = await graphGitService.deleteGraph(graphName, `Delete graph ${graphName}`, selectedBranch);
            if (result.success) {
                showMessage('success', `Deleted graph ${graphName}`);
                loadAvailableGraphs(); // Refresh the list
            }
            else {
                showMessage('error', result.error || 'Failed to delete graph');
            }
        }
        catch (error) {
            showMessage('error', 'Failed to delete graph');
        }
        finally {
            setIsLoading(false);
        }
    };
    return (_jsxs("div", { style: {
            background: '#f8f9fa',
            border: '1px solid #e9ecef',
            borderRadius: '8px',
            padding: '16px',
            marginBottom: '16px'
        }, children: [_jsxs("div", { style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '16px'
                }, children: [_jsx("h3", { style: { margin: 0, fontSize: '16px', fontWeight: '600' }, children: "Git Operations" }), _jsxs("div", { style: { display: 'flex', gap: '8px' }, children: [_jsxs("button", { onClick: () => setShowGraphList(!showGraphList), disabled: isLoading, style: {
                                    background: '#007bff',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '6px 12px',
                                    fontSize: '12px',
                                    cursor: isLoading ? 'not-allowed' : 'pointer',
                                    opacity: isLoading ? 0.6 : 1
                                }, children: [showGraphList ? 'Hide' : 'Show', " Graphs"] }), _jsx("button", { onClick: () => setShowSaveDialog(true), disabled: !currentGraph || isLoading, style: {
                                    background: '#28a745',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '6px 12px',
                                    fontSize: '12px',
                                    cursor: (!currentGraph || isLoading) ? 'not-allowed' : 'pointer',
                                    opacity: (!currentGraph || isLoading) ? 0.6 : 1
                                }, children: "Save Graph" })] })] }), _jsxs("div", { style: { marginBottom: '12px' }, children: [_jsx("label", { style: {
                            display: 'block',
                            fontSize: '12px',
                            fontWeight: '600',
                            marginBottom: '4px'
                        }, children: "Branch:" }), _jsx("select", { value: selectedBranch, onChange: (e) => handleBranchChange(e.target.value), disabled: isLoading, style: {
                            width: '100%',
                            padding: '6px 8px',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            fontSize: '12px',
                            background: 'white'
                        }, children: branches.map(branch => (_jsx("option", { value: branch, children: branch }, branch))) })] }), message && (_jsx("div", { style: {
                    padding: '8px 12px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    marginBottom: '12px',
                    background: message.type === 'error' ? '#f8d7da' : message.type === 'success' ? '#d4edda' : '#d1ecf1',
                    color: message.type === 'error' ? '#721c24' : message.type === 'success' ? '#155724' : '#0c5460',
                    border: `1px solid ${message.type === 'error' ? '#f5c6cb' : message.type === 'success' ? '#c3e6cb' : '#bee5eb'}`
                }, children: message.text })), showGraphList && (_jsxs("div", { style: {
                    background: 'white',
                    border: '1px solid #e9ecef',
                    borderRadius: '4px',
                    padding: '12px',
                    maxHeight: '200px',
                    overflowY: 'auto'
                }, children: [_jsxs("div", { style: {
                            fontSize: '12px',
                            fontWeight: '600',
                            marginBottom: '8px',
                            color: '#666'
                        }, children: ["Available Graphs (", availableGraphs.length, "):"] }), availableGraphs.length === 0 ? (_jsxs("div", { style: { fontSize: '11px', color: '#999', fontStyle: 'italic' }, children: ["No graphs found in ", selectedBranch] })) : (_jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: '4px' }, children: availableGraphs.map((graph, index) => (_jsxs("div", { style: {
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '6px 8px',
                                background: '#f8f9fa',
                                borderRadius: '3px',
                                fontSize: '11px'
                            }, children: [_jsxs("div", { style: { flex: 1 }, children: [_jsx("div", { style: { fontWeight: '500' }, children: graph.name }), _jsxs("div", { style: { color: '#666', fontSize: '10px' }, children: [graph.size, " bytes \u2022 ", graph.lastModified] })] }), _jsxs("div", { style: { display: 'flex', gap: '4px' }, children: [_jsx("button", { onClick: () => handleLoadGraph(graph.name), disabled: isLoading, style: {
                                                background: '#007bff',
                                                color: 'white',
                                                border: 'none',
                                                borderRadius: '3px',
                                                padding: '2px 6px',
                                                fontSize: '10px',
                                                cursor: isLoading ? 'not-allowed' : 'pointer',
                                                opacity: isLoading ? 0.6 : 1
                                            }, children: "Load" }), _jsx("button", { onClick: () => handleDeleteGraph(graph.name), disabled: isLoading, style: {
                                                background: '#dc3545',
                                                color: 'white',
                                                border: 'none',
                                                borderRadius: '3px',
                                                padding: '2px 6px',
                                                fontSize: '10px',
                                                cursor: isLoading ? 'not-allowed' : 'pointer',
                                                opacity: isLoading ? 0.6 : 1
                                            }, children: "Delete" })] })] }, index))) }))] })), showSaveDialog && (_jsx("div", { style: {
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
                }, children: _jsxs("div", { style: {
                        background: 'white',
                        borderRadius: '8px',
                        padding: '20px',
                        width: '400px',
                        maxWidth: '90vw'
                    }, children: [_jsx("h3", { style: { margin: '0 0 16px 0', fontSize: '16px' }, children: "Save Graph" }), _jsxs("div", { style: { marginBottom: '12px' }, children: [_jsx("label", { style: {
                                        display: 'block',
                                        fontSize: '12px',
                                        fontWeight: '600',
                                        marginBottom: '4px'
                                    }, children: "Graph Name:" }), _jsx("input", { type: "text", value: saveGraphName, onChange: (e) => setSaveGraphName(e.target.value), placeholder: currentGraphName ? currentGraphName : "my-graph", style: {
                                        width: '100%',
                                        padding: '6px 8px',
                                        border: '1px solid #ddd',
                                        borderRadius: '4px',
                                        fontSize: '12px',
                                        boxSizing: 'border-box'
                                    } })] }), _jsxs("div", { style: { marginBottom: '16px' }, children: [_jsx("label", { style: {
                                        display: 'block',
                                        fontSize: '12px',
                                        fontWeight: '600',
                                        marginBottom: '4px'
                                    }, children: "Commit Message:" }), _jsx("textarea", { value: saveCommitMessage, onChange: (e) => setSaveCommitMessage(e.target.value), placeholder: "Add new conversion funnel", style: {
                                        width: '100%',
                                        padding: '6px 8px',
                                        border: '1px solid #ddd',
                                        borderRadius: '4px',
                                        fontSize: '12px',
                                        minHeight: '60px',
                                        resize: 'vertical',
                                        boxSizing: 'border-box'
                                    } })] }), _jsxs("div", { style: {
                                display: 'flex',
                                gap: '8px',
                                justifyContent: 'flex-end'
                            }, children: [_jsx("button", { onClick: () => setShowSaveDialog(false), disabled: isLoading, style: {
                                        background: '#6c757d',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        padding: '6px 12px',
                                        fontSize: '12px',
                                        cursor: isLoading ? 'not-allowed' : 'pointer',
                                        opacity: isLoading ? 0.6 : 1
                                    }, children: "Cancel" }), _jsx("button", { onClick: handleSaveGraph, disabled: isLoading || !saveGraphName.trim() || !saveCommitMessage.trim(), style: {
                                        background: '#28a745',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        padding: '6px 12px',
                                        fontSize: '12px',
                                        cursor: (isLoading || !saveGraphName.trim() || !saveCommitMessage.trim()) ? 'not-allowed' : 'pointer',
                                        opacity: (isLoading || !saveGraphName.trim() || !saveCommitMessage.trim()) ? 0.6 : 1
                                    }, children: isLoading ? 'Saving...' : 'Save Graph' })] })] }) }))] }));
}
