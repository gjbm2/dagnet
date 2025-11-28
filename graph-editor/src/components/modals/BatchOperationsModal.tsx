import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { dataOperationsService } from '../../services/dataOperationsService';
import { LogFileService } from '../../services/logFileService';
import { sessionLogService } from '../../services/sessionLogService';
import toast from 'react-hot-toast';
import type { GraphData } from '../../types';
import './Modal.css';

export type BatchOperationType = 
  | 'get-from-files'
  | 'get-from-sources'
  | 'get-from-sources-direct'
  | 'put-to-files';

interface BatchItem {
  id: string;
  type: 'parameter' | 'case' | 'node';
  name: string;
  objectId: string;
  targetId: string;
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number;
  // Path notation (e.g., e.my-edge.p.mean, n.my-node.case)
  path: string;
  // Additional details for display
  edgeId?: string; // Human-readable edge ID
  edgeFrom?: string; // Source node ID/name
  edgeTo?: string; // Target node ID/name
  nodeId?: string; // Node ID/name (for cases/nodes)
  nodeLabel?: string; // Node label (for cases/nodes)
  source?: string; // Connection/source identifier
  // Availability flags
  hasFile: boolean;
  hasConnection: boolean;
}

interface BatchOperationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  operationType?: BatchOperationType; // Optional - can be selected in modal
  graph: GraphData | null;
  setGraph: (graph: GraphData | null) => void;
  window?: { start: string; end: string } | null;
}

interface OperationResult {
  item: BatchItem;
  success: boolean;
  skipped: boolean;
  error?: string;
  reason?: string;
}

/**
 * Batch Operations Modal
 * 
 * Allows users to:
 * - Select which parameters/cases/nodes to process
 * - Choose to create a log file
 * - Execute batch operations with progress tracking
 * - View summary of results
 */
export function BatchOperationsModal({
  isOpen,
  onClose,
  operationType: initialOperationType,
  graph,
  setGraph,
  window
}: BatchOperationsModalProps) {
  const { operations } = useTabContext();
  const [selectedOperationType, setSelectedOperationType] = useState<BatchOperationType>(
    initialOperationType || 'get-from-sources'
  );
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [createLog, setCreateLog] = useState(false);
  const [bustCache, setBustCache] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [results, setResults] = useState<OperationResult[]>([]);
  const [logContent, setLogContent] = useState<string>('');
  
  // CRITICAL: Use ref to track latest graph state during batch operations
  // Without this, rebalancing doesn't work because each iteration uses stale graph
  const graphRef = useRef(graph);

  // Update selected operation type when prop changes
  useEffect(() => {
    if (initialOperationType) {
      setSelectedOperationType(initialOperationType);
    }
  }, [initialOperationType]);
  
  // Keep graphRef in sync with graph prop
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  // Collect all items from graph (without filtering by operation type)
  const allItems = useMemo(() => {
    if (!graph) return [];

    const items: BatchItem[] = [];

    // Collect parameters from edges
    if (graph.edges) {
      for (const edge of graph.edges) {
        const edgeId = edge.uuid || edge.id || '';
        
        // Get source and target node names for display
        const fromNode = graph.nodes?.find((n: any) => n.uuid === edge.from || n.id === edge.from);
        const toNode = graph.nodes?.find((n: any) => n.uuid === edge.to || n.id === edge.to);
        const edgeFrom = fromNode?.id || fromNode?.label || edge.from || '';
        const edgeTo = toNode?.id || toNode?.label || edge.to || '';
        const edgeDisplayId = edge.id || edge.uuid || `${edgeFrom}→${edgeTo}`;

        // Probability parameter
        if (edge.p?.id && typeof edge.p.id === 'string') {
          const paramId = edge.p.id;
          const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
          const paramConnection = paramFile?.data?.connection;
          items.push({
            id: `param-${paramId}-p-${edgeId}`,
            type: 'parameter',
            name: `p: ${paramId}`,
            objectId: paramId,
            targetId: edgeId,
            paramSlot: 'p',
            path: `e.${edgeDisplayId}.p.mean`,
            edgeId: edgeDisplayId,
            edgeFrom,
            edgeTo,
            source: paramConnection || undefined,
            hasFile: !!paramFile,
            hasConnection: !!paramConnection
          });
        }

        // Cost GBP parameter
        if (edge.cost_gbp?.id && typeof edge.cost_gbp.id === 'string') {
          const paramId = edge.cost_gbp.id;
          const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
          const paramConnection = paramFile?.data?.connection;
          items.push({
            id: `param-${paramId}-cost_gbp-${edgeId}`,
            type: 'parameter',
            name: `cost_gbp: ${paramId}`,
            objectId: paramId,
            targetId: edgeId,
            paramSlot: 'cost_gbp',
            path: `e.${edgeDisplayId}.cost_gbp.mean`,
            edgeId: edgeDisplayId,
            edgeFrom,
            edgeTo,
            source: paramConnection || undefined,
            hasFile: !!paramFile,
            hasConnection: !!paramConnection
          });
        }

        // Cost Time parameter
        if (edge.cost_time?.id && typeof edge.cost_time.id === 'string') {
          const paramId = edge.cost_time.id;
          const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
          const paramConnection = paramFile?.data?.connection;
          items.push({
            id: `param-${paramId}-cost_time-${edgeId}`,
            type: 'parameter',
            name: `cost_time: ${paramId}`,
            objectId: paramId,
            targetId: edgeId,
            paramSlot: 'cost_time',
            path: `e.${edgeDisplayId}.cost_time.mean`,
            edgeId: edgeDisplayId,
            edgeFrom,
            edgeTo,
            source: paramConnection || undefined,
            hasFile: !!paramFile,
            hasConnection: !!paramConnection
          });
        }
      }
    }

    // Collect cases from nodes
    if (graph.nodes) {
      for (const node of graph.nodes) {
        const nodeId = node.uuid || node.id || '';

        // Case file
        if (node.case?.id && typeof node.case.id === 'string') {
          const caseId = node.case.id;
          const caseFile = fileRegistry.getFile(`case-${caseId}`);
          const caseConnection = caseFile?.data?.connection;
          const nodeDisplayId = node.id || node.label || nodeId;
          items.push({
            id: `case-${caseId}-${nodeId}`,
            type: 'case',
            name: `case: ${caseId}`,
            objectId: caseId,
            targetId: nodeId,
            path: `n.${nodeDisplayId}.case`,
            nodeLabel: nodeDisplayId,
            source: caseConnection || undefined,
            hasFile: !!caseFile,
            hasConnection: !!caseConnection
          });
        }

        // Node file
        if (node.id && typeof node.id === 'string') {
          const nodeFileId = node.id;
          const nodeDisplayId = node.id || node.label || nodeId;
          const nodeFile = fileRegistry.getFile(`node-${nodeFileId}`);
          items.push({
            id: `node-${nodeFileId}-${nodeId}`,
            type: 'node',
            name: `node: ${nodeFileId}`,
            objectId: nodeFileId,
            targetId: nodeId,
            path: `n.${nodeDisplayId}`,
            nodeLabel: nodeDisplayId,
            hasFile: !!nodeFile,
            hasConnection: false // Nodes don't have connections
          });
        }
      }
    }

    return items;
  }, [graph]);

  // Filter items based on selected operation type
  const batchItems = useMemo(() => {
    return allItems.filter(item => {
      switch (selectedOperationType) {
        case 'get-from-files':
          // Only show items that have a file to read from
          return item.hasFile;
        case 'get-from-sources':
          // Only show items that have a connection defined
          return item.hasConnection;
        case 'get-from-sources-direct':
          // Only parameters (direct mode doesn't need param files, uses edge connection)
          return item.type === 'parameter';
        case 'put-to-files':
          // Show all items - we can always write to files
          return true;
        default:
          return true;
      }
    });
  }, [allItems, selectedOperationType]);

  // Use selectedOperationType for operations
  const operationType = selectedOperationType;

  // Initialize selected items when modal opens or operation type changes
  useEffect(() => {
    if (isOpen) {
      // All items in batchItems are valid for the selected operation
      setSelectedItems(new Set(batchItems.map(item => item.id)));
      setCreateLog(false);
      setBustCache(false);
      setProgress({ current: 0, total: 0 });
      setResults([]);
      setLogContent('');
    } else {
      setSelectedItems(new Set());
      setCreateLog(false);
      setBustCache(false);
      setProgress({ current: 0, total: 0 });
      setResults([]);
      setLogContent('');
    }
  }, [isOpen, batchItems]);

  const handleItemToggle = (itemId: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedItems(new Set(batchItems.map(item => item.id)));
  };

  const handleDeselectAll = () => {
    setSelectedItems(new Set());
  };

  const executeOperation = async () => {
    if (!graph || selectedItems.size === 0) return;

    setIsProcessing(true);
    setProgress({ current: 0, total: selectedItems.size });
    setResults([]);

    const selectedBatchItems = batchItems.filter(item => selectedItems.has(item.id));
    const operationResults: OperationResult[] = [];

    const logLines: string[] = [];
    logLines.push(`Batch Operation: ${operationType}`);
    logLines.push(`Started: ${new Date().toISOString()}`);
    logLines.push(`Total items: ${selectedBatchItems.length}`);
    logLines.push('');
    logLines.push('Results:');
    logLines.push('');

    // Map operation type to human-readable name
    const operationNames: Record<BatchOperationType, string> = {
      'get-from-files': 'Get All from Files',
      'get-from-sources': 'Get All from Sources (versioned)',
      'get-from-sources-direct': 'Get All from Sources (direct)',
      'put-to-files': 'Put All to Files'
    };
    
    // Start hierarchical session log operation
    const logOpId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      `BATCH_${operationType.toUpperCase().replace(/-/g, '_')}`,
      `${operationNames[operationType]}: ${selectedBatchItems.length} items`,
      {
        filesAffected: selectedBatchItems.map(item => item.objectId)
      }
    );

    // Show progress bar toast (only if not logging to file, or show both)
    let progressToastId: string | undefined;
    if (!createLog) {
      progressToastId = toast.loading(
        `Processing 0/${selectedBatchItems.length}...`,
        { duration: Infinity }
      );
    }
    
    // CRITICAL: Wrap setGraph to also update graphRef
    // This ensures rebalancing works correctly across iterations
    const setGraphWithRef = (newGraph: GraphData | null) => {
      graphRef.current = newGraph;
      setGraph(newGraph);
    };

    for (let i = 0; i < selectedBatchItems.length; i++) {
      const item = selectedBatchItems[i];
      setProgress({ current: i + 1, total: selectedBatchItems.length });

      // Update progress bar toast (suppress individual item toasts)
      if (progressToastId) {
        toast.loading(
          `Processing ${i + 1}/${selectedBatchItems.length}: ${item.name}`,
          { id: progressToastId, duration: Infinity }
        );
      }

      try {
        let success = false;
        let error: string | undefined;
        let details: string | undefined; // Store operation details for logging

        if (operationType === 'get-from-files') {
          if (item.type === 'parameter') {
            // Get edge before operation to compare
            // CRITICAL: Use graphRef.current for latest state
            const edgeBefore = graphRef.current?.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
            const paramBefore = edgeBefore?.[item.paramSlot || 'p'];
            
            await dataOperationsService.getParameterFromFile({
              paramId: item.objectId,
              edgeId: item.targetId,
              graph: graphRef.current,
              setGraph: setGraphWithRef,
              window: window || undefined
            });
            
            // Get edge after operation to extract details
            const edgeAfter = graphRef.current?.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
            const paramAfter = edgeAfter?.[item.paramSlot || 'p'];
            
            if (paramAfter) {
              const evidence = paramAfter.evidence;
              const parts: string[] = [];
              if (evidence?.n !== undefined) parts.push(`n=${evidence.n}`);
              if (evidence?.k !== undefined) parts.push(`k=${evidence.k}`);
              if (evidence?.window_from && evidence?.window_to) {
                const from = new Date(evidence.window_from).toISOString().split('T')[0];
                const to = new Date(evidence.window_to).toISOString().split('T')[0];
                parts.push(`window=${from} to ${to}`);
              }
              if (evidence?.source) parts.push(`source=${evidence.source}`);
              if (paramAfter.mean !== undefined) parts.push(`p=${(paramAfter.mean * 100).toFixed(2)}%`);
              
              details = parts.length > 0 ? ` → ${parts.join(', ')}` : '';
            }
            
            success = true;
          } else if (item.type === 'case') {
            await dataOperationsService.getCaseFromFile({
              caseId: item.objectId,
              nodeId: item.targetId,
              graph: graphRef.current,
              setGraph: setGraphWithRef
            });
            success = true;
          } else if (item.type === 'node') {
            await dataOperationsService.getNodeFromFile({
              nodeId: item.objectId,
              graph: graphRef.current,
              setGraph: setGraphWithRef
            });
            success = true;
          }
        } else if (operationType === 'get-from-sources') {
          if (item.type === 'parameter') {
            // Get edge before operation
            const edgeBefore = graphRef.current?.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
            const paramBefore = edgeBefore?.[item.paramSlot || 'p'];
            
            await dataOperationsService.getFromSource({
              objectType: 'parameter',
              objectId: item.objectId,
              targetId: item.targetId,
              graph: graphRef.current,
              setGraph: setGraphWithRef,
              paramSlot: item.paramSlot,
              bustCache,
              currentDSL: graphRef.current?.currentQueryDSL || ''
            });
            
            // Get edge after operation to extract details
            const edgeAfter = graphRef.current?.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
            const paramAfter = edgeAfter?.[item.paramSlot || 'p'];
            
            if (paramAfter) {
              const evidence = paramAfter.evidence;
              const parts: string[] = [];
              if (evidence?.n !== undefined) parts.push(`n=${evidence.n}`);
              if (evidence?.k !== undefined) parts.push(`k=${evidence.k}`);
              if (evidence?.window_from && evidence?.window_to) {
                const from = new Date(evidence.window_from).toISOString().split('T')[0];
                const to = new Date(evidence.window_to).toISOString().split('T')[0];
                parts.push(`window=${from} to ${to}`);
              }
              if (evidence?.source) parts.push(`source=${evidence.source}`);
              if (paramAfter.mean !== undefined) parts.push(`p=${(paramAfter.mean * 100).toFixed(2)}%`);
              
              details = parts.length > 0 ? ` → ${parts.join(', ')}` : '';
            }
            
            success = true;
          } else if (item.type === 'case') {
            await dataOperationsService.getFromSource({
              objectType: 'case',
              objectId: item.objectId,
              targetId: item.targetId,
              graph: graphRef.current,
              setGraph: setGraphWithRef,
              currentDSL: graphRef.current?.currentQueryDSL || ''
            });
            success = true;
          }
        } else if (operationType === 'get-from-sources-direct') {
          if (item.type === 'parameter') {
            // Get edge before operation
            const edgeBefore = graphRef.current?.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
            const paramBefore = edgeBefore?.[item.paramSlot || 'p'];
            
            await dataOperationsService.getFromSourceDirect({
              objectType: 'parameter',
              objectId: '',
              targetId: item.targetId,
              graph: graphRef.current,
              setGraph: setGraphWithRef,
              paramSlot: item.paramSlot,
              dailyMode: false,
              bustCache,
              currentDSL: graphRef.current?.currentQueryDSL || ''
            });
            
            // Get edge after operation to extract details
            const edgeAfter = graphRef.current?.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
            const paramAfter = edgeAfter?.[item.paramSlot || 'p'];
            
            if (paramAfter) {
              const evidence = paramAfter.evidence;
              const parts: string[] = [];
              if (evidence?.n !== undefined) parts.push(`n=${evidence.n}`);
              if (evidence?.k !== undefined) parts.push(`k=${evidence.k}`);
              if (evidence?.window_from && evidence?.window_to) {
                const from = new Date(evidence.window_from).toISOString().split('T')[0];
                const to = new Date(evidence.window_to).toISOString().split('T')[0];
                parts.push(`window=${from} to ${to}`);
              }
              if (evidence?.source) parts.push(`source=${evidence.source}`);
              if (paramAfter.mean !== undefined) parts.push(`p=${(paramAfter.mean * 100).toFixed(2)}%`);
              
              details = parts.length > 0 ? ` → ${parts.join(', ')}` : '';
            }
            
            success = true;
          }
        } else if (operationType === 'put-to-files') {
          if (item.type === 'parameter') {
            await dataOperationsService.putParameterToFile({
              paramId: item.objectId,
              edgeId: item.targetId,
              graph: graphRef.current,
              setGraph: setGraphWithRef
            });
            details = ` → Written to parameter-${item.objectId}.yaml`;
            success = true;
          } else if (item.type === 'case') {
            await dataOperationsService.putCaseToFile({
              caseId: item.objectId,
              nodeId: item.targetId,
              graph: graphRef.current,
              setGraph: setGraphWithRef
            });
            details = ` → Written to case-${item.objectId}.yaml`;
            success = true;
          } else if (item.type === 'node') {
            await dataOperationsService.putNodeToFile({
              nodeId: item.objectId,
              graph: graphRef.current,
              setGraph: setGraphWithRef
            });
            details = ` → Written to node-${item.objectId}.yaml`;
            success = true;
          }
        }

        operationResults.push({
          item,
          success,
          skipped: false,
          error
        });

        // Build detailed log line with context
        const statusIcon = success ? '✓' : '✗';
        const statusText = success ? 'Success' : (error || 'Failed');
        
        // Build context info
        const contextParts: string[] = [];
        if (item.type === 'parameter' && item.edgeFrom && item.edgeTo) {
          contextParts.push(`Edge: ${item.edgeFrom} → ${item.edgeTo}`);
        }
        if (item.paramSlot) {
          contextParts.push(`Slot: ${item.paramSlot}`);
        }
        if (item.type === 'case' || item.type === 'node') {
          if (item.nodeLabel) {
            contextParts.push(`Node: ${item.nodeLabel}`);
          }
        }
        
        const contextText = contextParts.length > 0 ? ` (${contextParts.join(', ')})` : '';
        const detailText = details || '';
        logLines.push(`${statusIcon} ${item.name}${contextText}${detailText} (${statusText})`);

        // Add child to hierarchical session log
        sessionLogService.addChild(
          logOpId,
          success ? 'success' : 'error',
          success ? 'ITEM_SUCCESS' : 'ITEM_ERROR',
          `${item.name}${detailText}`,
          contextText ? contextText.slice(2, -1) : undefined, // Remove leading " (" and trailing ")"
          {
            fileId: item.objectId,
            fileType: item.type
          }
        );

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        operationResults.push({
          item,
          success: false,
          skipped: false,
          error: errorMessage
        });
        logLines.push(`✗ ${item.name}: ${errorMessage}`);
        
        // Log error to hierarchical session log
        sessionLogService.addChild(
          logOpId,
          'error',
          'ITEM_ERROR',
          `${item.name} failed`,
          errorMessage,
          {
            fileId: item.objectId,
            fileType: item.type
          }
        );
      }
    }

    setResults(operationResults);
    
    const successCount = operationResults.filter(r => r.success).length;
    const skippedCount = operationResults.filter(r => r.skipped).length;
    const errorCount = operationResults.filter(r => !r.success && !r.skipped).length;
    
    // End hierarchical session log operation
    sessionLogService.endOperation(
      logOpId,
      errorCount > 0 ? 'warning' : 'success',
      `${operationNames[operationType]} complete: ${successCount} succeeded, ${errorCount} failed`,
      {
        added: successCount,
        errors: errorCount,
        skipped: skippedCount
      }
    );
    
    // Build final log content as plain text
    const finalLogContent = logLines.join('\n') + '\n\n' + 
      `Summary:\n` +
      `  ✓ Success: ${successCount}\n` +
      (skippedCount > 0 ? `  ⊘ Skipped: ${skippedCount}\n` : '') +
      (errorCount > 0 ? `  ✗ Failed: ${errorCount}\n` : '') +
      `\nCompleted: ${new Date().toISOString()}`;
    
    setLogContent(finalLogContent);

    // Dismiss progress toast
    if (progressToastId) {
      toast.dismiss(progressToastId);
    }

    // Show summary toast (suppress if logging to file, or show brief summary)
    if (!createLog) {
      const summaryParts: string[] = [];
      if (successCount > 0) summaryParts.push(`${successCount} updated`);
      if (skippedCount > 0) summaryParts.push(`${skippedCount} skipped`);
      if (errorCount > 0) summaryParts.push(`${errorCount} failed`);
      
      toast.success(
        summaryParts.length > 0 
          ? summaryParts.join(', ')
          : 'Batch operation complete',
        { duration: 3000 }
      );
    } else {
      // Brief summary even when logging
      const summaryParts: string[] = [];
      if (successCount > 0) summaryParts.push(`${successCount} updated`);
      if (skippedCount > 0) summaryParts.push(`${skippedCount} skipped (overridden)`);
      if (errorCount > 0) summaryParts.push(`${errorCount} failed`);
      
      toast.success(
        summaryParts.length > 0 
          ? summaryParts.join(', ')
          : 'Complete - see log file',
        { duration: 2000 }
      );
    }

    setIsProcessing(false);

    // Open log in new tab if requested
    if (createLog && finalLogContent) {
      try {
        await LogFileService.createLogFile(
          finalLogContent,
          operations,
          `Batch Operation Log ${new Date().toISOString().split('T')[0]}`
        );
      } catch (error) {
        console.error('[BatchOperationsModal] Failed to create log file:', error);
        toast.error('Failed to create log file');
      }
    }

    // Close modal after operation completes
    onClose();
  };

  if (!isOpen) return null;

  const selectedCount = selectedItems.size;
  const totalCount = batchItems.length;

  const buttonText = isProcessing 
    ? 'Processing...' 
    : operationType === 'get-from-files'
    ? `Get ${selectedCount} from Files`
    : operationType === 'get-from-sources'
    ? `Get ${selectedCount} from Sources`
    : operationType === 'get-from-sources-direct'
    ? `Get ${selectedCount} from Sources (direct)`
    : `Put ${selectedCount} to Files`;

  const modalContent = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '80vw', width: 'auto' }}>
        <div className="modal-header">
          <h2 className="modal-title">Batch Data Operations</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {isProcessing ? (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: '16px', marginBottom: '20px' }}>
                Processing {progress.current} of {progress.total}...
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: '#e0e0e0', borderRadius: '4px', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${(progress.current / progress.total) * 100}%`,
                    height: '100%',
                    backgroundColor: '#0066cc',
                    transition: 'width 0.3s ease'
                  }}
                />
              </div>
            </div>
          ) : (
            <>
              {/* Operation Type Selector */}
              <div style={{ marginBottom: '20px' }}>
                <label className="modal-label" style={{ display: 'block', marginBottom: '8px' }}>Operation</label>
                <select
                  value={selectedOperationType}
                  onChange={(e) => {
                    setSelectedOperationType(e.target.value as BatchOperationType);
                    setSelectedItems(new Set()); // Reset selection when changing operation
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    fontSize: '14px',
                    border: '1px solid #ddd',
                    borderRadius: '6px',
                    backgroundColor: 'white',
                    cursor: 'pointer'
                  }}
                >
                  <option value="get-from-sources">Get from Sources (versioned)</option>
                  <option value="get-from-sources-direct">Get from Sources (direct)</option>
                  <option value="get-from-files">Get from Files</option>
                  <option value="put-to-files">Put to Files</option>
                </select>
              </div>

              {/* Summary */}
              <div style={{ marginBottom: '20px', padding: '12px', backgroundColor: '#f5f5f5', borderRadius: '6px' }}>
                <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '4px' }}>
                  {totalCount} item{totalCount !== 1 ? 's' : ''} available for this operation
                </div>
                <div style={{ fontSize: '13px', color: '#666' }}>
                  {selectedCount} selected
                </div>
              </div>

              {/* Items list */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label className="modal-label">Select items to process</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      onClick={handleSelectAll}
                      style={{
                        fontSize: '12px',
                        padding: '4px 8px',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        background: 'white',
                        cursor: 'pointer'
                      }}
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={handleDeselectAll}
                      style={{
                        fontSize: '12px',
                        padding: '4px 8px',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        background: 'white',
                        cursor: 'pointer'
                      }}
                    >
                      Deselect All
                    </button>
                  </div>
                </div>

                <div style={{
                  border: '1px solid #e0e0e0',
                  borderRadius: '6px',
                  maxHeight: '400px',
                  overflowY: 'auto',
                  overflowX: 'auto'
                }}>
                  {batchItems.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                      No items available for this operation
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e0e0e0', backgroundColor: '#f9f9f9' }}>
                          <th style={{ padding: '8px', textAlign: 'left', width: '30px' }}>
                            <input
                              type="checkbox"
                              checked={selectedItems.size > 0 && selectedItems.size === batchItems.length}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  handleSelectAll();
                                } else {
                                  handleDeselectAll();
                                }
                              }}
                              style={{ cursor: 'pointer' }}
                            />
                          </th>
                          <th style={{ padding: '8px', textAlign: 'left', fontWeight: '500' }}>Path</th>
                          <th style={{ padding: '8px', textAlign: 'left', fontWeight: '500' }}>From → To</th>
                          <th style={{ padding: '8px', textAlign: 'left', fontWeight: '500' }}>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batchItems.map(item => {
                          const isSelected = selectedItems.has(item.id);
                          return (
                            <tr
                              key={item.id}
                              style={{
                                borderBottom: '1px solid #f0f0f0',
                                cursor: 'pointer',
                                backgroundColor: isSelected ? '#f0f7ff' : 'transparent'
                              }}
                              onClick={() => handleItemToggle(item.id)}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = isSelected ? '#e6f2ff' : '#f9f9f9';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = isSelected ? '#f0f7ff' : 'transparent';
                              }}
                            >
                              <td style={{ padding: '8px' }}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => handleItemToggle(item.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ cursor: 'pointer' }}
                                />
                              </td>
                              <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '12px' }}>
                                {item.path}
                              </td>
                              <td style={{ padding: '8px', color: '#666', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>
                                {item.edgeFrom && item.edgeTo ? `${item.edgeFrom} → ${item.edgeTo}` : item.nodeLabel || '-'}
                              </td>
                              <td style={{ padding: '8px', color: '#666', fontFamily: 'monospace', fontSize: '12px' }}>
                                {item.source || '-'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Create log checkbox */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={createLog}
                    onChange={(e) => setCreateLog(e.target.checked)}
                    style={{ marginRight: '8px' }}
                  />
                  <span style={{ fontSize: '14px' }}>Create log file</span>
                </label>
              </div>

              {/* Bust cache checkbox (only show for get-from-sources operations) */}
              {(operationType === 'get-from-sources' || operationType === 'get-from-sources-direct') && (
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={bustCache}
                      onChange={(e) => setBustCache(e.target.checked)}
                      style={{ marginRight: '8px' }}
                    />
                    <span style={{ fontSize: '14px' }}>
                      Bust cache (re-fetch all dates, even if already cached)
                    </span>
                  </label>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={onClose}
            disabled={isProcessing}
          >
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={executeOperation}
            disabled={isProcessing || selectedItems.size === 0}
          >
            {buttonText}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
