/**
 * useURLScenarios Hook
 * 
 * Parses URL parameters for scenario creation:
 * - `scenarios=` - DSL expressions to create live scenarios (semicolon-separated or compound)
 * - `hidecurrent` - Hide the Current layer in scenarios panel
 * 
 * Examples:
 * - ?scenarios=context(channel:google);context(channel:meta) - Create 2 specific scenarios
 * - ?scenarios=context(channel) - Create 1 scenario per channel value (bare key expansion)
 * - ?scenarios=window(-7d:-1d) - Create window scenario
 * - ?hidecurrent - Hide Current layer
 * 
 * Design Reference: docs/current/project-live-scenarios/design.md §5.2, §5.4
 */

import { useEffect, useRef, useCallback } from 'react';
import { explodeDSL } from '../lib/dslExplosion';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import toast from 'react-hot-toast';

interface URLScenariosParams {
  scenariosParam: string | null;
  hideCurrent: boolean;
  graphParam: string | null; // The graph specified in URL (to match against fileId)
}

// Global flag to prevent multiple tabs from processing URL params
let urlScenariosProcessed = false;

/**
 * Parse URL parameters for scenarios
 */
export function parseURLScenariosParams(): URLScenariosParams {
  const searchParams = new URLSearchParams(window.location.search);
  return {
    scenariosParam: searchParams.get('scenarios'),
    hideCurrent: searchParams.has('hidecurrent'),
    graphParam: searchParams.get('graph'),
  };
}

/**
 * Reset the global processing flag (for testing or manual reset)
 */
export function resetURLScenariosProcessed(): void {
  urlScenariosProcessed = false;
}

/**
 * Clean scenario-related parameters from URL
 */
export function cleanURLScenariosParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('scenarios');
  url.searchParams.delete('hidecurrent');
  window.history.replaceState({}, document.title, url.toString());
}

/**
 * Hook to process URL scenario parameters after graph loads
 * 
 * @param graphLoaded - Whether the graph has finished loading
 * @param fileId - Current file ID (to ensure we're on the right graph)
 */
export function useURLScenarios(graphLoaded: boolean, fileId: string | undefined) {
  const scenariosContext = useScenariosContextOptional();
  const { activeTabId, operations } = useTabContext();
  const processedRef = useRef(false);
  const paramsRef = useRef<URLScenariosParams | null>(null);

  // Parse params on mount (before graph loads)
  useEffect(() => {
    if (!paramsRef.current) {
      paramsRef.current = parseURLScenariosParams();
    }
  }, []);

  // Check if graph is actually available in scenarios context
  // The graph comes from graphStore, which syncs asynchronously
  const graphAvailable = scenariosContext?.graph !== null && scenariosContext?.graph !== undefined;
  
  // Check if scenarios have finished loading from IndexedDB
  // We MUST wait for this to avoid race conditions where we create a scenario
  // and then the load effect overwrites it with empty state
  const scenariosReady = scenariosContext?.scenariosReady ?? false;

  // Process scenarios after graph loads
  useEffect(() => {
    if (!graphLoaded || !fileId || processedRef.current) return;
    if (!paramsRef.current?.scenariosParam && !paramsRef.current?.hideCurrent) return;
    if (!scenariosContext || !activeTabId) return;
    
    // CRITICAL: Check global flag to prevent multiple tabs from processing
    // This can happen when multiple tabs are open and URL params are present
    if (urlScenariosProcessed) {
      console.log('[useURLScenarios] URL params already processed by another tab, skipping');
      processedRef.current = true; // Mark this instance as "done" too
      return;
    }
    
    // CRITICAL: Only process if this tab matches the graph specified in URL
    // If ?graph=sample-graph is in URL, only the tab with fileId matching should process
    // Note: fileId may have a type prefix like "graph-sample-graph" while URL param is just "sample-graph"
    const graphParam = paramsRef.current?.graphParam;
    if (graphParam) {
      // Check both exact match and prefixed match (e.g., "graph-sample-graph" matches "sample-graph")
      const matchesExact = fileId === graphParam;
      const matchesPrefixed = fileId === `graph-${graphParam}`;
      if (!matchesExact && !matchesPrefixed) {
        console.log(`[useURLScenarios] fileId "${fileId}" doesn't match graph param "${graphParam}", skipping`);
        return;
      }
    }
    
    // CRITICAL: Wait for graph to be available in scenarios context
    // The graphStore syncs asynchronously, so we need to wait
    if (!graphAvailable) {
      console.log('[useURLScenarios] Waiting for graph to be available in scenarios context...');
      return;
    }
    
    // CRITICAL: Wait for scenarios to finish loading from IndexedDB
    // This prevents race conditions where we create a scenario and then
    // the load effect overwrites our state with empty IndexedDB data
    if (!scenariosReady) {
      console.log('[useURLScenarios] Waiting for scenarios to finish loading from IndexedDB...');
      return;
    }

    const processURLScenarios = async () => {
      const params = paramsRef.current!;
      
      // Set global flag FIRST to prevent other tabs from processing
      urlScenariosProcessed = true;
      processedRef.current = true;
      
      // Track created scenario IDs across both operations
      const createdIds: string[] = [];

      try {
        // Process scenarios parameter
        if (params.scenariosParam) {
          console.log(`[useURLScenarios] Processing scenarios param: "${params.scenariosParam}"`);
          
          // URL-decode the parameter
          const decodedParam = decodeURIComponent(params.scenariosParam);
          
          // Explode compound DSL into atomic slices
          const slices = await explodeDSL(decodedParam);
          
          if (slices.length === 0) {
            console.warn('[useURLScenarios] No valid slices from scenarios param');
            toast.error('Invalid scenarios parameter in URL');
          } else {
            // Build a map of existing scenarios by DSL for deduplication
            const existingByDSL = new Map<string, string>(); // DSL -> scenario ID
            for (const s of (scenariosContext.scenarios || [])) {
              if (s.meta?.queryDSL) {
                existingByDSL.set(s.meta.queryDSL, s.id);
              }
            }
            
            // Separate slices into existing (need visibility) and new (need creation)
            const existingIds: string[] = [];
            const newSlices: string[] = [];
            
            for (const slice of slices) {
              const existingId = existingByDSL.get(slice);
              if (existingId) {
                console.log(`[useURLScenarios] Found existing scenario for DSL: "${slice}" (id: ${existingId})`);
                existingIds.push(existingId);
              } else {
                newSlices.push(slice);
              }
            }
            
            // Make existing scenarios visible (they may have been hidden or not visible after F5)
            if (existingIds.length > 0) {
              console.log(`[useURLScenarios] Making ${existingIds.length} existing scenarios visible`);
              await operations.addVisibleScenarios(activeTabId, existingIds);
              // Track these for hideCurrent logic below
              createdIds.push(...existingIds);
            }
            
            if (newSlices.length === 0 && existingIds.length > 0) {
              console.log('[useURLScenarios] All scenarios already exist, made them visible');
              toast.success(`${existingIds.length} scenarios restored`);
            } else if (newSlices.length > 0) {
              const skipped = slices.length - newSlices.length;
              console.log(`[useURLScenarios] Creating ${newSlices.length} scenarios from URL (${skipped} already exist)`);
              
              const toastId = toast.loading(`Creating ${newSlices.length} scenarios from URL...`);
              
              try {
                // Create scenarios sequentially (for proper compositing)
                for (let i = 0; i < newSlices.length; i++) {
                  const slice = newSlices[i];
                  toast.loading(`Creating scenario ${i + 1}/${newSlices.length}...`, { id: toastId });
                  
                  try {
                    const scenario = await scenariosContext.createLiveScenario(
                      slice,
                      undefined, // Use smart label
                      activeTabId
                    );
                    createdIds.push(scenario.id);
                    
                    // Regenerate the scenario
                    await scenariosContext.regenerateScenario(scenario.id, scenario);
                  } catch (err) {
                    console.error(`[useURLScenarios] Failed to create scenario for "${slice}":`, err);
                    // Continue with other scenarios
                  }
                }
                
                // Make all created scenarios visible
                if (createdIds.length > 0) {
                  await operations.addVisibleScenarios(activeTabId, createdIds);
                }
                
                toast.success(`Created ${createdIds.length} scenarios from URL`, { id: toastId });
              } catch (err) {
                console.error('[useURLScenarios] Failed to create scenarios:', err);
                toast.error('Failed to create scenarios from URL', { id: toastId });
              }
            }
          }
        }

        // Process hidecurrent parameter
        if (params.hideCurrent) {
          console.log('[useURLScenarios] Hiding Current layer');
          const scenarioState = operations.getScenarioState(activeTabId);
          if (scenarioState) {
            // Remove 'current' from visible scenarios
            // IMPORTANT: Include createdIds that may not have propagated to state yet
            const existingVisible = scenarioState.visibleScenarioIds.filter(id => id !== 'current');
            const newlyCreatedNotYetInState = createdIds.filter(id => !scenarioState.visibleScenarioIds.includes(id));
            const newVisible = [...existingVisible, ...newlyCreatedNotYetInState];
            await operations.setVisibleScenarios(activeTabId, newVisible);
          }
        }

        // Clean URL parameters
        cleanURLScenariosParams();
        
      } catch (err) {
        console.error('[useURLScenarios] Error processing URL scenarios:', err);
        toast.error('Failed to process URL scenario parameters');
      }
    };

    processURLScenarios();
  }, [graphLoaded, fileId, scenariosContext, activeTabId, operations, graphAvailable, scenariosReady]);

  return {
    hasURLScenarios: Boolean(paramsRef.current?.scenariosParam),
    hideCurrent: paramsRef.current?.hideCurrent ?? false,
  };
}

/**
 * Generate a URL with scenario parameters
 * 
 * @param scenarios - Array of DSL strings (will be joined with semicolons)
 * @param hideCurrent - Whether to hide the Current layer
 * @param baseUrl - Base URL (defaults to current location)
 */
export function generateScenariosURL(
  scenarios: string[],
  hideCurrent: boolean = false,
  baseUrl?: string
): string {
  try {
    const url = new URL(baseUrl || window.location.href);
    
    // Add scenarios parameter
    // Note: URLSearchParams.set automatically encodes, so don't double-encode
    if (scenarios.length > 0) {
      const scenariosParam = scenarios.join(';');
      url.searchParams.set('scenarios', scenariosParam);
    }
    
    // Add hidecurrent parameter
    if (hideCurrent) {
      url.searchParams.set('hidecurrent', '');
    }
    
    return url.toString();
  } catch (error) {
    console.error('Failed to generate scenarios URL:', error);
    return baseUrl || window.location.href;
  }
}

