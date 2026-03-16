/**
 * Graph → File sync operations (PUT direction).
 *
 * Writes data from graph edges/nodes back to parameter/case/node files.
 *
 * Extracted from dataOperationsService.ts (Cluster G) during slimdown.
 */

import toast from 'react-hot-toast';
import { fileRegistry } from '../../contexts/TabContext';
import { UpdateManager } from '../UpdateManager';
import type { Graph } from '../../types';
import type { PutToFileCopyOptions, PermissionCopyMode } from './types';
import { applyChanges } from './applyChanges';

const updateManager = new UpdateManager();

// =============================================================================
// putParameterToFile
// =============================================================================

export async function putParameterToFile(options: {
  paramId: string;
  edgeId?: string;
  graph: Graph | null;
  setGraph: (graph: Graph | null) => void;
  conditionalIndex?: number; // For conditional_p entries - which index to write from
  copyOptions?: PutToFileCopyOptions;
}): Promise<void> {
  const { paramId, edgeId, graph, conditionalIndex } = options;
  const includeValues = options.copyOptions?.includeValues !== false;
  const includeMetadata = options.copyOptions?.includeMetadata !== false;
  const permissionsMode: PermissionCopyMode = options.copyOptions?.permissionsMode ?? 'copy_all';
  
  console.log('[DataOperationsService] putParameterToFile CALLED:', {
    paramId,
    edgeId,
    conditionalIndex,
    includeValues,
    includeMetadata,
    permissionsMode,
    timestamp: new Date().toISOString()
  });
  
  try {
    // Validate inputs
    if (!graph) {
      toast.error('No graph loaded');
      return;
    }
    
    if (!edgeId) {
      toast.error('No edge selected');
      return;
    }
    
    // Find the source edge first (needed to determine parameter type if creating)
    const sourceEdge = graph.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
    if (!sourceEdge) {
      toast.error(`Edge not found in graph`);
      return;
    }
    
    // Check if file exists, create if missing
    let paramFile = fileRegistry.getFile(`parameter-${paramId}`);
    let isNewFile = false;
    if (!paramFile) {
      console.log(`[putParameterToFile] File not found, creating: ${paramId}`);
      isNewFile = true;
      
      // Determine parameter type from edge
      let paramType: 'probability' | 'cost_gbp' | 'labour_cost' = 'probability';
      if (sourceEdge.cost_gbp?.id === paramId) {
        paramType = 'cost_gbp';
      } else if (sourceEdge.labour_cost?.id === paramId) {
        paramType = 'labour_cost';
      }
      
      // Create file using fileOperationsService (handles registry update)
      const { fileOperationsService } = await import('../fileOperationsService');
      await fileOperationsService.createFile(paramId, 'parameter', {
        openInTab: false,
        metadata: { parameterType: paramType }
      });
      
      // Now get the created file
      paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (!paramFile) {
        toast.error(`Failed to create parameter file: ${paramId}`);
        return;
      }
      
      toast.success(`Created new parameter file: ${paramId}`);
    }
    // Determine which parameter slot this file corresponds to
    // (an edge can have p, cost_gbp, labour_cost, AND conditional_p[] - we only want to write ONE)
    let filteredEdge: any = { ...sourceEdge };
    
    // ===== CONDITIONAL_P HANDLING =====
    // For conditional parameters, extract data from conditional_p[conditionalIndex].p
    if (conditionalIndex !== undefined) {
      const condEntry = sourceEdge.conditional_p?.[conditionalIndex];
      if (!condEntry?.p) {
        toast.error(`Conditional entry [${conditionalIndex}] not found on edge`);
        return;
      }
      
      // Verify this conditional entry is connected to the paramId
      if (condEntry.p.id !== paramId) {
        // Also check if paramId matches when creating new file
        console.log('[DataOperationsService] putParameterToFile conditional_p - ID mismatch or new file:', {
          condPId: condEntry.p.id,
          paramId,
          isNewFile
        });
      }
      
      // Create a filtered edge with just the conditional probability data
      // We present it as { p: ... } so UpdateManager handles it correctly
      filteredEdge = { p: condEntry.p };
      console.log('[DataOperationsService] putParameterToFile - using conditional_p data:', {
        conditionalIndex,
        condition: condEntry.condition,
        pData: condEntry.p
      });
    }
    // ===== END CONDITIONAL_P HANDLING =====
    else if (sourceEdge.p?.id === paramId) {
      // Writing probability parameter - keep only p field
      // IMPORTANT: some parameter-file fields live on the EDGE (query/n_query + override flags),
      // so we must include them for UpdateManager graph→file mappings.
      const pClone = structuredClone(sourceEdge.p);

      // Control whether we copy permission flags (override flags) into the parameter file.
      // Defaults to copy_all to match current behaviour; caller can disable or make it one-way.
      if (permissionsMode !== 'copy_all') {
        // Query/N-query flags live on edge; latency flags live under p.latency.
        // When permissions are not copied, remove all overridden flags from the payload.
        // When copying only-if-false, only send true flags when the file isn't already locked.
        const targetFile = paramFile?.data;
        const targetLatency = targetFile?.latency ?? {};

        // Latency flags under p.latency
        if (pClone?.latency) {
          const srcLat = pClone.latency;
          const maybeKeepTrue = (flagKey: string, targetFlag: any) => {
            if (permissionsMode === 'do_not_copy') {
              delete srcLat[flagKey];
              return;
            }
            if (permissionsMode === 'copy_if_false') {
              if (targetFlag === true) {
                delete srcLat[flagKey];
                return;
              }
              if (srcLat[flagKey] === true) {
                // keep true (promote)
                return;
              }
              delete srcLat[flagKey];
            }
          };

          maybeKeepTrue('latency_parameter_overridden', targetLatency.latency_parameter_overridden);
          maybeKeepTrue('anchor_node_id_overridden', targetLatency.anchor_node_id_overridden);
          maybeKeepTrue('t95_overridden', targetLatency.t95_overridden);
          maybeKeepTrue('path_t95_overridden', targetLatency.path_t95_overridden);
        }
      }

      // IMPORTANT: For force-copy mode, we want the file to match the graph even when
      // the graph omits optional fields (treat omission as "cleared"/false).
      // Without this, UPDATE mappings will skip (sourceValue undefined) and stale file
      // values persist even under "Copy all (force copy)".
      const forceCopy = permissionsMode === 'copy_all';
      const effectiveQueryOverridden =
        forceCopy ? (sourceEdge.query_overridden === true) : sourceEdge.query_overridden;
      const effectiveNQuery =
        forceCopy ? (typeof sourceEdge.n_query === 'string' ? sourceEdge.n_query : '') : sourceEdge.n_query;
      const effectiveNQueryOverridden =
        forceCopy ? (sourceEdge.n_query_overridden === true) : sourceEdge.n_query_overridden;

      filteredEdge = {
        p: pClone,
        query: sourceEdge.query,
        query_overridden: effectiveQueryOverridden,
        n_query: effectiveNQuery,
        n_query_overridden: effectiveNQueryOverridden,
      };

      // If user requested no permission copying, remove edge-level override flags from payload.
      if (permissionsMode === 'do_not_copy') {
        delete filteredEdge.query_overridden;
        delete filteredEdge.n_query_overridden;
      } else if (permissionsMode === 'copy_if_false') {
        const targetFile = paramFile?.data;
        if (targetFile?.query_overridden === true || filteredEdge.query_overridden !== true) {
          delete filteredEdge.query_overridden;
        }
        if (targetFile?.n_query_overridden === true || filteredEdge.n_query_overridden !== true) {
          delete filteredEdge.n_query_overridden;
        }
      }
    } else if (sourceEdge.cost_gbp?.id === paramId) {
      // Writing cost_gbp parameter - keep only cost_gbp field
      filteredEdge = { cost_gbp: sourceEdge.cost_gbp };
    } else if (sourceEdge.labour_cost?.id === paramId) {
      // Writing labour_cost parameter - keep only labour_cost field
      filteredEdge = { labour_cost: sourceEdge.labour_cost };
    } else {
      toast.error(`Edge is not connected to parameter ${paramId}`);
      return;
    }
    
    // For NEW files: Use CREATE operation to initialize connection settings from edge
    // This copies connection, connection_string, and other metadata from the edge
    let createResult: any = null;
    if (isNewFile) {
      createResult = await updateManager.handleGraphToFile(
        filteredEdge,      // source (filtered to only relevant parameter)
        paramFile.data,    // target (parameter file)
        'CREATE',          // operation (initialize connection settings)
        'parameter',       // sub-destination
        { interactive: true, validateOnly: true }  // Don't apply in UpdateManager, we'll use applyChanges
      );
      
      if (!createResult.success) {
        console.warn('[DataOperationsService] CREATE operation failed for new parameter file:', createResult);
      }
    }
    
    // Call UpdateManager to transform data (validateOnly mode - don't apply yet)
    let result: any = null;
    if (includeValues) {
      result = await updateManager.handleGraphToFile(
        filteredEdge,      // source (filtered to only relevant parameter)
        paramFile.data,    // target (parameter file)
        'APPEND',          // operation (append to values[])
        'parameter',       // sub-destination
        { interactive: true, validateOnly: true }  // Don't apply in UpdateManager, we'll use applyChanges
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update file');
        return;
      }
    }
    
    // Also update connection settings (UPDATE operation, not APPEND)
    // Connection settings go to top-level fields, not values[]
    const ignoreOverrideFlags = permissionsMode === 'copy_all';
    const updateResult = includeMetadata
      ? await updateManager.handleGraphToFile(
          filteredEdge,      // source (filtered to only relevant parameter)
          paramFile.data,    // target (parameter file)
          'UPDATE',          // operation (update top-level fields)
          'parameter',       // sub-destination
          {
            interactive: true,
            validateOnly: true,
            ignoreOverrideFlags,
            allowPermissionFlagCopy: permissionsMode !== 'do_not_copy',
          }  // Explicit PUT: optionally copy permissions
        )
      : { success: true, changes: [] };
    
    // Apply changes to file data
    const updatedFileData = structuredClone(paramFile.data);
    console.log('[DataOperationsService] putParameterToFile - changes to apply:', {
      paramId,
      isNewFile,
      createChanges: createResult?.changes ? JSON.stringify(createResult.changes, null, 2) : 'none',
      appendChanges: result?.changes ? JSON.stringify(result.changes, null, 2) : 'none',
      updateChanges: updateResult.changes ? JSON.stringify(updateResult.changes, null, 2) : 'none'
    });
    
    // For new files: Apply CREATE changes first (connection settings)
    if (isNewFile && createResult?.success && createResult?.changes) {
      applyChanges(updatedFileData, createResult.changes);
    }
    
    // Apply APPEND changes (values[])
    if (includeValues && result?.changes) {
      applyChanges(updatedFileData, result.changes);
    }
    
    // Apply UPDATE changes (connection settings, etc.)
    if (updateResult.success && updateResult.changes) {
      applyChanges(updatedFileData, updateResult.changes);
    }
    console.log('[DataOperationsService] putParameterToFile - after applyChanges:', {
      'updatedFileData.values': JSON.stringify(updatedFileData.values, null, 2),
      'updatedFileData.connection': updatedFileData.connection,
      'updatedFileData.connection_string': updatedFileData.connection_string
    });
    
    console.log('[DataOperationsService] Before updateFile:', {
      fileId: `parameter-${paramId}`,
      wasDirty: paramFile.isDirty,
      isInitializing: paramFile.isInitializing
    });
    
    // Update file in registry and mark dirty
    await fileRegistry.updateFile(`parameter-${paramId}`, updatedFileData);
    
    // Check if it worked
    const updatedFile = fileRegistry.getFile(`parameter-${paramId}`);
    console.log('[DataOperationsService] After updateFile:', {
      fileId: `parameter-${paramId}`,
      isDirty: updatedFile?.isDirty,
      isInitializing: updatedFile?.isInitializing
    });
    
    toast.success(`✓ Updated ${paramId}.yaml`, { duration: 2000 });
    
  } catch (error) {
    console.error('[DataOperationsService] Failed to put parameter to file:', error);
    toast.error('Failed to put data to file');
  }
}


// =============================================================================
// putCaseToFile
// =============================================================================

export async function putCaseToFile(options: {
  caseId: string;
  nodeId?: string;
  graph: Graph | null;
  setGraph: (graph: Graph | null) => void;
}): Promise<void> {
  const { caseId, nodeId, graph } = options;
  
  try {
    if (!graph || !nodeId) {
      toast.error('No graph or node selected');
      return;
    }
    
    // Find the source node first
    const sourceNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId);
    if (!sourceNode) {
      toast.error(`Node not found in graph`);
      return;
    }
    
    // Check if file exists, create if missing
    let caseFile = fileRegistry.getFile(`case-${caseId}`);
    if (!caseFile) {
      console.log(`[putCaseToFile] File not found, creating: ${caseId}`);
      
      // Create file using fileOperationsService (handles registry update)
      const { fileOperationsService } = await import('../fileOperationsService');
      await fileOperationsService.createFile(caseId, 'case', {
        openInTab: false,
        metadata: {}
      });
      
      // Now get the created file
      caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        toast.error(`Failed to create case file: ${caseId}`);
        return;
      }
      
      toast.success(`Created new case file: ${caseId}`);
    }
    
    // Filter node to only include the relevant case data
    const filteredNode: any = { case: sourceNode.case };
    
    console.log('[putCaseToFile] Source node case data:', {
      hasCase: !!sourceNode.case,
      hasConnection: !!sourceNode.case?.connection,
      connection: sourceNode.case?.connection,
      connectionString: sourceNode.case?.connection_string,
      filteredNode
    });
    
    // 1) APPEND schedule entry from current variants (keeps history)
    const appendResult = await updateManager.handleGraphToFile(
      filteredNode,
      caseFile.data,
      'APPEND', // APPEND to case.schedules[]
      'case',
      { interactive: true, validateOnly: true } // Don't apply in UpdateManager, we'll use applyChanges
    );
    
    console.log('[putCaseToFile] APPEND result:', {
      success: appendResult.success,
      changesCount: appendResult.changes?.length,
      changes: appendResult.changes
    });
    
    if (!appendResult.success || !appendResult.changes) {
      toast.error('Failed to update case file (schedule)');
      return;
    }
    
    const updatedFileData = structuredClone(caseFile.data);
    applyChanges(updatedFileData, appendResult.changes);
    
    // 2) UPDATE case metadata (connection, etc.) at top level
    const updateResult = await updateManager.handleGraphToFile(
      filteredNode,
      updatedFileData,
      'UPDATE', // UPDATE case.variants + connection fields
      'case',
      { interactive: true, validateOnly: true }
    );
    
    console.log('[putCaseToFile] UPDATE result:', {
      success: updateResult.success,
      changesCount: updateResult.changes?.length,
      errorsCount: updateResult.errors?.length,
      changes: updateResult.changes,
      errors: updateResult.errors,
      updatedFileDataBefore: structuredClone(updatedFileData)
    });
    
    // Apply changes even if there were some errors (as long as we have changes)
    if (updateResult.changes && updateResult.changes.length > 0) {
      applyChanges(updatedFileData, updateResult.changes);
      console.log('[putCaseToFile] After applying UPDATE changes:', {
        hasConnection: !!updatedFileData.case?.connection,
        connection: updatedFileData.case?.connection,
        connectionString: updatedFileData.case?.connection_string
      });
      
      if (!updateResult.success) {
        console.warn('[putCaseToFile] Applied changes despite errors:', updateResult.errors);
      }
    }
    
    await fileRegistry.updateFile(`case-${caseId}`, updatedFileData);
    toast.success(`✓ Updated ${caseId}.yaml`, { duration: 2000 });
  } catch (error) {
    console.error('[DataOperationsService] Failed to put case to file:', error);
    toast.error('Failed to put case to file');
  }
}


// =============================================================================
// putNodeToFile
// =============================================================================

export async function putNodeToFile(options: {
  nodeId: string;
  graph: Graph | null;
  setGraph: (graph: Graph | null) => void;
}): Promise<void> {
  const { nodeId, graph } = options;
  
  try {
    if (!graph) {
      toast.error('No graph loaded');
      return;
    }
    // Mirror putParameterToFile behaviour: create file if missing.
    let nodeFile = fileRegistry.getFile(`node-${nodeId}`);
    let isNewFile = false;
    if (!nodeFile) {
      isNewFile = true;
      console.log(`[putNodeToFile] File not found, creating: ${nodeId}`);
      const { fileOperationsService } = await import('../fileOperationsService');
      await fileOperationsService.createFile(nodeId, 'node', { openInTab: false });
      nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`Failed to create node file: ${nodeId}`);
        return;
      }
      toast.success(`Created new node file: ${nodeId}`);
    }
    
    const sourceNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
    if (!sourceNode) {
      toast.error(`Node not found in graph`);
      return;
    }

    // For new files, run CREATE mappings first to initialise id/name/description/event_id.
    if (isNewFile) {
      const createResult = await updateManager.handleGraphToFile(
        sourceNode,
        nodeFile.data,
        'CREATE',
        'node',
        { interactive: true, validateOnly: true }
      );
      if (createResult.success && createResult.changes?.length) {
        const createdFileData = structuredClone(nodeFile.data);
        applyChanges(createdFileData, createResult.changes);
        await fileRegistry.updateFile(`node-${nodeId}`, createdFileData);
        // Refresh local ref for subsequent UPDATE
        nodeFile = fileRegistry.getFile(`node-${nodeId}`) || nodeFile;
      }
    }

    const result = await updateManager.handleGraphToFile(
      sourceNode,
      nodeFile.data,
      'UPDATE',
      'node',
      { interactive: true, validateOnly: true }
    );
    
    if (!result.success || !result.changes) {
      toast.error('Failed to update node file');
      return;
    }
    
    const updatedFileData = structuredClone(nodeFile.data);
    applyChanges(updatedFileData, result.changes);
    
    await fileRegistry.updateFile(`node-${nodeId}`, updatedFileData);
    
    toast.success(`✓ Updated ${nodeId}.yaml`, { duration: 2000 });
  } catch (error) {
    console.error('[DataOperationsService] Failed to put node to file:', error);
    toast.error('Failed to put node to file');
  }
}

