/**
 * ScenarioOverlayRenderer
 * 
 * Renders scenario overlays as additional edge layers with their own colours.
 * This component MUST be used inside ReactFlow's children to access the SVG viewport.
 * 
 * CURRENTLY NOT FUNCTIONAL - needs rewrite to compute paths properly
 */

import React, { useMemo } from 'react';
import { useReactFlow, getBezierPath } from 'reactflow';
import { useScenarioRendering } from '../hooks/useScenarioRendering';
import { Graph } from '../types';

interface ScenarioOverlayRendererProps {
  tabId?: string;
  graph: Graph | null;
}

/**
 * Renders scenario overlays for all visible scenarios
 * 
 * Each scenario is rendered as an SVG group containing paths for its edges.
 * The paths use the scenario's colour and blend mode for visual comparison.
 * 
 * TODO: This needs to compute edge paths using the same getBezierPath logic
 * as ConversionEdge, not query the DOM.
 */
export function ScenarioOverlayRenderer({ tabId, graph }: ScenarioOverlayRendererProps) {
  const { getNodes, getEdges } = useReactFlow();
  const { hasVisibleScenarios, scenarioRenderData, isEnabled } = useScenarioRendering(tabId, graph);
  
  const reactFlowNodes = getNodes();
  const reactFlowEdges = getEdges();
  
  // Compute overlay paths for each visible scenario
  const overlayPaths = useMemo(() => {
    if (!hasVisibleScenarios || !isEnabled || !graph) {
      return null;
    }
    
    return scenarioRenderData.map((scenario) => {
      // For each scenario, render all graph edges with scenario params
      const edgePaths = graph.edges?.map((graphEdge) => {
        // Find ReactFlow edge
        const rfEdge = reactFlowEdges.find(e => e.id === graphEdge.id || e.data?.uuid === graphEdge.uuid);
        if (!rfEdge) return null;
        
        // Get source/target nodes
        const sourceNode = reactFlowNodes.find(n => n.id === rfEdge.source);
        const targetNode = reactFlowNodes.find(n => n.id === rfEdge.target);
        if (!sourceNode || !targetNode) return null;
        
        // Compute path using same logic as ReactFlow
        // TODO: This needs to account for offsets, handles, curvature, etc.
        // For now, just use simple bezier path
        const [path] = getBezierPath({
          sourceX: sourceNode.position.x + ((sourceNode as any).width || 120) / 2,
          sourceY: sourceNode.position.y + ((sourceNode as any).height || 120) / 2,
          targetX: targetNode.position.x + ((targetNode as any).width || 120) / 2,
          targetY: targetNode.position.y + ((targetNode as any).height || 120) / 2,
        });
        
        // Get width for this edge in this scenario
        const scenarioEdgeData = scenario.edges.find(e => e.edgeUuid === graphEdge.uuid);
        const width = scenarioEdgeData?.width || 2;
        
        return {
          uuid: graphEdge.uuid,
          path,
          width,
        };
      }).filter((p): p is NonNullable<typeof p> => p !== null) || [];
      
      return {
        scenarioId: scenario.scenarioId,
        name: scenario.name,
        colour: scenario.colour,
        paths: edgePaths,
      };
    });
  }, [hasVisibleScenarios, isEnabled, scenarioRenderData, reactFlowEdges, reactFlowNodes, graph]);
  
  if (!hasVisibleScenarios || !isEnabled || !overlayPaths || overlayPaths.length === 0) {
    return null;
  }
  
  // Calculate dynamic opacity based on number of visible layers
  // Formula: opacity = 1 - (1 - 0.8)^(1/n) where n = number of visible layers
  // This ensures:
  // - With 1 layer: opacity ≈ 0.8 (similar to before)
  // - As more layers are added: opacity decreases to preserve overall visual intensity
  const numVisibleLayers = overlayPaths.length;
  const baseOpacity = 0.8;
  const layerOpacity = 1 - Math.pow(1 - baseOpacity, 1 / numVisibleLayers);
  
  // Render as SVG groups with blend mode
  // Note: This still needs to be inside ReactFlow's SVG viewport to work correctly
  return (
    <>
      {overlayPaths.map((scenario) => (
        <g
          key={scenario.scenarioId}
          className="scenario-overlay"
          data-scenario-id={scenario.scenarioId}
          style={{
            mixBlendMode: 'multiply',
            opacity: layerOpacity,
          } as any}
        >
          {scenario.paths.map((pathData) => (
            <path
              key={`${scenario.scenarioId}-${pathData.uuid}`}
              d={pathData.path}
              stroke={scenario.colour}
              strokeWidth={pathData.width}
              fill="none"
              strokeLinecap="butt"
              strokeLinejoin="miter"
              className="scenario-overlay-path"
            />
          ))}
        </g>
      ))}
    </>
  );
}

export default ScenarioOverlayRenderer;

